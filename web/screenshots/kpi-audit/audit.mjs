#!/usr/bin/env node
/**
 * hero 三个 KPI 的极值审计 / Extreme-value audit for the three hero KPIs.
 *
 * - 拦截 `GET /api/v1/public/status`，不启动后端、不写库、不改 `web/src`；
 * - 33 个 fixture × 1440/390 × 亮/暗 × 中/英，全部跑几何与对比度测量；
 * - 选定的组合额外落截图（hero 卡片 + 少量整页），tooltip / 键盘单独测；
 * - 结果写 `report.json`，截图写 `shots/`。
 *
 * 用法 / Usage:
 *   (cd web && npm run build && npx vite preview --port 4173 --strictPort)
 *   node web/screenshots/kpi-audit/audit.mjs
 *
 * 环境变量：BASE_URL、PLAYWRIGHT_MODULE、CHROME_PATH、KPI_FILTER（fixture 名）。
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FIXTURE_NAMES,
  LABEL_TO_LONG,
  kpiFixture,
} from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SHOTS = path.join(HERE, "shots");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4173";
const HERO = 'main [data-slot="card"][role="group"]';
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];
const THEMES = ["dark", "light"];
const LOCALES = ["zh-CN", "en"];
const FILTER = process.env.KPI_FILTER
  ? new Set(process.env.KPI_FILTER.split(","))
  : null;
const FIXTURES = FILTER
  ? FIXTURE_NAMES.filter((name) => FILTER.has(name))
  : FIXTURE_NAMES;
/** 容器挤压模式：只跑 1280/1100/1024/768 这段 lg 断点附近。 */
const SQUEEZE = process.env.KPI_MODE === "squeeze";
const SQUEEZE_WIDTHS = [
  { width: 1280, height: 1000 },
  { width: 1100, height: 1000 },
  { width: 1024, height: 1000 },
  { width: 768, height: 1000 },
];
const SQUEEZE_FIXTURES = new Set([
  "baseline",
  "rate-999gb-single",
  "rate-8x500gb",
  "rate-boundary-1024",
  "rate-1024-both",
  "rate-both-missing",
  "uptime-0",
  "latency-9999",
  "longtext-simulated",
]);
const OUTPUT_NAME = process.env.KPI_OUT ?? "report";

/** tooltip / 键盘只在对照 fixture 上测，避免 264 次页面加载都多花 1 秒。 */
const TOOLTIP_FIXTURES = new Set([
  "baseline",
  "rate-999gb-single",
  "rate-8x500gb",
  "rate-1024-both",
  "rate-both-missing",
  "latency-12345",
  "longtext-simulated",
]);
const KEYBOARD_FIXTURES = new Set(["baseline"]);

/** A/B 两组时序 / 量级场景：截图用 2× DPR，方便做像素行测量。 */
const TEMPORAL_FIXTURES = new Set([
  "temporal-spike-rate",
  "temporal-spike-latency",
  "temporal-spike-uptime",
  "dual-gap-rx-high",
  "dual-gap-tx-high",
]);
const TEMPORAL_CHART = {
  "temporal-spike-rate": 2,
  "temporal-spike-latency": 0,
  "temporal-spike-uptime": 1,
  "dual-gap-rx-high": 2,
  "dual-gap-tx-high": 2,
};

/** 整页截图（看 390 下 hero 与卡片的关系），其余只截 hero 卡片。 */
const VIEWPORT_SHOT_FIXTURES = new Set([
  "baseline",
  "rate-8x500gb",
  "rate-1024-both",
  "rate-both-missing",
  "uptime-0",
  "latency-9999",
  "series-all-null",
  "longtext-simulated",
]);

mkdirSync(SHOTS, { recursive: true });

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const npxRoot = path.join(ROOT, ".npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(
        path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs"),
      );
    }
  }
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (mod.chromium) return mod.chromium;
    } catch {
      /* 试下一个 */
    }
  }
  try {
    const mod = await import("playwright");
    if (mod.chromium) return mod.chromium;
  } catch {
    /* 落到下面的报错 */
  }
  throw new Error("找不到 playwright。设置 PLAYWRIGHT_MODULE 或安装 playwright。");
}

function chromePath() {
  return [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]
    .filter(Boolean)
    .find((candidate) => existsSync(candidate));
}

const chromium = await loadPlaywright();
const browser = await chromium.launch({
  headless: true,
  ...(chromePath() ? { executablePath: chromePath() } : {}),
});

const jobs = [];
const consoleErrors = [];

/** 页面内测量：几何、字号、对齐、溢出、对比度全部在浏览器里取计算值。 */
function measureInPage() {
  const round = (value) => Math.round(value * 100) / 100;
  const rectOf = (rect) => ({
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
    top: round(rect.top),
    right: round(rect.right),
    bottom: round(rect.bottom),
    left: round(rect.left),
  });
  const box = (element) =>
    element ? rectOf(element.getBoundingClientRect()) : null;
  const styleOf = (element) => {
    if (!element) return null;
    const style = getComputedStyle(element);
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      fontWeight: style.fontWeight,
      fontFamily: style.fontFamily,
      fontVariantNumeric: style.fontVariantNumeric,
      color: style.color,
      whiteSpace: style.whiteSpace,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      display: style.display,
    };
  };
  const firstTextNode = (element) => {
    if (!element) return null;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim()) return node;
    }
    return null;
  };
  const textBox = (element) => {
    const node = firstTextNode(element);
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    return rectOf(range.getBoundingClientRect());
  };
  /** 在元素里塞一个 0×0、baseline 对齐的探针，取回真实基线 y。 */
  const baselineOf = (element) => {
    if (!element) return null;
    const probe = document.createElement("span");
    probe.style.cssText =
      "display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline";
    element.appendChild(probe);
    const y = probe.getBoundingClientRect().bottom;
    probe.remove();
    return round(y);
  };

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (color) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#010203";
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2], data[3] / 255];
  };
  const composite = (top, bottom) => {
    const alpha = top[3];
    return [
      top[0] * alpha + bottom[0] * (1 - alpha),
      top[1] * alpha + bottom[1] * (1 - alpha),
      top[2] * alpha + bottom[2] * (1 - alpha),
      1,
    ];
  };
  const luminance = (color) => {
    const channel = (value) => {
      const normalized = value / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    return (
      0.2126 * channel(color[0]) +
      0.7152 * channel(color[1]) +
      0.0722 * channel(color[2])
    );
  };
  const contrast = (element) => {
    if (!element) return null;
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const layer = rgba(getComputedStyle(node).backgroundColor);
      if (layer[3] > 0) layers.push(layer);
    }
    let background = [255, 255, 255, 1];
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      background = composite(layers[index], background);
    }
    const foreground = composite(rgba(getComputedStyle(element).color), background);
    const first = luminance(foreground);
    const second = luminance(background);
    return {
      ratio: round(
        (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
      ),
      color: getComputedStyle(element).color,
      background: `rgb(${Math.round(background[0])} ${Math.round(
        background[1],
      )} ${Math.round(background[2])})`,
    };
  };
  const overflowOf = (element) =>
    element
      ? {
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          x: element.scrollWidth - element.clientWidth,
        }
      : null;

  const card = document.querySelector('main [data-slot="card"][role="group"]');
  if (!card) return { error: "hero card not found" };
  const stats = card.querySelector("div.grid");
  const columns = stats ? [...stats.children] : [];
  const cardStyle = getComputedStyle(card);
  const cardRect = card.getBoundingClientRect();
  const padding = {
    left: parseFloat(cardStyle.paddingLeft),
    right: parseFloat(cardStyle.paddingRight),
    top: parseFloat(cardStyle.paddingTop),
    bottom: parseFloat(cardStyle.paddingBottom),
  };
  const content = {
    left: round(cardRect.left + padding.left),
    right: round(cardRect.right - padding.right),
    top: round(cardRect.top + padding.top),
    bottom: round(cardRect.bottom - padding.bottom),
  };

  const measureColumn = (column, index) => {
    const inner = column.children[0];
    const label = inner.children[0];
    const row = inner.children[1];
    const chartWrap = column.children[1];
    const chart = chartWrap.querySelector('[data-slot="hero-sparkline"]');
    const chartRect = box(chart);
    const value = { kind: "unknown" };

    if (index === 0) {
      // 有读数时是 `span.inline-flex`（数字 + unit），null 时是一个普通
      // span 里的 `—`；两者都要量，否则 null 态的字号 / 对比度会漏掉。
      const display =
        row.querySelector("span.inline-flex") ?? row.querySelector("span");
      const unit = display ? display.querySelector("span") : null;
      value.kind = "latency";
      value.display = display?.textContent.trim() ?? null;
      value.box = box(display);
      value.number = textBox(display);
      value.style = styleOf(display);
      value.baseline = baselineOf(display);
      value.contrast = contrast(display);
      value.unit = unit
        ? {
            text: unit.textContent.trim(),
            box: box(unit),
            style: styleOf(unit),
            contrast: contrast(unit),
          }
        : null;
    } else if (index === 1) {
      const display = row.querySelector("span");
      value.kind = "uptime";
      value.display = display?.textContent.trim() ?? null;
      value.box = box(display);
      value.number = textBox(display);
      value.style = styleOf(display);
      value.baseline = baselineOf(display);
      value.contrast = contrast(display);
      value.unit = null;
      value.percentInline = true;
    } else {
      const first = row.firstElementChild;
      if (first && first.tagName === "SPAN") {
        value.kind = "rate-single-dash";
        value.display = first.textContent.trim();
        value.box = box(first);
        value.number = textBox(first);
        value.style = styleOf(first);
        value.baseline = baselineOf(first);
        value.contrast = contrast(first);
        value.unit = null;
      } else if (first) {
        value.kind = "rate-pair";
        value.title = first.getAttribute("title");
        value.directions = [...first.children].map((direction) => {
          const display =
            direction.querySelector("span.tnum") ||
            direction.querySelector("span.text-base");
          const unit = display ? display.querySelector("span") : null;
          const srOnly = direction.querySelector(".sr-only");
          const icon = direction.querySelector("svg");
          return {
            label: srOnly?.textContent.trim() ?? null,
            text: direction.textContent.replace(/\s+/g, " ").trim(),
            display: display?.textContent.trim() ?? null,
            box: box(direction),
            number: textBox(display),
            style: styleOf(display),
            baseline: baselineOf(display || direction),
            contrast: contrast(display || direction),
            unit: unit
              ? {
                  text: unit.textContent.trim(),
                  box: box(unit),
                  style: styleOf(unit),
                  contrast: contrast(unit),
                }
              : null,
            icon: box(icon),
            unitClippedByIconOrNumber: null,
          };
        });
        value.box = box(first);
        value.overflow = overflowOf(first);
      }
    }

    const emptyLabel = chart?.querySelector("span.relative");
    const svg = chart?.querySelector("svg");
    // 曲线几何：把 viewBox（240×48）里的 path 坐标换算成 CSS 像素，
    // 用来回答「小值离底多少 px、两条线差多少 px、线宽多少」。
    const chartHeight = chartRect?.height ?? 0;
    const chartWidth = chartRect?.width ?? 0;
    const lineGeometry = svg
      ? [...svg.querySelectorAll('path[stroke]:not([stroke="none"])')].map(
          (pathElement, lineIndex) => {
            const d = pathElement.getAttribute("d") ?? "";
            const points = [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map(
              (match) => [Number(match[1]), Number(match[2])],
            );
            const ys = points.map((point) => point[1]);
            const xs = points.map((point) => point[0]);
            const computed = getComputedStyle(pathElement);
            const stroke = rgba(computed.stroke);
            return {
              index: lineIndex,
              className: pathElement.getAttribute("class") ?? "",
              segments: (d.match(/M/g) ?? []).length,
              pointCount: points.length,
              yMin: ys.length ? round(Math.min(...ys)) : null,
              yMax: ys.length ? round(Math.max(...ys)) : null,
              yRange: ys.length
                ? round(Math.max(...ys) - Math.min(...ys))
                : null,
              xMin: xs.length ? round(Math.min(...xs)) : null,
              xMax: xs.length ? round(Math.max(...xs)) : null,
              // 曲线最高 / 最低点换算到 CSS 像素后的位置与离底距离。
              yMinCss: ys.length
                ? round((Math.min(...ys) / 48) * chartHeight)
                : null,
              yMaxCss: ys.length
                ? round((Math.max(...ys) / 48) * chartHeight)
                : null,
              yRangeCss: ys.length
                ? round(((Math.max(...ys) - Math.min(...ys)) / 48) * chartHeight)
                : null,
              bottomGapCss: ys.length
                ? round(chartHeight - (Math.max(...ys) / 48) * chartHeight)
                : null,
              topGapCss: ys.length
                ? round((Math.min(...ys) / 48) * chartHeight)
                : null,
              pointsCss: points.map(([x, y]) => ({
                x: round((x / 240) * chartWidth),
                y: round((y / 48) * chartHeight),
              })),
              stroke: computed.stroke,
              strokeRgb: stroke.slice(0, 3),
              strokeWidthAttr: pathElement.getAttribute("stroke-width"),
              strokeWidth: computed.strokeWidth,
              vectorEffect: computed.vectorEffect,
            };
          },
        )
      : [];
    return {
      index,
      label: {
        text: label.textContent.trim(),
        box: box(label),
        style: styleOf(label),
        overflow: overflowOf(label),
        contrast: contrast(label),
      },
      row: {
        box: box(row),
        style: styleOf(row),
        overflow: overflowOf(row),
      },
      value,
      chart: {
        kind: chart?.dataset.kind ?? null,
        state: chart?.dataset.state ?? null,
        box: chartRect,
        bottom: chartRect?.bottom ?? null,
        aria: chart?.getAttribute("aria-label") ?? null,
        svgTabIndex: svg ? svg.tabIndex : null,
        svgTabindexAttr: svg?.getAttribute("tabindex") ?? null,
        cssWidth: round(chartWidth),
        cssHeight: round(chartHeight),
        viewBoxWidth: 240,
        viewBoxHeight: 48,
        lines: lineGeometry,
        emptyLabel: emptyLabel
          ? {
              text: emptyLabel.textContent.trim(),
              box: box(emptyLabel),
              style: styleOf(emptyLabel),
              contrast: contrast(emptyLabel),
            }
          : null,
      },
      column: {
        box: box(column),
        overflow: overflowOf(column),
      },
    };
  };

  return {
    card: {
      box: box(card),
      overflow: overflowOf(card),
      padding,
      content,
      background: getComputedStyle(card).backgroundColor,
    },
    stats: { box: box(stats), overflow: overflowOf(stats) },
    columns: columns.map(measureColumn),
    page: {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      innerWidth: window.innerWidth,
      scrollHeight: document.documentElement.scrollHeight,
      bodyScrollWidth: document.body.scrollWidth,
      theme: document.documentElement.dataset.theme ?? null,
      darkClass: document.documentElement.classList.contains("dark"),
      lang: document.documentElement.lang,
    },
    footnote: box(card.lastElementChild),
  };
}

function clipReport(metrics) {
  if (!metrics || metrics.error) return { clipped: [], overlaps: [] };
  const content = metrics.card.content;
  const items = [];
  for (const column of metrics.columns) {
    items.push({
      what: `${column.label.text} · label`,
      rect: column.label.box,
      scroll: column.label.overflow,
    });
    if (column.value.kind === "rate-pair") {
      for (const direction of column.value.directions) {
        items.push({
          what: `rate ${direction.label ?? "?"} · number`,
          rect: direction.box,
          scroll: null,
        });
        if (direction.unit) {
          items.push({
            what: `rate ${direction.label ?? "?"} · unit`,
            rect: direction.unit.box,
            scroll: null,
          });
        }
      }
    } else {
      items.push({
        what: `${column.value.kind} · number`,
        rect: column.value.number,
        scroll: null,
      });
      if (column.value.unit) {
        items.push({
          what: `${column.value.kind} · unit`,
          rect: column.value.unit.box,
          scroll: null,
        });
      }
    }
  }

  const clipped = [];
  for (const item of items) {
    if (!item.rect) continue;
    const sides = [];
    if (item.rect.left < content.left - 0.5) sides.push("left");
    if (item.rect.right > content.right + 0.5) sides.push("right");
    if (item.rect.top < content.top - 0.5) sides.push("top");
    if (item.rect.bottom > content.bottom + 0.5) sides.push("bottom");
    if (sides.length > 0) clipped.push({ ...item, sides });
    else if (item.scroll && item.scroll.x > 1) {
      clipped.push({ ...item, sides: ["scroll-truncate"] });
    }
  }

  const overlaps = [];
  for (const column of metrics.columns) {
    if (!column.chart.box) continue;
    if (column.value.kind === "rate-pair") {
      for (const direction of column.value.directions) {
        for (const [name, rect] of [
          ["number", direction.box],
          ["unit", direction.unit?.box],
        ]) {
          if (!rect) continue;
          const hit =
            rect.left < column.chart.box.right &&
            rect.right > column.chart.box.left &&
            rect.top < column.chart.box.bottom &&
            rect.bottom > column.chart.box.top;
          if (hit) {
            overlaps.push({
              what: `rate ${direction.label ?? "?"} ${name}`,
              rect,
              chart: column.chart.box,
            });
          }
        }
      }
    }
  }
  return { clipped, overlaps };
}

async function runJob({ fixture, locale, theme, width, height }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: TEMPORAL_FIXTURES.has(fixture) ? 2 : 1,
    colorScheme: theme,
    locale: locale === "en" ? "en-US" : "zh-CN",
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    ({ theme, locale }) => {
      window.localStorage.setItem("pierwave.theme", theme);
      window.localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale },
  );
  const page = await context.newPage();
  const label = `${fixture} ${locale} ${theme} ${width}`;
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });

  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/v1/public/status")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(kpiFixture(fixture)),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });

  await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
  await page.locator(HERO).waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-slot="hero-sparkline"]').length === 3,
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

  // 长标签压力：只改 DOM 文本，不改源码；只在英文下执行。
  let labelOverride = null;
  if (fixture === "longtext-simulated" && locale === "en") {
    labelOverride = await page.evaluate((map) => {
      const hero = document.querySelector(
        'main [data-slot="card"][role="group"]',
      );
      const changed = [];
      for (const element of hero.querySelectorAll("div.truncate")) {
        const from = element.textContent.trim();
        if (map[from]) {
          element.textContent = map[from];
          changed.push({ from, to: map[from] });
        }
      }
      return changed;
    }, LABEL_TO_LONG);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  }

  const metrics = await page.evaluate(measureInPage);
  const clipping = clipReport(metrics);

  const squeezeWidth = [1280, 1100, 1024, 768].includes(width);
  const temporal = TEMPORAL_FIXTURES.has(fixture);
  const screenshotPolicy =
    temporal ||
    (theme === "dark" && locale === "zh-CN") ||
    (theme === "light" && locale === "zh-CN" && width === 1440) ||
    (theme === "dark" && locale === "en" && (width === 1440 || squeezeWidth)) ||
    (fixture === "longtext-simulated" && locale === "en");

  const files = [];
  const heroLocator = page.locator(HERO).first();
  if (screenshotPolicy) {
    const file = path.join(
      SHOTS,
      temporal
        ? `${fixture}-${locale}-${theme}-${width}.png`
        : `hero-${fixture}-${locale}-${theme}-${width}.png`,
    );
    await heroLocator.screenshot({ path: file, animations: "disabled" });
    files.push(path.relative(HERE, file));
  }

  // A/B 场景额外截被测迷你图本身（2× DPR），供像素行分析。
  if (
    temporal &&
    locale === "zh-CN" &&
    (theme === "dark" || width === 1440)
  ) {
    const chartKind = TEMPORAL_CHART[fixture];
    const chart = page
      .locator('[data-slot="hero-sparkline"]')
      .nth(chartKind);
    const kindName =
      chartKind === 0 ? "latency" : chartKind === 1 ? "uptime" : "rate";
    const file = path.join(
      SHOTS,
      `chart-${fixture}-${kindName}-${theme}-${width}.png`,
    );
    await chart.screenshot({ path: file, animations: "disabled" });
    files.push(path.relative(HERE, file));
  }
  if (
    VIEWPORT_SHOT_FIXTURES.has(fixture) &&
    locale === "zh-CN" &&
    theme === "dark" &&
    width === 390
  ) {
    const file = path.join(
      SHOTS,
      `page-${fixture}-${locale}-${theme}-${width}.png`,
    );
    await page.screenshot({ path: file, animations: "disabled" });
    files.push(path.relative(HERE, file));
  }

  // ---- tooltip：贴右边缘 / 贴左边缘 -------------------------------------------------
  let tooltip = null;
  let tooltipLeft = null;
  let tooltipFirstRow = null;
  if (TOOLTIP_FIXTURES.has(fixture)) {
    const probe = async (chartIndex, ratio) => {
      const chart = page.locator('[data-slot="hero-sparkline"]').nth(chartIndex);
      const chartBox = await chart.boundingBox();
      if (!chartBox) return null;
      await page.mouse.move(
        chartBox.x + chartBox.width * ratio,
        chartBox.y + chartBox.height / 2,
      );
      await page.waitForTimeout(120);
      const tip = page.locator('[data-slot="hero-sparkline-tooltip"]').first();
      if ((await tip.count()) === 0) return { visible: false };
      return tip.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          visible: true,
          text: element.innerText.replace(/\s+/g, " ").trim(),
          rect: {
            left: Math.round(rect.left * 100) / 100,
            right: Math.round(rect.right * 100) / 100,
            top: Math.round(rect.top * 100) / 100,
            bottom: Math.round(rect.bottom * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          },
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          ariaHidden: element.getAttribute("aria-hidden"),
          lines: [...element.querySelectorAll("div")].map((row) =>
            row.textContent.replace(/\s+/g, " ").trim(),
          ),
        };
      });
    };

    tooltip = await probe(2, 0.98);
    if (tooltip?.visible) {
      const cardBox = await heroLocator.boundingBox();
      const viewport = page.viewportSize();
      tooltip.clippedByCard = {
        left: tooltip.rect.left < cardBox.x - 0.5,
        right:
          tooltip.rect.right > cardBox.x + cardBox.width + 0.5,
        top: tooltip.rect.top < cardBox.y - 0.5,
        bottom:
          tooltip.rect.bottom > cardBox.y + cardBox.height + 0.5,
      };
      tooltip.clippedByViewport = {
        left: tooltip.rect.left < 0,
        right: tooltip.rect.right > viewport.width,
        top: tooltip.rect.top < 0,
        bottom: tooltip.rect.bottom > viewport.height,
      };
    }
    if (
      width === 390 &&
      theme === "dark" &&
      locale === "zh-CN" &&
      tooltip?.visible
    ) {
      const file = path.join(
        SHOTS,
        `tooltip-right-${fixture}-${locale}-${theme}-${width}.png`,
      );
      await heroLocator.screenshot({ path: file, animations: "disabled" });
      files.push(path.relative(HERE, file));
    }

    tooltipLeft = await probe(2, 0.02);
    if (tooltipLeft?.visible) {
      const cardBox = await heroLocator.boundingBox();
      tooltipLeft.clippedByCard = {
        left: tooltipLeft.rect.left < cardBox.x - 0.5,
        right:
          tooltipLeft.rect.right > cardBox.x + cardBox.width + 0.5,
        top: tooltipLeft.rect.top < cardBox.y - 0.5,
        bottom:
          tooltipLeft.rect.bottom > cardBox.y + cardBox.height + 0.5,
      };
    }
    if (
      width === 390 &&
      theme === "dark" &&
      locale === "zh-CN" &&
      tooltipLeft?.visible
    ) {
      const file = path.join(
        SHOTS,
        `tooltip-left-${fixture}-${locale}-${theme}-${width}.png`,
      );
      await heroLocator.screenshot({ path: file, animations: "disabled" });
      files.push(path.relative(HERE, file));
    }

    // 390 下第一行（延迟）的图离卡片上缘最近：tooltip 向上弹可能被
    // `Card` 的 overflow-hidden 裁掉。这正是「贴近边缘」最坏的方向。
    if (width === 390) {
      tooltipFirstRow = await probe(0, 0.5);
      if (tooltipFirstRow?.visible) {
        const cardBox = await heroLocator.boundingBox();
        const viewport = page.viewportSize();
        tooltipFirstRow.clippedByCard = {
          left: tooltipFirstRow.rect.left < cardBox.x - 0.5,
          right:
            tooltipFirstRow.rect.right > cardBox.x + cardBox.width + 0.5,
          top: tooltipFirstRow.rect.top < cardBox.y - 0.5,
          bottom:
            tooltipFirstRow.rect.bottom > cardBox.y + cardBox.height + 0.5,
        };
        tooltipFirstRow.clippedByViewport = {
          left: tooltipFirstRow.rect.left < 0,
          right: tooltipFirstRow.rect.right > viewport.width,
          top: tooltipFirstRow.rect.top < 0,
          bottom: tooltipFirstRow.rect.bottom > viewport.height,
        };
      }
      if (
        theme === "dark" &&
        locale === "zh-CN" &&
        tooltipFirstRow?.visible
      ) {
        const file = path.join(
          SHOTS,
          `tooltip-firstrow-${fixture}-${locale}-${theme}-${width}.png`,
        );
        await heroLocator.screenshot({ path: file, animations: "disabled" });
        files.push(path.relative(HERE, file));
      }
    }
    await page.mouse.move(0, 0);
  }

  // ---- 键盘：SVG 是否可聚焦、Tab 是否能走到图 ------------------------------------
  let keyboard = null;
  let tabTrail = null;
  if (KEYBOARD_FIXTURES.has(fixture)) {
    keyboard = await page.evaluate(() => {
      const charts = [
        ...document.querySelectorAll('[data-slot="hero-sparkline"]'),
      ];
      const svgs = charts
        .map((chart) => chart.querySelector("svg"))
        .filter(Boolean);
      let focused = 0;
      for (const svg of svgs) {
        svg.focus();
        if (document.activeElement === svg) focused += 1;
      }
      return {
        charts: charts.length,
        svgs: svgs.length,
        tabIndex: svgs.map((svg) => svg.tabIndex),
        tabindexAttr: svgs.map((svg) => svg.getAttribute("tabindex")),
        focusSucceeded: focused,
        focusAfterAttempt: document.activeElement?.tagName ?? null,
        activeElementInChart: svgs.some(
          (svg) => document.activeElement === svg,
        ),
      };
    });

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    tabTrail = [];
    for (let index = 0; index < 24; index += 1) {
      await page.keyboard.press("Tab");
      const entry = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active) return null;
        return {
          tag: active.tagName,
          insideChart: Boolean(active.closest('[data-slot="hero-sparkline"]')),
          text: (active.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40),
          aria: active.getAttribute?.("aria-label") ?? null,
        };
      });
      tabTrail.push(entry);
    }
    keyboard.tabReachedChart = tabTrail.some((entry) => entry?.insideChart);
    keyboard.tabTrail = tabTrail;
    keyboard.tooltipAfterTab = await page
      .locator('[data-slot="hero-sparkline-tooltip"]')
      .count();
  }

  const result = {
    fixture,
    locale,
    theme,
    width,
    height,
    labelOverride,
    errors,
    metrics,
    clipping,
    tooltip,
    tooltipLeft,
    tooltipFirstRow,
    keyboard,
    screenshots: files,
  };
  await context.close();
  return result;
}

const startedAt = new Date().toISOString();
const MATRIX = SQUEEZE
  ? FIXTURES.filter((fixture) => SQUEEZE_FIXTURES.has(fixture)).flatMap(
      (fixture) =>
        LOCALES.flatMap((locale) =>
          THEMES.flatMap((theme) =>
            SQUEEZE_WIDTHS.map((size) => ({ fixture, locale, theme, ...size })),
          ),
        ),
    )
  : FIXTURES.flatMap((fixture) =>
      LOCALES.flatMap((locale) =>
        THEMES.flatMap((theme) =>
          WIDTHS.map((size) => ({ fixture, locale, theme, ...size })),
        ),
      ),
    );

for (const spec of MATRIX) {
  {
    {
      {
        const job = await runJob(spec);
        jobs.push(job);
        if (job.errors.length > 0) {
          consoleErrors.push({
            label: `${spec.fixture} ${spec.locale} ${spec.theme} ${spec.width}`,
            errors: job.errors,
          });
        }
        process.stdout.write(
          `. ${spec.fixture} ${spec.locale} ${spec.theme} ${spec.width}\n`,
        );
      }
    }
  }
}

// ---- 从原始测量里提炼表格 / 结论 ---------------------------------------------------
const by = (predicate) => jobs.filter(predicate);
const round = (value) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);

const fontTable = (job) =>
  job.metrics.error
    ? null
    : {
        fixture: job.fixture,
        locale: job.locale,
        theme: job.theme,
        width: job.width,
        labels: job.metrics.columns.map((column) => ({
          text: column.label.text,
          fontSize: column.label.style.fontSize,
          lineHeight: column.label.style.lineHeight,
        })),
        values: job.metrics.columns.map((column) => {
          if (column.value.kind === "rate-pair") {
            return {
              kind: "rate-pair",
              directions: column.value.directions.map((direction) => ({
                text: direction.display,
                fontSize: direction.style?.fontSize ?? null,
                lineHeight: direction.style?.lineHeight ?? null,
                unitFontSize: direction.unit?.style?.fontSize ?? null,
                unitLineHeight: direction.unit?.style?.lineHeight ?? null,
                fontWeight: direction.style?.fontWeight ?? null,
              })),
            };
          }
          return {
            kind: column.value.kind,
            text: column.value.display,
            fontSize: column.value.style?.fontSize ?? null,
            lineHeight: column.value.style?.lineHeight ?? null,
            unitFontSize: column.value.unit?.style?.fontSize ?? null,
            unitLineHeight: column.value.unit?.style?.lineHeight ?? null,
            fontWeight: column.value.style?.fontWeight ?? null,
            percentInline: column.value.percentInline ?? false,
          };
        }),
        baselines: job.metrics.columns.map((column) => {
          if (column.value.kind === "rate-pair") {
            return column.value.directions.map((direction) => ({
              label: direction.label,
              baseline: direction.baseline,
            }));
          }
          return { baseline: column.value.baseline };
        }),
        chartBottoms: job.metrics.columns.map((column) => column.chart.bottom),
        chartTops: job.metrics.columns.map((column) => column.chart.box?.top ?? null),
        chartHeights: job.metrics.columns.map((column) => column.chart.box?.height ?? null),
        rowHeights: job.metrics.columns.map((column) => column.row.box?.height ?? null),
        columnWidths: job.metrics.columns.map((column) => column.column.box?.width ?? null),
        columnXs: job.metrics.columns.map((column) => column.column.box?.x ?? null),
        labelXs: job.metrics.columns.map((column) => column.label.box?.x ?? null),
        labelYs: job.metrics.columns.map((column) => column.label.box?.y ?? null),
        numberBoxes: job.metrics.columns.map((column) => {
          if (column.value.kind === "rate-pair") {
            return column.value.directions.map((direction) => direction.number);
          }
          return column.value.number;
        }),
        card: job.metrics.card.box,
        page: job.metrics.page,
        clipped: job.clipping.clipped,
        overlaps: job.clipping.overlaps,
        chartStates: job.metrics.columns.map((column) => ({
          kind: column.chart.kind,
          state: column.chart.state,
          aria: column.chart.aria,
        })),
      };

const alignment = (job) => {
  if (job.metrics.error) return null;
  const bottoms = job.metrics.columns.map((column) => column.chart.bottom);
  const baselines = job.metrics.columns.map((column) =>
    column.value.kind === "rate-pair"
      ? column.value.directions.map((direction) => direction.baseline)
      : column.value.baseline,
  );
  const flat = baselines.flat().filter((value) => value !== null);
  return {
    fixture: job.fixture,
    locale: job.locale,
    theme: job.theme,
    width: job.width,
    chartBottomSpread: round(Math.max(...bottoms) - Math.min(...bottoms)),
    chartBottoms: bottoms.map(round),
    baselineSpread: flat.length ? round(Math.max(...flat) - Math.min(...flat)) : null,
    baselines,
  };
};

const contrast = (job) => {
  if (job.metrics.error) return null;
  const entries = [];
  for (const column of job.metrics.columns) {
    entries.push({
      what: `${column.value.kind} · label`,
      ratio: column.label.contrast?.ratio ?? null,
    });
    if (column.value.kind === "rate-pair") {
      for (const direction of column.value.directions) {
        entries.push({
          what: `rate ${direction.label ?? "?"} · number`,
          ratio: direction.contrast?.ratio ?? null,
        });
        if (direction.unit) {
          entries.push({
            what: `rate ${direction.label ?? "?"} · unit`,
            ratio: direction.unit.contrast?.ratio ?? null,
          });
        }
      }
    } else {
      entries.push({
        what: `${column.value.kind} · number`,
        ratio: column.value.contrast?.ratio ?? null,
      });
      if (column.value.unit) {
        entries.push({
          what: `${column.value.kind} · unit`,
          ratio: column.value.unit.contrast?.ratio ?? null,
        });
      }
    }
    if (column.chart.emptyLabel) {
      entries.push({
        what: "chart empty label",
        ratio: column.chart.emptyLabel.contrast?.ratio ?? null,
      });
    }
  }
  return {
    fixture: job.fixture,
    locale: job.locale,
    theme: job.theme,
    width: job.width,
    entries,
    min: entries.reduce(
      (minimum, entry) =>
        entry.ratio === null ? minimum : Math.min(minimum, entry.ratio),
      Number.POSITIVE_INFINITY,
    ),
  };
};

const table = jobs.map(fontTable).filter(Boolean);
const alignments = jobs.map(alignment).filter(Boolean);
const contrasts = jobs.map(contrast).filter(Boolean);

const report = {
  meta: {
    startedAt,
    finishedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    fixtureCount: FIXTURES.length,
    jobCount: jobs.length,
    tooltipFixtures: [...TOOLTIP_FIXTURES],
    keyboardFixtures: [...KEYBOARD_FIXTURES],
    note:
      "所有几何 / 字号 / 对比度都由 headless Chrome 的计算样式与 getBoundingClientRect 取得；" +
      "截图在 shots/，本文件是原始数据。",
  },
  summary: {
    horizontalOverflow: jobs
      .filter((job) => !job.metrics.error && job.metrics.page.scrollWidth > job.metrics.page.clientWidth + 1)
      .map((job) => ({
        fixture: job.fixture,
        locale: job.locale,
        theme: job.theme,
        width: job.width,
        scrollWidth: job.metrics.page.scrollWidth,
        clientWidth: job.metrics.page.clientWidth,
      })),
    cardOverflow: jobs
      .filter((job) => !job.metrics.error && job.metrics.card.overflow.x > 1)
      .map((job) => ({
        fixture: job.fixture,
        locale: job.locale,
        theme: job.theme,
        width: job.width,
        overflow: job.metrics.card.overflow,
      })),
    clippedTexts: jobs
      .filter((job) => job.clipping.clipped.length > 0)
      .map((job) => ({
        fixture: job.fixture,
        locale: job.locale,
        theme: job.theme,
        width: job.width,
        clipped: job.clipping.clipped,
      })),
    textChartOverlaps: jobs
      .filter((job) => job.clipping.overlaps.length > 0)
      .map((job) => ({
        fixture: job.fixture,
        locale: job.locale,
        theme: job.theme,
        width: job.width,
        overlaps: job.clipping.overlaps,
      })),
    tooltipClipped: jobs
      .filter((job) => {
        for (const tip of [job.tooltip, job.tooltipLeft, job.tooltipFirstRow]) {
          if (
            tip?.visible &&
            (Object.values(tip.clippedByCard ?? {}).some(Boolean) ||
              Object.values(tip.clippedByViewport ?? {}).some(Boolean))
          ) {
            return true;
          }
        }
        return false;
      })
      .map((job) => ({
        fixture: job.fixture,
        locale: job.locale,
        theme: job.theme,
        width: job.width,
        tooltip: job.tooltip,
        tooltipFirstRow: job.tooltipFirstRow,
      })),
    keyboardInaccessible: jobs
      .filter((job) => job.keyboard && !job.keyboard.tabReachedChart)
      .map((job) => ({
        fixture: job.fixture,
        locale: job.locale,
        theme: job.theme,
        width: job.width,
        keyboard: {
          tabIndex: job.keyboard.tabIndex,
          tabindexAttr: job.keyboard.tabindexAttr,
          focusSucceeded: job.keyboard.focusSucceeded,
          tabReachedChart: job.keyboard.tabReachedChart,
          tooltipAfterTab: job.keyboard.tooltipAfterTab,
        },
      })),
    consoleErrors,
  },
  fontTable: table,
  alignment: alignments,
  contrast: contrasts,
  jobs,
};

writeFileSync(
  path.join(HERE, `${OUTPUT_NAME}.json`),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify(
    {
      jobs: jobs.length,
      screenshots: jobs.reduce((sum, job) => sum + job.screenshots.length, 0),
      horizontalOverflow: report.summary.horizontalOverflow.length,
      cardOverflow: report.summary.cardOverflow.length,
      clippedTexts: report.summary.clippedTexts.length,
      textChartOverlaps: report.summary.textChartOverlaps.length,
      tooltipClipped: report.summary.tooltipClipped.length,
      keyboardInaccessible: report.summary.keyboardInaccessible.length,
      consoleErrors: consoleErrors.length,
    },
    null,
    2,
  ),
);

// 基础健全性：三列一定存在；否则说明 fixture/路由出了问题。
for (const job of jobs) {
  assert.ok(!job.metrics.error, `${job.fixture}: ${job.metrics.error}`);
  assert.equal(job.metrics.columns.length, 3, `${job.fixture}: 应有三列`);
}

await browser.close();
