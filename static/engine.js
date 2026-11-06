"use strict";
/* 工资拔草机 · 前端核心引擎（原生 JS，零依赖）
 *
 * 与 engine.py 保持同构：时薪换算 / 判定 JSON 健壮解析（含流式增量解析）/
 * 台账统计聚合 / 72 小时冷静期 / 吃灰翻旧账 / 人格提示词构建。
 */
(function (global) {

const VERDICTS = ["weed", "cool", "pass"];
const VERDICT_LABELS = {
  weed: { emoji: "🚫", label: "拔草", stamp: "不予批准" },
  cool: { emoji: "😐", label: "冷静", stamp: "暂缓批准" },
  pass: { emoji: "✅", label: "放行", stamp: "准予购买" },
};
const ALLOWED_OUTCOMES = {
  weed: ["kept", "bought"],
  cool: ["cool_didnt_buy", "cool_bought"],
  pass: ["pass_bought"],
};
const OUTCOME_LABELS = {
  pending: "待定", kept: "听劝没买 ✓", bought: "还是买了（吃灰）",
  cool_pending: "冷静期中", cool_didnt_buy: "72h 后没买 ✓", cool_bought: "冷静期后还是买了",
  pass_bought: "已购入",
};
const DUST_OUTCOMES = ["bought", "cool_bought"];
const COOLING_HOURS = 72;

const PERSONAS = {
  mild: { emoji: "🧧", label: "温和记账师", desc: "温柔讲道理，账算得明明白白" },
  salty: { emoji: "😈", label: "毒舌管家", desc: "阴阳怪气但幽默，毒舌对物不对人" },
  guardian: { emoji: "🛡️", label: "工资守护神", desc: "庄严悲壮，工资是本月流血流汗的军费" },
};

const PERSONA_TONE = {
  mild: "语气规范：温柔耐心，像一位替你管账的可靠朋友。多用「咱们」「你看」，把账算清楚、道理讲透，委婉但不含糊；不阴阳怪气，不嘲讽，让用户感到被心疼而不是被说教。",
  salty: "语气规范：阴阳怪气但幽默的老管家，反讽、夸张比喻、损人利弊皆可，但毒舌只对这件东西和商家话术，绝对不允许人身羞辱——不攻击用户的外貌、收入、能力、智商；刻薄要有分寸，好笑不伤人。",
  guardian: "语气规范：庄严悲壮的守护者。工资是这个月流血流汗换来的军费，每一分都不容辜负。多用庄重的句式与悲壮的排比，例如「你又要辜负这个月的自己了吗」；凝重而非嘲讽，让用户在肃穆中冷静下来。",
};

const SYSTEM_LOGIC = `你是「工资拔草机」里的抠门管家。用户每次想买东西，都要先来你这里「过审」。你的职责：给这笔消费一个真实、有据的判定，帮用户冷静。

你会收到：想买的东西、价格、用户的时薪（月薪÷每月工作小时）、这笔钱相当于多少小时的班、以及历史吃灰记录（翻旧账上下文）。

判定档位（三选一，填进 verdict）：
- "weed"：🚫拔草（别买），给出 3~5 条具体的不买理由
- "cool"：😐冷静（再想想），给出 3~5 条「买前先回答的问题」
- "pass"：✅放行（可以买，但要聪明地买），必须给出 2~4 条更聪明的买法

判定纪律（只看逻辑，语气另说）：
- 三档都要敢于真实给出，禁止永远反对——全反对会失去可信度。
- 生活刚需、确实需要、性价比高：果断 pass。可买可不买、一时上头：cool。冲动消费、吃灰重演、纯情绪溢价：weed。
- 取材角度（按契合度选用）：时薪换算（这东西=你多少小时的班）、买回吃灰概率、家里已有类似物、商家话术拆解（限时/限量/直播氛围/凑单满减）、替代方案、花呗白条分期的利息成本、二手残值。
- 该买的刚需要放行；禁止鼓励极端抠门。
- 禁止推荐任何借贷、分期、理财产品（花呗/白条只能作为成本提示，绝不能建议使用）；不碰投资建议；不羞辱用户。

输出格式（严格遵守：只输出一个 JSON 对象，不要 markdown 围栏，不要任何解释文字）：
{"verdict":"weed","confidence":72,"reasons":[{"text":"不买的理由","sting":4}],"questions":[],"alternatives":[],"saved_amount":899}

字段要求：
- verdict：仅限 "weed" / "cool" / "pass"
- confidence：0~100 整数，「置信拔草指数」；越该拔越高，放行时应偏低（约 15~40）
- reasons：3~5 条，每条 {"text":"理由","sting":1~5 扎心指数}；要具体到这一单，禁止空话套话
- questions：cool 时必填 3~5 个问题；其他档位给空数组
- alternatives：pass 时必填 2~4 条（等大促节点/凑券/二手渠道/同价位更优解）；其他档位给空数组
- saved_amount：weed 时=这件东西的价格数字；其他档位填 0`;

// ---------------- 工具 ----------------

function pad2(n) { return (n < 10 ? "0" : "") + n; }

function fmtNow(d) {
  d = d || new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function makeId(d) {
  d = d || new Date();
  return "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) +
    "-" + String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

function fmtNum(x) {
  if (!isFinite(x)) return "0";
  const s = (Math.round(x * 10) / 10).toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

// ---------------- 时薪换算 ----------------

function hourlyWage(monthly, days, hoursPerDay) {
  monthly = Number(monthly); days = Number(days); hoursPerDay = Number(hoursPerDay);
  if (!(monthly > 0) || !(days > 0) || !(hoursPerDay > 0)) return 0;
  return Math.round(monthly / (days * hoursPerDay) * 100) / 100;
}

function hoursFor(price, hourly) {
  price = Number(price); hourly = Number(hourly);
  if (!(hourly > 0) || !(price > 0)) return 0;
  return Math.round(price / hourly * 10) / 10;
}

function hoursText(price, hourly) {
  const h = hoursFor(price, hourly);
  if (h <= 0) return "";
  if (h < 1) return "不到 1 小时的班";
  const days = Math.round(h / 8 * 10) / 10;
  const extra = days >= 1 ? "（约 " + fmtNum(days) + " 个工作日）" : "";
  return fmtNum(h) + " 小时的班" + extra;
}

// ---------------- 判定 JSON 解析 ----------------

const VERDICT_SYNONYMS = {
  weed: "weed", cool: "cool", pass: "pass",
  reject: "weed", stop: "weed", nobuy: "weed", no: "weed", "拔草": "weed",
  "别买": "weed", "不予批准": "weed",
  think: "cool", wait: "cool", "再想想": "cool", "冷静": "cool", "暂缓": "cool", "暂缓批准": "cool",
  buy: "pass", ok: "pass", yes: "pass", approve: "pass", "放行": "pass",
  "可以买": "pass", "准予购买": "pass",
};

function stripFence(text) {
  let s = String(text == null ? "" : text).trim();
  s = s.replace(/^```[A-Za-z0-9_-]*[ \t]*\r?\n?/, "");
  s = s.replace(/\r?\n?[ \t]*```\s*$/, "");
  return s.trim();
}

function extractObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return "";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return text.slice(start);
}

function repairJson(s) {
  return s
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/：/g, ":").replace(/，/g, ",")
    .replace(/,\s*([}\]])/g, "$1");
}

function normVerdict(v) {
  if (typeof v !== "string") return null;
  return VERDICT_SYNONYMS[v.trim().toLowerCase()] || null;
}

function normConfidence(v) {
  if (typeof v === "boolean") return null;
  let x;
  if (typeof v === "number") x = v;
  else if (typeof v === "string") {
    const m = v.match(/\d{1,3}/);
    if (!m) return null;
    x = parseFloat(m[0]);
  } else return null;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function normSting(v) {
  const x = Number(v);
  if (!isFinite(x)) return 3;
  return Math.max(1, Math.min(5, Math.round(x)));
}

function normStrList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (typeof x === "string" && x.trim()) return x.trim();
    if (x && typeof x === "object" && typeof x.text === "string" && x.text.trim()) return x.text.trim();
    if (typeof x === "number" && isFinite(x)) return String(x);
    return null;
  }).filter(Boolean);
}

function normReasons(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    if (typeof x === "string" && x.trim()) out.push({ text: x.trim(), sting: 3 });
    else if (x && typeof x === "object") {
      const text = x.text || x.reason || x.content || "";
      if (typeof text === "string" && text.trim()) out.push({ text: text.trim(), sting: normSting(x.sting) });
    }
  }
  return out;
}

function normAmount(v) {
  if (typeof v === "boolean") return null;
  const x = Number(v);
  if (!isFinite(x) || x < 0) return null;
  return Math.round(x * 100) / 100;
}

function normalizeVerdict(obj, requireVerdict) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const verdict = normVerdict(obj.verdict);
  if (requireVerdict !== false && !verdict) return null;
  return {
    verdict: verdict,
    confidence: normConfidence(obj.confidence),
    reasons: normReasons(obj.reasons),
    questions: normStrList(obj.questions),
    alternatives: normStrList(obj.alternatives),
    saved_amount: normAmount(obj.saved_amount),
  };
}

function parseVerdict(raw, price) {
  const s = extractObject(stripFence(raw));
  if (!s) return null;
  for (const cand of [s, repairJson(s)]) {
    let obj;
    try { obj = JSON.parse(cand); } catch (e) { continue; }
    const nv = normalizeVerdict(obj);
    if (nv) {
      if (nv.verdict === "weed" && nv.saved_amount == null && price != null) {
        nv.saved_amount = Math.round(Number(price) * 100) / 100;
      }
      return nv;
    }
  }
  return null;
}

// 流式增量解析：半截 JSON 里提取已完整/可推断的字段
function autoclose(s) {
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let cut = s;
  if (inStr) cut += '"';
  cut = cut.replace(/\s+$/, "").replace(/[,:]\s*$/, "").replace(/,\s*(?=[}\]])/g, "");
  const closer = { "{": "}", "[": "]" };
  return cut + stack.slice().reverse().map((c) => closer[c] || "").join("");
}

function parsePartial(raw) {
  const s = extractObject(stripFence(raw));
  if (!s) return null;
  for (let back = 0; back < 12; back++) {
    const end = s.length - back;
    if (end <= 1) break;
    const cand = autoclose(s.slice(0, end));
    let obj;
    try { obj = JSON.parse(cand); } catch (e) { continue; }
    const nv = normalizeVerdict(obj, false);
    if (nv == null) continue;
    if (nv.verdict || nv.reasons.length || nv.questions.length || nv.alternatives.length || nv.confidence != null) {
      return nv;
    }
    return null;
  }
  return null;
}

// ---------------- 台账统计 ----------------
// 守住金额只计：verdict==weed 且 outcome==kept（听劝没买）

function priceOf(r) {
  const p = Number(r && r.price);
  return isFinite(p) && p > 0 ? p : 0;
}

function stats(ledger, now) {
  const d = now || new Date();
  const monthKey = d.getFullYear() + "-" + pad2(d.getMonth() + 1);
  const st = {
    month: monthKey,
    month_saved: 0, month_kept_count: 0,
    total_saved: 0, total_kept_count: 0,
    weed_total: 0, weed_kept: 0, weed_bought: 0,
    cool_total: 0, cool_didnt_buy: 0, cool_bought: 0, cool_pending: 0,
    pass_total: 0, pass_bought: 0,
    dust_count: 0, dust_amount: 0,
    judged_total: 0, resolved: 0, persuaded: 0,
    success_rate: 0, dust_rate: 0,
    monthly: {},
  };
  const monthly = {};
  for (const r of ledger || []) {
    const v = r.verdict, o = r.outcome;
    const price = priceOf(r);
    const created = String(r.created || "");
    const mk = created.slice(0, 7);
    if (!monthly[mk]) monthly[mk] = {
      month: mk, judged: 0, saved: 0, kept_count: 0, resolved: 0, persuaded: 0,
      dust: 0, dust_amount: 0, max_weed: null, max_pass: null,
    };
    const m = monthly[mk];
    if (VERDICTS.indexOf(v) < 0) continue;
    st.judged_total++; m.judged++;
    if (v === "weed") {
      st.weed_total++;
      if (o === "kept") {
        st.weed_kept++;
        st.total_kept_count++;
        st.total_saved += price;
        m.kept_count++; m.saved += price;
        if (created.slice(0, 7) === monthKey) { st.month_kept_count++; st.month_saved += price; }
      } else if (o === "bought") st.weed_bought++;
    } else if (v === "cool") {
      st.cool_total++;
      if (o === "cool_didnt_buy") st.cool_didnt_buy++;
      else if (o === "cool_bought") st.cool_bought++;
      else if (o === "cool_pending") st.cool_pending++;
    } else if (v === "pass") {
      st.pass_total++;
      if (o === "pass_bought") st.pass_bought++;
    }
    if (DUST_OUTCOMES.indexOf(o) >= 0) {
      st.dust_count++; st.dust_amount += price;
      m.dust++; m.dust_amount += price;
    }
    if (v === "weed" && (!m.max_weed || price > priceOf(m.max_weed))) {
      m.max_weed = { item: r.item, price };
    }
    if (v === "pass" && (!m.max_pass || price > priceOf(m.max_pass))) {
      m.max_pass = { item: r.item, price };
    }
    const settled = (v === "weed" && (o === "kept" || o === "bought")) ||
      (v === "cool" && (o === "cool_didnt_buy" || o === "cool_bought"));
    if (settled) {
      st.resolved++; m.resolved++;
      if (o === "kept" || o === "cool_didnt_buy") { st.persuaded++; m.persuaded++; }
    }
  }
  st.total_saved = Math.round(st.total_saved * 100) / 100;
  st.month_saved = Math.round(st.month_saved * 100) / 100;
  st.dust_amount = Math.round(st.dust_amount * 100) / 100;
  st.success_rate = st.resolved ? Math.round(st.persuaded / st.resolved * 1000) / 10 : 0;
  st.dust_rate = st.resolved ? Math.round(st.dust_count / st.resolved * 1000) / 10 : 0;
  const keys = Object.keys(monthly).sort().reverse();
  st.monthly = keys.map((k) => {
    const m = monthly[k];
    m.saved = Math.round(m.saved * 100) / 100;
    m.dust_amount = Math.round(m.dust_amount * 100) / 100;
    m.weed_rate = m.resolved ? Math.round(m.persuaded / m.resolved * 1000) / 10 : 0;
    m.dust_rate = m.resolved ? Math.round(m.dust / m.resolved * 1000) / 10 : 0;
    return m;
  });
  return st;
}

function coolingDue(ledger, now) {
  const d = now || new Date();
  const nowStr = fmtNow(d);
  return (ledger || [])
    .filter((r) => r.verdict === "cool" && r.outcome === "cool_pending" &&
      r.cool_until && String(r.cool_until) <= nowStr)
    .sort((a, b) => String(a.cool_until).localeCompare(String(b.cool_until)));
}

function coolingUntil(created, now) {
  const base = created ? new Date(String(created).replace(/-/g, "/")) : (now || new Date());
  const t = isFinite(base.getTime()) ? base : (now || new Date());
  t.setHours(t.getHours() + COOLING_HOURS);
  return fmtNow(t);
}

function markOutcome(record, outcome) {
  const allowed = ALLOWED_OUTCOMES[record.verdict];
  if (!allowed || allowed.indexOf(outcome) < 0) return false;
  record.outcome = outcome;
  record.outcome_at = fmtNow();
  return true;
}

// AI 输出解析失败时的手动归档：只定档不定结果
function manualVerdict(record, verdict) {
  if (VERDICTS.indexOf(verdict) < 0) return false;
  record.verdict = verdict;
  record.parse_ok = true;
  record.manual = true;
  if (verdict === "weed") record.saved_amount = priceOf(record);
  else record.saved_amount = 0;
  if (verdict === "cool") {
    record.outcome = "cool_pending";
    record.cool_until = record.cool_until || coolingUntil(record.created);
  }
  return true;
}

// ---------------- 吃灰翻旧账 ----------------

function normName(s) {
  return String(s == null ? "" : s)
    .replace(/[\s\-—_·、，。！？!?.,()（）[\]【】]+/g, "").toLowerCase();
}

function bigrams(s) {
  const t = normName(s);
  if (t.length < 2) return t ? [t] : [];
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

function overlapCount(aList, bSet) {
  let n = 0;
  for (const g of aList) if (bSet.indexOf(g) >= 0) n++;
  return n;
}

function dustMatches(ledger, item, limit) {
  limit = limit || 3;
  const grams = bigrams(item);
  if (!grams.length) return [];
  const scored = [];
  for (const r of ledger || []) {
    if (DUST_OUTCOMES.indexOf(r.outcome) < 0) continue;
    const other = bigrams(r.item);
    const overlap = overlapCount(grams, other);
    if (overlap > 0) scored.push({ overlap, created: String(r.created || ""), r });
  }
  scored.sort((a, b) => (b.overlap - a.overlap) || a.created.localeCompare(b.created));
  return scored.slice(0, limit).map((x) => x.r);
}

function dustLines(ledger, item, limit) {
  return dustMatches(ledger, item, limit).map((r) => {
    const vl = (VERDICT_LABELS[r.verdict] || {}).label || "?";
    return "你买过「" + r.item + "」（¥" + fmtNum(priceOf(r)) + "，" +
      String(r.created || "").slice(0, 10) + " 判定为" + vl + "后还是买了），吃灰至今";
  });
}

// ---------------- 提示词构建 ----------------

const SYSTEM_SCREENSHOT = `

截图判定补充规则：
- 用户可能附上购物页/直播间/购物车/订单截图。请先从截图提取关键信息：商品名、标价与到手价、优惠方式（满减/券/限时倒计时/限量 N 件/已售 N 件/直播间氛围），再套用上面的判定逻辑。
- 把截图里的商家话术当作判定取材重点：倒计时与「仅剩 X 件」是稀缺话术，划线原价是锚定价话术，「已售 10 万+」是从众话术——逐条拆解。
- 截图与用户填写的信息冲突时（如价格不一致），以截图为准，并在理由中明确点出这个矛盾。
- 若截图模糊或关键信息（价格）不可见，在理由中如实说明「截图未见价格」，不要编造。`;

const USER_SCREENSHOT_NOTE = "【附购物截图】已随本单提交。请先读取截图里的商品名、价格与优惠话术再判定；截图与上面填写的信息冲突时以截图为准。";

function hasImage(record) {
  return !!(record && record.thumb);
}

function personaSystem(personaId, screenshot) {
  return SYSTEM_LOGIC + (screenshot ? SYSTEM_SCREENSHOT : "") + "\n\n" +
    (PERSONA_TONE[personaId] || PERSONA_TONE.salty);
}

function buildMessages(record, salary, personaId, dust) {
  const hourly = Number(salary) || 0;
  const price = priceOf(record);
  const hText = hoursText(price, hourly);
  const img = hasImage(record);
  const parts = [
    "【想买的东西】" + (record.item || ""),
    "【价格】¥" + fmtNum(price),
    "【为什么想买】" + (String(record.why || "").trim() || "（未说明）"),
    "【在哪看到的】" + (String(record.source || "").trim() || "（未说明）"),
  ];
  if (hourly > 0) {
    parts.push("【你的时薪】¥" + fmtNum(hourly) + "/小时");
    if (hText) parts.push("【这笔钱相当于】" + hText);
  }
  if (dust && dust.length) {
    parts.push("【历史吃灰提醒·翻旧账】\n" + dust.map((d) => "- " + d).join("\n"));
  }
  if (img) parts.push(USER_SCREENSHOT_NOTE);
  parts.push("请直接输出判定 JSON。");
  return { system: personaSystem(personaId, img), user: parts.join("\n") };
}

// ---------------- 导出 ----------------

const Bacao = {
  VERDICTS, VERDICT_LABELS, ALLOWED_OUTCOMES, OUTCOME_LABELS, DUST_OUTCOMES,
  COOLING_HOURS, PERSONAS,
  fmtNum, fmtNow, makeId,
  hourlyWage, hoursFor, hoursText,
  stripFence, extractObject, repairJson, normalizeVerdict, parseVerdict, parsePartial, autoclose,
  priceOf, stats, coolingDue, coolingUntil, markOutcome, manualVerdict,
  dustMatches, dustLines, personaSystem, buildMessages, hasImage,
};

global.Bacao = Bacao;
if (typeof window !== "undefined") {
  // 测试钩子（自动化验证离线模式，不影响正常功能）
  window.__bacao = { engine: Bacao };
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = Bacao;
}
})(typeof window !== "undefined" ? window : globalThis);
