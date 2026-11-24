#!/usr/bin/env python3
"""字号放大前后的并排对比图。

Side-by-side before/after boards for the 11px type-floor change. Reads
`screenshots/font-floor/before/*.png` and `after/*.png`, writes
`screenshots/font-floor/compare/*.png`.

Run: python3 web/screenshots/font-floor/compare.py
"""
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROUND = os.environ.get("ROUND", "1")
PAGES = (
    [
        "servers",
        "chain-list",
        "forwards",
        "chain-detail-long",
        "settings",
        "status",
    ]
    if ROUND == "2"
    else [
        "overview-server",
        "overview-traffic",
        "overview-cost",
        "overview-chain",
        "servers",
        "forwards",
        "status",
        "settings",
        "chain-detail-long",
    ]
)
BEFORE_DIR = HERE / os.environ.get("BEFORE_DIR", "before")
AFTER_DIR = HERE / os.environ.get("AFTER_DIR", "after")
OUT_DIR = HERE / os.environ.get("OUT_DIR", "compare")
COMBOS = [
    (1440, "dark"),
    (1440, "light"),
    (390, "dark"),
    (390, "light"),
]
GUTTER = 16
LABEL_H = 34
FONT = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 18)
DARK = (11, 11, 13)
LIGHT = (247, 247, 248)
INK = (235, 235, 240)
INK_LIGHT = (30, 30, 36)


def load(path: Path, background):
    image = Image.open(path).convert("RGB")
    return image


def label_bar(width: int, theme: str, text: str) -> Image.Image:
    bg = DARK if theme == "dark" else LIGHT
    ink = INK if theme == "dark" else INK_LIGHT
    bar = Image.new("RGB", (width, LABEL_H), bg)
    draw = ImageDraw.Draw(bar)
    draw.text((12, 8), text, fill=ink, font=FONT)
    return bar


def main() -> None:
    out = OUT_DIR
    out.mkdir(exist_ok=True)
    for page in PAGES:
        for width, theme in COMBOS:
            name = f"{page}-{width}-{theme}.png"
            before_path = BEFORE_DIR / name
            after_path = AFTER_DIR / name
            if not before_path.exists() or not after_path.exists():
                print(f"skip {name}: missing before/after")
                continue
            bg = DARK if theme == "dark" else LIGHT
            before = load(before_path, bg)
            after = load(after_path, bg)
            height = max(before.height, after.height)
            canvas_w = before.width + GUTTER + after.width
            canvas = Image.new("RGB", (canvas_w, LABEL_H + height), bg)
            canvas.paste(label_bar(before.width, theme, "BEFORE"), (0, 0))
            canvas.paste(
                label_bar(after.width, theme, "AFTER"),
                (before.width + GUTTER, 0),
            )
            canvas.paste(before, (0, LABEL_H))
            canvas.paste(after, (before.width + GUTTER, LABEL_H))
            canvas.save(out / f"compare-{name}")
            print(f"compare-{name}  {canvas_w}x{LABEL_H + height}")


if __name__ == "__main__":
    main()
