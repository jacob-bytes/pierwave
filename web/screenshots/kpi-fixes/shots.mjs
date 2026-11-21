#!/usr/bin/env node
/**
 * KPI 审计修复的回归截图 / Regression shots for the KPI audit fixes.
 *
 * 覆盖审计点名的 6 个 fixture（temporal-spike-rate、dual-gap-rx-high、
 * uptime-9999、series-all-null、buckets-null、rate-1024）+ F6 的两个缺失方向。
 * 每个 fixture 在 1440/390、亮/暗下量字号、单位、基线、空态对比度与曲线 y；
 * 另含键盘焦点 / 方向键 / Escape 与 ARIA 关联。
 *
 * 用法 / Usage:
 *   (cd web && npm run build && npx vite preview --port 4173 --strictPort)
 *   BASE_URL=http://localhost:4173 node web/screenshots/kpi-fixes/shots.mjs
 *
 * 数据来自 ../kpi-audit/fixtures.mjs，Playwright 拦截接口，不启动后端、不写库。
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { kpiFixture } from "../kpi-audit/fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4173";

/** 审计报告点名的 6 个 fixture；rate-1024 对应 fixture 名 rate-boundary-1024。 */
const FIXTURES = [
  { name: "temporal-spike-rate", source: "temporal-spike-rate" },
  { name: "dual-gap-rx-high", source: "dual-gap-rx-high" },
  { name: "uptime-9999", source: "uptime-9999" },
  { name: "series-all-null", source: "series-all-null" },
  { name: "buckets-null", source: "buckets-null" },
  { name: "rate-1024", source: "rate-boundary-1024" },
];
const THEMES = ["dark", "light"];
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

mkdirSync(HERE, { recursive: true });

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) {
    candidates.push(process.env.PLAYWRIGHT_MODULE);
  }
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

function jobs() {
  const list = [];
  for (const fixture of FIXTURES) {
    for (const theme of THEMES) {
      for (const { width, height } of WIDTHS) {
        list.push({
          fixture: fixture.source,
          name: fixture.name,
          theme,
          width,
          height,
          keyboard: false,
          out: path.join(HERE, `${fixture.name}-${theme}-${width}.png`),
          label: `${fixture.name} ${theme} ${width}`,
        });
      }
    }
  }
  // F4：键盘焦点 / 方向键 / Escape + 焦点环。
  list.push({
    fixture: "temporal-spike-rate",
    name: "keyboard",
    theme: "dark",
    width: 1440,
    height: 1000,
    keyboard: true,
    out: path.join(HERE, "keyboard-rate-1024-dark-1440.png"),
    label: "keyboard rate 1440 dark",
  });
  // F6：单方向缺失 / 两方向都缺，— 的字号必须相同。
  for (const name of ["rate-rx-missing", "rate-both-missing"]) {
    list.push({
      fixture: name,
      name,
      theme: "dark",
      width: 1440,
      height: 1000,
      keyboard: false,
      out: path.join(HERE, `${name}-dark-1440.png`),
      label: `${name} dark 1440`,
    });
  }
  // 卡片上的可用率也用同一精度：一张整页截图作为证据。
  list.push({
    fixture: "uptime-9999",
    name: "uptime-9999-full",
    theme: "dark",
    width: 1440,
    height: 1000,
    keyboard: false,
    fullPage: true,
    out: path.join(HERE, "uptime-9999-full-dark-1440.png"),
    label: "uptime-9999 full dark 1440",
  });
  // F3：亚字节读数与 1024 双边界的补测。
  for (const extra of [
    { name: "rate-tiny", fixture: "rate-tiny", width: 1440, height: 1000 },
    { name: "rate-1024-both", fixture: "rate-1024-both", width: 1440, height: 1000 },
    { name: "rate-1024-both", fixture: "rate-1024-both", width: 390, height: 844 },
  ]) {
    list.push({
      fixture: extra.fixture,
      name: extra.name,
      theme: "dark",
      width: extra.width,
      height: extra.height,
      keyboard: false,
      out: path.join(
        HERE,
        `${extra.name}-dark-${extra.width}.png`,
      ),
      label: `${extra.name} dark ${extra.width}`,
    });
  }
  return list;
}

const chromium = await loadPlaywright();
const executablePath = chromePath();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const results = [];
const failures = [];

for (const job of jobs()) {
  const page = await browser.newPage({
    viewport: { width: job.width, height: job.height },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (error) =>
    failures.push(`${job.label}: ${error.message}`),
  );
  page.on("console", (message) => {
    if (message.type() === "error") {
      failures.push(`${job.label}: console ${message.text()}`);
    }
  });

  await page.addInitScript(
    ({ theme }) => {
      window.localStorage.setItem("pierwave.theme", theme);
      window.localStorage.setItem("pierwave.locale", "zh-CN");
    },
    { theme: job.theme },
  );

  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/v1/public/status")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(kpiFixture(job.fixture)),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });

  try {
    await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
    const hero = page.locator('main [data-slot="card"][role="group"]').first();
    await hero.waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForFunction(
      () => document.querySelectorAll("main h3").length === 8,
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

    const metrics = await page.evaluate(() => {
      const round = (value) => Math.round(value * 100) / 100;
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return {
          x: round(box.x),
          y: round(box.y),
          width: round(box.width),
          height: round(box.height),
          bottom: round(box.bottom),
        };
      };
      const hero = document.querySelector(
        'main [data-slot="card"][role="group"]',
      );
      const values = [
        ...hero.querySelectorAll('[data-slot="hero-kpi-value"]'),
      ].map((element) => ({
        kpi: element.dataset.kpi,
        text: element.innerText.replace(/\s+/g, " ").trim(),
        fontSize: parseFloat(getComputedStyle(element).fontSize),
        lineHeight: getComputedStyle(element).lineHeight,
        direction: element.dataset.direction ?? null,
        ...rect(element),
      }));
      const units = [
        ...hero.querySelectorAll('[data-slot="hero-kpi-unit"]'),
      ].map((element) => ({
        text: element.innerText.trim(),
        fontSize: parseFloat(getComputedStyle(element).fontSize),
        color: getComputedStyle(element).color,
      }));
      const charts = [
        ...hero.querySelectorAll('[data-slot="hero-sparkline"]'),
      ].map((element) => {
        const paths = [
          ...element.querySelectorAll('path[stroke]:not([stroke="none"])'),
        ].map((line) => {
          const d = line.getAttribute("d") ?? "";
          return {
            d,
            ys: [...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((match) =>
              Number(match[1]),
            ),
          };
        });
        return {
          kind: element.dataset.kind,
          state: element.dataset.state,
          ...rect(element),
          pathCount: paths.length,
          paths,
          aria: element.getAttribute("aria-label"),
        };
      });

      // 空态标签：字号 + 对比度（用 canvas 把 oklch 解析成 sRGB）。
      const rgba = (value) => {
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.fillStyle = value;
        context.fillRect(0, 0, 1, 1);
        const data = context.getImageData(0, 0, 1, 1).data;
        return [data[0], data[1], data[2], data[3] / 255];
      };
      const linear = (channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([r, g, b]) =>
        0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
      const contrast = (foreground, background) => {
        const a = luminance(foreground);
        const b = luminance(background);
        const lighter = Math.max(a, b);
        const darker = Math.min(a, b);
        return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
      };
      const emptyLabels = [];
      for (const chart of hero.querySelectorAll('[data-state="empty"]')) {
        const label = [...chart.querySelectorAll("span")].find(
          (span) =>
            span.textContent.trim() &&
            !span.hasAttribute("aria-hidden"),
        );
        if (!label) continue;
        const style = getComputedStyle(label);
        emptyLabels.push({
          text: label.textContent.trim(),
          fontSize: parseFloat(style.fontSize),
          color: style.color,
          background: style.backgroundColor,
          contrast: contrast(rgba(style.color), rgba(style.backgroundColor)),
        });
      }

      const byKpi = {};
      for (const value of values) {
        if (!byKpi[value.kpi]) byKpi[value.kpi] = value;
      }

      const firstCard = document.querySelector(
        'main [data-slot="card"]:not([role="group"])',
      );

      return {
        hero: rect(hero),
        values,
        units,
        byKpi,
        charts,
        emptyLabels,
        firstCardText:
          firstCard?.innerText.replace(/\s+/g, " ").trim() ?? null,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });

    // ---- 通用断言：字号 / 单位 / 基线 ------------------------------------------
    const expectedValue = job.width === 1440 ? 28 : 19;
    const expectedLine = job.width === 1440 ? 28 : 19;
    for (const value of metrics.values) {
      assert.equal(
        value.fontSize,
        expectedValue,
        `${job.name} ${value.kpi} 数值字号应为 ${expectedValue}px，实测 ${value.fontSize}`,
      );
      assert.equal(
        parseFloat(value.lineHeight),
        expectedLine,
        `${job.name} ${value.kpi} 行高应为 ${expectedLine}px`,
      );
    }
    for (const unit of metrics.units) {
      assert.equal(
        unit.fontSize,
        12,
        `${job.name} 单位 ${unit.text} 字号应为 12px，实测 ${unit.fontSize}`,
      );
    }
    assert.ok(metrics.units.length >= 1, "有数值时应能看到 12px 的单位 span");

    if (job.width === 1440) {
      const bottoms = ["latency", "uptime", "rate"].map(
        (kpi) => metrics.byKpi[kpi]?.bottom,
      );
      assert.ok(bottoms.every((value) => Number.isFinite(value)));
      assert.ok(
        Math.max(...bottoms) - Math.min(...bottoms) <= 1,
        `${job.name} 三个 KPI 数字基线未对齐：${bottoms.join(" / ")}`,
      );
      const chartBottoms = metrics.charts.map((chart) => chart.bottom);
      assert.ok(
        Math.max(...chartBottoms) - Math.min(...chartBottoms) <= 1,
        `${job.name} 三张图底未对齐：${chartBottoms.join(" / ")}`,
      );
    }

    // ---- fixture 专属 ---------------------------------------------------------
    const rate = metrics.charts.find((chart) => chart.kind === "rate");
    const uptime = metrics.charts.find((chart) => chart.kind === "uptime");
    if (job.name === "temporal-spike-rate") {
      assert.equal(rate.pathCount, 1, "上行全 null 时只画下行一条线");
      const ys = rate.paths[0].ys;
      assert.ok(
        ys.slice(0, -1).every((y) => y === 21),
        `2 MB/s 应被抬到地板 y=21，实测 ${ys.slice(0, -1).join(",")}`,
      );
      assert.equal(ys.at(-1), 1, "2000 MB/s 应贴顶");
      const scale = rate.height / 24;
      assert.ok(
        (23 - 21) * scale >= 1.5,
        `小值离 0 基线的可见高度应 ≥1.5px，实测 ${(23 - 21) * scale}px`,
      );
    }
    if (job.name === "dual-gap-rx-high") {
      assert.equal(rate.pathCount, 2, "上下行两条线都要画");
      const high = rate.paths.find((p) => p.ys.every((y) => y === 1));
      const low = rate.paths.find((p) => p.ys.every((y) => y === 21));
      assert.ok(high, "2000 MB/s 的高线应贴顶（共用比例尺）");
      assert.ok(low, "2 MB/s 的低线应被抬到 y=21");
    }
    if (job.name === "uptime-9999") {
      const text = metrics.byKpi.uptime?.text ?? "";
      assert.match(text, /^99\.99\s*%$/, `99.99% 不应显示成 100%：${text}`);
      assert.doesNotMatch(text, /100/, "ratio 不是 1 时绝不能出现 100");
    }
    if (job.name === "uptime-9999" || job.name === "uptime-9999-full") {
      assert.match(
        metrics.firstCardText ?? "",
        /24h 可用率\s*99\.99%/,
        `卡片 24h 可用率也应保留 99.99：${metrics.firstCardText}`,
      );
    }
    if (job.name === "buckets-null") {
      assert.equal(
        metrics.byKpi.uptime?.text,
        "—",
        "buckets 全空时可用率数字必须显示 —，不能 100% + 数据收集中",
      );
      assert.equal(uptime.state, "empty", "buckets 全空时图也进空态");
    }
    if (job.name === "rate-1024") {
      const rateText = metrics.values
        .filter((value) => value.kpi === "rate")
        .map((value) => value.text)
        .join(" | ");
      assert.match(rateText, /TB\/s/, `1024^4-1 应进位成 TB/s：${rateText}`);
      assert.doesNotMatch(
        rateText,
        /1024\s*GB\/s/,
        `不应停留在 1024 GB/s：${rateText}`,
      );
    }
    if (job.name === "series-all-null") {
      const latency = metrics.charts.find((chart) => chart.kind === "latency");
      assert.equal(latency.state, "empty");
      assert.equal(rate.state, "empty");
      assert.equal(uptime.state, "ready", "可用率仍由 buckets 画出");
      assert.ok(metrics.emptyLabels.length >= 2);
      for (const label of metrics.emptyLabels) {
        assert.equal(label.fontSize, 11, "空态标签应为 11px");
        assert.ok(
          label.contrast >= 4.5,
          `空态标签对比度应 ≥4.5，实测 ${label.contrast}（${job.theme}）`,
        );
      }
    }
    if (job.name === "rate-tiny") {
      const rateTexts = metrics.values
        .filter((value) => value.kpi === "rate")
        .map((value) => value.text)
        .join(" | ");
      assert.match(rateTexts, /<1 B\/s/, `亚字节读数应显示 <1 B/s：${rateTexts}`);
      assert.doesNotMatch(rateTexts, /0 B\/s/, "非零不能写成 0 B/s");

      await page.locator('[data-kind="rate"] svg').focus();
      await page.waitForTimeout(60);
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(40);
      const tinyTooltip = await page.evaluate(
        () =>
          document
            .querySelector('[data-slot="hero-sparkline-tooltip"]')
            ?.innerText.replace(/\s+/g, " ")
            .trim() ?? "",
      );
      assert.match(
        tinyTooltip,
        /0\.001 B\/s/,
        `tooltip 应保留精确值：${tinyTooltip}`,
      );
      assert.match(tinyTooltip, /0\.4 B\/s/);
    }
    if (job.name === "rate-1024-both") {
      const sizes = metrics.values
        .filter((value) => value.kpi === "rate")
        .map((value) => value.fontSize);
      assert.ok(
        sizes.every((size) => size === expectedValue),
        `两个 1024 边界值也不能缩字号：${sizes.join("/")}`,
      );
    }
    if (job.name === "rate-rx-missing" || job.name === "rate-both-missing") {
      const rateValues = metrics.values.filter(
        (value) => value.kpi === "rate",
      );
      assert.ok(rateValues.length >= 1);
      for (const value of rateValues) {
        assert.equal(
          value.fontSize,
          expectedValue,
          `单/双方向缺失的 — 必须同字号：${value.text} = ${value.fontSize}px`,
        );
      }
    }

    // ---- F4 键盘 / ARIA -------------------------------------------------------
    let keyboard = null;
    if (job.keyboard) {
      // 从页面起点按 Tab，直到进入迷你图；再按两次到速率图。
      let tabCount = 0;
      let entered = false;
      for (; tabCount < 40; tabCount += 1) {
        await page.keyboard.press("Tab");
        entered = await page.evaluate(() => {
          const active = document.activeElement;
          return Boolean(
            active?.matches?.('[data-slot="hero-sparkline"] svg'),
          );
        });
        if (entered) break;
      }
      assert.ok(entered, "Tab 必须能进入迷你图");
      const activeKind = await page.evaluate(
        () => document.activeElement?.closest('[data-slot="hero-sparkline"]')?.dataset.kind,
      );
      if (activeKind !== "rate") {
        for (let i = 0; i < 3; i += 1) {
          await page.keyboard.press("Tab");
          const kind = await page.evaluate(
            () => document.activeElement?.closest('[data-slot="hero-sparkline"]')?.dataset.kind,
          );
          if (kind === "rate") break;
        }
      }

      const readA11y = () =>
        page.evaluate(() => {
          const svg = document.querySelector('[data-kind="rate"] svg');
          const tip = document.querySelector(
            '[data-slot="hero-sparkline-tooltip"]',
          );
          const focused = document.activeElement === svg;
          const style = getComputedStyle(svg);
          return {
            focused,
            tabIndex: svg.tabIndex,
            describedBy: svg.getAttribute("aria-describedby"),
            tooltipId: tip?.id ?? null,
            tooltipLive: tip?.getAttribute("aria-live") ?? null,
            tooltipHidden: tip?.getAttribute("aria-hidden") ?? null,
            tooltipText:
              tip?.innerText.replace(/\s+/g, " ").trim() ?? null,
            outlineWidth: style.outlineWidth,
            outlineStyle: style.outlineStyle,
            outlineColor: style.outlineColor,
          };
        });

      await page.waitForTimeout(60);
      let a11y = await readA11y();
      assert.equal(a11y.focused, true, "速率图必须获得焦点");
      assert.equal(a11y.tabIndex, 0);
      assert.equal(a11y.tooltipLive, "polite");
      assert.equal(a11y.tooltipHidden, null, "tooltip 不能 aria-hidden");
      assert.equal(a11y.describedBy, a11y.tooltipId, "aria-describedby 应指向 tooltip");
      assert.match(a11y.outlineWidth, /2px/, "焦点环应沿用 2px --focus-ring");
      assert.match(a11y.tooltipText ?? "", /GB\/s|MB\/s/);

      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(40);
      const afterLeft = await readA11y();
      assert.match(
        afterLeft.tooltipText ?? "",
        /2 MB\/s/,
        `左方向键应移到前一个采样点（2 MB/s）：${afterLeft.tooltipText}`,
      );

      await page.keyboard.press("Escape");
      await page.waitForTimeout(40);
      const afterEscape = await readA11y();
      assert.equal(afterEscape.tooltipText, null, "Escape 应关闭 tooltip");
      assert.equal(afterEscape.describedBy, null);
      keyboard = { tabCount: tabCount + 1, initial: a11y, afterLeft, afterEscape };

      // 截图留一张「焦点 + 读数」的状态：Escape 之后重新用方向键打开。
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(40);
    }

    assert.ok(
      metrics.scrollWidth <= metrics.clientWidth + 1,
      `横向溢出 ${metrics.scrollWidth} > ${metrics.clientWidth}`,
    );

    if (job.fullPage) {
      await page.screenshot({
        path: job.out,
        fullPage: true,
        animations: "disabled",
      });
    } else {
      await hero.screenshot({
        path: job.out,
        animations: "disabled",
      });
    }

    results.push({
      fixture: job.name,
      source: job.fixture,
      theme: job.theme,
      width: job.width,
      keyboard: job.keyboard,
      fullPage: Boolean(job.fullPage),
      file: path.relative(HERE, job.out),
      hero: metrics.hero,
      values: metrics.values,
      units: metrics.units,
      baselineBottoms: {
        latency: metrics.byKpi.latency?.bottom ?? null,
        uptime: metrics.byKpi.uptime?.bottom ?? null,
        rate: metrics.byKpi.rate?.bottom ?? null,
      },
      charts: metrics.charts.map((chart) => ({
        kind: chart.kind,
        state: chart.state,
        height: chart.height,
        bottom: chart.bottom,
        pathCount: chart.pathCount,
        ys: chart.paths.map((p) => p.ys),
      })),
      emptyLabels: metrics.emptyLabels,
      firstCardText: metrics.firstCardText,
      keyboard,
      kb: Math.round(statSync(job.out).size / 1024),
    });
    console.log(
      `ok  ${path.basename(job.out).padEnd(38)} ${metrics.values
        .map((value) => `${value.kpi}:${value.fontSize}px`)
        .join(" ")}  ${metrics.emptyLabels.length} empty`,
    );
  } catch (error) {
    failures.push(`${job.label}: ${error.message}`);
    console.error(`FAIL ${job.label}: ${error.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();

writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify({ baseUrl: BASE_URL, results, failures }, null, 2)}\n`,
);

console.log(`\n${results.length} 张截图 → ${path.relative(process.cwd(), HERE) || "."}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} 个任务失败：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
