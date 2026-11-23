#!/usr/bin/env node
/**
 * 链路列表「标准表格」改版的验收截图 + 几何报告。
 *
 * 数据来自真实主控（`data/chain-rows-v2.db`，复制自 `data/preview.db` 并把
 * 时延/探测样本平移到当前窗口）。4 跳链、慢链、地址、路由、样本时间、P50、
 * 窗口丢包都来自真实接口，不注入 mock。
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
  const addressCell = row.querySelector("[data-chain-row-address]");
  const address = row.querySelector("[data-chain-endpoint-address]");
  const route = row.querySelector("[data-chain-row-route]");
  const metrics = row.querySelector("[data-chain-row-metrics]");
  const hops = row.querySelector("[data-chain-hops]");
  const p50 = row.querySelector("[data-chain-p50]");
  const loss = row.querySelector("[data-chain-loss]");
  const status = row.querySelector("[data-chain-status]");
  const chevron = row.querySelector("[data-chain-chevron]");
  const head = document.querySelector("[data-chain-list-head]");
  const font = (element) =>
    element ? Number.parseFloat(getComputedStyle(element).fontSize) : null;
  const box = (element) => {
    if (!element) return null;
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
  const rowStyle = getComputedStyle(row);
  const columns = rowStyle.gridTemplateColumns
    .split(" ")
    .map((value) => Number.parseFloat(value))
    .filter((value) => Number.isFinite(value));
  return {
    row: box(row),
    lead: box(lead),
    addressCell: box(addressCell),
    address: box(address),
    routeCell: box(route),
    metrics: box(metrics),
    hops: box(hops),
    p50: box(p50),
    loss: box(loss),
    status: box(status),
    chevron: box(chevron),
    columns,
    columnGap: Number.parseFloat(rowStyle.columnGap),
    rowHeight: Math.round(row.getBoundingClientRect().height),
    fonts: {
      hops: font(hops),
      address: font(address),
      route: font(row.querySelector("[data-chain-endpoint-name]")),
      sample: font(row.querySelector("[data-chain-sample]")),
      p50: font(row.querySelector("[data-chain-p50] .font-mono")),
      loss: font(row.querySelector("[data-chain-loss] .text-sm")),
    },
    addressWidth: Math.round(address.getBoundingClientRect().width),
    headerCount: document.querySelectorAll("[data-chain-list-head]").length,
    headerVisible: Boolean(head && head.offsetParent !== null),
    headerText: head?.innerText.replace(/\s+/g, " ").trim() ?? "",
    rowText: row.innerText.replace(/\s+/g, " ").trim(),
    connectorCount: row.querySelectorAll(
      "[data-chain-connector], .h-px",
    ).length,
    scrollOverflow: document.documentElement.scrollWidth - window.innerWidth,
    text: {
      address: address.textContent.replace(/\s+/g, " ").trim(),
      route: row
        .querySelector("[data-chain-endpoint-name]")
        ?.textContent.replace(/\s+/g, " ")
        .trim(),
      sample: row
        .querySelector("[data-chain-sample]")
        ?.textContent.replace(/\s+/g, " ")
        .trim(),
    },
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

    await check(`[${key}] 标准表格列宽 / 行高 / 字号`, async () => {
      assert.equal(rowCount, 3, `expected 3 chains, got ${rowCount}`);
      assert.equal(geometry.fonts.hops, 13, "跳数 13px");
      assert.equal(geometry.fonts.address, 12, "地址 12px");
      assert.equal(geometry.fonts.route, 12, "路由 12px");
      assert.equal(geometry.fonts.sample, 12, "样本时间 12px");
      assert.equal(geometry.fonts.p50, 15, "P50 15px");
      assert.equal(geometry.fonts.loss, 14, "丢包 14px");
      assert.ok(geometry.addressWidth <= 520, `地址宽 ${geometry.addressWidth}px`);
      if (width === 1440) {
        assert.equal(geometry.columns.length, 8, "8 列");
        const [, , , hops, p50, loss, status, chevron] = geometry.columns;
        assert.ok(Math.abs(hops - 64) <= 4, `跳数列 ${hops}px`);
        assert.ok(Math.abs(p50 - 80) <= 4, `P50 列 ${p50}px`);
        assert.ok(Math.abs(loss - 88) <= 4, `丢包列 ${loss}px`);
        assert.ok(Math.abs(status - 88) <= 4, `状态列 ${status}px`);
        assert.ok(Math.abs(chevron - 24) <= 4, `chevron 列 ${chevron}px`);
        const linkAddress = geometry.columns[0] / geometry.columns[1];
        const routeAddress = geometry.columns[2] / geometry.columns[1];
        assert.ok(Math.abs(linkAddress - 20 / 32) <= 0.08, `链路/地址比 ${linkAddress}`);
        assert.ok(Math.abs(routeAddress - 22 / 32) <= 0.08, `路由/地址比 ${routeAddress}`);
        assert.ok(
          geometry.rowHeight >= 56 && geometry.rowHeight <= 80,
          `行高 ${geometry.rowHeight}px`,
        );
        assert.ok(geometry.columnGap <= 40, `列间距 ${geometry.columnGap}px`);
      } else {
        assert.ok(geometry.scrollOverflow <= 1, `溢出 ${geometry.scrollOverflow}px`);
      }
      return { geometry, rowCount, slowBadge };
    });

    await check(`[${key}] 表头只出现一次，行内不重复标签`, async () => {
      assert.equal(geometry.headerCount, 1, "表头必须唯一");
      assert.equal(
        geometry.headerVisible,
        width === 1440,
        "表头只在桌面显示",
      );
      assert.equal(
        geometry.headerText.split("窗口丢包").length - 1,
        1,
        "表头只写一次窗口丢包",
      );
      assert.ok(geometry.headerText.includes("路由"), "表头必须有路由列");
      assert.ok(
        !geometry.rowText.includes("窗口丢包"),
        `行内出现窗口丢包: ${geometry.rowText}`,
      );
      assert.ok(!geometry.rowText.includes("P50"), `行内出现 P50: ${geometry.rowText}`);
      assert.equal(geometry.connectorCount, 0, "不允许连接线元素");
      return {
        headerText: geometry.headerText,
        headerVisible: geometry.headerVisible,
        rowText: geometry.rowText,
        connectorCount: geometry.connectorCount,
      };
    });

    await check(`[${key}] 地址不拉伸，390 单列堆叠`, async () => {
      if (width === 1440) {
        assert.ok(geometry.addressWidth <= 520, `地址宽 ${geometry.addressWidth}px`);
        assert.ok(geometry.columnGap <= 40, `列间距 ${geometry.columnGap}px`);
      } else {
        assert.ok(
          geometry.address.y >= geometry.lead.bottom,
          "地址必须在名称下方",
        );
        assert.ok(
          geometry.routeCell.y >= geometry.address.bottom,
          "路由必须在地址下方",
        );
        assert.ok(
          geometry.metrics.y >= geometry.routeCell.bottom,
          "指标在最后一行",
        );
        assert.ok(geometry.scrollOverflow <= 1, `溢出 ${geometry.scrollOverflow}px`);
      }
      return {
        addressWidth: geometry.addressWidth,
        columnGap: geometry.columnGap,
        positions: {
          lead: geometry.lead,
          address: geometry.addressCell,
          route: geometry.routeCell,
          metrics: geometry.metrics,
        },
      };
    });

    await check(`[${key}] 4 跳路由用省略号，不编造中间节点`, async () => {
      const labels = fourHopRoute.split(" → ");
      assert.equal(labels.length, 4, `route labels: ${fourHopRoute}`);
      assert.equal(labels[0], "香港-01");
      assert.equal(labels[1], "东京-01");
      assert.equal(labels[2], "…");
      assert.equal(labels[3], "大阪-01");
      assert.ok(!fourHopRoute.includes("新加坡-01"));
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
