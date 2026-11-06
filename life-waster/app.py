#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""人生虚度记录仪 · 本地服务（Python 标准库，零依赖）

- 提供网页与 JSON API：生命档案、健康截图导入、时光录入（LLM 流式判定）、
  时光台账、72 小时复盘回访、月度光阴战报
- 代理 LLM 判定（流式）：OpenAI/Anthropic 兼容服务（默认智谱 GLM，glm-5.3-flash 原生多模态）
- 数据保存在 data/ 目录（config.json、profile.json、ledger.json），纯本地隐私存储

用法：
    python3 app.py                # http://127.0.0.1:8774
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

DATA_DIR = os.environ.get("LIFE_WASTER_DATA_DIR", os.path.join(BASE, "data"))
STATIC_DIR = os.path.join(BASE, "static")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
PROFILE_PATH = os.path.join(DATA_DIR, "profile.json")
LEDGER_PATH = os.path.join(DATA_DIR, "ledger.json")
_LOCK = threading.RLock()

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
        ".png": "image/png", ".ico": "image/x-icon"}

DEFAULT_CONFIG = {
    "provider": "glm",
    "persona": "salty",  # mild=温和史官 | salty=毒舌光阴质检员 | guardian=余生守望者
    "providers": {
        "glm": {
            "label": "GLM 智谱（Coding Plan）", "protocol": "openai",
            "base": "https://open.bigmodel.cn/api/coding/paas/v4", "model": "glm-5.3-flash",
            "vision_model": "glm-5.3-flash",  # 原生多模态：截图/照片识别（缺省回退主模型）
            "api_key": "", "fast": True,
        },
    },
}

DEFAULT_PROFILE = {
    "birth_date": "",        # YYYY-MM-DD
    "expectancy": 80,        # 预期寿命（岁）
    "height": 0,             # cm
    "weight": 0,             # kg
    "chronic": "",           # 慢性疾病/既往病史
    "sleep_start": "",       # 入睡 HH:MM
    "sleep_end": "",         # 起床 HH:MM
    "sleep_hours": 0,        # 日均睡眠时长（小时）
    "diet": "",              # 三餐/饮食习惯
    "smoke": "",             # 烟
    "drink": "",             # 酒
    "exercise": "",          # 运动频率
    "health_log": [],        # 健康截图导入记录（新的在前）
}
HEALTH_LOG_MAX = 60

# 判定/识别图片缓存：请求时暂存 AI 用大图（台账只持久化缩略图），判定后保留供重新过审
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


def load_profile():
    data = _load_json(PROFILE_PATH, {})
    if not isinstance(data, dict):
        data = {}
    out = json.loads(json.dumps(DEFAULT_PROFILE))
    for k in out:
        if k == "health_log":
            continue
        if k in data and data[k] is not None:
            out[k] = data[k]
    log = data.get("health_log")
    out["health_log"] = [h for h in log if isinstance(h, dict)][:HEALTH_LOG_MAX] \
        if isinstance(log, list) else []
    return out


def save_profile(profile):
    with _LOCK:
        _save_json_atomic(PROFILE_PATH, profile)


def load_ledger():
    data = _load_json(LEDGER_PATH, [])
    return data if isinstance(data, list) else []


def save_ledger(ledger):
    _save_json_atomic(LEDGER_PATH, ledger)


def profile_public(profile, ledger=None):
    """对外档案（含派生生命统计与 BMI）。"""
    out = json.loads(json.dumps(profile))
    out["bmi"] = engine.bmi(profile.get("height"), profile.get("weight"))
    out["life"] = engine.life_stats(profile, ledger)
    out["health_summary"] = engine.health_summary(profile)
    return out


def config_public(cfg):
    """对外配置（Key 脱敏）。"""
    out = json.loads(json.dumps(cfg))
    for p in out["providers"].values():
        p["has_key"] = bool(p.get("api_key"))
        p["api_key"] = ""
    out["persona_info"] = engine.PERSONAS.get(out["persona"], engine.PERSONAS["salty"])
    return out


def record_summary(r):
    return {
        "id": r["id"], "created": r.get("created", ""),
        "activity": r.get("activity", ""), "hours": r.get("hours", 0),
        "feeling": r.get("feeling", ""),
        "verdict": r.get("verdict"), "confidence": r.get("confidence"),
        "waste_index": r.get("waste_index"),
        "life_change": r.get("life_change", 0),
        "outcome": r.get("outcome", "pending"), "outcome_at": r.get("outcome_at", ""),
        "cool_until": r.get("cool_until", ""), "parse_ok": r.get("parse_ok", False),
        "save_time": r.get("save_time", 0),
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
_NON_CHAT_MODEL = re.compile(r"embed|rerank|whisper|speech|tts|stt|audio|clip", re.I)


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


def collect_upstream(pcfg, model, system, user, images=None):
    """整段收集上游输出（健康截图识别等小请求内部复用流式框架）。返回 (text, error)。"""
    try:
        resp = open_upstream(pcfg, model, system, user, images=images)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:400]
        except Exception:
            detail = ""
        return "", "上游返回 HTTP %d：%s" % (e.code, detail)
    except Exception as e:
        return "", "无法连接上游：%s（请检查网络与接口地址）" % e
    chunks = []
    try:
        for delta in iter_deltas(resp):
            if delta:
                chunks.append(delta)
    except Exception as e:
        return "".join(chunks), "上游流中断：%s" % e
    finally:
        try:
            resp.close()
        except Exception:
            pass
    return "".join(chunks), ""


# ---------------------------------------------------------------- 业务逻辑

def _valid_image(dataurl, max_chars):
    """校验图片 dataURL；合法返回 True。"""
    if not isinstance(dataurl, str) or not dataurl:
        return False
    if len(dataurl) > max_chars:
        return False
    return bool(re.match(r"^data:image/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$", dataurl))


def new_record(body, cfg, ledger, profile):
    """时光录入 → 台账新记录（判定前）。校验失败抛 ValueError。"""
    activity = str(body.get("activity") or "").strip()
    if not activity:
        raise ValueError("今天做了什么不能为空")
    if len(activity) > 80:
        raise ValueError("行为描述太长了（≤80 字）")
    try:
        hours = round(float(body.get("hours")), 2)
    except (TypeError, ValueError):
        raise ValueError("耗时应为数字（小时）")
    if hours <= 0 or hours > 24:
        raise ValueError("耗时应大于 0 且不超过 24 小时")
    persona = body.get("persona") or cfg.get("persona") or "salty"
    if persona not in engine.PERSONAS:
        persona = "salty"
    image = body.get("image")
    thumb = body.get("thumb") or ""
    if image is not None and not _valid_image(image, _IMAGE_MAX_CHARS):
        raise ValueError("图片格式不支持或过大（仅支持 png/jpg/webp，≤2.5MB）")
    if thumb and not _valid_image(thumb, _THUMB_MAX_CHARS):
        raise ValueError("缩略图数据异常")
    if image and not thumb:
        thumb = image  # 未提供缩略图时兜底（不推荐，仅避免图片无处展示）
    blacklist = engine.blacklist_matches(ledger, activity)
    rid = datetime.now().strftime("%Y%m%d%H%M%S") + "-%04d" % random.randint(0, 9999)
    created = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return {
        "id": rid, "created": created,
        "activity": activity, "hours": hours,
        "feeling": str(body.get("feeling") or "").strip()[:300],
        "persona": persona,
        "blacklist_used": [str(r.get("id") or "") for r in blacklist],
        "verdict": None, "confidence": None, "waste_index": None,
        "reasons": [], "questions": [], "alternatives": [],
        "life_change": 0, "save_time": 0,
        "ai_text": "", "parse_ok": False,
        "outcome": "pending", "outcome_at": "", "cool_until": "",
        "thumb": thumb, "has_image": bool(thumb),
    }


def apply_verdict(record, raw_text):
    """AI 原文 → 写入判定字段（失败降级：只存原文，verdict 留空）。"""
    record["ai_text"] = raw_text
    nv = engine.parse_verdict(raw_text)
    if not nv:
        record["parse_ok"] = False
        return False
    record["parse_ok"] = True
    record["verdict"] = nv["verdict"]
    record["confidence"] = nv["confidence"]
    record["waste_index"] = nv["waste_index"]
    record["reasons"] = nv["reasons"]
    record["questions"] = nv["questions"]
    record["alternatives"] = nv["alternatives"]
    record["life_change"] = nv["life_change"]
    record["save_time"] = nv["save_time"] if nv["verdict"] == "waste" else 0
    if nv["verdict"] == "normal":
        record["outcome"] = "review_pending"
        record["cool_until"] = engine.cooling_until(record.get("created", ""))
    elif nv["verdict"] == "valuable":
        record["outcome"] = "highlight"
        record["outcome_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return True


def sanitize_health_entry(entry):
    """健康导入条目清洗（仅保留规范字段）。"""
    clean = engine.normalize_health(entry or {})
    if clean is None:
        return None
    clean["date"] = str((entry or {}).get("date") or datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    thumb = (entry or {}).get("thumb") or ""
    if thumb and _valid_image(thumb, _THUMB_MAX_CHARS):
        clean["thumb"] = thumb
    return clean


def apply_profile_patch(profile, body):
    """档案字段校验合并（就地修改）。非法值忽略。"""
    def _num(key, lo, hi, digits=0):
        v = body.get(key)
        if isinstance(v, bool) or v is None or v == "":
            return
        try:
            x = float(v)
        except (TypeError, ValueError):
            return
        if lo <= x <= hi:
            profile[key] = round(x, digits) if digits else x

    bd = str(body.get("birth_date") or "").strip()
    if bd == "" or engine._parse_birth(bd):
        profile["birth_date"] = bd[:10]
    _num("expectancy", 40, 120)
    _num("height", 50, 250)
    _num("weight", 20, 400, 1)
    _num("sleep_hours", 0, 16, 1)
    for key in ("sleep_start", "sleep_end"):
        val = str(body.get(key) or "").strip()
        m = re.match(r"^([01]?\d|2[0-3]):([0-5]\d)$", val)
        if val == "" or m:
            profile[key] = val if m else ""
            if m and len(m.group(1)) == 1:
                profile[key] = "0" + profile[key]
    for key in ("chronic", "diet", "smoke", "drink", "exercise"):
        if key in body:
            profile[key] = str(body.get(key) or "").strip()[:60]
    if isinstance(body.get("health_log"), list):
        entries = []
        for e in body["health_log"][:HEALTH_LOG_MAX]:
            clean = sanitize_health_entry(e)
            if clean:
                entries.append(clean)
        profile["health_log"] = entries


# ---------------------------------------------------------------- HTTP Handler

class Handler(BaseHTTPRequestHandler):
    server_version = "LifeWaster/1.0"

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
        elif path == "/api/profile":
            with _LOCK:
                self._send_json(profile_public(load_profile(), load_ledger()))
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
                profile = load_profile()
            now = datetime.now()
            self._send_json({"stats": engine.stats(ledger, now=now),
                             "life": engine.life_stats(profile, ledger, now=now),
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
        elif path == "/api/profile":
            self._handle_profile()
        elif path == "/api/health/import":
            self._handle_health_import()
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

    def _handle_profile(self):
        body = self._read_json()
        with _LOCK:
            profile = load_profile()
            apply_profile_patch(profile, body)
            save_profile(profile)
        self._send_json({"ok": True, "profile": profile_public(profile, load_ledger())})

    def _handle_health_import(self):
        """华为运动健康截图 → glm-5.3-flash 多模态识别 → 自动回填健康档案。"""
        body = self._read_json()
        image = body.get("image") or ""
        if not _valid_image(image, _IMAGE_MAX_CHARS):
            self._send_json({"error": "截图格式不支持或过大（仅支持 png/jpg/webp，≤2.5MB）"}, 400)
            return
        cfg = load_config()
        pcfg = cfg["providers"].get(body.get("provider") or cfg.get("provider"))
        if not pcfg:
            self._send_json({"error": "未知 provider"}, 400)
            return
        model = (pcfg.get("vision_model") or "").strip() or resolve_model(pcfg)
        if not model:
            self._send_json({"error": "未配置模型名，且无法从服务获取模型列表。请在设置里填写模型。"}, 502)
            return
        raw, err = collect_upstream(pcfg, model, engine.HEALTH_PROMPT,
                                    "识别这张截图里的运动健康数据，按约定输出 JSON。", images=[image])
        if err and not raw:
            self._send_json({"error": err}, 502)
            return
        health = engine.parse_health(raw)
        if not health:
            self._send_json({"error": "未能从截图识别出健康数据", "raw": raw[:400]}, 422)
            return
        health["date"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        thumb = body.get("thumb") or ""
        if thumb and _valid_image(thumb, _THUMB_MAX_CHARS):
            health["thumb"] = thumb
        with _LOCK:
            profile = load_profile()
            profile["health_log"].insert(0, health)
            del profile["health_log"][HEALTH_LOG_MAX:]
            save_profile(profile)
        self._send_json({"ok": True, "health": health,
                         "profile": profile_public(profile, load_ledger())})

    def _handle_judge(self):
        body = self._read_json()
        cfg = load_config()
        try:
            with _LOCK:
                record = new_record(body, cfg, load_ledger(), load_profile())
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
            profile = load_profile()
            record = next((r for r in ledger if r.get("id") == rid), None)
            blacklist_lines = []
            if record:
                blacklist_lines = engine.blacklist_lines(ledger, record.get("activity", ""))
                record["blacklist_used"] = [r.get("id") for r in engine.blacklist_matches(ledger, record.get("activity", ""))]
        if not record:
            self._send_json({"error": "记录不存在"}, 404)
            return
        if record.get("verdict"):
            self._send_json({"error": "这条已经判过了，别重复过审"}, 400)
            return

        image = _IMAGE_CACHE.get(rid)
        system, user = engine.build_messages(record, profile,
                                             record.get("persona") or cfg.get("persona"),
                                             blacklist_lines)
        # 附图片时用识图模型（vision_model），未配置则退回主模型（glm-5.3-flash 原生多模态）
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
    ap = argparse.ArgumentParser(description="人生虚度记录仪 本地服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8774)
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_PATH):
        save_config(json.loads(json.dumps(DEFAULT_CONFIG)))
    if not os.path.exists(PROFILE_PATH):
        save_profile(json.loads(json.dumps(DEFAULT_PROFILE)))
    if not os.path.exists(LEDGER_PATH):
        save_ledger([])

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print("人生虚度记录仪 服务已启动")
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
