# -*- coding: utf-8 -*-
"""从项目根目录 logo.jpeg 生成飞牛 fnOS 规范的应用图标。

规范：ICON.PNG(64x64)、ICON_256.PNG(256x256)、app/ui/images/icon_64.png、
app/ui/images/icon_256.png，sRGB，小于 1024KB。
处理：定位黑色圆形主体 -> 方形裁剪（自动去除角落水印）-> 圆形抗锯齿蒙版
-> 透明四角输出。
"""
from PIL import Image, ImageDraw, ImageOps
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "logo.jpeg")

img = Image.open(SRC).convert("RGB")
w, h = img.size
print(f"source: {w}x{h}")

# 灰度化，找出深色像素（圆主体）的投影，忽略零散水印
gray = ImageOps.grayscale(img)
px = gray.load()
thresh = 120

col_counts = [sum(1 for y in range(h) if px[x, y] < thresh) for x in range(w)]
row_counts = [sum(1 for x in range(w) if px[x, y] < thresh) for y in range(h)]

def span(counts, frac):
    limit = max(counts) * frac
    idx = [i for i, c in enumerate(counts) if c >= limit]
    return (idx[0], idx[-1]) if idx else (0, len(counts) - 1)

left, right = span(col_counts, 0.08)
top, bottom = span(row_counts, 0.08)
size = max(right - left + 1, bottom - top + 1)
cx, cy = (left + right) // 2, (top + bottom) // 2
half = size // 2
box = (max(0, cx - half), max(0, cy - half), min(w, cx + half), min(h, cy + half))
print(f"circle bbox: {box} -> {box[2]-box[0]}x{box[3]-box[1]}")

crop = img.crop(box).convert("RGBA")

def make_icon(px_size: int) -> Image.Image:
    s = crop.resize((px_size, px_size), Image.LANCZOS)
    # 圆形蒙版（4x 超采样抗锯齿）
    ss = px_size * 4
    mask = Image.new("L", (ss, ss), 0)
    ImageDraw.Draw(mask).ellipse((1, 1, ss - 2, ss - 2), fill=255)
    mask = mask.resize((px_size, px_size), Image.LANCZOS)
    s.putalpha(mask)
    return s

targets = [
    (64, os.path.join(ROOT, "fnos", "ICON.PNG")),
    (256, os.path.join(ROOT, "fnos", "ICON_256.PNG")),
    (64, os.path.join(ROOT, "fnos", "app", "ui", "images", "icon_64.png")),
    (256, os.path.join(ROOT, "fnos", "app", "ui", "images", "icon_256.png")),
    (256, os.path.join(ROOT, "fnos", "app", "server", "public", "logo.png")),
    (64, os.path.join(ROOT, "fnos", "app", "server", "public", "logo-64.png")),
]

for px_size, out in targets:
    os.makedirs(os.path.dirname(out), exist_ok=True)
    icon = make_icon(px_size)
    icon.save(out, "PNG")
    kb = os.path.getsize(out) / 1024
    print(f"saved {os.path.relpath(out, ROOT)}  {px_size}x{px_size}  {kb:.1f} KB")

print("done")
