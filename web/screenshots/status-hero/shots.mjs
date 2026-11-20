#!/usr/bin/env node
/**
 * 公开状态页 hero 的四态截图 / Screenshots for the public status hero.
 *
 * 用法 / Usage:
 *   # 先构建并起一个静态预览（后端不参与）
 *   (cd web && npm run build && npx vite preview --port 4173 --strictPort)
 *   node web/screenshots/status-hero/shots.mjs
 *
 * 产物 / Output
 *   {state}-{theme}-{width}.png      中文 16 张（4 状态 × 亮/暗 × 1440/390）
 *   {state}-dark-1440-en.png         英文 4 张（每个状态一张）
 *   report.json                      尺寸、断言结果与卡片结构
 *
 * 数据由 Playwright 拦截 `GET /api/v1/public/status` 返回，不启动后端、不写库。
 * 环境变量：BASE_URL、PLAYWRIGHT_MODULE、CHROME_PATH。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EXPECTED, statusFixture } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:4173";
const STATES = ["all-online", "partial", "all-offline", "low"];
const THEMES = ["dark", "light"];
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];
const HERO_LABEL = { "zh-CN": "服务概况", en: "Service overview" };

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
          out: path.join(HERE, `${state}-${theme}-${width}.png`),
          label: `${state} ${theme} ${width} zh`,
        });
      }
    }
    list.push({
      state,
      theme: "dark",
      width: 1440,
      height: 1000,
      locale: "en",
      out: path.join(HERE, `${state}-dark-1440-en.png`),
      label: `${state} dark 1440 en`,
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
  page.on("pageerror", (error) => failures.push(`${job.label}: ${error.message}`));
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

  // 只放行公开状态接口；其它请求保持真实（静态资源来自 preview）。
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/v1/public/status")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(statusFixture(job.state)),
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
    const hero = page.locator(
      `[role="group"][aria-label="${HERO_LABEL[job.locale]}"]`,
    );
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

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    assert.ok(
      metrics.scrollWidth <= metrics.clientWidth + 1,
      `横向溢出 ${metrics.scrollWidth} > ${metrics.clientWidth}`,
    );

    // 1. 一句结论
    const verdict = (await hero.locator("p").first().innerText())
      .replace(/\s+/g, " ")
      .trim();
    assert.ok(
      verdict.includes(EXPECTED[job.state][job.locale === "zh-CN" ? "zh" : "en"]),
      `结论不符：${verdict}`,
    );

    // 2. 三个大数字
    const statsGrid = hero.locator("div.grid").first();
    const statTexts = (await statsGrid.locator(":scope > div").allInnerTexts()).map(
      (text) => text.replace(/\s+/g, " ").trim(),
    );
    assert.equal(statTexts.length, 3, "hero 必须正好三个大数字");
    const labels =
      job.locale === "zh-CN"
        ? ["在线率", "平均 24h 可用率", "当前总速率"]
        : ["Online", "Avg 24h uptime", "Total rate"];
    assert.ok(
      statTexts[0].includes(labels[0]) &&
        statTexts[0].includes(EXPECTED[job.state].online),
      `在线率不符：${statTexts[0]}`,
    );
    assert.ok(
      statTexts[1].includes(labels[1]) &&
        statTexts[1].includes(EXPECTED[job.state].availability),
      `平均可用率不符：${statTexts[1]}`,
    );
    if (EXPECTED[job.state].rateMissing) {
      assert.ok(
        statTexts[2].includes(labels[2]) && statTexts[2].includes("—"),
        `无速率时应显示 —：${statTexts[2]}`,
      );
    } else {
      assert.ok(
        statTexts[2].includes(labels[2]) && /\/s/.test(statTexts[2]),
        `总速率未格式化：${statTexts[2]}`,
      );
      assert.ok(!statTexts[2].includes("—"), "有速率时不应显示 —");
    }

    // 3. 不再重复的旧汇总：平均可用率 / 最忙服务器 各只出现一次。
    const averageLabel = job.locale === "zh-CN" ? "平均 24h 可用率" : "Avg 24h uptime";
    const busiestLabel = job.locale === "zh-CN" ? "最忙服务器" : "Busiest server";
    assert.equal(
      await page.getByText(averageLabel, { exact: true }).count(),
      1,
      "平均可用率只应出现在 hero",
    );
    assert.equal(
      await page.getByText(busiestLabel, { exact: true }).count(),
      1,
      "最忙服务器只应出现在 hero 脚注",
    );

    // 4. 卡片与 24 格点阵的结构断言（内容由未改动的 ServerCard 渲染）。
    const cards = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('main [data-slot="card"] h3')).map(
        (heading) => {
          const card = heading.closest('[data-slot="card"]');
          const strip = Array.from(
            card.querySelectorAll('[role="group"]'),
          ).find((group) => group.children.length === 24);
          return {
            name: heading.textContent.trim(),
            stripCells: strip ? strip.children.length : 0,
            has7d: /7\s*(天|d)/.test(card.textContent ?? ""),
            progressBars: card.querySelectorAll('[role="progressbar"]').length,
          };
        },
      );
    });
    assert.equal(cards.length, 8, "卡片数量应保持 8");
    for (const card of cards) {
      assert.equal(card.stripCells, 24, `${card.name} 的 24 格点阵被改动`);
      assert.equal(card.has7d, true, `${card.name} 缺少 7 天可用率`);
      assert.equal(card.progressBars, 3, `${card.name} 的指标条被改动`);
    }

    await page.screenshot({
      path: job.out,
      fullPage: true,
      animations: "disabled",
    });

    const bytes = statSync(job.out).size;
    results.push({
      state: job.state,
      theme: job.theme,
      width: job.width,
      locale: job.locale,
      file: path.relative(HERE, job.out),
      scrollWidth: metrics.scrollWidth,
      scrollHeight: metrics.scrollHeight,
      kb: Math.round(bytes / 1024),
      verdict,
      stats: statTexts,
      cards,
    });
    console.log(
      `ok  ${path.basename(job.out).padEnd(34)} ${metrics.scrollWidth}×${metrics.scrollHeight}  ${Math.round(bytes / 1024)} KB  ${verdict}`,
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
