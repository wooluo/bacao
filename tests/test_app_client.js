/* 离线（client）模式自动化测试：在 Node 中加载 engine.js + app.js（带极简 DOM 桩），
 * 验证 工资设定 → 过审全链路（直连本地 stub LLM，含非流式与原生 StreamHttp 流式两条路径）/
 * 台账统计 / 冷静期 / 吃灰翻旧账 / 手动归档 / 模拟 Capacitor 原生环境（强制离线 + 200-HTML 兜底不误判）。
 * 运行：node tests/test_app_client.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const http = require("http");

// ---------------- stub LLM（OpenAI 兼容：/models + /chat/completions SSE） ----------------
const WEED = { verdict: "weed", confidence: 78,
  reasons: [{ text: "吃灰概率极高", sting: 5 }, { text: "时薪不配", sting: 3 }],
  questions: [], alternatives: [], saved_amount: 899 };
const COOL = { verdict: "cool", confidence: 55, reasons: [],
  questions: ["一个月后还想要吗？", "家里有替代品吗？"], alternatives: [], saved_amount: 0 };
const PASS = { verdict: "pass", confidence: 25, reasons: [{ text: "刚需", sting: 1 }],
  questions: [], alternatives: ["等 618", "看二手"], saved_amount: 0 };

let stubQueue = [];
let stubLast = null;  // 最近一次 /chat/completions 请求体（断言 multimodal 载荷用）
function stubNext() { return stubQueue.length ? stubQueue.shift() : { obj: WEED, style: "fence" }; }

const stubServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "stub-model" }, { id: "stub-mini" }] }));
    return;
  }
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      stubLast = parsed;
      assert.ok(parsed.messages.some((m) => m.role === "system" && m.content.includes("只输出一个 JSON 对象")),
        "请求必须携带判定系统提示词");
      const { obj, style } = stubNext();
      let text;
      if (style === "bad") text = "这东西吧……我说不清。反正别买。";
      else if (style === "raw") text = JSON.stringify(obj);
      else text = "我的判定：\n```json\n" + JSON.stringify(obj) + "\n```\n请冷静。";
      if (parsed.stream === false) {  // 浏览器非流式路径：整段 JSON
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      for (let i = 0; i < text.length; i += 30) {
        const piece = text.slice(i, i + 30);
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + "\n\n");
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }
  res.statusCode = 404;
  res.end("{}");
});

function loadApp(sandbox) {
  const root = path.join(__dirname, "..");
  vm.runInContext(fs.readFileSync(path.join(root, "static", "engine.js"), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "static", "app.js"), "utf8"), sandbox);
  return sandbox;
}

function makeSandbox(opts) {
  const magic = new Proxy(function () {}, {
    get(t, p) {
      if (p === Symbol.iterator) return () => ({ next: () => ({ done: true }) });
      if (p === "then") return undefined;
      return magic;
    },
    set() { return true; },
    apply() { return magic; }
  });
  const mem = new Map();
  const hashHandlers = [];
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    URLSearchParams, URL, TextDecoder, AbortController,
    navigator: {}, location: { hash: (opts && opts.hash) || "#/home" },
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k)
    },
    document: magic, confirm: () => true, alert: () => {},
    addEventListener: (t, fn) => { if (t === "hashchange") hashHandlers.push(fn); },
    scrollTo: () => {}
  };
  sb.window = sb;
  sb.globalThis = sb;
  sb.__mem = mem;
  sb.__go = (hash) => { sb.location.hash = hash; hashHandlers.forEach((fn) => fn()); };
  if (opts && opts.fetch) sb.fetch = opts.fetch;
  if (opts && opts.capacitor) sb.Capacitor = opts.capacitor;
  return vm.createContext(sb);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => stubServer.listen(0, "127.0.0.1", r));
  const stubPort = stubServer.address().port;
  const stubBase = "http://127.0.0.1:" + stubPort + "/v1";

  // ================= 沙箱 1：浏览器直开页面（无 Capacitor）→ 自动离线模式 =================
  const sb1 = loadApp(makeSandbox({ fetch: (...a) => fetch(...a) }));
  const LY = sb1.__bacao;
  await wait(150);
  assert.strictEqual(LY.mode, "client", "无服务器时应自动进入离线模式");

  // 1) 工资设定：9600 / 20 天 × 8h → 时薪 60；GLM 指向本机 stub
  await LY.clientApi("/api/config", { method: "POST",
    body: { salary: { monthly: 9600, days: 20, hours_per_day: 8 }, persona: "guardian",
            providers: { glm: { base: stubBase, model: "stub-model" } } } });
  const cfg = await LY.clientApi("/api/config");
  assert.strictEqual(cfg.hourly, 60);
  assert.strictEqual(cfg.persona, "guardian");
  console.log("✓ 工资设定 OK（时薪 ¥60）");

  // 2) 过审：judge → 直连 stub LLM（非流式路径）→ 结构化落账
  const { record } = await LY.clientApi("/api/judge",
    { method: "POST", body: { item: "机械键盘", price: 899, why: "打字爽", source: "直播间" } });
  assert.strictEqual(record.hourly, 60);
  assert.strictEqual(record.hours_cost, 15);  // 899/60
  stubQueue.push({ obj: WEED, style: "raw" });
  const raw = await LY.clientVerdict(record, "glm");
  assert.ok(raw.includes("saved_amount"), "应返回模型原文");
  const one = (await LY.clientApi("/api/ledger/" + record.id)).record;
  assert.strictEqual(one.verdict, "weed");
  assert.strictEqual(one.confidence, 78);
  assert.strictEqual(one.saved_amount, 899);
  assert.strictEqual(one.parse_ok, true);
  assert.strictEqual(one.ai_text, raw);
  console.log("✓ 离线直连过审 OK（weed / 指数 78 / 守住 ¥899）");

  // 3) 台账统计：听劝没买 → 守住金额入账
  await LY.clientApi("/api/ledger/" + record.id + "/outcome", { method: "POST", body: { outcome: "kept" } });
  let data = await LY.clientApi("/api/stats");
  assert.strictEqual(data.stats.month_saved, 899);
  assert.strictEqual(data.stats.success_rate, 100);
  console.log("✓ 台账统计 OK（守住 ¥899，只计🚫且听劝）");

  // 4) 冷静期：cool 判定 → cool_pending + 72h → 注入时间偏移后回访 → 买了进吃灰
  stubQueue.push({ obj: COOL, style: "fence" });
  const r2 = (await LY.clientApi("/api/judge",
    { method: "POST", body: { item: "泡脚桶", price: 399 } })).record;
  await LY.clientVerdict(r2, "glm");
  const one2 = (await LY.clientApi("/api/ledger/" + r2.id)).record;
  assert.strictEqual(one2.verdict, "cool");
  assert.strictEqual(one2.outcome, "cool_pending");
  assert.strictEqual(one2.cool_until, sb1.Bacao.coolingUntil(one2.created), "cool_until 应为 created+72h");
  // 时间偏移注入：把 created/cool_until 改到过去
  const ledgerNow = JSON.parse(sb1.__mem.get("bacao.ledger"));
  ledgerNow.find((x) => x.id === r2.id).created = "2026-09-01 08:00:00";
  ledgerNow.find((x) => x.id === r2.id).cool_until = "2026-09-04 08:00:00";
  sb1.__mem.set("bacao.ledger", JSON.stringify(ledgerNow));
  data = await LY.clientApi("/api/stats");
  assert.deepStrictEqual(Array.from(data.cooling_due, (d) => d.id), [r2.id], "72h 过后必须出现在回访列表");
  await LY.clientApi("/api/ledger/" + r2.id + "/outcome", { method: "POST", body: { outcome: "cool_bought" } });
  data = await LY.clientApi("/api/stats");
  assert.strictEqual(data.stats.dust_count, 1);
  assert.strictEqual(data.stats.dust_amount, 399);
  console.log("✓ 72h 冷静期回访 OK（到点提醒 → 回填进吃灰名单）");

  // 5) 吃灰翻旧账：再买同类时，judge 自动注入 dust_used
  stubQueue.push({ obj: COOL, style: "fence" });
  const r3 = (await LY.clientApi("/api/judge",
    { method: "POST", body: { item: "足浴泡脚桶豪华版", price: 499 } })).record;
  assert.strictEqual(r3.dust_used.length, 1, "同类吃灰记录应被翻出");
  const msgs = sb1.Bacao.buildMessages(r3, 60, "salty",
    sb1.Bacao.dustLines(JSON.parse(sb1.__mem.get("bacao.ledger")), r3.item));
  assert.ok(msgs.user.includes("吃灰至今"));
  await LY.clientApi("/api/ledger/" + r3.id, { method: "DELETE" });
  console.log("✓ 吃灰翻旧账注入 OK");

  // 6) 解析失败 → 原文降级 + 手动归档
  stubQueue = [];  // 清掉步骤 5 未消费的桩响应
  stubQueue.push({ obj: null, style: "bad" });
  const r4 = (await LY.clientApi("/api/judge",
    { method: "POST", body: { item: "香薰机", price: 129 } })).record;
  await LY.clientVerdict(r4, "glm");
  const one4 = (await LY.clientApi("/api/ledger/" + r4.id)).record;
  assert.strictEqual(one4.verdict, null);
  assert.strictEqual(one4.parse_ok, false);
  assert.ok(one4.ai_text.includes("别买"));
  await LY.clientApi("/api/ledger/" + r4.id + "/verdict", { method: "POST", body: { verdict: "weed" } });
  const one4b = (await LY.clientApi("/api/ledger/" + r4.id)).record;
  assert.strictEqual(one4b.verdict, "weed");
  assert.strictEqual(one4b.manual, true);
  assert.strictEqual(one4b.saved_amount, 129);
  console.log("✓ 解析失败降级 + 手动归档 OK");

  // 7) Key 持久化且读取脱敏、留空不覆盖
  await LY.clientApi("/api/config", { method: "POST", body: { providers: { glm: { api_key: "TESTKEY123" } } } });
  const cfg1 = await LY.clientApi("/api/config");
  assert.strictEqual(cfg1.providers.glm.has_key, true);
  assert.strictEqual(cfg1.providers.glm.api_key, "");
  await LY.clientApi("/api/config", { method: "POST", body: { providers: { glm: { model: "stub-model", vision_model: "stub-vision" } } } });
  const rawCfg = JSON.parse(sb1.__mem.get("bacao.config"));
  assert.strictEqual(rawCfg.providers.glm.api_key, "TESTKEY123", "空 Key 不应覆盖已存 Key");
  console.log("✓ 离线配置 OK（Key 持久化且读取时脱敏）");

  // 8) 购物截图（client 模式多模态）：judge 带图 → 直连判定走识图模型 + content 数组 → 大图不落 localStorage
  stubQueue.push({ obj: WEED, style: "raw" });
  const IMG = "data:image/jpeg;base64," + "A".repeat(200);
  const THUMB = "data:image/jpeg;base64," + "B".repeat(40);
  const rs = (await LY.clientApi("/api/judge",
    { method: "POST", body: { item: "戴森吹风机", price: 2999, image: IMG, thumb: THUMB } })).record;
  assert.strictEqual(rs.has_image, true);
  assert.strictEqual(rs.thumb, THUMB);
  assert.ok(!("image" in rs), "judge 返回不应携带 AI 用大图");
  const storedShot = JSON.parse(sb1.__mem.get("bacao.ledger")).find((x) => x.id === rs.id);
  assert.strictEqual(storedShot.thumb, THUMB);
  assert.ok(!("image" in storedShot), "大图不应写入 localStorage");
  await LY.clientVerdict(rs, "glm");
  assert.strictEqual(stubLast.model, "stub-vision", "带截图应切换到识图模型");
  const uc = stubLast.messages[1].content;
  assert.ok(Array.isArray(uc), "带截图时 user content 应为数组");
  assert.ok(uc.some((p) => p.type === "image_url" && p.image_url.url === IMG), "应携带 image_url");
  assert.ok(uc.some((p) => p.type === "text" && p.text.includes("【附购物截图】")));
  assert.ok(stubLast.messages[0].content.includes("截图判定补充规则"));
  assert.strictEqual((await LY.clientApi("/api/ledger/" + rs.id)).record.verdict, "weed");
  await LY.clientApi("/api/ledger/" + rs.id, { method: "DELETE" });
  // 非法截图拒绝
  try {
    await LY.clientApi("/api/judge", { method: "POST", body: { item: "x", price: 1, image: "data:text/html;base64,AA" } });
    assert.fail("非法截图应被拒绝");
  } catch (e) { assert.ok(/截图/.test(e.message)); }
  console.log("✓ 购物截图多模态判定 OK（识图模型 + content 数组 + 大图不落盘）");

  // ================= 沙箱 2：模拟安卓（Capacitor 原生 + StreamHttp 插件） =================
  // 即使 /api/config 返回 200 HTML 也必须判为离线（detectMode 防误判回归）
  const listeners = {};
  const emit = (evt, data) => (listeners[evt] || []).forEach((fn) => fn(data));
  const sb2raw = makeSandbox({
    hash: "#/settings",
    fetch: async () => ({ ok: true, status: 200,
      headers: { get: () => "text/html" },
      json: async () => { throw new Error("html"); } }),
    capacitor: {
      isNativePlatform: () => true,
      Plugins: {
        StreamHttp: {
          addListener: async (evt, cb) => {
            (listeners[evt] = listeners[evt] || []).push(cb);
            return { remove: () => { listeners[evt] = (listeners[evt] || []).filter((f) => f !== cb); } };
          },
          request: async ({ id, url, headers, body }) => {
            const res = await fetch(url, { method: "POST", headers, body });
            const text = await res.text();
            for (const line of text.split("\n")) {
              const t = line.trim();
              if (!t.startsWith("data:")) continue;
              const payload = t.slice(5).trim();
              if (payload === "[DONE]") break;
              emit("stream-http-data", { id, payload });
            }
            emit("stream-http-end", { id });
          },
          cancel: async () => {}
        }
      }
    }
  });
  const appEl = { innerHTML: "" };
  // 元素桩：设置页渲染时要读 input.value / 挂事件，magic 代理会让 Number() 抛错
  const elemStub = () => ({
    innerHTML: "", textContent: "", value: "", hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, closest() { return null; }, remove() {}, select() {},
  });
  sb2raw.document = {
    getElementById: (id) => (id === "app" ? appEl : elemStub()),
    querySelector: () => elemStub(),
    querySelectorAll: () => [],
    createElement: () => elemStub(),
    body: { appendChild() {} },
  };
  const magicRef = new Proxy(function () {}, {
    get(t, p) {
      if (p === Symbol.iterator) return () => ({ next: () => ({ done: true }) });
      if (p === "then") return undefined;
      return magicRef;
    },
    set() { return true; },
    apply() { return magicRef; }
  });
  vm.createContext(sb2raw);
  loadApp(sb2raw);
  const LY2 = sb2raw.__bacao;
  const unhandled = [];
  process.on("unhandledRejection", (e) => unhandled.push(e));
  await wait(150);
  assert.strictEqual(LY2.mode, "client", "原生环境必须强制离线模式（200 HTML 不误判）");
  assert.ok(/工资设定/.test(appEl.innerHTML), "设置页应渲染工资设定区块");
  assert.ok(/毒舌人格/.test(appEl.innerHTML), "设置页应渲染人格区块");
  assert.ok(/审判服务/.test(appEl.innerHTML), "设置页应渲染服务区块");
  assert.ok(/识图模型/.test(appEl.innerHTML), "设置页应渲染识图模型字段"); // 说明卡片已按产品要求移除
  assert.strictEqual(unhandled.length, 0, "渲染不应有未捕获异常：" + (unhandled[0] && unhandled[0].message));
  console.log("✓ 原生环境强制离线模式 OK（回归：200 HTML 不误判）");
  console.log("✓ 手机环境设置页渲染 OK（工资/人格/服务/识图模型，无未捕获异常）");

  // 8) 手机端全流程：配置 → judge → StreamHttp 流式过审 → 落账
  await LY2.clientApi("/api/config", { method: "POST",
    body: { salary: { monthly: 9600, days: 20, hours_per_day: 8 },
            providers: { glm: { base: stubBase, model: "stub-model" } } } });
  const rec5 = (await LY2.clientApi("/api/judge",
    { method: "POST", body: { item: "降噪耳机", price: 1999, why: "通勤要安静" } })).record;
  let deltas = 0;
  stubQueue.push({ obj: PASS, style: "raw" });
  const text5 = await LY2.clientVerdictStream(rec5, "glm", () => deltas++);
  assert.ok(deltas > 3, "流式应收到多次增量：" + deltas);
  assert.ok(text5.includes("alternatives"));
  const one5 = (await LY2.clientApi("/api/ledger/" + rec5.id)).record;
  assert.strictEqual(one5.verdict, "pass");
  assert.deepStrictEqual(Array.from(one5.alternatives), ["等 618", "看二手"]);
  await LY2.clientApi("/api/ledger/" + rec5.id + "/outcome", { method: "POST", body: { outcome: "pass_bought" } });
  const stats5 = (await LY2.clientApi("/api/stats")).stats;
  assert.strictEqual(stats5.pass_bought, 1);
  assert.strictEqual(stats5.month_saved, 0, "放行购买绝不计入守住金额");
  // 手机端台账页渲染
  appEl.innerHTML = "";
  sb2raw.__go("#/ledger");
  await wait(120);  // renderLedger 是异步的
  assert.ok(/拔草台账/.test(appEl.innerHTML), "台账页应正常渲染");
  assert.strictEqual(unhandled.length, 0, "台账页渲染不应有未捕获异常");
  console.log("✓ 原生 StreamHttp 流式过审 OK（%d 次增量 → pass 落账，放行不计守住）", deltas);
  console.log("✓ 手机环境台账页渲染 OK");

  // 9) CSS 回归：[hidden] 规则必须存在——否则 display:flex 类会把 hidden 属性顶掉（截图预览框漏显示事故）
  const css = fs.readFileSync(path.join(__dirname, "..", "static", "style.css"), "utf8");
  assert.ok(/\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/.test(css),
    "style.css 必须包含 [hidden]{display:none!important} 规则");
  console.log("✓ CSS 回归守卫 OK（[hidden] 规则在位）");

  process.off("unhandledRejection", (e) => unhandled.push(e));
  stubServer.close();
  console.log("\nclient 模式全部通过");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
