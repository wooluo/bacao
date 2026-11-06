"use strict";
/* 人生虚度记录仪 · 前端（原生 JS，零依赖）
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

// 沙漏漏光（确认虚度）/ 光阴金币入账（高光时刻）
function hourglassPop() {
  const el = document.createElement("div");
  el.className = "hourglass-pop";
  el.textContent = "⏳";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 950);
}
function coinPop() {
  const el = document.createElement("div");
  el.className = "coin-pop";
  el.textContent = "🪙✨";
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
    providers: {
      glm: { label: "GLM 智谱（Coding Plan）", protocol: "openai", base: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-5.3-flash", vision_model: "glm-5.3-flash", api_key: "", fast: true }
    }
  };
}

function defaultProfile() {
  return {
    birth_date: "", expectancy: 80,
    height: 0, weight: 0,
    chronic: "", sleep_start: "", sleep_end: "", sleep_hours: 0,
    diet: "", smoke: "", drink: "", exercise: "",
    health_log: [],
  };
}

function clientRawConfig() {
  const stored = lsGet("lw.config", null);
  if (!stored) return defaultConfig();
  const base = defaultConfig();
  if (!stored.provider || !stored.providers || !stored.providers[stored.provider]) stored.provider = base.provider;
  stored.providers = stored.providers || {};
  Object.keys(base.providers).forEach((pid) => {
    if (!stored.providers[pid]) stored.providers[pid] = base.providers[pid];
  });
  if (!LifeWaster.PERSONAS[stored.persona]) stored.persona = base.persona;
  return stored;
}

function clientRawProfile() {
  const stored = lsGet("lw.profile", null);
  if (!stored) return defaultProfile();
  const base = defaultProfile();
  const out = Object.assign({}, base, stored);
  if (!LifeWaster.parseBirth(out.birth_date)) out.birth_date = "";
  out.expectancy = Number(out.expectancy) >= 40 && Number(out.expectancy) <= 120 ? Number(out.expectancy) : 80;
  if (!Array.isArray(out.health_log)) out.health_log = [];
  return out;
}

function applyConfigPatch(cfg, body) {
  if (body.provider && cfg.providers && cfg.providers[body.provider]) cfg.provider = body.provider;
  if (LifeWaster.PERSONAS[body.persona]) cfg.persona = body.persona;
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

// 与 app.py apply_profile_patch 同构
function applyProfilePatch(profile, body) {
  const num = (key, lo, hi, digits) => {
    const v = body[key];
    if (typeof v === "boolean" || v == null || v === "") return;
    const x = Number(v);
    if (isFinite(x) && x >= lo && x <= hi) profile[key] = digits ? Math.round(x * 10) / 10 : x;
  };
  const bd = String(body.birth_date || "").trim();
  if (bd === "" || LifeWaster.parseBirth(bd)) profile.birth_date = bd.slice(0, 10);
  num("expectancy", 40, 120);
  num("height", 50, 250);
  num("weight", 20, 400, 1);
  num("sleep_hours", 0, 16, 1);
  ["sleep_start", "sleep_end"].forEach((key) => {
    const val = String(body[key] || "").trim();
    const m = val.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (val === "" || m) profile[key] = m ? (m[1].length === 1 ? "0" + m[1] : m[1]) + ":" + m[2] : "";
  });
  ["chronic", "diet", "smoke", "drink", "exercise"].forEach((key) => {
    if (key in body) profile[key] = String(body[key] || "").trim().slice(0, 60);
  });
  if (Array.isArray(body.health_log)) {
    profile.health_log = body.health_log.slice(0, 60)
      .map((e) => e && typeof e === "object" ? e : null)
      .filter(Boolean);
  }
}

function profilePublicClient(profile) {
  const out = JSON.parse(JSON.stringify(profile));
  out.bmi = LifeWaster.bmi(profile.height, profile.weight);
  out.life = LifeWaster.lifeStats(profile, clientLedger());
  out.health_summary = LifeWaster.healthSummary(profile);
  return out;
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

const NON_CHAT_MODEL = /embed|rerank|whisper|speech|tts|stt|audio|clip/i;

// ---------------- 离线（client）模式 API ----------------

function clientLedger() { return lsGet("lw.ledger", []); }

function recordSummaryClient(r) {
  return {
    id: r.id, created: r.created || "",
    activity: r.activity || "", hours: r.hours || 0,
    feeling: r.feeling || "",
    verdict: r.verdict || null, confidence: r.confidence != null ? r.confidence : null,
    waste_index: r.waste_index != null ? r.waste_index : null,
    life_change: r.life_change || 0,
    outcome: r.outcome || "pending", outcome_at: r.outcome_at || "",
    cool_until: r.cool_until || "", parse_ok: !!r.parse_ok,
    save_time: r.save_time || 0,
    dust_count: (r.blacklist_used || []).length,
    has_image: !!r.thumb,
  };
}

// ---------------- 时光照片/截图 ----------------
// 前端压缩成两份：image（AI 识别用，≤1280px）与 thumb（台账展示，≤240px）
const IMG_AI_MAX_CHARS = 3500000, IMG_THUMB_MAX_CHARS = 80000;
const clientImageCache = {};  // 记录 id → AI 用大图 dataURL（内存，不落 localStorage）

function readImageAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("读取图片失败"));
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
    img.onerror = () => reject(new Error("图片解析失败（仅支持 png/jpg/webp）"));
    img.src = dataUrl;
  });
}

async function prepareScreenshot(file) {
  if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
    throw new Error("仅支持 png / jpg / webp 图片");
  }
  if (file.size > 8 * 1024 * 1024) throw new Error("图片太大（≤8MB），请截小一点");
  const raw = await readImageAsDataURL(file);
  const image = await downscale(raw, 1280, 0.8);   // AI 识别用
  const thumb = await downscale(raw, 240, 0.6);    // 台账缩略图
  if (image.length > IMG_AI_MAX_CHARS) throw new Error("图片压缩后仍过大，请换小一点的图");
  return { image, thumb };
}

async function clientApi(path, opts = {}) {
  const method = opts.method || "GET";
  const body = opts.body || {};
  if (path === "/api/config" && method === "GET") {
    const cfg = JSON.parse(JSON.stringify(clientRawConfig()));
    Object.values(cfg.providers).forEach((p) => { p.has_key = !!p.api_key; p.api_key = ""; });
    cfg.persona_info = LifeWaster.PERSONAS[cfg.persona] || LifeWaster.PERSONAS.salty;
    return cfg;
  }
  if (path === "/api/config" && method === "POST") {
    const cfg = clientRawConfig();
    applyConfigPatch(cfg, body);
    lsSet("lw.config", cfg);
    return { ok: true };
  }
  if (path === "/api/profile" && method === "GET") {
    return profilePublicClient(clientRawProfile());
  }
  if (path === "/api/profile" && method === "POST") {
    const profile = clientRawProfile();
    applyProfilePatch(profile, body);
    lsSet("lw.profile", profile);
    return { ok: true, profile: profilePublicClient(profile) };
  }
  if (path === "/api/health/import") {
    return clientHealthImport(body.image || "", body.thumb || "");
  }
  if (path === "/api/judge") {
    const activity = String(body.activity || "").trim();
    if (!activity) throw new Error("今天做了什么不能为空");
    if (activity.length > 80) throw new Error("行为描述太长了（≤80 字）");
    const hours = Math.round(Number(body.hours) * 100) / 100;
    if (!(hours > 0) || hours > 24) throw new Error("耗时应大于 0 且不超过 24 小时");
    const cfg = clientRawConfig();
    let persona = body.persona || cfg.persona || "salty";
    if (!LifeWaster.PERSONAS[persona]) persona = "salty";
    const image = body.image || "";
    const thumb = body.thumb || "";
    const imgOk = (s, max) => !s || (s.length <= max && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(s));
    if (!imgOk(image, IMG_AI_MAX_CHARS)) throw new Error("图片格式不支持或过大（仅支持 png/jpg/webp）");
    if (!imgOk(thumb, IMG_THUMB_MAX_CHARS)) throw new Error("缩略图数据异常");
    const ledger = clientLedger();
    const now = new Date();
    const record = {
      id: LifeWaster.makeId(now), created: LifeWaster.fmtNow(now),
      activity: activity.slice(0, 80), hours,
      feeling: String(body.feeling || "").trim().slice(0, 300),
      persona,
      blacklist_used: LifeWaster.blacklistMatches(ledger, activity).map((r) => r.id),
      verdict: null, confidence: null, waste_index: null,
      reasons: [], questions: [], alternatives: [],
      life_change: 0, save_time: 0,
      ai_text: "", parse_ok: false,
      outcome: "pending", outcome_at: "", cool_until: "",
      thumb, has_image: !!thumb,
    };
    if (image) clientImageCache[record.id] = image; // AI 用大图只留内存
    ledger.unshift(record);
    lsSet("lw.ledger", ledger);
    return { record };
  }
  if (path === "/api/ledger") {
    const ledger = clientLedger();
    return { records: ledger.map(recordSummaryClient), stats: LifeWaster.stats(ledger) };
  }
  const m = path.match(/^\/api\/ledger\/([\w-]+)$/);
  if (m && method === "GET") {
    const r = clientLedger().find((x) => x.id === m[1]);
    if (!r) throw new Error("记录不存在");
    return { record: r };
  }
  if (m && method === "DELETE") {
    lsSet("lw.ledger", clientLedger().filter((x) => x.id !== m[1]));
    delete clientImageCache[m[1]];
    return { ok: true };
  }
  const mo = path.match(/^\/api\/ledger\/([\w-]+)\/outcome$/);
  if (mo && method === "POST") {
    const ledger = clientLedger();
    const r = ledger.find((x) => x.id === mo[1]);
    if (!r) throw new Error("记录不存在");
    if (!LifeWaster.markOutcome(r, body.outcome)) throw new Error("该判定档位不支持这个结果：" + body.outcome);
    lsSet("lw.ledger", ledger);
    return { ok: true, record: recordSummaryClient(r) };
  }
  const mv = path.match(/^\/api\/ledger\/([\w-]+)\/verdict$/);
  if (mv && method === "POST") {
    const ledger = clientLedger();
    const r = ledger.find((x) => x.id === mv[1]);
    if (!r) throw new Error("记录不存在");
    if (!LifeWaster.manualVerdict(r, body.verdict)) throw new Error("判定档位不合法");
    lsSet("lw.ledger", ledger);
    return { ok: true, record: recordSummaryClient(r) };
  }
  if (path === "/api/stats") {
    const ledger = clientLedger();
    return {
      stats: LifeWaster.stats(ledger),
      life: LifeWaster.lifeStats(clientRawProfile(), ledger),
      cooling_due: LifeWaster.coolingDue(ledger).map(recordSummaryClient),
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

// ---------------- 健康截图导入（离线直连识图） ----------------
async function clientHealthImport(image, thumb) {
  if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > IMG_AI_MAX_CHARS) {
    throw new Error("截图格式不支持或过大（仅支持 png/jpg/webp）");
  }
  const pcfg = clientRawConfig().providers[clientRawConfig().provider];
  let model = String(pcfg.vision_model || "").trim() || String(pcfg.model || "").trim();
  if (!model) model = await resolveClientModel(pcfg);
  if (!model) throw new Error("未配置模型名，且无法从服务获取模型列表。请在设置里填写模型。");
  const req = healthRequestBody(pcfg, model, image);
  const { json } = await httpJSON("POST", req.url, req.headers, req.payload, 300000);
  let text = "";
  if (json && Array.isArray(json.choices) && json.choices[0]) {
    text = (json.choices[0].message || {}).content || "";
  } else if (json && Array.isArray(json.content)) {
    text = json.content.map((b) => (b && b.text) || "").join("");
  }
  if (!text) throw new Error("模型未返回内容：" + JSON.stringify(json).slice(0, 160));
  const health = LifeWaster.parseHealth(text);
  if (!health) throw new Error("未能从截图识别出健康数据，可换一张更清晰的截图试试");
  const profile = clientRawProfile();
  const entry = Object.assign({ date: LifeWaster.fmtNow() }, health);
  if (thumb && thumb.length <= IMG_THUMB_MAX_CHARS) entry.thumb = thumb;
  profile.health_log.unshift(entry);
  profile.health_log = profile.health_log.slice(0, 60);
  lsSet("lw.profile", profile);
  return { ok: true, health: entry, profile: profilePublicClient(profile) };
}

function healthRequestBody(pcfg, model, image) {
  const base = (pcfg.base || "").replace(/\/+$/, "");
  const url = base + "/chat/completions";
  const headers = { "Content-Type": "application/json" };
  if (pcfg.api_key) headers.Authorization = "Bearer " + pcfg.api_key;
  const payload = {
    model, temperature: 0.2, stream: false,
    messages: [
      { role: "system", content: LifeWaster.HEALTH_PROMPT },
      { role: "user", content: [{ type: "image_url", image_url: { url: image } },
                                { type: "text", text: "识别这张截图里的运动健康数据，按约定输出 JSON。" }] },
    ],
  };
  if (pcfg.fast && /bigmodel|z\.ai/i.test(pcfg.base || "")) {
    payload.thinking = { type: "disabled" };
  }
  return { url, headers, payload };
}

// ---------------- 离线直连判定 ----------------
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

function clientRequestBody(pcfg, model, record, blacklistLines, stream, images) {
  const msgs = LifeWaster.buildMessages(record, clientRawProfile(), record.persona || "salty", blacklistLines);
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
  const nv = LifeWaster.parseVerdict(rawText);
  if (!nv) { record.parse_ok = false; return false; }
  record.parse_ok = true;
  record.verdict = nv.verdict;
  record.confidence = nv.confidence;
  record.waste_index = nv.waste_index;
  record.reasons = nv.reasons;
  record.questions = nv.questions;
  record.alternatives = nv.alternatives;
  record.life_change = nv.life_change;
  record.save_time = nv.verdict === "waste" ? nv.save_time : 0;
  if (nv.verdict === "normal") {
    record.outcome = "review_pending";
    record.cool_until = LifeWaster.coolingUntil(record.created);
  } else if (nv.verdict === "valuable") {
    record.outcome = "highlight";
    record.outcome_at = LifeWaster.fmtNow();
  }
  return true;
}

function saveClientVerdict(record, raw) {
  const ledger = clientLedger();
  const target = ledger.find((x) => x.id === record.id);
  if (!target) return;
  applyVerdictRecord(target, raw);
  lsSet("lw.ledger", ledger);
}

// 非流式（浏览器离线模式）
async function clientVerdict(record, pid) {
  const pcfg = clientRawConfig().providers[pid];
  if (!pcfg) throw new Error("未知 provider：" + pid);
  const image = clientImageCache[record.id] || "";
  let model = verdictModel(pcfg, !!image);
  if (!model) model = await resolveClientModel(pcfg);
  if (!model) throw new Error("未配置模型名，且无法从服务获取模型列表。请在设置里填写模型。");
  const blacklistLines = LifeWaster.blacklistLines(clientLedger(), record.activity || "");
  const req = clientRequestBody(pcfg, model, record, blacklistLines, false, image ? [image] : null);
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
      const blacklistLines = LifeWaster.blacklistLines(clientLedger(), record.activity || "");
      const req = clientRequestBody(pcfg, model, record, blacklistLines, true, image ? [image] : null);
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

// ---------------- 配置/档案缓存 ----------------
let config = null;
let profile = null;
async function loadConfig(force) {
  if (config && !force) return config;
  try { config = await api("/api/config"); } catch (e) { config = null; }
  return config;
}
async function loadProfile(force) {
  if (profile && !force) return profile;
  try { profile = await api("/api/profile"); } catch (e) { profile = null; }
  return profile;
}

function profileReady(p) {
  return p && p.life && p.life.ready;
}

// ---------------- 语音录入（浏览器原生 Web Speech，零第三方 SDK） ----------------
let recog = null;
function toggleVoice(btn, textarea) {
  const SR = (typeof window !== "undefined") && (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) { toast("当前环境不支持语音识别，请直接打字"); return; }
  if (recog) { recog.stop(); return; }
  try {
    recog = new SR();
    recog.lang = "zh-CN";
    recog.interimResults = false;
    recog.maxResults = 1;
    recog.onstart = () => { btn.innerHTML = '<span class="rec-dot"></span> 正在听…点击结束'; };
    recog.onresult = (ev) => {
      const t = ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript || "";
      if (t) {
        textarea.value = (textarea.value ? textarea.value + " " : "") + t.trim();
        textarea.dispatchEvent(new Event("input"));
        toast("语音已转文字");
      }
    };
    recog.onerror = () => toast("语音识别失败，请直接打字");
    recog.onend = () => { recog = null; btn.textContent = "🎙️ 语音录入感受"; };
    recog.start();
  } catch (e) {
    recog = null;
    toast("语音识别启动失败，请直接打字");
  }
}

// ---------------- 路由 ----------------
let countdownTimer = null;
window.addEventListener("hashchange", route);

function route() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
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
  const p = await loadProfile(true);
  if (!profileReady(p)) return renderOnboarding();
  if (page === "judge") return renderJudge();
  if (page === "ledger") return renderLedger();
  if (page === "report") return renderReport();
  return renderHome();
}

// ---------------- 首次引导：生命档案 ----------------
let onboard = { step: 0, birth_date: "", expectancy: "80", height: "", weight: "",
                sleep_start: "23:30", sleep_end: "07:00", sleep_hours: "7.5", persona: "salty" };

function renderOnboarding() {
  const stepNames = ["① 生命起点", "② 身体与作息", "③ 审判人格"];
  const personas = Object.entries(LifeWaster.PERSONAS);
  let body = "";
  if (onboard.step === 0) {
    body = `
      <div class="onboard-step">第 1 / 3 步</div>
      <h2>你的沙漏从哪天开始漏 <span class="sub">记录仪需要知道你的生命刻度</span></h2>
      <label class="field">出生日期（只在本机保存，不上传）</label>
      <input type="date" id="ob-birth" value="${esc(onboard.birth_date)}">
      <label class="field">预期寿命（岁，仅作趣味倒计时基准）</label>
      <input type="number" id="ob-exp" min="40" max="120" step="1" value="${esc(onboard.expectancy)}">
      <div class="hint">余生倒计时是娱乐性测算，不构成任何医疗或保险结论。数据只保存在本机。</div>
      <div class="btn-row"><button class="btn primary big" id="ob-next" ${onboard.birth_date ? "" : "disabled"}>下一步 →</button></div>`;
  } else if (onboard.step === 1) {
    body = `
      <div class="onboard-step">第 2 / 3 步</div>
      <h2>身体与作息 <span class="sub">都会作为 AI 审计依据（可留空，之后在档案里补）</span></h2>
      <div class="grid2">
        <div>
          <label class="field">身高（cm）</label>
          <input type="number" id="ob-height" min="50" max="250" step="1" value="${esc(onboard.height)}">
        </div>
        <div>
          <label class="field">体重（kg）</label>
          <input type="number" id="ob-weight" min="20" max="400" step="0.1" value="${esc(onboard.weight)}">
        </div>
      </div>
      <div class="grid2">
        <div>
          <label class="field">通常入睡</label>
          <input type="time" id="ob-sleep-start" value="${esc(onboard.sleep_start)}">
        </div>
        <div>
          <label class="field">通常起床</label>
          <input type="time" id="ob-sleep-end" value="${esc(onboard.sleep_end)}">
        </div>
      </div>
      <label class="field">日均睡眠时长（小时）</label>
      <input type="number" id="ob-sleep-hours" min="0" max="16" step="0.5" value="${esc(onboard.sleep_hours)}">
      <div class="btn-row">
        <button class="btn ghost" id="ob-prev">← 上一步</button>
        <button class="btn primary big" id="ob-next">下一步 →</button>
      </div>`;
  } else {
    body = `
      <div class="onboard-step">第 3 / 3 步</div>
      <h2>选一位光阴审计官 <span class="sub">只换语气，不换判定逻辑</span></h2>
      <div class="persona-grid">${personas.map(([pid, p]) => `
        <div class="persona-card ${onboard.persona === pid ? "active" : ""}" data-p="${pid}">
          <div class="pe">${p.emoji}</div>
          <div><div class="pl">${esc(p.label)}</div><div class="pd">${esc(p.desc)}</div></div>
        </div>`).join("")}
      </div>
      <div class="btn-row">
        <button class="btn ghost" id="ob-prev">← 上一步</button>
        <button class="btn primary big" id="ob-done">⏳ 开始记录余生</button>
      </div>`;
  }

  app.innerHTML = `<section><div class="card hero">${body}
    <div class="hint" style="margin-top:16px">「人生虚度记录仪」是一个娱乐性时光复盘工具：记录每一段时光，AI 光阴审计官评估虚度程度。判定与寿命测算仅供参考，不构成医疗建议。</div>
  </div></section>`;

  const wire = (id, key) => {
    const el = $(id);
    if (el) el.addEventListener("input", () => { onboard[key] = el.value; refreshObButtons(); });
    if (el) el.addEventListener("change", () => { onboard[key] = el.value; refreshObButtons(); });
  };
  function refreshObButtons() {
    const next = $("#ob-next");
    if (next && onboard.step === 0) next.disabled = !LifeWaster.parseBirth(onboard.birth_date);
  }
  wire("#ob-birth", "birth_date"); wire("#ob-exp", "expectancy");
  wire("#ob-height", "height"); wire("#ob-weight", "weight");
  wire("#ob-sleep-start", "sleep_start"); wire("#ob-sleep-end", "sleep_end");
  wire("#ob-sleep-hours", "sleep_hours");
  $$(".persona-card").forEach((c) => c.addEventListener("click", () => {
    onboard.persona = c.dataset.p;
    $$(".persona-card").forEach((x) => x.classList.toggle("active", x.dataset.p === onboard.persona));
  }));
  const prev = $("#ob-prev");
  if (prev) prev.addEventListener("click", () => { onboard.step--; renderOnboarding(); });
  const next = $("#ob-next");
  if (next) next.addEventListener("click", () => {
    if (onboard.step === 0 && !LifeWaster.parseBirth(onboard.birth_date)) { toast("先填一个有效的出生日期"); return; }
    onboard.step++;
    renderOnboarding();
  });
  const done = $("#ob-done");
  if (done) done.addEventListener("click", async () => {
    done.disabled = true;
    try {
      await api("/api/profile", { method: "POST", body: {
        birth_date: onboard.birth_date,
        expectancy: Number(onboard.expectancy) || 80,
        height: Number(onboard.height) || 0,
        weight: Number(onboard.weight) || 0,
        sleep_start: onboard.sleep_start,
        sleep_end: onboard.sleep_end,
        sleep_hours: Number(onboard.sleep_hours) || 0,
      } });
      await api("/api/config", { method: "POST", body: { persona: onboard.persona } });
      profile = null; config = null;
      toast("沙漏已就位，开始记录！");
      location.hash = "#/home";
    } catch (e) { toast(e.message); done.disabled = false; }
  });
}

// ---------------- 首页：余生倒计时 ----------------
function startCountdown(life) {
  if (countdownTimer) clearInterval(countdownTimer);
  if (!life || !life.ready) return;
  const t0 = Date.now();
  const baseSec = life.remain_days * 86400;
  const paint = () => {
    const left = Math.max(0, Math.floor(baseSec - (Date.now() - t0) / 1000));
    const el = $("#cd-remain");
    if (!el) return;
    const days = Math.floor(left / 86400);
    const h = Math.floor((left % 86400) / 3600);
    const m = Math.floor((left % 3600) / 60);
    const s = left % 60;
    el.innerHTML = LifeWaster.fmtNum(days) + " <small>天</small> " +
      '<span class="cd-tick">' + pad2(h) + " : " + pad2(m) + " : " + pad2(s) + "</span>";
  };
  paint();
  countdownTimer = setInterval(paint, 1000);
}
function pad2(n) { return (n < 10 ? "0" : "") + n; }

async function renderHome() {
  const [p, data] = await Promise.all([loadProfile(true), api("/api/stats")]);
  if (!profileReady(p)) return renderOnboarding();
  const st = data.stats;
  const life = data.life || p.life;
  const due = data.cooling_due || [];
  const pct = Math.min(100, Math.round(st.month_waste_rate));
  const valuePct = Math.min(100, Math.round(100 - st.month_waste_rate));
  const persona = LifeWaster.PERSONAS[(await loadConfig()).persona] || LifeWaster.PERSONAS.salty;
  const lc = life.life_change_total;

  app.innerHTML = `
  <section>
    <div class="card hero countdown">
      <div class="cd-label">余生倒计时（按预期 ${LifeWaster.fmtNum(life.expectancy_years)} 岁估算）</div>
      <div class="cd-num" id="cd-remain">…</div>
      <div class="cd-sub">已度过 ${LifeWaster.fmtNum(life.age_days)} 天 · 人生已流逝 ${life.lived_pct}%${lc ? `<br>AI 趣味测算已调整 <b class="${lc >= 0 ? "ok-box" : "warn"}">${lc >= 0 ? "+" : ""}${lc} 天</b>（不构成医疗结论）` : ""}</div>
    </div>
    <div class="card">
      <h2>本月光阴审计 <span class="sub">${st.month} · ${esc(persona.emoji)} ${esc(persona.label)}在岗</span></h2>
      <div class="bignum ${st.month_wasted > 0 ? "red" : ""}"><small>虚度 </small>${LifeWaster.fmtNum(st.month_wasted)}<small> 小时</small></div>
      <div class="wall-label"><span>⏳ 虚度占比</span><span>🪙 有效 ${LifeWaster.fmtNum(st.month_value)} 小时（${valuePct}%）</span></div>
      <div class="wall"><div class="brick" style="width:${pct}%"></div></div>
      <div class="stat-grid">
        <div class="stat-cell"><div class="v red">${st.month_waste_rate}%</div><div class="k">本月虚度率</div></div>
        <div class="stat-cell"><div class="v gold">${LifeWaster.fmtNum(st.total_value)}</div><div class="k">累计有效时长</div></div>
        <div class="stat-cell"><div class="v amber">${st.blacklist_count}</div><div class="k">虚度黑名单</div></div>
      </div>
      <div class="btn-row">
        <a class="btn primary big" href="#/judge" style="text-decoration:none">⏳ 刚虚度了一段？现在记录 →</a>
      </div>
    </div>
    ${due.length ? `
    <div class="card">
      <h2>72 小时复盘回访 <span class="sub">当初这件事，事后回头看，算不算虚度？</span></h2>
      ${due.map((r) => `
        <div class="dust-card" data-id="${esc(r.id)}">
          <div class="dq">${esc(r.activity)} <span class="tag amber">${esc(LifeWaster.hoursText(r.hours))}</span></div>
          <div class="dm">${esc(r.created)} 送进复盘清单 · 复盘结束：${esc(r.cool_until)}</div>
          <div class="btn-row">
            <button class="btn danger small" data-cool="review_waste">确实虚度（计入虚度时长）</button>
            <button class="btn ghost small" data-cool="review_valuable">收获很大（修正为有效时光）</button>
          </div>
        </div>`).join("")}
    </div>` : ""}
    <div class="card">
      <h2>光阴速览</h2>
      <div class="chip-row">
        <span class="tag">累计记录 ${st.judged_total} 段</span>
        <span class="tag red">🟥 重度虚度 ${st.waste_total}</span>
        <span class="tag amber">🟨 复盘中 ${st.normal_reviewing}</span>
        <span class="tag green">🟩 高光 ${st.valuable_total}</span>
        <span class="tag meta">累计虚度 ${LifeWaster.fmtNum(st.total_wasted)} 小时</span>
      </div>
      ${(st.month_top_wastes || []).length ? `<div class="hint warn">⚠️ 本月光阴浪费 Top3：${st.month_top_wastes.map((x) => esc(x.activity || "") + "（" + LifeWaster.fmtNum(x.hours) + "h）").join("、")}</div>` : ""}
      <div class="btn-row">
        <a class="btn ghost small" href="#/ledger" style="text-decoration:none">翻时光台账 →</a>
        <a class="btn ghost small" href="#/report" style="text-decoration:none">看月度光阴战报 →</a>
      </div>
    </div>
  </section>`;

  startCountdown(life);

  $$("[data-cool]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.closest(".dust-card").dataset.id;
    const outcome = b.dataset.cool;
    try {
      await api("/api/ledger/" + id + "/outcome", { method: "POST", body: { outcome } });
      if (outcome === "review_waste") { hourglassPop(); toast("已计入虚度时长，沙漏记下了这一段"); }
      else { coinPop(); toast("已修正为有效时光，恭喜"); }
      renderHome();
    } catch (e) { toast(e.message); }
  }));
}

// ---------------- 时光录入页 ----------------
let judgeForm = { activity: "", hours: "", feeling: "", image: "", thumb: "" };

async function renderJudge() {
  const p = await loadProfile();
  if (!profileReady(p)) return renderOnboarding();
  app.innerHTML = `
  <section>
    <div class="card">
      <h2>时光录入 <span class="sub">AI 光阴审计官 · 判定仅供参考</span></h2>
      <label class="field">今天做了什么（说得越具体，判得越准）</label>
      <textarea id="j-activity" rows="2" maxlength="80" placeholder="例：连续刷了 3 小时短视频 / 陪家人散步 1 小时 / 打了两小时游戏">${esc(judgeForm.activity)}</textarea>
      <label class="field">耗时（小时）</label>
      <input type="number" id="j-hours" min="0.1" max="24" step="0.1" placeholder="例：3" value="${esc(judgeForm.hours)}">
      <div class="hint" id="j-convert">填时长即可换算成你的生命刻度。</div>
      <label class="field">内心感受（可选）</label>
      <textarea id="j-feeling" rows="2" maxlength="300" placeholder="例：停不下来，越刷越空虚 / 很放松">${esc(judgeForm.feeling)}</textarea>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn ghost small" id="j-voice">🎙️ 语音录入感受</button>
      </div>
      <label class="field">照片 / 截图（可选）<span class="warn">支持多模态识别</span></label>
      <input type="file" id="j-file" accept="image/png,image/jpeg,image/webp" style="display:none">
      <div class="img-pick" id="j-img-pick">
        <button class="btn ghost small" id="j-pick">📸 附照片/截图</button>
        <span class="hint" style="margin-top:0">现场照片、华为运动健康、屏幕使用时间、游戏战绩都行——AI 会读取画面内容</span>
      </div>
      <div class="img-preview" id="j-img-preview" hidden>
        <img id="j-thumb" alt="图片缩略图">
        <div class="ip-meta"><span id="j-img-info"></span><br><button class="btn ghost small" id="j-img-del">✕ 移除图片</button></div>
      </div>
      <div id="j-dust"></div>
      <div class="btn-row">
        <button class="btn primary big" id="j-go">📄 递交时光审计单 →</button>
      </div>
    </div>
  </section>`;

  const activityEl = $("#j-activity"), hoursEl = $("#j-hours"), feelEl = $("#j-feeling");
  const conv = $("#j-convert"), dustBox = $("#j-dust");
  const paintImg = () => {
    const box = $("#j-img-preview");
    if (judgeForm.thumb) {
      box.hidden = false;
      $("#j-img-pick").hidden = true;
      $("#j-thumb").src = judgeForm.thumb;
      $("#j-img-info").textContent = "图片已就绪（自动压缩，判定时随单发给 AI）";
    } else {
      box.hidden = true;
      $("#j-img-pick").hidden = false;
    }
  };
  $("#j-voice").addEventListener("click", () => toggleVoice($("#j-voice"), feelEl));
  $("#j-pick").addEventListener("click", () => $("#j-file").click());
  $("#j-file").addEventListener("change", async () => {
    const f = $("#j-file").files[0];
    if (!f) return;
    const btn = $("#j-pick");
    btn.disabled = true; btn.textContent = "压缩图片…";
    try {
      const r = await prepareScreenshot(f);
      judgeForm.image = r.image;
      judgeForm.thumb = r.thumb;
      paintImg();
    } catch (e) { toast(e.message); }
    finally {
      btn.disabled = false; btn.textContent = "📸 附照片/截图";
      $("#j-file").value = "";
    }
  });
  $("#j-img-del").addEventListener("click", () => {
    judgeForm.image = ""; judgeForm.thumb = "";
    paintImg();
  });
  const refresh = () => {
    const h = Number(judgeForm.hours);
    if (h > 0) {
      const shareLedger = MODE === "client" ? clientLedger() : [];
      const shareText = LifeWaster.lifeShareText(h, p || {}, shareLedger);
      conv.innerHTML = "这段 <b>" + esc(LifeWaster.hoursText(h)) + "</b>" +
        (shareText ? "： <b class=\"warn\">" + esc(shareText) + "</b>" : "。");
    } else {
      conv.innerHTML = "填时长即可换算成你的生命刻度。";
    }
    // 虚度黑名单翻旧账实时提示
    const ledger = MODE === "client" ? clientLedger() : [];
    const lines = LifeWaster.blacklistLines(ledger, judgeForm.activity || "");
    dustBox.innerHTML = lines.length
      ? `<div class="hint warn">⚠️ 翻旧账：${lines.map(esc).join("；")}</div>`
      : "";
  };
  activityEl.addEventListener("input", () => { judgeForm.activity = activityEl.value; refresh(); });
  hoursEl.addEventListener("input", () => { judgeForm.hours = hoursEl.value; refresh(); });
  feelEl.addEventListener("input", () => { judgeForm.feeling = feelEl.value; });
  refresh();
  paintImg();

  $("#j-go").addEventListener("click", async () => {
    const btn = $("#j-go");
    if (!judgeForm.activity.trim()) { toast("先写下今天做了什么"); return; }
    if (!(Number(judgeForm.hours) > 0)) { toast("耗时得是大于 0 的数字（小时）"); return; }
    btn.disabled = true; btn.textContent = "递交中…";
    try {
      const data = await api("/api/judge", {
        method: "POST",
        body: {
          activity: judgeForm.activity.trim(),
          hours: Number(judgeForm.hours),
          feeling: judgeForm.feeling.trim(),
          image: judgeForm.image || undefined,
          thumb: judgeForm.thumb || undefined,
        },
      });
      judgeForm = { activity: "", hours: "", feeling: "", image: "", thumb: "" };
      location.hash = "#/record/" + data.record.id + "/auto";
    } catch (e) {
      toast(e.message);
      btn.disabled = false; btn.textContent = "📄 递交时光审计单 →";
    }
  });
}

// ---------------- 审计单页 ----------------
let verdictCtl = null;

async function renderRecord(id, auto) {
  let record;
  try {
    record = (await api("/api/ledger/" + id)).record;
  } catch (e) {
    app.innerHTML = `<div class="card"><div class="err-box">记录不存在或已删除。<br><a href="#/ledger">← 返回台账</a></div></div>`;
    return;
  }
  const p = await loadProfile();
  const cfg = (await loadConfig()) || { providers: {}, provider: "" };
  const provChips = Object.entries(cfg.providers || {}).map(([pid, pr]) =>
    `<span class="chip ${pid === cfg.provider ? "active" : ""}" data-prov="${pid}">${esc(pr.label)}</span>`).join("");
  const dustNames = (record.blacklist_used || []).length;
  const share = LifeWaster.lifeShareText(record.hours, p || {}, MODE === "client" ? clientLedger() : []);

  app.innerHTML = `
  <section>
    <div class="paper">
      <div class="form-no">NO.${esc(record.id)} · ${esc(record.created)} · ${esc((LifeWaster.PERSONAS[record.persona] || LifeWaster.PERSONAS.salty).emoji)}${esc((LifeWaster.PERSONAS[record.persona] || LifeWaster.PERSONAS.salty).label)}在审</div>
      <h3>${esc(record.activity)}</h3>
      <div class="hours-line">
        <span class="hours-big">${esc(LifeWaster.hoursText(record.hours) || record.hours + "h")}</span>
        ${share ? `<span class="share-text">${esc(share)}</span>` : ""}
      </div>
      ${record.feeling ? `<div class="meta-row">内心感受：${esc(record.feeling)}</div>` : ""}
      ${record.thumb ? `<div class="img-attach"><img src="${esc(record.thumb)}" alt="时光图片"><span class="tag gold">📎 附图片 · AI 已识图</span></div>` : ""}
      ${dustNames ? `<div class="meta-row">📂 本次审计已翻你的旧账（${dustNames} 条黑名单记录）</div>` : ""}
      <div id="stamp-slot"></div>
    </div>
    <div class="card">
      <h2>AI 审计 <span class="sub">流式输出 · 自动入账</span></h2>
      <div class="chips" id="prov-chips">${provChips}</div>
      <div class="btn-row">
        <button class="btn primary" id="start-verdict">${record.verdict || record.ai_text ? "重新审计" : "开始审计"}</button>
        <button class="btn ghost" id="stop-verdict" style="display:none">停止</button>
        ${(record.verdict && record.parse_ok) ? '<button class="btn ghost small" id="copy-verdict">复制判定</button>' : ""}
      </div>
      ${record.parse_ok === false && record.ai_text ? '<div class="hint warn">上次 AI 输出没能解析成判定 JSON，以下为原文降级展示；可「重新审计」或在下方手动归档。</div>' : ""}
      <div class="stream ${record.ai_text ? "" : "waiting"}" id="verdict-area">${
        record.ai_text
          ? (record.parse_ok ? verdictCardHtml(record) : md(record.ai_text))
          : "点「开始审计」，光阴审计官马上到岗。"
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
        toast("默认审计服务：" + cfg.providers[pid].label);
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
  const lv = LifeWaster.VERDICT_LABELS[nv.verdict] || { emoji: "❓", label: "未知", stamp: "?" };
  const conf = nv.confidence != null ? nv.confidence : null;
  const idx = nv.waste_index != null ? nv.waste_index : null;
  let html = `
    <div class="verdict-head">
      <span class="vt ${esc(nv.verdict)}">${lv.emoji} ${esc(lv.label)}${nv.manual ? "（手动归档）" : ""}</span>
      <div class="confidence">
        <div class="cl"><span>虚度指数 / 置信</span><b>${idx != null ? idx : "?"} / ${conf != null ? conf : "?"}</b></div>
        <div class="conf-bar"><div class="conf-fill" style="width:${idx != null ? idx : (conf != null ? conf : 0)}%"></div></div>
      </div>
    </div>`;
  if (nv.reasons && nv.reasons.length) {
    html += `<div class="reason-list">${nv.reasons.map((r, i) => `
      <div class="reason-row"><span class="idx">${i + 1}</span><span>${esc(r.content || r.text)}</span>
        <span class="sting">${"⚡".repeat(r.sting_level || r.sting || 1)}${r.sting_level || r.sting || 1}</span></div>`).join("")}</div>`;
  }
  if (nv.questions && nv.questions.length) {
    html += `<div class="q-list">${nv.questions.map((q, i) => `
      <div class="q-row"><span class="qk">Q${i + 1}</span><span>${esc(q)}</span></div>`).join("")}</div>`;
  }
  if (nv.alternatives && nv.alternatives.length) {
    html += `<div class="alt-list">${nv.alternatives.map((a, i) => `
      <div class="alt-row"><span class="qk">${["💡", "📖", "🏃", "🚶"][i % 4]}</span><span>${esc(a)}</span></div>`).join("")}</div>`;
  }
  const lc = Number(nv.life_change) || 0;
  if (lc && nv.verdict) {
    html += `<div class="life-change-note ${lc > 0 ? "plus" : ""}">⏳ AI 趣味测算：本次${lc > 0 ? "延养" : "折损"}预估寿命约 <b>${Math.abs(lc)} 天</b>（${lc > 0 ? "规律的行为在给沙漏续沙" : "这段行为在给沙漏漏沙"} · 仅供娱乐，不构成医疗结论）</div>`;
  }
  if (opts && opts.partial) html += `<div style="margin-top:8px"><span class="cursor">▍</span> <span style="font-size:12px;color:var(--ink-faint)">审计官正在写审计意见…</span></div>`;
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
        <button class="btn danger small" data-manual="waste">🟥 归为重度虚度</button>
        <button class="btn amber small" data-manual="normal">🟨 归为中度浪费</button>
        <button class="btn primary small" data-manual="valuable">🟩 归为高效充实</button>
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
  const hoursLabel = LifeWaster.hoursText(record.hours) || record.hours + " 小时";
  const coolLeft = record.verdict === "normal" && o === "review_pending" && record.cool_until
    ? hoursLeft(record.cool_until) : null;
  let html = "";
  if (record.verdict === "waste") {
    if (o === "pending") {
      html = `
        <div class="btn-row">
          <button class="btn danger big" data-act="confirmed">⏳ 认了，这段确实虚度（${esc(hoursLabel)}计入虚度）</button>
          <button class="btn ghost" data-act="not_waste">🙃 不服——其实有收获（回流有效时光）</button>
        </div>`;
    } else {
      html = `<div class="interp-meta">结果：${esc(LifeWaster.OUTCOME_LABELS[o] || o)}${record.outcome_at ? " · " + esc(record.outcome_at) : ""}</div>`;
    }
  } else if (record.verdict === "normal") {
    if (o === "review_pending") {
      html = `
        <div class="interp-meta">🟨 已进入 72 小时复盘冷静期${coolLeft != null ? (coolLeft <= 0 ? " · <b class='ok-box'>冷静期已满，可以回访了</b>" : " · 还剩约 " + coolLeft + " 小时（" + esc(record.cool_until) + " 到点）") : ""}</div>
        <div class="btn-row">
          <button class="btn danger small" data-act="review_waste">确实虚度（计入虚度时长）</button>
          <button class="btn ghost small" data-act="review_valuable">事后收获很大（修正为有效时光）</button>
        </div>
        <div class="hint">72 小时后首页会出现回访提醒：当初这件事，事后回头看，算不算虚度？</div>`;
    } else {
      html = `<div class="interp-meta">结果：${esc(LifeWaster.OUTCOME_LABELS[o] || o)}${record.outcome_at ? " · " + esc(record.outcome_at) : ""}</div>`;
    }
  } else if (record.verdict === "valuable") {
    html = `<div class="interp-meta">🪙 已自动存入「高光时刻」，将在月度光阴战报里表彰。</div>`;
  }
  if (html) {
    slot.innerHTML = `<div style="border-top:1px dashed var(--line);margin-top:12px;padding-top:6px">${html}</div>`;
    $$("[data-act]", slot).forEach((b) => b.addEventListener("click", async () => {
      const act = b.dataset.act;
      try {
        await api("/api/ledger/" + record.id + "/outcome", { method: "POST", body: { outcome: act } });
        if (act === "confirmed" || act === "review_waste") { hourglassPop(); toast("已计入虚度时长，沙漏记下了这一段"); }
        else { coinPop(); toast("已回流为有效时光"); }
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
      const nv = LifeWaster.parsePartial(buf);
      if (nv && (nv.reasons.length || nv.confidence != null || nv.verdict)) {
        area.innerHTML = verdictCardHtml(nv, { partial: !final }) + (final ? "" : "");
      } else {
        const thinking = !final && !buf;
        const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
        area.innerHTML = thinking
          ? '<div class="think-status">⏳ 光阴审计官翻账本中 · ' + secs + "s"
            + (reasonBuf ? " · 已推理 " + reasonBuf.length + " 字" : "")
            + '<div class="sub2">正在核对你的生命档案、黑名单和健康数据</div></div>'
          : "<pre>" + esc(buf) + "</pre>";
      }
    };
    const tick = stream ? setInterval(() => { if (!buf) paint(false); }, 1000) : null;
    area.innerHTML = stream ? "" : '<span class="cursor">▍</span> 正在审计（直连 AI，生成完整体显示）…';
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
        area.innerHTML = '<span class="cursor">▍</span> 正在审计…';
        text = await clientVerdict(record, cfgProvider());
      }
      buf = text;
      paint(true);
      finishVerdictUI(rid, record, buf);
    } catch (e) {
      if (buf) paint(true);
      errBox.hidden = false;
      errBox.textContent = hintFor(e.message);
      if (!buf) { area.classList.add("waiting"); area.textContent = "审计未完成"; }
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
    const nv = LifeWaster.parsePartial(buf);
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
  if (r.parse_ok && LifeWaster.VERDICT_LABELS[r.verdict]) {
    area.innerHTML = verdictCardHtml(r, { partial: false });
    const slot = $("#stamp-slot");
    const lv = LifeWaster.VERDICT_LABELS[r.verdict];
    slot.innerHTML = `<div class="stamp ${esc(r.verdict)} show">${esc(lv.stamp)}<span class="vsmall">光阴审计局 · 虚度指数 ${r.waste_index != null ? r.waste_index : "?"}</span></div>`;
    toast({ waste: "🟥 虚度不予通过——审计官的刀已出鞘", normal: "🟨 待复盘，先进 72 小时冷静期", valuable: "🟩 高光时刻，金币入账" }[r.verdict] || "已入账");
    if (r.verdict === "valuable") coinPop();
  } else {
    area.innerHTML = md(buf || "") + '<div class="hint warn">（AI 输出没能解析成判定 JSON，以上为原文；可在下方手动归档）</div>';
  }
  const cv = $("#copy-verdict");
  if (cv) cv.style.display = "";
  renderActions(r);
}

function hintFor(msg) {
  let out = "审计失败：" + msg;
  if (/401|403|api.?key|unauthorized/i.test(msg)) {
    out += "\n提示：请到「档案」页检查 API Key 是否正确保存。";
  } else if (/429|1113|余额|资源包|quota|rate.?limit/i.test(msg)) {
    out += "\n提示：账户额度不足——Coding Plan 需用开通订阅的账号创建「Coding Plan 类型」密钥；个人 Key 会报余额不足。";
  } else if (/404|model/i.test(msg)) {
    out += "\n提示：请到「档案」页核对模型名称。";
  }
  return out;
}

// ---------------- 分享文本 ----------------
function shareOneText(r) {
  const lv = LifeWaster.VERDICT_LABELS[r.verdict] || { emoji: "❓", label: "?" };
  const lines = [
    "【人生虚度记录仪 · 时光审计单】",
    "这段时光：" + r.activity + "（" + (LifeWaster.hoursText(r.hours) || r.hours + " 小时") + "）",
  ];
  lines.push("判定：" + lv.emoji + " " + lv.label + "（" + lv.stamp + "）" +
    (r.waste_index != null ? " · 虚度指数 " + r.waste_index : ""));
  if (r.reasons && r.reasons.length) {
    lines.push("AI 的扎心结论：");
    r.reasons.slice(0, 3).forEach((x, i) => {
      lines.push("  " + (i + 1) + ". " + (x.content || x.text) + " " + "⚡".repeat(x.sting_level || x.sting || 1));
    });
  }
  const lc = Number(r.life_change) || 0;
  if (lc) lines.push("AI 趣味测算：本次" + (lc > 0 ? "延养" : "折损") + "预估寿命约 " + Math.abs(lc) + " 天（仅供娱乐）");
  if (r.verdict === "waste" && r.save_time > 0) lines.push("若执行替代方案，可挽回约 " + LifeWaster.fmtNum(r.save_time) + " 小时");
  lines.push("—— 记录每一日虚度，看清余生还有多少时光");
  return lines.join("\n");
}

function shareMonthText(m, all) {
  const lines = [
    "【人生虚度记录仪 · " + m.month + " 光阴战报】",
    "本月我一共虚度 " + LifeWaster.fmtNum(m.wasted) + " 小时，光阴浪费率 " + m.waste_rate + "%",
    "记录 " + m.judged + " 段时光 · 有效时光 " + LifeWaster.fmtNum(m.value) + " 小时 · 黑名单 +" + m.blacklist + " 条",
  ];
  if (m.max_waste) lines.push("最可惜的一次：" + m.max_waste.activity + "（" + LifeWaster.fmtNum(m.max_waste.hours) + " 小时）");
  if (m.max_valuable) lines.push("最充实的一次：" + m.max_valuable.activity + "（" + LifeWaster.fmtNum(m.max_valuable.hours) + " 小时）");
  if (m.save_time > 0) lines.push("若执行替代方案，本月可挽回约 " + LifeWaster.fmtNum(m.save_time) + " 小时");
  lines.push("累计虚度 " + LifeWaster.fmtNum(all.total_wasted) + " 小时 · 累计有效 " + LifeWaster.fmtNum(all.total_value) + " 小时");
  lines.push("—— 记录每一日虚度，看清余生还有多少时光 ⏳");
  return lines.join("\n");
}

// ---------------- 台账页 ----------------
let ledgerFilter = "all";

async function renderLedger() {
  await loadProfile();
  const data = await api("/api/ledger");
  const all = data.records;
  const st = data.stats;
  const nowStr = LifeWaster.fmtNow();
  const filters = [
    ["all", "全部"], ["waste", "🟥 重度"], ["normal", "🟨 中度"],
    ["valuable", "🟩 高光"], ["blacklist", "⌛ 黑名单"], ["cooling", "⏳ 复盘中"],
  ];
  const list = all.filter((r) => {
    if (ledgerFilter === "all") return true;
    if (ledgerFilter === "waste") return r.verdict === "waste";
    if (ledgerFilter === "normal") return r.verdict === "normal";
    if (ledgerFilter === "valuable") return r.verdict === "valuable";
    if (ledgerFilter === "blacklist") return LifeWaster.BLACKLIST_OUTCOMES.indexOf(r.outcome) >= 0;
    if (ledgerFilter === "cooling") return r.outcome === "review_pending";
    return true;
  });

  app.innerHTML = `
  <section>
    <div class="card">
      <h2>时光台账 <span class="sub">${st.judged_total} 段记录 · 累计虚度 ${LifeWaster.fmtNum(st.total_wasted)} 小时</span></h2>
      <div class="chips">${filters.map(([k, label]) =>
        `<span class="chip ${ledgerFilter === k ? "active" : ""}" data-f="${k}">${label}</span>`).join("")}</div>
    </div>
    ${list.length ? list.map((r) => {
      const lv = LifeWaster.VERDICT_LABELS[r.verdict];
      const outcomeTag = r.verdict
        ? `<span class="tag ${r.outcome === "confirmed" || r.outcome === "review_waste" ? "red" : r.outcome === "pending" || r.outcome === "review_pending" ? "amber" : "green"}">${esc(LifeWaster.OUTCOME_LABELS[r.outcome] || r.outcome)}</span>`
        : '<span class="tag meta">未判定</span>';
      const coolingNote = r.outcome === "review_pending" && r.cool_until
        ? `<span class="tag ${r.cool_until <= nowStr ? "red" : "meta"}">${r.cool_until <= nowStr ? "到点待回访" : "到点 " + esc(String(r.cool_until).slice(5, 16))}</span>`
        : "";
      return `
      <div class="hist-card" data-id="${esc(r.id)}">
        <div class="hist-v">${lv ? lv.emoji : "❔"}</div>
        <div class="hist-main">
          <div class="hist-q">${esc(r.activity)} · ${esc(LifeWaster.hoursText(r.hours) || r.hours + "h")}</div>
          <div class="hist-meta">
            <span>${esc(r.created.slice(0, 16))}</span>
            ${r.waste_index != null ? `<span>虚度 ${r.waste_index}</span>` : ""}
            ${outcomeTag}${coolingNote}
          </div>
        </div>
        <button class="hist-del" data-del="${esc(r.id)}" title="删除">✕</button>
      </div>`;
    }).join("") : '<div class="card empty"><div class="big">⏳</div>还没有时光记录<br><br><a class="btn primary" href="#/judge" style="text-decoration:none">去记录第一段时光</a></div>'}
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

// ---------------- 月度光阴战报页 ----------------
let reportMonth = "";

async function renderReport() {
  const [p, data] = await Promise.all([loadProfile(), api("/api/ledger")]);
  const st = data.stats;
  const months = st.monthly;
  if (!reportMonth && months.length) reportMonth = months[0].month;
  let m = months.find((x) => x.month === reportMonth);
  if (!m && months.length) { reportMonth = months[0].month; m = months[0]; }
  const mi = months.indexOf(m);
  const prev = mi >= 0 && mi + 1 < months.length ? months[mi + 1] : null;
  const delta = (prev && m) ? Math.round((m.waste_rate - prev.waste_rate) * 10) / 10 : null;
  const health = (p && p.health_log || []).slice(0, 3);

  app.innerHTML = `
  <section>
    <div class="card">
      <h2>月度光阴战报 <span class="sub">按月汇总 · 数据都在本机</span></h2>
      ${months.length ? `<div class="chips">${months.map((x) =>
        `<span class="chip ${reportMonth === x.month ? "active" : ""}" data-m="${esc(x.month)}">${esc(x.month)}</span>`).join("")}</div>`
        : '<div class="empty"><div class="big">📋</div>还没有战报，先去记录几段时光</div>'}
      ${m ? `
      <div class="stat-grid" style="margin-top:14px">
        <div class="stat-cell"><div class="v red">${LifeWaster.fmtNum(m.wasted)}<small style="font-size:12px">h</small></div><div class="k">虚度总时长</div></div>
        <div class="stat-cell"><div class="v ${m.waste_rate >= 50 ? "red" : "gold"}">${m.waste_rate}%</div><div class="k">光阴浪费率</div></div>
        <div class="stat-cell"><div class="v green">${LifeWaster.fmtNum(m.value)}<small style="font-size:12px">h</small></div><div class="k">有效时长</div></div>
      </div>
      ${delta != null ? `<div class="hint">历史同比：较 ${esc(prev.month)} 虚度率${delta >= 0 ? "<b class='warn'>上升 " + delta : "<b class='ok-box'>下降 " + (-delta)}%</b>${prev ? "（" + esc(prev.month) + " 为 " + prev.waste_rate + "%）" : ""}</div>` : ""}
      <div class="chip-row" style="margin-top:12px">
        <span class="tag">记录 ${m.judged} 段</span>
        <span class="tag red">黑名单 +${m.blacklist}</span>
        ${m.save_time > 0 ? `<span class="tag gold">替代方案可挽回 ${LifeWaster.fmtNum(m.save_time)} 小时</span>` : ""}
        ${m.max_waste ? `<span class="tag red">最虚度：${esc(m.max_waste.activity)} ${LifeWaster.fmtNum(m.max_waste.hours)}h</span>` : ""}
        ${m.max_valuable ? `<span class="tag green">最充实：${esc(m.max_valuable.activity)} ${LifeWaster.fmtNum(m.max_valuable.hours)}h</span>` : ""}
      </div>
      ${(m.top_wastes || []).length ? `<div class="hint warn" style="margin-top:10px">⏳ 虚度 TOP3：${m.top_wastes.map((x, i) => (i + 1) + ". " + esc(x.activity || "") + "（" + LifeWaster.fmtNum(x.hours) + "h）").join("  ")}</div>` : ""}
      ${(m.top_highlights || []).length ? `<div class="hint" style="margin-top:6px">🪙 高光充实 TOP3：${m.top_highlights.map((x, i) => (i + 1) + ". " + esc(x.activity || "") + "（" + LifeWaster.fmtNum(x.hours) + "h）").join("  ")}</div>` : ""}
      <div class="btn-row">
        <button class="btn primary big" id="share-month">📣 生成战报，复制分享</button>
      </div>
      <div class="share-box" id="share-preview" hidden></div>` : ""}
      ${health.length ? `<div class="hint" style="margin-top:14px">❤️ 健康联动（华为运动健康导入）：${health.map((h) => esc(LifeWaster.healthSummary({ health_log: [h] }))).join("<br>")}</div>` : ""}
      <div class="hint" style="margin-top:10px">累计虚度 <b>${LifeWaster.fmtNum(st.total_wasted)}</b> 小时（只计「确认虚度/复盘确实虚度」）；寿命增减为 AI 趣味测算累计 <b>${st.life_change_total >= 0 ? "+" : ""}${st.life_change_total}</b> 天，不构成医疗结论。</div>
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

// ---------------- 档案/设置页 ----------------
async function renderSettings() {
  const p = await loadProfile(true);
  const cfg = await loadConfig(true);
  if (!p || !cfg) { app.innerHTML = '<div class="card"><div class="err-box">无法读取配置</div></div>'; return; }
  const personas = Object.entries(LifeWaster.PERSONAS);
  const latest = (p.health_log || [])[0] || null;

  app.innerHTML = `
  <section>
    <div class="card hero">
      <h2>生命档案 <span class="sub">${p.life && p.life.ready ? "已度过 " + LifeWaster.fmtNum(p.life.age_days) + " 天 · 剩余约 " + esc(p.life.remain_text) : "先填写出生日期"}</span></h2>
      <label class="field">出生日期</label>
      <input type="date" id="s-birth" value="${esc(p.birth_date || "")}">
      <div class="grid2">
        <div>
          <label class="field">预期寿命（岁）</label>
          <input type="number" id="s-exp" min="40" max="120" step="1" value="${esc(p.expectancy || 80)}">
        </div>
        <div>
          <label class="field">BMI（自动算）</label>
          <input type="text" id="s-bmi" value="${p.bmi != null ? p.bmi : "—"}" readonly>
        </div>
      </div>
      <div class="grid2">
        <div>
          <label class="field">身高（cm）</label>
          <input type="number" id="s-height" min="50" max="250" step="1" value="${esc(p.height || "")}">
        </div>
        <div>
          <label class="field">体重（kg）</label>
          <input type="number" id="s-weight" min="20" max="400" step="0.1" value="${esc(p.weight || "")}">
        </div>
      </div>
      <label class="field">慢性疾病 / 既往病史（可选）</label>
      <input type="text" id="s-chronic" maxlength="60" placeholder="例：无 / 轻度脂肪肝" value="${esc(p.chronic || "")}">
      <div class="grid2">
        <div>
          <label class="field">通常入睡</label>
          <input type="time" id="s-sleep-start" value="${esc(p.sleep_start || "")}">
        </div>
        <div>
          <label class="field">通常起床</label>
          <input type="time" id="s-sleep-end" value="${esc(p.sleep_end || "")}">
        </div>
      </div>
      <label class="field">日均睡眠时长（小时）</label>
      <input type="number" id="s-sleep-hours" min="0" max="16" step="0.5" value="${esc(p.sleep_hours || "")}">
      <div class="grid2">
        <div>
          <label class="field">三餐 / 饮食习惯</label>
          <input type="text" id="s-diet" maxlength="60" placeholder="例：三餐规律/重油外卖" value="${esc(p.diet || "")}">
        </div>
        <div>
          <label class="field">运动频率</label>
          <input type="text" id="s-exercise" maxlength="60" placeholder="例：每周跑步 2 次" value="${esc(p.exercise || "")}">
        </div>
      </div>
      <div class="grid2">
        <div>
          <label class="field">烟</label>
          <input type="text" id="s-smoke" maxlength="60" placeholder="例：不抽 / 每天 3 根" value="${esc(p.smoke || "")}">
        </div>
        <div>
          <label class="field">酒</label>
          <input type="text" id="s-drink" maxlength="60" placeholder="例：不喝 / 周末小酌" value="${esc(p.drink || "")}">
        </div>
      </div>
      <div class="btn-row"><button class="btn primary" id="save-profile">保存档案</button></div>
      <div class="hint">余生倒计时由出生日期与预期寿命推算，AI 判定的寿命增减（趣味测算）会动态调整；不构成医疗结论。</div>
    </div>

    <div class="card">
      <h2>健康数据导入 <span class="sub">华为运动健康截图 · AI 自动识别回填</span></h2>
      <input type="file" id="h-file" accept="image/png,image/jpeg,image/webp" style="display:none">
      <div class="btn-row" style="margin-top:4px">
        <button class="btn primary" id="h-import">📸 上传运动健康截图</button>
      </div>
      <div class="hint">截图只保存在本机（缩略图），识别字段：睡眠时长 / 入睡起床 / 步数 / 运动时长 / 体重 / 心率。导入后自动刷新健康画像，AI 判定时作为依据。</div>
      ${latest ? `<div class="health-log-item">
        ${latest.thumb ? `<img src="${esc(latest.thumb)}" alt="健康截图">` : ""}
        <div class="hl-main">${esc(p.health_summary || "")}</div>
      </div>` : ""}
      <div id="h-log">${(p.health_log || []).slice(1, 4).map((h) => `
        <div class="health-log-item">
          ${h.thumb ? `<img src="${esc(h.thumb)}" alt="">` : ""}
          <div class="hl-main">${esc(healthEntryText(h))}</div>
        </div>`).join("")}</div>
    </div>

    <div class="card">
      <h2>三档人格 <span class="sub">只换语气，不换判定逻辑</span></h2>
      <div class="persona-grid">${personas.map(([pid, pr]) => `
        <div class="persona-card ${cfg.persona === pid ? "active" : ""}" data-p="${pid}">
          <div class="pe">${pr.emoji}</div>
          <div><div class="pl">${esc(pr.label)}</div><div class="pd">${esc(pr.desc)}</div></div>
        </div>`).join("")}
      </div>
    </div>
    <div class="card">
      <h2>审计服务 <span class="sub">点标签可切换默认</span></h2>
      ${Object.entries(cfg.providers).map(([pid, pr]) => `
        <div class="prov-card ${pid === cfg.provider ? "default" : ""}" data-pid="${pid}">
          <div class="prov-head">
            <span class="name">${esc(pr.label)} ${pid === cfg.provider ? '<span class="tag">默认</span>' : ""}</span>
            <button class="btn small ghost" data-setdefault="${pid}">设为默认</button>
          </div>
          <label class="field">接口地址（Base URL）</label>
          <input type="url" data-f="base" value="${esc(pr.base)}" placeholder="https://open.bigmodel.cn/api/coding/paas/v4">
          <div class="grid2">
            <div>
              <label class="field">协议</label>
              <select data-f="protocol">
                <option value="openai" ${pr.protocol !== "anthropic" ? "selected" : ""}>OpenAI 兼容（/chat/completions）</option>
                <option value="anthropic" ${pr.protocol === "anthropic" ? "selected" : ""}>Anthropic 兼容（/v1/messages）</option>
              </select>
            </div>
            <div>
              <label class="field">API Key</label>
              <input type="password" data-f="api_key" placeholder="${pr.has_key ? "已保存（留空则不修改）" : "未设置"}" autocomplete="new-password">
            </div>
          </div>
          <label class="field">模型名 <span style="font-weight:400">（可下拉选择或手动输入）</span></label>
          <select data-f="model_select" hidden></select>
          <input type="text" data-f="model" value="${esc(pr.model)}" placeholder="如 glm-5.3-flash" style="margin-top:8px">
          <label class="field">识图模型 <span style="font-weight:400">（截图/照片识别用，如 glm-5.3-flash 原生多模态）</span></label>
          <input type="text" data-f="vision_model" value="${esc(pr.vision_model || "")}" placeholder="如 glm-5.3-flash" style="margin-top:8px">
          <label class="chk-line"><input type="checkbox" data-f="fast" ${pr.fast ? "checked" : ""}> 快速模式（关闭深度思考，GLM 出结果更快）</label>
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

  const bmiEl = $("#s-bmi");
  const paintBmi = () => {
    const b = LifeWaster.bmi($("#s-height").value, $("#s-weight").value);
    bmiEl.value = b != null ? b : "—";
  };
  ["#s-height", "#s-weight"].forEach((id) => $(id).addEventListener("input", paintBmi));

  $("#save-profile").addEventListener("click", async () => {
    try {
      await api("/api/profile", { method: "POST", body: {
        birth_date: $("#s-birth").value,
        expectancy: Number($("#s-exp").value) || 80,
        height: Number($("#s-height").value) || 0,
        weight: Number($("#s-weight").value) || 0,
        chronic: $("#s-chronic").value,
        sleep_start: $("#s-sleep-start").value,
        sleep_end: $("#s-sleep-end").value,
        sleep_hours: Number($("#s-sleep-hours").value) || 0,
        diet: $("#s-diet").value,
        exercise: $("#s-exercise").value,
        smoke: $("#s-smoke").value,
        drink: $("#s-drink").value,
      } });
      profile = null;
      const fresh = await loadProfile(true);
      toast(fresh && fresh.life && fresh.life.ready
        ? "档案已更新 · 余生约 " + fresh.life.remain_text
        : "档案已更新");
    } catch (e) { toast(e.message); }
  });

  // 健康截图导入
  $("#h-import").addEventListener("click", () => $("#h-file").click());
  $("#h-file").addEventListener("change", async () => {
    const f = $("#h-file").files[0];
    if (!f) return;
    const btn = $("#h-import");
    btn.disabled = true; btn.textContent = "识别中…";
    try {
      const r = await prepareScreenshot(f);
      const out = await api("/api/health/import", { method: "POST", body: { image: r.image, thumb: r.thumb } });
      profile = null;
      toast("健康数据已导入：" + healthEntryText(out.health));
      renderSettings();
    } catch (e) { toast(e.message); }
    finally {
      btn.disabled = false; btn.textContent = "📸 上传运动健康截图";
      $("#h-file").value = "";
    }
  });

  $$(".persona-card").forEach((c) => c.addEventListener("click", async () => {
    try {
      await api("/api/config", { method: "POST", body: { persona: c.dataset.p } });
      config = null;
      toast("审计人格已切换：" + LifeWaster.PERSONAS[c.dataset.p].label);
      renderSettings();
    } catch (e) { toast(e.message); }
  }));

  $$("[data-setdefault]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await api("/api/config", { method: "POST", body: { provider: b.dataset.setdefault } });
        config = null;
        toast("已设为默认审计服务");
        renderSettings();
      } catch (e) { toast(e.message); }
    }));

  function provField(pid, f) {
    const card = $(`.prov-card[data-pid="${pid}"]`);
    return card && $(`[data-f="${f}"]`, card);
  }

  function cachedModels(pid) {
    try { return JSON.parse(localStorage.getItem("lw.models." + pid) || "[]"); } catch (e) { return []; }
  }
  function cacheModels(pid, ms) {
    try { localStorage.setItem("lw.models." + pid, JSON.stringify(ms.slice(0, 80))); } catch (e) { /* 忽略 */ }
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
      const pr = { base: get("base") || "", protocol: get("protocol") || "openai",
                   model: get("model") || "", vision_model: get("vision_model") || "" };
      if (get("fast") !== undefined) pr.fast = get("fast");
      const key = get("api_key");
      if (key) pr.api_key = key;
      providers[pid] = pr;
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

function healthEntryText(h) {
  const parts = [];
  if (h.sleep_hours != null) {
    let seg = "睡眠 " + LifeWaster.fmtNum(h.sleep_hours) + " 小时";
    if (h.sleep_start && h.sleep_end) seg += "（" + h.sleep_start + "~" + h.sleep_end + "）";
    parts.push(seg);
  }
  if (h.steps != null) parts.push("步数 " + h.steps);
  if (h.exercise_minutes != null) parts.push("运动 " + h.exercise_minutes + " 分钟");
  if (h.weight != null) parts.push("体重 " + LifeWaster.fmtNum(h.weight) + "kg");
  if (h.heart_rate != null) parts.push("心率 " + h.heart_rate);
  return (String(h.date || "").slice(0, 10) + " ") + (parts.join(" · ") || "（未识别到数据）");
}

// ---------------- 启动 ----------------
// 测试钩子（自动化验证离线模式，不影响正常功能）
if (typeof window !== "undefined") {
  const hooks = window.__lifewaster = window.__lifewaster || {};
  // 注意：不能用 Object.assign——它会把 getter 求值成静态快照
  Object.defineProperties(hooks, {
    mode: { get() { return MODE; }, set(v) { MODE = v; }, configurable: true, enumerable: true },
  });
  hooks.clientApi = clientApi;
  hooks.clientVerdict = clientVerdict;
  hooks.clientVerdictStream = clientVerdictStream;
  hooks.applyVerdictRecord = applyVerdictRecord;
  hooks.recordSummary = recordSummaryClient;
  hooks.clientHealthImport = clientHealthImport;
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
