/* engine.js 单测：与 tests/test_engine.py 同构的关键用例，保证 APK 离线引擎行为一致。
 * 运行：node tests/test_engine.js */
"use strict";
const assert = require("assert");
const path = require("path");
const B = require(path.join(__dirname, "..", "static", "engine.js"));

// ---------------- 时薪 ----------------
assert.strictEqual(B.hourlyWage(10000, 21.75, 8), 57.47);
assert.strictEqual(B.hourlyWage(0, 22, 8), 0);
assert.strictEqual(B.hourlyWage(-5, 22, 8), 0);
assert.strictEqual(B.hourlyWage("abc", 22, 8), 0);
assert.strictEqual(B.hoursFor(899, 24), 37.5);
assert.ok(B.hoursText(899, 24).includes("37.5 小时的班"));
assert.ok(B.hoursText(899, 24).includes("4.7 个工作日"));
assert.strictEqual(B.hoursText(10, 24), "不到 1 小时的班");
assert.strictEqual(B.hoursText(899, 0), "");
console.log("✓ 时薪换算");

// ---------------- 判定 JSON 解析 ----------------
const GOOD = '{"verdict":"weed","confidence":72,"reasons":[{"text":"理由一","sting":4},{"text":"理由二","sting":5}],"questions":[],"alternatives":[],"saved_amount":899}';
let v = B.parseVerdict(GOOD, 899);
assert.strictEqual(v.verdict, "weed");
assert.strictEqual(v.confidence, 72);
assert.strictEqual(v.reasons[0].sting, 4);
assert.strictEqual(v.saved_amount, 899);

for (const fence of ["```json\n" + GOOD + "\n```", "```JSON\n" + GOOD + "\n```", "```\n" + GOOD + "\n```"]) {
  assert.strictEqual(B.parseVerdict(fence, 899).verdict, "weed", fence);
}
assert.strictEqual(B.parseVerdict("判定如下：\n" + GOOD + "\n望三思。", 899).verdict, "weed");

v = B.parseVerdict('{“verdict”:“cool”,“confidence”:60,“reasons”:[“想清楚”],“questions”:[“q1”,“q2”,],“saved_amount”:0,}');
assert.strictEqual(v.verdict, "cool");
assert.strictEqual(v.confidence, 60);
assert.strictEqual(v.questions.length, 2);

const SYNONYMS = [["REJECT", "weed"], ["别买", "weed"], ["暂缓批准", "cool"], ["approve", "pass"], ["可以买", "pass"]];
for (const [raw, want] of SYNONYMS) {
  assert.strictEqual(B.parseVerdict('{"verdict":"' + raw + '","confidence":1,"reasons":[]}').verdict, want, raw);
}

assert.strictEqual(B.parseVerdict('{"verdict":"weed","confidence":"78%","reasons":[]}').confidence, 78);
assert.strictEqual(B.parseVerdict('{"verdict":"weed","confidence":999,"reasons":[]}').confidence, 100);
assert.strictEqual(B.parseVerdict('{"verdict":"weed","confidence":-3,"reasons":[]}').confidence, 0);
assert.strictEqual(B.parseVerdict('{"verdict":"weed","confidence":"高","reasons":[]}').confidence, null);

v = B.parseVerdict('{"verdict":"weed","reasons":[{"text":"a","sting":"2"},{"text":"b"},{"text":"c","sting":99},{"text":"d","sting":0}]}');
assert.deepStrictEqual(v.reasons.map((r) => r.sting), [2, 3, 5, 1]);

v = B.parseVerdict('{"verdict":"pass","reasons":["好","不错"]}');
assert.deepStrictEqual(v.reasons, [{ text: "好", sting: 3 }, { text: "不错", sting: 3 }]);

assert.strictEqual(B.parseVerdict('{"verdict":"weed","reasons":[]}', 399).saved_amount, 399);
assert.strictEqual(B.parseVerdict('{"verdict":"weed","reasons":[],"saved_amount":-5}', 399).saved_amount, 399);

assert.strictEqual(B.parseVerdict(""), null);
assert.strictEqual(B.parseVerdict("完全没有 JSON 的闲聊"), null);
assert.strictEqual(B.parseVerdict('{"verdict":"垃圾档位","reasons":[]}'), null);
assert.strictEqual(B.parseVerdict('{"confidence":50,"reasons":[]}'), null);
assert.strictEqual(B.parseVerdict('{"verdict":"weed","confidence":50,"reasons":['), null);
console.log("✓ 判定 JSON 健壮解析（围栏/杂质/全角/尾逗号/同义词/越界钳制）");

// ---------------- 流式增量解析 ----------------
const CHUNKS = ['{"verdict', '":"weed"', ',"confidence":7', '2,"reasons":[{"tex',
  't":"理由一","sting":4}', ',{"text":"理由二","sting":5}',
  ',"questions":[],"alternatives":[],"saved_amount":899}'];
let acc = "", seen = [];
for (const c of CHUNKS) {
  acc += c;
  const p = B.parsePartial(acc);
  if (p) seen.push([p.reasons.length, p.confidence, p.verdict]);
}
assert.ok(seen.length > 0, "流式过程中至少解析出一次中间结果");
assert.deepStrictEqual(seen[seen.length - 1], [2, 72, "weed"]);
const counts = seen.map((s) => s[0]).filter((n) => n > 0);
assert.ok(Math.min(...counts) === 1, "理由应先出现 1 条再 2 条");
const early = B.parsePartial('{"verdict":"cool","confidence":6');
assert.strictEqual(early.verdict, "cool");
assert.strictEqual(B.parsePartial("完全不是 JSON"), null);
console.log("✓ 流式增量解析（理由逐条出现）");

// ---------------- 台账统计（守住金额只计🚫且听劝） ----------------
const LEDGER = [
  { item: "键盘", price: 899, verdict: "weed", outcome: "kept", created: "2026-11-01 10:00:00" },
  { item: "耳机", price: 1500, verdict: "weed", outcome: "bought", created: "2026-11-02 10:00:00" },
  { item: "泡脚桶", price: 399, verdict: "cool", outcome: "cool_didnt_buy", created: "2026-10-20 10:00:00" },
  { item: "香薰机", price: 300, verdict: "cool", outcome: "cool_bought", created: "2026-11-04 10:00:00" },
  { item: "手表", price: 2000, verdict: "pass", outcome: "pass_bought", created: "2026-11-03 10:00:00" },
  { item: "台灯", price: 200, verdict: "cool", outcome: "cool_pending", cool_until: "2026-12-01 00:00:00", created: "2026-11-05 10:00:00" },
  { item: "未判定", price: 100, verdict: null, outcome: "pending", created: "2026-11-05 10:00:00" },
];
const st = B.stats(LEDGER, new Date(2026, 10, 6, 12, 0, 0));
assert.strictEqual(st.month_saved, 899);
assert.strictEqual(st.total_saved, 899);
assert.strictEqual(st.resolved, 4);
assert.strictEqual(st.persuaded, 2);
assert.strictEqual(st.success_rate, 50.0);
assert.strictEqual(st.dust_count, 2);
assert.strictEqual(st.dust_amount, 1800);
assert.strictEqual(st.judged_total, 6);
assert.strictEqual(st.cool_pending, 1);
assert.deepStrictEqual(st.monthly.map((m) => m.month), ["2026-11", "2026-10"]);
const m11 = st.monthly[0];
assert.strictEqual(m11.saved, 899);
assert.strictEqual(m11.weed_rate, 33.3);
assert.strictEqual(m11.dust_rate, 66.7);
assert.deepStrictEqual(m11.max_weed, { item: "耳机", price: 1500 });
assert.deepStrictEqual(m11.max_pass, { item: "手表", price: 2000 });
console.log("✓ 台账统计聚合（月战报/成功率/吃灰率/最贵拔草放行）");

// ---------------- 冷静期 72h（注入时间偏移） ----------------
assert.strictEqual(B.coolingUntil("2026-11-06 12:00:00"), "2026-11-09 12:00:00");
const CLEDGER = [
  { item: "刚进冷静期", verdict: "cool", outcome: "cool_pending", cool_until: "2026-11-09 12:00:00", created: "2026-11-06 12:00:00" },
  { item: "早已到点", verdict: "cool", outcome: "cool_pending", cool_until: "2026-10-01 08:00:00", created: "2026-09-28 08:00:00" },
  { item: "已回填", verdict: "cool", outcome: "cool_didnt_buy", cool_until: "2026-10-01 08:00:00", created: "2026-09-28 08:00:00" },
];
assert.deepStrictEqual(
  B.coolingDue(CLEDGER, new Date(2026, 10, 8, 12, 0, 0)).map((r) => r.item), ["早已到点"]);
assert.deepStrictEqual(
  B.coolingDue(CLEDGER, new Date(2026, 10, 9, 12, 0, 1)).map((r) => r.item), ["早已到点", "刚进冷静期"]);
console.log("✓ 冷静期 72h 回访（时间偏移注入）");

// ---------------- 结果标记 / 手动归档 ----------------
assert.strictEqual(B.markOutcome({ verdict: "weed", outcome: "pending" }, "kept"), true);
assert.strictEqual(B.markOutcome({ verdict: "weed", outcome: "pending" }, "cool_didnt_buy"), false);
assert.strictEqual(B.markOutcome({ verdict: "cool", outcome: "cool_pending" }, "cool_bought"), true);
assert.strictEqual(B.markOutcome({ verdict: null, outcome: "pending" }, "kept"), false);
const man = { price: 500, outcome: "pending", created: "2026-11-06 10:00:00" };
assert.strictEqual(B.manualVerdict(man, "cool"), true);
assert.strictEqual(man.outcome, "cool_pending");
assert.strictEqual(man.cool_until, "2026-11-09 10:00:00");
assert.strictEqual(B.manualVerdict(man, "垃圾"), false);
console.log("✓ 结果标记转换 / 手动归档");

// ---------------- 吃灰翻旧账 ----------------
const DLEDGER = [
  { id: "a", item: "机械键盘", price: 899, verdict: "weed", outcome: "bought", created: "2025-03-01 10:00:00" },
  { id: "b", item: "泡脚桶", price: 399, verdict: "cool", outcome: "cool_bought", created: "2025-06-01 10:00:00" },
  { id: "c", item: "手机壳", price: 50, verdict: "weed", outcome: "kept", created: "2025-08-01 10:00:00" },
];
assert.deepStrictEqual(B.dustMatches(DLEDGER, "键盘键帽").map((r) => r.id), ["a"]);
const lines = B.dustLines(DLEDGER, "泡脚桶");
assert.strictEqual(lines.length, 1);
assert.ok(lines[0].includes("吃灰至今") && lines[0].includes("¥399"));
assert.deepStrictEqual(B.dustLines(DLEDGER, "从未买过的黑名单物品"), []);
console.log("✓ 吃灰翻旧账匹配与注入文本");

// ---------------- 提示词 ----------------
const msgs = B.buildMessages({ item: "机械键盘", price: 899, why: "打字爽", source: "直播间" }, 24, "salty", lines);
assert.ok(msgs.system.includes("只输出一个 JSON 对象"));
assert.ok(msgs.system.includes("禁止推荐任何借贷"));
assert.ok(msgs.system.includes("不允许人身羞辱"));
assert.ok(msgs.system.includes("禁止永远反对"));
assert.ok(msgs.user.includes("【想买的东西】机械键盘"));
assert.ok(msgs.user.includes("【你的时薪】¥24/小时"));
assert.ok(msgs.user.includes("37.5 小时的班"));
assert.ok(msgs.user.includes("翻旧账"));
assert.strictEqual(B.buildMessages({ item: "x", price: 1 }, 0, "mild", []).user.includes("时薪"), false);
// 三人格共享判定逻辑（SYSTEM 部分一致）
assert.strictEqual(B.personaSystem("mild").split("\n\n")[0], B.personaSystem("salty").split("\n\n")[0]);
assert.ok(B.personaSystem("guardian").includes("辜负这个月"));
console.log("✓ 人格提示词（语气分离 / 安全红线 / 翻旧账注入）");

console.log("\nengine.js 全部通过");
