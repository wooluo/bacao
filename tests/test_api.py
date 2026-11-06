# -*- coding: utf-8 -*-
"""API 集成测试：静态页 / 工资设定 / 过审全链路（stub LLM 流式）/
台账落账与统计 / 冷静期回访 / 手动归档 / 代理直连回归。

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
os.environ["BACAO_DATA_DIR"] = tempfile.mkdtemp(prefix="bacao-test-")
sys.path.insert(0, BASE_DIR)

import app as appmod  # noqa: E402
import engine  # noqa: E402

WEED_VERDICT = {
    "verdict": "weed", "confidence": 78,
    "reasons": [{"text": "吃灰概率极高", "sting": 5}, {"text": "时薪不配", "sting": 3}],
    "questions": [], "alternatives": [], "saved_amount": 899,
}
COOL_VERDICT = {
    "verdict": "cool", "confidence": 55,
    "reasons": [], "questions": ["一个月后还想要吗？", "家里有替代品吗？"],
    "alternatives": [], "saved_amount": 0,
}
PASS_VERDICT = {
    "verdict": "pass", "confidence": 25, "reasons": [{"text": "刚需", "sting": 1}],
    "questions": [], "alternatives": ["等 618", "看二手"], "saved_amount": 0,
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
            text = "这东西吧……我觉得你还是再想想，我说不清。反正别买。"
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

    def expect_404(self, method, path, body=None):
        try:
            self.request(method, path, body)
            self.fail("应当返回 404：%s" % path)
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 404)

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
        self.assertIn("工资拔草机", html)
        js = self.request("GET", "/static/app.js")
        self.assertIn("startVerdict", js)
        eng = self.request("GET", "/static/engine.js")
        self.assertIn("parseVerdict", eng)

    def test_02_judge_requires_salary(self):
        self.expect_400("POST", "/api/judge", {"item": "键盘", "price": 899})

    def test_03_config_salary_and_privacy(self):
        out = self.post_json("/api/config", {
            "salary": {"monthly": 9600, "days": 20, "hours_per_day": 8},
            "persona": "guardian",
        })
        self.assertTrue(out["ok"])
        cfg = self.get_json("/api/config")
        self.assertEqual(cfg["hourly"], 60.0)  # 9600 / (20*8)
        self.assertEqual(cfg["persona"], "guardian")
        self.assertIn("persona_info", cfg)
        # Key 脱敏
        self.assertEqual(cfg["providers"]["glm"]["api_key"], "")
        self.assertIsInstance(cfg["providers"]["glm"]["has_key"], bool)

    def test_04_judge_bad_request(self):
        self.expect_400("POST", "/api/judge", {"item": "", "price": 10})
        self.expect_400("POST", "/api/judge", {"item": "键盘", "price": 0})
        self.expect_400("POST", "/api/judge", {"item": "键盘", "price": "abc"})
        self.expect_400("POST", "/api/judge", {"item": "x" * 41, "price": 10})

    def test_05_full_weed_chain(self):
        out = self.post_json("/api/judge", {"item": "机械键盘", "price": 899, "why": "打字爽", "source": "直播间"})
        rec = out["record"]
        self.assertEqual(rec["verdict"], None)
        self.assertEqual(rec["outcome"], "pending")
        self.assertAlmostEqual(rec["hourly"], 60.0)
        self.assertEqual(rec["hours_cost"], 15.0)  # 899/60
        raw = self.request("POST", "/api/verdict", {"id": rec["id"]})
        self.assertIn("机械键盘", StubLLM.last_request["messages"][1]["content"])
        self.assertIn("打字爽", StubLLM.last_request["messages"][1]["content"])
        # 提示词带人格语气与安全红线
        sysmsg = StubLLM.last_request["messages"][0]["content"]
        self.assertIn("辜负这个月", sysmsg)  # guardian
        self.assertIn("禁止推荐任何借贷", sysmsg)
        self.assertIn("¥60/小时", StubLLM.last_request["messages"][1]["content"])
        one = self.get_json("/api/ledger/" + rec["id"])["record"]
        self.assertEqual(one["verdict"], "weed")
        self.assertEqual(one["confidence"], 78)
        self.assertEqual(len(one["reasons"]), 2)
        self.assertEqual(one["saved_amount"], 899)
        self.assertTrue(one["parse_ok"])
        self.assertEqual(one["ai_text"], raw)  # 流式原文完整保存
        # 重复判定拒绝
        self.expect_400("POST", "/api/verdict", {"id": rec["id"]})
        TestAPI.weed_id = rec["id"]

    def test_06_full_cool_chain_and_stats(self):
        # 先 weed + 听劝 → 守住
        self.post_json("/api/ledger/%s/outcome" % TestAPI.weed_id, {"outcome": "kept"})
        st = self.get_json("/api/stats")["stats"]
        self.assertEqual(st["month_saved"], 899)
        self.assertEqual(st["success_rate"], 100.0)
        # 再来一单 cool：围栏 JSON → 进冷静清单
        StubLLM.push(COOL_VERDICT, "fence")
        rec = self.post_json("/api/judge", {"item": "泡脚桶", "price": 399})["record"]
        self.request("POST", "/api/verdict", {"id": rec["id"]})
        one = self.get_json("/api/ledger/" + rec["id"])["record"]
        self.assertEqual(one["verdict"], "cool")
        self.assertEqual(one["outcome"], "cool_pending")
        self.assertEqual(one["cool_until"], engine.cooling_until(one["created"]))
        self.assertEqual(len(one["questions"]), 2)
        self.assertEqual(one["saved_amount"], 0)
        # 守住金额不变（cool 不计）
        st = self.get_json("/api/stats")["stats"]
        self.assertEqual(st["month_saved"], 899)
        self.assertEqual(st["cool_pending"], 1)
        # 72h 未到 → 不出现在回访列表
        self.assertEqual(self.get_json("/api/stats")["cooling_due"], [])
        # 注入时间偏移（回溯 73h）→ 出现在回访列表
        from datetime import datetime, timedelta
        created = datetime(2026, 11, 1, 10, 0, 0)
        self.backdate(rec["id"], created.strftime("%Y-%m-%d %H:%M:%S"),
                      (created + timedelta(hours=72)).strftime("%Y-%m-%d %H:%M:%S"))
        due = self.get_json("/api/stats")["cooling_due"]
        self.assertEqual([d["id"] for d in due], [rec["id"]])
        # 回访回填：买了 → 吃灰名单
        self.post_json("/api/ledger/%s/outcome" % rec["id"], {"outcome": "cool_bought"})
        st = self.get_json("/api/stats")["stats"]
        self.assertEqual(st["dust_count"], 1)
        self.assertEqual(st["dust_amount"], 399)
        TestAPI.dust_id = rec["id"]

    def test_07_pass_chain_and_manual_verdict(self):
        StubLLM.push(PASS_VERDICT, "raw")
        rec = self.post_json("/api/judge", {"item": "丁香结", "price": 59})["record"]
        self.request("POST", "/api/verdict", {"id": rec["id"]})
        one = self.get_json("/api/ledger/" + rec["id"])["record"]
        self.assertEqual(one["verdict"], "pass")
        self.assertEqual(len(one["alternatives"]), 2)
        self.post_json("/api/ledger/%s/outcome" % rec["id"], {"outcome": "pass_bought"})
        # 解析失败 → 手动归档
        StubLLM.push({"fake": 1}, "bad")
        rec2 = self.post_json("/api/judge", {"item": "香薰", "price": 129})["record"]
        self.request("POST", "/api/verdict", {"id": rec2["id"]})
        one2 = self.get_json("/api/ledger/" + rec2["id"])["record"]
        self.assertEqual(one2["verdict"], None)
        self.assertFalse(one2["parse_ok"])
        self.assertIn("再想想", one2["ai_text"])  # 原文降级保存
        self.expect_400("POST", "/api/ledger/%s/verdict" % rec2["id"], {"verdict": "垃圾"})
        self.post_json("/api/ledger/%s/verdict" % rec2["id"], {"verdict": "weed"})
        one2 = self.get_json("/api/ledger/" + rec2["id"])["record"]
        self.assertEqual(one2["verdict"], "weed")
        self.assertTrue(one2["manual"])
        self.assertEqual(one2["saved_amount"], 129)
        # 非法 outcome
        self.expect_400("POST", "/api/ledger/%s/outcome" % rec2["id"], {"outcome": "cool_bought"})

    def test_08_dust_context_injection(self):
        # 之前 cool_bought 了泡脚桶 → 再买同类时提示词必须翻旧账
        StubLLM.push(COOL_VERDICT, "fence")
        rec = self.post_json("/api/judge", {"item": "足浴泡脚桶旗舰款", "price": 499})["record"]
        self.request("POST", "/api/verdict", {"id": rec["id"]})
        user = StubLLM.last_request["messages"][1]["content"]
        self.assertIn("翻旧账", user)
        self.assertIn("泡脚桶", user)
        self.assertIn("吃灰至今", user)
        one = self.get_json("/api/ledger/" + rec["id"])["record"]
        self.assertEqual(len(one["dust_used"]), 1)
        self.request("DELETE", "/api/ledger/" + rec["id"])

    def test_09_models_and_bad_verdict_404(self):
        out = self.get_json("/api/models?provider=glm")
        self.assertEqual(out["models"][0], "stub-model")
        self.expect_400("GET", "/api/models?provider=nope")
        self.expect_404("POST", "/api/verdict", {"id": "not-exist"})

    def test_10_ledger_delete_and_404(self):
        self.expect_404("DELETE", "/api/ledger/not-exist")

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
