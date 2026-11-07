# -*- coding: utf-8 -*-
"""API 集成测试：静态页 / 生命档案 / 健康截图导入（stub 多模态）/ 时光录入全链路
（stub LLM 流式）/ 台账落账与统计 / 72h 复盘回访 / 手动归档 / 黑名单翻旧账 /
代理直连回归。

内置一个 stub LLM（OpenAI 兼容 SSE），验证 /api/judge → /api/verdict →
台账结构化落账（JSON 健壮解析）→ /api/stats 全链路。

运行：python3 -m unittest tests.test_api -v
"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["LIFE_WASTER_DATA_DIR"] = tempfile.mkdtemp(prefix="lifewaster-test-")
sys.path.insert(0, BASE_DIR)

import app as appmod  # noqa: E402
import engine  # noqa: E402

WEED_VERDICT = {
    "verdict": "waste", "confidence": 78, "waste_index": 78,
    "reasons": [{"content": "无意义刷短视频，没有成长收益", "sting_level": 5},
                {"content": "纯消磨", "sting_level": 3}],
    "questions": [], "alternatives": ["用这段时间看书/运动"],
    "life_change": -2, "save_time": 3,
}
NORMAL_VERDICT = {
    "verdict": "normal", "confidence": 55, "waste_index": 55,
    "reasons": [], "questions": ["这件事长期能带来成长吗？", "只是单纯消磨时间吗？"],
    "alternatives": [], "life_change": 0, "save_time": 0,
}
VALUABLE_VERDICT = {
    "verdict": "valuable", "confidence": 25, "waste_index": 20,
    "reasons": [{"content": "规律运动，延养寿命", "sting_level": 1}],
    "questions": [], "alternatives": [], "life_change": 1, "save_time": 0,
}
HEALTH_JSON = {
    "sleep_hours": 6.5, "sleep_start": "01:10", "sleep_end": "07:40",
    "steps": 3210, "exercise_minutes": 0, "weight": 66.2, "heart_rate": 74,
}


class StubLLM(BaseHTTPRequestHandler):
    last_request = None
    # 队列：按次弹出返回内容（None 则用默认 weed）
    queue = []

    def log_message(self, *a):
        pass

    @classmethod
    def push(cls, obj, style="fence"):
        cls.queue.append((obj, style))

    @classmethod
    def pop(cls):
        return cls.queue.pop(0) if cls.queue else (None, None)

    @classmethod
    def last_user_text(cls):
        """最后请求的 user 文本（兼容多模态 content 数组）。"""
        c = cls.last_request["messages"][1]["content"]
        if isinstance(c, str):
            return c
        return "".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")

    def do_POST(self):  # chat/completions (SSE)
        length = int(self.headers.get("Content-Length") or 0)
        StubLLM.last_request = json.loads(self.rfile.read(length))
        obj, style = self.pop()
        if obj is None:
            obj, style = WEED_VERDICT, "fence"
        if style == "fence":
            text = "好的，我的判定如下：\n```json\n" + json.dumps(obj, ensure_ascii=False) + "\n```\n请冷静。"
        elif style == "raw":
            text = json.dumps(obj, ensure_ascii=False)
        else:  # bad：无法解析
            text = "这段时光吧……我觉得你还是再想想，我说不清。反正少刷点。"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for piece in [text[:40], text[40:80], text[80:]]:
            if not piece:
                continue
            chunk = {"choices": [{"delta": {"content": piece}}]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def do_GET(self):  # /models
        body = json.dumps({"data": [{"id": "stub-model"}, {"id": "stub-mini"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class TestAPI(unittest.TestCase):
    srv = None
    stub = None
    base = None

    @classmethod
    def setUpClass(cls):
        cls.stub = ThreadingHTTPServer(("127.0.0.1", 0), StubLLM)
        threading.Thread(target=cls.stub.serve_forever, daemon=True).start()
        stub_port = cls.stub.server_address[1]

        cfg = json.loads(json.dumps(appmod.DEFAULT_CONFIG))
        cfg["providers"]["glm"]["base"] = "http://127.0.0.1:%d/v1" % stub_port
        cfg["providers"]["glm"]["model"] = ""  # 留空 → 从 /models 自动取第一个
        appmod.save_config(cfg)

        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), appmod.Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.stub.shutdown()

    # ---------- 工具 ----------
    def request(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, data=data, timeout=15) as resp:
            return resp.read().decode()

    def post_json(self, path, body):
        return json.loads(self.request("POST", path, body))

    def get_json(self, path):
        return json.loads(self.request("GET", path))

    def expect_400(self, method, path, body=None):
        try:
            self.request(method, path, body)
            self.fail("应当返回 400：%s" % path)
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)

    def expect_status(self, method, path, body, code):
        try:
            self.request(method, path, body)
            self.fail("应当返回 %d：%s" % (code, path))
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, code)

    def backdate(self, rid, created, cool_until=None):
        """直接改台账文件注入时间偏移。"""
        with appmod._LOCK:
            ledger = appmod.load_ledger()
            for r in ledger:
                if r["id"] == rid:
                    r["created"] = created
                    if cool_until is not None:
                        r["cool_until"] = cool_until
            appmod.save_ledger(ledger)

    # ---------- 用例 ----------
    def test_01_static(self):
        html = self.request("GET", "/")
        self.assertIn("人生虚度记录仪", html)
        js = self.request("GET", "/static/app.js")
        self.assertIn("startVerdict", js)
        eng = self.request("GET", "/static/engine.js")
        self.assertIn("parseVerdict", eng)

    def test_02_profile_flow(self):
        # 未建档案：life 未就绪
        p = self.get_json("/api/profile")
        self.assertFalse(p["life"]["ready"])
        # 建档案（含非法值：应被忽略/钳制）
        out = self.post_json("/api/profile", {
            "birth_date": "1990-06-15", "expectancy": 80,
            "height": 170, "weight": 65,
            "sleep_start": "23:30", "sleep_end": "07:00", "sleep_hours": 7.5,
            "chronic": "无", "exercise": "每周跑步 2 次",
            "expectancy_bad": 999,
        })
        self.assertTrue(out["ok"])
        p = self.get_json("/api/profile")
        self.assertTrue(p["life"]["ready"])
        self.assertEqual(p["bmi"], 22.5)
        self.assertGreater(p["life"]["remain_days"], 0)
        self.assertEqual(p["life"]["expectancy_years"], 80)
        # 非法出生日期被忽略、寿命越界被忽略
        self.post_json("/api/profile", {"birth_date": "1990-13-99", "expectancy": 500})
        p = self.get_json("/api/profile")
        self.assertEqual(p["birth_date"], "1990-06-15")
        self.assertEqual(p["expectancy"], 80)
        self.assertEqual(p["chronic"], "无")
        TestAPI.profile_id = p

    def test_03_config_persona_and_privacy(self):
        out = self.post_json("/api/config", {"persona": "guardian"})
        self.assertTrue(out["ok"])
        cfg = self.get_json("/api/config")
        self.assertEqual(cfg["persona"], "guardian")
        self.assertIn("persona_info", cfg)
        # Key 脱敏
        self.assertEqual(cfg["providers"]["glm"]["api_key"], "")
        self.assertIsInstance(cfg["providers"]["glm"]["has_key"], bool)

    def test_04_judge_bad_request(self):
        self.expect_400("POST", "/api/judge", {"activity": "", "hours": 1})
        self.expect_400("POST", "/api/judge", {"activity": "刷手机", "hours": 0})
        self.expect_400("POST", "/api/judge", {"activity": "刷手机", "hours": 25})
        self.expect_400("POST", "/api/judge", {"activity": "刷手机", "hours": "abc"})
        self.expect_400("POST", "/api/judge", {"activity": "x" * 81, "hours": 1})

    def test_05_full_waste_chain(self):
        out = self.post_json("/api/judge", {"activity": "连续刷短视频 3 小时", "hours": 3,
                                            "feeling": "越刷越空虚"})
        rec = out["record"]
        self.assertEqual(rec["verdict"], None)
        self.assertEqual(rec["outcome"], "pending")
        self.assertEqual(rec["hours"], 3)
        raw = self.request("POST", "/api/verdict", {"id": rec["id"]})
        self.assertIn("连续刷短视频 3 小时", StubLLM.last_request["messages"][1]["content"])
        self.assertIn("越刷越空虚", StubLLM.last_request["messages"][1]["content"])
        # 提示词带人格语气与合规红线
        sysmsg = StubLLM.last_request["messages"][0]["content"]
        self.assertIn("消耗本就不多的余生", sysmsg)  # guardian
        self.assertIn("不做任何医疗诊断", sysmsg)
        self.assertIn("【生命档案】出生 1990-06-15", StubLLM.last_user_text())
        one = self.get_json("/api/ledger/" + rec["id"])["record"]
        self.assertEqual(one["verdict"], "waste")
        self.assertEqual(one["confidence"], 78)
        self.assertEqual(one["waste_index"], 78)
        self.assertEqual(len(one["reasons"]), 2)
        self.assertEqual(one["life_change"], -2)
        self.assertEqual(one["save_time"], 3)
        self.assertTrue(one["parse_ok"])
        self.assertEqual(one["ai_text"], raw)  # 流式原文完整保存
        # 重复判定拒绝
        self.expect_400("POST", "/api/verdict", {"id": rec["id"]})
        # waste 判定待用户确认：pending 不计虚度
        st = self.get_json("/api/stats")["stats"]
        self.assertEqual(st["total_wasted"], 0)
        self.assertEqual(st["waste_total"], 1)
        # 确认虚度 → 计入虚度时长 + 进黑名单
        self.post_json("/api/ledger/%s/outcome" % rec["id"], {"outcome": "confirmed"})
        st = self.get_json("/api/stats")["stats"]
        self.assertEqual(st["total_wasted"], 3)
        self.assertEqual(st["month_wasted"], 3)
        self.assertEqual(st["blacklist_count"], 1)
        self.assertEqual(st["total_save_time"], 3)
        TestAPI.weed_id = rec["id"]

    def test_06_normal_chain_and_stats(self):
        # waste not_waste 回流有效时光
        self.post_json("/api/ledger/%s/outcome" % TestAPI.weed_id, {"outcome": "not_waste"})
        st = self.get_json("/api/stats")["stats"]
        self.assertEqual(st["total_wasted"], 0)
        self.assertEqual(st["total_value"], 3)
        self.assertEqual(st["blacklist_count"], 0)
        # 再确认回来，供后续用例
        self.post_json("/api/ledger/%s/outcome" % TestAPI.weed_id, {"outcome": "confirmed"})
        # normal：围栏 JSON → 进复盘冷静期
        StubLLM.push(NORMAL_VERDICT, "fence")
        rec = self.post_json("/api/judge", {"activity": "通宵打手游", "hours": 4})["record"]
        self.request("POST", "/api/verdict", {"id": rec["id"]})
        one = self.get_json("/api/ledger/" + rec["id"])["record"]
        self.assertEqual(one["verdict"], "normal")
        self.assertEqual(one["outcome"], "review_pending")
        self.assertEqual(one["cool_until"], engine.cooling_until(one["created"]))
        self.assertEqual(len(one["questions"]), 2)
        # pending 不计入虚度
        st = self.get_json("/api/stats")["stats"]
        self.assertEqual(st["normal_reviewing"], 1)
        self.assertEqual(self.get_json("/api/stats")["cooling_due"], [])
        # 注入时间偏移（回溯 73h）→ 出现在回访列表
        from datetime import datetime, timedelta
        created = datetime(2026, 11, 1, 10, 0, 0)
        self.backdate(rec["id"], created.strftime("%Y-%m-%d %H:%M:%S"),
                      (created + timedelta(hours=72)).strftime("%Y-%m-%d %H:%M:%S"))
        due = self.get_json("/api/stats")["cooling_due"]
        self.assertEqual([d["id"] for d in due], [rec["id"]])
        # 回访回填：确实虚度 → 计入虚度 + 黑名单
        self.post_json("/api/ledger/%s/outcome" % rec["id"], {"outcome": "review_waste"})
        st = self.get_json("/api/stats")["stats"]
        self.assertEqual(st["total_wasted"], 7)  # 3 + 4
        self.assertEqual(st["blacklist_count"], 2)
        TestAPI.normal_id = rec["id"]

    def test_07_valuable_chain_and_manual_verdict(self):
        StubLLM.push(VALUABLE_VERDICT, "raw")
        rec = self.post_json("/api/judge", {"activity": "跑步 5 公里", "hours": 1,
                                            "feeling": "神清气爽"})["record"]
        self.request("POST", "/api/verdict", {"id": rec["id"]})
        one = self.get_json("/api/ledger/" + rec["id"])["record"]
        self.assertEqual(one["verdict"], "valuable")
        self.assertEqual(one["outcome"], "highlight")  # 自动入高光时刻
        self.assertNotEqual(one["outcome_at"], "")
        st = self.get_json("/api/stats")["stats"]
        self.assertEqual(st["valuable_total"], 1)
        self.assertEqual(st["total_value"], 1)  # 仅这条高光 1h（not_waste 已回改为 confirmed）
        # 解析失败 → 手动归档
        StubLLM.push({"fake": 1}, "bad")
        rec2 = self.post_json("/api/judge", {"activity": "躺床上发呆", "hours": 2})["record"]
        self.request("POST", "/api/verdict", {"id": rec2["id"]})
        one2 = self.get_json("/api/ledger/" + rec2["id"])["record"]
        self.assertEqual(one2["verdict"], None)
        self.assertFalse(one2["parse_ok"])
        self.assertIn("少刷点", one2["ai_text"])  # 原文降级保存
        self.expect_400("POST", "/api/ledger/%s/verdict" % rec2["id"], {"verdict": "垃圾"})
        self.post_json("/api/ledger/%s/verdict" % rec2["id"], {"verdict": "normal"})
        one2 = self.get_json("/api/ledger/" + rec2["id"])["record"]
        self.assertEqual(one2["verdict"], "normal")
        self.assertTrue(one2["manual"])
        self.assertEqual(one2["waste_index"], 50)
        self.assertEqual(one2["outcome"], "review_pending")
        # 非法 outcome
        self.expect_400("POST", "/api/ledger/%s/outcome" % rec2["id"], {"outcome": "confirmed"})
        self.request("DELETE", "/api/ledger/" + rec2["id"])
        self.request("DELETE", "/api/ledger/" + rec["id"])

    def test_08_blacklist_context_injection(self):
        # 之前 confirmed 了「连续刷短视频」→ 同类行为提示词必须翻旧账
        StubLLM.push(NORMAL_VERDICT, "fence")
        rec = self.post_json("/api/judge", {"activity": "无聊又刷短视频打发时间", "hours": 1.5})["record"]
        self.assertEqual(len(rec["blacklist_used"]), 1)
        self.request("POST", "/api/verdict", {"id": rec["id"]})
        user = StubLLM.last_request["messages"][1]["content"]
        self.assertIn("翻旧账", user)
        self.assertIn("刷短视频", user)
        self.assertIn("拉高虚度评分", user)
        self.request("DELETE", "/api/ledger/" + rec["id"])

    def test_09_models_and_bad_verdict_404(self):
        out = self.get_json("/api/models?provider=glm")
        self.assertEqual(out["models"][0], "stub-model")
        self.expect_400("GET", "/api/models?provider=nope")
        try:
            self.request("POST", "/api/verdict", {"id": "not-exist"})
            self.fail("应当返回 404")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 404)

    def test_10_ledger_delete_and_404(self):
        try:
            self.request("DELETE", "/api/ledger/not-exist")
            self.fail("应当返回 404")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 404)

    def test_11_proxy_bypass_local(self):
        # 回归：系统/环境代理存在时，本地地址必须直连（修复 Clash 等代理导致 localhost 502）
        bogus = "http://127.0.0.1:9"  # 无人监听的代理端口
        saved = {k: os.environ.get(k) for k in
                 ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY")}
        try:
            for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
                os.environ[k] = bogus
            models = appmod.fetch_models(
                {"base": "http://127.0.0.1:%d/v1" % self.stub.server_address[1],
                 "protocol": "openai"})
            self.assertEqual(models[0], "stub-model")
            self.assertTrue(appmod._is_local_url("http://localhost:1234/v1"))
            self.assertFalse(appmod._is_local_url("https://open.bigmodel.cn/api/paas/v4"))
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_12_resolve_model_skips_embedding(self):
        orig = appmod.fetch_models
        appmod.fetch_models = lambda p, timeout=8: [
            "text-embedding-nomic-embed-text-v1.5", "glm-5.3"]
        try:
            self.assertEqual(
                appmod.resolve_model({"model": "", "base": "x", "protocol": "openai"}),
                "glm-5.3")
            self.assertEqual(appmod.resolve_model({"model": "手选模型"}), "手选模型")
        finally:
            appmod.fetch_models = orig

    def test_13_screenshot_multimodal_chain(self):
        # 配置识图模型 → 带截图过审 → 上游收到 content 数组 + 识图模型
        self.post_json("/api/config", {"providers": {"glm": {"vision_model": "stub-vision"}}})
        img = "data:image/jpeg;base64," + "A" * 200
        thumb = "data:image/jpeg;base64," + "B" * 40
        rec = self.post_json("/api/judge",
                             {"activity": "游戏五连败后继续肝", "hours": 3, "image": img, "thumb": thumb})["record"]
        self.assertTrue(rec["has_image"])
        self.assertEqual(rec["thumb"], thumb)
        self.assertNotIn("image", rec, "对外返回的记录不应携带 AI 用大图")
        StubLLM.push(VALUABLE_VERDICT, "raw")
        self.request("POST", "/api/verdict", {"id": rec["id"]})
        body = StubLLM.last_request
        self.assertEqual(body["model"], "stub-vision", "带截图应切换到识图模型")
        content = body["messages"][1]["content"]
        self.assertIsInstance(content, list)
        img_parts = [p for p in content if p.get("type") == "image_url"]
        self.assertEqual(len(img_parts), 1)
        self.assertEqual(img_parts[0]["image_url"]["url"], img)
        text = StubLLM.last_user_text()
        self.assertIn("【附时光截图】", text)
        self.assertIn("游戏五连败后继续肝", text)
        self.assertIn("截图判定补充规则", body["messages"][0]["content"])
        # 台账只持久化缩略图，大图不落盘
        with open(appmod.LEDGER_PATH, encoding="utf-8") as f:
            raw_ledger = f.read()
        self.assertNotIn(img[:80], raw_ledger, "AI 用大图不能写进台账文件")
        self.assertIn(thumb[:40], raw_ledger)
        one = self.get_json("/api/ledger/" + rec["id"])["record"]
        self.assertEqual(one["verdict"], "valuable")
        # 摘要带 has_image
        summary = next(x for x in self.get_json("/api/ledger")["records"] if x["id"] == rec["id"])
        self.assertTrue(summary["has_image"])
        self.request("DELETE", "/api/ledger/" + rec["id"])
        self.assertNotIn(rec["id"], appmod._IMAGE_CACHE, "删除后应清理截图缓存")

    def test_14_screenshot_validation(self):
        self.expect_400("POST", "/api/judge",
                        {"activity": "x", "hours": 1, "image": "data:text/html;base64,AAAA"})
        self.expect_400("POST", "/api/judge",
                        {"activity": "x", "hours": 1, "image": "data:image/jpeg;base64," + "A" * 4000000})
        self.expect_400("POST", "/api/judge",
                        {"activity": "x", "hours": 1, "thumb": "not-a-dataurl"})

    def test_15_health_import_chain(self):
        # 华为运动健康截图 → 识图模型 → 健康 JSON → 自动回填档案
        img = "data:image/jpeg;base64," + "C" * 200
        thumb = "data:image/jpeg;base64," + "D" * 40
        StubLLM.push(HEALTH_JSON, "raw")
        out = self.post_json("/api/health/import", {"image": img, "thumb": thumb})
        self.assertTrue(out["ok"])
        h = out["health"]
        self.assertEqual(h["sleep_hours"], 6.5)
        self.assertEqual(h["sleep_start"], "01:10")
        self.assertEqual(h["steps"], 3210)
        self.assertIn("date", h)
        body = StubLLM.last_request
        self.assertEqual(body["model"], "stub-vision", "健康识别应走识图模型")
        self.assertIn("华为运动健康", body["messages"][0]["content"])
        self.assertIsInstance(body["messages"][1]["content"], list)
        # 档案自动回填 + 缩略图落盘、大图不落盘
        p = self.get_json("/api/profile")
        self.assertEqual(p["health_log"][0]["sleep_hours"], 6.5)
        self.assertEqual(p["health_log"][0]["thumb"], thumb)
        self.assertIn("导入", p["health_summary"])
        with open(appmod.PROFILE_PATH, encoding="utf-8") as f:
            raw_profile = f.read()
        self.assertNotIn(img[:80], raw_profile, "AI 用大图不能写进档案文件")
        self.assertIn(thumb[:40], raw_profile)
        # 识别失败 → 422（原文降级返回，不崩溃）
        StubLLM.push({"fake": 1}, "bad")
        self.expect_status("POST", "/api/health/import", {"image": img}, 422)
        # 非法图片 → 400
        self.expect_400("POST", "/api/health/import", {"image": "data:text/html;base64,AA"})

    def test_16_verdict_without_image_keeps_text_content(self):
        # 无截图时 user content 必须仍是纯字符串（兼容非多模态上游）
        rec = self.post_json("/api/judge", {"activity": "普通刷手机", "hours": 0.5})["record"]
        self.request("POST", "/api/verdict", {"id": rec["id"]})
        self.assertIsInstance(StubLLM.last_request["messages"][1]["content"], str)
        self.assertNotIn("截图判定补充规则", StubLLM.last_request["messages"][0]["content"])
        self.request("DELETE", "/api/ledger/" + rec["id"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
