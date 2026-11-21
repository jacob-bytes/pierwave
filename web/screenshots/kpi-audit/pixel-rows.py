#!/usr/bin/env python3
"""把 temporal.json 的曲线几何与 chart-*.png 的像素行对上。

对每张被测迷你图，按 SVG 实际 stroke 颜色逐行数像素，输出：
- 线条在设备像素里的行区间、换算成 CSS px 的中心 y；
- 线宽（CSS px）；
- 距离图表底边的 CSS px（<0.5px 视为「贴底」）；
- 同时保留 path 几何算出的 y / 高度，方便和像素结果互证。

用法：
  python3 web/screenshots/kpi-audit/pixel-rows.py
"""
import json
from collections import Counter
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
CHART_INDEX = {
    "temporal-spike-rate": 2,
    "temporal-spike-latency": 0,
    "temporal-spike-uptime": 1,
    "dual-gap-rx-high": 2,
    "dual-gap-tx-high": 2,
}
KIND_NAME = {0: "latency", 1: "uptime", 2: "rate"}


def groups(rows):
    result = []
    current = []
    for row, count in rows:
        if current and row == current[-1][0] + 1:
            current.append((row, count))
        else:
            if current:
                result.append(current)
            current = [(row, count)]
    if current:
        result.append(current)
    return result


def main():
    report = json.loads((HERE / "temporal.json").read_text())
    output = []
    for job in report["jobs"]:
        if job["locale"] != "zh-CN":
            continue
        if job["theme"] != "dark" and job["width"] != 1440:
            continue
        fixture = job["fixture"]
        index = CHART_INDEX[fixture]
        chart = job["metrics"]["columns"][index]["chart"]
        if chart["state"] != "ready":
            continue
        kind = KIND_NAME[index]
        image_path = (
            HERE
            / "shots"
            / f"chart-{fixture}-{kind}-{job['theme']}-{job['width']}.png"
        )
        if not image_path.exists():
            continue
        image = Image.open(image_path).convert("RGB")
        width, height = image.size
        css_height = chart["cssHeight"]
        dpr = round(height / css_height, 3)
        payload = {
            "fixture": fixture,
            "kind": kind,
            "theme": job["theme"],
            "width": job["width"],
            "image": str(image_path.relative_to(HERE)),
            "imagePx": {"width": width, "height": height},
            "cssSize": {"width": chart["cssWidth"], "height": css_height},
            "dpr": dpr,
            "background": Counter(image.getdata()).most_common(1)[0][0],
            "lines": [],
        }
        for line in chart["lines"]:
            stroke = tuple(line["strokeRgb"])
            rows = []
            for y in range(height):
                count = 0
                for x in range(width):
                    pixel = image.getpixel((x, y))
                    distance = sum(
                        (pixel[channel] - stroke[channel]) ** 2
                        for channel in range(3)
                    )
                    if distance <= 32**2:
                        count += 1
                if count >= 3:
                    rows.append((y, count))
            segments = groups(rows)
            # 取像素最多的一段当作水平线主体；折线可能只有很少像素。
            primary = max(segments, key=lambda seg: sum(c for _, c in seg)) if segments else []
            if primary:
                top = primary[0][0] / dpr
                bottom = (primary[-1][0] + 1) / dpr
                center = (top + bottom) / 2
            else:
                top = bottom = center = None
            payload["lines"].append(
                {
                    "index": line["index"],
                    "strokeRgb": line["strokeRgb"],
                    "stroke": line["stroke"],
                    "strokeWidthCss": line["strokeWidth"],
                    "geometry": {
                        "yMinViewBox": line["yMin"],
                        "yMaxViewBox": line["yMax"],
                        "yMinCss": line["yMinCss"],
                        "yMaxCss": line["yMaxCss"],
                        "rangeCss": line["yRangeCss"],
                        "bottomGapCss": line["bottomGapCss"],
                    },
                    "pixels": {
                        "rowGroups": [
                            {
                                "deviceRows": [seg[0][0], seg[-1][0]],
                                "maxCount": max(c for _, c in seg),
                            }
                            for seg in segments
                        ],
                        "mainGroupCss": {
                            "top": round(top, 2) if top is not None else None,
                            "bottom": round(bottom, 2) if bottom is not None else None,
                            "center": round(center, 2) if center is not None else None,
                        },
                        "thicknessCss": round(bottom - top, 2)
                        if top is not None
                        else None,
                        "bottomGapCss": round(css_height - bottom, 2)
                        if bottom is not None
                        else None,
                        "touchesBottom": (css_height - bottom) < 0.75
                        if bottom is not None
                        else None,
                    },
                }
            )
        output.append(payload)
    (HERE / "pixel-rows.json").write_text(
        json.dumps(output, indent=2, ensure_ascii=False)
    )
    for item in output:
        print(
            f"\n{item['fixture']} {item['kind']} {item['theme']} {item['width']} "
            f"({item['imagePx']['width']}x{item['imagePx']['height']} @{item['dpr']}x)"
        )
        for line in item["lines"]:
            geometry = line["geometry"]
            pixels = line["pixels"]
            print(
                f"  line {line['index']}: geom y {geometry['yMinCss']}–{geometry['yMaxCss']}px "
                f"(range {geometry['rangeCss']}px, bottomGap {geometry['bottomGapCss']}px) | "
                f"pixel rows {pixels['rowGroups']} -> center {pixels['mainGroupCss']['center']}px, "
                f"thickness {pixels['thicknessCss']}px, bottomGap {pixels['bottomGapCss']}px, "
                f"touchesBottom={pixels['touchesBottom']}"
            )


if __name__ == "__main__":
    main()
