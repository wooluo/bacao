#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拔草机 · 本地服务（Python 标准库，零依赖）

- 提供网页与 JSON API：工资设定、拔草过审（LLM 流式）、拔草台账、冷静期回访、月度战报
- 代理 LLM 判定（流式）：OpenAI/Anthropic 兼容服务（默认智谱 GLM）
- 数据保存在 data/ 目录（config.json、ledger.json）

用法：
    python3 app.py                # http://127.0.0.1:8772
    python3 app.py --host 0.0.0.0 # 局域网内手机也可访问
"""
import argparse
import json
import os
import random
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
import engine  # noqa: E402

DATA_DIR = os.environ.get("BACAO_DATA_DIR", os.path.join(BASE, "data"))
STATIC_DIR = os.path.join(BASE, "static")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
LEDGER_PATH = os.path.join(DATA_DIR, "ledger.json")
_LOCK = threading.RLock()

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
        ".png": "image/png", ".ico": "image/x-icon"}

DEFAULT_CONFIG = {
    "provider": "glm",
    "persona": "salty",  # mild=温和记账师 | salty=毒舌管家 | guardian=工资守护神
    "salary": {"monthly": 0, "days": 21.75, "hours_per_day": 8},
    "providers": {
        "glm": {
            "label": "GLM 智谱（Coding Plan）", "protocol": "openai",
            "base": "https://open.bigmodel.cn/api/coding/paas/v4", "model": "glm-5.3-flash",
            "vision_model": "glm-4.5v",  # 购物截图判定用（识图模型）
            "api_key": "", "fast": True,
        },
    },
}

# 过审截图缓存：judge 时暂存 AI 用大图（台账只持久化缩略图），verdict 后保留供重新过审
_IMAGE_CACHE = {}
_IMAGE_MAX_CHARS = 3_500_000   # dataURL base64 上限（约 2.5MB 原图）
_THUMB_MAX_CHARS = 80_000      # 缩略图上限


# ---------------------------------------------------------------- 存取工具

def _load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _save_json_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load_config():
    cfg = _load_json(CONFIG_PATH, {})
    if not isinstance(cfg, dict):
        cfg = {}
    out = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    out["provider"] = cfg.get("provider", out["provider"])
    out["persona"] = cfg.get("persona", out["persona"])
    salary = out["salary"]
    saved_salary = cfg.get("salary") or {}
    for k in ("monthly", "days", "hours_per_day"):
        try:
            v = float(saved_salary.get(k))
        except (TypeError, ValueError):
            continue
        if v >= 0:
            salary[k] = v
    for pid, p in (cfg.get("providers") or {}).items():
        if pid in out["providers"] and isinstance(p, dict):
            for k in ("label", "protocol", "base", "model", "vision_model"):
                if isinstance(p.get(k), str):
                    out["providers"][pid][k] = p[k]
            if isinstance(p.get("fast"), bool):
                out["providers"][pid]["fast"] = p["fast"]
            if isinstance(p.get("api_key"), str) and p["api_key"]:
                out["providers"][pid]["api_key"] = p["api_key"]
        elif isinstance(p, dict):  # 用户自定义的 provider
            out["providers"][pid] = {
                "label": p.get("label") or pid, "protocol": p.get("protocol") or "openai",
                "base": p.get("base") or "", "model": p.get("model") or "",
                "vision_model": p.get("vision_model") or "",
                "api_key": p.get("api_key") or "", "fast": bool(p.get("fast"))}
    if out["provider"] not in out["providers"]:
        out["provider"] = "glm"
    if out["persona"] not in engine.PERSONAS:
        out["persona"] = "salty"
    return out


def save_config(cfg):
    with _LOCK:
        _save_json_atomic(CONFIG_PATH, cfg)


def load_ledger():
    data = _load_json(LEDGER_PATH, [])
    return data if isinstance(data, list) else []


def save_ledger(ledger):
    _save_json_atomic(LEDGER_PATH, ledger)


def hourly_of(cfg):
    s = cfg.get("salary") or {}
    return engine.hourly_wage(s.get("monthly"), s.get("days"), s.get("hours_per_day"))


def config_public(cfg):
    """对外配置（Key 脱敏）+ 派生时薪。"""
    out = json.loads(json.dumps(cfg))
    for p in out["providers"].values():
        p["has_key"] = bool(p.get("api_key"))
        p["api_key"] = ""
    out["hourly"] = hourly_of(cfg)
    out["persona_info"] = engine.PERSONAS.get(out["persona"], engine.PERSONAS["salty"])
    return out


def record_summary(r):
    return {
        "id": r["id"], "created": r.get("created", ""),
        "item": r.get("item", ""), "price": r.get("price", 0),
        "verdict": r.get("verdict"), "confidence": r.get("confidence"),
        "outcome": r.get("outcome", "pending"), "outcome_at": r.get("outcome_at", ""),
        "cool_until": r.get("cool_until", ""), "parse_ok": r.get("parse_ok", False),
        "hours_cost": r.get("hours_cost", 0), "saved_amount": r.get("saved_amount") or 0,
        "dust_count": len(r.get("dust_used") or []),
        "has_image": bool(r.get("thumb")),
    }


# ---------------------------------------------------------------- LLM 上游

def _is_local_url(url):
    """本地/回环地址判断（这些地址必须绕过系统代理直连）。"""
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return False
    return host in ("localhost", "127.0.0.1", "::1", "0.0.0.0") or host.endswith(".local")


# 本地直连 opener（无视系统代理，否则 Clash 类代理会对 localhost 返回 502）
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def smart_urlopen(req, timeout):
    """本地地址直连，远程地址尊重环境/系统代理。"""
    if _is_local_url(req.full_url):
        return _DIRECT_OPENER.open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)


def fetch_models(pcfg, timeout=8):
    base = (pcfg.get("base") or "").rstrip("/")
    if not base:
        return []
    url = base + ("/v1/models" if pcfg.get("protocol") == "anthropic" else "/models")
    headers = {}
    key = pcfg.get("api_key") or ""
    if key:
        headers["Authorization"] = "Bearer " + key
        headers["x-api-key"] = key
    req = urllib.request.Request(url, headers=headers, method="GET")
    with smart_urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return [m.get("id") for m in data.get("data", [])
            if isinstance(m, dict) and m.get("id")]


# 自动选模型时排除非对话模型（embedding/OCR/语音等）
_NON_CHAT_MODEL = re.compile(r"embed|rerank|ocr|whisper|speech|tts|stt|audio|clip", re.I)


def resolve_model(pcfg):
    model = (pcfg.get("model") or "").strip()
    if model:
        return model
    try:
        models = fetch_models(pcfg)
    except Exception:
        models = []
    chat = [m for m in models if not _NON_CHAT_MODEL.search(m)]
    pool = chat or models
    return pool[0] if pool else ""


def _openai_content(user, images):
    """OpenAI 协议多模态 content：文本 + image_url（dataURL）。"""
    if not images:
        return user
    parts = []
    for url in images:
        parts.append({"type": "image_url", "image_url": {"url": url}})
    parts.append({"type": "text", "text": user})
    return parts


def _anthropic_content(user, images):
    """Anthropic 协议多模态 content blocks。"""
    if not images:
        return user
    blocks = []
    for url in images:
        m = re.match(r"^data:image/(\w+);base64,(.*)$", url, re.S)
        if not m:
            continue
        media = "jpeg" if m.group(1) in ("jpg", "jpeg") else m.group(1)
        blocks.append({"type": "image",
                       "source": {"type": "base64", "media_type": "image/" + media,
                                  "data": m.group(2)}})
    blocks.append({"type": "text", "text": user})
    return blocks


def open_upstream(pcfg, model, system, user, images=None):
    base = (pcfg.get("base") or "").rstrip("/")
    key = pcfg.get("api_key") or ""
    if pcfg.get("protocol") == "anthropic":
        url = base + "/v1/messages"
        headers = {"Content-Type": "application/json", "anthropic-version": "2023-06-01"}
        if key:
            headers["x-api-key"] = key
            headers["Authorization"] = "Bearer " + key
        payload = {"model": model, "max_tokens": 2048, "temperature": 0.7,
                   "system": system, "stream": True,
                   "messages": [{"role": "user", "content": _anthropic_content(user, images)}]}
    else:
        url = base + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = "Bearer " + key
        payload = {"model": model, "temperature": 0.7, "stream": True,
                   "messages": [{"role": "system", "content": system},
                                {"role": "user", "content": _openai_content(user, images)}]}
    # 快速模式：智谱系端点关闭深度思考，显著缩短等待（识图模型同样适用）
    if pcfg.get("fast") and re.search(r"(bigmodel|z\.ai)", base):
        payload["thinking"] = {"type": "disabled"}
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers=headers, method="POST")
    return smart_urlopen(req, timeout=600)


def _extract_full_text(obj):
    try:
        if "choices" in obj:
            return obj["choices"][0].get("message", {}).get("content") or ""
        if isinstance(obj.get("content"), list):
            return "".join(b.get("text", "") for b in obj["content"] if isinstance(b, dict))
    except Exception:
        pass
    return ""


def iter_deltas(resp):
    """把上游 SSE/JSON 响应解析成文本增量（兼容 OpenAI 与 Anthropic 两种事件格式）。"""
    ct = (resp.headers.get("content-type") or "").lower()
    if "event-stream" not in ct:
        yield _extract_full_text(json.loads(resp.read().decode("utf-8")))
        return
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            obj = json.loads(payload)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        choices = obj.get("choices")
        if isinstance(choices, list) and choices:
            delta = choices[0].get("delta") or {}
            text = delta.get("content")
            if text:
                yield text
            continue
        if obj.get("type") == "content_block_delta":
            text = (obj.get("delta") or {}).get("text")
            if text:
                yield text


# ---------------------------------------------------------------- 业务逻辑

def _valid_image(dataurl, max_chars):
    """校验图片 dataURL；合法返回 True。"""
    if not isinstance(dataurl, str) or not dataurl:
        return False
    if len(dataurl) > max_chars:
        return False
    return bool(re.match(r"^data:image/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$", dataurl))


def new_record(body, cfg, ledger):
    """过审申请 → 台账新记录（判定前）。校验失败抛 ValueError。"""
    item = str(body.get("item") or "").strip()
    if not item:
        raise ValueError("想买的东西不能为空")
    if len(item) > 40:
        raise ValueError("名称太长了（≤40 字）")
    try:
        price = round(float(body.get("price")), 2)
    except (TypeError, ValueError):
        raise ValueError("价格应为数字")
    if price <= 0 or price > 10 ** 7:
        raise ValueError("价格应在 0 ~ 1000 万之间")
    hourly = hourly_of(cfg)
    if hourly <= 0:
        raise ValueError("请先在设置里填写工资（月薪与工作天数），才能开始过审")
    persona = body.get("persona") or cfg.get("persona") or "salty"
    if persona not in engine.PERSONAS:
        persona = "salty"
    image = body.get("image")
    thumb = body.get("thumb") or ""
    if image is not None and not _valid_image(image, _IMAGE_MAX_CHARS):
        raise ValueError("截图格式不支持或过大（仅支持 png/jpg/webp，≤2.5MB）")
    if thumb and not _valid_image(thumb, _THUMB_MAX_CHARS):
        raise ValueError("缩略图数据异常")
    if image and not thumb:
        thumb = image  # 未提供缩略图时兜底（不推荐，仅避免截图无处展示）
    dust = engine.dust_lines(ledger, item)
    rid = datetime.now().strftime("%Y%m%d%H%M%S") + "-%04d" % random.randint(0, 9999)
    created = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return {
        "id": rid, "created": created,
        "item": item, "price": price,
        "why": str(body.get("why") or "").strip()[:200],
        "source": str(body.get("source") or "").strip()[:100],
        "persona": persona, "hourly": hourly,
        "hours_cost": engine.hours_for(price, hourly),
        "dust_used": [str(r.get("id") or "") for r in engine.dust_matches(ledger, item)],
        "verdict": None, "confidence": None,
        "reasons": [], "questions": [], "alternatives": [],
        "saved_amount": 0, "ai_text": "", "parse_ok": False,
        "outcome": "pending", "outcome_at": "", "cool_until": "",
        "thumb": thumb, "has_image": bool(thumb),
    }, dust


def apply_verdict(record, raw_text):
    """AI 原文 → 写入判定字段（失败降级：只存原文，verdict 留空）。"""
    record["ai_text"] = raw_text
    nv = engine.parse_verdict(raw_text, price=record.get("price"))
    if not nv:
        record["parse_ok"] = False
        return False
    record["parse_ok"] = True
    record["verdict"] = nv["verdict"]
    record["confidence"] = nv["confidence"]
    record["reasons"] = nv["reasons"]
    record["questions"] = nv["questions"]
    record["alternatives"] = nv["alternatives"]
    amount = nv["saved_amount"]
    if nv["verdict"] == "weed":
        record["saved_amount"] = amount if (amount and amount > 0) else record["price"]
    else:
        record["saved_amount"] = 0
    if nv["verdict"] == "cool":
        record["outcome"] = "cool_pending"
        record["cool_until"] = engine.cooling_until(record.get("created", ""))
    return True


# ---------------------------------------------------------------- HTTP Handler

class Handler(BaseHTTPRequestHandler):
    server_version = "BaCao/1.0"

    def log_message(self, fmt, *args):  # 静默常规访问日志
        pass

    # ---------- 基础工具 ----------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > 8 << 20:  # 上限 8MB（带截图的请求较大）；超限需排空，否则客户端断管
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1 << 20))
                if not chunk:
                    break
                remaining -= len(chunk)
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return {}

    def _send_file(self, path):
        ext = os.path.splitext(path)[1].lower()
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self._send_json({"error": "not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, rel):
        rel = rel.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self._send_json({"error": "not found"}, 404)
            return
        self._send_file(full)

    # ---------- 路由 ----------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            self._send_json(config_public(load_config()))
        elif path == "/api/ledger":
            with _LOCK:
                ledger = load_ledger()
            self._send_json({"records": [record_summary(r) for r in ledger],
                             "stats": engine.stats(ledger)})
        elif path.startswith("/api/ledger/"):
            rid = path.rsplit("/", 1)[-1]
            with _LOCK:
                r = next((x for x in load_ledger() if x.get("id") == rid), None)
            self._send_json({"record": r} if r else {"error": "记录不存在"}, 200 if r else 404)
        elif path == "/api/stats":
            with _LOCK:
                ledger = load_ledger()
            now = datetime.now()
            self._send_json({"stats": engine.stats(ledger, now=now),
                             "cooling_due": [record_summary(r) for r in engine.cooling_due(ledger, now)]})
        elif path == "/api/models":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            pid = (qs.get("provider") or [""])[0]
            cfg = load_config()
            pcfg = cfg["providers"].get(pid)
            if not pcfg:
                self._send_json({"error": "未知 provider"}, 400)
                return
            try:
                self._send_json({"models": fetch_models(pcfg)})
            except Exception as e:
                self._send_json({"error": "获取模型列表失败：%s" % e}, 502)
        elif path.startswith("/api/"):
            self._send_json({"error": "not found"}, 404)
        else:  # 静态资源（相对路径或 /static/ 均可，供网页与 APK 复用同一套前端）
            rel = path.lstrip("/")
            if not rel or rel == "index.html":
                self._send_file(os.path.join(STATIC_DIR, "index.html"))
            elif rel == "favicon.ico":
                self.send_response(204)
                self.end_headers()
            else:
                if rel.startswith("static/"):
                    rel = rel[len("static/"):]
                self._serve_static(rel)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            self._handle_config()
        elif path == "/api/judge":
            self._handle_judge()
        elif path == "/api/verdict":
            self._handle_verdict()
        elif path.startswith("/api/ledger/") and path.endswith("/outcome"):
            self._handle_outcome(path)
        elif path.startswith("/api/ledger/") and path.endswith("/verdict"):
            self._handle_manual_verdict(path)
        else:
            self._send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        m = re.match(r"^/api/ledger/([^/]+)$", path)
        if not m:
            self._send_json({"error": "not found"}, 404)
            return
        rid = m.group(1)
        with _LOCK:
            ledger = load_ledger()
            remain = [r for r in ledger if r.get("id") != rid]
            if len(remain) == len(ledger):
                self._send_json({"error": "记录不存在"}, 404)
                return
            save_ledger(remain)
        _IMAGE_CACHE.pop(rid, None)
        self._send_json({"ok": True})

    # ---------- 业务 ----------
    def _handle_config(self):
        body = self._read_json()
        with _LOCK:
            cfg = load_config()
            if body.get("provider") in cfg["providers"]:
                cfg["provider"] = body["provider"]
            if body.get("persona") in engine.PERSONAS:
                cfg["persona"] = body["persona"]
            salary = body.get("salary")
            if isinstance(salary, dict):
                for k in ("monthly", "days", "hours_per_day"):
                    try:
                        v = float(salary.get(k))
                    except (TypeError, ValueError):
                        continue
                    if v >= 0:
                        cfg["salary"][k] = v
            if hourly_of(cfg) <= 0 and cfg["salary"].get("monthly", 0) <= 0:
                pass  # 未设工资允许保存，但过审时会要求先设定
            for pid, p in (body.get("providers") or {}).items():
                if not isinstance(p, dict) or pid not in cfg["providers"]:
                    continue
                tgt = cfg["providers"][pid]
                for k in ("label", "protocol", "base", "model", "vision_model"):
                    if isinstance(p.get(k), str):
                        tgt[k] = p[k].strip()
                if p.get("protocol") not in ("openai", "anthropic"):
                    tgt["protocol"] = "openai"
                if isinstance(p.get("fast"), bool):
                    tgt["fast"] = p["fast"]
                key = p.get("api_key")
                if isinstance(key, str) and key.strip():
                    tgt["api_key"] = key.strip()
            save_config(cfg)
        self._send_json({"ok": True})

    def _handle_judge(self):
        body = self._read_json()
        cfg = load_config()
        try:
            with _LOCK:
                record, _dust = new_record(body, cfg, load_ledger())
        except ValueError as e:
            self._send_json({"error": str(e)}, 400)
            return
        if body.get("image"):
            _IMAGE_CACHE[record["id"]] = body["image"]  # AI 用大图只留在内存
        with _LOCK:
            ledger = load_ledger()
            ledger.insert(0, record)
            save_ledger(ledger)
        self._send_json({"record": record})

    def _handle_verdict(self):
        body = self._read_json()
        rid = body.get("id") or ""
        cfg = load_config()
        pid = body.get("provider") or cfg.get("provider")
        pcfg = cfg["providers"].get(pid)
        if not pcfg:
            self._send_json({"error": "未知 provider：%s" % pid}, 400)
            return
        with _LOCK:
            ledger = load_ledger()
            record = next((r for r in ledger if r.get("id") == rid), None)
            dust_lines = []
            if record:
                by_id = {r.get("id"): r for r in ledger}
                dust_lines = engine.dust_lines(ledger, record.get("item", ""))
                record["dust_used"] = [r.get("id") for r in engine.dust_matches(ledger, record.get("item", ""))]
        if not record:
            self._send_json({"error": "记录不存在"}, 404)
            return
        if record.get("verdict"):
            self._send_json({"error": "这条已经判过了，别重复过审"}, 400)
            return

        salary = hourly_of(cfg)
        image = _IMAGE_CACHE.get(rid)
        system, user = engine.build_messages(record, salary, record.get("persona") or cfg.get("persona"), dust_lines)
        # 附截图时用识图模型（vision_model），未配置则退回主模型
        model = resolve_model(pcfg)
        if image:
            vmodel = (pcfg.get("vision_model") or "").strip()
            if vmodel:
                model = vmodel
        if not model:
            self._send_json({"error": "未配置模型名，且无法从 %s 获取模型列表。请在设置里填写模型。"
                                      % pcfg.get("label", pid)}, 502)
            return
        try:
            resp = open_upstream(pcfg, model, system, user, images=[image] if image else None)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:400]
            except Exception:
                detail = ""
            self._send_json({"error": "上游返回 HTTP %d：%s" % (e.code, detail)}, 502)
            return
        except Exception as e:
            self._send_json({"error": "无法连接 %s：%s（请检查网络与接口地址）"
                                      % (pcfg.get("label", pid), e)}, 502)
            return

        # 上游 OK：开始向浏览器流式转发（HTTP/1.0 风格：无 Content-Length，关连接即结束）
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        chunks = []
        try:
            for delta in iter_deltas(resp):
                if not delta:
                    continue
                chunks.append(delta)
                self.wfile.write(delta.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器中断，保存已生成部分
        except Exception as e:
            tail = "\n\n[上游流中断：%s]" % e
            chunks.append(tail)
            try:
                self.wfile.write(tail.encode("utf-8"))
            except Exception:
                pass
        finally:
            try:
                resp.close()
            except Exception:
                pass
        raw = "".join(chunks)
        with _LOCK:
            ledger = load_ledger()
            target = next((r for r in ledger if r.get("id") == rid), None)
            if target is not None:
                apply_verdict(target, raw)
                save_ledger(ledger)

    def _handle_outcome(self, path):
        rid = path.split("/")[-2]
        body = self._read_json()
        outcome = body.get("outcome")
        with _LOCK:
            ledger = load_ledger()
            record = next((r for r in ledger if r.get("id") == rid), None)
            if not record:
                self._send_json({"error": "记录不存在"}, 404)
                return
            if not engine.mark_outcome(record, outcome):
                self._send_json({"error": "该判定档位不支持这个结果：%s" % outcome}, 400)
                return
            save_ledger(ledger)
        self._send_json({"ok": True, "record": record_summary(record)})

    def _handle_manual_verdict(self, path):
        rid = path.split("/")[-2]
        body = self._read_json()
        verdict = body.get("verdict")
        with _LOCK:
            ledger = load_ledger()
            record = next((r for r in ledger if r.get("id") == rid), None)
            if not record:
                self._send_json({"error": "记录不存在"}, 404)
                return
            if not engine.manual_verdict(record, verdict):
                self._send_json({"error": "判定档位不合法：%s" % verdict}, 400)
                return
            save_ledger(ledger)
        self._send_json({"ok": True, "record": record_summary(record)})


# ---------------------------------------------------------------- 入口

def main():
    ap = argparse.ArgumentParser(description="拔草机 本地服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8772)
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_PATH):
        save_config(json.loads(json.dumps(DEFAULT_CONFIG)))
    if not os.path.exists(LEDGER_PATH):
        save_ledger([])

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print("拔草机 服务已启动")
    print("  本机访问:  http://127.0.0.1:%d" % args.port)
    if args.host not in ("127.0.0.1", "localhost"):
        print("  局域网访问: http://<本机IP>:%d （手机同 Wi-Fi 可用）" % args.port)
    print("  数据目录:  %s" % DATA_DIR)
    print("按 Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
