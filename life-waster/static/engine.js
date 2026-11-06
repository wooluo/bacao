"use strict";
/* 人生虚度记录仪 · 前端核心引擎（原生 JS，零依赖）
 *
 * 与 engine.py 保持同构：生命换算（出生日期→已活/剩余/BMI）/ 虚度判定 JSON 健壮解析
 * （含流式增量解析）/ 台账统计聚合 / 72 小时复盘冷静期 / 虚度黑名单翻旧账 /
 * 健康截图 JSON 解析 / 三档人格提示词构建。
 */
(function (global) {

const VERDICTS = ["waste", "normal", "valuable"];
const VERDICT_LABELS = {
  waste: { emoji: "🟥", label: "重度虚度", stamp: "虚度不予通过" },
  normal: { emoji: "🟨", label: "中度浪费", stamp: "待复盘" },
  valuable: { emoji: "🟩", label: "高效充实", stamp: "高光时刻" },
};
const ALLOWED_OUTCOMES = {
  waste: ["confirmed", "not_waste"],
  normal: ["review_waste", "review_valuable"],
  valuable: ["highlight"],
};
const OUTCOME_LABELS = {
  pending: "待确认",
  confirmed: "确认虚度",
  not_waste: "有收获（回流有效时光）",
  review_pending: "72h 复盘中",
  review_waste: "复盘：确实虚度",
  review_valuable: "复盘：收获很大",
  highlight: "已入高光时刻",
};
const BLACKLIST_OUTCOMES = ["confirmed", "review_waste"];  // 记入虚度黑名单（翻旧账）
const WASTED_OUTCOMES = ["confirmed", "review_waste"];     // 计入虚度时长
const VALUE_OUTCOMES = ["highlight", "review_valuable", "not_waste"];  // 计入有效时光
const COOLING_HOURS = 72;
const WASTE_INDEX_HEAVY = 70;
const WASTE_INDEX_MILD = 35;

const PERSONAS = {
  mild: { emoji: "📜", label: "温和史官", desc: "平静理性复盘，娓娓道来，适合自我反思" },
  salty: { emoji: "👿", label: "毒舌光阴质检员", desc: "阴阳幽默，只吐槽行为，绝不攻击人格" },
  guardian: { emoji: "🕯️", label: "余生守望者", desc: "悲壮严肃，「你又在消耗本就不多的余生」" },
};

const PERSONA_TONE = {
  mild: "语气规范：平静理性的史官，像一位陪你翻旧账册的老友。娓娓道来、就事论事，把这段时光的来龙去脉复盘清楚；不嘲讽、不刺激，让用户在平静中自己看清问题。",
  salty: "语气规范：阴阳怪气但幽默的光阴质检员，反讽、夸张比喻皆可，但毒舌只对这段行为和「时间刺客」话术，绝对不允许人身羞辱——不攻击用户的外貌、收入、能力、智商；刻薄要有分寸，好笑不伤人。",
  guardian: "语气规范：悲壮肃穆的余生守望者。余生是倒计时的沙漏，每小时都在漏。多用庄重悲壮的句式与排比，例如「你又在消耗本就不多的余生」「沙漏不为人倒转」；凝重而非嘲讽，让用户在肃穆中冷静下来。",
};

const SYSTEM_LOGIC = `你是「人生虚度记录仪」里的光阴审计官。用户每记录一段度过的时间，都要来你这里「过审」。你的职责：给这段时光一个真实、有据的虚度评级，帮用户看清时间去向。

你会收到：当天行为、耗时（小时）、内心感受、生命档案（年龄/预期寿命/BMI/作息）、健康摘要、历史虚度黑名单（翻旧账上下文）。

判定档位（三选一，填进 verdict，必须与 waste_index 区间一致）：
- "waste"：🟥重度虚度（虚度指数≥70），给出 3~5 条扎心结论，并给出替代方案（这段时间可以换成什么事）
- "normal"：🟨中度浪费（虚度指数 35~69），给出 3~5 条「自我拷问」问题，进入 72 小时冷静复盘
- "valuable"：🟩高效充实（虚度指数<35），判定为有效光阴，给 1~3 条闪光点

判定纪律（只看逻辑，语气另说）：
- 三档都要敢于真实给出，禁止永远差评——全判虚度会失去可信度。
- 偶尔放松≠虚度：有节制的娱乐、社交、发呆充电都不算；无节制重复性刷手机、无效刷信息流、明知无意义却停不下来=重度虚度。
- 取材角度（按契合度选用）：时间投入产出比（这段时长换来了什么）、长期成长价值、是否重复历史虚度行为（翻旧账拉高评分）、健康联动（熬夜+久坐刷手机直接拉高档位）、机会成本（同时段可以做什么）、成瘾特征（停不下来/报复性熬夜）。
- 判定依据里明确引用翻旧账与健康数据（若有）。
- 禁止鼓励极端自律或效率焦虑；休息与快乐本身有价值。

输出格式（严格遵守：只输出一个 JSON 对象，不要 markdown 围栏，不要任何解释文字）：
{"verdict":"waste","confidence":78,"waste_index":78,"reasons":[{"content":"无意义刷短视频，没有成长收益","sting_level":4}],"questions":[],"alternatives":["用这段时间看书/运动"],"life_change":-2,"save_time":3}

字段要求：
- verdict：仅限 "waste" / "normal" / "valuable"
- confidence：0~100 整数，「虚度置信指数」；越该判虚度越高，高效充实时应偏低（约 15~40）
- waste_index：0~100 整数，「虚度指数」；≥70 必须判 waste，35~69 判 normal，<35 判 valuable
- reasons：3~5 条，每条 {"content":"结论","sting_level":1~5 扎心指数}；要具体到这一段时光，禁止空话套话
- questions：normal 时必填 3~5 个自我拷问（如「这件事长期能带来成长吗？」「只是单纯消磨时间吗？」）；其他档位给空数组
- alternatives：waste 时必填 2~4 条替代方案（具体可执行）；其他档位给空数组
- life_change：本次行为对预估寿命的影响天数，整数；正=延长（如规律运动+1），负=折损（如熬夜+久坐刷手机 -1~-3），普通行为 0；仅为趣味测算，取值务必保守
- save_time：采纳替代方案预计可挽回的有效时长（小时，0~24，可有小数），waste 时给出；其他档位填 0

合规红线（必须遵守）：
- 只做娱乐性时光评估，不做任何医疗诊断或健康建议；
- life_change 寿命影响仅为趣味测算，不是医学结论；
- 不推荐任何保健品、药品、医疗方案；
- 只吐槽行为，绝不羞辱人格。`;

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

// ---------------- 生命换算 ----------------

function parseBirth(birth) {
  const m = String(birth == null ? "" : birth).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])
    ? null : d;
}

function bmi(heightCm, weightKg) {
  const h = Number(heightCm), w = Number(weightKg);
  if (!isFinite(h) || !isFinite(w) || h < 50 || h > 250 || w <= 0 || w > 400) return null;
  return Math.round(w / Math.pow(h / 100, 2) * 10) / 10;
}

function lifeChangeTotal(ledger) {
  let total = 0;
  for (const r of ledger || []) {
    if (VERDICTS.indexOf(r.verdict) < 0) continue;
    const x = Number(r.life_change);
    if (isFinite(x)) total += Math.round(x);
  }
  return total;
}

function remainText(days) {
  if (days == null) return "";
  const years = Math.floor(days / 365.25);
  const months = Math.floor((days - years * 365.25) / 30);
  if (years >= 1) return "约 " + years + " 年 " + months + " 个月";
  return "约 " + Math.max(1, months) + " 个月";
}

function lifeStats(profile, ledger, now) {
  const d = now || new Date();
  const birth = parseBirth((profile || {}).birth_date);
  const expectancy = Number((profile || {}).expectancy);
  if (!birth || !(expectancy > 0)) {
    return { age_days: null, age_hours: null, age_text: "", expectancy_years: null,
      remain_days: null, remain_hours: null, remain_text: "", lived_pct: null,
      life_change_total: 0, ready: false };
  }
  const ageMs = d.getTime() - birth.getTime();
  const ageDays = Math.max(0, Math.floor(ageMs / 86400000));
  const ageHours = ageDays * 24 + Math.floor((ageMs % 86400000) / 3600000);
  const totalDays = expectancy * 365.25;
  const remainDays = Math.max(0, Math.round((totalDays - ageDays + lifeChangeTotal(ledger)) * 10) / 10);
  return {
    age_days: ageDays,
    age_hours: ageHours,
    age_text: fmtNum(ageDays) + " 天",
    expectancy_years: expectancy,
    remain_days: remainDays,
    remain_hours: Math.round(remainDays * 24 * 10) / 10,
    remain_text: remainText(remainDays),
    lived_pct: Math.round(ageDays / totalDays * 10000) / 100,
    life_change_total: lifeChangeTotal(ledger),
    ready: true,
  };
}

function hoursText(hours) {
  const h = Number(hours);
  if (!isFinite(h) || h <= 0) return "";
  if (h < 1) return Math.round(h * 60) + " 分钟";
  return fmtNum(h) + " 小时";
}

function lifeShareText(hours, profile, ledger) {
  const h = Number(hours);
  if (!isFinite(h) || h <= 0) return "";
  const st = lifeStats(profile, ledger);
  const parts = [];
  if (st.ready && st.remain_days > 0) {
    const pct = h / (st.remain_days * 24) * 100;
    if (pct >= 0.01) {
      parts.push("这段时光≈你剩余生命的 " + (pct < 1 ? (Math.round(pct * 100) / 100).toFixed(2) : fmtNum(Math.round(pct * 10) / 10)) + "%");
    } else {
      parts.push("这段时光≈你剩余生命的 " + pct.toFixed(4) + "%");
    }
  }
  const yearDays = h * 3 * 52 / 24;  // 每周重复 3 次
  if (yearDays >= 1) parts.push("若每周重复 3 次，一年就是 " + fmtNum(Math.round(yearDays * 10) / 10) + " 天");
  return parts.join(" · ");
}

// ---------------- 判定 JSON 解析 ----------------

const VERDICT_SYNONYMS = {
  waste: "waste", normal: "normal", valuable: "valuable",
  heavy: "waste", severe: "waste", "重度": "waste", "重度虚度": "waste",
  "虚度": "waste", "虚度不予通过": "waste",
  mid: "normal", middle: "normal", cool: "normal", "中度": "normal",
  "中度浪费": "normal", "待复盘": "normal", "冷静": "normal", "复盘": "normal",
  good: "valuable", pass: "valuable", valued: "valuable",
  "高效": "valuable", "高效充实": "valuable", "高光": "valuable",
  "高光时刻": "valuable", "充实": "valuable",
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

function verdictFromIndex(idx) {
  if (idx == null) return null;
  return idx >= WASTE_INDEX_HEAVY ? "waste" : (idx >= WASTE_INDEX_MILD ? "normal" : "valuable");
}

function normIndex(v) {
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
    if (typeof x === "string" && x.trim()) out.push({ content: x.trim(), sting_level: 3 });
    else if (x && typeof x === "object") {
      const text = x.content || x.text || x.reason || "";
      if (typeof text === "string" && text.trim()) {
        out.push({ content: text.trim(), sting_level: normSting(x.sting_level != null ? x.sting_level : x.sting) });
      }
    }
  }
  return out;
}

function normLifeChange(v) {
  if (typeof v === "boolean") return 0;
  const x = Number(v);
  if (!isFinite(x)) return 0;
  return Math.max(-365, Math.min(365, Math.round(x)));
}

function normSaveTime(v) {
  if (typeof v === "boolean") return 0;
  const x = Number(v);
  if (!isFinite(x) || x < 0) return 0;
  return Math.round(Math.min(24, x) * 10) / 10;
}

function normalizeVerdict(obj, requireVerdict) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const index = normIndex(obj.waste_index);
  const verdict = verdictFromIndex(index) || normVerdict(obj.verdict);
  if (requireVerdict !== false && !verdict) return null;
  return {
    verdict: verdict,
    confidence: normIndex(obj.confidence),
    waste_index: index,
    reasons: normReasons(obj.reasons),
    questions: normStrList(obj.questions),
    alternatives: normStrList(obj.alternatives),
    life_change: normLifeChange(obj.life_change),
    save_time: normSaveTime(obj.save_time),
  };
}

function parseVerdict(raw) {
  const s = extractObject(stripFence(raw));
  if (!s) return null;
  for (const cand of [s, repairJson(s)]) {
    let obj;
    try { obj = JSON.parse(cand); } catch (e) { continue; }
    const nv = normalizeVerdict(obj);
    if (nv) return nv;
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
    if (nv.verdict || nv.reasons.length || nv.questions.length || nv.alternatives.length ||
        nv.confidence != null || nv.waste_index != null) {
      return nv;
    }
    return null;
  }
  return null;
}

// ---------------- 健康截图 JSON 解析 ----------------

function normHHMM(v) {
  if (typeof v === "number" || v == null) return null;
  const m = String(v).match(/(\d{1,2})\s*[:：点时]\s*(\d{1,2})?/);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2] || 0);
  if (hh === 24 && mm === 0) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return pad2(hh) + ":" + pad2(mm);
}

function normHealthNum(v, lo, hi, digits) {
  if (typeof v === "boolean") return null;
  const x = Number(v);
  if (!isFinite(x) || x < lo || x > hi) return null;
  return digits ? Math.round(x * 10) / 10 : Math.round(x);
}

function normalizeHealth(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {
    sleep_hours: normHealthNum(obj.sleep_hours, 0, 24, 1),
    sleep_start: normHHMM(obj.sleep_start),
    sleep_end: normHHMM(obj.sleep_end),
    steps: normHealthNum(obj.steps, 0, 200000),
    exercise_minutes: normHealthNum(obj.exercise_minutes, 0, 1440),
    weight: normHealthNum(obj.weight, 20, 300, 1),
    heart_rate: normHealthNum(obj.heart_rate, 25, 240),
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

function parseHealth(raw) {
  const s = extractObject(stripFence(raw));
  if (!s) return null;
  for (const cand of [s, repairJson(s)]) {
    let obj;
    try { obj = JSON.parse(cand); } catch (e) { continue; }
    const nh = normalizeHealth(obj);
    if (nh) return nh;
  }
  return null;
}

// ---------------- 台账统计 ----------------
// 虚度时长只计：确认虚度（waste+confirmed / normal+review_waste）

function hoursOf(r) {
  const h = Number(r && r.hours);
  return isFinite(h) && h > 0 && h <= 24 ? h : 0;
}

function stats(ledger, now) {
  const d = now || new Date();
  const monthKey = d.getFullYear() + "-" + pad2(d.getMonth() + 1);
  const st = {
    month: monthKey,
    month_wasted: 0, month_value: 0, month_save_time: 0,
    month_top_wastes: [], month_top_highlights: [],
    total_wasted: 0, total_value: 0, total_save_time: 0,
    waste_total: 0, waste_confirmed: 0, waste_not_waste: 0,
    normal_total: 0, normal_reviewing: 0, normal_review_waste: 0, normal_review_valuable: 0,
    valuable_total: 0,
    blacklist_count: 0,
    judged_total: 0, resolved: 0, admitted: 0,
    waste_rate: 0, month_waste_rate: 0,
    life_change_total: 0,
    monthly: {},
  };
  const monthly = {};
  for (const r of ledger || []) {
    const v = r.verdict, o = r.outcome;
    const hours = hoursOf(r);
    const created = String(r.created || "");
    const mk = created.slice(0, 7);
    if (!monthly[mk]) monthly[mk] = {
      month: mk, judged: 0, wasted: 0, value: 0, save_time: 0,
      blacklist: 0, max_waste: null, max_valuable: null,
      top_wastes: [], top_highlights: [],
    };
    const m = monthly[mk];
    if (VERDICTS.indexOf(v) < 0) continue;
    st.judged_total++; m.judged++;
    const inMonth = mk === monthKey;
    if (v === "waste") {
      st.waste_total++;
      if (o === "confirmed") {
        st.waste_confirmed++;
        st.total_wasted += hours; m.wasted += hours;
        st.admitted++;
        if (inMonth) st.month_wasted += hours;
        m.top_wastes.push({ activity: r.activity, hours, created });
        if (!m.max_waste || hours > hoursOf(m.max_waste)) m.max_waste = { activity: r.activity, hours };
      } else if (o === "not_waste") {
        st.waste_not_waste++;
        st.total_value += hours; m.value += hours;
        if (inMonth) st.month_value += hours;
      }
    } else if (v === "normal") {
      st.normal_total++;
      if (o === "review_pending") st.normal_reviewing++;
      else if (o === "review_waste") {
        st.normal_review_waste++;
        st.total_wasted += hours; m.wasted += hours;
        st.admitted++;
        if (inMonth) st.month_wasted += hours;
        m.top_wastes.push({ activity: r.activity, hours, created });
        if (!m.max_waste || hours > hoursOf(m.max_waste)) m.max_waste = { activity: r.activity, hours };
      } else if (o === "review_valuable") {
        st.normal_review_valuable++;
        st.total_value += hours; m.value += hours;
        if (inMonth) st.month_value += hours;
      }
    } else if (v === "valuable") {
      st.valuable_total++;
      if (o === "highlight") {
        st.total_value += hours; m.value += hours;
        if (inMonth) st.month_value += hours;
        m.top_highlights.push({ activity: r.activity, hours, created });
        if (!m.max_valuable || hours > hoursOf(m.max_valuable)) m.max_valuable = { activity: r.activity, hours };
      }
    }
    if (BLACKLIST_OUTCOMES.indexOf(o) >= 0) {
      st.blacklist_count++; m.blacklist++;
    }
    if (o === "confirmed" && v === "waste") {
      st.total_save_time += normSaveTime(r.save_time);
      if (inMonth) st.month_save_time += normSaveTime(r.save_time);
    }
    const settled = (v === "waste" && (o === "confirmed" || o === "not_waste")) ||
      (v === "normal" && (o === "review_waste" || o === "review_valuable"));
    if (settled) { st.resolved++; m.resolved = (m.resolved || 0) + 1; }
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  st.total_wasted = r1(st.total_wasted);
  st.total_value = r1(st.total_value);
  st.month_wasted = r1(st.month_wasted);
  st.month_value = r1(st.month_value);
  st.month_save_time = r1(st.month_save_time);
  st.total_save_time = r1(st.total_save_time);
  const totalAll = st.total_wasted + st.total_value;
  st.waste_rate = totalAll ? Math.round(st.total_wasted / totalAll * 1000) / 10 : 0;
  const monthAll = st.month_wasted + st.month_value;
  st.month_waste_rate = monthAll ? Math.round(st.month_wasted / monthAll * 1000) / 10 : 0;
  st.life_change_total = lifeChangeTotal(ledger);
  const keys = Object.keys(monthly).sort().reverse();
  st.monthly = keys.map((k) => {
    const m = monthly[k];
    m.wasted = r1(m.wasted);
    m.value = r1(m.value);
    m.save_time = r1(m.save_time);
    const allH = m.wasted + m.value;
    m.waste_rate = allH ? Math.round(m.wasted / allH * 1000) / 10 : 0;
    m.top_wastes = m.top_wastes.sort((a, b) => b.hours - a.hours).slice(0, 3);
    m.top_highlights = m.top_highlights.sort((a, b) => b.hours - a.hours).slice(0, 3);
    return m;
  });
  const cur = st.monthly.find((m) => m.month === monthKey);
  if (cur) {
    st.month_top_wastes = cur.top_wastes;
    st.month_top_highlights = cur.top_highlights;
  }
  return st;
}

function coolingDue(ledger, now) {
  const d = now || new Date();
  const nowStr = fmtNow(d);
  return (ledger || [])
    .filter((r) => r.verdict === "normal" && r.outcome === "review_pending" &&
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
  record.waste_index = { waste: 80, normal: 50, valuable: 20 }[verdict];
  if (verdict === "normal") {
    record.outcome = "review_pending";
    record.cool_until = record.cool_until || coolingUntil(record.created);
  } else if (verdict === "valuable") {
    record.outcome = "highlight";
    record.outcome_at = fmtNow();
  }
  return true;
}

// ---------------- 虚度黑名单（翻旧账） ----------------

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

function blacklistMatches(ledger, activity, limit) {
  limit = limit || 3;
  const grams = bigrams(activity);
  if (!grams.length) return [];
  const scored = [];
  for (const r of ledger || []) {
    if (BLACKLIST_OUTCOMES.indexOf(r.outcome) < 0) continue;
    const other = bigrams(r.activity);
    const overlap = overlapCount(grams, other);
    if (overlap > 0) scored.push({ overlap, created: String(r.created || ""), r });
  }
  scored.sort((a, b) => (b.overlap - a.overlap) || a.created.localeCompare(b.created));
  return scored.slice(0, limit).map((x) => x.r);
}

function blacklistLines(ledger, activity, limit) {
  return blacklistMatches(ledger, activity, limit).map((r) => {
    const vl = (VERDICT_LABELS[r.verdict] || {}).label || "?";
    return "你曾在 " + String(r.created || "").slice(0, 10) + " 虚度过「" + r.activity +
      "」（" + (hoursText(r.hours) || "时长不详") + "，判定为" + vl + "），本次同类行为会拉高虚度评分";
  });
}

// ---------------- 健康摘要 ----------------

function healthSummary(profile) {
  const log = (profile || {}).health_log || [];
  if (!log.length) return "";
  const h = log[0];
  const parts = [];
  if (h.sleep_hours != null) {
    let seg = "睡眠 " + fmtNum(h.sleep_hours) + " 小时";
    if (h.sleep_start && h.sleep_end) seg += "（" + h.sleep_start + " ~ " + h.sleep_end + "）";
    parts.push(seg);
  }
  if (h.steps != null) parts.push("步数 " + h.steps);
  if (h.exercise_minutes != null) parts.push("运动 " + h.exercise_minutes + " 分钟");
  if (h.weight != null) parts.push("体重 " + fmtNum(h.weight) + "kg");
  if (h.heart_rate != null) parts.push("心率 " + h.heart_rate);
  if (!parts.length) return "";
  return String(h.date || "").slice(0, 10) + "导入：" + parts.join(" · ");
}

// ---------------- 提示词构建 ----------------

const SYSTEM_SCREENSHOT = `

截图判定补充规则：
- 用户可能附上现场照片或屏幕截图（如华为运动健康、短视频 APP 时长统计、游戏战绩等）。请先从截图提取关键信息：实际行为、时长/次数/进度等线索，再套用上面的判定逻辑。
- 截图里的成瘾特征（连续使用时长、今日已刷 N 小时、凌晨 2 点仍在用）是判定取材重点——逐条点破。
- 截图与用户填写的信息冲突时（如时长不一致），以截图为准，并在结论中明确点出这个矛盾。
- 若截图模糊或关键信息不可见，在结论中如实说明「截图未见关键信息」，不要编造。`;

const USER_SCREENSHOT_NOTE = "【附时光截图】已随本条提交。请先读取截图里的实际行为与时长线索再判定；截图与上面填写的信息冲突时以截图为准。";

function hasImage(record) {
  return !!(record && record.thumb);
}

function personaSystem(personaId, screenshot) {
  return SYSTEM_LOGIC + (screenshot ? SYSTEM_SCREENSHOT : "") + "\n\n" +
    (PERSONA_TONE[personaId] || PERSONA_TONE.salty);
}

function buildMessages(record, profile, personaId, blacklist) {
  const prof = profile || {};
  const hours = hoursOf(record);
  const img = hasImage(record);
  const parts = [
    "【今天做了什么】" + (record.activity || ""),
    "【耗时】" + (hoursText(hours) || "时长不详"),
    "【内心感受】" + (String(record.feeling || "").trim() || "（未说明）"),
  ];
  const st = lifeStats(prof, null);
  if (st.ready) {
    parts.push("【生命档案】出生 " + String(prof.birth_date).slice(0, 10) +
      "（现 " + st.age_text + "）· 预期寿命 " + Math.round(st.expectancy_years) +
      " 岁 · 已度过人生 " + st.lived_pct + "%");
    const b = bmi(prof.height, prof.weight);
    if (b != null) parts.push("【身体】BMI " + b);
    if (prof.sleep_start || prof.sleep_end || prof.sleep_hours) {
      parts.push("【作息】入睡 " + (prof.sleep_start || "?") + " · 起床 " + (prof.sleep_end || "?") +
        " · 日均睡眠 " + (hoursText(prof.sleep_hours) || "?"));
    }
    const extras = [["chronic", "慢性病/病史"], ["diet", "饮食"], ["smoke", "烟"], ["drink", "酒"], ["exercise", "运动频率"]];
    for (const [key, label] of extras) {
      const val = String(prof[key] || "").trim();
      if (val) parts.push("【" + label + "】" + val.slice(0, 60));
    }
  }
  const hs = healthSummary(prof);
  if (hs) parts.push("【健康摘要】" + hs);
  if (blacklist && blacklist.length) {
    parts.push("【历史虚度提醒·翻旧账】\n" + blacklist.map((d) => "- " + d).join("\n"));
  }
  if (img) parts.push(USER_SCREENSHOT_NOTE);
  parts.push("请直接输出判定 JSON。");
  return { system: personaSystem(personaId, img), user: parts.join("\n") };
}

// ---------------- 健康截图识别提示词 ----------------

const HEALTH_PROMPT = `识别这张华为运动健康截图，提取：睡眠时长（小时）、入睡时间、起床时间、日均步数、运动时长（分钟）、体重（kg）、心率（次/分）。
只输出纯 JSON，不要多余文字，不要 markdown 围栏。缺失的字段填 null：
{"sleep_hours":7.5,"sleep_start":"23:30","sleep_end":"07:00","steps":8000,"exercise_minutes":30,"weight":65.5,"heart_rate":70}`;

// ---------------- 导出 ----------------

const LifeWaster = {
  VERDICTS, VERDICT_LABELS, ALLOWED_OUTCOMES, OUTCOME_LABELS,
  BLACKLIST_OUTCOMES, WASTED_OUTCOMES, VALUE_OUTCOMES,
  COOLING_HOURS, WASTE_INDEX_HEAVY, WASTE_INDEX_MILD, PERSONAS,
  fmtNum, fmtNow, makeId,
  parseBirth, bmi, lifeStats, lifeChangeTotal, hoursText, lifeShareText, remainText,
  stripFence, extractObject, repairJson, normalizeVerdict, parseVerdict, parsePartial, autoclose,
  verdictFromIndex, normIndex,
  normHHMM, normalizeHealth, parseHealth,
  hoursOf, stats, coolingDue, coolingUntil, markOutcome, manualVerdict,
  blacklistMatches, blacklistLines, healthSummary,
  personaSystem, buildMessages, hasImage, HEALTH_PROMPT,
};

global.LifeWaster = LifeWaster;
if (typeof window !== "undefined") {
  // 测试钩子（自动化验证离线模式，不影响正常功能）
  window.__lifewaster = { engine: LifeWaster };
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = LifeWaster;
}
})(typeof window !== "undefined" ? window : globalThis);
