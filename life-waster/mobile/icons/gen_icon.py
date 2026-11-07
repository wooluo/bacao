#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""人生虚度记录仪 · 图标/启动图生成器（Pillow，唯一允许的本地工具脚本）

设计语言与前端一致：墨黑底 + 暗金时光账本风，主视觉为金沙漏（上方余沙渐少、
下方沙堆渐高，流沙不断）。产出：
  - mipmap-*/ic_launcher.png / ic_launcher_round.png   旧式图标（圆角矩形 / 圆）
  - mipmap-*/ic_launcher_foreground.png                自适应前景（沙漏居 66dp 安全区）
  - drawable*/splash.png                               启动图（墨黑底 + 居中沙漏，无文字）

运行：python3 mobile/icons/gen_icon.py   （在仓库根目录或任意位置，路径以脚本定位）
"""
import math
import os

from PIL import Image, ImageDraw, ImageOps

RES = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "..", "android", "app", "src", "main", "res"))

# ---------------- 调色（与 static/style.css 的时光账本风一致） ----------------
BG_LIGHT = (35, 35, 44)      # 渐变内芯 #23232C
BG_DARK = (15, 15, 20)       # 渐变外缘 #0F0F14
GOLD_FRAME = (201, 165, 92)  # 框架金 #C9A55C
GOLD_SAND = (226, 183, 95)   # 流沙金 #E2B75F
GOLD_STAR = (232, 213, 163)  # 星光 #E8D5A3
GLASS_FILL = (255, 255, 255, 20)

SS = 4  # 超采样倍率（抗锯齿）

# ---------------- 沙漏几何（108 网格坐标，中心 54,54） ----------------
TOP_BAR = (30, 27.5, 78, 32.5)
BOT_BAR = (30, 75.5, 78, 80.5)
NECK_L = (52, 53.2)          # 上壶颈部左点
NECK_R = (56, 53.2)
NECK2_L = (52, 54.8)         # 下壶颈部左点
NECK2_R = (56, 54.8)
GLASS_TOP_L, GLASS_TOP_C, GLASS_TOP_R = (37, 32.5), (47, 44), (71, 32.5)
GLASS_BOT_L, GLASS_BOT_C, GLASS_BOT_R = (37, 75.5), (47, 64), (71, 75.5)
STARS = [((63, 24), 2.6), ((33, 64), 2.0)]
SAND_TOP_L_Y = 44.6          # 上壶沙面（左高右低，微斜更有动感）
SAND_TOP_R_Y = 46.6
STREAM = (53.1, 53.0, 54.9, 69.0)
PILE = [(45.5, 76.0), (62.5, 76.0), (54, 62.5)]  # 下壶沙堆


def bezier(p0, p1, p2, n=48):
    """二次贝塞尔采样。"""
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1])
            for t in (i / (n - 1) for i in range(n))]


def _edge_from_y(pts, y_min, reverse=False):
    """取边缘采样点中 y>=y_min 的部分，并在 y_min 处插值出精确断点。"""
    keep = [p for p in pts if p[1] >= y_min]
    if not keep:
        return []
    if reverse:
        keep = keep[::-1]
    return keep


def hourglass_shapes():
    """返回沙漏的全部图元（108 网格坐标）。"""
    edge_tl = bezier(GLASS_TOP_L, GLASS_TOP_C, NECK_L)   # 上壶左边缘（上→下）
    edge_tr = bezier(GLASS_TOP_R, (61, 44), NECK_R)      # 上壶右边缘
    edge_bl = bezier(NECK2_L, GLASS_BOT_C, GLASS_BOT_L)  # 下壶左边缘（颈→左下）
    edge_br = bezier(NECK2_R, (61, 64), GLASS_BOT_R)
    shapes = []

    # 玻璃轮廓多边形（内部极淡白，画在沙与描边之下）
    glass_top = [GLASS_TOP_L] + edge_tl + [NECK_R] + edge_tr[::-1]
    glass_bot = [NECK2_L] + edge_bl + [GLASS_BOT_R] + edge_br[::-1]
    shapes.append(("poly", glass_top, GLASS_FILL))
    shapes.append(("poly", glass_bot, GLASS_FILL))

    # 上壶沙：沿玻璃内缘取 y>=沙面 的点，顶面斜线直接闭合（勿加收口点，会自交挖空）
    sand_top = _edge_from_y(edge_tl, SAND_TOP_L_Y)
    sand_top += _edge_from_y(edge_tr, SAND_TOP_R_Y, reverse=True)
    if sand_top:
        first = sand_top[0]
        sand_top = [(first[0], SAND_TOP_L_Y)] + sand_top
        shapes.append(("poly", sand_top, GOLD_SAND))

    # 下壶沙堆 + 流沙
    shapes.append(("poly", PILE, GOLD_SAND))
    shapes.append(("rrect", STREAM, 0.9, GOLD_SAND))

    # 玻璃描边（覆盖沙与玻璃接缝）
    lw = 1.7
    shapes.append(("stroke", glass_top, lw, GOLD_FRAME))
    shapes.append(("stroke", glass_bot, lw, GOLD_FRAME))

    # 顶/底横梁
    shapes.append(("rrect", TOP_BAR, 2.0, GOLD_FRAME))
    shapes.append(("rrect", BOT_BAR, 2.0, GOLD_FRAME))

    # 星光点缀
    for (sx, sy), r in STARS:
        star = []
        for i in range(8):
            ang = math.pi / 4 * i - math.pi / 2
            rad = r if i % 2 == 0 else r * 0.3
            star.append((sx + rad * math.cos(ang), sy + rad * math.sin(ang)))
        shapes.append(("poly", star, GOLD_STAR + (190,)))
    return shapes


def _to_px(shapes, size, grid_span, cx=None, cy=None):
    """108 网格图元 → size 画布像素图元。grid_span 为沙漏区域映射的网格跨度，
    cx/cy 为沙漏网格中心 (54,54) 落在画布上的位置（默认画布中心）。"""
    cx = size / 2 if cx is None else cx
    cy = size / 2 if cy is None else cy
    # grid_span=108 → 1:1 网格；其余 → 沙漏区（56 网格宽）缩放到画布 grid_span%
    k = size / 108.0 if grid_span == 108 else size * (grid_span / 108.0) / 56.0
    out = []
    for s in shapes:
        kind = s[0]
        if kind in ("poly", "stroke"):
            pts = s[1]
            pts = [((p[0] - 54) * k + cx, (p[1] - 54) * k + cy) for p in pts]
            if kind == "poly":
                fill = s[2]
                if len(fill) == 3:
                    fill = fill + (255,)
                out.append(("poly", pts, fill))
            else:
                out.append(("stroke", pts, s[2] * k, s[3] + (255,)))
        else:  # rrect
            x0, y0, x1, y1 = s[1]
            box = tuple((v - 54) * k + c for v, c in
                        zip((x0, y0, x1, y1), (cx, cy, cx, cy)))
            out.append(("rrect", box, s[2] * k, s[3] + (255,)))
    return out


def draw_shapes(draw, shapes_px):
    for s in shapes_px:
        if s[0] == "poly":
            draw.polygon(s[1], fill=s[2])
        elif s[0] == "stroke":
            pts = s[1] + [s[1][0]]
            draw.line(pts, fill=s[3], width=max(1, round(s[2])), joint="curve")
        else:
            draw.rounded_rectangle(s[1], radius=s[2], fill=s[3])


def render_hourglass(size, grid_span=108, cx=None, cy=None):
    """透明底沙漏图层（size 见方）。grid_span=108 → 自适应前景 1:1 网格；
    其余值 → 沙漏区域（约 56 网格宽）缩放到画布 grid_span%。"""
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    shapes = _to_px(hourglass_shapes(), big, grid_span, cx and cx * SS, cy and cy * SS)
    draw_shapes(draw, shapes)
    return img.resize((size, size), Image.LANCZOS)


def render_bg(size, radius_ratio=None, circle=False):
    """墨黑径向渐变底；radius_ratio=None 时全幅（自适应背景用不到，仅 splash）。"""
    big = size * SS
    # 径向渐变：内芯亮、外缘暗，光心偏左上（与前端 hero 一致）
    grad = Image.radial_gradient("L").resize((big * 2, big * 2))
    grad = grad.crop((big // 3, big // 4, big // 3 + big, big // 4 + big))
    grad = grad.point(lambda v: 255 - v)  # radial_gradient 中心黑边缘白 → 反转为中心亮
    bg = ImageOps.colorize(grad, black=BG_LIGHT, white=BG_DARK).convert("RGBA")
    if radius_ratio is not None:
        mask = Image.new("L", (big, big), 0)
        md = ImageDraw.Draw(mask)
        if circle:
            md.ellipse((0, 0, big - 1, big - 1), fill=255)
        else:
            md.rounded_rectangle((0, 0, big - 1, big - 1), radius=big * radius_ratio, fill=255)
        bg.putalpha(mask)
    return bg.resize((size, size), Image.LANCZOS)


def compose_legacy(size, circle):
    """旧式图标：渐变底 + 居中沙漏（沙漏约占画布 70%）。"""
    icon = render_bg(size, radius_ratio=0.225, circle=circle)
    hg = render_hourglass(size, grid_span=70)
    icon.alpha_composite(hg)
    return icon


def write(img, rel):
    path = os.path.join(RES, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)
    print("✓", rel, img.size[0], "x", img.size[1])


def main():
    # 1) 旧式图标 + 自适应前景（五档密度）
    for dpi, legacy, fg in (("mdpi", 48, 108), ("hdpi", 72, 162), ("xhdpi", 96, 216),
                            ("xxhdpi", 144, 324), ("xxxhdpi", 192, 432)):
        write(compose_legacy(legacy, circle=False), "mipmap-%s/ic_launcher.png" % dpi)
        write(compose_legacy(legacy, circle=True), "mipmap-%s/ic_launcher_round.png" % dpi)
        write(render_hourglass(fg, grid_span=108), "mipmap-%s/ic_launcher_foreground.png" % dpi)

    # 2) 自适应背景色 → 墨黑（values/ic_launcher_background.xml 由外部维护，这里只管图）
    # 3) 启动图：墨黑渐变 + 居中沙漏（宽约短边 22%）
    splash_dims = [
        ("drawable/splash.png", 480, 320),
        ("drawable-port-mdpi/splash.png", 480, 800),
        ("drawable-port-hdpi/splash.png", 720, 1280),
        ("drawable-port-xhdpi/splash.png", 960, 1600),
        ("drawable-port-xxhdpi/splash.png", 1600, 2560),
        ("drawable-port-xxxhdpi/splash.png", 1920, 3200),
        ("drawable-land-mdpi/splash.png", 800, 480),
        ("drawable-land-hdpi/splash.png", 1280, 720),
        ("drawable-land-xhdpi/splash.png", 1600, 960),
        ("drawable-land-xxhdpi/splash.png", 2560, 1600),
        ("drawable-land-xxxhdpi/splash.png", 3200, 1920),
    ]
    for rel, w, h in splash_dims:
        if not os.path.exists(os.path.join(RES, rel)):
            continue  # 只替换已存在的尺寸，不新增目录
        # 按目标尺寸重建径向渐变（光心偏左上，与前端 hero 一致）
        grad = Image.radial_gradient("L").resize((w * 2, h * 2))
        grad = grad.crop((w // 2, h // 3, w // 2 + w, h // 3 + h))
        grad = grad.point(lambda v: 255 - v)
        base = ImageOps.colorize(grad, black=BG_LIGHT, white=BG_DARK).convert("RGBA")
        m = min(w, h)
        hg = render_hourglass(int(m * 0.26), grid_span=70)
        base.alpha_composite(hg, ((w - hg.size[0]) // 2, (h - hg.size[1]) // 2))
        write(base, rel)
    print("完成")


if __name__ == "__main__":
    main()
