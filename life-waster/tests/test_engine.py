# -*- coding: utf-8 -*-
"""核心引擎单测：生命换算（出生日期/剩余寿命/BMI）/ 虚度判定 JSON 解析健壮性 /
流式增量解析 / 健康截图 JSON 解析 / 台账统计聚合（虚度时长只计确认虚度）/
72h 复盘冷静期（注入时间偏移）/ 黑名单翻旧账注入 / 手动归档 / 人格提示词与合规红线。

运行：python3 -m unittest tests.test_engine -v
"""
import json
import os
import sys
import unittest
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)
import engine  # noqa: E402


def dt(*args):
    return datetime(*args)


PROFILE = {"birth_date": "1990-06-15", "expectancy": 80}


class TestLife(unittest.TestCase):
    NOW = dt(2026, 11, 6, 12, 0, 0)

    def test_life_stats(self):
        birth = datetime(1990, 6, 15)
        want_days = (self.NOW - birth).days
        st = engine.life_stats(PROFILE, ledger=[], now=self.NOW)
        self.assertTrue(st["ready"])
        self.assertEqual(st["age_days"], want_days)
        self.assertEqual(st["age_hours"], want_days * 24 + 12)
        self.assertEqual(st["remain_days"], round(80 * 365.25 - want_days, 1))
        self.assertEqual(st["remain_hours"], round(st["remain_days"] * 24, 1))
        self.assertAlmostEqual(st["lived_pct"], round(want_days / (80 * 365.25) * 100, 2))
        self.assertIn("年", st["remain_text"])

    def test_life_stats_with_life_change(self):
        ledger = [{"verdict": "waste", "life_change": -3},
                  {"verdict": "valuable", "life_change": 1},
                  {"verdict": None, "life_change": 100},   # 未判定不计
                  {"verdict": "normal", "life_change": "x"}]
        st = engine.life_stats(PROFILE, ledger=ledger, now=self.NOW)
        self.assertEqual(st["life_change_total"], -2)
        birth_days = (self.NOW - datetime(1990, 6, 15)).days
        self.assertEqual(st["remain_days"], round(80 * 365.25 - birth_days - 2, 1))

    def test_life_stats_invalid_birth(self):
        for bad in ("", "abc", "1990-13-01", "1990/06/15", None, "1990-02-30"):
            st = engine.life_stats({"birth_date": bad, "expectancy": 80}, [], now=self.NOW)
            self.assertFalse(st["ready"])
            self.assertIsNone(st["age_days"])
        st = engine.life_stats({"birth_date": "1990-06-15", "expectancy": 0}, [], now=self.NOW)
        self.assertFalse(st["ready"])

    def test_bmi(self):
        self.assertEqual(engine.bmi(170, 65), 22.5)
        self.assertIsNone(engine.bmi(0, 65))
        self.assertIsNone(engine.bmi(170, 0))
        self.assertIsNone(engine.bmi(170, -5))
        self.assertIsNone(engine.bmi("abc", 65))
        self.assertIsNone(engine.bmi(None, None))
        self.assertIsNone(engine.bmi(300, 65))
        self.assertIsNone(engine.bmi(True, 65))

    def test_hours_text(self):
        self.assertEqual(engine.hours_text(2.5), "2.5 小时")
        self.assertEqual(engine.hours_text(1), "1 小时")
        self.assertEqual(engine.hours_text(0.75), "45 分钟")
        self.assertEqual(engine.hours_text(0), "")
        self.assertEqual(engine.hours_text("x"), "")

    def test_life_share_text(self):
        # 有档案：出现「剩余生命」占比
        t = engine.life_share_text(3, PROFILE, ledger=[], now=self.NOW)
        self.assertIn("剩余生命", t)
        self.assertIn("%", t)
        # 3h × 每周 3 次 × 52 周 = 19.5 天/年
        self.assertIn("19.5 天", t)
        # 无档案：只剩年度换算
        t2 = engine.life_share_text(3, {}, ledger=[], now=self.NOW)
        self.assertNotIn("剩余生命", t2)
        self.assertIn("19.5 天", t2)
        self.assertEqual(engine.life_share_text(0, PROFILE), "")


class TestParseVerdict(unittest.TestCase):
    GOOD = ('{"verdict":"waste","confidence":78,"waste_index":78,"reasons":['
            '{"content":"无意义刷短视频，没有成长收益","sting_level":4},'
            '{"content":"纯消磨","sting_level":5}],"questions":[],"alternatives":["看书"],'
            '"life_change":-2,"save_time":3}')

    def test_plain(self):
        v = engine.parse_verdict(self.GOOD)
        self.assertEqual(v["verdict"], "waste")
        self.assertEqual(v["confidence"], 78)
        self.assertEqual(v["waste_index"], 78)
        self.assertEqual(len(v["reasons"]), 2)
        self.assertEqual(v["reasons"][0]["content"], "无意义刷短视频，没有成长收益")
        self.assertEqual(v["reasons"][0]["sting_level"], 4)
        self.assertEqual(v["life_change"], -2)
        self.assertEqual(v["save_time"], 3)

    def test_fenced(self):
        for fence in ("```json\n%s\n```", "```JSON\n%s\n```", "```\n%s\n```"):
            v = engine.parse_verdict(fence % self.GOOD)
            self.assertEqual(v["verdict"], "waste", fence)

    def test_chatter_around_json(self):
        v = engine.parse_verdict("好的，我的判定如下：\n%s\n希望帮你守住光阴。" % self.GOOD)
        self.assertEqual(v["verdict"], "waste")

    def test_trailing_comma_and_fullwidth(self):
        s = '{“verdict”:“normal”,“confidence”:60,“waste_index”:50,“reasons”:[“想清楚”],“questions”:[“q1”,“q2”,],“life_change”:0,“save_time”:0,}'
        v = engine.parse_verdict(s)
        self.assertEqual(v["verdict"], "normal")
        self.assertEqual(v["confidence"], 60)
        self.assertEqual(len(v["questions"]), 2)

    def test_verdict_synonyms(self):
        for raw, want in [("重度", "waste"), ("重度虚度", "waste"), ("虚度不予通过", "waste"),
                          ("中度", "normal"), ("待复盘", "normal"), ("冷静", "normal"),
                          ("高光", "valuable"), ("高光时刻", "valuable"), ("充实", "valuable")]:
            v = engine.parse_verdict('{"verdict":"%s","confidence":1,"reasons":[]}' % raw)
            self.assertEqual(v["verdict"], want, raw)

    def test_index_drives_verdict(self):
        # waste_index 存在时必须以阈值重新推导档位（档位与指数强制一致）
        self.assertEqual(engine.parse_verdict('{"verdict":"valuable","waste_index":85,"reasons":[]}')["verdict"], "waste")
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","waste_index":20,"reasons":[]}')["verdict"], "valuable")
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","waste_index":42,"reasons":[]}')["verdict"], "normal")
        # 只有指数没有档位：直接推导
        self.assertEqual(engine.parse_verdict('{"waste_index":99,"reasons":[]}')["verdict"], "waste")
        self.assertEqual(engine.parse_verdict('{"waste_index":35,"reasons":[]}')["verdict"], "normal")
        self.assertEqual(engine.parse_verdict('{"waste_index":34,"reasons":[]}')["verdict"], "valuable")

    def test_confidence_coercion(self):
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","confidence":"78%","reasons":[]}')["confidence"], 78)
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","confidence":88.6,"reasons":[]}')["confidence"], 89)
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","confidence":999,"reasons":[]}')["confidence"], 100)
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","confidence":-3,"reasons":[]}')["confidence"], 0)
        self.assertIsNone(engine.parse_verdict('{"verdict":"waste","confidence":"高","reasons":[]}')["confidence"])
        self.assertIsNone(engine.parse_verdict('{"verdict":"waste","confidence":true,"reasons":[]}')["confidence"])

    def test_sting_coercion(self):
        v = engine.parse_verdict('{"verdict":"waste","reasons":[{"content":"a","sting_level":"2"},{"content":"b"},{"content":"c","sting_level":99},{"content":"d","sting_level":0}]}')
        self.assertEqual([r["sting_level"] for r in v["reasons"]], [2, 3, 5, 1])

    def test_reasons_plain_strings_and_compat_keys(self):
        v = engine.parse_verdict('{"verdict":"valuable","reasons":["好","不错"]}')
        self.assertEqual(v["reasons"], [{"content": "好", "sting_level": 3}, {"content": "不错", "sting_level": 3}])
        # 兼容 text/sting 字段名
        v = engine.parse_verdict('{"verdict":"waste","reasons":[{"text":"x","sting":2}]}')
        self.assertEqual(v["reasons"], [{"content": "x", "sting_level": 2}])

    def test_life_change_and_save_time(self):
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","reasons":[],"life_change":2.7}')["life_change"], 3)
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","reasons":[],"life_change":-999}')["life_change"], -365)
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","reasons":[],"life_change":"abc"}')["life_change"], 0)
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","reasons":[],"life_change":true}')["life_change"], 0)
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","reasons":[]}')["life_change"], 0)
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","reasons":[],"save_time":-5}')["save_time"], 0)
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","reasons":[],"save_time":30}')["save_time"], 24)
        self.assertEqual(engine.parse_verdict('{"verdict":"waste","reasons":[],"save_time":"2"}')["save_time"], 2)

    def test_failures_return_none(self):
        self.assertIsNone(engine.parse_verdict(""))
        self.assertIsNone(engine.parse_verdict("完全没有 JSON 的闲聊"))
        self.assertIsNone(engine.parse_verdict('{"verdict":"垃圾档位","reasons":[]}'))
        self.assertIsNone(engine.parse_verdict('{"confidence":50,"reasons":[]}'))
        self.assertIsNone(engine.parse_verdict("[1,2,3]"))
        self.assertIsNone(engine.parse_verdict('{"verdict":"waste","confidence":50,"reasons":['))  # 半截
        self.assertIsNone(engine.parse_verdict('"just a string"'))


class TestParsePartial(unittest.TestCase):
    CHUNKS = ['{"verdict', '":"waste"', ',"waste_index":7', '8,"confidence":78,"reasons":[{"con',
              'tent":"理由一","sting_level":4}', ',{"content":"理由二","sting_level":5}',
              ',"questions":[],"alternatives":[],"life_change":-2,"save_time":3}']

    def test_stream_grows(self):
        acc, seen = "", []
        for c in self.CHUNKS:
            acc += c
            p = engine.parse_partial(acc)
            if p:
                seen.append((len(p["reasons"]), p["confidence"], p["verdict"]))
        self.assertTrue(seen, "流式过程中至少解析出一次中间结果")
        self.assertEqual(seen[-1], (2, 78, "waste"))
        counts = [s[0] for s in seen if s[0]]
        self.assertEqual(counts, sorted(counts))
        self.assertEqual(min(counts), 1)

    def test_early_index_derives_verdict(self):
        p = engine.parse_partial('{"waste_index":55')
        self.assertIsNotNone(p)
        self.assertEqual(p["verdict"], "normal")

    def test_garbage(self):
        self.assertIsNone(engine.parse_partial("完全不是 JSON"))
        self.assertIsNone(engine.parse_partial("{"))


class TestHealth(unittest.TestCase):
    FULL = ('{"sleep_hours":7.5,"sleep_start":"23:30","sleep_end":"07:00",'
            '"steps":8000,"exercise_minutes":30,"weight":65.5,"heart_rate":70}')

    def test_full(self):
        h = engine.parse_health(self.FULL)
        self.assertEqual(h["sleep_hours"], 7.5)
        self.assertEqual(h["sleep_start"], "23:30")
        self.assertEqual(h["sleep_end"], "07:00")
        self.assertEqual(h["steps"], 8000)
        self.assertEqual(h["exercise_minutes"], 30)
        self.assertEqual(h["weight"], 65.5)
        self.assertEqual(h["heart_rate"], 70)

    def test_fenced_and_chatter(self):
        h = engine.parse_health("识别结果：\n```json\n%s\n```" % self.FULL)
        self.assertEqual(h["steps"], 8000)

    def test_hhmm_coercion(self):
        self.assertEqual(engine.parse_health('{"sleep_start":"23点30"}')["sleep_start"], "23:30")
        self.assertEqual(engine.parse_health('{"sleep_start":"6:5"}')["sleep_start"], "06:05")
        self.assertEqual(engine.parse_health('{"sleep_start":"24:00"}')["sleep_start"], "00:00")
        # 非法时间：字段置 None（其余合法字段保留）
        self.assertIsNone(engine.parse_health('{"sleep_hours":7,"sleep_start":"25:00"}')["sleep_start"])
        self.assertIsNone(engine.parse_health('{"sleep_hours":7,"sleep_start":"11:60"}')["sleep_start"])
        self.assertIsNone(engine.parse_health('{"sleep_hours":7,"sleep_start":"睡得早"}')["sleep_start"])
        self.assertIsNone(engine.parse_health('{"sleep_hours":7,"sleep_start":730}')["sleep_start"])
        # 只有非法字段 → 整体识别失败
        self.assertIsNone(engine.parse_health('{"sleep_start":"25:00"}'))

    def test_range_guards(self):
        # 单一非法字段 → 整体识别失败
        self.assertIsNone(engine.parse_health('{"steps":-5}'))
        self.assertIsNone(engine.parse_health('{"steps":true}'))
        # 合法锚字段在位时，非法字段置 None
        self.assertIsNone(engine.parse_health('{"sleep_hours":7,"steps":-5}')["steps"])
        self.assertIsNone(engine.parse_health('{"steps":100,"weight":999}')["weight"])
        self.assertIsNone(engine.parse_health('{"steps":100,"heart_rate":500}')["heart_rate"])
        self.assertIsNone(engine.parse_health('{"steps":100,"weight":true}')["weight"])
        self.assertEqual(engine.parse_health('{"steps":"9000"}')["steps"], 9000)
        self.assertEqual(engine.parse_health('{"exercise_minutes":90.6}')["exercise_minutes"], 91)

    def test_failures(self):
        self.assertIsNone(engine.parse_health(""))
        self.assertIsNone(engine.parse_health("闲聊无 JSON"))
        self.assertIsNone(engine.parse_health('{"foo":"bar"}'))  # 没有任何有效字段
        self.assertIsNone(engine.parse_health("[1,2]"))


class TestStats(unittest.TestCase):
    LEDGER = [
        {"activity": "刷短视频", "hours": 3, "verdict": "waste", "outcome": "confirmed",
         "save_time": 2, "life_change": -2, "created": "2026-11-01 10:00:00"},
        {"activity": "加班开会走神", "hours": 2, "verdict": "waste", "outcome": "not_waste",
         "life_change": 0, "created": "2026-11-02 10:00:00"},
        {"activity": "通宵手游", "hours": 4, "verdict": "normal", "outcome": "review_waste",
         "life_change": -1, "created": "2026-10-20 10:00:00"},
        {"activity": "逛街闲逛", "hours": 1.5, "verdict": "normal", "outcome": "review_valuable",
         "created": "2026-11-04 10:00:00"},
        {"activity": "跑步健身", "hours": 1, "verdict": "valuable", "outcome": "highlight",
         "life_change": 1, "created": "2026-11-03 10:00:00"},
        {"activity": "读书", "hours": 2, "verdict": "normal", "outcome": "review_pending",
         "cool_until": "2026-12-01 00:00:00", "created": "2026-11-05 10:00:00"},
        {"activity": "未判定", "hours": 1, "verdict": None, "outcome": "pending",
         "created": "2026-11-05 10:00:00"},
    ]

    def test_wasted_only_confirmed(self):
        st = engine.stats(self.LEDGER, now=dt(2026, 11, 6, 12, 0, 0))
        # 虚度时长只计确认虚度：刷短视频 3h + 通宵手游 4h（复盘确实虚度）= 7
        self.assertEqual(st["total_wasted"], 7)
        self.assertEqual(st["total_value"], 4.5)  # 回流 2 + 复盘收获 1.5 + 高光 1
        self.assertEqual(st["month_wasted"], 3)   # 通宵手游在 10 月
        self.assertEqual(st["month_value"], 4.5)
        # 放行/未确认的绝不计入
        self.assertNotEqual(st["total_wasted"], 9)

    def test_rates_and_counts(self):
        st = engine.stats(self.LEDGER, now=dt(2026, 11, 6, 12, 0, 0))
        all_h = st["total_wasted"] + st["total_value"]
        self.assertEqual(st["waste_rate"], round(7 / all_h * 100, 1))
        self.assertEqual(st["month_waste_rate"], 40.0)  # 3 / 7.5
        self.assertEqual(st["judged_total"], 6)  # 未判定不计
        self.assertEqual(st["waste_total"], 2)
        self.assertEqual(st["waste_confirmed"], 1)
        self.assertEqual(st["waste_not_waste"], 1)
        self.assertEqual(st["normal_total"], 3)
        self.assertEqual(st["normal_reviewing"], 1)
        self.assertEqual(st["normal_review_waste"], 1)
        self.assertEqual(st["normal_review_valuable"], 1)
        self.assertEqual(st["valuable_total"], 1)
        self.assertEqual(st["blacklist_count"], 2)  # confirmed + review_waste
        self.assertEqual(st["resolved"], 4)
        self.assertEqual(st["life_change_total"], -2)  # -2 -1 +1（只算已判定）
        self.assertEqual(st["total_save_time"], 2)
        self.assertEqual(st["month_save_time"], 2)

    def test_month_report(self):
        st = engine.stats(self.LEDGER, now=dt(2026, 11, 6, 12, 0, 0))
        self.assertEqual([m["month"] for m in st["monthly"]], ["2026-11", "2026-10"])
        m11 = st["monthly"][0]
        self.assertEqual(m11["judged"], 5)
        self.assertEqual(m11["wasted"], 3)
        self.assertEqual(m11["value"], 4.5)
        self.assertEqual(m11["waste_rate"], 40.0)
        self.assertEqual(m11["blacklist"], 1)
        self.assertEqual(m11["max_waste"], {"activity": "刷短视频", "hours": 3})
        self.assertEqual(m11["max_valuable"], {"activity": "跑步健身", "hours": 1})
        self.assertEqual(m11["top_wastes"], [{"activity": "刷短视频", "hours": 3, "created": "2026-11-01 10:00:00"}])
        m10 = st["monthly"][1]
        self.assertEqual(m10["wasted"], 4)
        self.assertEqual(m10["waste_rate"], 100.0)
        self.assertEqual(st["month_top_wastes"], m11["top_wastes"])

    def test_empty(self):
        st = engine.stats([], now=dt(2026, 11, 6))
        self.assertEqual(st["month_wasted"], 0)
        self.assertEqual(st["waste_rate"], 0)
        self.assertEqual(st["monthly"], [])
        self.assertEqual(st["month_top_wastes"], [])


class TestCooling(unittest.TestCase):
    def test_cooling_until(self):
        self.assertEqual(engine.cooling_until("2026-11-06 12:00:00"), "2026-11-09 12:00:00")
        self.assertEqual(engine.cooling_until("2026-12-31 23:59:59"), "2027-01-03 23:59:59")  # 跨月跨年
        self.assertRegex(engine.cooling_until(""), r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")

    def test_cooling_due_with_time_injection(self):
        ledger = [
            {"activity": "刚进复盘期", "verdict": "normal", "outcome": "review_pending",
             "cool_until": "2026-11-09 12:00:00", "created": "2026-11-06 12:00:00"},
            {"activity": "早已到点", "verdict": "normal", "outcome": "review_pending",
             "cool_until": "2026-10-01 08:00:00", "created": "2026-09-28 08:00:00"},
            {"activity": "已回填", "verdict": "normal", "outcome": "review_waste",
             "cool_until": "2026-10-01 08:00:00", "created": "2026-09-28 08:00:00"},
            {"activity": "重度虚度不回访", "verdict": "waste", "outcome": "confirmed",
             "created": "2026-09-01 08:00:00"},
        ]
        due = engine.cooling_due(ledger, now=dt(2026, 11, 8, 12, 0, 0))
        self.assertEqual([r["activity"] for r in due], ["早已到点"])
        due = engine.cooling_due(ledger, now=dt(2026, 11, 9, 12, 0, 1))
        self.assertEqual([r["activity"] for r in due], ["早已到点", "刚进复盘期"])

    def test_mark_outcome_transitions(self):
        waste = {"verdict": "waste", "outcome": "pending"}
        self.assertTrue(engine.mark_outcome(waste, "confirmed"))
        self.assertFalse(engine.mark_outcome(waste, "review_waste"))
        self.assertTrue(engine.mark_outcome(waste, "not_waste"))  # 允许改标
        normal = {"verdict": "normal", "outcome": "review_pending"}
        self.assertTrue(engine.mark_outcome(normal, "review_waste"))
        self.assertTrue(engine.mark_outcome(normal, "review_valuable"))
        self.assertFalse(engine.mark_outcome(normal, "confirmed"))
        val = {"verdict": "valuable", "outcome": "highlight"}
        self.assertTrue(engine.mark_outcome(val, "highlight"))
        self.assertFalse(engine.mark_outcome(val, "bought"))
        bad = {"verdict": None, "outcome": "pending"}
        self.assertFalse(engine.mark_outcome(bad, "confirmed"))

    def test_manual_verdict(self):
        r = {"verdict": None, "parse_ok": False, "hours": 2, "outcome": "pending", "created": "2026-11-06 10:00:00"}
        self.assertTrue(engine.manual_verdict(r, "waste"))
        self.assertEqual(r["waste_index"], 80)
        self.assertTrue(r["manual"])
        r2 = {"hours": 2, "outcome": "pending", "created": "2026-11-06 10:00:00"}
        self.assertTrue(engine.manual_verdict(r2, "normal"))
        self.assertEqual(r2["outcome"], "review_pending")
        self.assertEqual(r2["cool_until"], "2026-11-09 10:00:00")
        r3 = {"hours": 1, "outcome": "pending", "created": "2026-11-06 10:00:00"}
        self.assertTrue(engine.manual_verdict(r3, "valuable"))
        self.assertEqual(r3["outcome"], "highlight")
        self.assertFalse(engine.manual_verdict(r, "垃圾"))


class TestBlacklist(unittest.TestCase):
    LEDGER = [
        {"id": "a", "activity": "机械键盘打游戏", "hours": 3, "verdict": "waste", "outcome": "confirmed", "created": "2025-03-01 10:00:00"},
        {"id": "b", "activity": "通宵追剧", "hours": 4, "verdict": "normal", "outcome": "review_waste", "created": "2025-06-01 10:00:00"},
        {"id": "c", "activity": "刷朋友圈", "hours": 1, "verdict": "waste", "outcome": "not_waste", "created": "2025-08-01 10:00:00"},
        {"id": "d", "activity": "刷短视频", "hours": 2.5, "verdict": "waste", "outcome": "confirmed", "created": "2024-01-01 10:00:00"},
    ]

    def test_blacklist_only_matches_blacklist_outcomes(self):
        matches = engine.blacklist_matches(self.LEDGER, "打游戏机")
        self.assertEqual([m["id"] for m in matches], ["a"])  # not_waste 的不算黑名单

    def test_blacklist_order_by_overlap_then_recent(self):
        matches = engine.blacklist_matches(self.LEDGER, "刷短视频放松", limit=3)
        self.assertEqual(matches[0]["id"], "d")  # 重叠更多
        self.assertEqual([m["id"] for m in engine.blacklist_matches(self.LEDGER, "通宵追剧")], ["b"])

    def test_blacklist_lines_text(self):
        lines = engine.blacklist_lines(self.LEDGER, "机械键盘")
        self.assertEqual(len(lines), 1)
        self.assertIn("拉高虚度评分", lines[0])
        self.assertIn("3 小时", lines[0])
        self.assertIn("2025-03-01", lines[0])
        self.assertEqual(engine.blacklist_lines(self.LEDGER, "从未虚度过的高级活动"), [])

    def test_prompt_injection_contains_blacklist(self):
        record = {"activity": "打游戏", "hours": 2, "feeling": ""}
        _system, user = engine.build_messages(record, PROFILE, "salty",
                                              engine.blacklist_lines(self.LEDGER, "打游戏"))
        self.assertIn("翻旧账", user)
        self.assertIn("拉高虚度评分", user)


class TestPrompts(unittest.TestCase):
    def test_three_personas_same_logic(self):
        logic = engine.persona_system("salty")
        self.assertEqual(engine.persona_system("mild").split("\n\n")[0], logic.split("\n\n")[0])
        self.assertEqual(engine.persona_system("guardian").split("\n\n")[0], logic.split("\n\n")[0])

    def test_persona_tones(self):
        self.assertIn("娓娓道来", engine.persona_system("mild"))
        self.assertIn("不允许人身羞辱", engine.persona_system("salty"))
        self.assertIn("消耗本就不多的余生", engine.persona_system("guardian"))

    def test_red_lines_in_every_persona(self):
        for pid in engine.PERSONAS:
            s = engine.persona_system(pid)
            self.assertIn("不做任何医疗诊断", s, pid)
            self.assertIn("不推荐任何保健品", s, pid)
            self.assertIn("绝不羞辱人格", s, pid)
            self.assertIn("禁止永远差评", s, pid)
            self.assertIn("偶尔放松≠虚度", s, pid)
            self.assertIn("waste_index", s, pid)

    def test_build_messages_user_fields(self):
        profile = dict(PROFILE, height=170, weight=65, sleep_start="23:30",
                       sleep_end="07:00", sleep_hours=7.5, chronic="无", exercise="每周跑步 2 次",
                       health_log=[{"date": "2026-11-05 08:00:00", "sleep_hours": 6.5,
                                    "steps": 3000, "exercise_minutes": 0}])
        record = {"activity": "连续刷短视频", "hours": 3, "feeling": "越刷越空虚"}
        system, user = engine.build_messages(record, profile, "salty", [])
        self.assertIn("【今天做了什么】连续刷短视频", user)
        self.assertIn("【耗时】3 小时", user)
        self.assertIn("【内心感受】越刷越空虚", user)
        self.assertIn("【生命档案】出生 1990-06-15", user)
        self.assertIn("BMI 22.5", user)
        self.assertIn("【作息】入睡 23:30", user)
        self.assertIn("【健康摘要】2026-11-05导入", user)
        self.assertIn("睡眠 6.5 小时", user)
        self.assertIn("步数 3000", user)
        self.assertIn("请直接输出判定 JSON", user)
        self.assertIn("只输出一个 JSON 对象", system)

    def test_build_messages_minimal_profile(self):
        _s, user = engine.build_messages({"activity": "x", "hours": 1}, {}, "mild", [])
        self.assertNotIn("生命档案", user)
        self.assertNotIn("健康摘要", user)

    def test_health_prompt(self):
        self.assertIn("华为运动健康", engine.HEALTH_PROMPT)
        self.assertIn("只输出纯 JSON", engine.HEALTH_PROMPT)


class TestScreenshot(unittest.TestCase):
    IMG = "data:image/jpeg;base64,AAAA"

    def test_has_image(self):
        self.assertFalse(engine.has_image({"thumb": ""}))
        self.assertFalse(engine.has_image({}))
        self.assertTrue(engine.has_image({"thumb": self.IMG}))

    def test_prompt_with_screenshot(self):
        record = {"activity": "刷手机", "hours": 2, "thumb": self.IMG}
        system, user = engine.build_messages(record, PROFILE, "salty", [])
        self.assertIn("截图判定补充规则", system)
        self.assertIn("以截图为准", system)
        self.assertIn("不要编造", system)
        self.assertIn("【附时光截图】", user)
        self.assertIn("不允许人身羞辱", system)

    def test_prompt_without_screenshot(self):
        record = {"activity": "刷手机", "hours": 2}
        system, user = engine.build_messages(record, PROFILE, "salty", [])
        self.assertNotIn("截图判定补充规则", system)
        self.assertNotIn("【附时光截图】", user)


if __name__ == "__main__":
    unittest.main(verbosity=2)
