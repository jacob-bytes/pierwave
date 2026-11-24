#!/usr/bin/env node
/**
 * 字号下限（最小 11px）改版的可视证据与机读报告。
 *
 * 覆盖：概览四个 tab / 服务器列表 / 转发列表 / 链路详情弹窗 / 公开状态页 /
 * 设置页；1440×900 与 390×844；暗色与亮色；改动前后各一轮。
 *
 * Screenshot + DOM evidence for the 11px type floor: four overview tabs, the
 * server list, the forward list, the chain detail dialog, the public status
 * page and settings, at 1440×900 / 390×844 in both themes, before and after.
 *
 * 前置 / Prerequisite:
 *   cp data/preview.db data/font-floor.db         # 见 README 的样本平移步骤
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
 *   PIERWAVE_DB='sqlite://data/font-floor.db?mode=rwc' target/debug/pierwave-master
 *   cd web && npm run dev
 *
 * 用法 / Usage:
 *   node web/screenshots/font-floor/shots.mjs before
 *   node web/screenshots/font-floor/shots.mjs after
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://localhost:5173";
const ADMIN = process.env.ADMIN_PASSWORD ?? "devpass";
const PHASE = ["before", "after", "before13", "after13"].includes(
  process.argv[2],
)
  ? process.argv[2]
  : "after";
const OUT = path.join(HERE, PHASE);
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT, { recursive: true });

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
  body: JSON.stringify({ username: "admin", password: ADMIN }),
});
assert.equal(loginResponse.status, 200, `login failed: ${loginResponse.status}`);
const sessionCookie = loginResponse.headers
  .getSetCookie()
  .map((item) => item.split(";")[0])
  .find((item) => item.startsWith("pierwave_session="));
assert.ok(sessionCookie, "session cookie must exist");
const [cookieName, cookieValue] = sessionCookie.split("=");

const serversResponse = await fetch(`${BASE}/api/v1/servers`, {
  headers: { Cookie: sessionCookie },
});
assert.equal(serversResponse.status, 200, "servers request failed");
const serversPayload = await serversResponse.json();
const servers = serversPayload.items ?? serversPayload;
const forwardServer = servers.find((server) => server.name === "香港-01") ?? servers[0];
assert.ok(forwardServer, "at least one server is required");

const THEMES = /** @type {const} */ (["dark", "light"]);
const VIEWPORTS = [
  [1440, 900],
  [390, 844],
];

/** 页面清单：name / url / 等待选择器。 */
const PAGES = [
  { name: "overview-server", url: "/?view=server", wait: "[data-uptime-mode]" },
  { name: "overview-server-heatmap", url: "/?view=server&mode=heatmap", wait: "[data-heatmap]" },
  { name: "overview-traffic", url: "/?view=traffic", wait: "[data-traffic-view]" },
  { name: "overview-cost", url: "/?view=cost", wait: "[data-cost-view]" },
  { name: "overview-chain", url: "/?view=chain", wait: "[data-chain-list]" },
  { name: "servers", url: "/servers", wait: "[data-slot=table-container]" },
  {
    name: "forwards",
    url: `/servers/${forwardServer.id}/forwards`,
    wait: "[data-slot=table-container]",
  },
  { name: "status", url: "/status", wait: "main" },
  { name: "settings", url: "/settings", wait: "[data-settings-page] or main" },
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
    const attr = ["data-slot", "data-testid", "data-chain-list-row"]
      .map((name) => {
        const value = element.getAttribute(name);
        return value ? `[${name}="${value}"]` : "";
      })
      .join("");
    const cls = typeof element.className === "string"
      ? element.className.split(/\s+/).filter(Boolean).slice(0, 4).map((c) => `.${c}`).join("")
      : "";
    return `${tag}${attr}${cls}`;
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
    if (text === "") continue;
    if (!visible(element)) continue;
    const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
    if (!Number.isFinite(fontSize)) continue;
    rows.push({ selector: describe(element), text: text.slice(0, 48), fontSize });
  }
  const belowEleven = rows.filter((row) => row.fontSize < 10.999);
  const min = rows.reduce(
    (best, row) => (best === null || row.fontSize < best.fontSize ? row : best),
    null,
  );
  const typeMicro = [...document.querySelectorAll(".type-micro")]
    .filter((element) => element instanceof HTMLElement && visible(element))
    .map((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  const doc = document.documentElement;
  return {
    url: location.pathname + location.search,
    innerWidth: window.innerWidth,
    scrollWidth: Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0),
    overflowX: Math.max(0, doc.scrollWidth - window.innerWidth),
    textNodeCount: rows.length,
    minFont: min,
    belowElevenCount: belowEleven.length,
    belowEleven: belowEleven.slice(0, 12),
    elevenCount: rows.filter((row) => Math.abs(row.fontSize - 11) < 0.01).length,
    twelveCount: rows.filter((row) => Math.abs(row.fontSize - 12) < 0.01).length,
    typeMicro: typeMicro.length === 0 ? null : Math.min(...typeMicro),
    fonts: [...new Set(rows.map((row) => row.fontSize))].sort((a, b) => a - b),
  };
};

const TOPOLOGY = () => {
  const labels = [
    ...document.querySelectorAll(
      "[data-chain-topology-edge-latency], [data-chain-topology-edge-loss]",
    ),
  ];
  const rows = labels.map((label) => {
    const style = getComputedStyle(label);
    const parent = label.parentElement;
    const parentRect = parent?.getBoundingClientRect();
    const rect = label.getBoundingClientRect();
    return {
      kind: label.hasAttribute("data-chain-topology-edge-latency")
        ? "latency"
        : "loss",
      text: label.textContent.trim(),
      fontSize: Number.parseFloat(style.fontSize),
      truncate: style.textOverflow,
      clientWidth: label.clientWidth,
      scrollWidth: label.scrollWidth,
      clipped: label.scrollWidth > label.clientWidth + 1,
      overflowsParent: parentRect ? rect.width > parentRect.width + 0.5 : null,
      rectWidth: Math.round(rect.width),
      parentWidth: parentRect ? Math.round(parentRect.width) : null,
    };
  });
  const scroll = document.querySelector("[data-chain-topology-scroll]");
  return {
    labels: rows,
    edgeCount: document.querySelectorAll("[data-chain-topology-edge]").length,
    scrollOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : null,
  };
};

async function newContext(browser, width, height, theme) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  await context.addInitScript(
    ({ theme }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", "zh-CN");
    },
    { theme },
  );
  await context.addCookies([
    {
      name: cookieName,
      value: cookieValue,
      url: `${BASE}/`,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return context;
}

async function settle(page, wait) {
  if (wait) {
    try {
      await page.locator(wait).first().waitFor({ timeout: 15_000 });
    } catch {
      // 选择器是提示，不阻塞截图；等待网络与前端的骨架退场即可。
    }
  }
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  headless: true,
});

const report = {
  phase: PHASE,
  base: BASE,
  generatedAt: new Date().toISOString(),
  pages: [],
  topology: [],
  errors: [],
};

for (const theme of THEMES) {
  for (const [width, height] of VIEWPORTS) {
    const key = `${width}-${theme}`;
    const context = await newContext(browser, width, height, theme);
    const page = await context.newPage();
    page.on("pageerror", (error) => report.errors.push(`${key}: ${error}`));
    page.on("console", (message) => {
      if (message.type() === "error") report.errors.push(`${key}: ${message.text()}`);
    });

    for (const entry of PAGES) {
      try {
        await page.goto(`${BASE}${entry.url}`, { waitUntil: "domcontentloaded" });
        await settle(page, entry.wait);
        const metrics = await page.evaluate(MEASURE);
        await page.screenshot({
          path: path.join(OUT, `${entry.name}-${key}.png`),
          fullPage: true,
          animations: "disabled",
        });
        report.pages.push({ name: entry.name, theme, width, ...metrics });
        console.log(`saved ${entry.name}-${key}.png  min=${metrics.minFont?.fontSize}px  overflow=${metrics.overflowX}px`);
      } catch (error) {
        report.errors.push(`${key}/${entry.name}: ${error.message}`);
        console.error(`${key}/${entry.name} failed: ${error.message}`);
      }
    }

    // 链路详情弹窗：普通数据 + 针对长标注的注入数据（只改浏览器里的响应）。
    try {
      await page.goto(`${BASE}/?view=chain`, { waitUntil: "domcontentloaded" });
      await settle(page, "[data-chain-list]");
      await page.locator("[data-chain-list-row]").first().click();
      await page.locator("[data-chain-topology]").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(350);
      const topology = await page.evaluate(TOPOLOGY);
      await page.screenshot({
        path: path.join(OUT, `chain-detail-${key}.png`),
        animations: "disabled",
      });
      const dialog = page.locator('[role="dialog"]').first();
      if (await dialog.count()) {
        await dialog.screenshot({
          path: path.join(OUT, `chain-detail-panel-${key}.png`),
          animations: "disabled",
        });
      }
      report.topology.push({ theme, width, variant: "real", ...topology });
      console.log(`saved chain-detail-${key}.png  edges=${topology.edgeCount}  clipped=${topology.labels.filter((label) => label.clipped).length}`);

      // 注入：多路径估算（128.5 ms ≈）与最后一跳不可测（不可测量 / 原因）。
      await page.route("**/api/v1/overview/chain-health?*", async (route) => {
        const response = await route.fetch();
        const payload = await response.json();
        const target = payload.chains?.find((chain) => chain.name === "港日多路径");
        if (target) {
          target.estimated = true;
          target.last_hop = { measurable: false, reason: "engine_unsupported" };
          target.loss_partial = true;
          const segment = target.segments?.find((item) => item.seq === 2);
          if (segment) {
            segment.p50 = 128.5;
            segment.loss_pct = 0.8;
            segment.attempts = 120;
            segment.failures = 1;
          }
        }
        await route.fulfill({
          status: response.status(),
          headers: response.headers(),
          body: JSON.stringify(payload),
        });
      });
      await page.goto(`${BASE}/?view=chain`, { waitUntil: "domcontentloaded" });
      await settle(page, "[data-chain-list]");
      await page
        .locator("[data-chain-list-row]", { hasText: "港日多路径" })
        .first()
        .click();
      await page.locator("[data-chain-topology]").first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(350);
      const injected = await page.evaluate(TOPOLOGY);
      await page.screenshot({
        path: path.join(OUT, `chain-detail-long-${key}.png`),
        animations: "disabled",
      });
      const longDialog = page.locator('[role="dialog"]').first();
      if (await longDialog.count()) {
        await longDialog.screenshot({
          path: path.join(OUT, `chain-detail-long-panel-${key}.png`),
          animations: "disabled",
        });
      }
      report.topology.push({ theme, width, variant: "long-labels", ...injected });
      console.log(`saved chain-detail-long-${key}.png  clipped=${injected.labels.filter((label) => label.clipped).length}`);
      await page.unroute("**/api/v1/overview/chain-health?*");
    } catch (error) {
      report.errors.push(`${key}/chain-detail: ${error.message}`);
      console.error(`${key}/chain-detail failed: ${error.message}`);
    }

    // 链路列表卡片：390 下卡片高于视口，临时把视口拉高以便一张图看全。
    if (PHASE === "before13" || PHASE === "after13") {
      try {
        await page.setViewportSize({
          width,
          height: width === 390 ? 2000 : 1000,
        });
        await page.goto(`${BASE}/?view=chain`, { waitUntil: "domcontentloaded" });
        await settle(page, "[data-chain-list]");
        if (PHASE === "before13") {
          // 模拟本轮改动前的 12px：只回退列表第二行，其他数据保持不变。
          await page.addStyleTag({
            content:
              "[data-chain-sample],[data-chain-endpoint-name]{font-size:12px!important}",
          });
        }
        await page.locator("[data-chain-list-card]").scrollIntoViewIfNeeded();
        await page.waitForTimeout(350);
        await page.screenshot({
          path: path.join(OUT, `chain-list-${key}.png`),
          animations: "disabled",
        });
        console.log(`saved chain-list-${key}.png`);
      } catch (error) {
        report.errors.push(`${key}/chain-list: ${error.message}`);
        console.error(`${key}/chain-list failed: ${error.message}`);
      }
    }

    await context.close();
  }
}

await browser.close();

writeFileSync(
  path.join(HERE, `report-${PHASE}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(`\n${report.pages.length} page shots, ${report.topology.length} topology shots`);
if (report.errors.length > 0) {
  console.error(report.errors.join("\n"));
  process.exitCode = 1;
}
