# -*- coding: utf-8 -*-
"""生成 GStats 的应用图标（符合飞牛 fnOS 图标规范：圆角矩形主体、sRGB、正方形画布）。"""

from PIL import Image, ImageDraw
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fnos")
S = 1024           # 超采样画布
MARGIN = 62        # 留白
RADIUS = 224       # 圆角
C1 = (37, 99, 235)      # #2563eb
C2 = (56, 189, 248)     # #38bdf8


def build() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. 渐变背景圆角矩形
    grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = grad.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            gd[x, y] = (
                int(C1[0] + (C2[0] - C1[0]) * t),
                int(C1[1] + (C2[1] - C1[1]) * t),
                int(C1[2] + (C2[2] - C1[2]) * t),
                255,
            )
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [MARGIN, MARGIN, S - MARGIN, S - MARGIN], radius=RADIUS, fill=255
    )
    img.paste(grad, (0, 0), mask)

    # 2. 顶部柔光，增加层次
    highlight = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    hd = ImageDraw.Draw(highlight)
    hd.ellipse([-S * 0.35, -S * 0.42, S * 0.95, S * 0.36], fill=(255, 255, 255, 38))
    img = Image.alpha_composite(img, Image.composite(highlight, Image.new("RGBA", img.size, (0, 0, 0, 0)), mask))

    draw = ImageDraw.Draw(img)

    # 3. 柱状图主体（圆角柱）
    bar_color = (255, 255, 255, 235)
    dim_color = (255, 255, 255, 175)
    base_y = S * 0.745
    bars = [
        (S * 0.235, S * 0.135, dim_color),
        (S * 0.360, S * 0.245, bar_color),
        (S * 0.485, S * 0.360, bar_color),
    ]
    bar_w = S * 0.105
    for x, h, color in bars:
        draw.rounded_rectangle(
            [x, base_y - h, x + bar_w, base_y + bar_w * 0.18],
            radius=int(bar_w * 0.42),
            fill=color,
        )

    # 4. 上扬趋势线
    points = [
        (S * 0.255, S * 0.415),
        (S * 0.415, S * 0.315),
        (S * 0.575, S * 0.350),
        (S * 0.735, S * 0.205),
    ]
    draw.line(points, fill=(255, 255, 255, 150), width=int(S * 0.030), joint="curve")
    for i, (px, py) in enumerate(points):
        r = S * 0.020 if i in (0, len(points) - 1) else S * 0.014
        draw.ellipse(
            [px - r, py - r, px + r, py + r],
            fill=(255, 255, 255, 225) if i in (0, len(points) - 1) else (255, 255, 255, 185),
        )

    return img


def main():
    img = build()
    os.makedirs(os.path.join(ROOT, "app", "ui", "images"), exist_ok=True)

    targets = {
        os.path.join(ROOT, "ICON_256.PNG"): 256,
        os.path.join(ROOT, "ICON.PNG"): 64,
        os.path.join(ROOT, "app", "ui", "images", "icon_256.png"): 256,
        os.path.join(ROOT, "app", "ui", "images", "icon_64.png"): 64,
    }
    for path, size in targets.items():
        resized = img.resize((size, size), Image.LANCZOS).convert("RGB")  # sRGB 输出
        resized.save(path, "PNG", optimize=True)
        kb = os.path.getsize(path) / 1024
        print(f"{path}  {size}x{size}  {kb:.1f} KB")


if __name__ == "__main__":
    main()
