#!/usr/bin/env node
/**
 * 服务器页密度改造验收：截图 + DOM 断言 / Server list density screenshots + assertions.
 *
 * 前置 / Prerequisite:
 *   PIERWAVE_DB='sqlite://data/preview.db' PIERWAVE_ADMIN_PASSWORD=devpass \
 *   PIERWAVE_ADDR=127.0.0.1:8787 ./target/debug/pierwave-master
 *   （web/dist 必须是当前构建；或把 BASE 指到 vite dev）
 *
 * 用法 / Usage:
 *   node web/screenshots/server-list-density/shots.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const ADMIN = process.env.ADMIN_PASSWORD ?? "devpass";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function loadPlaywright() {
  const npxRoot = path.join(ROOT, ".npm-cache", "_npx");
  const { existsSync, readdirSync } = await import("node:fs");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      const candidate = path.join(
        npxRoot,
        entry,
        "node_modules",
        "playwright",
        "index.mjs",
      );
      if (!existsSync(candidate)) continue;
      const mod = await import(pathToFileURL(candidate).href);
      if (mod.chromium) return mod.chromium;
    }
  }
  const mod = await import("playwright");
  return mod.chromium;
}

const chromium = await loadPlaywright();
mkdirSync(HERE, { recursive: true });

// ---- 登录 + 用真实数据算异常数量（不写死预览库内容） ----------------------
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: ADMIN }),
});
assert.equal(login.status, 200, `login failed: ${login.status}`);
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .find((value) => value.startsWith("pierwave_session="));
assert.ok(cookie, "no session cookie");
const [cookieName, cookieValue] = cookie.split("=");

const serverResponse = await fetch(`${BASE}/api/v1/servers`, {
  headers: { Cookie: cookie },
});
assert.equal(serverResponse.status, 200);
const serverPayload = await serverResponse.json();
const servers = Array.isArray(serverPayload)
  ? serverPayload
  : (serverPayload.items ?? []);
const abnormal = servers.filter(
  (server) => server.status === "online" && server.xray_running === false,
);
const online = servers.filter((server) => server.status === "online");
assert.ok(abnormal.length > 0, "preview data needs at least one service-abnormal server");

const report = {
  base: BASE,
  servers: servers.length,
  online: online.length,
  abnormal: abnormal.length,
  themes: {},
  assertions: [],
};
function pass(name, detail) {
  report.assertions.push({ name, ok: true, detail });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function newContext({ width, height, theme }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    locale: "zh-CN",
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
      url: BASE,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return context;
}

async function waitForTable(page) {
  await page.locator('tbody [data-slot="table-row"] td.pw-sticky-name').first().waitFor();
  await page.waitForTimeout(250);
}

for (const theme of ["dark", "light"]) {
  const entry = (report.themes[theme] = {});

  // ---- 1440 桌面：工具栏 / 滚动到右侧 / 异常筛选 --------------------------
  {
    const context = await newContext({ width: 1440, height: 1000, theme });
    const page = await context.newPage();
    await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
    await waitForTable(page);

    const container = page.locator('[data-slot="table-container"]').first();
    const tableMetrics = await container.evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      scrollLeft: el.scrollLeft,
    }));
    assert.ok(
      tableMetrics.scrollWidth > tableMetrics.clientWidth + 1,
      "1440 table must overflow horizontally for this assertion",
    );

    // 行高：h-16 目标 64px（应用结果徽章行允许 ±4px）。
    const rowHeights = await page
      .locator('tbody [data-slot="table-row"]')
      .evaluateAll((rows) =>
        rows
          .filter((row) => row.querySelector("td.pw-sticky-name"))
          .map((row) => Math.round(row.getBoundingClientRect().height)),
      );
    const minRow = Math.min(...rowHeights);
    const maxRow = Math.max(...rowHeights);
    assert.ok(minRow >= 62 && maxRow <= 68, `row heights ${minRow}..${maxRow} not ~64`);
    entry.rowHeights = { min: minRow, max: maxRow, count: rowHeights.length };
    pass(`${theme}: 行高 ~64px`, `${minRow}–${maxRow}px`);

    // 工具栏截图：在线计数在标题徽章里，描述只有一行。
    await page.screenshot({
      path: path.join(HERE, `servers-1440-${theme}-toolbar.png`),
    });
    const titleBadge = await page
      .locator('[data-slot="card-title"] [data-slot="badge"]')
      .first()
      .textContent();
    assert.match(titleBadge ?? "", /在线\s*\d+\s*\/\s*\d+/);
    entry.titleBadge = titleBadge?.trim();
    const descLines = await page
      .locator('[data-slot="card-description"]')
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el);
        const lineHeight = parseFloat(style.lineHeight);
        return Math.round(el.getBoundingClientRect().height / lineHeight);
      });
    assert.ok(descLines <= 2, `description uses ${descLines} lines`);
    entry.descriptionLines = descLines;

    // 滚动到最右：名称列仍在视口左侧，且紧贴复选框列（left: 40px）。
    await container.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForTimeout(150);
    const sticky = await page
      .locator('tbody [data-slot="table-row"] td.pw-sticky-name')
      .first()
      .evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          position: style.position,
          left: style.left,
          rectLeft: Math.round(el.getBoundingClientRect().left),
          visible: el.getBoundingClientRect().width > 0,
        };
      });
    assert.equal(sticky.position, "sticky", "name column must be sticky");
    assert.equal(sticky.left, "40px", "name column must stick after the 40px checkbox column");
    assert.ok(sticky.visible);
    const containerBox = await container.boundingBox();
    assert.ok(
      sticky.rectLeft >= containerBox.x - 1 &&
        sticky.rectLeft <= containerBox.x + 41,
      `name column left ${sticky.rectLeft} vs container ${containerBox.x}`,
    );
    // 名称文本真的还在视口里（不只是单元格存在）。
    const firstName = await page
      .locator('tbody [data-slot="table-row"] td.pw-sticky-name')
      .first()
      .innerText();
    assert.ok(firstName.trim().length > 0);

    // 提示条在可见区：滚动前后位置不变，且点击命中它自己。
    const hint = page.locator('[data-slot="table-scroll-hint"]').first();
    await hint.waitFor();
    const hintBoxBefore = await hint.boundingBox();
    await container.evaluate((el) => {
      el.scrollLeft = 0;
    });
    await page.waitForTimeout(120);
    const hintBoxAtLeft = await hint.boundingBox();
    assert.ok(Math.abs(hintBoxBefore.y - hintBoxAtLeft.y) < 1);
    assert.ok(hintBoxAtLeft.y + hintBoxAtLeft.height <= 1000);
    assert.ok(hintBoxAtLeft.x >= 0 && hintBoxAtLeft.x + hintBoxAtLeft.width <= 1440);
    await container.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForTimeout(120);
    const hintBoxAtRight = await hint.boundingBox();
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.closest('[data-slot="table-scroll-hint"]') !== null;
    }, {
      x: hintBoxAtRight.x + hintBoxAtRight.width / 2,
      y: hintBoxAtRight.y + hintBoxAtRight.height / 2,
    });
    assert.ok(hit, "scroll hint must not be covered by a sticky cell");
    entry.stickyName = sticky;
    entry.scrollHint = {
      y: Math.round(hintBoxAtRight.y),
      height: Math.round(hintBoxAtRight.height),
      hit,
    };
    pass(`${theme}: 名称列 sticky`, `left=${sticky.left}, rectLeft=${sticky.rectLeft}`);
    pass(`${theme}: 滑动提示可见`, `y=${entry.scrollHint.y}, hit=${hit}`);

    await page.screenshot({
      path: path.join(HERE, `servers-1440-${theme}-scrolled.png`),
    });

    // 异常筛选：选中态 + URL + 只显示异常行；再点一次恢复。
    const filter = page.locator('[data-slot="server-abnormal-filter"]').first();
    await filter.waitFor();
    await filter.click();
    await page.waitForURL(/only=abnormal/);
    // 等 150ms 的颜色过渡结束再截图，否则会抓到背景已红、文字还没变色的中间帧。
    await page.waitForTimeout(400);
    assert.equal(await filter.getAttribute("aria-pressed"), "true");
    assert.equal(await filter.getAttribute("data-active"), "true");
    const filteredRows = await page
      .locator("tbody td.pw-sticky-name")
      .count();
    assert.equal(filteredRows, abnormal.length, "abnormal filter row count");
    await page.screenshot({
      path: path.join(HERE, `servers-1440-${theme}-filter.png`),
    });
    entry.filter = {
      rows: filteredRows,
      url: page.url(),
      pressed: true,
    };
    pass(`${theme}: 异常筛选`, `${filteredRows} rows, url=${new URL(page.url()).search}`);

    await filter.click();
    await page.waitForTimeout(400);
    assert.equal(await filter.getAttribute("aria-pressed"), "false");
    assert.ok(!page.url().includes("only=abnormal"));
    const restoredRows = await page.locator("tbody td.pw-sticky-name").count();
    assert.equal(restoredRows, servers.length);
    entry.filterRestoredRows = restoredRows;

    await context.close();
  }

  // ---- 1024 详情弹层：label / value 不重复 --------------------------------
  {
    const context = await newContext({ width: 1024, height: 900, theme });
    const page = await context.newPage();
    await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
    await waitForTable(page);

    const row = page
      .locator('tbody [data-slot="table-row"]')
      .filter({ hasText: "东京-01" })
      .first();
    await row.locator('button[data-slot="popover-trigger"]').click();
    const popover = page.locator('[data-slot="popover-content"]').first();
    await popover.waitFor();
    await page.waitForTimeout(200);

    const pairs = await popover.locator("dl > div").evaluateAll((rows) =>
      rows.map((row) => ({
        label: row.querySelector("dt")?.textContent?.trim() ?? "",
        value: row.querySelector("dd")?.textContent?.trim() ?? "",
      })),
    );
    const latency = pairs.find((pair) => pair.label === "网络延迟");
    assert.ok(latency, "latency row missing");
    assert.ok(!latency.value.startsWith("延迟"), `latency value repeats label: ${latency.value}`);
    assert.equal(latency.value, "52 ms");
    const ports = pairs.find((pair) => pair.label === "允许的端口");
    assert.ok(ports, "ports row missing");
    assert.ok(
      !ports.value.startsWith("允许端口") && !ports.value.startsWith("允许自定义端口"),
      `ports value repeats label: ${ports.value}`,
    );
    assert.equal(ports.value, "10000-60000");
    const lastSeen = pairs.find((pair) => pair.label === "最后在线");
    assert.ok(lastSeen, "last seen row missing");
    // 预览库里在线服务器的 last_seen_at 在未来：必须收敛成「刚刚」。
    assert.equal(lastSeen.value, "刚刚");

    entry.detail = { latency, ports, lastSeen };
    pass(`${theme}: 详情弹层不重复`, `latency=${latency.value}, ports=${ports.value}`);
    pass(`${theme}: 未来 last_seen`, `lastSeen=${lastSeen.value}`);

    await page.screenshot({
      path: path.join(HERE, `servers-1024-${theme}-detail.png`),
    });
    await context.close();
  }

  // ---- 390 手机卡片：默认高度 / 更多折叠 ---------------------------------
  {
    const context = await newContext({ width: 390, height: 844, theme });
    const page = await context.newPage();
    await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
    const cards = page.locator('[data-slot="mobile-data-card"]');
    await cards.first().waitFor();
    await page.waitForTimeout(250);

    const heights = await cards.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    const maxHeight = Math.max(...heights);
    assert.ok(maxHeight <= 240, `collapsed card height ${maxHeight} > 240`);
    entry.mobile = { heightMin: Math.min(...heights), heightMax: maxHeight, count: heights.length };
    pass(`${theme}: 390 卡片 ≤240px`, `max=${maxHeight}px (${heights.length} cards)`);

    await page.screenshot({
      path: path.join(HERE, `servers-390-${theme}-cards.png`),
    });

    const firstCard = cards.first();
    const toggle = firstCard.locator('[data-slot="mobile-card-more-toggle"]');
    await toggle.click();
    await page.waitForTimeout(200);
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.equal(await firstCard.locator('[data-slot="mobile-card-more"]').count(), 1);
    const expandedHeight = Math.round(
      (await firstCard.boundingBox()).height,
    );
    assert.ok(expandedHeight > maxHeight);
    entry.mobile.expandedFirst = expandedHeight;
    await page.screenshot({
      path: path.join(HERE, `servers-390-${theme}-card-more.png`),
    });

    // 390 下同一个筛选也要能切换：卡片数量与 URL 同步。
    const mobileFilter = page.locator('[data-slot="server-abnormal-filter"]').first();
    await mobileFilter.click();
    await page.waitForURL(/only=abnormal/);
    await page.waitForTimeout(400);
    assert.equal(await mobileFilter.getAttribute("aria-pressed"), "true");
    assert.equal(await cards.count(), abnormal.length);
    pass(`${theme}: 390 异常筛选`, `${abnormal.length} cards, url=?only=abnormal`);
    await mobileFilter.click();
    await page.waitForTimeout(400);
    assert.equal(await cards.count(), servers.length);
    await context.close();
  }
}

await browser.close();
report.ok = true;
writeFileSync(path.join(HERE, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
