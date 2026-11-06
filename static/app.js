"use strict";
/* 拔草机 · 前端（原生 JS，零依赖）
 * 双模式：server（本地 Python 服务，流式）/ client（APK 或直开页面，localStorage + 直连 AI）
 */

// ---------------- 基础工具 ----------------
const app = document.getElementById("app");
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

function cutPop() {
  const el = document.createElement("div");
  el.className = "scissors-pop";
  el.textContent = "✂️🛒";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

async function api(path, opts = {}) {
  if (MODE === "client") return clientApi(path, opts);
  const init = { method: opts.method || "GET", headers: { "Content-Type": "application/json" } };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(path, init);
  const data = await res.json().catch(() => null);
  if (!res.ok || data === null || typeof data !== "object") {
    throw new Error((data && data.error) || "HTTP " + res.status);
  }
  return data;
}

// ---------------- 服务器探测 / 离线（App）模式 ----------------
let MODE = "server"; // server = 本地 Python 服务；client = 离线（APK / 直接打开页面）

function lsGet(k, d) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
}
function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

function defaultConfig() {
  return {
    provider: "glm", persona: "salty",
    salary: { monthly: 0, days: 21.75, hours_per_day: 8 },
    providers: {
      glm: { label: "GLM 智谱（Coding Plan）", protocol: "openai", base: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.3-flash", vision_model: "glm-4.5v", api_key: "", fast: true }
    }
  };
}

function clientRawConfig() {
  const stored = lsGet("bacao.config", null);
  if (!stored) return defaultConfig();
  const base = defaultConfig();
  stored.salary = Object.assign({}, base.salary, stored.salary || {});
  if (!stored.provider || !stored.providers || !stored.providers[stored.provider]) stored.provider = base.provider;
  stored.providers = stored.providers || {};
  Object.keys(base.providers).forEach((pid) => {
    if (!stored.providers[pid]) stored.providers[pid] = base.providers[pid];
  });
  if (!Bacao.PERSONAS[stored.persona]) stored.persona = base.persona;
  return stored;
}

function applyConfigPatch(cfg, body) {
  if (body.provider && cfg.providers && cfg.providers[body.provider]) cfg.provider = body.provider;
  if (Bacao.PERSONAS[body.persona]) cfg.persona = body.persona;
  if (body.salary && typeof body.salary === "object") {
    ["monthly", "days", "hours_per_day"].forEach((k) => {
      const v = Number(body.salary[k]);
      if (isFinite(v) && v >= 0) cfg.salary[k] = v;
    });
  }
  Object.entries(body.providers || {}).forEach(([pid, p]) => {
    if (!p || typeof p !== "object" || !cfg.providers[pid]) return;
    const tgt = cfg.providers[pid];
    ["label", "protocol", "base", "model", "vision_model"].forEach((k) => {
      if (typeof p[k] === "string") tgt[k] = p[k].trim();
    });
    if (p.protocol !== "openai" && p.protocol !== "anthropic") tgt.protocol = "openai";
    if (typeof p.api_key === "string" && p.api_key.trim()) tgt.api_key = p.api_key.trim();
    if (typeof p.fast === "boolean") tgt.fast = p.fast;
  });
}

async function detectMode() {
  // 安卓/原生环境：必定离线模式（App 内置引擎与直连能力，不依赖本机服务）
  const cap = typeof window !== "undefined" && window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) { MODE = "client"; return; }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch("/api/config", { signal: ctl.signal });
    clearTimeout(t);
    const ct = res.headers.get("content-type") || "";
    if (res.ok && ct.indexOf("json") >= 0) {
      const data = await res.json().catch(() => null);
      if (data && data.providers) { MODE = "server"; return; }
    }
  } catch (e) { /* 无服务器 */ }
  MODE = "client";
}

// ---- 原生 HTTP（Capacitor 内绕过 CORS；浏览器则退回 fetch） ----
function nativeHttp() {
  const cap = typeof window !== "undefined" && window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.CapacitorHttp && (!cap.isNativePlatform || cap.isNativePlatform())) {
    return cap.Plugins.CapacitorHttp;
  }
  return null;
}

async function httpJSON(method, url, headers, bodyObj, timeoutMs) {
  const nh = nativeHttp();
  if (nh) {
    const r = await nh.request({ method, url, headers: headers || {}, data: bodyObj });
    if (r.status >= 400) {
      throw new Error("HTTP " + r.status + "：" + JSON.stringify(r.data).slice(0, 200));
    }
    return { status: r.status, json: r.data };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(url, {
      method, headers,
      body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
      signal: ctl.signal
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const msg = j && j.error ? (j.error.message || j.error) : JSON.stringify(j).slice(0, 200);
      throw new Error("HTTP " + res.status + "：" + (msg || ""));
    }
    return { status: res.status, json: await res.json().catch(() => ({})) };
  } finally { clearTimeout(t); }
}

async function fetchModelsDirect(pcfg) {
  const base = (pcfg.base || "").replace(/\/+$/, "");
  if (!base) return [];
  const url = base + (pcfg.protocol === "anthropic" ? "/v1/models" : "/models");
  const headers = {};
  if (pcfg.api_key) { headers.Authorization = "Bearer " + pcfg.api_key; headers["x-api-key"] = pcfg.api_key; }
  const { json } = await httpJSON("GET", url, headers, undefined, 10000);
  return (json.data || []).map((m) => m && m.id).filter(Boolean);
}

const NON_CHAT_MODEL = /embed|rerank|ocr|whisper|speech|tts|stt|audio|clip/i;

// ---------------- 离线（client）模式 API ----------------

function clientLedger() { return lsGet("bacao.ledger", []); }

function recordSummaryClient(r) {
  return {
    id: r.id, created: r.created || "",
    item: r.item || "", price: r.price || 0,
    verdict: r.verdict || null, confidence: r.confidence != null ? r.confidence : null,
    outcome: r.outcome || "pending", outcome_at: r.outcome_at || "",
    cool_until: r.cool_until || "", parse_ok: !!r.parse_ok,
    hours_cost: r.hours_cost || 0, saved_amount: r.saved_amount || 0,
    dust_count: (r.dust_used || []).length,
    has_image: !!r.thumb,
  };
}

// ---------------- 购物截图 ----------------
// 前端压缩成两份：image（AI 识别用，≤1280px）与 thumb（台账展示，≤240px）
const IMG_AI_MAX_CHARS = 3500000, IMG_THUMB_MAX_CHARS = 80000;
const clientImageCache = {};  // 记录 id → AI 用大图 dataURL（内存，不落 localStorage）

function readImageAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("读取截图失败"));
    fr.readAsDataURL(file);
  });
}

function downscale(dataUrl, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(cv.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => reject(new Error("截图解析失败（仅支持 png/jpg/webp）"));
    img.src = dataUrl;
  });
}

async function prepareScreenshot(file) {
  if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
    throw new Error("仅支持 png / jpg / webp 截图");
  }
  if (file.size > 8 * 1024 * 1024) throw new Error("截图太大（≤8MB），请截小一点");
  const raw = await readImageAsDataURL(file);
  const image = await downscale(raw, 1280, 0.8);   // AI 识别用
  const thumb = await downscale(raw, 240, 0.6);    // 台账缩略图
  if (image.length > IMG_AI_MAX_CHARS) throw new Error("截图压缩后仍过大，请换小一点的图");
  return { image, thumb };
}

function clientHourly() {
  const s = clientRawConfig().salary || {};
  return Bacao.hourlyWage(s.monthly, s.days, s.hours_per_day);
}

async function clientApi(path, opts = {}) {
  const method = opts.method || "GET";
  const body = opts.body || {};
  if (path === "/api/config" && method === "GET") {
    const cfg = JSON.parse(JSON.stringify(clientRawConfig()));
    Object.values(cfg.providers).forEach((p) => { p.has_key = !!p.api_key; p.api_key = ""; });
    cfg.hourly = clientHourly();
    cfg.persona_info = Bacao.PERSONAS[cfg.persona] || Bacao.PERSONAS.salty;
    return cfg;
  }
  if (path === "/api/config" && method === "POST") {
    const cfg = clientRawConfig();
    applyConfigPatch(cfg, body);
    lsSet("bacao.config", cfg);
    return { ok: true };
  }
  if (path === "/api/judge") {
    const item = String(body.item || "").trim();
    if (!item) throw new Error("想买的东西不能为空");
    const price = Math.round(Number(body.price) * 100) / 100;
    if (!(price > 0) || price > 10000000) throw new Error("价格应在 0 ~ 1000 万之间");
    const hourly = clientHourly();
    if (!(hourly > 0)) throw new Error("请先在设置里填写工资（月薪与工作天数），才能开始过审");
    const cfg = clientRawConfig();
    let persona = body.persona || cfg.persona || "salty";
    if (!Bacao.PERSONAS[persona]) persona = "salty";
    const image = body.image || "";
    const thumb = body.thumb || "";
    const imgOk = (s, max) => !s || (s.length <= max && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(s));
    if (!imgOk(image, IMG_AI_MAX_CHARS)) throw new Error("截图格式不支持或过大（仅支持 png/jpg/webp）");
    if (!imgOk(thumb, IMG_THUMB_MAX_CHARS)) throw new Error("缩略图数据异常");
    const ledger = clientLedger();
    const now = new Date();
    const record = {
      id: Bacao.makeId(now), created: Bacao.fmtNow(now),
      item: item.slice(0, 40), price,
      why: String(body.why || "").trim().slice(0, 200),
      source: String(body.source || "").trim().slice(0, 100),
      persona, hourly,
      hours_cost: Bacao.hoursFor(price, hourly),
      dust_used: Bacao.dustMatches(ledger, item).map((r) => r.id),
      verdict: null, confidence: null,
      reasons: [], questions: [], alternatives: [],
      saved_amount: 0, ai_text: "", parse_ok: false,
      outcome: "pending", outcome_at: "", cool_until: "",
      thumb, has_image: !!thumb,
    };
    if (image) clientImageCache[record.id] = image; // AI 用大图只留内存
    ledger.unshift(record);
    lsSet("bacao.ledger", ledger);
    return { record };
  }
  if (path === "/api/ledger") {
    const ledger = clientLedger();
    return { records: ledger.map(recordSummaryClient), stats: Bacao.stats(ledger) };
  }
  const m = path.match(/^\/api\/ledger\/([\w-]+)$/);
  if (m && method === "GET") {
    const r = clientLedger().find((x) => x.id === m[1]);
    if (!r) throw new Error("记录不存在");
    return { record: r };
  }
  if (m && method === "DELETE") {
    lsSet("bacao.ledger", clientLedger().filter((x) => x.id !== m[1]));
    delete clientImageCache[m[1]];
    return { ok: true };
  }
  const mo = path.match(/^\/api\/ledger\/([\w-]+)\/outcome$/);
  if (mo && method === "POST") {
    const ledger = clientLedger();
    const r = ledger.find((x) => x.id === mo[1]);
    if (!r) throw new Error("记录不存在");
    if (!Bacao.markOutcome(r, body.outcome)) throw new Error("该判定档位不支持这个结果：" + body.outcome);
    lsSet("bacao.ledger", ledger);
    return { ok: true, record: recordSummaryClient(r) };
  }
  const mv = path.match(/^\/api\/ledger\/([\w-]+)\/verdict$/);
  if (mv && method === "POST") {
    const ledger = clientLedger();
    const r = ledger.find((x) => x.id === mv[1]);
    if (!r) throw new Error("记录不存在");
    if (!Bacao.manualVerdict(r, body.verdict)) throw new Error("判定档位不合法");
    lsSet("bacao.ledger", ledger);
    return { ok: true, record: recordSummaryClient(r) };
  }
  if (path === "/api/stats") {
    const ledger = clientLedger();
    return {
      stats: Bacao.stats(ledger),
      cooling_due: Bacao.coolingDue(ledger).map(recordSummaryClient),
    };
  }
  if (path.startsWith("/api/models")) {
    const pid = new URLSearchParams(path.split("?")[1] || "").get("provider") || "";
    const pcfg = clientRawConfig().providers[pid];
    if (!pcfg) throw new Error("未知 provider");
    return { models: await fetchModelsDirect(pcfg) };
  }
  throw new Error("离线模式不支持：" + path);
}

// ---- 离线直连判定 ----
// 安卓 App 内置原生 StreamHttp 插件时可流式；浏览器（受 CORS）退回非流式整段返回。
function nativeStreamHttp() {
  const cap = typeof window !== "undefined" && window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.StreamHttp &&
      (!cap.isNativePlatform || cap.isNativePlatform())) {
    return cap.Plugins.StreamHttp;
  }
  return null;
}

async function resolveClientModel(pcfg) {
  let model = (pcfg.model || "").trim();
  if (!model) {
    try {
      const ms = await fetchModelsDirect(pcfg);
      model = ms.find((x) => !NON_CHAT_MODEL.test(x)) || ms[0] || "";
    } catch (e) { /* 留空报错 */ }
  }
  return model;
}

function clientRequestBody(pcfg, model, record, dustLines, stream, images) {
  const msgs = Bacao.buildMessages(record, clientHourly(), record.persona || "salty", dustLines);
  const base = (pcfg.base || "").replace(/\/+$/, "");
  const userContent = (images && images.length)
    ? images.map((url) => ({ type: "image_url", image_url: { url } })).concat([{ type: "text", text: msgs.user }])
    : msgs.user;
  let url, headers, payload;
  if (pcfg.protocol === "anthropic") {
    url = base + "/v1/messages";
    headers = { "Content-Type": "application/json", "anthropic-version": "2023-06-01" };
    if (pcfg.api_key) { headers["x-api-key"] = pcfg.api_key; headers.Authorization = "Bearer " + pcfg.api_key; }
    const acContent = (images && images.length)
      ? images.map((u) => {
          const m = String(u).match(/^data:image\/(\w+);base64,(.*)$/);
          const media = m ? (m[1] === "jpg" ? "jpeg" : m[1]) : "jpeg";
          return m ? { type: "image", source: { type: "base64", media_type: "image/" + media, data: m[2] } } : null;
        }).filter(Boolean).concat([{ type: "text", text: msgs.user }])
      : msgs.user;
    payload = { model, max_tokens: 2048, temperature: 0.7, stream: !!stream, system: msgs.system,
                messages: [{ role: "user", content: acContent }] };
  } else {
    url = base + "/chat/completions";
    headers = { "Content-Type": "application/json" };
    if (pcfg.api_key) headers.Authorization = "Bearer " + pcfg.api_key;
    payload = { model, temperature: 0.7, stream: !!stream,
                messages: [{ role: "system", content: msgs.system }, { role: "user", content: userContent }] };
  }
  // 快速模式：智谱系端点关闭深度思考，显著缩短等待（识图模型同样适用）
  if (pcfg.fast && /bigmodel|z\.ai/i.test(pcfg.base || "")) {
    payload.thinking = { type: "disabled" };
  }
  return { url, headers, payload };
}

// 判定用模型：附截图 → 识图模型（vision_model，缺省退回主模型）
function verdictModel(pcfg, withImage) {
  if (withImage) {
    const vm = String(pcfg.vision_model || "").trim();
    if (vm) return vm;
  }
  return (pcfg.model || "").trim();
}

// 判定字段落账（与 app.py apply_verdict 同构）
function applyVerdictRecord(record, rawText) {
  record.ai_text = rawText;
  const nv = Bacao.parseVerdict(rawText, record.price);
  if (!nv) { record.parse_ok = false; return false; }
  record.parse_ok = true;
  record.verdict = nv.verdict;
  record.confidence = nv.confidence;
  record.reasons = nv.reasons;
  record.questions = nv.questions;
  record.alternatives = nv.alternatives;
  if (nv.verdict === "weed") {
    record.saved_amount = (nv.saved_amount && nv.saved_amount > 0) ? nv.saved_amount : record.price;
  } else {
    record.saved_amount = 0;
  }
  if (nv.verdict === "cool") {
    record.outcome = "cool_pending";
    record.cool_until = Bacao.coolingUntil(record.created);
  }
  return true;
}

function saveClientVerdict(record, raw) {
  const ledger = clientLedger();
  const target = ledger.find((x) => x.id === record.id);
  if (!target) return;
  applyVerdictRecord(target, raw);
  lsSet("bacao.ledger", ledger);
}

// 非流式（浏览器离线模式）
async function clientVerdict(record, pid) {
  const pcfg = clientRawConfig().providers[pid];
  if (!pcfg) throw new Error("未知 provider：" + pid);
  const image = clientImageCache[record.id] || "";
  let model = verdictModel(pcfg, !!image);
  if (!model) model = await resolveClientModel(pcfg);
  if (!model) throw new Error("未配置模型名，且无法从服务获取模型列表。请在设置里填写模型。");
  const dustLines = Bacao.dustLines(clientLedger(), record.item || "");
  const req = clientRequestBody(pcfg, model, record, dustLines, false, image ? [image] : null);
  verdictBusy = true;
  try {
  const { json } = await httpJSON("POST", req.url, req.headers, req.payload, 300000);
  let text = "";
  if (json && Array.isArray(json.choices) && json.choices[0]) {
    text = (json.choices[0].message || {}).content || "";
  } else if (json && Array.isArray(json.content)) {
    text = json.content.map((b) => (b && b.text) || "").join("");
  }
  if (!text) throw new Error("模型未返回内容：" + JSON.stringify(json).slice(0, 160));
  saveClientVerdict(record, text);
  return text;
  } finally { verdictBusy = false; }
}

// 流式（原生 StreamHttp 插件）：SSE 增量逐段回调 onDelta，结束/停止保存已生成部分
let nativeStreamCancel = null;

function clientVerdictStream(record, pid, onDelta) {
  return new Promise((resolve, reject) => {
    (async () => {
      const plugin = nativeStreamHttp();
      const pcfg = clientRawConfig().providers[pid];
      if (!pcfg) { reject(new Error("未知 provider：" + pid)); return; }
      const image = clientImageCache[record.id] || "";
      let model = verdictModel(pcfg, !!image);
      if (!model) model = await resolveClientModel(pcfg);
      if (!model) { reject(new Error("未配置模型名，且无法从服务获取模型列表。请在设置里填写模型。")); return; }
      verdictBusy = true;
      const dustLines = Bacao.dustLines(clientLedger(), record.item || "");
      const req = clientRequestBody(pcfg, model, record, dustLines, true, image ? [image] : null);
      const id = "s" + Date.now() + "-" + Math.floor(Math.random() * 1000);
      let acc = "", reason = "", finished = false;
      const handles = [];
      const cleanup = () => { handles.forEach((h) => { try { h.remove && h.remove(); } catch (e) {} }); };
      const finish = (err) => {
        if (finished) return;
        finished = true;
        cleanup();
        nativeStreamCancel = null;
        verdictBusy = false;
        if (acc) saveClientVerdict(record, acc); // 停止也保留已生成部分
        if (err) reject(err);
        else if (!acc) reject(new Error("模型未返回内容"));
        else resolve(acc);
      };
      nativeStreamCancel = () => { try { plugin.cancel({ id }); } catch (e) {} };
      try {
        handles.push(await plugin.addListener("stream-http-data", (e) => {
          if (e.id !== id || !e.payload || e.payload === "[DONE]") return;
          let obj;
          try { obj = JSON.parse(e.payload); } catch (err) { return; }
          let t = "", r = "";
          if (obj.choices && obj.choices[0]) {
            const d = (obj.choices[0].delta) || {};
            t = d.content || "";
            r = d.reasoning_content || d.reasoning || "";
          } else if (obj.type === "content_block_delta") {
            t = (obj.delta || {}).text || "";
          } else if (obj.type === "thinking_delta") {
            r = (obj.delta || {}).thinking || "";
          }
          if (t || r) {
            if (t) acc += t;
            if (r) reason += r;
            onDelta({ content: acc, reason });
          }
        }));
        handles.push(await plugin.addListener("stream-http-end", (e) => { if (e.id === id) finish(); }));
        handles.push(await plugin.addListener("stream-http-error", (e) => {
          if (e.id === id) finish(new Error(e.message || "上游错误"));
        }));
        await plugin.request({ id, url: req.url, headers: req.headers, body: JSON.stringify(req.payload) });
      } catch (e) { finish(e); }
    })();
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("已复制到剪贴板");
  }
}

// ---------------- 极简 Markdown（解析失败降级展示） ----------------
function md(src) {
  const inline = (t) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  const out = [];
  let para = [], list = null;
  const flushP = () => { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } };
  const flushL = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { flushP(); flushL(); continue; }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      flushP(); flushL();
      const lv = Math.min(m[1].length + 1, 4);
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
    } else if ((m = l.match(/^[-•]\s+(.*)$/))) {
      flushP();
      if (list !== "ul") { flushL(); out.push("<ul>"); list = "ul"; }
      out.push("<li>" + inline(m[1]) + "</li>");
    } else {
      flushL(); para.push(l);
    }
  }
  flushP(); flushL();
  return out.join("\n");
}

// ---------------- 配置缓存 ----------------
let config = null;
async function loadConfig(force) {
  if (config && !force) return config;
  try { config = await api("/api/config"); } catch (e) { config = null; }
  return config;
}

function salaryReady(cfg) {
  return cfg && cfg.hourly > 0;
}

// ---------------- 路由 ----------------
window.addEventListener("hashchange", route);

function route() {
  const h = location.hash || "#/home";
  const m = h.match(/^#\/([a-z]+)(?:\/([\w-]+))?(\/auto)?/);
  const page = m ? m[1] : "home";
  $$(".topbar nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
  window.scrollTo(0, 0);
  if (page === "record" && m[2]) return renderRecord(m[2], !!m[3]);
  if (page === "settings") return renderSettings();
  if (["home", "judge", "ledger", "report"].indexOf(page) >= 0) return guardOnboarding(page);
  return renderHome();
}

async function guardOnboarding(page) {
  const cfg = await loadConfig(true);
  if (!salaryReady(cfg)) return renderOnboarding();
  if (page === "judge") return renderJudge();
  if (page === "ledger") return renderLedger();
  if (page === "report") return renderReport();
  return renderHome();
}

// ---------------- 首次引导：工资设定 ----------------
let onboard = { step: 0, monthly: "", days: "21.75", hours_per_day: "8", persona: "salty" };

function renderOnboarding() {
  const wage = () => Bacao.hourlyWage(onboard.monthly, onboard.days, onboard.hours_per_day);
  const stepNames = ["① 月薪", "② 工作时间", "③ 审判人格"];
  const personas = Object.entries(Bacao.PERSONAS);
  let body = "";
  if (onboard.step === 0) {
    body = `
      <div class="onboard-step">第 1 / 3 步</div>
      <h2>先把军费报上来 <span class="sub">拔草机需要知道你的时薪</span></h2>
      <label class="field">每月到手工资（元，税后实发更准）</label>
      <input type="number" id="ob-monthly" min="1" step="100" placeholder="例：10000" value="${esc(onboard.monthly)}">
      <div class="hint">只在本机保存，用于把价格换算成「生命小时数」。不上传、不联网同步。</div>
      <div class="btn-row"><button class="btn primary big" id="ob-next" ${onboard.monthly > 0 ? "" : "disabled"}>下一步 →</button></div>`;
  } else if (onboard.step === 1) {
    body = `
      <div class="onboard-step">第 2 / 3 步</div>
      <h2>这个月要卖多少小时给老板</h2>
      <label class="field">每月工作天数</label>
      <input type="number" id="ob-days" min="1" max="31" step="0.5" value="${esc(onboard.days)}">
      <label class="field">每天工作小时数</label>
      <input type="number" id="ob-hours" min="1" max="16" step="0.5" value="${esc(onboard.hours_per_day)}">
      ${wage() > 0 ? `<div class="onboard-big">你的时薪 ¥${Bacao.fmtNum(wage())} —— 以后每笔消费都会换算成「多少小时的班」</div>` : ""}
      <div class="btn-row">
        <button class="btn ghost" id="ob-prev">← 上一步</button>
        <button class="btn primary big" id="ob-next">下一步 →</button>
      </div>`;
  } else {
    body = `
      <div class="onboard-step">第 3 / 3 步</div>
      <h2>选一位审判者 <span class="sub">只换语气，不换判决逻辑</span></h2>
      <div class="persona-grid">${personas.map(([pid, p]) => `
        <div class="persona-card ${onboard.persona === pid ? "active" : ""}" data-p="${pid}">
          <div class="pe">${p.emoji}</div>
          <div><div class="pl">${esc(p.label)}</div><div class="pd">${esc(p.desc)}</div></div>
        </div>`).join("")}
      </div>
      <div class="btn-row">
        <button class="btn ghost" id="ob-prev">← 上一步</button>
        <button class="btn primary big" id="ob-done">💰 开始守工资</button>
      </div>`;
  }

  app.innerHTML = `<section><div class="card hero">${body}
    <div class="hint" style="margin-top:16px">「拔草机」是一个娱乐性理性消费辅助工具：想买东西先来过一审，AI 专给不买的理由，帮你冷静。判定仅供参考。</div>
  </div></section>`;

  const wire = (id, key) => {
    const el = $(id);
    if (el) el.addEventListener("input", () => { onboard[key] = el.value; refreshObButtons(); });
  };
  function refreshObButtons() {
    const next = $("#ob-next");
    if (next && onboard.step === 0) next.disabled = !(Number(onboard.monthly) > 0);
  }
  wire("#ob-monthly", "monthly"); wire("#ob-days", "days"); wire("#ob-hours", "hours_per_day");
  $$(".persona-card").forEach((c) => c.addEventListener("click", () => {
    onboard.persona = c.dataset.p;
    $$(".persona-card").forEach((x) => x.classList.toggle("active", x.dataset.p === onboard.persona));
  }));
  const prev = $("#ob-prev");
  if (prev) prev.addEventListener("click", () => { onboard.step--; renderOnboarding(); });
  const next = $("#ob-next");
  if (next) next.addEventListener("click", () => {
    if (onboard.step === 0 && !(Number(onboard.monthly) > 0)) { toast("月薪得大于 0 呀"); return; }
    onboard.step++;
    renderOnboarding();
  });
  const done = $("#ob-done");
  if (done) done.addEventListener("click", async () => {
    done.disabled = true;
    try {
      await api("/api/config", { method: "POST", body: {
        salary: { monthly: Number(onboard.monthly), days: Number(onboard.days), hours_per_day: Number(onboard.hours_per_day) },
        persona: onboard.persona,
      } });
      config = null;
      toast("军费已入账，开始过审！");
      location.hash = "#/home";
    } catch (e) { toast(e.message); done.disabled = false; }
  });
}

// ---------------- 首页 ----------------
async function renderHome() {
  const [cfg, data] = await Promise.all([loadConfig(), api("/api/stats")]);
  if (!salaryReady(cfg)) return renderOnboarding();
  const st = data.stats;
  const due = data.cooling_due || [];
  const ledger = MODE === "client" ? clientLedger() : [];
  const dustCount = st.dust_count;
  const pct = cfg.salary.monthly > 0 ? Math.min(100, Math.round(st.month_saved / cfg.salary.monthly * 100)) : 0;
  const persona = Bacao.PERSONAS[cfg.persona] || Bacao.PERSONAS.salty;

  app.innerHTML = `
  <section>
    <div class="card hero">
      <h2>你的时薪 <span class="sub">${esc(persona.emoji)} ${esc(persona.label)}在岗</span></h2>
      <div class="wage"><b>¥${Bacao.fmtNum(cfg.hourly)}</b><small>/小时 · 月薪 ¥${Bacao.fmtNum(cfg.salary.monthly)} ÷ ${Bacao.fmtNum(cfg.salary.days)} 天 × ${Bacao.fmtNum(cfg.salary.hours_per_day)} 时</small></div>
      <div class="hint">想买任何东西前，先来「过审」——每笔都会换算成你多少小时的班。</div>
    </div>
    <div class="card">
      <h2>本月已守住 <span class="sub">${st.month}</span></h2>
      <div class="bignum"><small>¥</small>${Bacao.fmtNum(st.month_saved)}</div>
      <div class="wall-label"><span>🛡️ 工资城墙</span><span>${pct}%（按月薪计）</span></div>
      <div class="wall"><div class="brick" style="width:${pct}%"></div></div>
      <div class="stat-grid">
        <div class="stat-cell"><div class="v green">${st.success_rate}%</div><div class="k">拔草成功率</div></div>
        <div class="stat-cell"><div class="v gold">¥${Bacao.fmtNum(st.total_saved)}</div><div class="k">累计守住</div></div>
        <div class="stat-cell"><div class="v red">${dustCount}</div><div class="k">吃灰名单</div></div>
      </div>
      <div class="btn-row">
        <a class="btn primary big" href="#/judge" style="text-decoration:none">🛒 有东西想买？先过一审 →</a>
      </div>
    </div>
    ${due.length ? `
    <div class="card">
      <h2>冷静期回访 <span class="sub">72 小时到了，还想买吗？</span></h2>
      ${due.map((r) => `
        <div class="dust-card" data-id="${esc(r.id)}">
          <div class="dq">${esc(r.item)} <span class="tag gold">¥${Bacao.fmtNum(r.price)}</span></div>
          <div class="dm">${esc(r.created)} 送进冷静清单 · 冷静结束：${esc(r.cool_until)}</div>
          <div class="btn-row">
            <button class="btn primary small" data-cool="cool_didnt_buy">😴 没买（拔草成功 +¥${Bacao.fmtNum(r.price)}）</button>
            <button class="btn ghost small" data-cool="cool_bought">😅 还是买了</button>
          </div>
        </div>`).join("")}
    </div>` : ""}
    <div class="card">
      <h2>军情速览</h2>
      <div class="chip-row">
        <span class="tag">累计过审 ${st.judged_total} 件</span>
        <span class="tag red">🚫 拔草 ${st.weed_total}</span>
        <span class="tag amber">😐 冷静中 ${st.cool_pending}</span>
        <span class="tag">✅ 放行 ${st.pass_total}</span>
        <span class="tag meta">听劝 ${st.total_kept_count} 次</span>
      </div>
      <div class="btn-row">
        <a class="btn ghost small" href="#/ledger" style="text-decoration:none">翻拔草台账 →</a>
        <a class="btn ghost small" href="#/report" style="text-decoration:none">看月度战报 →</a>
      </div>
    </div>
  </section>`;

  $$("[data-cool]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest(".dust-card").dataset.id;
    const outcome = b.dataset.cool;
    try {
      await api("/api/ledger/" + id + "/outcome", { method: "POST", body: { outcome } });
      if (outcome === "cool_bought") { cutPop(); toast("已记入吃灰名单，下次翻旧账"); }
      else { toast("拔草成功，工资又守住一笔！"); }
      renderHome();
    } catch (e) { toast(e.message); }
  }));
}

// ---------------- 过审页 ----------------
let judgeForm = { item: "", price: "", why: "", source: "", image: "", thumb: "" };

async function renderJudge() {
  const cfg = await loadConfig();
  if (!salaryReady(cfg)) return renderOnboarding();
  app.innerHTML = `
  <section>
    <div class="card">
      <h2>拔草过审 <span class="sub">AI 抠门管家 · 判定仅供参考</span></h2>
      <label class="field">想买的东西</label>
      <input type="text" id="j-item" maxlength="40" placeholder="例：机械键盘 / 泡脚桶 / 第 5 件外套" value="${esc(judgeForm.item)}">
      <label class="field">价格（元）</label>
      <input type="number" id="j-price" min="0.01" step="0.01" placeholder="例：899" value="${esc(judgeForm.price)}">
      <div class="hint" id="j-convert">你的时薪 <b>¥${Bacao.fmtNum(cfg.hourly)}</b>，填价格即可换算成「多少小时的班」。</div>
      <label class="field">为什么想买（可选，说得越真，判得越准）</label>
      <textarea id="j-why" rows="2" maxlength="200" placeholder="例：直播间说最后 100 套 / 加班想要奖励自己">${esc(judgeForm.why)}</textarea>
      <label class="field">在哪看到的（可选）</label>
      <input type="text" id="j-source" maxlength="100" placeholder="例：抖音直播间 / 朋友晒图 / 京东首页">
      <label class="field">购物截图（可选）<span class="warn">支持多模态识别</span></label>
      <input type="file" id="j-file" accept="image/png,image/jpeg,image/webp" style="display:none">
      <div class="img-pick" id="j-img-pick">
        <button class="btn ghost small" id="j-pick">📸 附购物截图</button>
        <span class="hint" style="margin-top:0">商品页 / 直播间 / 购物车都行——AI 会拆解截图里的价格与商家话术</span>
      </div>
      <div class="img-preview" id="j-img-preview" hidden>
        <img id="j-thumb" alt="截图缩略图">
        <div class="ip-meta"><span id="j-img-info"></span><br><button class="btn ghost small" id="j-img-del">✕ 移除截图</button></div>
      </div>
      <div id="j-dust"></div>
      <div class="btn-row">
        <button class="btn primary big" id="j-go">📄 递交审批单 →</button>
      </div>
    </div>
  </section>`;

  const itemEl = $("#j-item"), priceEl = $("#j-price"), whyEl = $("#j-why"), srcEl = $("#j-source");
  const conv = $("#j-convert"), dustBox = $("#j-dust");
  const paintImg = () => {
    const box = $("#j-img-preview");
    if (judgeForm.thumb) {
      box.hidden = false;
      $("#j-img-pick").hidden = true;
      $("#j-thumb").src = judgeForm.thumb;
      $("#j-img-info").textContent = "截图已就绪（自动压缩，判定时随单发给 AI）";
    } else {
      box.hidden = true;
      $("#j-img-pick").hidden = false;
    }
  };
  $("#j-pick").addEventListener("click", () => $("#j-file").click());
  $("#j-file").addEventListener("change", async () => {
    const f = $("#j-file").files[0];
    if (!f) return;
    const btn = $("#j-pick");
    btn.disabled = true; btn.textContent = "压缩截图…";
    try {
      const r = await prepareScreenshot(f);
      judgeForm.image = r.image;
      judgeForm.thumb = r.thumb;
      paintImg();
    } catch (e) { toast(e.message); }
    finally {
      btn.disabled = false; btn.textContent = "📸 附购物截图";
      $("#j-file").value = "";
    }
  });
  $("#j-img-del").addEventListener("click", () => {
    judgeForm.image = ""; judgeForm.thumb = "";
    paintImg();
  });
  const refresh = () => {
    const p = Number(judgeForm.price);
    if (p > 0) {
      const h = Bacao.hoursText(p, cfg.hourly);
      conv.innerHTML = h
        ? `这笔 <b>¥${Bacao.fmtNum(p)}</b> 相当于你 <b class="warn">${esc(h)}</b>。`
        : `这笔 <b>¥${Bacao.fmtNum(p)}</b>。`;
    } else {
      conv.innerHTML = `你的时薪 <b>¥${Bacao.fmtNum(cfg.hourly)}</b>，填价格即可换算成「多少小时的班」。`;
    }
    // 吃灰翻旧账实时提示
    const ledger = MODE === "client" ? clientLedger() : [];
    const lines = Bacao.dustLines(ledger, judgeForm.item || "");
    dustBox.innerHTML = lines.length
      ? `<div class="hint warn">⚠️ 翻旧账：${lines.map(esc).join("；")}</div>`
      : "";
  };
  itemEl.addEventListener("input", () => { judgeForm.item = itemEl.value; refresh(); });
  priceEl.addEventListener("input", () => { judgeForm.price = priceEl.value; refresh(); });
  whyEl.addEventListener("input", () => { judgeForm.why = whyEl.value; });
  srcEl.addEventListener("input", () => { judgeForm.source = srcEl.value; });
  refresh();
  paintImg();

  $("#j-go").addEventListener("click", async () => {
    const btn = $("#j-go");
    if (!judgeForm.item.trim()) { toast("先写下想买的东西"); return; }
    if (!(Number(judgeForm.price) > 0)) { toast("价格得是大于 0 的数字"); return; }
    btn.disabled = true; btn.textContent = "递交中…";
    try {
      const data = await api("/api/judge", {
        method: "POST",
        body: {
          item: judgeForm.item.trim(),
          price: Number(judgeForm.price),
          why: judgeForm.why.trim(),
          source: judgeForm.source.trim(),
          image: judgeForm.image || undefined,
          thumb: judgeForm.thumb || undefined,
        },
      });
      judgeForm = { item: "", price: "", why: "", source: "", image: "", thumb: "" };
      location.hash = "#/record/" + data.record.id + "/auto";
    } catch (e) {
      toast(e.message);
      btn.disabled = false; btn.textContent = "📄 递交审批单 →";
    }
  });
}

// ---------------- 审批单页 ----------------
let verdictCtl = null;

async function renderRecord(id, auto) {
  let record;
  try {
    record = (await api("/api/ledger/" + id)).record;
  } catch (e) {
    app.innerHTML = `<div class="card"><div class="err-box">记录不存在或已删除。<br><a href="#/ledger">← 返回台账</a></div></div>`;
    return;
  }
  const cfg = (await loadConfig()) || { providers: {}, provider: "", hourly: 0 };
  const provChips = Object.entries(cfg.providers || {}).map(([pid, p]) =>
    `<span class="chip ${pid === cfg.provider ? "active" : ""}" data-prov="${pid}">${esc(p.label)}</span>`).join("");
  const h = Bacao.hoursText(record.price, record.hourly || cfg.hourly);
  const dustNames = (record.dust_used || []).length;

  app.innerHTML = `
  <section>
    <div class="paper">
      <div class="form-no">NO.${esc(record.id)} · ${esc(record.created)} · ${esc((Bacao.PERSONAS[record.persona] || Bacao.PERSONAS.salty).emoji)}${esc((Bacao.PERSONAS[record.persona] || Bacao.PERSONAS.salty).label)}在审</div>
      <h3>${esc(record.item)}</h3>
      <div class="price-line">
        <span class="price">¥${Bacao.fmtNum(record.price)}</span>
        ${h ? `<span class="hours">≈ 你 ${esc(h)}</span>` : ""}
      </div>
      ${record.why || record.source ? `<div class="meta-row">
        ${record.why ? "申请理由：" + esc(record.why) + "<br>" : ""}
        ${record.source ? "种草来源：" + esc(record.source) : ""}
      </div>` : ""}
      ${record.thumb ? `<div class="img-attach"><img src="${esc(record.thumb)}" alt="购物截图"><span class="tag gold">📎 附购物截图 · AI 已识图</span></div>` : ""}
      ${dustNames ? `<div class="meta-row">📂 本次过审已翻你的旧账（${dustNames} 条吃灰记录）</div>` : ""}
      <div id="stamp-slot"></div>
    </div>
    <div class="card">
      <h2>AI 审批 <span class="sub">流式输出 · 自动入账</span></h2>
      <div class="chips" id="prov-chips">${provChips}</div>
      <div class="btn-row">
        <button class="btn primary" id="start-verdict">${record.verdict || record.ai_text ? "重新过审" : "开始过审"}</button>
        <button class="btn ghost" id="stop-verdict" style="display:none">停止</button>
        ${(record.verdict && record.parse_ok) ? '<button class="btn ghost small" id="copy-verdict">复制判定</button>' : ""}
      </div>
      ${record.parse_ok === false && record.ai_text ? '<div class="hint warn">上次 AI 输出没能解析成判定 JSON，以下为原文降级展示；可「重新过审」或在下方手动归档。</div>' : ""}
      <div class="stream ${record.ai_text ? "" : "waiting"}" id="verdict-area">${
        record.ai_text
          ? (record.parse_ok ? verdictCardHtml(record) : md(record.ai_text))
          : "点「开始过审」，抠门管家马上到岗。"
      }</div>
      <div class="err-box" id="verdict-err" hidden></div>
      <div id="actions-slot"></div>
    </div>
    <div class="btn-row">
      <a class="btn ghost small" href="#/ledger" style="text-decoration:none">← 台账</a>
    </div>
  </section>`;

  $$("#prov-chips .chip").forEach((c) =>
    c.addEventListener("click", async () => {
      const pid = c.dataset.prov;
      try {
        await api("/api/config", { method: "POST", body: { provider: pid } });
        cfg.provider = pid;
        $$("#prov-chips .chip").forEach((x) => x.classList.toggle("active", x.dataset.prov === pid));
        toast("默认审判服务：" + cfg.providers[pid].label);
      } catch (e) { toast(e.message); }
    }));
  $("#start-verdict").addEventListener("click", () => startVerdict(record.id));
  $("#stop-verdict").addEventListener("click", () => {
    if (verdictCtl) verdictCtl.abort();
    if (nativeStreamCancel) nativeStreamCancel();
  });
  const cv = $("#copy-verdict");
  if (cv) cv.addEventListener("click", () => copyText(shareOneText(record)));

  if (record.verdict || (record.ai_text && record.parse_ok === false)) renderActions(record);
  if (auto && !record.verdict && !record.ai_text) startVerdict(record.id);
}

function verdictCardHtml(nv, opts) {
  const lv = Bacao.VERDICT_LABELS[nv.verdict] || { emoji: "❓", label: "未知", stamp: "?" };
  const conf = nv.confidence != null ? nv.confidence : null;
  let html = `
    <div class="verdict-head">
      <span class="vt ${esc(nv.verdict)}">${lv.emoji} ${esc(lv.label)}${nv.manual ? "（手动归档）" : ""}</span>
      <div class="confidence">
        <div class="cl"><span>置信拔草指数</span><b>${conf != null ? conf : "?"}</b></div>
        <div class="conf-bar"><div class="conf-fill" style="width:${conf != null ? conf : 0}%"></div></div>
      </div>
    </div>`;
  if (nv.reasons && nv.reasons.length) {
    html += `<div class="reason-list">${nv.reasons.map((r, i) => `
      <div class="reason-row"><span class="idx">${i + 1}</span><span>${esc(r.text)}</span>
        <span class="sting">${"⚡".repeat(r.sting || 1)}${r.sting || 1}</span></div>`).join("")}</div>`;
  }
  if (nv.questions && nv.questions.length) {
    html += `<div class="q-list">${nv.questions.map((q, i) => `
      <div class="q-row"><span class="qk">Q${i + 1}</span><span>${esc(q)}</span></div>`).join("")}</div>`;
  }
  if (nv.alternatives && nv.alternatives.length) {
    html += `<div class="alt-list">${nv.alternatives.map((a, i) => `
      <div class="alt-row"><span class="qk">${["💡", "🛒", "🎟️", "♻️"][i % 4]}</span><span>${esc(a)}</span></div>`).join("")}</div>`;
  }
  if (opts && opts.partial) html += `<div style="margin-top:8px"><span class="cursor">▍</span> <span style="font-size:12px;color:var(--ink-faint)">管家正在写审批意见…</span></div>`;
  return html;
}

function renderActions(record) {
  const slot = $("#actions-slot");
  if (!slot) return;
  if (!record.verdict) {
    // 解析失败的手动归档
    slot.innerHTML = `
      <div class="hint">AI 输出无法解析，手动归档（只定档，不定结果）：</div>
      <div class="btn-row">
        <button class="btn danger small" data-manual="weed">🚫 归为拔草</button>
        <button class="btn amber small" data-manual="cool">😐 归为冷静</button>
        <button class="btn primary small" data-manual="pass">✅ 归为放行</button>
      </div>`;
    $$("[data-manual]", slot).forEach((b) => b.addEventListener("click", async () => {
      try {
        await api("/api/ledger/" + record.id + "/verdict", { method: "POST", body: { verdict: b.dataset.manual } });
        toast("已归档");
        renderRecord(record.id, false);
      } catch (e) { toast(e.message); }
    }));
    return;
  }
  const o = record.outcome;
  const price = Bacao.fmtNum(record.price);
  const coolLeft = record.verdict === "cool" && o === "cool_pending" && record.cool_until
    ? hoursLeft(record.cool_until) : null;
  let html = "";
  if (record.verdict === "weed") {
    if (o === "pending") {
      html = `
        <div class="btn-row">
          <button class="btn primary big" data-act="kept">✂️ 听劝，没买（守住 ¥${price}）</button>
          <button class="btn ghost" data-act="bought">😅 最后还是买了</button>
        </div>`;
    } else {
      html = `<div class="interp-meta">结果：${esc(Bacao.OUTCOME_LABELS[o] || o)}${record.outcome_at ? " · " + esc(record.outcome_at) : ""}</div>`;
    }
  } else if (record.verdict === "cool") {
    if (o === "cool_pending") {
      html = `
        <div class="interp-meta">😐 已进入 72 小时冷静清单${coolLeft != null ? (coolLeft <= 0 ? " · <b class='ok-box'>冷静期已满，可以回访了</b>" : " · 还剩约 " + coolLeft + " 小时（" + esc(record.cool_until) + " 到点）") : ""}</div>
        <div class="btn-row">
          <button class="btn primary" data-act="cool_didnt_buy">😴 回访：没买（拔草成功）</button>
          <button class="btn ghost" data-act="cool_bought">😅 回访：还是买了（进吃灰名单）</button>
        </div>
        <div class="hint">冷静期到点后，首页会出现回访提醒；也可以现在就回填结果。</div>`;
    } else {
      html = `<div class="interp-meta">结果：${esc(Bacao.OUTCOME_LABELS[o] || o)}${record.outcome_at ? " · " + esc(record.outcome_at) : ""}</div>`;
    }
  } else if (record.verdict === "pass") {
    if (o === "pending") {
      html = `
        <div class="hint">管家放行了，记得按「聪明买法」执行：等大促 / 凑券 / 看二手 / 比同价位更优解。</div>
        <div class="btn-row">
          <button class="btn primary small" data-act="pass_bought">🛍️ 已下单（按聪明买法）</button>
        </div>`;
    } else {
      html = `<div class="interp-meta">结果：${esc(Bacao.OUTCOME_LABELS[o] || o)}${record.outcome_at ? " · " + esc(record.outcome_at) : ""}</div>`;
    }
  }
  if (html) {
    slot.innerHTML = `<div style="border-top:1px dashed var(--line);margin-top:12px;padding-top:6px">${html}</div>`;
    $$("[data-act]", slot).forEach((b) => b.addEventListener("click", async () => {
      const act = b.dataset.act;
      try {
        await api("/api/ledger/" + record.id + "/outcome", { method: "POST", body: { outcome: act } });
        if (act === "kept" || act === "cool_didnt_buy") { cutPop(); toast("守住 ¥" + price + "，干得漂亮！"); }
        else if (act === "bought" || act === "cool_bought") { toast("已记入吃灰名单，下次翻旧账"); }
        else { toast("已记入台账"); }
        renderRecord(record.id, false);
      } catch (e) { toast(e.message); }
    }));
  }
}

function hoursLeft(untilStr) {
  const until = new Date(String(untilStr).replace(/-/g, "/"));
  if (!isFinite(until.getTime())) return null;
  return Math.max(0, Math.round((until.getTime() - Date.now()) / 3600000));
}

async function startVerdict(rid) {
  if (verdictCtl) return;
  const area = $("#verdict-area");
  const errBox = $("#verdict-err");
  const startBtn = $("#start-verdict");
  const stopBtn = $("#stop-verdict");
  let record;
  try {
    record = (await api("/api/ledger/" + rid)).record;
  } catch (e) { toast(e.message); return; }
  if (MODE === "client") {
    // 离线直连：原生插件流式；浏览器退回整段返回
    startBtn.disabled = true;
    errBox.hidden = true;
    area.classList.remove("waiting");
    const stream = nativeStreamHttp();
    stopBtn.style.display = stream ? "" : "none";
    let buf = "", reasonBuf = "", lastPaint = 0;
    const t0 = Date.now();
    const paint = (final) => {
      const nv = Bacao.parsePartial(buf);
      if (nv && (nv.reasons.length || nv.confidence != null || nv.verdict)) {
        area.innerHTML = verdictCardHtml(nv, { partial: !final }) + (final ? "" : "");
      } else {
        const thinking = !final && !buf;
        const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
        area.innerHTML = thinking
          ? '<div class="think-status">😈 抠门管家翻账本中 · ' + secs + "s"
            + (reasonBuf ? " · 已推理 " + reasonBuf.length + " 字" : "")
            + '<div class="sub2">正在核对你的时薪、吃灰记录和商家话术</div></div>'
          : "<pre>" + esc(buf) + "</pre>";
      }
    };
    const tick = stream ? setInterval(() => { if (!buf) paint(false); }, 1000) : null;
    area.innerHTML = stream ? "" : '<span class="cursor">▍</span> 正在过审（直连 AI，生成完整体显示）…';
    try {
      let text;
      if (stream) {
        text = await clientVerdictStream(record, cfgProvider(), (st) => {
          buf = st.content;
          reasonBuf = st.reason || "";
          const now = performance.now();
          if (now - lastPaint > 120) { lastPaint = now; paint(false); }
        });
      } else {
        area.innerHTML = '<span class="cursor">▍</span> 正在过审…';
        text = await clientVerdict(record, cfgProvider());
      }
      buf = text;
      paint(true);
      finishVerdictUI(rid, record, buf);
    } catch (e) {
      if (buf) paint(true);
      errBox.hidden = false;
      errBox.textContent = hintFor(e.message);
      if (!buf) { area.classList.add("waiting"); area.textContent = "过审未完成"; }
    } finally {
      if (tick) clearInterval(tick);
      startBtn.disabled = false;
      stopBtn.style.display = "none";
    }
    return;
  }

  // 服务器模式
  errBox.hidden = true;
  startBtn.disabled = true;
  stopBtn.style.display = "";
  area.classList.remove("waiting");
  area.innerHTML = '<span class="cursor">▍</span>';
  let buf = "", lastPaint = 0;
  const paint = () => {
    const nv = Bacao.parsePartial(buf);
    if (nv && (nv.reasons.length || nv.confidence != null || nv.verdict)) {
      area.innerHTML = verdictCardHtml(nv, { partial: true });
    } else {
      area.innerHTML = "<pre>" + esc(buf) + '</pre><span class="cursor">▍</span>';
    }
  };
  verdictCtl = new AbortController();
  try {
    const res = await fetch("/api/verdict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: rid, provider: cfgProvider() }),
      signal: verdictCtl.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || "HTTP " + res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const now = performance.now();
      if (now - lastPaint > 120) { lastPaint = now; paint(); }
    }
    finishVerdictUI(rid, record, buf);
  } catch (e) {
    if (e.name === "AbortError") {
      paint();
      toast("已停止（已生成部分自动保存）");
      setTimeout(() => renderRecord(rid, false), 400);
    } else {
      if (buf) paint();
      errBox.hidden = false;
      errBox.textContent = hintFor(e.message);
    }
  } finally {
    verdictCtl = null;
    startBtn.disabled = false;
    stopBtn.style.display = "none";
  }
}

function cfgProvider() {
  return (config && config.provider) || "glm";
}

// 判定流结束：展示最终卡 + 盖章 + 结果操作
async function finishVerdictUI(rid, record, buf) {
  const area = $("#verdict-area");
  let fresh;
  try { fresh = (await api("/api/ledger/" + rid)).record; } catch (e) { fresh = null; }
  const r = fresh || record;
  if (r.parse_ok && Bacao.VERDICT_LABELS[r.verdict]) {
    area.innerHTML = verdictCardHtml(r, { partial: false });
    const slot = $("#stamp-slot");
    const lv = Bacao.VERDICT_LABELS[r.verdict];
    slot.innerHTML = `<div class="stamp ${esc(r.verdict)} show">${esc(lv.stamp)}<span class="vsmall">拔草机 · ${r.confidence != null ? "拔草指数 " + r.confidence : ""}</span></div>`;
    toast({ weed: "🚫 不予批准——管家的刀已出鞘", cool: "😐 暂缓批准，先进冷静清单", pass: "✅ 准予购买，但要聪明地买" }[r.verdict] || "已入账");
  } else {
    area.innerHTML = md(buf || "") + '<div class="hint warn">（AI 输出没能解析成判定 JSON，以上为原文；可在下方手动归档）</div>';
  }
  const cv = $("#copy-verdict");
  if (cv) cv.style.display = "";
  renderActions(r);
}

function hintFor(msg) {
  let out = "过审失败：" + msg;
  if (/401|403|api.?key|unauthorized/i.test(msg)) {
    out += "\n提示：请到「设置」检查 API Key 是否正确保存。";
  } else if (/429|1113|余额|资源包|quota|rate.?limit/i.test(msg)) {
    out += "\n提示：账户额度不足——Coding Plan 需用开通订阅的账号创建「Coding Plan 类型」密钥；个人 Key 会报余额不足。";
  } else if (/404|model/i.test(msg)) {
    out += "\n提示：请到「设置」核对模型名称。";
  }
  return out;
}

// ---------------- 分享文本 ----------------
function shareOneText(r) {
  const lv = Bacao.VERDICT_LABELS[r.verdict] || { emoji: "❓", label: "?" };
  const lines = [
    "【拔草机 · AI 审批单】",
    "想买：" + r.item + " ¥" + Bacao.fmtNum(r.price),
  ];
  const h = Bacao.hoursText(r.price, r.hourly);
  if (h) lines.push("折算：你 " + h);
  lines.push("判定：" + lv.emoji + " " + lv.label + "（" + lv.stamp + "）" +
    (r.confidence != null ? " · 拔草指数 " + r.confidence : ""));
  if (r.reasons && r.reasons.length) {
    lines.push("AI 的理由：");
    r.reasons.slice(0, 3).forEach((x, i) => {
      lines.push("  " + (i + 1) + ". " + x.text + " " + "⚡".repeat(x.sting || 1));
    });
  }
  if (r.verdict === "weed") lines.push("这一刀守住了 ¥" + Bacao.fmtNum(r.saved_amount || r.price));
  lines.push("—— 买前过一审，工资自己守");
  return lines.join("\n");
}

function shareMonthText(m, all) {
  const lines = [
    "【拔草机 · " + m.month + " 战报】",
    "本月我为工资守住了 ¥" + Bacao.fmtNum(m.saved) + "，听劝拔草 " + m.kept_count + " 件",
    "过审 " + m.judged + " 件 · 拔草成功率 " + m.weed_rate + "% · 吃灰率 " + m.dust_rate + "%",
  ];
  if (m.max_weed) lines.push("最狠的一刀：" + m.max_weed.item + "（¥" + Bacao.fmtNum(m.max_weed.price) + "）");
  if (m.max_pass) lines.push("最大方的放行：" + m.max_pass.item + "（¥" + Bacao.fmtNum(m.max_pass.price) + "）");
  lines.push("累计守住 ¥" + Bacao.fmtNum(all.total_saved));
  lines.push("—— 买前过一审，工资自己守 💪");
  return lines.join("\n");
}

// ---------------- 台账页 ----------------
let ledgerFilter = "all";

async function renderLedger() {
  const cfg = await loadConfig();
  if (!salaryReady(cfg)) return renderOnboarding();
  const data = await api("/api/ledger");
  const all = data.records;
  const st = data.stats;
  const nowStr = Bacao.fmtNow();
  const filters = [
    ["all", "全部"], ["weed", "🚫 拔草"], ["cool", "😐 冷静"],
    ["pass", "✅ 放行"], ["dust", "🌰 吃灰"], ["cooling", "⏳ 冷静期中"],
  ];
  const list = all.filter((r) => {
    if (ledgerFilter === "all") return true;
    if (ledgerFilter === "weed") return r.verdict === "weed";
    if (ledgerFilter === "cool") return r.verdict === "cool";
    if (ledgerFilter === "pass") return r.verdict === "pass";
    if (ledgerFilter === "dust") return Bacao.DUST_OUTCOMES.indexOf(r.outcome) >= 0;
    if (ledgerFilter === "cooling") return r.outcome === "cool_pending";
    return true;
  });

  app.innerHTML = `
  <section>
    <div class="card">
      <h2>拔草台账 <span class="sub">${st.judged_total} 件过审 · 听劝守住 ¥${Bacao.fmtNum(st.total_saved)}</span></h2>
      <div class="chips">${filters.map(([k, label]) =>
        `<span class="chip ${ledgerFilter === k ? "active" : ""}" data-f="${k}">${label}</span>`).join("")}</div>
    </div>
    ${list.length ? list.map((r) => {
      const lv = Bacao.VERDICT_LABELS[r.verdict];
      const outcomeTag = r.verdict
        ? `<span class="tag ${r.outcome === "kept" || r.outcome === "cool_didnt_buy" ? "" : r.outcome === "pending" || r.outcome === "cool_pending" ? "amber" : "red"}">${esc(Bacao.OUTCOME_LABELS[r.outcome] || r.outcome)}</span>`
        : '<span class="tag meta">未判定</span>';
      const coolingNote = r.outcome === "cool_pending" && r.cool_until
        ? `<span class="tag ${r.cool_until <= nowStr ? "red" : "meta"}">${r.cool_until <= nowStr ? "到点待回访" : "到点 " + esc(String(r.cool_until).slice(5, 16))}</span>`
        : "";
      return `
      <div class="hist-card" data-id="${esc(r.id)}">
        <div class="hist-v">${lv ? lv.emoji : "❔"}</div>
        <div class="hist-main">
          <div class="hist-q">${esc(r.item)} · ¥${Bacao.fmtNum(r.price)}</div>
          <div class="hist-meta">
            <span>${esc(r.created.slice(0, 16))}</span>
            ${r.confidence != null ? `<span>指数 ${r.confidence}</span>` : ""}
            ${outcomeTag}${coolingNote}
          </div>
        </div>
        <button class="hist-del" data-del="${esc(r.id)}" title="删除">✕</button>
      </div>`;
    }).join("") : '<div class="card empty"><div class="big">🛒</div>还没有过审记录<br><br><a class="btn primary" href="#/judge" style="text-decoration:none">去递交第一单</a></div>'}
  </section>`;

  $$("[data-f]").forEach((c) => c.addEventListener("click", () => { ledgerFilter = c.dataset.f; renderLedger(); }));
  $$(".hist-card").forEach((c) =>
    c.addEventListener("click", (ev) => {
      if (ev.target.dataset.del) return;
      location.hash = "#/record/" + c.dataset.id;
    }));
  $$("[data-del]").forEach((b) =>
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm("删除这条台账记录？")) return;
      try { await api("/api/ledger/" + b.dataset.del, { method: "DELETE" }); } catch (e) { toast(e.message); }
      renderLedger();
    }));
}

// ---------------- 月度战报页 ----------------
let reportMonth = "";

async function renderReport() {
  const cfg = await loadConfig();
  if (!salaryReady(cfg)) return renderOnboarding();
  const data = await api("/api/ledger");
  const st = data.stats;
  const months = st.monthly;
  if (!reportMonth && months.length) reportMonth = months[0].month;
  let m = months.find((x) => x.month === reportMonth);
  if (!m && months.length) { reportMonth = months[0].month; m = months[0]; }

  app.innerHTML = `
  <section>
    <div class="card">
      <h2>月度战报 <span class="sub">按月汇总 · 数据都在本机</span></h2>
      ${months.length ? `<div class="chips">${months.map((x) =>
        `<span class="chip ${reportMonth === x.month ? "active" : ""}" data-m="${esc(x.month)}">${esc(x.month)}</span>`).join("")}</div>`
        : '<div class="empty"><div class="big">📋</div>还没有战报，先去过几单</div>'}
      ${m ? `
      <div class="stat-grid" style="margin-top:14px">
        <div class="stat-cell"><div class="v green">¥${Bacao.fmtNum(m.saved)}</div><div class="k">守住金额</div></div>
        <div class="stat-cell"><div class="v">${m.weed_rate}%</div><div class="k">拔草成功率</div></div>
        <div class="stat-cell"><div class="v red">${m.dust_rate}%</div><div class="k">吃灰率</div></div>
      </div>
      <div class="chip-row" style="margin-top:12px">
        <span class="tag">过审 ${m.judged} 件</span>
        <span class="tag">听劝 ${m.kept_count} 件</span>
        <span class="tag red">吃灰 ${m.dust} 件（¥${Bacao.fmtNum(m.dust_amount)}）</span>
        ${m.max_weed ? `<span class="tag gold">最狠一刀：${esc(m.max_weed.item)} ¥${Bacao.fmtNum(m.max_weed.price)}</span>` : ""}
        ${m.max_pass ? `<span class="tag">最大放行：${esc(m.max_pass.item)} ¥${Bacao.fmtNum(m.max_pass.price)}</span>` : ""}
      </div>
      <div class="btn-row">
        <button class="btn primary big" id="share-month">📣 生成战报，复制分享</button>
      </div>
      <div class="share-box" id="share-preview" hidden></div>` : ""}
      <div class="hint" style="margin-top:14px">累计守住 <b>¥${Bacao.fmtNum(st.total_saved)}</b>（只计「🚫 拔草 + 听劝没买」）；冷静期 72h 后没买也算拔草成功，但不计入守住金额。</div>
    </div>
  </section>`;

  $$("[data-m]").forEach((c) => c.addEventListener("click", () => { reportMonth = c.dataset.m; renderReport(); }));
  const share = $("#share-month");
  if (share && m) share.addEventListener("click", () => {
    const text = shareMonthText(m, st);
    const box = $("#share-preview");
    box.hidden = false;
    box.textContent = text;
    copyText(text);
  });
}

// ---------------- 设置页 ----------------
async function renderSettings() {
  const cfg = await loadConfig(true);
  if (!cfg) { app.innerHTML = '<div class="card"><div class="err-box">无法读取配置</div></div>'; return; }
  const personas = Object.entries(Bacao.PERSONAS);
  const s = cfg.salary || { monthly: 0, days: 21.75, hours_per_day: 8 };

  app.innerHTML = `
  <section>
    <div class="card hero">
      <h2>工资设定 <span class="sub">当前时薪 ¥${Bacao.fmtNum(cfg.hourly || 0)}/小时</span></h2>
      <label class="field">每月到手工资（元）</label>
      <input type="number" id="s-monthly" min="0" step="100" value="${esc(s.monthly || "")}">
      <div class="grid2">
        <div>
          <label class="field">每月工作天数</label>
          <input type="number" id="s-days" min="1" max="31" step="0.5" value="${esc(s.days)}">
        </div>
        <div>
          <label class="field">每天工作小时</label>
          <input type="number" id="s-hours" min="1" max="16" step="0.5" value="${esc(s.hours_per_day)}">
        </div>
      </div>
      <div class="hint" id="s-wage"></div>
      <div class="btn-row"><button class="btn primary" id="save-salary">保存工资</button></div>
    </div>
    <div class="card">
      <h2>毒舌人格 <span class="sub">只换语气，不换判定逻辑</span></h2>
      <div class="persona-grid">${personas.map(([pid, p]) => `
        <div class="persona-card ${cfg.persona === pid ? "active" : ""}" data-p="${pid}">
          <div class="pe">${p.emoji}</div>
          <div><div class="pl">${esc(p.label)}</div><div class="pd">${esc(p.desc)}</div></div>
        </div>`).join("")}
      </div>
    </div>
    <div class="card">
      <h2>审判服务 <span class="sub">点标签可切换默认</span></h2>
      ${Object.entries(cfg.providers).map(([pid, p]) => `
        <div class="prov-card ${pid === cfg.provider ? "default" : ""}" data-pid="${pid}">
          <div class="prov-head">
            <span class="name">${esc(p.label)} ${pid === cfg.provider ? '<span class="tag">默认</span>' : ""}</span>
            <button class="btn small ghost" data-setdefault="${pid}">设为默认</button>
          </div>
          <label class="field">接口地址（Base URL）</label>
          <input type="url" data-f="base" value="${esc(p.base)}" placeholder="https://open.bigmodel.cn/api/coding/paas/v4">
          <div class="grid2">
            <div>
              <label class="field">协议</label>
              <select data-f="protocol">
                <option value="openai" ${p.protocol !== "anthropic" ? "selected" : ""}>OpenAI 兼容（/chat/completions）</option>
                <option value="anthropic" ${p.protocol === "anthropic" ? "selected" : ""}>Anthropic 兼容（/v1/messages）</option>
              </select>
            </div>
            <div>
              <label class="field">API Key</label>
              <input type="password" data-f="api_key" placeholder="${p.has_key ? "已保存（留空则不修改）" : "未设置"}" autocomplete="new-password">
            </div>
          </div>
          <label class="field">模型名 <span style="font-weight:400">（可下拉选择或手动输入）</span></label>
          <select data-f="model_select" hidden></select>
          <input type="text" data-f="model" value="${esc(p.model)}" placeholder="如 glm-5.3-flash" style="margin-top:8px">
          <label class="field">识图模型 <span style="font-weight:400">（购物截图判定用，如 glm-4.5v / glm-4v-flash）</span></label>
          <input type="text" data-f="vision_model" value="${esc(p.vision_model || "")}" placeholder="如 glm-4.5v" style="margin-top:8px">
          <label class="chk-line"><input type="checkbox" data-f="fast" ${p.fast ? "checked" : ""}> 快速模式（关闭深度思考，GLM 出结果更快）</label>
          <div class="btn-row">
            <button class="btn small ghost" data-fetchmodels="${pid}">获取模型列表</button>
            <button class="btn small ghost" data-test="${pid}">测试连接</button>
          </div>
          <div class="test-line" data-line="${pid}"></div>
        </div>`).join("")}
      <div class="btn-row">
        <button class="btn primary big" id="save-cfg">保存服务设置</button>
      </div>
    </div>
  </section>`;

  const wageHint = $("#s-wage");
  const paintWage = () => {
    const w = Bacao.hourlyWage($("#s-monthly").value, $("#s-days").value, $("#s-hours").value);
    wageHint.innerHTML = w > 0
      ? `时薪 = ¥${Bacao.fmtNum(s.monthly || 0)} ÷（${Bacao.fmtNum($("#s-days").value || 0)} 天 × ${Bacao.fmtNum($("#s-hours").value || 0)} 时）= <b class="warn">¥${Bacao.fmtNum(w)}/小时</b>。例：¥899 ≈ ${esc(Bacao.hoursText(899, w))}。`
      : "填写月薪与工作时间后自动算出时薪。";
  };
  ["#s-monthly", "#s-days", "#s-hours"].forEach((id) => $(id).addEventListener("input", paintWage));
  paintWage();

  $("#save-salary").addEventListener("click", async () => {
    try {
      await api("/api/config", { method: "POST", body: {
        salary: {
          monthly: Number($("#s-monthly").value) || 0,
          days: Number($("#s-days").value) || 21.75,
          hours_per_day: Number($("#s-hours").value) || 8,
        },
      } });
      config = null;
      toast("工资已更新，时薪 ¥" + Bacao.fmtNum(Bacao.hourlyWage($("#s-monthly").value, $("#s-days").value, $("#s-hours").value)));
    } catch (e) { toast(e.message); }
  });

  $$(".persona-card").forEach((c) => c.addEventListener("click", async () => {
    try {
      await api("/api/config", { method: "POST", body: { persona: c.dataset.p } });
      config = null;
      toast("审判人格已切换：" + Bacao.PERSONAS[c.dataset.p].label);
      renderSettings();
    } catch (e) { toast(e.message); }
  }));

  $$("[data-setdefault]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await api("/api/config", { method: "POST", body: { provider: b.dataset.setdefault } });
        config = null;
        toast("已设为默认审判服务");
        renderSettings();
      } catch (e) { toast(e.message); }
    }));

  function provField(pid, f) {
    const card = $(`.prov-card[data-pid="${pid}"]`);
    return card && $(`[data-f="${f}"]`, card);
  }

  function cachedModels(pid) {
    try { return JSON.parse(localStorage.getItem("bacao.models." + pid) || "[]"); } catch (e) { return []; }
  }
  function cacheModels(pid, ms) {
    try { localStorage.setItem("bacao.models." + pid, JSON.stringify(ms.slice(0, 80))); } catch (e) { /* 忽略 */ }
  }
  function fillModelSelect(card, models) {
    const sel = $('[data-f="model_select"]', card);
    const mi = $('[data-f="model"]', card);
    if (!sel) return;
    if (!models.length) { sel.hidden = true; sel.innerHTML = ""; return; }
    sel.innerHTML = models.map((m) =>
      `<option value="${esc(m)}" ${m === mi.value.trim() ? "selected" : ""}>${esc(m)}</option>`).join("");
    sel.hidden = false;
  }
  function wireModelSelect(card) {
    const sel = $('[data-f="model_select"]', card);
    const mi = $('[data-f="model"]', card);
    if (!sel) return;
    sel.addEventListener("change", () => { if (sel.value) mi.value = sel.value; });
    mi.addEventListener("input", () => {
      Array.from(sel.options).forEach((o) => { o.selected = o.value === mi.value.trim(); });
    });
  }
  $$(".prov-card").forEach((card) => {
    wireModelSelect(card);
    const ms = cachedModels(card.dataset.pid);
    if (ms.length) fillModelSelect(card, ms);
  });

  async function saveProviderCfg() {
    const providers = {};
    $$(".prov-card").forEach((card) => {
      const pid = card.dataset.pid;
      const get = (f) => {
        const el = $(`[data-f="${f}"]`, card);
        if (!el) return undefined;
        return el.type === "checkbox" ? el.checked : el.value.trim();
      };
      const p = { base: get("base") || "", protocol: get("protocol") || "openai",
                  model: get("model") || "", vision_model: get("vision_model") || "" };
      if (get("fast") !== undefined) p.fast = get("fast");
      const key = get("api_key");
      if (key) p.api_key = key;
      providers[pid] = p;
    });
    const body = { provider: cfg.provider, providers };
    try { await api("/api/config", { method: "POST", body }); config = null; } catch (e) { toast(e.message); throw e; }
  }

  $$("[data-fetchmodels]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pid = b.dataset.fetchmodels;
      const line = $(`[data-line="${pid}"]`);
      line.textContent = "获取中…";
      await saveProviderCfg();
      try {
        const { models } = await api("/api/models?provider=" + pid);
        const card = $(`.prov-card[data-pid="${pid}"]`);
        cacheModels(pid, models);
        fillModelSelect(card, models);
        const mi = provField(pid, "model");
        if (models.length && !mi.value.trim()) mi.value = models[0];
        line.textContent = models.length
          ? `✓ 发现 ${models.length} 个模型，已在上方下拉可选`
          : "✗ 未发现可用模型";
        line.className = "test-line ok-box";
      } catch (e) {
        line.textContent = "✗ " + e.message;
        line.className = "test-line";
      }
    }));

  $$("[data-test]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pid = b.dataset.test;
      const line = $(`[data-line="${pid}"]`);
      line.textContent = "测试中…";
      await saveProviderCfg();
      try {
        const { models } = await api("/api/models?provider=" + pid);
        line.textContent = `✓ 连接正常，可用模型 ${models.length} 个`;
        line.className = "test-line ok-box";
      } catch (e) {
        line.textContent = "✗ " + e.message;
        line.className = "test-line";
      }
    }));

  $("#save-cfg").addEventListener("click", async () => {
    const btn = $("#save-cfg");
    btn.disabled = true;
    try { await saveProviderCfg(); toast("设置已保存"); } finally { btn.disabled = false; }
  });
}

// ---------------- 启动 ----------------
// 测试钩子（自动化验证离线模式，不影响正常功能）
if (typeof window !== "undefined") {
  const hooks = window.__bacao = window.__bacao || {};
  // 注意：不能用 Object.assign——它会把 getter 求值成静态快照
  Object.defineProperties(hooks, {
    mode: { get() { return MODE; }, set(v) { MODE = v; }, configurable: true, enumerable: true },
  });
  hooks.clientApi = clientApi;
  hooks.clientVerdict = clientVerdict;
  hooks.clientVerdictStream = clientVerdictStream;
  hooks.applyVerdictRecord = applyVerdictRecord;
  hooks.recordSummary = recordSummaryClient;
}
// ---------------- 数据自刷新 ----------------
// 长时间停留的页面（如战报）在数据变化后不会自己更新：页面重新可见/窗口聚焦/点击当前页签时重取数据。
// 判定流式进行中不打断，避免重渲染冲掉流式输出。
let refreshTimer = null;
let verdictBusy = false;

function scheduleRefresh() {
  if (verdictCtl || nativeStreamCancel || verdictBusy) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => route(), 120);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleRefresh(); });
window.addEventListener("focus", scheduleRefresh);
$$(".topbar nav a").forEach((a) =>
  a.addEventListener("click", () => {
    if (location.hash === a.getAttribute("href")) scheduleRefresh(); // 同 hash 导航不触发 hashchange
  }));

detectMode().then(route);
