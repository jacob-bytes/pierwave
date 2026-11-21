#!/usr/bin/env node
/**
 * hero 三张迷你图的截图与断言 / Screenshots and assertions for the hero sparklines.
 *
 * 用法 / Usage:
 *   (cd web && npm run build && npx vite preview --port 4173 --strictPort)
 *   node web/screenshots/hero-sparklines/shots.mjs
 *
 * 产物 / Output:
 *   {state}-{theme}-{width}.png        5 状态 × 亮/暗 × 1440/390（20 张，中文）
 *   full-dark-1440-en.png              英文完整数据
 *   empty-dark-1440-en.png             英文空态（Collecting data）
 *   full-dark-1440-hover.png           速率图悬停 tooltip
 *   zero-dark-1440-hover.png          0 B/s 的悬停读数（证明 0 不是 null）
 *   card-hover-{dark,light}-1440.png  卡片 hover 特写（1px primary/70）
 *   card-hover-dark-390.png           手机上的同一特写
 *   report.json                       布局实测、路径段数、hover ring、断言结果
 *
 * 数据由 Playwright 拦截 `GET /api/v1/public/status` 返回，不启动后端、不写库。
 * 环境变量：BASE_URL、PLAYWRIGHT_MODULE、CHROME_PATH。
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
import { heroFixture } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4173";
const STATES = ["empty", "legacy", "partial", "full", "zero"];
const THEMES = ["dark", "light"];
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

/** 本轮改前实测（KPI 占满剩余宽度、24/20px 的图，同一份 8 台机器 fixture）。 */
const BASELINE = {
  1440: {
    statsWidth: 1046,
    columnWidth: 324,
    heroHeight: 171,
    chartHeight: 24,
    verdictWidth: 233.7,
    gap: 32,
  },
  390: { statsWidth: 326, columnWidth: 326, heroHeight: 368.8, chartHeight: 20 },
};

const EMPTY_LABEL = {
  "zh-CN": "数据收集中",
  en: "Collecting data",
};

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
  for (const state of STATES) {
    for (const theme of THEMES) {
      for (const { width, height } of WIDTHS) {
        list.push({
          state,
          theme,
          width,
          height,
          locale: "zh-CN",
          hover: false,
          cardHover: false,
          out: path.join(HERE, `${state}-${theme}-${width}.png`),
          label: `${state} ${theme} ${width} zh`,
        });
      }
    }
  }

  // 英文：完整数据 + 空态文案各一张。
  for (const state of ["full", "empty"]) {
    list.push({
      state,
      theme: "dark",
      width: 1440,
      height: 1000,
      locale: "en",
      hover: false,
      cardHover: false,
      out: path.join(HERE, `${state}-dark-1440-en.png`),
      label: `${state} dark 1440 en`,
    });
  }

  // tooltip：完整数据读数 + 0 的读数。
  for (const state of ["full", "zero"]) {
    list.push({
      state,
      theme: "dark",
      width: 1440,
      height: 1000,
      locale: "zh-CN",
      hover: true,
      cardHover: false,
      out: path.join(HERE, `${state}-dark-1440-hover.png`),
      label: `${state} dark 1440 hover`,
    });
  }

  // 卡片 hover 特写：1px 主色边缘（不再用 2px 的厚框）。
  for (const theme of ["dark", "light"]) {
    list.push({
      state: "full",
      theme,
      width: 1440,
      height: 1000,
      locale: "zh-CN",
      hover: false,
      cardHover: true,
      out: path.join(HERE, `card-hover-${theme}-1440.png`),
      label: `card hover ${theme} 1440`,
    });
  }
  list.push({
    state: "full",
    theme: "dark",
    width: 390,
    height: 844,
    locale: "zh-CN",
    hover: false,
    cardHover: true,
    out: path.join(HERE, "card-hover-dark-390.png"),
    label: "card hover dark 390",
  });

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
    ({ theme, locale }) => {
      window.localStorage.setItem("pierwave.theme", theme);
      window.localStorage.setItem("pierwave.locale", locale);
    },
    { theme: job.theme, locale: job.locale },
  );

  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/v1/public/status")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(heroFixture(job.state)),
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
      const round = (value) => Math.round(value * 10) / 10;
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return {
          x: round(box.x),
          y: round(box.y),
          width: round(box.width),
          height: round(box.height),
        };
      };
      const hero = document.querySelector(
        'main [data-slot="card"][role="group"]',
      );
      const stats = hero.querySelector("div.grid");
      const row = stats.parentElement;
      const verdictBlock = row.children[0];
      const verdictText = verdictBlock.querySelector("p");
      const verdict = rect(verdictBlock);
      const columns = [...stats.children].map((element) => ({
        ...rect(element),
        text: element.innerText.replace(/\s+/g, " ").trim(),
      }));
      const charts = [
        ...hero.querySelectorAll('[data-slot="hero-sparkline"]'),
      ].map((element) => {
        const lines = [
          ...element.querySelectorAll('path[stroke]:not([stroke="none"])'),
        ].map((line) => line.getAttribute("d") ?? "");
        const ys = lines.flatMap((d) =>
          [...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((match) =>
            Number(match[1]),
          ),
        );
        return {
          kind: element.dataset.kind,
          state: element.dataset.state,
          ...rect(element),
          aria: element.getAttribute("aria-label"),
          segments: lines.map(
            (d) => (d.match(/M/g) ?? []).length,
          ),
          lineCount: lines.length,
          yMin: ys.length ? Math.min(...ys) : null,
          yMax: ys.length ? Math.max(...ys) : null,
          areaCount: element.querySelectorAll('path[stroke="none"]').length,
          dashedBaseline: element.querySelectorAll(".border-dashed").length,
        };
      });
      return {
        hero: rect(hero),
        verdict,
        verdictText: rect(verdictText),
        // 两个 flex 子块之间的实际空白 / 从结论文字末尾到 KPI 边缘的距离。
        gap: round(stats.getBoundingClientRect().x - verdictBlock.getBoundingClientRect().right),
        textGap: round(stats.getBoundingClientRect().x - verdictText.getBoundingClientRect().right),
        stats: rect(stats),
        columns,
        charts,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
      };
    });

    // 0) 横向溢出：1440 / 390 都不许出现。
    assert.ok(
      metrics.scrollWidth <= metrics.clientWidth + 1,
      `横向溢出 ${metrics.scrollWidth} > ${metrics.clientWidth}`,
    );

    // 1) 正好三张迷你图，顺序就是三个 KPI 的顺序。
    assert.equal(metrics.charts.length, 3, "hero 必须正好三张迷你图");
    assert.deepEqual(
      metrics.charts.map((chart) => chart.kind),
      ["latency", "uptime", "rate"],
      "三张图的顺序应与 KPI 一致",
    );

    // 2) 三种数据形态。
    const assertEmpty = (chart) => {
      assert.equal(chart.state, "empty", `${chart.kind} 应为空态`);
      assert.equal(chart.lineCount, 0, "空态不画线（更不能画 0 平线）");
      assert.equal(chart.dashedBaseline, 1, "空态要有虚线基线");
      assert.equal(
        chart.aria,
        EMPTY_LABEL[job.locale === "zh-CN" ? "zh-CN" : "en"],
        `${chart.kind} 空态文案不对`,
      );
    };

    if (job.state === "empty" || job.state === "legacy") {
      for (const chart of metrics.charts) {
        // 旧后端只缺 series：可用率仍能由 buckets_24h 画出来。
        if (job.state === "legacy" && chart.kind === "uptime") {
          assert.equal(chart.state, "ready", "legacy 下可用率图仍应有线");
          assert.ok(chart.lineCount >= 1);
        } else {
          assertEmpty(chart);
        }
      }
      if (job.state === "empty" && job.locale === "en") {
        assert.equal(
          await page.getByText("Collecting data", { exact: true }).count(),
          3,
          "英文空态应有三处 Collecting data",
        );
      }
    } else {
      for (const chart of metrics.charts) {
        assert.equal(chart.state, "ready", `${chart.kind} 应为折线`);
        assert.ok(chart.lineCount >= 1, `${chart.kind} 没有线`);
      }
    }

    if (job.state === "partial") {
      for (const chart of metrics.charts) {
        assert.ok(
          chart.segments.some((count) => count >= 2),
          `${chart.kind} 的部分 null 应断线（至少两段 M）`,
        );
      }
    }

    if (job.state === "full" || job.state === "zero") {
      for (const chart of metrics.charts) {
        assert.ok(
          chart.segments.every((count) => count === 1),
          `${chart.kind} 的完整数据不应断线`,
        );
      }
    }

    if (job.state === "zero") {
      const rate = metrics.charts.find((chart) => chart.kind === "rate");
      assert.ok(rate.lineCount >= 2, "速率图应有上下行两条线");
      assert.equal(rate.areaCount, 1, "速率图应有一层面积");
      // 零基线：viewBox 高度 48，0 落在 y = 47（贴底）。
      assert.equal(
        rate.yMin,
        47,
        "0 B/s 是有效数据，必须贴底画线而不是空态",
      );
      assert.equal(rate.yMax, 47);

      const uptime = metrics.charts.find((chart) => chart.kind === "uptime");
      assert.equal(uptime.yMin, 47, "0% 可用率贴底");
      assert.equal(uptime.yMax, 47);
    }

    // 3) 布局：1440 三列大致等宽；390 三行堆叠、每行一张图。
    if (job.width === 1440) {
      assert.equal(metrics.columns.length, 3);
      const widths = metrics.columns.map((column) => column.width);
      assert.ok(
        Math.max(...widths) - Math.min(...widths) <= 2,
        `三列应等宽，实测 ${widths.join(" / ")}`,
      );
      // 本轮目标：KPI 区 720–800px，单列约 240–260px，靠右但不占满。
      assert.ok(
        metrics.stats.width >= 720 && metrics.stats.width <= 810,
        `KPI 区应收到约 720–800px，实测 ${metrics.stats.width}px`,
      );
      assert.ok(
        widths[0] >= 235 && widths[0] <= 262,
        `单列应约 240–260px，实测 ${widths[0]}px`,
      );
      // 结论与 KPI 之间要留出明显空白（上一版只有 32px 的 gap）。
      assert.ok(
        metrics.gap >= 120,
        `结论与 KPI 之间仍太挤：${metrics.gap}px`,
      );
      // hero 总高应从 213px 收到约 170px：图变小、间距收紧、去掉进度条。
      assert.ok(
        metrics.hero.height <= 180,
        `hero 仍太高：${metrics.hero.height}px（目标约 170px）`,
      );
      for (const chart of metrics.charts) {
        assert.equal(chart.height, 24, `${chart.kind} 桌面高度应为 24px`);
        assert.ok(chart.width >= 200, `${chart.kind} 桌面宽度过窄`);
      }
    } else {
      const ys = metrics.columns.map((column) => column.y);
      assert.ok(
        ys[0] < ys[1] && ys[1] < ys[2],
        `390 下三列应堆叠，实测 y=${ys.join(" / ")}`,
      );
      assert.ok(
        Math.abs(metrics.columns[0].x - metrics.columns[1].x) <= 1,
        "堆叠后三行左边缘应对齐",
      );
      assert.ok(
        Math.abs(metrics.columns[0].width - metrics.columns[2].width) <= 1,
        "堆叠后三行应同宽",
      );
      for (const chart of metrics.charts) {
        assert.equal(chart.height, 20, `${chart.kind} 手机高度应为 20px`);
      }
    }

    // 4) 悬停 tooltip：读数必须在卡片里，不越界。
    let tooltipText = null;
    if (job.hover) {
      const rate = page.locator('[data-slot="hero-sparkline"][data-kind="rate"]');
      const box = await rate.boundingBox();
      assert.ok(box);
      await rate.hover({
        position: { x: Math.round(box.width * 0.72), y: box.height / 2 },
      });
      const tooltip = rate.locator('[data-slot="hero-sparkline-tooltip"]');
      await tooltip.waitFor({ state: "visible", timeout: 3_000 });
      tooltipText = (await tooltip.innerText()).replace(/\s+/g, " ").trim();
      const tooltipBox = await tooltip.boundingBox();
      const heroBox = await hero.boundingBox();
      assert.ok(tooltipBox && heroBox);
      assert.ok(
        tooltipBox.x >= heroBox.x - 1 &&
          tooltipBox.x + tooltipBox.width <= heroBox.x + heroBox.width + 1,
        "tooltip 不应被卡片裁掉",
      );
      if (job.state === "zero") {
        assert.match(tooltipText, /0 B\/s/, "0 必须读成 0 B/s");
      } else {
        assert.match(tooltipText, /下行/);
        assert.match(tooltipText, /MB\/s/);
      }
    }

    let cardHover = null;
    if (job.cardHover) {
      // 第一张服务器卡（hero 也有 data-slot=card，但带 role=group，排除掉）。
      const card = page
        .locator('main [data-slot="card"]:not([role="group"])')
        .first();
      await card.scrollIntoViewIfNeeded();
      await card.hover();
      await page.waitForTimeout(220);
      cardHover = await card.evaluate((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          className: element.className,
          boxShadow: style.boxShadow,
          outline: style.outline,
          rect: {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
          },
        };
      });
      // 1px 边缘：Tailwind ring 会写进 box-shadow；不允许再出现 2px 的 ring。
      assert.match(cardHover.boxShadow, /0px 0px 0px 1px/);
      assert.doesNotMatch(cardHover.boxShadow, /0px 0px 0px 2px/);
      assert.match(cardHover.className, /hover:ring-1/);
      assert.match(cardHover.className, /hover:ring-primary\/70/);
      // 阴影保留（shadow-sm 的另一层仍在）。
      assert.match(cardHover.className, /hover:shadow-sm/);

      const box = await card.boundingBox();
      assert.ok(box);
      const pad = 18;
      await page.screenshot({
        path: job.out,
        animations: "disabled",
        clip: {
          x: Math.max(0, box.x - pad),
          y: Math.max(0, box.y - pad),
          width: box.width + pad * 2,
          height: box.height + pad * 2,
        },
      });
    } else {
      await page.screenshot({
        path: job.out,
        fullPage: true,
        animations: "disabled",
      });
    }

    const bytes = statSync(job.out).size;
    results.push({
      state: job.state,
      theme: job.theme,
      width: job.width,
      locale: job.locale,
      hover: job.hover,
      cardHover: job.cardHover,
      file: path.relative(HERE, job.out),
      hero: metrics.hero,
      verdict: metrics.verdict,
      verdictText: metrics.verdictText,
      gap: metrics.gap,
      textGap: metrics.textGap,
      stats: metrics.stats,
      columns: metrics.columns,
      charts: metrics.charts,
      scrollWidth: metrics.scrollWidth,
      scrollHeight: metrics.scrollHeight,
      tooltip: tooltipText,
      hoverRing: cardHover,
      kb: Math.round(bytes / 1024),
    });
    console.log(
      `ok  ${path.basename(job.out).padEnd(32)} cols=${metrics.columns
        .map((column) => column.width)
        .join("/")} hero=${metrics.hero.width}×${metrics.hero.height} ${Math.round(
        bytes / 1024,
      )} KB`,
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
  `${JSON.stringify({ baseUrl: BASE_URL, baseline: BASELINE, results, failures }, null, 2)}\n`,
);

console.log(
  `\n${results.length} 张截图 → ${path.relative(process.cwd(), HERE) || "."}`,
);
if (failures.length > 0) {
  console.error(`\n${failures.length} 个任务失败：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
