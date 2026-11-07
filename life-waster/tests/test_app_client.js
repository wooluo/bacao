/* 离线（client）模式自动化测试：在 Node 中加载 engine.js + app.js（带极简 DOM 桩），
 * 验证 生命档案 → 时光录入全链路（直连本地 stub LLM，含非流式与原生 StreamHttp 流式两条路径）/
 * 健康截图导入 / 台账统计 / 72h 复盘 / 黑名单翻旧账 / 手动归档 /
 * 模拟 Capacitor 原生环境（强制离线 + 200-HTML 兜底不误判）。
 * 运行：node tests/test_app_client.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const http = require("http");

// ---------------- stub LLM（OpenAI 兼容：/models + /chat/completions SSE） ----------------
const WEED = { verdict: "waste", confidence: 78, waste_index: 78,
  reasons: [{ content: "无意义刷短视频，没有成长收益", sting_level: 5 }, { content: "纯消磨", sting_level: 3 }],
  questions: [], alternatives: ["用这段时间看书/运动"], life_change: -2, save_time: 3 };
const NORMAL = { verdict: "normal", confidence: 55, waste_index: 55, reasons: [],
  questions: ["这件事长期能带来成长吗？", "只是单纯消磨时间吗？"], alternatives: [], life_change: 0, save_time: 0 };
const VALUABLE = { verdict: "valuable", confidence: 25, waste_index: 20,
  reasons: [{ content: "规律运动", sting_level: 1 }], questions: [], alternatives: [], life_change: 1, save_time: 0 };
const HEALTH = { sleep_hours: 6.5, sleep_start: "01:10", sleep_end: "07:40",
  steps: 3210, exercise_minutes: 0, weight: 66.2, heart_rate: 74 };

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
      assert.ok(parsed.messages.some((m) => m.role === "system" &&
        (m.content.includes("只输出一个 JSON 对象") || m.content.includes("只输出纯 JSON"))),
        "请求必须携带判定/识别系统提示词");
      const { obj, style } = stubNext();
      let text;
      if (style === "bad") text = "这段时光吧……我说不清。反正少刷点。";
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
  const LW = sb1.__lifewaster;
  await wait(150);
  assert.strictEqual(LW.mode, "client", "无服务器时应自动进入离线模式");

  // 1) 生命档案：出生 1990-06-01 / 预期 80 → life 就绪；GLM 指向本机 stub
  await LW.clientApi("/api/profile", { method: "POST",
    body: { birth_date: "1990-06-01", expectancy: 80, height: 170, weight: 65,
            sleep_start: "23:30", sleep_end: "07:00", sleep_hours: 7.5 } });
  await LW.clientApi("/api/config", { method: "POST",
    body: { persona: "guardian", providers: { glm: { base: stubBase, model: "stub-model", vision_model: "stub-vision" } } } });
  const p = await LW.clientApi("/api/profile");
  assert.strictEqual(p.life.ready, true);
  assert.strictEqual(p.bmi, 22.5);
  assert.ok(p.life.remain_days > 0);
  assert.strictEqual((await LW.clientApi("/api/config")).persona, "guardian");
  console.log("✓ 生命档案 OK（剩余 " + p.life.remain_days + " 天 / BMI 22.5）");

  // 2) 录入：judge → 直连 stub LLM（非流式路径）→ 结构化落账
  const { record } = await LW.clientApi("/api/judge",
    { method: "POST", body: { activity: "连续刷短视频", hours: 3, feeling: "越刷越空虚" } });
  assert.strictEqual(record.hours, 3);
  assert.strictEqual(record.outcome, "pending");
  stubQueue.push({ obj: WEED, style: "raw" });
  const raw = await LW.clientVerdict(record, "glm");
  assert.ok(raw.includes("waste_index"), "应返回模型原文");
  const one = (await LW.clientApi("/api/ledger/" + record.id)).record;
  assert.strictEqual(one.verdict, "waste");
  assert.strictEqual(one.waste_index, 78);
  assert.strictEqual(one.life_change, -2);
  assert.strictEqual(one.save_time, 3);
  assert.strictEqual(one.parse_ok, true);
  assert.strictEqual(one.ai_text, raw);
  // 提示词带档案与健康红线
  assert.ok(stubLast.messages[1].content.includes("【生命档案】出生 1990-06-01"));
  assert.ok(stubLast.messages[0].content.includes("不做任何医疗诊断"));
  console.log("✓ 离线直连录入 OK（waste / 虚度指数 78 / 折损 2 天）");

  // 3) 台账统计：确认虚度 → 计入虚度时长 + 黑名单
  await LW.clientApi("/api/ledger/" + record.id + "/outcome", { method: "POST", body: { outcome: "confirmed" } });
  let data = await LW.clientApi("/api/stats");
  assert.strictEqual(data.stats.total_wasted, 3);
  assert.strictEqual(data.stats.blacklist_count, 1);
  assert.strictEqual(data.life.ready, true);
  console.log("✓ 台账统计 OK（虚度 3 小时只计确认虚度，黑名单 +1）");

  // 4) 72h 复盘：normal 判定 → review_pending + 72h → 注入时间偏移后回访 → 确实虚度
  stubQueue.push({ obj: NORMAL, style: "fence" });
  const r2 = (await LW.clientApi("/api/judge",
    { method: "POST", body: { activity: "躺着刷短视频", hours: 2 } })).record;
  await LW.clientVerdict(r2, "glm");
  const one2 = (await LW.clientApi("/api/ledger/" + r2.id)).record;
  assert.strictEqual(one2.verdict, "normal");
  assert.strictEqual(one2.outcome, "review_pending");
  assert.strictEqual(one2.cool_until, sb1.LifeWaster.coolingUntil(one2.created), "cool_until 应为 created+72h");
  // 时间偏移注入：把 created/cool_until 改到过去
  const ledgerNow = JSON.parse(sb1.__mem.get("lw.ledger"));
  ledgerNow.find((x) => x.id === r2.id).created = "2026-09-01 08:00:00";
  ledgerNow.find((x) => x.id === r2.id).cool_until = "2026-09-04 08:00:00";
  sb1.__mem.set("lw.ledger", JSON.stringify(ledgerNow));
  data = await LW.clientApi("/api/stats");
  assert.deepStrictEqual(Array.from(data.cooling_due, (d) => d.id), [r2.id], "72h 过后必须出现在回访列表");
  await LW.clientApi("/api/ledger/" + r2.id + "/outcome", { method: "POST", body: { outcome: "review_waste" } });
  data = await LW.clientApi("/api/stats");
  assert.strictEqual(data.stats.total_wasted, 5);
  assert.strictEqual(data.stats.blacklist_count, 2);
  console.log("✓ 72h 复盘冷静期 OK（到点提醒 → 确实虚度计入虚度时长）");

  // 5) 黑名单翻旧账：同类行为 judge 自动注入 blacklist_used
  stubQueue.push({ obj: NORMAL, style: "fence" });
  const r3 = (await LW.clientApi("/api/judge",
    { method: "POST", body: { activity: "睡前刷短视频放松", hours: 1 } })).record;
  assert.ok(r3.blacklist_used.length >= 1, "同类虚度记录应被翻出");
  const msgs = sb1.LifeWaster.buildMessages(r3, JSON.parse(sb1.__mem.get("lw.profile")), "salty",
    sb1.LifeWaster.blacklistLines(JSON.parse(sb1.__mem.get("lw.ledger")), r3.activity));
  assert.ok(msgs.user.includes("拉高虚度评分"));
  await LW.clientApi("/api/ledger/" + r3.id, { method: "DELETE" });
  console.log("✓ 黑名单翻旧账注入 OK");

  // 6) 解析失败 → 原文降级 + 手动归档（valuable → 自动入高光）
  stubQueue = [];  // 清掉步骤 5 未消费的桩响应
  stubQueue.push({ obj: null, style: "bad" });
  const r4 = (await LW.clientApi("/api/judge",
    { method: "POST", body: { activity: "漫无目的逛街", hours: 2 } })).record;
  await LW.clientVerdict(r4, "glm");
  const one4 = (await LW.clientApi("/api/ledger/" + r4.id)).record;
  assert.strictEqual(one4.verdict, null);
  assert.strictEqual(one4.parse_ok, false);
  assert.ok(one4.ai_text.includes("少刷点"));
  await LW.clientApi("/api/ledger/" + r4.id + "/verdict", { method: "POST", body: { verdict: "valuable" } });
  const one4b = (await LW.clientApi("/api/ledger/" + r4.id)).record;
  assert.strictEqual(one4b.verdict, "valuable");
  assert.strictEqual(one4b.manual, true);
  assert.strictEqual(one4b.outcome, "highlight");
  console.log("✓ 解析失败降级 + 手动归档 OK（valuable 自动入高光）");

  // 7) Key 持久化且读取脱敏、留空不覆盖
  await LW.clientApi("/api/config", { method: "POST", body: { providers: { glm: { api_key: "TESTKEY123" } } } });
  const cfg1 = await LW.clientApi("/api/config");
  assert.strictEqual(cfg1.providers.glm.has_key, true);
  assert.strictEqual(cfg1.providers.glm.api_key, "");
  const rawCfg = JSON.parse(sb1.__mem.get("lw.config"));
  assert.strictEqual(rawCfg.providers.glm.api_key, "TESTKEY123", "空 Key 不应覆盖已存 Key");
  console.log("✓ 离线配置 OK（Key 持久化且读取时脱敏）");

  // 8) 健康截图导入（client 模式多模态）：识图模型 + content 数组 → 自动回填档案 → 大图不落 localStorage
  stubQueue.push({ obj: HEALTH, style: "raw" });
  const IMG = "data:image/jpeg;base64," + "A".repeat(200);
  const THUMB = "data:image/jpeg;base64," + "B".repeat(40);
  const hi = await LW.clientHealthImport(IMG, THUMB);
  assert.strictEqual(hi.health.sleep_hours, 6.5);
  assert.strictEqual(hi.health.steps, 3210);
  assert.strictEqual(stubLast.model, "stub-vision", "健康识别应切换到识图模型");
  const uc = stubLast.messages[1].content;
  assert.ok(Array.isArray(uc), "带截图时 user content 应为数组");
  assert.ok(uc.some((pt) => pt.type === "image_url" && pt.image_url.url === IMG), "应携带 image_url");
  assert.ok(stubLast.messages[0].content.includes("华为运动健康"));
  const storedProfile = JSON.parse(sb1.__mem.get("lw.profile"));
  assert.strictEqual(storedProfile.health_log[0].sleep_hours, 6.5);
  assert.strictEqual(storedProfile.health_log[0].thumb, THUMB);
  assert.ok(!JSON.stringify(storedProfile).includes(IMG.slice(0, 60)), "大图不应写入 localStorage");
  // 非法截图拒绝
  try {
    await LW.clientHealthImport("data:text/html;base64,AA", "");
    assert.fail("非法截图应被拒绝");
  } catch (e) { assert.ok(/截图/.test(e.message)); }
  console.log("✓ 健康截图导入 OK（识图模型 + 自动回填 + 大图不落盘）");

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
    addEventListener() {},
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
  const LW2 = sb2raw.__lifewaster;
  const unhandled = [];
  process.on("unhandledRejection", (e) => unhandled.push(e));
  await wait(150);
  assert.strictEqual(LW2.mode, "client", "原生环境必须强制离线模式（200 HTML 不误判）");
  assert.ok(/生命档案/.test(appEl.innerHTML), "设置页应渲染生命档案区块");
  assert.ok(/健康数据导入/.test(appEl.innerHTML), "设置页应渲染健康导入区块");
  assert.ok(/三档人格/.test(appEl.innerHTML), "设置页应渲染人格区块");
  assert.ok(/审计服务/.test(appEl.innerHTML), "设置页应渲染服务区块");
  assert.ok(/识图模型/.test(appEl.innerHTML), "设置页应渲染识图模型字段");
  assert.strictEqual(unhandled.length, 0, "渲染不应有未捕获异常：" + (unhandled[0] && unhandled[0].message));
  console.log("✓ 原生环境强制离线模式 OK（回归：200 HTML 不误判）");
  console.log("✓ 手机环境设置页渲染 OK（生命档案/健康导入/人格/服务/识图模型，无未捕获异常）");

  // 9) 手机端全流程：档案 → judge → StreamHttp 流式审计 → 落账（valuable 自动入高光）
  await LW2.clientApi("/api/profile", { method: "POST",
    body: { birth_date: "1992-03-15", expectancy: 82 } });
  await LW2.clientApi("/api/config", { method: "POST",
    body: { providers: { glm: { base: stubBase, model: "stub-model", vision_model: "stub-vision" } } } });
  const rec5 = (await LW2.clientApi("/api/judge",
    { method: "POST", body: { activity: "夜跑 5 公里", hours: 1, why: "神清气爽" } })).record;
  let deltas = 0;
  stubQueue.push({ obj: VALUABLE, style: "raw" });
  const text5 = await LW2.clientVerdictStream(rec5, "glm", () => deltas++);
  assert.ok(deltas > 3, "流式应收到多次增量：" + deltas);
  assert.ok(text5.includes("waste_index"));
  const one5 = (await LW2.clientApi("/api/ledger/" + rec5.id)).record;
  assert.strictEqual(one5.verdict, "valuable");
  assert.strictEqual(one5.outcome, "highlight", "valuable 应自动入高光时刻");
  assert.strictEqual(one5.life_change, 1);
  const stats5 = (await LW2.clientApi("/api/stats")).stats;
  assert.strictEqual(stats5.valuable_total, 1);
  assert.strictEqual(stats5.total_value, 1);
  assert.strictEqual(stats5.total_wasted, 0, "高光绝不计入虚度时长");
  // 手机端台账页渲染
  appEl.innerHTML = "";
  sb2raw.__go("#/ledger");
  await wait(120);  // renderLedger 是异步的
  assert.ok(/时光台账/.test(appEl.innerHTML), "台账页应正常渲染");
  assert.strictEqual(unhandled.length, 0, "台账页渲染不应有未捕获异常");
  console.log("✓ 原生 StreamHttp 流式审计 OK（%d 次增量 → valuable 自动入高光，不计虚度）", deltas);
  console.log("✓ 手机环境台账页渲染 OK");

  // 10) CSS 回归：[hidden] 规则必须存在——否则 display:flex 类会把 hidden 属性顶掉（截图预览框漏显示事故）
  const css = fs.readFileSync(path.join(__dirname, "..", "static", "style.css"), "utf8");
  assert.ok(/\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/.test(css),
    "style.css 必须包含 [hidden]{display:none!important} 规则");
  console.log("✓ CSS 回归守卫 OK（[hidden] 规则在位）");

  process.off("unhandledRejection", (e) => unhandled.push(e));
  stubServer.close();
  console.log("\nclient 模式全部通过");
})().catch((e) => { console.error("FAIL:", e); process.exit(1); });
