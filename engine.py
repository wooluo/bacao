# -*- coding: utf-8 -*-
"""拔草机 · 核心引擎（纯逻辑，零依赖）

时薪换算 / 判定 JSON 健壮解析（含流式增量解析）/ 台账统计聚合 /
72 小时冷静期 / 吃灰翻旧账上下文 / 毒舌人格提示词构建。

app.py（服务器模式）与本目录 static/engine.js（离线 App 模式）保持同构。
"""
import json
import re
from datetime import datetime

# ---------------------------------------------------------------- 常量

VERDICTS = ("weed", "cool", "pass")
VERDICT_LABELS = {
    "weed": {"emoji": "🚫", "label": "拔草", "stamp": "不予批准"},
    "cool": {"emoji": "😐", "label": "冷静", "stamp": "暂缓批准"},
    "pass": {"emoji": "✅", "label": "放行", "stamp": "准予购买"},
}
# 判定档位 → 允许标记的结果（kept=听劝没买 / bought=还是买了）
ALLOWED_OUTCOMES = {
    "weed": ("kept", "bought"),
    "cool": ("cool_didnt_buy", "cool_bought"),
    "pass": ("pass_bought",),
}
OUTCOME_LABELS = {
    "pending": "待定", "kept": "听劝没买 ✓", "bought": "还是买了（吃灰）",
    "cool_pending": "冷静期中", "cool_didnt_buy": "72h 后没买 ✓", "cool_bought": "冷静期后还是买了",
    "pass_bought": "已购入",
}
DUST_OUTCOMES = ("bought", "cool_bought")  # 记入吃灰名单的结果
COOLING_HOURS = 72

PERSONAS = {
    "mild": {"emoji": "🧧", "label": "温和记账师", "desc": "温柔讲道理，账算得明明白白"},
    "salty": {"emoji": "😈", "label": "毒舌管家", "desc": "阴阳怪气但幽默，毒舌对物不对人"},
    "guardian": {"emoji": "🛡️", "label": "工资守护神", "desc": "庄严悲壮，工资是本月流血流汗的军费"},
}

_PERSONA_TONE = {
    "mild": "语气规范：温柔耐心，像一位替你管账的可靠朋友。多用「咱们」「你看」，把账算清楚、道理讲透，"
            "委婉但不含糊；不阴阳怪气，不嘲讽，让用户感到被心疼而不是被说教。",
    "salty": "语气规范：阴阳怪气但幽默的老管家，反讽、夸张比喻、损人利弊皆可，"
             "但毒舌只对这件东西和商家话术，绝对不允许人身羞辱——不攻击用户的外貌、收入、能力、智商；"
             "刻薄要有分寸，好笑不伤人。",
    "guardian": "语气规范：庄严悲壮的守护者。工资是这个月流血流汗换来的军费，每一分都不容辜负。"
                "多用庄重的句式与悲壮的排比，例如「你又要辜负这个月的自己了吗」；凝重而非嘲讽，"
                "让用户在肃穆中冷静下来。",
}

_SYSTEM_LOGIC = """你是「拔草机」里的抠门管家。用户每次想买东西，都要先来你这里「过审」。你的职责：给这笔消费一个真实、有据的判定，帮用户冷静。

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
- saved_amount：weed 时=这件东西的价格数字；其他档位填 0"""

# ---------------------------------------------------------------- 时薪换算

def hourly_wage(monthly, days=21.75, hours_per_day=8.0):
    """月薪 → 时薪（保留 2 位）。输入非法返回 0。"""
    try:
        monthly, days, hpd = float(monthly), float(days), float(hours_per_day)
    except (TypeError, ValueError):
        return 0.0
    if monthly <= 0 or days <= 0 or hpd <= 0:
        return 0.0
    return round(monthly / (days * hpd), 2)


def hours_for(price, hourly):
    """价格折算成生命小时数。"""
    try:
        price, hourly = float(price), float(hourly)
    except (TypeError, ValueError):
        return 0.0
    if hourly <= 0 or price <= 0:
        return 0.0
    return round(price / hourly, 1)


def _fmt_num(x):
    s = ("%.1f" % x)
    return s[:-2] if s.endswith(".0") else s


def hours_text(price, hourly):
    """「¥899 ≈ 你 37.5 小时的班（约 4.7 个工作日）」；换算不了返回空串。"""
    h = hours_for(price, hourly)
    if h <= 0:
        return ""
    if h < 1:
        return "不到 1 小时的班"
    days = round(h / 8.0, 1)
    extra = "（约 %s 个工作日）" % _fmt_num(days) if days >= 1 else ""
    return "%s 小时的班%s" % (_fmt_num(h), extra)


# ---------------------------------------------------------------- 判定 JSON 解析

_VERDICT_SYNONYMS = {
    "weed": "weed", "cool": "cool", "pass": "pass",
    "reject": "weed", "stop": "weed", "nobuy": "weed", "no": "weed", "拔草": "weed",
    "别买": "weed", "不予批准": "weed",
    "think": "cool", "wait": "cool", "再想想": "cool", "冷静": "cool", "暂缓": "cool", "暂缓批准": "cool",
    "buy": "pass", "ok": "pass", "yes": "pass", "approve": "pass", "放行": "pass",
    "可以买": "pass", "准予购买": "pass",
}


def strip_fence(text):
    """去掉 ```json ... ``` 围栏（大小写/语言标记均可）。"""
    s = str(text or "").strip()
    s = re.sub(r"^```[A-Za-z0-9_-]*[ \t]*\r?\n?", "", s)
    s = re.sub(r"\r?\n?[ \t]*```\s*$", "", s)
    return s.strip()


def _extract_object(text):
    """从混杂文本中截出第一个平衡的 {...}（字符串感知）。未闭合则截到末尾。"""
    start = text.find("{")
    if start < 0:
        return ""
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return text[start:]


def _repair_json(s):
    """常见小病修复：全角引号/逗号冒号、尾逗号、中文冒号。"""
    s = s.replace("\u201c", '"').replace("\u201d", '"').replace("\u2018", '"').replace("\u2019", '"')
    s = s.replace("\uff1a", ":").replace("\uff0c", ",")
    s = re.sub(r",\s*([}\]])", r"\1", s)  # 尾逗号
    return s


def _norm_verdict(v):
    if not isinstance(v, str):
        return None
    return _VERDICT_SYNONYMS.get(v.strip().lower())


def _norm_confidence(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        x = v
    elif isinstance(v, str):
        m = re.search(r"\d{1,3}", v)
        if not m:
            return None
        x = float(m.group())
    else:
        return None
    return int(min(100, max(0, round(x))))


def _norm_sting(v):
    try:
        if isinstance(v, bool):
            return 3
        x = float(v)
    except (TypeError, ValueError):
        return 3
    return int(min(5, max(1, round(x))))


def _norm_str_list(v):
    if not isinstance(v, list):
        return []
    out = []
    for x in v:
        if isinstance(x, str) and x.strip():
            out.append(x.strip())
        elif isinstance(x, dict) and isinstance(x.get("text"), str) and x["text"].strip():
            out.append(x["text"].strip())
        elif isinstance(x, (int, float)):
            out.append(str(x))
    return out


def _norm_reasons(v):
    if not isinstance(v, list):
        return []
    out = []
    for x in v:
        if isinstance(x, str) and x.strip():
            out.append({"text": x.strip(), "sting": 3})
        elif isinstance(x, dict):
            text = x.get("text") or x.get("reason") or x.get("content") or ""
            if isinstance(text, str) and text.strip():
                out.append({"text": text.strip(), "sting": _norm_sting(x.get("sting"))})
    return out


def _norm_amount(v):
    if isinstance(v, bool):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if x != x or x in (float("inf"), float("-inf")) or x < 0:  # NaN/inf/负数
        return None
    return round(x, 2)


def normalize_verdict(obj, require_verdict=True):
    """原始 dict → 规范判定 dict；verdict 无法识别时返回 None（require_verdict=False 供流式增量解析）。"""
    if not isinstance(obj, dict):
        return None
    verdict = _norm_verdict(obj.get("verdict"))
    if require_verdict and not verdict:
        return None
    return {
        "verdict": verdict,
        "confidence": _norm_confidence(obj.get("confidence")),
        "reasons": _norm_reasons(obj.get("reasons")),
        "questions": _norm_str_list(obj.get("questions")),
        "alternatives": _norm_str_list(obj.get("alternatives")),
        "saved_amount": _norm_amount(obj.get("saved_amount")),
    }


def parse_verdict(raw, price=None):
    """AI 原始输出 → 规范判定 dict；彻底解析失败返回 None（前端降级 Markdown 原文）。"""
    s = _extract_object(strip_fence(raw))
    if not s:
        return None
    candidates = [s, _repair_json(s)]
    for cand in candidates:
        try:
            obj = json.loads(cand)
        except ValueError:
            continue
        nv = normalize_verdict(obj)
        if nv:
            if nv["verdict"] == "weed" and nv["saved_amount"] is None and price is not None:
                nv["saved_amount"] = round(float(price), 2)
            return nv
    return None


def _autoclose(s):
    """按扫描状态补全括号/引号，返回可能合法的 JSON 前缀；修不好返回 None。"""
    stack, in_str, esc = [], False, False
    for ch in s:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
    cut = s
    if in_str:
        cut += '"'
    cut = cut.rstrip()
    cut = re.sub(r"[,:]\s*$", "", cut)          # 悬空的冒号/逗号
    cut = re.sub(r",\s*(?=[}\]])", "", cut)      # 尾逗号
    closer = {"{": "}", "[": "]"}

    def closer_of(c):
        return closer.get(c, "")

    out = cut + "".join(closer_of(c) for c in reversed(stack))
    try:
        json.loads(out)
        return out
    except ValueError:
        return None


def parse_partial(raw):
    """流式增量解析：从半截 JSON 里提取已完整/可推断的字段（理由逐条流式渲染用）。

    返回与 normalize_verdict 相同结构的 dict；一个字段都提不出来时返回 None。
    """
    s = _extract_object(strip_fence(raw))
    if not s:
        return None
    for back in range(0, 12):  # 从头逐渐向回截，避免半截 token 卡死
        end = len(s) - back
        if end <= 1:
            break
        cand = _autoclose(s[:end])
        if cand is None:
            continue
        try:
            obj = json.loads(cand)
        except ValueError:
            continue
        nv = normalize_verdict(obj, require_verdict=False)
        if nv is None:
            continue
        if nv["verdict"] or nv["reasons"] or nv["questions"] or nv["alternatives"] or nv["confidence"] is not None:
            return nv
        return None  # 已能合法解析但一个字段都还没有：等到下个增量再试
    return None


# ---------------------------------------------------------------- 台账统计

def _price_of(r):
    try:
        p = float(r.get("price") or 0)
    except (TypeError, ValueError):
        return 0.0
    return p if p > 0 else 0.0


def stats(ledger, now=None):
    """台账聚合。守住金额只计：verdict==weed 且 outcome==kept（听劝没买）。

    monthly: 按月战报（守住金额、拔草率、吃灰率、最贵的拔草/放行）。
    """
    now = now or datetime.now()
    month_key = now.strftime("%Y-%m")
    st = {
        "month": month_key,
        "month_saved": 0.0, "month_kept_count": 0,
        "total_saved": 0.0, "total_kept_count": 0,
        "weed_total": 0, "weed_kept": 0, "weed_bought": 0,
        "cool_total": 0, "cool_didnt_buy": 0, "cool_bought": 0, "cool_pending": 0,
        "pass_total": 0, "pass_bought": 0,
        "dust_count": 0, "dust_amount": 0.0,
        "judged_total": 0, "resolved": 0, "persuaded": 0,
        "success_rate": 0.0, "dust_rate": 0.0,
        "monthly": {},
    }
    for r in ledger:
        v, o = r.get("verdict"), r.get("outcome")
        price = _price_of(r)
        created = str(r.get("created") or "")
        mk = created[:7]
        m = st["monthly"].setdefault(mk, {
            "month": mk, "judged": 0, "saved": 0.0, "kept_count": 0,
            "resolved": 0, "persuaded": 0, "dust": 0, "dust_amount": 0.0,
            "max_weed": None, "max_pass": None,
        })
        if v not in VERDICTS:
            continue  # 未判定 / 解析失败的记录不进统计
        st["judged_total"] += 1
        m["judged"] += 1
        if v == "weed":
            st["weed_total"] += 1
            if o == "kept":
                st["weed_kept"] += 1
                st["total_kept_count"] += 1
                st["total_saved"] += price
                m["kept_count"] += 1
                m["saved"] += price
                if created.startswith(month_key):
                    st["month_kept_count"] += 1
                    st["month_saved"] += price
            elif o == "bought":
                st["weed_bought"] += 1
        elif v == "cool":
            st["cool_total"] += 1
            if o == "cool_didnt_buy":
                st["cool_didnt_buy"] += 1
            elif o == "cool_bought":
                st["cool_bought"] += 1
            elif o == "cool_pending":
                st["cool_pending"] += 1
        elif v == "pass":
            st["pass_total"] += 1
            if o == "pass_bought":
                st["pass_bought"] += 1
        if o in DUST_OUTCOMES:
            st["dust_count"] += 1
            st["dust_amount"] += price
            m["dust"] += 1
            m["dust_amount"] += price
        # 月度最贵拔草 / 放行
        if v == "weed" and (m["max_weed"] is None or price > _price_of(m["max_weed"])):
            m["max_weed"] = {"item": r.get("item"), "price": price}
        if v == "pass" and (m["max_pass"] is None or price > _price_of(m["max_pass"])):
            m["max_pass"] = {"item": r.get("item"), "price": price}
        # 拔草成功率：已出结果的（weed kept/bought + cool 没买/买了）中被劝退比例
        if v == "weed" and o in ("kept", "bought") or v == "cool" and o in ("cool_didnt_buy", "cool_bought"):
            st["resolved"] += 1
            m["resolved"] += 1
            if o in ("kept", "cool_didnt_buy"):
                st["persuaded"] += 1
                m["persuaded"] += 1
    st["total_saved"] = round(st["total_saved"], 2)
    st["month_saved"] = round(st["month_saved"], 2)
    st["dust_amount"] = round(st["dust_amount"], 2)
    st["success_rate"] = round(st["persuaded"] / st["resolved"] * 100, 1) if st["resolved"] else 0.0
    st["dust_rate"] = round(st["dust_count"] / st["resolved"] * 100, 1) if st["resolved"] else 0.0
    for mk in st["monthly"]:
        m = st["monthly"][mk]
        m["saved"] = round(m["saved"], 2)
        m["dust_amount"] = round(m["dust_amount"], 2)
        m["weed_rate"] = round(m["persuaded"] / m["resolved"] * 100, 1) if m["resolved"] else 0.0
        m["dust_rate"] = round(m["dust"] / m["resolved"] * 100, 1) if m["resolved"] else 0.0
    st["monthly"] = [st["monthly"][k] for k in sorted(st["monthly"], reverse=True)]
    return st


def cooling_due(ledger, now=None):
    """冷静期到点待回访：verdict==cool 且 outcome==cool_pending 且 72h 已过。"""
    now = now or datetime.now()
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    out = []
    for r in ledger:
        if r.get("verdict") == "cool" and r.get("outcome") == "cool_pending":
            until = str(r.get("cool_until") or "")
            if until and until <= now_str:
                out.append(r)
    out.sort(key=lambda r: r.get("cool_until") or "")
    return out


def cooling_until(created, now=None):
    """冷静期截止时间字符串（created + 72h）。"""
    now = now or datetime.now()
    try:
        t = datetime.strptime(created, "%Y-%m-%d %H:%M:%S") if created else now
    except ValueError:
        t = now
    from datetime import timedelta
    return (t + timedelta(hours=COOLING_HOURS)).strftime("%Y-%m-%d %H:%M:%S")


def mark_outcome(record, outcome):
    """校验并写入结果标记；非法返回 False。"""
    v = record.get("verdict")
    if v not in ALLOWED_OUTCOMES or outcome not in ALLOWED_OUTCOMES[v]:
        return False
    record["outcome"] = outcome
    record["outcome_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return True


def manual_verdict(record, verdict):
    """AI 输出解析失败时的手动归档：只定档不定结果。"""
    if verdict not in VERDICTS:
        return False
    record["verdict"] = verdict
    record["parse_ok"] = True
    record["manual"] = True
    if verdict == "weed":
        record["saved_amount"] = _price_of(record)
    else:
        record["saved_amount"] = 0
    if verdict == "cool":
        record["outcome"] = "cool_pending"
        record["cool_until"] = record.get("cool_until") or cooling_until(record.get("created", ""))
    return True


# ---------------------------------------------------------------- 吃灰翻旧账

def _norm_name(s):
    return re.sub(r"[\s\-—_·、，。！？!?.,()（）\[\]【】]+", "", str(s or "")).lower()


def _bigrams(s):
    s = _norm_name(s)
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def dust_matches(ledger, item, limit=3):
    """吃灰名单里与想买东西「同类」的记录（名字 bigram 相似度>0），新的在前。"""
    grams = _bigrams(item)
    if not grams:
        return []
    scored = []
    for r in ledger:
        if r.get("outcome") not in DUST_OUTCOMES:
            continue
        other = _bigrams(r.get("item"))
        overlap = len(grams & other)
        if overlap > 0:
            scored.append((overlap, str(r.get("created") or ""), r))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [r for _, _, r in scored[:limit]]


def dust_lines(ledger, item, limit=3):
    """翻旧账上下文文本行，注入提示词：你买过 XX（¥Y，日期），吃灰至今。"""
    lines = []
    for r in dust_matches(ledger, item, limit):
        verdict = VERDICT_LABELS.get(r.get("verdict"), {}).get("label", "?")
        lines.append("你买过「%s」（¥%s，%s 判定为%s后还是买了），吃灰至今" % (
            r.get("item"), _fmt_num(_price_of(r)), str(r.get("created") or "")[:10], verdict))
    return lines


# ---------------------------------------------------------------- 提示词构建

_SYSTEM_SCREENSHOT = """

截图判定补充规则：
- 用户可能附上购物页/直播间/购物车/订单截图。请先从截图提取关键信息：商品名、标价与到手价、优惠方式（满减/券/限时倒计时/限量 N 件/已售 N 件/直播间氛围），再套用上面的判定逻辑。
- 把截图里的商家话术当作判定取材重点：倒计时与「仅剩 X 件」是稀缺话术，划线原价是锚定价话术，「已售 10 万+」是从众话术——逐条拆解。
- 截图与用户填写的信息冲突时（如价格不一致），以截图为准，并在理由中明确点出这个矛盾。
- 若截图模糊或关键信息（价格）不可见，在理由中如实说明「截图未见价格」，不要编造。"""

_USER_SCREENSHOT_NOTE = "【附购物截图】已随本单提交。请先读取截图里的商品名、价格与优惠话术再判定；截图与上面填写的信息冲突时以截图为准。"


def has_image(record):
    """记录是否附带购物截图。"""
    return bool(record.get("thumb")) if isinstance(record, dict) else False


def persona_system(persona_id, screenshot=False):
    tone = _PERSONA_TONE.get(persona_id) or _PERSONA_TONE["salty"]
    return _SYSTEM_LOGIC + (_SYSTEM_SCREENSHOT if screenshot else "") + "\n\n" + tone


def build_messages(record, salary, persona_id, dust=None):
    """判定提示词：(system, user)。salary 为时薪数字，dust 为翻旧账文本行。"""
    hourly = float(salary or 0)
    price = _price_of(record)
    h_text = hours_text(price, hourly)
    img = has_image(record)
    parts = ["【想买的东西】%s" % record.get("item", ""),
             "【价格】¥%s" % _fmt_num(price)]
    why = str(record.get("why") or "").strip()
    src = str(record.get("source") or "").strip()
    parts.append("【为什么想买】%s" % (why or "（未说明）"))
    parts.append("【在哪看到的】%s" % (src or "（未说明）"))
    if hourly > 0:
        parts.append("【你的时薪】¥%s/小时" % ("%.2f" % hourly).rstrip("0").rstrip("."))
        if h_text:
            parts.append("【这笔钱相当于】%s" % h_text)
    if dust:
        parts.append("【历史吃灰提醒·翻旧账】\n" + "\n".join("- " + d for d in dust))
    if img:
        parts.append(_USER_SCREENSHOT_NOTE)
    parts.append("请直接输出判定 JSON。")
    return persona_system(persona_id, img), "\n".join(parts)
