#!/usr/bin/env node
/**
 * 11px / 12px 下的 tooltip 溢出检查：链路趋势、逐段趋势、整体时延 sparkline、
 * 服务器热力图。只出机读报告与局部截图。
 *
 * Tooltip overflow check at the new type sizes: chain trend, per-segment trend,
 * overall latency sparkline and the server heatmap.
 *
 * Usage: node web/screenshots/font-floor/tooltips.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://localhost:5173";
const OUT = path.join(HERE, "after");
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  for (const entry of readdirSync(path.join(ROOT, ".npm-cache", "_npx"))) {
    candidates.push(
      path.join(ROOT, ".npm-cache", "_npx", entry, "node_modules", "playwright", "index.mjs"),
    );
  }
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (mod.chromium) return mod.chromium;
    } catch {
      /* try next */
    }
  }
  return (await import("playwright")).chromium;
}

const chromium = await loadPlaywright();
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "devpass" }),
});
assert.equal(login.status, 200, "login failed");
const cookie = login.headers
  .getSetCookie()
  .map((item) => item.split(";")[0])
  .find((item) => item.startsWith("pierwave_session="));
const [cookieName, cookieValue] = cookie.split("=");
const publicStatus = await (await fetch(`${BASE}/api/v1/public/status`)).json();
const publicServerId = publicStatus.servers?.[0]?.id;

const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  headless: true,
});
const report = { generatedAt: new Date().toISOString(), tooltips: [], errors: [] };

const PROBE = (selector) => {
  const node = document.querySelector(selector);
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  const rows = [node, ...node.querySelectorAll("div,span")].map((row) => {
    const rowRect = row.getBoundingClientRect();
    return {
      text: row.textContent.replace(/\s+/g, " ").trim().slice(0, 60),
      scrollWidth: row.scrollWidth,
      clientWidth: row.clientWidth,
      clipped: row.scrollWidth > row.clientWidth + 1,
      fontSize: parseFloat(getComputedStyle(row).fontSize),
      right: Math.round(rowRect.right),
    };
  });
  return {
    fontSizes: [...new Set(rows.map((row) => row.fontSize))].sort((a, b) => a - b),
    rect: {
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
    },
    inViewport:
      rect.left >= 0 &&
      rect.right <= window.innerWidth + 1 &&
      rect.top >= 0 &&
      rect.bottom <= window.innerHeight + 1,
    clippedRows: rows.filter((row) => row.clipped).slice(0, 6),
    hidden: node.hidden,
    text: node.textContent.replace(/\s+/g, " ").trim().slice(0, 160),
  };
};

for (const [width, height] of [
  [1440, 900],
  [390, 844],
]) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });
  await context.addInitScript(() => {
    localStorage.setItem("pierwave.theme", "dark");
    localStorage.setItem("pierwave.locale", "zh-CN");
  });
  await context.addCookies([
    { name: cookieName, value: cookieValue, url: `${BASE}/`, httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${width}: ${error}`));

  // 1) 链路趋势图 tooltip
  await page.goto(`${BASE}/?view=chain`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const trend = page.locator("[data-chain-trend-chart] .recharts-wrapper").first();
  await trend.scrollIntoViewIfNeeded();
  const trendBox = await trend.boundingBox();
  await page.mouse.move(
    trendBox.x + trendBox.width * 0.6,
    trendBox.y + trendBox.height * 0.5,
  );
  await page.locator("[data-chain-trend-tooltip]").waitFor({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
  const trendTip = await page.evaluate(PROBE, "[data-chain-trend-tooltip]");
  report.tooltips.push({ name: "chain-trend", width, ...trendTip });
  await page.locator("[data-chain-trend-chart]").screenshot({
    path: path.join(OUT, `tooltip-chain-trend-${width}.png`),
  });

  // 2) 链路详情里的整体时延 sparkline tooltip
  await page.locator("[data-chain-list-row]").first().click();
  await page.locator("[data-chain-overall-card]").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(250);
  const spark = page.locator("[data-chain-sparkline]").first();
  await spark.scrollIntoViewIfNeeded();
  const sparkBox = await spark.boundingBox();
  await page.mouse.move(
    sparkBox.x + sparkBox.width * 0.5,
    sparkBox.y + sparkBox.height * 0.5,
  );
  await page.locator("[data-chain-sparkline-tooltip]").waitFor({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(200);
  const sparkTip = await page.evaluate(PROBE, "[data-chain-sparkline-tooltip]");
  report.tooltips.push({ name: "latency-sparkline", width, ...sparkTip });
  await page.locator("[data-chain-overall-card]").screenshot({
    path: path.join(OUT, `tooltip-latency-sparkline-${width}.png`),
  });

  // 3) 逐段趋势 tooltip：先滚到弹窗底部再 hover
  const dialog = page.locator('[role="dialog"]').first();
  const scroller = dialog.locator("[data-slot=dialog-content]").first();
  await page.evaluate(() => {
    const node = document.querySelector('[role="dialog"]');
    if (node) node.scrollTop = node.scrollHeight;
  });
  const segment = page.locator("[data-chain-segment-chart] .recharts-wrapper").first();
  if (await segment.count()) {
    await segment.scrollIntoViewIfNeeded();
    const segmentBox = await segment.boundingBox();
    await page.mouse.move(
      segmentBox.x + segmentBox.width * 0.55,
      segmentBox.y + segmentBox.height * 0.45,
    );
    await page
      .locator("[data-segment-tooltip]")
      .waitFor({ timeout: 5_000 })
      .catch(() => {});
    await page.waitForTimeout(200);
    const segmentTip = await page.evaluate(PROBE, "[data-segment-tooltip]");
    report.tooltips.push({ name: "segment-trend", width, ...segmentTip });
    await page.screenshot({
      path: path.join(OUT, `tooltip-segment-${width}.png`),
      animations: "disabled",
    });
  } else {
    report.errors.push(`${width}: segment trend chart not found`);
  }

  // 4) 服务器热力图 tooltip
  await page.goto(`${BASE}/?view=server&mode=heatmap`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator("[data-heatmap]").first().waitFor({ timeout: 10_000 });
  const cells = page.locator("[data-heatmap-cell]");
  const cellCount = await cells.count();
  if (cellCount > 0) {
    await cells.nth(Math.floor(cellCount / 2)).hover();
    await page.waitForTimeout(250);
    const heatTip = await page.evaluate(PROBE, "[data-heatmap-tooltip]");
    report.tooltips.push({ name: "server-heatmap", width, ...heatTip });
    await page.locator("[data-heatmap]").screenshot({
      path: path.join(OUT, `tooltip-heatmap-${width}.png`),
    });
  }

  // 5) 公开状态页：卡片迷你图与可用率曲线 tooltip（未登录路由，cookie 无影响）
  await page.goto(`${BASE}/status`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  const statusSpark = page.locator("[data-slot=hero-sparkline] svg").first();
  if (await statusSpark.count()) {
    const box = await statusSpark.boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page
      .locator("[data-slot=hero-sparkline-tooltip]")
      .waitFor({ timeout: 5_000 })
      .catch(() => {});
    await page.waitForTimeout(200);
    const statusTip = await page.evaluate(
      PROBE,
      "[data-slot=hero-sparkline-tooltip]",
    );
    report.tooltips.push({ name: "status-sparkline", width, ...statusTip });
  } else {
    report.errors.push(`${width}: status sparkline not found`);
  }

  if (publicServerId) {
    await page.goto(`${BASE}/status/${publicServerId}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    const plot = page.locator("[data-slot=availability-plot]").first();
    if (await plot.count()) {
      const box = await plot.boundingBox();
      await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.5);
      await page.waitForTimeout(250);
      const availabilityTip = await page.evaluate(
        PROBE,
        "[data-slot=availability-tooltip]",
      );
      report.tooltips.push({
        name: "status-availability",
        width,
        ...availabilityTip,
      });
      await page.screenshot({
        path: path.join(OUT, `tooltip-status-${width}.png`),
        animations: "disabled",
      });
    } else {
      report.errors.push(`${width}: availability plot not found`);
    }
  }

  await context.close();
}

await browser.close();
writeFileSync(`${HERE}/tooltip-report.json`, `${JSON.stringify(report, null, 2)}\n`);
for (const item of report.tooltips) {
  console.log(
    `${item.width} ${item.name}: fonts=${JSON.stringify(item.fontSizes)} inViewport=${item.inViewport} clipped=${item.clippedRows.length}`,
  );
}
if (report.errors.length) console.error(report.errors.join("\n"));
