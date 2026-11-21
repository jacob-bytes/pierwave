#!/usr/bin/env node
/**
 * 公开状态页轮询实测 / Wall-clock polling measurement.
 *
 * 实测两件事：
 * 1. 正常态：两次请求间隔约 20 秒；
 * 2. 失败态：连续 5xx 后按 5s / 10s / 20s / 40s / 60s 退避，上限 60 秒。
 *
 * 用法 / Usage:
 *   (cd web && npm run build && npx vite preview --port 4174 --strictPort)
 *   node web/screenshots/status-states/timing.mjs
 *
 * 两个浏览器上下文并行跑，互不共享 query cache，也不会互相抢焦点。
 * 结果写入 timing.json；环境变量 BASE_URL、PLAYWRIGHT_MODULE、CHROME_PATH。
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publicStatusFixture } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4174";
const NORMAL_EXPECTED = 20_000;
const BACKOFF_EXPECTED = [5_000, 10_000, 20_000, 40_000, 60_000];

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
      /* try next */
    }
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

async function waitForCount(list, count, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (list.length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `只收到 ${list.length} 次请求，期望 ${count} 次：${JSON.stringify(list)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const chromium = await loadPlaywright();
const executablePath = chromePath();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const normalTimes = [];
const failureTimes = [];

async function setupPage({ fail, times }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem("pierwave.theme", "dark");
    window.localStorage.setItem("pierwave.locale", "zh-CN");
  });
  await page.route("**/api/**", async (route) => {
    if (!route.request().url().includes("/api/v1/public/status")) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    times.push(Date.now());
    if (fail()) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ code: "internal", error: "boom" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(publicStatusFixture("all-online")),
    });
  });
  await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
  await page.locator("header h1").waitFor({ state: "visible", timeout: 15_000 });
  return { context, page };
}

function deltas(times) {
  return times.slice(1).map((time, index) => time - times[index]);
}

const startedAt = Date.now();

// 正常态：初始请求 + 一次 20 秒轮询。
const normal = await setupPage({ fail: () => false, times: normalTimes });
// 失败态：第一次就是 500，随后退避；第 6 次请求覆盖到 60 秒上限。
const failure = await setupPage({ fail: () => true, times: failureTimes });

await Promise.all([
  waitForCount(normalTimes, 2, 35_000),
  waitForCount(failureTimes, 6, 170_000),
]);

const normalGap = deltas(normalTimes);
const backoffGaps = deltas(failureTimes);

const closeTo = (actual, expected, tolerance) =>
  Math.abs(actual - expected) <= tolerance;

const checks = {
  normal20s: closeTo(normalGap[0], NORMAL_EXPECTED, 2_000),
  backoff5s: closeTo(backoffGaps[0], BACKOFF_EXPECTED[0], 1_000),
  backoff10s: closeTo(backoffGaps[1], BACKOFF_EXPECTED[1], 1_500),
  backoff20s: closeTo(backoffGaps[2], BACKOFF_EXPECTED[2], 2_000),
  backoff40s: closeTo(backoffGaps[3], BACKOFF_EXPECTED[3], 3_000),
  backoff60s: closeTo(backoffGaps[4], BACKOFF_EXPECTED[4], 4_000),
};

const report = {
  baseUrl: BASE_URL,
  measuredAt: new Date().toISOString(),
  elapsedMs: Date.now() - startedAt,
  normal: {
    expectedMs: NORMAL_EXPECTED,
    requests: normalTimes.length,
    gapsMs: normalGap,
  },
  failure: {
    expectedMs: BACKOFF_EXPECTED,
    requests: failureTimes.length,
    gapsMs: backoffGaps,
  },
  checks,
};

await normal.context.close();
await failure.context.close();
await browser.close();

writeFileSync(
  path.join(HERE, "timing.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(
  `normal 20s: ${normalGap.map((gap) => `${(gap / 1000).toFixed(2)}s`).join(", ")}`,
);
console.log(
  `failure backoff: ${backoffGaps
    .map((gap) => `${(gap / 1000).toFixed(2)}s`)
    .join(", ")}`,
);
console.log(JSON.stringify(checks));

if (Object.values(checks).some((ok) => !ok)) {
  process.exitCode = 1;
}
