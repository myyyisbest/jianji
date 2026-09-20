#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
简记 · 应用图标生成器
=====================
图形：一支斜置的「艺术签字笔」（蘸水笔 / 书法笔尖）。
配色沿用应用主题：深炭底 + 奶油白笔身 + 强调橙点缀。

设计要点
--------
1. 笔杆与笔尖用「一笔画」的连续轮廓，避免拼接感
2. 倾斜 40°（从左下笔尖指向右上笔尾），符合书写动势
3. 笔尖开缝 + 笔尖处的橙色「墨点」，点出「落笔成字」的意象
4. 圆角方底 = 应用图标惯例；内边距按 12% 留白，小尺寸下不挤边

之所以自己画路径而不调用图形库：
图标要在 16px 下仍然认得出，任何自动简化的结果都糊。用超采样（4x）手绘
再降采样，边缘质量最稳。
"""

import math
import os
from PIL import Image, ImageDraw, ImageFilter

# ---------- 配色（与 css/style.css 的主题变量对齐）----------
BG_DARK = (33, 32, 28)          # --text-1 的深炭，做图标底
BG_DARK_2 = (44, 43, 38)        # 底部微亮，形成极淡的纵向渐变
INK = (250, 249, 245)           # --bg 奶油白，做笔身
INK_SOFT = (232, 229, 218)      # 笔身受光面
ACCENT = (217, 119, 87)         # --accent 强调橙
ACCENT_DEEP = (201, 100, 66)    # --accent-strong
INK_SHADE = (206, 202, 190)     # 笔身背光侧的收尾色

SS = 4                           # 超采样倍数


def rounded_square(size, radius_ratio=0.225, padding_ratio=0.0):
    """返回圆角方底的 mask（L 模式）。radius_ratio 相对整边长。"""
    w = size
    pad = int(w * padding_ratio)
    box = [pad, pad, w - pad - 1, w - pad - 1]
    img = Image.new('L', (w, w), 0)
    d = ImageDraw.Draw(img)
    r = int((box[2] - box[0] + 1) * radius_ratio)
    d.rounded_rectangle(box, radius=r, fill=255)
    return img


def vertical_gradient(size, top, bottom):
    """纵向渐变色块。"""
    img = Image.new('RGB', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (size, y)], fill=c)
    return img


def rotate_about(point, cx, cy, deg):
    """把 point 绕 (cx, cy) 旋转 deg 度。"""
    rad = math.radians(deg)
    px, py = point[0] - cx, point[1] - cy
    return (cx + px * math.cos(rad) - py * math.sin(rad),
            cy + px * math.sin(rad) + py * math.cos(rad))


def pen_metrics(S):
    """笔的各段比例，集中一处，轮廓与装饰共用同一组数，避免对不齐。"""
    return {
        'cx': S / 2,
        'W': S * 0.058,          # 笔杆半宽
        'W_grip': S * 0.050,     # 握位半宽（略收）
        'W_nib': S * 0.032,      # 笔尖起始半宽
        'y_tail': S * 0.150,     # 笔尾
        'y_shoulder': S * 0.286, # 笔杆 → 握位
        'y_grip': S * 0.560,     # 握位结束
        'y_nib': S * 0.628,      # 笔尖起始
        'y_tip': S * 0.862,      # 笔尖（旋转前的最下端）
    }


def pen_polygon(size):
    """
    签字笔的轮廓（竖直绘制的笔，笔尖朝下），返回一组点。
    之后整体旋转，得到斜置的姿态。

    结构：
        笔尾(上) ── 笔杆 ── 握位(略收) ── 笔尖(下, 收成一点)
    """
    m = pen_metrics(size)
    cx, W, W_grip, W_nib = m['cx'], m['W'], m['W_grip'], m['W_nib']

    left = [
        (cx - W, m['y_tail']),
        (cx - W, m['y_shoulder']),
        (cx - W_grip, m['y_grip']),
        (cx - W_nib, m['y_nib']),
        (cx - size * 0.003, m['y_tip']),   # 收成尖
    ]
    right = [
        (cx + size * 0.003, m['y_tip']),
        (cx + W_nib, m['y_nib']),
        (cx + W_grip, m['y_grip']),
        (cx + W, m['y_shoulder']),
        (cx + W, m['y_tail']),
    ]
    return left + right


def draw_icon(size_px):
    """生成指定像素尺寸的图标（RGBA）。"""
    S = size_px * SS

    # ---- 1. 底：圆角方 + 极淡纵向渐变 ----
    base = vertical_gradient(S, BG_DARK_2, BG_DARK)
    mask = rounded_square(S, radius_ratio=0.225)
    icon = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)

    # 描一圈极细的亮边，深色底在深色任务栏上才有边界感
    edge = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    de = ImageDraw.Draw(edge)
    r = int(S * 0.225)
    de.rounded_rectangle([0, 0, S - 1, S - 1], radius=r,
                         outline=(255, 255, 255, 26), width=max(1, int(S * 0.006)))
    icon = Image.alpha_composite(icon, edge)

    # ---- 2. 笔：竖直画好再旋转 ----
    # 整体绕画布中心旋转 QUAD 度。笔在竖直状态下偏高，旋转后重心会甩向右上，
    # 所以先把竖直笔整体下移一点（偏移量在旋转前施加），转完才落在视觉中心。
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    dl = ImageDraw.Draw(layer)

    OFFSET_Y = S * 0.030                 # 旋转前的下移补偿
    CX = CY = S / 2
    ANGLE = 36                           # 顺时针旋转角度，笔尖指向左下

    def place(p):
        """竖直坐标 →（下移补偿）→ 绕中心旋转。"""
        return rotate_about((p[0], p[1] + OFFSET_Y), CX, CY, ANGLE)

    pts = pen_polygon(S)
    m = pen_metrics(S)
    W = m['W']
    cx = m['cx']

    # 笔的完整轮廓（含笔尾圆头）——渐变与描边都用它做 mask
    tail_cy = m['y_tail'] - W * 0.06          # 圆头圆心略上移，与杆身平滑相接

    # ---- 2a. 先铺一层纯色笔身（作为渐变的底） ----
    dl.polygon([place(p) for p in pts], fill=INK + (255,))
    tail = place((cx, tail_cy))
    dl.ellipse([tail[0] - W, tail[1] - W, tail[0] + W, tail[1] + W], fill=INK + (255,))

    # ---- 2b. 圆柱渐变：只在「笔杆 + 握位」范围内压暗右侧，
    #          笔尖保持纯色（笔尖有渐变会显脏） ----
    grad = Image.new('RGB', (S, S), INK)
    dg = ImageDraw.Draw(grad)
    x_lo, x_hi = cx - W, cx + W
    for xx in range(S):
        t = (xx - x_lo) / max(1.0, (x_hi - x_lo))
        if t < 0.45:
            c = INK
        else:
            k = min(1.0, (t - 0.45) / 0.55)
            c = tuple(int(INK[i] + (INK_SHADE[i] - INK[i]) * k) for i in range(3))
        dg.line([(xx, 0), (xx, S)], fill=c)

    body_mask = Image.new('L', (S, S), 0)
    bm = ImageDraw.Draw(body_mask)
    # 笔杆段（不含笔尖）+ 笔尾圆头
    bm.polygon([place((cx - W, m['y_tail'])),
                place((cx + W, m['y_tail'])),
                place((cx + m['W_grip'], m['y_nib'])),
                place((cx - m['W_grip'], m['y_nib']))], fill=255)
    bm.ellipse([tail[0] - W, tail[1] - W, tail[0] + W, tail[1] + W], fill=255)
    grad.putalpha(body_mask)
    layer = Image.alpha_composite(layer, grad.convert('RGBA'))
    dl = ImageDraw.Draw(layer)                # 之后继续往 layer 上画细节

    # 笔杆与握位之间的细缝（分段感）
    sy = m['y_shoulder']
    seam = [
        (cx - W * 1.02, sy), (cx + W * 1.02, sy),
        (cx + W * 1.02, sy + S * 0.009), (cx - W * 1.02, sy + S * 0.009),
    ]
    dl.polygon([place(p) for p in seam], fill=BG_DARK + (255,))

    # 笔尖开缝：只做「暗示」，不挖穿。
    # 挖黑色实缝会在小尺寸下糊成叉子；细长缝则显脏。取「短而浅」的一段。
    slit = [
        (cx - S * 0.0034, m['y_nib'] + S * 0.004),
        (cx + S * 0.0034, m['y_nib'] + S * 0.004),
        (cx + S * 0.0034, m['y_nib'] + S * 0.062),
        (cx - S * 0.0034, m['y_nib'] + S * 0.062),
    ]
    dl.polygon([place(p) for p in slit], fill=(122, 119, 110, 150))

    # ---- 3. 橙色墨点：贴在笔尖外侧，点出「落笔成字」----
    tip = place((cx, m['y_tip']))
    dirx = math.sin(math.radians(ANGLE))     # 旋转后「笔尖朝向」的单位向量
    diry = math.cos(math.radians(ANGLE))
    dot_r = S * 0.050
    d = dot_r * 0.80
    dot_c = (tip[0] + dirx * d, tip[1] + diry * d)
    dl.ellipse([dot_c[0] - dot_r, dot_c[1] - dot_r, dot_c[0] + dot_r, dot_c[1] + dot_r],
               fill=ACCENT + (255,))

    icon = Image.alpha_composite(icon, layer)

    # ---- 4. 降采样 ----
    out = icon.resize((size_px, size_px), Image.LANCZOS)
    return out


def draw_tray_icon(size_px, on_dark=False):
    """
    托盘图标（RGBA，透明底）。

    与应用图标 draw_icon 的区别，每一条都是踩出来的：

    1. **不要深色圆角方底**。托盘区只有 16~24px，带底的方块在里面就是一块糊掉的黑斑，
       还会和相邻图标打架。
    2. **单色笔身，且必须出两套**。子进程实测（浅底/深底各占一半的对比图）：
         白笔 → 浅色托盘条上完全消失
         黑笔 → 深色托盘条上完全消失
       这是物理限制，调色解决不了。所以按 Windows 应用通行做法，运行期监听系统主题、
       在 light / dark 两套之间切换（见 electron/main.js 的 nativeTheme 监听）。
    3. **保留橙色墨点**。它是整套视觉唯一的识别锚点，且在深浅两种底上都出得来
       （实测过：去掉墨点的纯色版本在深底上就是一根白线，认不出是简记）。

    on_dark=False → 深色笔，给浅色托盘条用（Windows 11 默认）
    on_dark=True  → 白色笔，给深色托盘条用（Windows 10 深色主题 / 深色任务栏）

    几何完全复用 pen_metrics / pen_polygon，保证托盘里的笔和应用图标是同一支。
    """
    S = size_px * SS
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    dl = ImageDraw.Draw(layer)

    OFFSET_Y = S * 0.030
    CX = CY = S / 2
    ANGLE = 36

    def place(p):
        return rotate_about((p[0], p[1] + OFFSET_Y), CX, CY, ANGLE)

    body = INK if on_dark else BG_DARK          # 深色托盘条上画白笔，反之画深笔
    slit = BG_DARK if on_dark else INK          # 开缝取反色，保证在笔身上看得见

    pts = pen_polygon(S)
    m = pen_metrics(S)
    W = m['W']
    cx = m['cx']
    tail_cy = m['y_tail'] - W * 0.06

    # 笔身 + 笔尾圆头。纯色不渐变——16px 下渐变等于脏
    dl.polygon([place(p) for p in pts], fill=body + (255,))
    tail = place((cx, tail_cy))
    dl.ellipse([tail[0] - W, tail[1] - W, tail[0] + W, tail[1] + W], fill=body + (255,))

    slit_pts = [
        (cx - S * 0.0034, m['y_nib'] + S * 0.004),
        (cx + S * 0.0034, m['y_nib'] + S * 0.004),
        (cx + S * 0.0034, m['y_nib'] + S * 0.062),
        (cx - S * 0.0034, m['y_nib'] + S * 0.062),
    ]
    dl.polygon([place(p) for p in slit_pts], fill=slit + (170,))

    # 橙色墨点：识别锚点，两套都保留
    tip = place((cx, m['y_tip']))
    dirx = math.sin(math.radians(ANGLE))
    diry = math.cos(math.radians(ANGLE))
    dot_r = S * 0.050
    d = dot_r * 0.80
    dot_c = (tip[0] + dirx * d, tip[1] + diry * d)
    dl.ellipse([dot_c[0] - dot_r, dot_c[1] - dot_r, dot_c[0] + dot_r, dot_c[1] + dot_r],
               fill=ACCENT + (255,))

    return layer.resize((size_px, size_px), Image.LANCZOS)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    outdir = os.path.join(root, 'icon')
    os.makedirs(outdir, exist_ok=True)

    sizes = [16, 24, 32, 48, 64, 128, 180, 256, 512, 1024]
    imgs = {}
    for s in sizes:
        imgs[s] = draw_icon(s)
        print(f'生成 {s}x{s}')

    # 单文件 PNG。16/32 给 HTML favicon 用（浏览器标签页很小，必须单独出小图，
    # 让 180 缩下去会糊）；180 给 apple-touch-icon；256/512/1024 给打包与文档。
    for s in [16, 24, 32, 48, 64, 128, 180, 256, 512, 1024]:
        imgs[s].save(os.path.join(outdir, f'jianji-icon-{s}.png'))

    # 多尺寸 .ico：Windows 会按 DPI 挑最合适的一档
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    imgs[256].save(
        os.path.join(outdir, 'jianji-icon.ico'),
        format='ICO',
        sizes=[(s, s) for s in ico_sizes],
    )
    print(f'已写 icon/jianji-icon.ico（内含 {len(ico_sizes)} 档）与 {len(imgs)} 档 PNG')

    # 顺便导出一份 SVG 版（与 ico 同源几何），供网页/文档用
    write_svg(os.path.join(outdir, 'jianji-icon.svg'))
    print('已写 icon/jianji-icon.svg')

    # ---- 托盘图标：透明底、单色笔身，出 light / dark 两套 ----
    # 16/20/24/32：Windows 托盘按 DPI 挑档（100% / 125% / 150% / 200%）
    # light.ico → 给浅色托盘条（深色笔）；dark.ico → 给深色托盘条（白色笔）
    tray_sizes = [16, 20, 24, 32]
    for on_dark, suffix in ((False, 'light'), (True, 'dark')):
        for s in tray_sizes:
            draw_tray_icon(s, on_dark).save(
                os.path.join(outdir, f'jianji-tray-{s}-{suffix}.png'))
        draw_tray_icon(32, on_dark).save(
            os.path.join(outdir, f'jianji-tray-{suffix}.ico'),
            format='ICO',
            sizes=[(s, s) for s in tray_sizes],
        )
    print('已写 icon/jianji-tray-{light,dark}.ico（各含 %d 档）与对应 PNG' % len(tray_sizes))

    # 预览拼接图，便于肉眼检查
    prev = Image.new('RGBA', (16 + 32 + 64 + 128 + 256 + 4 * 24 + 24, 300), (250, 249, 245, 255))
    x = 12
    for s in [16, 32, 64, 128, 256]:
        prev.paste(imgs[s], (x, 20), imgs[s])
        x += s + 24
    prev.save(os.path.join(root, '.tmp-icon-preview.png'))
    print('已写 .tmp-icon-preview.png')


def write_svg(path):
    """
    导出 24×24 视口的 SVG。坐标用与位图同一组几何参数算出，
    保证网页里的 logo 与应用图标是同一支笔。
    """
    S = 24.0
    m = pen_metrics(S)
    OFF = S * 0.030
    CX = CY = S / 2
    A = 36.0

    def place(x, y):
        return rotate_about((x, y + OFF), CX, CY, A)

    cx, W = m['cx'], m['W']
    body = [
        (cx - W, m['y_tail']), (cx - W, m['y_shoulder']),
        (cx - m['W_grip'], m['y_grip']), (cx - m['W_nib'], m['y_nib']),
        (cx - S * 0.003, m['y_tip']), (cx + S * 0.003, m['y_tip']),
        (cx + m['W_nib'], m['y_nib']), (cx + m['W_grip'], m['y_grip']),
        (cx + W, m['y_shoulder']), (cx + W, m['y_tail']),
    ]
    d = 'M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in map(lambda p: place(*p), body)) + ' Z'

    t = place(cx, m['y_tail'] - W * 0.06)
    seam = [place(cx - W * 1.02, m['y_shoulder']), place(cx + W * 1.02, m['y_shoulder']),
            place(cx + W * 1.02, m['y_shoulder'] + S * 0.009),
            place(cx - W * 1.02, m['y_shoulder'] + S * 0.009)]
    seam_d = 'M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in seam) + ' Z'

    slit = [place(cx - S * 0.0034, m['y_nib'] + S * 0.004),
            place(cx + S * 0.0034, m['y_nib'] + S * 0.004),
            place(cx + S * 0.0034, m['y_nib'] + S * 0.062),
            place(cx - S * 0.0034, m['y_nib'] + S * 0.062)]
    slit_d = 'M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in slit) + ' Z'

    tip = place(cx, m['y_tip'])
    dd = S * 0.050 * 0.80
    dot = (tip[0] + math.sin(math.radians(A)) * dd, tip[1] + math.cos(math.radians(A)) * dd)

    def rgb(c):
        return '#%02x%02x%02x' % c

    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <!-- 简记 · 签字笔标记（由 scripts/make-icon.py 生成，勿手改） -->
  <rect x="0" y="0" width="24" height="24" rx="5.4" fill="{rgb(BG_DARK)}"/>
  <path d="{d}" fill="{rgb(INK)}"/>
  <circle cx="{t[0]:.2f}" cy="{t[1]:.2f}" r="{W:.2f}" fill="{rgb(INK)}"/>
  <path d="{seam_d}" fill="{rgb(BG_DARK)}"/>
  <path d="{slit_d}" fill="#7a776e" opacity=".58"/>
  <circle cx="{dot[0]:.2f}" cy="{dot[1]:.2f}" r="{S * 0.050:.2f}" fill="{rgb(ACCENT)}"/>
</svg>
'''
    with open(path, 'w', encoding='utf-8') as f:
        f.write(svg)


if __name__ == '__main__':
    main()
