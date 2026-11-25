import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MIN_SERIES_OPACITY,
  SERIES_TOKEN_COUNT,
  seriesVisual,
} from "./seriesStyle.ts";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

/** CSS 里的亮色主题块（`[data-theme="light"] { … }`）。 */
function lightThemeBlock(css) {
  const marker = '[data-theme="light"]';
  const start = css.indexOf(marker);
  assert.ok(start >= 0, "index.css is missing the light theme");
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error("unterminated light theme block");
}

function parseOklch(value) {
  const match =
    /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(value.trim());
  assert.ok(match, `not an oklch color: ${value}`);
  return {
    l: Number(match[1]),
    c: Number(match[2]),
    h: Number(match[3]),
  };
}

/** OKLCH → 线性 sRGB → 相对亮度（WCAG 2.x）。 */
function relativeLuminance(oklch) {
  const hue = (oklch.h * Math.PI) / 180;
  const a = oklch.c * Math.cos(hue);
  const b = oklch.c * Math.sin(hue);
  const l = oklch.l + 0.3963377774 * a + 0.2158037573 * b;
  const m = oklch.l - 0.1055613458 * a - 0.0638541728 * b;
  const s = oklch.l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;
  const red = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const green = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const blue = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
  const clamp = (channel) => Math.max(0, Math.min(1, channel));
  return (
    0.2126 * clamp(red) + 0.7152 * clamp(green) + 0.0722 * clamp(blue)
  );
}

function contrast(foreground, background) {
  const [light, dark] = [foreground, background].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test("first four series use --series-1..4 and a dash from the second on", () => {
  assert.equal(SERIES_TOKEN_COUNT, 4);
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => seriesVisual(index)),
    [
      { color: "var(--series-1)", opacity: 1, dash: undefined },
      { color: "var(--series-2)", opacity: 1, dash: "7 4" },
      { color: "var(--series-3)", opacity: 1, dash: "2 3" },
      { color: "var(--series-4)", opacity: 1, dash: "10 3 2 3" },
    ],
  );
});

test("more than four series keep a dash and never fade below 0.55", () => {
  for (let index = 4; index < 16; index += 1) {
    const visual = seriesVisual(index);
    assert.ok(visual.opacity >= MIN_SERIES_OPACITY, `opacity at ${index}`);
    assert.match(visual.color, /^var\(--series-[1-4]\)$/);
    assert.equal(typeof visual.dash, "string");
    assert.ok(visual.dash.length > 0);
  }
  assert.equal(MIN_SERIES_OPACITY, 0.55);
});

test("light theme --series-1..4 each reach 3:1 against the card", () => {
  const css = read("index.css");
  const light = lightThemeBlock(css);
  const card = parseOklch(/--card:\s*([^;]+);/.exec(light)[1]);
  const cardLuminance = relativeLuminance(card);
  for (let step = 1; step <= SERIES_TOKEN_COUNT; step += 1) {
    const match = new RegExp(`--series-${step}:\\s*([^;]+);`).exec(light);
    assert.ok(match, `missing --series-${step} in light theme`);
    const ratio = contrast(relativeLuminance(parseOklch(match[1])), cardLuminance);
    assert.ok(
      ratio >= 3,
      `--series-${step} contrast ${ratio.toFixed(2)}:1 must be >= 3:1`,
    );
  }
});

test("both line chart families consume the shared series visuals", () => {
  for (const file of [
    "lib/chainSeriesStyle.ts",
    "components/overview/ChainSegmentTrendChart.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /seriesVisual/, `${file} must use seriesVisual`);
    assert.doesNotMatch(source, /OPACITY_LADDER/, `${file} ladder is replaced`);
  }
  // 整体趋势图通过共享 swatch 使用同一套线型，不再各自拼颜色。
  const trend = read("components/overview/ChainLatencyTrendChart.tsx");
  assert.match(trend, /ChainSeriesSwatch/);
  assert.match(trend, /lineVisual/);
});
