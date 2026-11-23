#!/usr/bin/env node
/**
 * 链路列表两行式改版的验收截图 + 几何报告。
 *
 * 数据来自真实主控（`data/chain-rows-v2.db`，复制自 `data/preview.db` 并把
 * 时延/探测样本平移到当前窗口）。不注入 mock：4 跳链、3 跳链、2 跳链、慢链
 * 徽章、起点/出口和窗口丢包都来自真实接口。
 *
 * 前置 / Prerequisite:
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
 *   PIERWAVE_DB='sqlite://data/chain-rows-v2.db?mode=rwc' ./target/debug/pierwave-master
 *   cd web && npm run dev
 *
 * 用法 / Usage:
 *   node web/screenshots/chain-row-v2/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const OUT = HERE;
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
  body: JSON.stringify({ username: "admin", password: "devpass" }),
});
assert.equal(loginResponse.status, 200, `login failed: ${loginResponse.status}`);
const sessionCookie = loginResponse.headers
  .getSetCookie()
  .map((item) => item.split(";")[0])
  .find((item) => item.startsWith("pierwave_session="));
assert.ok(sessionCookie, "session cookie must exist");
const [cookieName, cookieValue] = sessionCookie.split("=");

const results = [];
const failures = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    failures.push(`${name}: ${error.message}`);
  }
}

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

async function openList(page) {
  await page.goto(`${BASE}/?view=chain`, { waitUntil: "networkidle" });
  await page.locator("[data-chain-list]").waitFor();
  await page.locator("[data-chain-list-row]").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

const GEOMETRY = () => {
  const row = document.querySelector("[data-chain-list-row]");
  const lead = row.querySelector("[data-chain-row-lead]");
  const route = row.querySelector("[data-chain-row-route]");
  const metrics = row.querySelector("[data-chain-row-metrics]");
  const hops = row.querySelector("[data-chain-hops]");
  const sample = row.querySelector("[data-chain-sample]");
  const address = row.querySelector("[data-chain-endpoint-address]");
  const names = row.querySelector("[data-chain-endpoint-name]");
  const p50 = row.querySelector("[data-chain-p50] .font-mono");
  const loss = row.querySelector("[data-chain-loss] .text-sm");
  const font = (element) =>
    element ? Number.parseFloat(getComputedStyle(element).fontSize) : null;
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
    };
  };
  const leadBox = box(lead);
  const routeBox = box(route);
  const metricsBox = box(metrics);
  const addressBox = box(address);
  return {
    row: box(row),
    lead: leadBox,
    route: routeBox,
    metrics: metricsBox,
    gapLeadRoute: routeBox.x - leadBox.right,
    gapRouteMetrics: metricsBox.x - routeBox.right,
    gapAddressMetrics: metricsBox.x - addressBox.right,
    address: addressBox,
    fonts: {
      hops: font(hops),
      sample: font(sample),
      address: font(address),
      names: font(names),
      p50: font(p50),
      loss: font(loss),
    },
    text: {
      hops: hops?.textContent?.trim(),
      sample: sample?.textContent?.trim(),
      address: address?.textContent?.replace(/\s+/g, " ").trim(),
      names: names?.textContent?.replace(/\s+/g, " ").trim(),
    },
    scrollOverflow: document.documentElement.scrollWidth - window.innerWidth,
  };
};

const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  headless: true,
});

for (const theme of ["dark", "light"]) {
  for (const [width, height] of [
    [1440, 1000],
    [390, 844],
  ]) {
    const key = `${width}-${theme}`;
    const context = await newContext(browser, width, height, theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });

    await openList(page);

    const geometry = await page.evaluate(GEOMETRY);
    const rowCount = await page.locator("[data-chain-list-row]").count();
    const fourHop = page
      .locator("[data-chain-list-row]", { hasText: "港日中转链" })
      .first();
    const fourHopRoute = (
      await fourHop.locator("[data-chain-endpoint-name]").innerText()
    )
      .replace(/\s+/g, " ")
      .trim();
    const slowBadge = await fourHop.locator("[data-chain-slow-badge]").count();
    const headVisible = await page.locator("[data-chain-list-head]").isVisible();

    await check(`[${key}] 两行式三段布局`, async () => {
      assert.equal(rowCount, 3, `expected 3 chains, got ${rowCount}`);
      assert.equal(geometry.fonts.hops, 13, "跳数字号必须是 13px");
      assert.equal(geometry.fonts.sample, 13, "最近样本与跳数同字号");
      assert.equal(geometry.fonts.address, 13, "地址等宽 13px");
      assert.equal(geometry.fonts.names, 12, "服务器路由 12px");
      assert.equal(geometry.fonts.p50, 20, "P50 20px");
      assert.equal(geometry.fonts.loss, 14, "窗口丢包 14px");
      assert.ok(geometry.row.height >= 56, `row height ${geometry.row.height}`);
      assert.ok(geometry.scrollOverflow <= 1, `overflow ${geometry.scrollOverflow}px`);
      return { geometry, rowCount, slowBadge, headVisible };
    });

    await check(`[${key}] 块之间没有 >40px 空白`, async () => {
      if (width === 1440) {
        assert.ok(
          geometry.gapLeadRoute <= 40,
          `lead→route gap ${geometry.gapLeadRoute}px`,
        );
        assert.ok(
          geometry.gapRouteMetrics <= 40,
          `route→metrics gap ${geometry.gapRouteMetrics}px`,
        );
        assert.ok(
          geometry.gapAddressMetrics <= 40,
          `address→metrics gap ${geometry.gapAddressMetrics}px`,
        );
      } else {
        // 390：三块纵向堆叠，名称 → 地址 → 指标。
        assert.ok(
          geometry.route.y >= geometry.lead.bottom,
          "route must stack below lead",
        );
        assert.ok(
          geometry.metrics.y >= geometry.route.bottom,
          "metrics must stack below route",
        );
      }
      return {
        gapLeadRoute: geometry.gapLeadRoute,
        gapRouteMetrics: geometry.gapRouteMetrics,
        gapAddressMetrics: geometry.gapAddressMetrics,
      };
    });

    await check(`[${key}] 4 跳链路由用省略号，不编造中间节点`, async () => {
      const labels = fourHopRoute.split(" → ");
      assert.equal(labels.length, 4, `route labels: ${fourHopRoute}`);
      assert.equal(labels[0], "香港-01");
      assert.equal(labels[1], "东京-01");
      assert.equal(labels[2], "…");
      assert.equal(labels[3], "大阪-01");
      assert.ok(!fourHopRoute.includes("新加坡-01"), "中间节点必须省略");
      assert.equal(slowBadge, 1, "慢链显示「变慢」徽章");
      return { fourHopRoute, slowBadge };
    });

    await check(`[${key}] 没有页面错误`, async () => {
      assert.deepEqual(errors, []);
      return { errors };
    });

    const card = page.locator("[data-chain-list-card]");
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await card.screenshot({ path: path.join(OUT, `rows-${key}.png`) });
    console.log(`saved rows-${key}.png`);

    await context.close();
  }
}

await browser.close();

writeFileSync(
  path.join(OUT, "report.json"),
  `${JSON.stringify({ results, failures }, null, 2)}\n`,
);
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
