# -*- coding: utf-8 -*-
"""人生虚度记录仪 · 核心引擎（纯逻辑，零依赖）

生命换算（出生日期→已活/剩余/BMI）/ 虚度判定 JSON 健壮解析（含流式增量解析）/
台账统计聚合（虚度时长只计确认虚度）/ 72 小时复盘冷静期 / 虚度黑名单翻旧账 /
健康截图 JSON 解析 / 三档人格提示词构建。

app.py（服务器模式）与本目录 static/engine.js（离线 App 模式）保持同构。
"""
import json
import re
from datetime import datetime, timedelta

# ---------------------------------------------------------------- 常量

VERDICTS = ("waste", "normal", "valuable")
VERDICT_LABELS = {
    "waste": {"emoji": "🟥", "label": "重度虚度", "stamp": "虚度不予通过"},
    "normal": {"emoji": "🟨", "label": "中度浪费", "stamp": "待复盘"},
    "valuable": {"emoji": "🟩", "label": "高效充实", "stamp": "高光时刻"},
}
# 判定档位 → 允许标记的结果
#   waste: confirmed=认了确实虚度（计入虚度时长） / not_waste=其实有收获（回流有效时光）
#   normal: review_waste=复盘确实虚度 / review_valuable=复盘收获很大
#   valuable: highlight=自动入高光时刻
ALLOWED_OUTCOMES = {
    "waste": ("confirmed", "not_waste"),
    "normal": ("review_waste", "review_valuable"),
    "valuable": ("highlight",),
}
OUTCOME_LABELS = {
    "pending": "待确认",
    "confirmed": "确认虚度",
    "not_waste": "有收获（回流有效时光）",
    "review_pending": "72h 复盘中",
    "review_waste": "复盘：确实虚度",
    "review_valuable": "复盘：收获很大",
    "highlight": "已入高光时刻",
}
BLACKLIST_OUTCOMES = ("confirmed", "review_waste")   # 记入虚度黑名单（翻旧账）
WASTED_OUTCOMES = ("confirmed", "review_waste")      # 计入虚度时长
VALUE_OUTCOMES = ("highlight", "review_valuable", "not_waste")  # 计入有效时光
COOLING_HOURS = 72

# 虚度指数分档阈值
WASTE_INDEX_HEAVY = 70   # ≥70 → 重度虚度
WASTE_INDEX_MILD = 35    # 35~69 → 中度浪费；<35 → 高效充实

PERSONAS = {
    "mild": {"emoji": "📜", "label": "温和史官", "desc": "平静理性复盘，娓娓道来，适合自我反思"},
    "salty": {"emoji": "👿", "label": "毒舌光阴质检员", "desc": "阴阳幽默，只吐槽行为，绝不攻击人格"},
    "guardian": {"emoji": "🕯️", "label": "余生守望者", "desc": "悲壮严肃，「你又在消耗本就不多的余生」"},
}

_PERSONA_TONE = {
    "mild": "语气规范：平静理性的史官，像一位陪你翻旧账册的老友。娓娓道来、就事论事，"
            "把这段时光的来龙去脉复盘清楚；不嘲讽、不刺激，让用户在平静中自己看清问题。",
    "salty": "语气规范：阴阳怪气但幽默的光阴质检员，反讽、夸张比喻皆可，"
             "但毒舌只对这段行为和「时间刺客」话术，绝对不允许人身羞辱——"
             "不攻击用户的外貌、收入、能力、智商；刻薄要有分寸，好笑不伤人。",
    "guardian": "语气规范：悲壮肃穆的余生守望者。余生是倒计时的沙漏，每小时都在漏。"
                "多用庄重悲壮的句式与排比，例如「你又在消耗本就不多的余生」「沙漏不为人倒转」；"
                "凝重而非嘲讽，让用户在肃穆中冷静下来。",
}

_SYSTEM_LOGIC = """你是「人生虚度记录仪」里的光阴审计官。用户每记录一段度过的时间，都要来你这里「过审」。你的职责：给这段时光一个真实、有据的虚度评级，帮用户看清时间去向。

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
- 只吐槽行为，绝不羞辱人格。"""

_SYSTEM_SCREENSHOT = """

截图判定补充规则：
- 用户可能附上现场照片或屏幕截图（如华为运动健康、短视频 APP 时长统计、游戏战绩等）。请先从截图提取关键信息：实际行为、时长/次数/进度等线索，再套用上面的判定逻辑。
- 截图里的成瘾特征（连续使用时长、今日已刷 N 小时、凌晨 2 点仍在用）是判定取材重点——逐条点破。
- 截图与用户填写的信息冲突时（如时长不一致），以截图为准，并在结论中明确点出这个矛盾。
- 若截图模糊或关键信息不可见，在结论中如实说明「截图未见关键信息」，不要编造。"""

_USER_SCREENSHOT_NOTE = "【附时光截图】已随本条提交。请先读取截图里的实际行为与时长线索再判定；截图与上面填写的信息冲突时以截图为准。"

# ---------------------------------------------------------------- 生命换算

_DATE_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$")


def _parse_birth(birth):
    """出生日期字符串 → date；非法返回 None。"""
    m = _DATE_RE.match(str(birth or "").strip())
    if not m:
        return None
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def bmi(height_cm, weight_kg):
    """BMI = 体重kg / 身高m²（保留 1 位）；输入非法返回 None。"""
    try:
        h, w = float(height_cm), float(weight_kg)
    except (TypeError, ValueError):
        return None
    if h < 50 or h > 250 or w <= 0 or w > 400:
        return None
    return round(w / (h / 100.0) ** 2, 1)


def _life_change_total(ledger):
    """台账里所有已判定记录的寿命增减合计（天）。"""
    total = 0
    for r in ledger or []:
        if r.get("verdict") not in VERDICTS:
            continue
        try:
            total += int(r.get("life_change") or 0)
        except (TypeError, ValueError):
            continue
    return total


def life_stats(profile, ledger=None, now=None):
    """生命档案 → 已活/剩余天数小时、流逝占比、AI 寿命趣味增减。

    birth_date 非法时各字段返回 None（前端显示「先完善档案」）。
    """
    now = now or datetime.now()
    birth = _parse_birth((profile or {}).get("birth_date"))
    try:
        expectancy = float((profile or {}).get("expectancy"))
    except (TypeError, ValueError):
        expectancy = 0
    if not birth or expectancy <= 0:
        return {"age_days": None, "age_hours": None, "age_text": "",
                "expectancy_years": None, "remain_days": None, "remain_hours": None,
                "remain_text": "", "lived_pct": None, "life_change_total": 0,
                "ready": False}
    age = now - birth
    age_days = age.days  # 不足一天忽略（出生当天算第 0 天）
    age_hours = age_days * 24 + age.seconds // 3600
    total_days = expectancy * 365.25
    remain_days = max(0.0, round(total_days - age_days + _life_change_total(ledger), 1))
    st = {
        "age_days": age_days,
        "age_hours": age_hours,
        "age_text": _fmt_num(age_days) + " 天",
        "expectancy_years": expectancy,
        "remain_days": remain_days,
        "remain_hours": round(remain_days * 24, 1),
        "remain_text": _remain_text(remain_days),
        "lived_pct": round(age_days / total_days * 100, 2),
        "life_change_total": _life_change_total(ledger),
        "ready": True,
    }
    return st


def _remain_text(days):
    """剩余天数 → 「约 X 年 Y 个月」人类可读文案。"""
    if days is None:
        return ""
    years = int(days // 365.25)
    months = int((days - years * 365.25) // 30)
    if years >= 1:
        return "约 %d 年 %d 个月" % (years, months)
    return "约 %d 个月" % max(1, months)


def _fmt_num(x):
    s = ("%.1f" % x)
    return s[:-2] if s.endswith(".0") else s


def hours_text(hours):
    """「2.5 小时」/「45 分钟」。"""
    try:
        h = float(hours)
    except (TypeError, ValueError):
        return ""
    if h <= 0:
        return ""
    if h < 1:
        return "%d 分钟" % round(h * 60)
    return _fmt_num(h) + " 小时"


def life_share_text(hours, profile, ledger=None, now=None):
    """把这段时长换算成生命刻度文案（「这段时光≈余生的 X%」「若每周来 3 次，一年≈X 天」）。"""
    try:
        h = float(hours)
    except (TypeError, ValueError):
        return ""
    if h <= 0:
        return ""
    st = life_stats(profile, ledger, now=now)
    parts = []
    if st["ready"] and st["remain_days"] > 0:
        pct = h / (st["remain_days"] * 24) * 100
        if pct >= 0.01:
            parts.append("这段时光≈你剩余生命的 %s%%" % ("%.2f" % pct if pct < 1 else _fmt_num(round(pct, 1))))
        else:
            parts.append("这段时光≈你剩余生命的 %.4f%%" % pct)
    year_days = h * 3 * 52 / 24.0  # 每周重复 3 次
    if year_days >= 1:
        parts.append("若每周重复 3 次，一年就是 %s 天" % _fmt_num(round(year_days, 1)))
    return " · ".join(parts)


# ---------------------------------------------------------------- 判定 JSON 解析

_VERDICT_SYNONYMS = {
    "waste": "waste", "normal": "normal", "valuable": "valuable",
    "heavy": "waste", "severe": "waste", "重度": "waste", "重度虚度": "waste",
    "虚度": "waste", "虚度不予通过": "waste",
    "mid": "normal", "middle": "normal", "cool": "normal", "中度": "normal",
    "中度浪费": "normal", "待复盘": "normal", "冷静": "normal", "复盘": "normal",
    "good": "valuable", "pass": "valuable", "valued": "valuable",
    "高效": "valuable", "高效充实": "valuable", "高光": "valuable",
    "高光时刻": "valuable", "充实": "valuable",
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


def verdict_from_index(idx):
    """虚度指数 → 档位（≥70 waste / ≥35 normal / 其余 valuable）。"""
    if idx is None:
        return None
    return "waste" if idx >= WASTE_INDEX_HEAVY else ("normal" if idx >= WASTE_INDEX_MILD else "valuable")


def _norm_index(v):
    """0~100 整数；非法返回 None。"""
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
            out.append({"content": x.strip(), "sting_level": 3})
        elif isinstance(x, dict):
            text = x.get("content") or x.get("text") or x.get("reason") or ""
            if isinstance(text, str) and text.strip():
                sting = x.get("sting_level", x.get("sting"))
                out.append({"content": text.strip(), "sting_level": _norm_sting(sting)})
    return out


def _norm_life_change(v):
    """寿命影响天数：int，[-365, 365]；非法/缺失 → 0。"""
    if isinstance(v, bool):
        return 0
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0
    if x != x or x in (float("inf"), float("-inf")):
        return 0
    return int(min(365, max(-365, round(x))))


def _norm_save_time(v):
    """挽回有效时长（小时）：[0, 24]；非法/缺失 → 0。"""
    if isinstance(v, bool):
        return 0.0
    try:
        x = float(v)
    except (TypeError, ValueError):
        return 0.0
    if x != x or x in (float("inf"), float("-inf")) or x < 0:
        return 0.0
    return round(min(24.0, x), 1)


def normalize_verdict(obj, require_verdict=True):
    """原始 dict → 规范判定 dict；档位无法识别时返回 None（require_verdict=False 供流式增量解析）。

    waste_index 存在时以阈值重新推导 verdict（档位与指数必须一致）。
    """
    if not isinstance(obj, dict):
        return None
    index = _norm_index(obj.get("waste_index"))
    verdict = verdict_from_index(index) or _norm_verdict(obj.get("verdict"))
    if require_verdict and not verdict:
        return None
    return {
        "verdict": verdict,
        "confidence": _norm_index(obj.get("confidence")),
        "waste_index": index,
        "reasons": _norm_reasons(obj.get("reasons")),
        "questions": _norm_str_list(obj.get("questions")),
        "alternatives": _norm_str_list(obj.get("alternatives")),
        "life_change": _norm_life_change(obj.get("life_change")),
        "save_time": _norm_save_time(obj.get("save_time")),
    }


def parse_verdict(raw):
    """AI 原始输出 → 规范判定 dict；彻底解析失败返回 None（前端降级 Markdown 原文）。"""
    s = _extract_object(strip_fence(raw))
    if not s:
        return None
    for cand in (s, _repair_json(s)):
        try:
            obj = json.loads(cand)
        except ValueError:
            continue
        nv = normalize_verdict(obj)
        if nv:
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
    out = cut + "".join(closer.get(c, "") for c in reversed(stack))
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
        if nv["verdict"] or nv["reasons"] or nv["questions"] or nv["alternatives"] \
                or nv["confidence"] is not None or nv["waste_index"] is not None:
            return nv
        return None  # 已能合法解析但一个字段都还没有：等到下个增量再试
    return None


# ---------------------------------------------------------------- 健康截图 JSON 解析

_HHMM_RE = re.compile(r"(\d{1,2})\s*[:：点时]\s*(\d{1,2})?")


def _norm_hhmm(v):
    """「23:30」「23点30」「11:60(非法)」→ HH:MM；非法返回 None。"""
    if isinstance(v, (int, float)) or v is None:
        return None
    m = _HHMM_RE.search(str(v))
    if not m:
        return None
    hh, mm = int(m.group(1)), int(m.group(2) or 0)
    if hh == 24 and mm == 0:
        hh = 0
    if hh > 23 or mm > 59:
        return None
    return "%02d:%02d" % (hh, mm)


def _norm_health_num(v, lo, hi, digits=0):
    if isinstance(v, bool):
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if x != x or x in (float("inf"), float("-inf")) or x < lo or x > hi:
        return None
    return round(x, digits) if digits else int(round(x))


def normalize_health(obj):
    """健康截图 dict → 规范健康数据（缺失字段为 None）；一个有效字段都没有返回 None。"""
    if not isinstance(obj, dict):
        return None
    out = {
        "sleep_hours": _norm_health_num(obj.get("sleep_hours"), 0, 24, 1),
        "sleep_start": _norm_hhmm(obj.get("sleep_start")),
        "sleep_end": _norm_hhmm(obj.get("sleep_end")),
        "steps": _norm_health_num(obj.get("steps"), 0, 200000),
        "exercise_minutes": _norm_health_num(obj.get("exercise_minutes"), 0, 1440),
        "weight": _norm_health_num(obj.get("weight"), 20, 300, 1),
        "heart_rate": _norm_health_num(obj.get("heart_rate"), 25, 240),
    }
    return out if any(v is not None for v in out.values()) else None


def parse_health(raw):
    """识别原文 → 规范健康数据 dict；彻底失败返回 None。"""
    s = _extract_object(strip_fence(raw))
    if not s:
        return None
    for cand in (s, _repair_json(s)):
        try:
            obj = json.loads(cand)
        except ValueError:
            continue
        nh = normalize_health(obj)
        if nh:
            return nh
    return None


# ---------------------------------------------------------------- 台账统计

def _hours_of(r):
    try:
        h = float(r.get("hours") or 0)
    except (TypeError, ValueError):
        return 0.0
    return h if 0 < h <= 24 else 0.0


def stats(ledger, now=None):
    """台账聚合。虚度时长只计：确认虚度（waste+confirmed / normal+review_waste）。

    monthly: 按月战报（虚度/有效时长、虚度率、黑名单数、Top 浪费与高光事件）。
    """
    now = now or datetime.now()
    month_key = now.strftime("%Y-%m")
    st = {
        "month": month_key,
        "month_wasted": 0.0, "month_value": 0.0, "month_save_time": 0.0,
        "month_top_wastes": [], "month_top_highlights": [],
        "total_wasted": 0.0, "total_value": 0.0, "total_save_time": 0.0,
        "waste_total": 0, "waste_confirmed": 0, "waste_not_waste": 0,
        "normal_total": 0, "normal_reviewing": 0, "normal_review_waste": 0, "normal_review_valuable": 0,
        "valuable_total": 0,
        "blacklist_count": 0,
        "judged_total": 0, "resolved": 0, "admitted": 0,
        "waste_rate": 0.0, "month_waste_rate": 0.0,
        "life_change_total": 0,
        "monthly": {},
    }
    for r in ledger:
        v, o = r.get("verdict"), r.get("outcome")
        hours = _hours_of(r)
        created = str(r.get("created") or "")
        mk = created[:7]
        m = st["monthly"].setdefault(mk, {
            "month": mk, "judged": 0, "wasted": 0.0, "value": 0.0, "save_time": 0.0,
            "blacklist": 0, "max_waste": None, "max_valuable": None,
            "top_wastes": [], "top_highlights": [],
        })
        if v not in VERDICTS:
            continue  # 未判定 / 解析失败的记录不进统计
        st["judged_total"] += 1
        m["judged"] += 1
        if v == "waste":
            st["waste_total"] += 1
            if o == "confirmed":
                st["waste_confirmed"] += 1
                st["total_wasted"] += hours
                m["wasted"] += hours
                st["admitted"] += 1
                if created.startswith(month_key):
                    st["month_wasted"] += hours
                m["top_wastes"].append({"activity": r.get("activity"), "hours": hours,
                                        "created": created})
                if m["max_waste"] is None or hours > _hours_of(m["max_waste"]):
                    m["max_waste"] = {"activity": r.get("activity"), "hours": hours}
            elif o == "not_waste":
                st["waste_not_waste"] += 1
                st["total_value"] += hours
                m["value"] += hours
                if created.startswith(month_key):
                    st["month_value"] += hours
        elif v == "normal":
            st["normal_total"] += 1
            if o == "review_pending":
                st["normal_reviewing"] += 1
            elif o == "review_waste":
                st["normal_review_waste"] += 1
                st["total_wasted"] += hours
                m["wasted"] += hours
                st["admitted"] += 1
                if created.startswith(month_key):
                    st["month_wasted"] += hours
                m["top_wastes"].append({"activity": r.get("activity"), "hours": hours,
                                        "created": created})
                if m["max_waste"] is None or hours > _hours_of(m["max_waste"]):
                    m["max_waste"] = {"activity": r.get("activity"), "hours": hours}
            elif o == "review_valuable":
                st["normal_review_valuable"] += 1
                st["total_value"] += hours
                m["value"] += hours
                if created.startswith(month_key):
                    st["month_value"] += hours
        elif v == "valuable":
            st["valuable_total"] += 1
            if o == "highlight":
                st["total_value"] += hours
                m["value"] += hours
                if created.startswith(month_key):
                    st["month_value"] += hours
                m["top_highlights"].append({"activity": r.get("activity"), "hours": hours,
                                            "created": created})
                if m["max_valuable"] is None or hours > _hours_of(m["max_valuable"]):
                    m["max_valuable"] = {"activity": r.get("activity"), "hours": hours}
        if o in BLACKLIST_OUTCOMES:
            st["blacklist_count"] += 1
            m["blacklist"] += 1
        if o in WASTED_OUTCOMES and r.get("verdict") == "waste":
            try:
                st["total_save_time"] += _norm_save_time(r.get("save_time"))
                if created.startswith(month_key):
                    st["month_save_time"] += _norm_save_time(r.get("save_time"))
            except (TypeError, ValueError):
                pass
        # 已出结果：waste 确认/回流 + normal 复盘完成
        if (v == "waste" and o in ("confirmed", "not_waste")) or \
                (v == "normal" and o in ("review_waste", "review_valuable")):
            st["resolved"] += 1
            m.setdefault("resolved", 0)
            m["resolved"] += 1
    st["total_wasted"] = round(st["total_wasted"], 1)
    st["total_value"] = round(st["total_value"], 1)
    st["month_wasted"] = round(st["month_wasted"], 1)
    st["month_value"] = round(st["month_value"], 1)
    st["month_save_time"] = round(st["month_save_time"], 1)
    st["total_save_time"] = round(st["total_save_time"], 1)
    total_all = st["total_wasted"] + st["total_value"]
    st["waste_rate"] = round(st["total_wasted"] / total_all * 100, 1) if total_all else 0.0
    month_all = st["month_wasted"] + st["month_value"]
    st["month_waste_rate"] = round(st["month_wasted"] / month_all * 100, 1) if month_all else 0.0
    st["life_change_total"] = _life_change_total(ledger)
    for mk in st["monthly"]:
        m = st["monthly"][mk]
        m["wasted"] = round(m["wasted"], 1)
        m["value"] = round(m["value"], 1)
        m["save_time"] = round(m["save_time"], 1)
        all_h = m["wasted"] + m["value"]
        m["waste_rate"] = round(m["wasted"] / all_h * 100, 1) if all_h else 0.0
        m["top_wastes"] = sorted(m["top_wastes"], key=lambda x: -_hours_of(x))[:3]
        m["top_highlights"] = sorted(m["top_highlights"], key=lambda x: -_hours_of(x))[:3]
    st["monthly"] = [st["monthly"][k] for k in sorted(st["monthly"], reverse=True)]
    cur = next((m for m in st["monthly"] if m["month"] == month_key), None)
    if cur:
        st["month_top_wastes"] = cur["top_wastes"]
        st["month_top_highlights"] = cur["top_highlights"]
    return st


def cooling_due(ledger, now=None):
    """复盘期到点待回访：verdict==normal 且 outcome==review_pending 且 72h 已过。"""
    now = now or datetime.now()
    now_str = now.strftime("%Y-%m-%d %H:%M:%S")
    out = []
    for r in ledger:
        if r.get("verdict") == "normal" and r.get("outcome") == "review_pending":
            until = str(r.get("cool_until") or "")
            if until and until <= now_str:
                out.append(r)
    out.sort(key=lambda r: r.get("cool_until") or "")
    return out


def cooling_until(created, now=None):
    """复盘期截止时间字符串（created + 72h）。"""
    now = now or datetime.now()
    try:
        t = datetime.strptime(created, "%Y-%m-%d %H:%M:%S") if created else now
    except ValueError:
        t = now
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
    record["waste_index"] = {"waste": 80, "normal": 50, "valuable": 20}.get(verdict)
    if verdict == "normal":
        record["outcome"] = "review_pending"
        record["cool_until"] = record.get("cool_until") or cooling_until(record.get("created", ""))
    elif verdict == "valuable":
        record["outcome"] = "highlight"
        record["outcome_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return True


# ---------------------------------------------------------------- 虚度黑名单（翻旧账）

def _norm_name(s):
    return re.sub(r"[\s\-—_·、，。！？!?.,()（）\[\]【】]+", "", str(s or "")).lower()


def _bigrams(s):
    s = _norm_name(s)
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def blacklist_matches(ledger, activity, limit=3):
    """黑名单里与本次行为「同类」的记录（文本 bigram 相似度>0），新的在前。"""
    grams = _bigrams(activity)
    if not grams:
        return []
    scored = []
    for r in ledger:
        if r.get("outcome") not in BLACKLIST_OUTCOMES:
            continue
        other = _bigrams(r.get("activity"))
        overlap = len(grams & other)
        if overlap > 0:
            scored.append((overlap, str(r.get("created") or ""), r))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [r for _, _, r in scored[:limit]]


def blacklist_lines(ledger, activity, limit=3):
    """翻旧账上下文文本行，注入提示词：你曾虚度过 XX（时长，日期），本次同类行为会拉高虚度评分。"""
    lines = []
    for r in blacklist_matches(ledger, activity, limit):
        verdict = VERDICT_LABELS.get(r.get("verdict"), {}).get("label", "?")
        lines.append("你曾在 %s 虚度过「%s」（%s，判定为%s），本次同类行为会拉高虚度评分" % (
            str(r.get("created") or "")[:10], r.get("activity"),
            hours_text(r.get("hours")) or "时长不详", verdict))
    return lines


# ---------------------------------------------------------------- 健康摘要

def health_summary(profile):
    """最近一次健康导入 → 提示词文本行（无导入返回空串）。"""
    log = (profile or {}).get("health_log") or []
    if not log:
        return ""
    h = log[0]
    parts = []
    if h.get("sleep_hours") is not None:
        seg = "睡眠 " + _fmt_num(h["sleep_hours"]) + " 小时"
        if h.get("sleep_start") and h.get("sleep_end"):
            seg += "（%s ~ %s）" % (h["sleep_start"], h["sleep_end"])
        parts.append(seg)
    if h.get("steps") is not None:
        parts.append("步数 " + str(h["steps"]))
    if h.get("exercise_minutes") is not None:
        parts.append("运动 " + str(h["exercise_minutes"]) + " 分钟")
    if h.get("weight") is not None:
        parts.append("体重 " + _fmt_num(h["weight"]) + "kg")
    if h.get("heart_rate") is not None:
        parts.append("心率 " + str(h["heart_rate"]))
    if not parts:
        return ""
    return "%s导入：%s" % (str(h.get("date") or "")[:10], " · ".join(parts))


# ---------------------------------------------------------------- 提示词构建

def has_image(record):
    """记录是否附带照片/截图。"""
    return bool(record.get("thumb")) if isinstance(record, dict) else False


def persona_system(persona_id, screenshot=False):
    tone = _PERSONA_TONE.get(persona_id) or _PERSONA_TONE["salty"]
    return _SYSTEM_LOGIC + (_SYSTEM_SCREENSHOT if screenshot else "") + "\n\n" + tone


def build_messages(record, profile, persona_id, blacklist=None):
    """判定提示词：(system, user)。profile 为生命档案，blacklist 为翻旧账文本行。"""
    prof = profile or {}
    hours = _hours_of(record)
    img = has_image(record)
    parts = ["【今天做了什么】%s" % record.get("activity", ""),
             "【耗时】%s" % (hours_text(hours) or "时长不详")]
    feeling = str(record.get("feeling") or "").strip()
    parts.append("【内心感受】%s" % (feeling or "（未说明）"))
    st = life_stats(prof, None)
    if st["ready"]:
        parts.append("【生命档案】出生 %s（现 %s）· 预期寿命 %d 岁 · 已度过人生 %.1f%%"
                     % (str(prof.get("birth_date"))[:10], st["age_text"],
                        int(st["expectancy_years"]), st["lived_pct"]))
        b = bmi(prof.get("height"), prof.get("weight"))
        if b is not None:
            parts.append("【身体】BMI %.1f" % b)
        ss, se, sh = prof.get("sleep_start"), prof.get("sleep_end"), prof.get("sleep_hours")
        if ss or se or sh:
            parts.append("【作息】入睡 %s · 起床 %s · 日均睡眠 %s"
                         % (ss or "?", se or "?", (hours_text(sh) if sh else "?")))
        for key, label in (("chronic", "慢性病/病史"), ("diet", "饮食"),
                           ("smoke", "烟"), ("drink", "酒"), ("exercise", "运动频率")):
            val = str(prof.get(key) or "").strip()
            if val:
                parts.append("【%s】%s" % (label, val[:60]))
    hs = health_summary(prof)
    if hs:
        parts.append("【健康摘要】%s" % hs)
    if blacklist:
        parts.append("【历史虚度提醒·翻旧账】\n" + "\n".join("- " + d for d in blacklist))
    if img:
        parts.append(_USER_SCREENSHOT_NOTE)
    parts.append("请直接输出判定 JSON。")
    return persona_system(persona_id, img), "\n".join(parts)


# ---------------------------------------------------------------- 健康截图识别提示词

HEALTH_PROMPT = """识别这张华为运动健康截图，提取：睡眠时长（小时）、入睡时间、起床时间、日均步数、运动时长（分钟）、体重（kg）、心率（次/分）。
只输出纯 JSON，不要多余文字，不要 markdown 围栏。缺失的字段填 null：
{"sleep_hours":7.5,"sleep_start":"23:30","sleep_end":"07:00","steps":8000,"exercise_minutes":30,"weight":65.5,"heart_rate":70}"""
