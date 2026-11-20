#!/usr/bin/env node
/**
 * 渲染探针公开页三个概念方案的截图 / Render the three status-page concepts.
 *
 * 用法 / Usage:
 *   node web/screenshots/probe-concepts/render.mjs
 *
 * 产物 / Output
 *   {variant}-{theme}-{width}.png            12 张主图（本目录）
 *   states/{variant}-{state}-dark-1440.png   无在线 / 加载失败（每方案各 2 张）
 *   states/b-expanded-dark-{width}.png        B 的展开详情（2 张）
 *   states/b-comfortable-dark-1440.png        B 的舒适密度（1 张）
 *
 * 只读本地 file:// 的 a.html / b.html / c.html，不启动任何服务。
 * 环境变量：PLAYWRIGHT_MODULE（playwright/index.mjs 路径）、
 *           CHROME_PATH（Chrome 可执行文件）。
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUT = HERE;
const STATES_OUT = path.join(HERE, "states");

const VARIANTS = [
  { id: "a", html: "a.html", label: "状态仪表盘", cards: ".srv" },
  { id: "b", html: "b.html", label: "极简列表", cards: ".row" },
  { id: "c", html: "c.html", label: "品牌化落地页", cards: ".card" },
];
const THEMES = ["dark", "light"];
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

mkdirSync(STATES_OUT, { recursive: true });

/* ---------------- 定位 playwright 与 Chrome ---------------- */
async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);

  // 本仓库的 npx 缓存：.npm-cache/_npx/<hash>/node_modules/playwright/index.mjs
  const npxRoot = path.join(ROOT, ".npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      const mod = path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs");
      if (existsSync(mod)) candidates.push(mod);
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
  throw new Error(
    "找不到 playwright。请安装 playwright，或设置 PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs",
  );
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/* ---------------- 任务表 ---------------- */
function jobs() {
  const list = [];

  // 12 张主图：3 方案 × 亮/暗 × 1440/390，文件名固定为 {variant}-{theme}-{width}.png
  for (const variant of VARIANTS) {
    for (const theme of THEMES) {
      for (const { width } of WIDTHS) {
        list.push({
          out: path.join(OUT, `${variant.id}-${theme}-${width}.png`),
          variant,
          theme,
          width,
          query: "",
          expectCards: true,
          label: `${variant.id} ${theme} ${width}`,
        });
      }
    }
  }

  // 状态图：无在线 / 加载失败，暗色 1440（每个方案各两张）
  for (const variant of VARIANTS) {
    for (const state of ["offline", "error"]) {
      list.push({
        out: path.join(STATES_OUT, `${variant.id}-${state}-dark-1440.png`),
        variant,
        theme: "dark",
        width: 1440,
        query: `&state=${state}`,
        expectCards: state !== "error",
        label: `${variant.id} ${state} dark 1440`,
      });
    }
  }

  // B 的两种交互演示：展开详情、舒适密度
  for (const width of [1440, 390]) {
    list.push({
      out: path.join(STATES_OUT, `b-expanded-dark-${width}.png`),
      variant: VARIANTS[1],
      theme: "dark",
      width,
      query: "&expanded=hk",
      expectCards: true,
      label: `b expanded dark ${width}`,
    });
  }
  list.push({
    out: path.join(STATES_OUT, "b-comfortable-dark-1440.png"),
    variant: VARIANTS[1],
    theme: "dark",
    width: 1440,
    query: "&density=comfortable",
    expectCards: true,
    label: "b comfortable dark 1440",
  });

  return list;
}

/* ---------------- 渲染 ---------------- */
const chromium = await loadPlaywright();
const executablePath = chromePath();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const failures = [];
const results = [];

for (const job of jobs()) {
  const page = await browser.newPage({
    viewport: {
      width: job.width,
      height: job.width === 390 ? 844 : 1000,
    },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (error) => {
    failures.push(`${job.label}: ${error.message}`);
  });

  const url =
    pathToFileURL(path.join(HERE, job.variant.html)).href +
    `?theme=${job.theme}${job.query}`;

  try {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(
      () => document.documentElement.dataset.ready === "1",
      undefined,
      { timeout: 10_000 },
    );
    await page.evaluate(() => document.fonts.ready);
    // 两帧之后再截，确保字体与布局都已落地
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.mouse.move(1, 1);

    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        scrollHeight: doc.scrollHeight,
      };
    });
    if (metrics.scrollWidth > metrics.clientWidth + 1) {
      throw new Error(
        `横向溢出 ${metrics.scrollWidth} > ${metrics.clientWidth}（${url}）`,
      );
    }

    if (job.expectCards) {
      const count = await page.locator(job.variant.cards).count();
      if (count !== 8) {
        throw new Error(`${job.variant.id} 期望 8 台服务器，实际 ${count}`);
      }
    }

    await page.screenshot({ path: job.out, fullPage: true });

    const bytes = statSync(job.out).size;
    results.push({
      file: path.relative(HERE, job.out),
      width: metrics.scrollWidth,
      height: metrics.scrollHeight,
      kb: Math.round(bytes / 1024),
    });
    console.log(
      `ok  ${path.relative(HERE, job.out).padEnd(42)} ${metrics.scrollWidth}×${metrics.scrollHeight}  ${Math.round(bytes / 1024)} KB`,
    );
  } catch (error) {
    failures.push(`${job.label}: ${error.message}`);
    console.error(`FAIL ${job.label}: ${error.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();

console.log(
  `\n${results.length} 张截图 → ${path.relative(process.cwd(), OUT) || "."}` +
    (existsSync(STATES_OUT) ? `，状态图在 ${path.relative(process.cwd(), STATES_OUT)}` : ""),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} 个任务失败：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
