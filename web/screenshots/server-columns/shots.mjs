#!/usr/bin/env node
/**
 * 服务器列表「负载 / 内存 / 当前速率」三列对齐验收 / Server numeric column acceptance.
 *
 * 覆盖 / Covers:
 * - 1440 未滚动 + 主内容区纵向滚到底（亮暗）
 * - 1360 横向滚到最右（仍在 xl 断点以上，表格溢出时名称列仍固定）
 * - 1024（xl 以下合并列 / 速率列隐藏，地址与操作不被挤压）
 * - 390 卡片（三字段仍独立，速率保持单行）
 * - 几何断言：text-align:left、数值与列头同一起点、两行速率不撑高 64px 行
 * - 文案断言：`0.39 / 31%`、无进度条、上行在上/下行在下、tabular-nums
 *
 * 前置 / Prerequisite:
 *   PIERWAVE_DB='sqlite://data/preview.db' PIERWAVE_ADMIN_PASSWORD=devpass \
 *   PIERWAVE_ADDR=127.0.0.1:8787 ./target/debug/pierwave-master
 *   （web/dist 必须是当前构建 / web/dist must be the current build）
 *
 * 用法 / Usage:
 *   BASE=http://127.0.0.1:8797 node web/screenshots/server-columns/shots.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// 展示格式直接复用被测源码，避免截图脚本另写一份格式化逻辑。
// Reuse the formatting under test instead of duplicating it here.
import { formatRate } from "../../src/lib/netRate.ts";
import { formatLoadMemory } from "../../src/lib/serverMetrics.ts";

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

// ---- 登录（Cookie 会话）与真实数据 ----------------------------------------
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
const byName = new Map(servers.map((server) => [server.name, server]));

const report = {
  base: BASE,
  servers: servers.length,
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
  await page
    .locator('tbody [data-slot="table-row"] td.pw-sticky-name')
    .first()
    .waitFor();
  await page.waitForTimeout(250);
}

async function noPageOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
}

async function cellMetrics(locator) {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      align: style.textAlign,
      contentLeft: rect.x + parseFloat(style.paddingLeft),
      width: rect.width,
      fontVariantNumeric: style.fontVariantNumeric,
    };
  });
}

for (const theme of ["dark", "light"]) {
  const entry = (report.themes[theme] = {});

  // ---- 1440：列对齐 / 合并文案 / 两行速率 / 行高 / 溢出 -------------------
  {
    const context = await newContext({ width: 1440, height: 1000, theme });
    const page = await context.newPage();
    await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
    await waitForTable(page);

    const rows = page.locator('tbody [data-slot="table-row"]:has(td.pw-sticky-name)');
    const firstRow = rows.first();
    const firstName = (await firstRow.locator('[data-slot="server-name"]').innerText()).trim();
    const server = byName.get(firstName);
    assert.ok(server, `servers API has no row named ${firstName}`);

    const merged = firstRow.locator('[data-slot="server-load-memory"]');
    const rate = firstRow.locator('[data-slot="server-rate"]');
    assert.equal(await merged.count(), 1, "合并单元格缺失");
    assert.equal(await rate.count(), 1, "两行速率单元格缺失");

    // 合并列文案：数据来自 API，格式来自被测源码。
    const expectedMerged = formatLoadMemory(
      server.load1,
      server.mem_used,
      server.mem_total,
    );
    const mergedText = (await merged.innerText()).replace(/\s+/g, " ").trim();
    assert.equal(mergedText, expectedMerged, "合并列文案");
    assert.match(mergedText, /^\d+\.\d{2} \/ \d{1,3}%$/);
    entry.merged = mergedText;

    // 速率：上行（tx）在上、下行（rx）在下，数值与 API 一致。
    const expectedTx = `↑ ${formatRate(server.net_tx_bps)}`;
    const expectedRx = `↓ ${formatRate(server.net_rx_bps)}`;
    const lines = rate.locator("[data-direction]");
    assert.deepEqual(
      await lines.evaluateAll((els) => els.map((el) => el.dataset.direction)),
      ["tx", "rx"],
      "两行顺序必须是 上行 → 下行",
    );
    const lineTexts = (await lines.allInnerTexts()).map((text) =>
      text.replace(/\s+/g, " ").trim(),
    );
    assert.equal(lineTexts[0], expectedTx, "第一行必须是上行");
    assert.equal(lineTexts[1], expectedRx, "第二行必须是下行");
    assert.match(lineTexts[0], /^↑ /);
    assert.match(lineTexts[1], /^↓ /);
    entry.rate = lineTexts;

    // 两行真的上下堆叠（不是并排），且各自 13px 紧行高。
    const lineBoxes = await lines.evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          x: rect.x,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
        };
      }),
    );
    assert.ok(lineBoxes[0].bottom <= lineBoxes[1].top + 1, "两行必须上下堆叠");
    assert.ok(Math.abs(lineBoxes[0].x - lineBoxes[1].x) < 1, "两行左边缘对齐");
    for (const box of lineBoxes) {
      assert.equal(box.fontSize, "13px");
      const lineHeight = parseFloat(box.lineHeight);
      assert.ok(lineHeight >= 13 && lineHeight <= 16, `行高 ${box.lineHeight}`);
    }
    const rateBox = await rate.boundingBox();
    assert.ok(rateBox.height <= 34, `两行总高 ${rateBox.height}px 不应接近 64px`);

    // 行高仍 64px：两行速率不撑高行。
    const rowHeights = await rows.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    const minRow = Math.min(...rowHeights);
    const maxRow = Math.max(...rowHeights);
    assert.equal(minRow, 64, `行高 ${minRow}px`);
    assert.equal(maxRow, 64, `行高 ${maxRow}px`);
    entry.rowHeights = { min: minRow, max: maxRow, count: rowHeights.length };

    // 三处（合并列 / 速率）都是 text-align:left，数值从单元格内容左沿开始。
    const mergedTd = merged.locator("xpath=ancestor::td[1]");
    const rateTd = rate.locator("xpath=ancestor::td[1]");
    const [mergedTdMetrics, rateTdMetrics] = await Promise.all([
      cellMetrics(mergedTd),
      cellMetrics(rateTd),
    ]);
    assert.equal(mergedTdMetrics.align, "left");
    assert.equal(rateTdMetrics.align, "left");
    const mergedLeft = (await merged.boundingBox()).x;
    const rateLeft = (await rate.boundingBox()).x;
    assert.ok(Math.abs(mergedLeft - mergedTdMetrics.contentLeft) < 0.6);
    assert.ok(Math.abs(rateLeft - rateTdMetrics.contentLeft) < 0.6);
    assert.ok(
      Math.abs(mergedTdMetrics.contentLeft - rateTdMetrics.contentLeft) > 0,
      "两列内容起点应不同，确认没有挤到同一列",
    );

    // 表头同样左对齐，且表头与单元格同宽、内容左沿重合。
    const mergedTh = page.locator("thead th").filter({ hasText: "负载 / 内存" });
    const rateTh = page.locator("thead th").filter({ hasText: "当前速率" });
    assert.equal(await mergedTh.count(), 1);
    assert.equal(await rateTh.count(), 1);
    const [mergedThMetrics, rateThMetrics] = await Promise.all([
      cellMetrics(mergedTh),
      cellMetrics(rateTh),
    ]);
    assert.equal(mergedThMetrics.align, "left");
    assert.equal(rateThMetrics.align, "left");
    assert.ok(Math.abs(mergedThMetrics.contentLeft - mergedTdMetrics.contentLeft) < 0.6);
    assert.ok(Math.abs(rateThMetrics.contentLeft - rateTdMetrics.contentLeft) < 0.6);
    entry.alignment = {
      merged: { head: mergedThMetrics.align, cell: mergedTdMetrics.align },
      rate: { head: rateThMetrics.align, cell: rateTdMetrics.align },
    };

    // tabular-nums 保留在合并列与速率列（td 本身不需要，数值 span 继承）。
    const mergedNumeric = await merged.evaluate(
      (el) => getComputedStyle(el).fontVariantNumeric,
    );
    const rateNumeric = await rate.evaluate(
      (el) => getComputedStyle(el).fontVariantNumeric,
    );
    assert.match(mergedNumeric, /tabular-nums/);
    assert.match(rateNumeric, /tabular-nums/);
    entry.fontVariantNumeric = { merged: mergedNumeric, rate: rateNumeric };

    // `/` 与箭头是 muted；负载数值是 foreground，两者必须不同色。
    const colors = await page.evaluate(() => {
      const color = (selector) => {
        const el = document.querySelector(selector);
        return el ? getComputedStyle(el).color : null;
      };
      return {
        load: color('[data-slot="load-memory-load"]'),
        slash: color('[data-slot="load-memory-slash"]'),
        arrow: color('[data-slot="server-rate"] [data-direction] > span:first-child'),
      };
    });
    assert.ok(colors.load && colors.slash && colors.arrow);
    assert.notEqual(colors.load, colors.slash, "斜杠必须弱化");
    assert.equal(colors.slash, colors.arrow, "箭头与斜杠同属 muted");
    entry.colors = colors;

    // 合并列不再有进度条，整张表也没有。
    assert.equal(
      await page.locator('[data-slot="server-load-memory"] [role="progressbar"]').count(),
      0,
      "合并列里还有进度条",
    );
    assert.equal(await page.locator('tbody [role="progressbar"]').count(), 0);

    // 页面无横向新增溢出；合并后 1440 的表格通常已经放得下（记录实测值）。
    assert.ok(await noPageOverflow(page), "1440 页面出现横向滚动");
    const container = page.locator('[data-slot="table-container"]').first();
    const tableMetrics = await container.evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    const tableOverflows =
      tableMetrics.scrollWidth > tableMetrics.clientWidth + 1;
    entry.tableAt1440 = { ...tableMetrics, overflows: tableOverflows };

    // 地址列不被挤压（min-w-40 = 160px），操作列仍可点到。
    const address = firstRow.locator('td[title="' + server.address + '"]');
    const addressBox = await address.boundingBox();
    assert.ok(addressBox.width >= 160, `地址列 ${addressBox.width}px < 160px`);
    entry.addressWidth = Math.round(addressBox.width);
    const actions = firstRow.locator("td").last();
    const actionsBox = await actions.boundingBox();
    // 操作列只要求「三个动作都完整落在单元格里」，不写死一个拍脑袋的宽度。
    const actionControls = actions.locator("button, a");
    // `xl:hidden` 的详情入口在 1440 不占位，只校验真正可见的动作。
    assert.ok((await actionControls.count()) >= 3, "操作列动作缺失");
    const controlBoxes = (
      await actionControls.evaluateAll((els) =>
        els.map((el) => {
          const rect = el.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        }),
      )
    ).filter((box) => box.width > 0);
    assert.ok(controlBoxes.length >= 2, "操作列可见动作少于 2 个");
    for (const box of controlBoxes) {
      assert.ok(box.left >= actionsBox.x - 1, "操作按钮被左侧裁切");
      assert.ok(box.right <= actionsBox.x + actionsBox.width + 1, "操作按钮被右侧裁切");
    }
    assert.ok(actionsBox.width >= 80, `操作列 ${actionsBox.width}px 过窄`);

    // 1440 下所有列（含速率 / 操作）都在视口内，先截未滚动全表。
    await page.screenshot({
      path: path.join(HERE, `servers-1440-${theme}-columns.png`),
    });

    // 页面纵向滚到底：15 行数据下三列仍与列头对齐（滚动状态截图）。
    const main = page.locator("main").first();
    await main.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(250);
    assert.ok(
      (await main.evaluate((el) => el.scrollTop)) > 0,
      "主内容区应可纵向滚动",
    );
    await page.screenshot({
      path: path.join(HERE, `servers-1440-${theme}-scrolled.png`),
    });
    await main.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(150);

    if (tableOverflows) {
      // 兼容更窄但仍在 xl 断点之上的场景：横向滚到最右，名称列仍固定。
      await container.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await page.waitForTimeout(200);
      const mergedBoxAfterScroll = await merged.boundingBox();
      assert.ok(mergedBoxAfterScroll.x > 0 && mergedBoxAfterScroll.x < 1440);
      assert.ok(await noPageOverflow(page), "滚动后页面出现横向滚动");
      const sticky = await firstRow.locator("td.pw-sticky-name").evaluate((el) => ({
        position: getComputedStyle(el).position,
        left: getComputedStyle(el).left,
      }));
      assert.equal(sticky.position, "sticky");
      assert.equal(sticky.left, "40px");
      await page.screenshot({
        path: path.join(HERE, `servers-1440-${theme}-scrolled-right.png`),
      });
    }

    pass(`${theme}: 合并列文案`, mergedText);
    pass(`${theme}: 两行速率`, lineTexts.join(" | "));
    pass(`${theme}: 行高`, `${minRow}–${maxRow}px`);
    pass(`${theme}: 左对齐`, `cell=${mergedTdMetrics.align}, head=${mergedThMetrics.align}`);
    await context.close();
  }

  // ---- 1360（仍在 xl 断点以上）：表格真的溢出时，滚动后名称列仍固定 ------
  {
    const context = await newContext({ width: 1360, height: 1000, theme });
    const page = await context.newPage();
    await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
    await waitForTable(page);

    const firstRow = page
      .locator('tbody [data-slot="table-row"]:has(td.pw-sticky-name)')
      .first();
    const container = page.locator('[data-slot="table-container"]').first();
    const metrics = await container.evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    assert.ok(
      metrics.scrollWidth > metrics.clientWidth + 1,
      "1360 下表格应保留横向滚动",
    );

    await container.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForTimeout(200);
    assert.ok(await noPageOverflow(page), "1360 滚动后页面出现横向滚动");

    const sticky = await firstRow.locator("td.pw-sticky-name").evaluate((el) => ({
      position: getComputedStyle(el).position,
      left: getComputedStyle(el).left,
    }));
    assert.equal(sticky.position, "sticky");
    assert.equal(sticky.left, "40px");
    const rateBox = await firstRow.locator('[data-slot="server-rate"]').boundingBox();
    assert.ok(rateBox.x >= 0 && rateBox.x + rateBox.width <= 1360, "速率列被挤出视口");
    const mergedBox = await firstRow
      .locator('[data-slot="server-load-memory"]')
      .boundingBox();
    assert.ok(mergedBox.x >= 0 && mergedBox.x + mergedBox.width <= 1360);

    entry["1360"] = {
      overflows: true,
      sticky,
      rateVisible: true,
    };
    await page.screenshot({
      path: path.join(HERE, `servers-1360-${theme}-scrolled.png`),
    });
    pass(`${theme}: 1360 滚动后列仍可见`, `scroll=${metrics.scrollWidth - metrics.clientWidth}px`);
    await context.close();
  }

  // ---- 1024：xl 以下这三列隐藏，地址 / 操作不被挤压，无横向溢出 ----------
  {
    const context = await newContext({ width: 1024, height: 900, theme });
    const page = await context.newPage();
    await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
    await waitForTable(page);

    const mergedTh = page.locator("thead th").filter({ hasText: "负载 / 内存" });
    const rateTh = page.locator("thead th").filter({ hasText: "当前速率" });
    assert.equal(await mergedTh.count(), 1);
    assert.equal(await rateTh.count(), 1);
    assert.equal(
      await mergedTh.evaluate((el) => getComputedStyle(el).display),
      "none",
      "1024 下合并列应随 xl 断点隐藏",
    );
    assert.equal(
      await rateTh.evaluate((el) => getComputedStyle(el).display),
      "none",
    );
    assert.ok(await noPageOverflow(page), "1024 页面出现横向滚动");

    const firstRow = page
      .locator('tbody [data-slot="table-row"]:has(td.pw-sticky-name)')
      .first();
    // 地址列可见（用文字宽度兜底，不依赖某个固定 IP）。
    const addressCell = firstRow.locator("td").nth(2);
    assert.equal(await addressCell.evaluate((el) => getComputedStyle(el).display), "table-cell");
    const addressWidth = (await addressCell.boundingBox()).width;
    assert.ok(addressWidth >= 160, `1024 地址列 ${addressWidth}px < 160px`);
    const actionsBox = await firstRow.locator("td").last().boundingBox();
    assert.ok(actionsBox.x + actionsBox.width <= 1024, "操作列被挤出视口");
    entry["1024"] = {
      mergedHeaderDisplay: "none",
      addressWidth: Math.round(addressWidth),
      noPageOverflow: true,
    };

    await page.screenshot({
      path: path.join(HERE, `servers-1024-${theme}.png`),
    });
    pass(`${theme}: 1024 断点`, `address=${Math.round(addressWidth)}px, 无横向溢出`);
    await context.close();
  }

  // ---- 390：卡片仍按三个独立字段展示，速率保持单行 -----------------------
  {
    const context = await newContext({ width: 390, height: 844, theme });
    const page = await context.newPage();
    await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
    const cards = page.locator('[data-slot="mobile-data-card"]');
    await cards.first().waitFor();
    await page.waitForTimeout(250);

    const firstCard = cards.first();
    const labels = await firstCard
      .locator("dl dt")
      .evaluateAll((els) => els.map((el) => el.textContent.trim()));
    for (const label of ["负载（1 分钟）", "内存", "当前速率"]) {
      assert.ok(labels.includes(label), `390 卡片缺少独立字段 ${label}`);
    }
    // 卡片没有改成两行堆叠，默认高度也不变。
    assert.equal(await page.locator('[data-slot="server-rate"]').count(), 0);
    const heights = await cards.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    const maxHeight = Math.max(...heights);
    assert.ok(maxHeight <= 240, `390 卡片高度 ${maxHeight}px > 240`);
    entry["390"] = { labels, cardHeightMax: maxHeight };
    assert.ok(await noPageOverflow(page), "390 页面出现横向滚动");

    await page.screenshot({
      path: path.join(HERE, `servers-390-${theme}-cards.png`),
    });
    pass(`${theme}: 390 卡片独立字段`, `${labels.length} fields, max=${maxHeight}px`);
    await context.close();
  }
}

await browser.close();
report.ok = true;
writeFileSync(path.join(HERE, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
