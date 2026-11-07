/* engine.js 单测：与 tests/test_engine.py 同构的关键用例，保证 APK 离线引擎行为一致。
 * 运行：node tests/test_engine.js */
"use strict";
const assert = require("assert");
const path = require("path");
const B = require(path.join(__dirname, "..", "static", "engine.js"));

// ---------------- 生命换算 ----------------
const NOW = new Date(2026, 10, 6, 12, 0, 0);  // 2026-11-06 12:00
const PROFILE = { birth_date: "1990-06-15", expectancy: 80 };

let st = B.lifeStats(PROFILE, [], NOW);
assert.strictEqual(st.ready, true);
const wantDays = Math.floor((NOW.getTime() - new Date(1990, 5, 15).getTime()) / 86400000);
assert.strictEqual(st.age_days, wantDays);
assert.strictEqual(st.remain_days, Math.round((80 * 365.25 - wantDays) * 10) / 10);
assert.ok(st.remain_text.includes("年"));
assert.ok(st.lived_pct > 0 && st.lived_pct < 100);

// 寿命趣味增减（只计已判定）
st = B.lifeStats(PROFILE, [
  { verdict: "waste", life_change: -3 },
  { verdict: "valuable", life_change: 1 },
  { verdict: null, life_change: 100 },
  { verdict: "normal", life_change: "x" },
], NOW);
assert.strictEqual(st.life_change_total, -2);
assert.strictEqual(st.remain_days, Math.round((80 * 365.25 - wantDays - 2) * 10) / 10);

for (const bad of ["", "abc", "1990-13-01", "1990/06/15", "1990-02-30"]) {
  assert.strictEqual(B.lifeStats({ birth_date: bad, expectancy: 80 }, [], NOW).ready, false);
}
assert.strictEqual(B.lifeStats({ birth_date: "1990-06-15", expectancy: 0 }, [], NOW).ready, false);

assert.strictEqual(B.bmi(170, 65), 22.5);
assert.strictEqual(B.bmi(0, 65), null);
assert.strictEqual(B.bmi(170, 0), null);
assert.strictEqual(B.bmi(170, -5), null);
assert.strictEqual(B.bmi("abc", 65), null);
assert.strictEqual(B.bmi(null, null), null);
assert.strictEqual(B.bmi(300, 65), null);

assert.strictEqual(B.hoursText(2.5), "2.5 小时");
assert.strictEqual(B.hoursText(1), "1 小时");
assert.strictEqual(B.hoursText(0.75), "45 分钟");
assert.strictEqual(B.hoursText(0), "");
assert.strictEqual(B.hoursText("x"), "");

const share = B.lifeShareText(3, PROFILE, [], NOW);
assert.ok(share.includes("剩余生命"));
assert.ok(share.includes("19.5 天"));
assert.ok(!B.lifeShareText(3, {}, [], NOW).includes("剩余生命"));
assert.ok(B.lifeShareText(3, {}, [], NOW).includes("19.5 天"));
assert.strictEqual(B.lifeShareText(0, PROFILE), "");
console.log("✓ 生命换算（已活/剩余/BMI/占余比例）");

// ---------------- 判定 JSON 解析 ----------------
const GOOD = '{"verdict":"waste","confidence":78,"waste_index":78,"reasons":[{"content":"无意义刷短视频，没有成长收益","sting_level":4},{"content":"纯消磨","sting_level":5}],"questions":[],"alternatives":["看书"],"life_change":-2,"save_time":3}';
let v = B.parseVerdict(GOOD);
assert.strictEqual(v.verdict, "waste");
assert.strictEqual(v.confidence, 78);
assert.strictEqual(v.waste_index, 78);
assert.strictEqual(v.reasons[0].content, "无意义刷短视频，没有成长收益");
assert.strictEqual(v.reasons[0].sting_level, 4);
assert.strictEqual(v.life_change, -2);
assert.strictEqual(v.save_time, 3);

for (const fence of ["```json\n" + GOOD + "\n```", "```JSON\n" + GOOD + "\n```", "```\n" + GOOD + "\n```"]) {
  assert.strictEqual(B.parseVerdict(fence).verdict, "waste", fence);
}
assert.strictEqual(B.parseVerdict("判定如下：\n" + GOOD + "\n望三思。").verdict, "waste");

v = B.parseVerdict('{“verdict”:“normal”,“confidence”:60,“waste_index”:50,“reasons”:[“想清楚”],“questions”:[“q1”,“q2”,],“life_change”:0,“save_time”:0,}');
assert.strictEqual(v.verdict, "normal");
assert.strictEqual(v.confidence, 60);
assert.strictEqual(v.questions.length, 2);

const SYNONYMS = [["重度", "waste"], ["重度虚度", "waste"], ["虚度不予通过", "waste"],
  ["中度", "normal"], ["待复盘", "normal"], ["高光", "valuable"], ["高光时刻", "valuable"]];
for (const [raw, want] of SYNONYMS) {
  assert.strictEqual(B.parseVerdict('{"verdict":"' + raw + '","confidence":1,"reasons":[]}').verdict, want, raw);
}

// waste_index 阈值强制档位一致
assert.strictEqual(B.parseVerdict('{"verdict":"valuable","waste_index":85,"reasons":[]}').verdict, "waste");
assert.strictEqual(B.parseVerdict('{"verdict":"waste","waste_index":20,"reasons":[]}').verdict, "valuable");
assert.strictEqual(B.parseVerdict('{"verdict":"waste","waste_index":42,"reasons":[]}').verdict, "normal");
assert.strictEqual(B.parseVerdict('{"waste_index":99,"reasons":[]}').verdict, "waste");
assert.strictEqual(B.parseVerdict('{"waste_index":35,"reasons":[]}').verdict, "normal");
assert.strictEqual(B.parseVerdict('{"waste_index":34,"reasons":[]}').verdict, "valuable");

assert.strictEqual(B.parseVerdict('{"verdict":"waste","confidence":"78%","reasons":[]}').confidence, 78);
assert.strictEqual(B.parseVerdict('{"verdict":"waste","confidence":999,"reasons":[]}').confidence, 100);
assert.strictEqual(B.parseVerdict('{"verdict":"waste","confidence":-3,"reasons":[]}').confidence, 0);
assert.strictEqual(B.parseVerdict('{"verdict":"waste","confidence":"高","reasons":[]}').confidence, null);

v = B.parseVerdict('{"verdict":"waste","reasons":[{"content":"a","sting_level":"2"},{"content":"b"},{"content":"c","sting_level":99},{"content":"d","sting_level":0}]}');
assert.deepStrictEqual(v.reasons.map((r) => r.sting_level), [2, 3, 5, 1]);

v = B.parseVerdict('{"verdict":"valuable","reasons":["好","不错"]}');
assert.deepStrictEqual(v.reasons, [{ content: "好", sting_level: 3 }, { content: "不错", sting_level: 3 }]);
v = B.parseVerdict('{"verdict":"waste","reasons":[{"text":"x","sting":2}]}');
assert.deepStrictEqual(v.reasons, [{ content: "x", sting_level: 2 }]);

assert.strictEqual(B.parseVerdict('{"verdict":"waste","reasons":[],"life_change":-999}').life_change, -365);
assert.strictEqual(B.parseVerdict('{"verdict":"waste","reasons":[],"life_change":2.7}').life_change, 3);
assert.strictEqual(B.parseVerdict('{"verdict":"waste","reasons":[],"life_change":"abc"}').life_change, 0);
assert.strictEqual(B.parseVerdict('{"verdict":"waste","reasons":[],"save_time":30}').save_time, 24);
assert.strictEqual(B.parseVerdict('{"verdict":"waste","reasons":[],"save_time":-5}').save_time, 0);

assert.strictEqual(B.parseVerdict(""), null);
assert.strictEqual(B.parseVerdict("完全没有 JSON 的闲聊"), null);
assert.strictEqual(B.parseVerdict('{"verdict":"垃圾档位","reasons":[]}'), null);
assert.strictEqual(B.parseVerdict('{"confidence":50,"reasons":[]}'), null);
assert.strictEqual(B.parseVerdict('[1,2,3]'), null);
assert.strictEqual(B.parseVerdict('{"verdict":"waste","confidence":50,"reasons":['), null);
console.log("✓ 判定 JSON 解析（围栏/全角/尾逗号/指数定档/越界钳制）");

// ---------------- 流式增量解析 ----------------
const CHUNKS = ['{"verdict', '":"waste"', ',"waste_index":7', '8,"confidence":78,"reasons":[{"con',
  'tent":"理由一","sting_level":4}', ',{"content":"理由二","sting_level":5}',
  ',"questions":[],"alternatives":[],"life_change":-2,"save_time":3}'];
{
  let acc = "";
  const seen = [];
  for (const c of CHUNKS) {
    acc += c;
    const p = B.parsePartial(acc);
    if (p) seen.push([p.reasons.length, p.confidence, p.verdict]);
  }
  assert.ok(seen.length > 0, "流式过程中至少解析出一次中间结果");
  assert.deepStrictEqual(seen[seen.length - 1], [2, 78, "waste"]);
  const counts = seen.filter((s) => s[0]).map((s) => s[0]);
  assert.deepStrictEqual(counts, counts.slice().sort((a, b) => a - b));
  assert.strictEqual(Math.min(...counts), 1);
}
assert.strictEqual(B.parsePartial('{"waste_index":55').verdict, "normal");
assert.strictEqual(B.parsePartial("完全不是 JSON"), null);
assert.strictEqual(B.parsePartial("{"), null);
console.log("✓ 流式增量解析（理由逐条出现 + 指数提前定档）");

// ---------------- 健康截图 JSON 解析 ----------------
const FULL = '{"sleep_hours":7.5,"sleep_start":"23:30","sleep_end":"07:00","steps":8000,"exercise_minutes":30,"weight":65.5,"heart_rate":70}';
let h = B.parseHealth(FULL);
assert.strictEqual(h.sleep_hours, 7.5);
assert.strictEqual(h.sleep_start, "23:30");
assert.strictEqual(h.steps, 8000);
assert.strictEqual(h.weight, 65.5);
assert.strictEqual(h.heart_rate, 70);
assert.strictEqual(B.parseHealth("识别结果：\n```json\n" + FULL + "\n```").steps, 8000);
assert.strictEqual(B.parseHealth('{"sleep_start":"23点30"}').sleep_start, "23:30");
assert.strictEqual(B.parseHealth('{"sleep_start":"6:5"}').sleep_start, "06:05");
assert.strictEqual(B.parseHealth('{"sleep_start":"24:00"}').sleep_start, "00:00");
// 非法时间：带合法锚字段时该字段置 null；只有非法字段 → 整体识别失败
assert.strictEqual(B.parseHealth('{"sleep_hours":7,"sleep_start":"25:00"}').sleep_start, null);
assert.strictEqual(B.parseHealth('{"sleep_hours":7,"sleep_start":"11:60"}').sleep_start, null);
assert.strictEqual(B.parseHealth('{"sleep_start":"25:00"}'), null);
assert.strictEqual(B.parseHealth('{"sleep_hours":26}'), null);
assert.strictEqual(B.parseHealth('{"steps":-5}'), null);
assert.strictEqual(B.parseHealth('{"steps":true}'), null);
assert.strictEqual(B.parseHealth('{"sleep_hours":7,"steps":-5}').steps, null);
assert.strictEqual(B.parseHealth('{"steps":100,"weight":999}').weight, null);
assert.strictEqual(B.parseHealth('{"steps":"9000"}').steps, 9000);
assert.strictEqual(B.parseHealth(""), null);
assert.strictEqual(B.parseHealth("闲聊无 JSON"), null);
assert.strictEqual(B.parseHealth('{"foo":"bar"}'), null);
console.log("✓ 健康截图 JSON 解析（时间/数值钳制）");

// ---------------- 台账统计 ----------------
const LEDGER = [
  { activity: "刷短视频", hours: 3, verdict: "waste", outcome: "confirmed", save_time: 2, life_change: -2, created: "2026-11-01 10:00:00" },
  { activity: "加班开会走神", hours: 2, verdict: "waste", outcome: "not_waste", life_change: 0, created: "2026-11-02 10:00:00" },
  { activity: "通宵手游", hours: 4, verdict: "normal", outcome: "review_waste", life_change: -1, created: "2026-10-20 10:00:00" },
  { activity: "逛街闲逛", hours: 1.5, verdict: "normal", outcome: "review_valuable", created: "2026-11-04 10:00:00" },
  { activity: "跑步健身", hours: 1, verdict: "valuable", outcome: "highlight", life_change: 1, created: "2026-11-03 10:00:00" },
  { activity: "读书", hours: 2, verdict: "normal", outcome: "review_pending", cool_until: "2026-12-01 00:00:00", created: "2026-11-05 10:00:00" },
  { activity: "未判定", hours: 1, verdict: null, outcome: "pending", created: "2026-11-05 10:00:00" },
];
let s = B.stats(LEDGER, NOW);
assert.strictEqual(s.total_wasted, 7);   // 只计确认虚度 3 + 复盘虚度 4
assert.strictEqual(s.total_value, 4.5);
assert.strictEqual(s.month_wasted, 3);
assert.strictEqual(s.month_value, 4.5);
assert.strictEqual(s.month_waste_rate, 40);
assert.strictEqual(s.judged_total, 6);
assert.strictEqual(s.blacklist_count, 2);
assert.strictEqual(s.resolved, 4);
assert.strictEqual(s.life_change_total, -2);
assert.strictEqual(s.total_save_time, 2);
assert.strictEqual(s.monthly[0].month, "2026-11");
assert.strictEqual(s.monthly[0].judged, 5);
assert.strictEqual(s.monthly[0].waste_rate, 40);
assert.deepStrictEqual(s.monthly[0].max_waste, { activity: "刷短视频", hours: 3 });
assert.deepStrictEqual(s.monthly[0].max_valuable, { activity: "跑步健身", hours: 1 });
assert.strictEqual(s.monthly[1].wasted, 4);
assert.strictEqual(s.monthly[1].waste_rate, 100);
assert.strictEqual(s.month_top_wastes.length, 1);
s = B.stats([], NOW);
assert.strictEqual(s.waste_rate, 0);
assert.deepStrictEqual(s.monthly, []);
console.log("✓ 台账统计（虚度时长只计确认虚度，月度聚合）");

// ---------------- 冷静期 / 结果标记 / 手动归档 ----------------
assert.strictEqual(B.coolingUntil("2026-11-06 12:00:00"), "2026-11-09 12:00:00");
assert.strictEqual(B.coolingUntil("2026-12-31 23:59:59"), "2027-01-03 23:59:59");
const LEDGER2 = [
  { activity: "刚进复盘期", verdict: "normal", outcome: "review_pending", cool_until: "2026-11-09 12:00:00", created: "2026-11-06 12:00:00" },
  { activity: "早已到点", verdict: "normal", outcome: "review_pending", cool_until: "2026-10-01 08:00:00", created: "2026-09-28 08:00:00" },
  { activity: "已回填", verdict: "normal", outcome: "review_waste", cool_until: "2026-10-01 08:00:00", created: "2026-09-28 08:00:00" },
  { activity: "重度虚度不回访", verdict: "waste", outcome: "confirmed", created: "2026-09-01 08:00:00" },
];
assert.deepStrictEqual(B.coolingDue(LEDGER2, new Date(2026, 10, 8, 12)).map((r) => r.activity), ["早已到点"]);
assert.deepStrictEqual(B.coolingDue(LEDGER2, new Date(2026, 10, 9, 12, 0, 1)).map((r) => r.activity), ["早已到点", "刚进复盘期"]);

const waste = { verdict: "waste", outcome: "pending" };
assert.ok(B.markOutcome(waste, "confirmed"));
assert.ok(!B.markOutcome(waste, "review_waste"));
assert.ok(B.markOutcome(waste, "not_waste"));
const normal = { verdict: "normal", outcome: "review_pending" };
assert.ok(B.markOutcome(normal, "review_waste"));
assert.ok(!B.markOutcome(normal, "confirmed"));
assert.ok(!B.markOutcome({ verdict: null, outcome: "pending" }, "confirmed"));

const r1 = { verdict: null, parse_ok: false, hours: 2, outcome: "pending", created: "2026-11-06 10:00:00" };
assert.ok(B.manualVerdict(r1, "waste"));
assert.strictEqual(r1.waste_index, 80);
assert.ok(r1.manual);
const r2 = { hours: 2, outcome: "pending", created: "2026-11-06 10:00:00" };
assert.ok(B.manualVerdict(r2, "normal"));
assert.strictEqual(r2.outcome, "review_pending");
assert.strictEqual(r2.cool_until, "2026-11-09 10:00:00");
assert.ok(!B.manualVerdict(r1, "垃圾"));
console.log("✓ 72h 冷静期（时间偏移注入）+ 结果标记 + 手动归档");

// ---------------- 黑名单翻旧账 ----------------
const BLEDGER = [
  { id: "a", activity: "机械键盘打游戏", hours: 3, verdict: "waste", outcome: "confirmed", created: "2025-03-01 10:00:00" },
  { id: "b", activity: "通宵追剧", hours: 4, verdict: "normal", outcome: "review_waste", created: "2025-06-01 10:00:00" },
  { id: "c", activity: "刷朋友圈", hours: 1, verdict: "waste", outcome: "not_waste", created: "2025-08-01 10:00:00" },
  { id: "d", activity: "刷短视频", hours: 2.5, verdict: "waste", outcome: "confirmed", created: "2024-01-01 10:00:00" },
];
assert.deepStrictEqual(B.blacklistMatches(BLEDGER, "打游戏机").map((m) => m.id), ["a"]);
assert.strictEqual(B.blacklistMatches(BLEDGER, "刷短视频放松")[0].id, "d");
const lines = B.blacklistLines(BLEDGER, "机械键盘");
assert.strictEqual(lines.length, 1);
assert.ok(lines[0].includes("拉高虚度评分"));
assert.ok(lines[0].includes("3 小时"));
assert.strictEqual(B.blacklistLines(BLEDGER, "从未虚度过的高级活动").length, 0);
console.log("✓ 虚度黑名单翻旧账（只匹配确认虚度）");

// ---------------- 提示词 ----------------
const logic = B.personaSystem("salty").split("\n\n")[0];
assert.strictEqual(B.personaSystem("mild").split("\n\n")[0], logic);
assert.strictEqual(B.personaSystem("guardian").split("\n\n")[0], logic);
assert.ok(B.personaSystem("mild").includes("娓娓道来"));
assert.ok(B.personaSystem("salty").includes("不允许人身羞辱"));
assert.ok(B.personaSystem("guardian").includes("消耗本就不多的余生"));
for (const pid of Object.keys(B.PERSONAS)) {
  const sys = B.personaSystem(pid);
  assert.ok(sys.includes("不做任何医疗诊断"), pid);
  assert.ok(sys.includes("不推荐任何保健品"), pid);
  assert.ok(sys.includes("绝不羞辱人格"), pid);
  assert.ok(sys.includes("禁止永远差评"), pid);
  assert.ok(sys.includes("偶尔放松≠虚度"), pid);
}
const PROF = Object.assign({}, PROFILE, { height: 170, weight: 65, sleep_start: "23:30", sleep_end: "07:00", sleep_hours: 7.5, health_log: [{ date: "2026-11-05 08:00:00", sleep_hours: 6.5, steps: 3000 }] });
const msgs = B.buildMessages({ activity: "连续刷短视频", hours: 3, feeling: "越刷越空虚" }, PROF, "salty", B.blacklistLines(BLEDGER, "刷短视频"));
assert.ok(msgs.user.includes("【今天做了什么】连续刷短视频"));
assert.ok(msgs.user.includes("【耗时】3 小时"));
assert.ok(msgs.user.includes("【生命档案】出生 1990-06-15"));
assert.ok(msgs.user.includes("BMI 22.5"));
assert.ok(msgs.user.includes("【健康摘要】2026-11-05导入"));
assert.ok(msgs.user.includes("翻旧账"));
assert.ok(msgs.user.includes("拉高虚度评分"));
assert.ok(msgs.user.includes("请直接输出判定 JSON"));
assert.ok(msgs.system.includes("只输出一个 JSON 对象"));
const msgs2 = B.buildMessages({ activity: "x", hours: 1 }, {}, "mild", []);
assert.ok(!msgs2.user.includes("生命档案"));
assert.ok(!msgs2.user.includes("健康摘要"));
assert.ok(B.HEALTH_PROMPT.includes("华为运动健康"));
assert.ok(B.HEALTH_PROMPT.includes("只输出纯 JSON"));
const msgs3 = B.buildMessages({ activity: "刷手机", hours: 2, thumb: "data:image/jpeg;base64,AAAA" }, PROFILE, "salty", []);
assert.ok(msgs3.system.includes("截图判定补充规则"));
assert.ok(msgs3.system.includes("以截图为准"));
assert.ok(msgs3.user.includes("【附时光截图】"));
const msgs4 = B.buildMessages({ activity: "刷手机", hours: 2 }, PROFILE, "salty", []);
assert.ok(!msgs4.system.includes("截图判定补充规则"));
console.log("✓ 三档人格提示词 + 生命档案/健康/黑名单注入 + 合规红线");

console.log("\nengine.js 全部通过");
