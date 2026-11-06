# -*- coding: utf-8 -*-
"""核心引擎单测：时薪换算 / 判定 JSON 解析健壮性 / 流式增量解析 /
台账统计聚合（守住金额只计🚫且听劝）/ 72h 冷静期（注入时间偏移）/
吃灰翻旧账注入 / 手动归档 / 人格提示词。

运行：python3 -m unittest tests.test_engine -v
"""
import json
import sys
import unittest
from datetime import datetime, timedelta

import os
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)
import engine  # noqa: E402


def dt(*args):
    return datetime(*args)


class TestHourly(unittest.TestCase):
    def test_hourly_wage(self):
        self.assertEqual(engine.hourly_wage(10000, 21.75, 8), 57.47)
        self.assertEqual(engine.hourly_wage(8800, 22, 8), 50.0)
        self.assertEqual(engine.hourly_wage(0, 22, 8), 0)
        self.assertEqual(engine.hourly_wage(-5, 22, 8), 0)
        self.assertEqual(engine.hourly_wage(10000, 0, 8), 0)
        self.assertEqual(engine.hourly_wage(None, 22, 8), 0)
        self.assertEqual(engine.hourly_wage("abc", 22, 8), 0)

    def test_hours_text(self):
        # ¥899 ≈ 你 37.5 小时的班
        self.assertEqual(engine.hours_for(899, 24), 37.5)
        self.assertIn("37.5 小时的班", engine.hours_text(899, 24))
        self.assertIn("4.7 个工作日", engine.hours_text(899, 24))
        self.assertEqual(engine.hours_text(10, 24), "不到 1 小时的班")
        self.assertEqual(engine.hours_text(899, 0), "")
        self.assertEqual(engine.hours_text(0, 24), "")
        self.assertEqual(engine.hours_text("x", 24), "")


class TestParseVerdict(unittest.TestCase):
    GOOD = ('{"verdict":"weed","confidence":72,"reasons":['
            '{"text":"理由一","sting":4},{"text":"理由二","sting":5}],'
            '"questions":[],"alternatives":[],"saved_amount":899}')

    def test_plain(self):
        v = engine.parse_verdict(self.GOOD, 899)
        self.assertEqual(v["verdict"], "weed")
        self.assertEqual(v["confidence"], 72)
        self.assertEqual(len(v["reasons"]), 2)
        self.assertEqual(v["reasons"][0]["sting"], 4)
        self.assertEqual(v["saved_amount"], 899)

    def test_fenced(self):
        for fence in ("```json\n%s\n```", "```JSON\n%s\n```", "```\n%s\n```"):
            v = engine.parse_verdict(fence % self.GOOD, 899)
            self.assertEqual(v["verdict"], "weed", fence)

    def test_chatter_around_json(self):
        v = engine.parse_verdict("好的，我的判定如下：\n%s\n希望帮你守住工资。" % self.GOOD, 899)
        self.assertEqual(v["verdict"], "weed")

    def test_trailing_comma_and_fullwidth(self):
        s = '{“verdict”:“cool”,“confidence”:60,“reasons”:[“想清楚”],“questions”:[“q1”,“q2”,],“saved_amount”:0,}'
        v = engine.parse_verdict(s)
        self.assertEqual(v["verdict"], "cool")
        self.assertEqual(v["confidence"], 60)
        self.assertEqual(len(v["questions"]), 2)

    def test_verdict_synonyms(self):
        for raw, want in [("REJECT", "weed"), ("别买", "weed"), ("暂缓批准", "cool"),
                          ("再想想", "cool"), ("approve", "pass"), ("可以买", "pass")]:
            v = engine.parse_verdict('{"verdict":"%s","confidence":1,"reasons":[]}' % raw)
            self.assertEqual(v["verdict"], want, raw)

    def test_confidence_coercion(self):
        self.assertEqual(engine.parse_verdict('{"verdict":"weed","confidence":"78%","reasons":[]}')["confidence"], 78)
        self.assertEqual(engine.parse_verdict('{"verdict":"weed","confidence":88.6,"reasons":[]}')["confidence"], 89)
        self.assertEqual(engine.parse_verdict('{"verdict":"weed","confidence":999,"reasons":[]}')["confidence"], 100)
        self.assertEqual(engine.parse_verdict('{"verdict":"weed","confidence":-3,"reasons":[]}')["confidence"], 0)
        self.assertIsNone(engine.parse_verdict('{"verdict":"weed","confidence":"高","reasons":[]}')["confidence"])
        self.assertIsNone(engine.parse_verdict('{"verdict":"weed","confidence":true,"reasons":[]}')["confidence"])

    def test_sting_coercion(self):
        v = engine.parse_verdict('{"verdict":"weed","reasons":[{"text":"a","sting":"2"},{"text":"b"},{"text":"c","sting":99},{"text":"d","sting":0}]}')
        self.assertEqual([r["sting"] for r in v["reasons"]], [2, 3, 5, 1])

    def test_reasons_as_plain_strings(self):
        v = engine.parse_verdict('{"verdict":"pass","reasons":["好","不错"]}')
        self.assertEqual(v["reasons"], [{"text": "好", "sting": 3}, {"text": "不错", "sting": 3}])

    def test_saved_amount_fallback_to_price(self):
        v = engine.parse_verdict('{"verdict":"weed","reasons":[]}', 399)
        self.assertEqual(v["saved_amount"], 399)
        v = engine.parse_verdict('{"verdict":"weed","reasons":[],"saved_amount":-5}', 399)
        self.assertEqual(v["saved_amount"], 399)
        v = engine.parse_verdict('{"verdict":"weed","reasons":[],"saved_amount":"很多"}', 399)
        self.assertEqual(v["saved_amount"], 399)

    def test_failures_return_none(self):
        self.assertIsNone(engine.parse_verdict(""))
        self.assertIsNone(engine.parse_verdict("完全没有 JSON 的闲聊"))
        self.assertIsNone(engine.parse_verdict('{"verdict":"垃圾档位","reasons":[]}'))
        self.assertIsNone(engine.parse_verdict('{"confidence":50,"reasons":[]}'))
        self.assertIsNone(engine.parse_verdict('[1,2,3]'))
        self.assertIsNone(engine.parse_verdict('{"verdict":"weed","confidence":50,"reasons":['))  # 半截

    def test_non_dict_json(self):
        self.assertIsNone(engine.parse_verdict('"just a string"'))


class TestParsePartial(unittest.TestCase):
    CHUNKS = ['{"verdict', '":"weed"', ',"confidence":7', '2,"reasons":[{"tex',
              't":"理由一","sting":4}', ',{"text":"理由二","sting":5}',
              ',"questions":[],"alternatives":[],"saved_amount":899}']

    def test_stream_grows(self):
        acc, seen = "", []
        for c in self.CHUNKS:
            acc += c
            p = engine.parse_partial(acc)
            if p:
                seen.append((len(p["reasons"]), p["confidence"], p["verdict"]))
        self.assertTrue(seen, "流式过程中至少解析出一次中间结果")
        self.assertEqual(seen[-1], (2, 72, "weed"))
        # 理由必须逐条出现（先 1 条后 2 条）
        counts = [s[0] for s in seen if s[0]]
        self.assertEqual(counts, sorted(counts))
        self.assertEqual(min(counts), 1)

    def test_early_verdict(self):
        p = engine.parse_partial('{"verdict":"cool","confidence":6')
        self.assertIsNotNone(p)
        self.assertEqual(p["verdict"], "cool")

    def test_garbage(self):
        self.assertIsNone(engine.parse_partial("完全不是 JSON"))
        self.assertIsNone(engine.parse_partial('{'))


class TestStats(unittest.TestCase):
    LEDGER = [
        {"item": "键盘", "price": 899, "verdict": "weed", "outcome": "kept", "created": "2026-11-01 10:00:00"},
        {"item": "耳机", "price": 1500, "verdict": "weed", "outcome": "bought", "created": "2026-11-02 10:00:00"},
        {"item": "泡脚桶", "price": 399, "verdict": "cool", "outcome": "cool_didnt_buy", "created": "2026-10-20 10:00:00"},
        {"item": "香薰机", "price": 300, "verdict": "cool", "outcome": "cool_bought", "created": "2026-11-04 10:00:00"},
        {"item": "手表", "price": 2000, "verdict": "pass", "outcome": "pass_bought", "created": "2026-11-03 10:00:00"},
        {"item": "台灯", "price": 200, "verdict": "cool", "outcome": "cool_pending", "cool_until": "2026-12-01 00:00:00", "created": "2026-11-05 10:00:00"},
        {"item": "未判定", "price": 100, "verdict": None, "outcome": "pending", "created": "2026-11-05 10:00:00"},
    ]

    def test_saved_only_weed_and_kept(self):
        st = engine.stats(self.LEDGER, now=dt(2026, 11, 6, 12, 0, 0))
        # 守住金额只计 🚫 且「听劝没买」：只有键盘 899
        self.assertEqual(st["month_saved"], 899)
        self.assertEqual(st["total_saved"], 899)
        self.assertEqual(st["month_kept_count"], 1)
        # pass_bought 的手表 2000 绝不能计入
        self.assertNotEqual(st["month_saved"], 2899)

    def test_rates(self):
        st = engine.stats(self.LEDGER, now=dt(2026, 11, 6, 12, 0, 0))
        # resolved: 键盘(kept) 耳机(bought) 泡脚桶(没买) 香薰机(买了) = 4；劝退 2
        self.assertEqual(st["resolved"], 4)
        self.assertEqual(st["persuaded"], 2)
        self.assertEqual(st["success_rate"], 50.0)
        self.assertEqual(st["dust_count"], 2)  # 耳机 + 香薰机
        self.assertEqual(st["dust_amount"], 1800)
        self.assertEqual(st["dust_rate"], 50.0)
        self.assertEqual(st["judged_total"], 6)  # 未判定记录不计
        self.assertEqual(st["cool_pending"], 1)

    def test_month_report(self):
        st = engine.stats(self.LEDGER, now=dt(2026, 11, 6, 12, 0, 0))
        self.assertEqual([m["month"] for m in st["monthly"]], ["2026-11", "2026-10"])
        m11 = st["monthly"][0]
        self.assertEqual(m11["judged"], 5)
        self.assertEqual(m11["saved"], 899)
        # 11 月 resolved：键盘(kept)/耳机(bought)/香薰机(买了)=3，劝退 1 → 33.3%
        self.assertEqual(m11["resolved"], 3)
        self.assertEqual(m11["weed_rate"], 33.3)
        self.assertEqual(m11["dust_rate"], 66.7)
        self.assertEqual(m11["max_weed"], {"item": "耳机", "price": 1500})
        self.assertEqual(m11["max_pass"], {"item": "手表", "price": 2000})
        m10 = st["monthly"][1]
        self.assertEqual(m10["saved"], 0)
        self.assertEqual(m10["persuaded"], 1)

    def test_empty(self):
        st = engine.stats([], now=dt(2026, 11, 6))
        self.assertEqual(st["month_saved"], 0)
        self.assertEqual(st["success_rate"], 0)
        self.assertEqual(st["monthly"], [])


class TestCooling(unittest.TestCase):
    def test_cooling_until(self):
        self.assertEqual(engine.cooling_until("2026-11-06 12:00:00"), "2026-11-09 12:00:00")
        self.assertEqual(engine.cooling_until("2026-12-31 23:59:59"), "2027-01-03 23:59:59")  # 跨月跨年
        # created 为空时退回当前时间 + 72h（格式正确即可）
        self.assertRegex(engine.cooling_until(""), r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")

    def test_cooling_due_with_time_injection(self):
        ledger = [
            {"item": "刚进冷静期", "verdict": "cool", "outcome": "cool_pending",
             "cool_until": "2026-11-09 12:00:00", "created": "2026-11-06 12:00:00"},
            {"item": "早已到点", "verdict": "cool", "outcome": "cool_pending",
             "cool_until": "2026-10-01 08:00:00", "created": "2026-09-28 08:00:00"},
            {"item": "已回填", "verdict": "cool", "outcome": "cool_didnt_buy",
             "cool_until": "2026-10-01 08:00:00", "created": "2026-09-28 08:00:00"},
            {"item": "拔草不回访", "verdict": "weed", "outcome": "kept",
             "created": "2026-09-01 08:00:00"},
        ]
        # 注入「现在」：只剩 10 月那条早已到点的
        due = engine.cooling_due(ledger, now=dt(2026, 11, 8, 12, 0, 0))
        self.assertEqual([r["item"] for r in due], ["早已到点"])
        # 注入 72h 后：两条都到点，按到点时间先后排序
        due = engine.cooling_due(ledger, now=dt(2026, 11, 9, 12, 0, 1))
        self.assertEqual([r["item"] for r in due], ["早已到点", "刚进冷静期"])

    def test_mark_outcome_transitions(self):
        weed = {"verdict": "weed", "outcome": "pending"}
        self.assertTrue(engine.mark_outcome(weed, "kept"))
        self.assertFalse(engine.mark_outcome(weed, "cool_didnt_buy"))
        self.assertTrue(engine.mark_outcome(weed, "bought"))  # 允许改标
        cool = {"verdict": "cool", "outcome": "cool_pending"}
        self.assertTrue(engine.mark_outcome(cool, "cool_didnt_buy"))
        self.assertFalse(engine.mark_outcome(cool, "kept"))
        pas = {"verdict": "pass", "outcome": "pending"}
        self.assertTrue(engine.mark_outcome(pas, "pass_bought"))
        self.assertFalse(engine.mark_outcome(pas, "bought"))
        bad = {"verdict": None, "outcome": "pending"}
        self.assertFalse(engine.mark_outcome(bad, "kept"))


class TestDust(unittest.TestCase):
    LEDGER = [
        {"id": "a", "item": "机械键盘", "price": 899, "verdict": "weed", "outcome": "bought", "created": "2025-03-01 10:00:00"},
        {"id": "b", "item": "泡脚桶", "price": 399, "verdict": "cool", "outcome": "cool_bought", "created": "2025-06-01 10:00:00"},
        {"id": "c", "item": "手机壳", "price": 50, "verdict": "weed", "outcome": "kept", "created": "2025-08-01 10:00:00"},
        {"id": "d", "item": "蓝牙耳机", "price": 1500, "verdict": "weed", "outcome": "bought", "created": "2024-01-01 10:00:00"},
    ]

    def test_dust_only_matches_dust_outcomes(self):
        matches = engine.dust_matches(self.LEDGER, "键盘键帽")
        self.assertEqual([m["id"] for m in matches], ["a"])  # kept 的手机壳不算吃灰

    def test_dust_order_by_overlap_then_recent(self):
        matches = engine.dust_matches(self.LEDGER, "无线蓝牙耳机", limit=3)
        self.assertEqual(matches[0]["id"], "d")  # 重叠更多
        self.assertEqual([m["id"] for m in engine.dust_matches(self.LEDGER, "泡脚桶")], ["b"])

    def test_dust_lines_text(self):
        lines = engine.dust_lines(self.LEDGER, "机械键盘")
        self.assertEqual(len(lines), 1)
        self.assertIn("吃灰至今", lines[0])
        self.assertIn("¥899", lines[0])
        self.assertIn("2025-03-01", lines[0])
        self.assertEqual(engine.dust_lines(self.LEDGER, "从未买过的黑名单物品"), [])

    def test_prompt_injection_contains_dust(self):
        record = {"item": "键盘", "price": 899, "why": "", "source": ""}
        _system, user = engine.build_messages(record, 24, "salty", engine.dust_lines(self.LEDGER, "键盘"))
        self.assertIn("翻旧账", user)
        self.assertIn("吃灰至今", user)


class TestManualVerdict(unittest.TestCase):
    def test_manual(self):
        r = {"verdict": None, "parse_ok": False, "price": 500, "outcome": "pending", "created": "2026-11-06 10:00:00"}
        self.assertTrue(engine.manual_verdict(r, "weed"))
        self.assertEqual(r["saved_amount"], 500)
        self.assertTrue(r["manual"])
        r2 = {"price": 500, "outcome": "pending", "created": "2026-11-06 10:00:00"}
        self.assertTrue(engine.manual_verdict(r2, "cool"))
        self.assertEqual(r2["outcome"], "cool_pending")
        self.assertEqual(r2["cool_until"], "2026-11-09 10:00:00")
        self.assertFalse(engine.manual_verdict(r, "垃圾"))


class TestPrompts(unittest.TestCase):
    def test_three_personas_same_logic(self):
        logic = engine.persona_system("salty")
        self.assertEqual(engine.persona_system("mild").split("\n\n")[0], logic.split("\n\n")[0])
        self.assertEqual(engine.persona_system("guardian").split("\n\n")[0], logic.split("\n\n")[0])

    def test_persona_tones(self):
        self.assertIn("温柔", engine.persona_system("mild"))
        self.assertIn("不允许人身羞辱", engine.persona_system("salty"))
        self.assertIn("辜负这个月", engine.persona_system("guardian"))
        # 每种人格的提示词都必须带安全红线
        for pid in engine.PERSONAS:
            s = engine.persona_system(pid)
            self.assertIn("禁止推荐任何借贷", s, pid)
            self.assertIn("禁止永远反对", s, pid)
            self.assertIn("该买的刚需要放行", s, pid)

    def test_build_messages_user_fields(self):
        record = {"item": "机械键盘", "price": 899, "why": "打字爽", "source": "直播间"}
        system, user = engine.build_messages(record, 24, "salty", [])
        self.assertIn("【想买的东西】机械键盘", user)
        self.assertIn("【价格】¥899", user)
        self.assertIn("【你的时薪】¥24/小时", user)
        self.assertIn("37.5 小时的班", user)
        self.assertIn("【为什么想买】打字爽", user)
        self.assertIn("【在哪看到的】直播间", user)
        self.assertIn("请直接输出判定 JSON", user)
        self.assertIn("只输出一个 JSON 对象", system)

    def test_build_messages_no_salary(self):
        _s, user = engine.build_messages({"item": "x", "price": 1}, 0, "mild", [])
        self.assertNotIn("时薪", user)


if __name__ == "__main__":
    unittest.main(verbosity=2)
