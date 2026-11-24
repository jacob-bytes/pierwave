#!/usr/bin/env node
/**
 * 全站字号下限 / 横向溢出巡检（不截图，只出机读报告）。
 *
 * Full-site type-floor and horizontal-overflow probe. It walks every admin
 * route plus the public status pages and login at 1440 and 390, records the
 * smallest visible font size, any text below 11px, and document overflow.
 *
 * Usage:
 *   node web/screenshots/font-floor/probe.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://localhost:5173";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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
      /* try next */
    }
  }
  const mod = await import("playwright");
  return mod.chromium;
}

const chromium = await loadPlaywright();

const loginResponse = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "devpass" }),
});
assert.equal(loginResponse.status, 200, "admin login failed");
const sessionCookie = loginResponse.headers
  .getSetCookie()
  .map((item) => item.split(";")[0])
  .find((item) => item.startsWith("pierwave_session="));
const [cookieName, cookieValue] = sessionCookie.split("=");

const servers = (await (await fetch(`${BASE}/api/v1/servers`, {
  headers: { Cookie: sessionCookie },
})).json()).items;
const server = servers.find((item) => item.name === "香港-01") ?? servers[0];
const publicStatus = await (await fetch(`${BASE}/api/v1/public/status`)).json();
const publicServer = publicStatus.servers?.[0];

const ROUTES = [
  ["overview-server", "/?view=server"],
  ["overview-traffic", "/?view=traffic"],
  ["overview-cost", "/?view=cost"],
  ["overview-chain", "/?view=chain"],
  ["servers", "/servers"],
  ["server-nodes", `/servers/${server.id}/nodes`],
  ["server-outbounds", `/servers/${server.id}/outbounds`],
  ["server-forwards", `/servers/${server.id}/forwards`],
  ["chains", "/chains"],
  ["chain-templates", "/chain-templates"],
  ["forward-usage", "/forward-usage"],
  ["nodes", "/nodes"],
  ["users", "/users"],
  ["subscriptions", "/subscriptions"],
  ["packages", "/packages"],
  ["logs", "/logs"],
  ["settings", "/settings"],
  ["settings-security", "/settings?tab=security"],
  ["settings-alerts", "/settings?tab=alerts"],
  ["settings-backup", "/settings?tab=backup"],
  ["settings-templates", "/settings?tab=templates"],
  ["settings-subscription-templates", "/settings?tab=subscription-templates"],
  ["settings-certificates", "/settings?tab=certificates"],
  ["me", "/me"],
  ["me-subscription", "/me/subscription"],
  ["me-forwards", "/me/forwards"],
  ["me-packages", "/me/packages"],
  ["status", "/status"],
  ["status-detail", `/status/${publicServer.id}`],
];

const MEASURE = () => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (Number.parseFloat(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0.5 && rect.height > 0.5;
  };
  const describe = (element) => {
    const tag = element.tagName.toLowerCase();
    const slot = element.getAttribute("data-slot");
    return `${tag}${slot ? `[data-slot="${slot}"]` : ""}`;
  };
  const directText = (element) =>
    [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();

  const rows = [];
  for (const element of document.querySelectorAll("body *")) {
    if (!(element instanceof HTMLElement)) continue;
    const text = directText(element);
    if (text === "" || !visible(element)) continue;
    const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
    if (Number.isFinite(fontSize)) {
      rows.push({ selector: describe(element), text: text.slice(0, 40), fontSize });
    }
  }
  const below = rows.filter((row) => row.fontSize < 10.999);
  const doc = document.documentElement;
  return {
    url: location.pathname + location.search,
    overflowX: Math.max(0, doc.scrollWidth - window.innerWidth),
    minFont: rows.reduce((min, row) => Math.min(min, row.fontSize), Infinity),
    belowEleven: below.slice(0, 8),
    belowElevenCount: below.length,
  };
};

const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  headless: true,
});
const report = { generatedAt: new Date().toISOString(), base: BASE, pages: [], errors: [] };

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
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(`${width}: ${message.text()}`);
  });

  for (const [name, url] of ROUTES) {
    await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle");
    } catch {
      /* polling pages can stay busy; screenshot anyway */
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    const metrics = await page.evaluate(MEASURE);
    report.pages.push({ name, width, ...metrics });
    console.log(
      `${String(width).padEnd(4)} ${name.padEnd(32)} min=${String(metrics.minFont).padEnd(5)} overflow=${metrics.overflowX}px below11=${metrics.belowElevenCount}`,
    );
    if (metrics.belowElevenCount > 0) {
      console.log("     ", JSON.stringify(metrics.belowEleven));
    }
  }

  // 服务器状态 tab 的「热力图」子视图：日期 / 小时表头是最小的文字之一。
  await page.goto(`${BASE}/?view=server&mode=heatmap`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator("[data-heatmap]").first().waitFor({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
  {
    const metrics = await page.evaluate(MEASURE);
    report.pages.push({ name: "overview-server-heatmap", width, ...metrics });
    console.log(
      `${String(width).padEnd(4)} ${"overview-server-heatmap".padEnd(32)} min=${String(metrics.minFont).padEnd(5)} overflow=${metrics.overflowX}px below11=${metrics.belowElevenCount}`,
    );
    if (metrics.belowElevenCount > 0) {
      console.log("     ", JSON.stringify(metrics.belowEleven));
    }
  }

  // 链路详情弹窗：390 下时间轴刻度是否互相压住。
  await page.goto(`${BASE}/?view=chain`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator("[data-chain-list-row]").first().click();
  await page.locator("[data-chain-time-axis]").first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const ticks = await page.evaluate(() => {
    const axis = document.querySelectorAll("[data-chain-time-axis]");
    return [...axis].map((node) => {
      const rects = [...node.querySelectorAll("[data-chain-time-tick]")].map((tick) => {
        const rect = tick.getBoundingClientRect();
        return {
          text: tick.textContent.trim(),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      });
      const overlaps = [];
      for (let index = 1; index < rects.length; index += 1) {
        if (rects[index].left < rects[index - 1].right + 2) {
          overlaps.push([rects[index - 1].text, rects[index].text]);
        }
      }
      const dialog = node.closest('[role="dialog"]');
      const width = dialog?.getBoundingClientRect().width ?? null;
      return { dialogWidth: width, ticks: rects, overlaps };
    });
  });
  report.pages.push({ name: "chain-detail-ticks", width, ticks });
  console.log(
    `${String(width).padEnd(4)} chain-detail-ticks             overlaps=${JSON.stringify(ticks.map((item) => item.overlaps))}`,
  );

  await context.close();
}

// 未登录的登录页。
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
  const page = await context.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);
  const metrics = await page.evaluate(MEASURE);
  report.pages.push({ name: "login", width, ...metrics });
  console.log(
    `${String(width).padEnd(4)} ${"login".padEnd(32)} min=${String(metrics.minFont).padEnd(5)} overflow=${metrics.overflowX}px below11=${metrics.belowElevenCount}`,
  );
  await context.close();
}

await browser.close();
writeFileSync(`${HERE}/probe-report.json`, `${JSON.stringify(report, null, 2)}\n`);

const bad = report.pages.filter(
  (item) => item.belowElevenCount > 0 || item.overflowX > 0,
);
console.log(`\n${report.pages.length} page checks, ${bad.length} with violations`);
if (report.errors.length) console.error(report.errors.join("\n"));
if (bad.length) process.exitCode = 1;
