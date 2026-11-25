#!/usr/bin/env node
/**
 * 链路时延趋势：图例下拉多选 + 数据范围 x 轴验收 / Chain trend series picker acceptance.
 *
 * 覆盖 / Covers:
 * - 24 链池（23 条有样本）默认只显示 P50 最高的 5 条；
 * - 全选 / 清空 / 搜索、URL `?series=` 刷新与切 tab 保持、空选择空态；
 * - x 轴范围 = 有效样本实际范围，绘图区用满左右空间（右侧 ≤12px）；
 * - 图例只有一行（≤32px）、390 无横向溢出；1440/390 × 亮/暗。
 *
 * 前置 / Prerequisite:
 *   # 复制真实预览库并把样本平移到「现在」约 4.5 小时前（24h 窗口内只覆盖约 19h）
 *   sqlite3 data/preview.db ".backup '/tmp/pw-chain-trend.db'"
 *   NOW=$(date +%s)
 *   MAXL=$(sqlite3 /tmp/pw-chain-trend.db "select max(ts) from forward_latency_samples;")
 *   MAXP=$(sqlite3 /tmp/pw-chain-trend.db "select max(ts) from forward_probe_samples;")
 *   sqlite3 /tmp/pw-chain-trend.db \
 *     "update forward_latency_samples set ts = ts + $((NOW - 16200 - MAXL));
 *      update forward_probe_samples  set ts = ts + $((NOW - 16200 - MAXP));"
 *   # 预览库 admin 密码不是 devpass 时，用本地 argon2id 重算 users.password_hash
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8797 \
 *     PIERWAVE_DB='sqlite:///tmp/pw-chain-trend.db?mode=rwc' ./target/debug/pierwave-master
 *   make web-build
 *
 * 用法 / Usage:
 *   BASE=http://127.0.0.1:8797 node web/screenshots/chain-trend-series/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://127.0.0.1:8797";
const ADMIN = process.env.ADMIN_PASSWORD ?? "devpass";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(HERE, { recursive: true });

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

// ---- 登录与真实数据 -------------------------------------------------------
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

const healthResponse = await fetch(
  `${BASE}/api/v1/overview/chain-health?hours=24&bucket=900`,
  { headers: { cookie: `${cookieName}=${cookieValue}` } },
);
assert.equal(healthResponse.status, 200, "chain-health must be 200");
const health = await healthResponse.json();

/** 有效样本：`p50` 非空且探测数 > 0。 */
function validPoints(chain) {
  return (chain.series ?? []).filter(
    (point) =>
      point &&
      point.p50 !== null &&
      point.p50 !== undefined &&
      Number.isFinite(Number(point.p50)) &&
      Number(point.samples) > 0 &&
      Number.isFinite(Number(point.ts)),
  );
}

const sampled = (health.chains ?? []).filter(
  (chain) => validPoints(chain).length > 0,
);
const unsampled = (health.chains ?? []).filter(
  (chain) => validPoints(chain).length === 0,
);
const sampledIds = sampled.map((chain) => chain.id);
const allValidTs = sampled.flatMap((chain) =>
  validPoints(chain).map((point) => Number(point.ts)),
);
const dataMin = Math.min(...allValidTs);
const dataMax = Math.max(...allValidTs);

/** 默认 5 条：当前窗口 P50 降序（与 lib/chainTrendSeries.ts 同口径）。 */
function latestP50(chain) {
  const points = validPoints(chain);
  return points.length > 0 ? Number(points[points.length - 1].p50) : null;
}
const expectedDefault = [...sampled]
  .map((chain, index) => ({ id: chain.id, index, p50: latestP50(chain) }))
  .sort((a, b) => {
    if (a.p50 !== b.p50) return b.p50 - a.p50;
    return a.index - b.index;
  })
  .slice(0, 5)
  .map((entry) => entry.id);

function expectedAxis(ids) {
  const selected = new Set(ids);
  const ts = sampled
    .filter((chain) => selected.has(chain.id))
    .flatMap((chain) => validPoints(chain).map((point) => Number(point.ts)));
  return ts.length === 0
    ? null
    : { min: Math.min(...ts), max: Math.max(...ts) };
}

// ---- 浏览器 ---------------------------------------------------------------
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {
  base: BASE,
  pool: {
    chains: (health.chains ?? []).length,
    sampled: sampled.length,
    unsampled: unsampled.length,
    dataMin,
    dataMax,
  },
  expectedDefault,
  shots: [],
  assertions: [],
};

function pass(name, detail) {
  report.assertions.push({ name, ok: true, detail });
}

async function newPage({ width, height, theme }) {
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
  const page = await context.newPage();
  return { context, page };
}

async function waitChart(page, { expectEmpty = false } = {}) {
  await page.waitForSelector("[data-chain-series-trigger]", {
    state: "visible",
    timeout: 15_000,
  });
  await page.waitForSelector("[data-chain-trend-chart]", {
    state: "visible",
    timeout: 15_000,
  });
  await page.waitForFunction(
    (empty) => {
      const chart = document.querySelector("[data-chain-trend-chart]");
      if (!chart) return false;
      const visible = Number(chart.dataset.visibleCount);
      if (visible === 0) {
        return (
          !!empty || document.body.innerText.includes("全部链路已隐藏")
        );
      }
      return chart.querySelectorAll(".recharts-line-curve").length > 0;
    },
    expectEmpty,
    { timeout: 15_000 },
  );
  // 等 150–220ms 的过渡结束，截图不糊。
  await page.waitForTimeout(250);
}

async function gotoChart(page, search = "view=chain", { expectEmpty = false } = {}) {
  await page.goto(`${BASE}/?${search}`, {
    waitUntil: "domcontentloaded",
  });
  await waitChart(page, { expectEmpty });
}

async function metrics(page) {
  return page.evaluate(() => {
    const chart = document.querySelector("[data-chain-trend-chart]");
    const card = document.querySelector("[data-chain-trend-card]");
    const legend = chart?.querySelector("[data-chain-trend-legend]");
    const surface = chart?.querySelector(".recharts-surface");
    const surfaceRect = surface?.getBoundingClientRect();
    const verticals = [
      ...(chart?.querySelectorAll(".recharts-cartesian-grid line") ?? []),
    ]
      .map((line) => ({
        x1: Number(line.getAttribute("x1")),
        x2: Number(line.getAttribute("x2")),
      }))
      .filter((line) => Math.abs(line.x1 - line.x2) < 0.01)
      .map((line) => line.x1);
    const lines = [
      ...(chart?.querySelectorAll(".recharts-line-curve") ?? []),
    ].map((line) => {
      const box = line.getBBox();
      return { x: box.x, width: box.width };
    });
    // 折线的实际左右端点：数据是否铺满绘图区，就看它离 surface 边缘多远。
    const lineLeft = lines.length
      ? Math.min(...lines.map((box) => box.x))
      : null;
    const lineRight = lines.length
      ? Math.max(...lines.map((box) => box.x + box.width))
      : null;
    const plotLeft = lineLeft ?? (verticals.length ? Math.min(...verticals) : null);
    const plotRight =
      lineRight ?? (verticals.length ? Math.max(...verticals) : null);
    return {
      cardWidth: card?.getBoundingClientRect().width ?? null,
      legendHeight: legend?.getBoundingClientRect().height ?? 0,
      legendWrap: legend ? getComputedStyle(legend).flexWrap : null,
      legendOverflow: legend
        ? legend.scrollWidth > legend.clientWidth + 1
        : false,
      visibleCount: Number(chart?.dataset.visibleCount ?? -1),
      seriesCount: Number(chart?.dataset.seriesCount ?? -1),
      axisMin: chart?.dataset.axisMin ? Number(chart.dataset.axisMin) : null,
      axisMax: chart?.dataset.axisMax
        ? Number(chart.dataset.axisMax)
        : null,
      triggerText: document
        .querySelector("[data-chain-series-trigger]")
        ?.textContent?.trim(),
      surfaceWidth: surfaceRect?.width ?? null,
      plotLeft,
      plotRight,
      lineBoxes: lines,
      overflowX:
        Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
        ) - window.innerWidth,
      bodyText: document.body.innerText,
    };
  });
}

function seriesFromUrl(page) {
  return new URL(page.url()).searchParams.get("series");
}

async function assertGeometry(label, page, { expectEmpty = false } = {}) {
  const m = await metrics(page);
  assert.ok(m.overflowX <= 0, `${label}: horizontal overflow ${m.overflowX}px`);
  if (!expectEmpty) {
    assert.ok(m.legendHeight > 0, `${label}: legend missing`);
    assert.ok(m.legendHeight <= 32.5, `${label}: legend ${m.legendHeight}px > 32`);
    assert.equal(m.legendWrap, "nowrap", `${label}: legend must not wrap`);
  }

  if (!expectEmpty) {
    assert.ok(m.plotLeft !== null && m.plotRight !== null, `${label}: no grid`);
    const plotWidth = m.plotRight - m.plotLeft;
    const widest = Math.max(...m.lineBoxes.map((box) => box.width));
    const ratio = widest / plotWidth;
    // 数据从轴左端画到右端：旧实现只占 19h/24h ≈ 80%，新实现必须 >99%。
    assert.ok(ratio >= 0.98, `${label}: line width ratio ${ratio.toFixed(3)}`);
    const rightGap = m.surfaceWidth - m.plotRight;
    assert.ok(
      rightGap <= 12.5,
      `${label}: right blank ${rightGap.toFixed(1)}px > 12px`,
    );
    // 左边界 = 8px margin + 48px y 轴标签槽；再大就是把数据挤窄了。
    assert.ok(
      m.plotLeft >= 50 && m.plotLeft <= 60,
      `${label}: left gutter ${m.plotLeft}px outside 50–60px`,
    );
    pass(`${label}: 图例一行 / x 轴用满绘图区`, {
      legendHeight: Math.round(m.legendHeight * 10) / 10,
      rightGap: Math.round(rightGap * 10) / 10,
      leftGutter: m.plotLeft,
      plotLeft: m.plotLeft,
      plotRight: m.plotRight,
      surfaceWidth: m.surfaceWidth,
      lineWidthRatio: Math.round(ratio * 1000) / 1000,
    });
  } else {
    assert.equal(m.visibleCount, 0, `${label}: expected 0 selected`);
    assert.equal(m.lineBoxes.length, 0, `${label}: empty selection drew lines`);
    pass(`${label}: 空选择无折线`, { visibleCount: m.visibleCount });
  }
  pass(`${label}: 无横向溢出`, { overflowX: m.overflowX });
  return m;
}

async function shoot(page, name, { element = "[data-chain-trend-card]" } = {}) {
  const file = path.join(HERE, `${name}.png`);
  if (element) {
    const locator = page.locator(element);
    await locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    await locator.screenshot({ path: file });
  } else {
    // 弹层挂在 portal 上，只能截视口：先把卡头滚到可见位置。
    await page
      .locator("[data-chain-series-trigger]")
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    await page.screenshot({ path: file, fullPage: false });
  }
  report.shots.push(`${name}.png`);
}

async function openPicker(page) {
  await page.click("[data-chain-series-trigger]");
  await page.waitForSelector("[data-chain-series-content]", {
    state: "visible",
  });
  await page.waitForTimeout(200);
}

// ===========================================================================
// 1) 24 链池：默认 5 条 + 全选 + 空选 + 下拉展开（搜索 / 全选 / 清空）
// ===========================================================================
for (const width of [1440, 390]) {
  const height = width === 390 ? 844 : 900;
  for (const theme of ["dark", "light"]) {
    const label = `${width}-${theme}`;

    // --- 默认 5 条 ---
    {
      const { context, page } = await newPage({ width, height, theme });
      await gotoChart(page);
      // 默认选择会以 replace 方式写回 URL，等它落定。
      await page.waitForFunction(
        () =>
          (new URL(location.href).searchParams.get("series") ?? "")
            .split(",")
            .filter(Boolean).length === 5,
        undefined,
        { timeout: 10_000 },
      );
      const m = await assertGeometry(`default ${label}`, page);
      assert.equal(m.visibleCount, 5, `${label}: default must be 5`);
      assert.ok(
        (m.triggerText ?? "").includes("5"),
        `${label}: trigger shows ${m.triggerText}`,
      );
      const raw = seriesFromUrl(page);
      const ids = raw === null ? [] : raw.split(",").filter(Boolean);
      assert.equal(ids.length, 5, `${label}: URL series must hold 5 ids`);
      assert.deepEqual(
        ids,
        expectedDefault,
        `${label}: default ids are top-5 P50 descending`,
      );
      const axis = expectedAxis(ids);
      assert.equal(
        m.axisMin,
        axis.min,
        `${label}: axis min must be selected data min`,
      );
      assert.equal(
        m.axisMax,
        axis.max,
        `${label}: axis max must be selected data max`,
      );
      pass(`default ${label}: 默认 5 条 + x 轴=数据范围`, {
        ids,
        trigger: m.triggerText,
        axis: [m.axisMin, m.axisMax],
        data: [axis.min, axis.max],
        pool: [dataMin, dataMax],
        seriesCount: m.seriesCount,
      });
      await shoot(page, `default-5-${label}`);

      // 勾选一条未选中的链 → URL 增加该 id；刷新后保持。
      await openPicker(page);
      const rows = page.locator("[data-chain-series-row]");
      const rowCount = await rows.count();
      let added = null;
      for (let index = 0; index < rowCount; index += 1) {
        const row = rows.nth(index);
        const checked = await row
          .locator("[data-chain-series-checkbox]")
          .getAttribute("data-state");
        if (checked !== "checked") {
          added = await row.getAttribute("data-chain-id");
          await row.locator("[data-chain-series-checkbox]").click();
          break;
        }
      }
      assert.ok(added, `${label}: no unchecked row to add`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        (count) =>
          Number(
            document.querySelector("[data-chain-trend-chart]")?.dataset
              .visibleCount,
          ) === count,
        6,
        { timeout: 10_000 },
      );
      const afterAdd = seriesFromUrl(page).split(",").filter(Boolean);
      assert.ok(afterAdd.includes(added), `${label}: added id missing in URL`);
      assert.equal(afterAdd.length, 6);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitChart(page);
      const reloaded = await metrics(page);
      assert.equal(reloaded.visibleCount, 6, `${label}: reload keeps 6`);
      pass(`default ${label}: URL 刷新保持`, {
        added,
        count: reloaded.visibleCount,
        series: seriesFromUrl(page),
      });
      await context.close();
    }

    // --- 全选 23 条 ---
    {
      const { context, page } = await newPage({ width, height, theme });
      await gotoChart(page);
      await openPicker(page);
      const rows = await page.locator("[data-chain-series-row]").count();
      assert.equal(rows, sampled.length, `${label}: picker rows`);
      assert.equal(
        await page.locator("[data-chain-series-search]").count(),
        1,
        `${label}: search input`,
      );
      assert.equal(
        await page.locator("[data-chain-series-all]").count(),
        1,
        `${label}: select all`,
      );
      assert.equal(
        await page.locator("[data-chain-series-clear]").count(),
        1,
        `${label}: clear`,
      );
      assert.equal(
        await page.locator("[data-chain-legend-unsampled-toggle]").count(),
        1,
        `${label}: unsampled fold`,
      );
      const foldText = await page
        .locator("[data-chain-legend-unsampled-toggle]")
        .innerText();
      assert.ok(
        foldText.includes(String(unsampled.length)),
        `${label}: fold says ${foldText}`,
      );

      // 搜索：「港日」匹配若干条，且行名都包含关键词。
      await page.fill("[data-chain-series-search]", "港日");
      await page.waitForTimeout(150);
      const names = await page
        .locator("[data-chain-series-row]")
        .allInnerTexts();
      assert.ok(names.length > 0 && names.length < sampled.length);
      for (const text of names) {
        assert.ok(text.includes("港日"), `${label}: search leaked ${text}`);
      }
      assert.equal(
        await page
          .locator("[data-chain-series-all]")
          .isVisible(),
        true,
        `${label}: select all visible while searching`,
      );
      await shoot(page, `picker-search-${label}`, { element: null });
      pass(`${label}: 下拉展开含搜索 / 全选 / 清空 / 无样本折叠`, {
        rows,
        searched: names.length,
        fold: foldText,
      });

      // 清空搜索后全选，再截图 23 条同屏。
      await page.fill("[data-chain-series-search]", "");
      await page.locator("[data-chain-series-all]").click();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        (count) =>
          Number(
            document.querySelector("[data-chain-trend-chart]")?.dataset
              .visibleCount,
          ) === count,
        sampled.length,
        { timeout: 15_000 },
      );
      const allSeries = seriesFromUrl(page).split(",").filter(Boolean);
      assert.equal(allSeries.length, sampled.length, `${label}: all in URL`);
      const allMetrics = await assertGeometry(`all ${label}`, page);
      assert.equal(allMetrics.visibleCount, sampled.length);
      const allAxis = expectedAxis(sampledIds);
      assert.equal(allMetrics.axisMin, allAxis.min, `${label}: all axis min`);
      assert.equal(allMetrics.axisMax, allAxis.max, `${label}: all axis max`);
      pass(`all ${label}: 全选写入 URL`, {
        count: allSeries.length,
        trigger: allMetrics.triggerText,
        axis: [allMetrics.axisMin, allMetrics.axisMax],
      });
      await shoot(page, `all-chains-${label}`);
      await context.close();
    }

    // --- 空选 ---
    {
      const { context, page } = await newPage({ width, height, theme });
      await gotoChart(page, "view=chain&series=", { expectEmpty: true });
      const m = await assertGeometry(`empty ${label}`, page, {
        expectEmpty: true,
      });
      assert.equal(seriesFromUrl(page), "", `${label}: ?series= kept empty`);
      assert.ok(
        m.bodyText.includes("全部链路已隐藏"),
        `${label}: empty copy missing`,
      );
      pass(`empty ${label}: 空选择显示空态`, {
        trigger: m.triggerText,
        series: seriesFromUrl(page),
      });
      await shoot(page, `empty-${label}`);
      await context.close();
    }
  }
}

// ===========================================================================
// 2) 切 tab / 切时窗保持选择（只在 1440 dark 跑一次）
// ===========================================================================
{
  const { context, page } = await newPage({
    width: 1440,
    height: 900,
    theme: "dark",
  });
  await gotoChart(page);
  const before = seriesFromUrl(page);
  const viewTabs = page.locator("[data-overview-view-tabs]");
  await viewTabs.getByRole("tab", { name: "流量趋势" }).click();
  await page.waitForTimeout(500);
  await viewTabs.getByRole("tab", { name: "链路时延" }).click();
  await waitChart(page);
  assert.equal(seriesFromUrl(page), before, "tab switch keeps ?series=");
  // 24h → 7d 也不重置选择。
  await page
    .locator("[data-chain-trend-card]")
    .getByRole("tab", { name: "7 天" })
    .click();
  await page.waitForTimeout(800);
  await page.waitForFunction(() => {
    const chart = document.querySelector("[data-chain-trend-chart]");
    return (
      chart &&
      chart.querySelectorAll(".recharts-line-curve").length === 5
    );
  });
  assert.equal(seriesFromUrl(page), before, "range switch keeps ?series=");
  pass("切 tab / 切时窗保持 ?series=", { series: before });
  await context.close();
}

// ===========================================================================
// 3) 既有交互回归：tooltip / 表格视图 / 无样本折叠（1440 dark）
// ===========================================================================
{
  const { context, page } = await newPage({
    width: 1440,
    height: 900,
    theme: "dark",
  });
  await gotoChart(page);

  // tooltip 仍按真实时间显示，并列出当前选中的 5 条链。
  const chartBox = await page
    .locator("[data-chain-trend-card] .recharts-wrapper")
    .boundingBox();
  assert.ok(chartBox, "chart wrapper must exist");
  await page.mouse.move(
    chartBox.x + chartBox.width * 0.6,
    chartBox.y + chartBox.height * 0.5,
  );
  await page.waitForSelector("[data-chain-trend-tooltip]", {
    state: "visible",
  });
  const tooltipRows = await page
    .locator("[data-chain-trend-tooltip] [data-chain-tooltip-row]")
    .count();
  assert.equal(tooltipRows, 5, "tooltip lists the five selected chains");
  const tooltipText = await page
    .locator("[data-chain-trend-tooltip]")
    .innerText();
  assert.match(tooltipText, /\d{2}:\d{2}/, "tooltip shows real time");
  await shoot(page, "tooltip-1440-dark");

  // 表格视图仍是可选视图，切回图表后折线仍在。
  await page.locator("[data-chain-table-toggle]").click();
  await page.waitForSelector("[data-chain-trend-table]", { state: "visible" });
  const tableColumns = await page
    .locator("[data-chain-trend-table] thead th")
    .count();
  assert.equal(
    tableColumns,
    1 + 5,
    "table shows time + five selected chains",
  );
  await shoot(page, "table-view-1440-dark");
  await page.locator("[data-chain-table-toggle]").click();
  await page.waitForSelector(".recharts-line-curve", { state: "attached" });
  pass("回归：tooltip / 表格视图", { tooltipRows, tableColumns });

  // 无样本链仍折叠在「N 条暂无样本」里，展开后能看到名单。
  await openPicker(page);
  await page.locator("[data-chain-legend-unsampled-toggle]").click();
  await page.waitForSelector("[data-chain-legend-unsampled-item]", {
    state: "visible",
  });
  const unsampledRows = await page
    .locator("[data-chain-legend-unsampled-item]")
    .count();
  assert.equal(unsampledRows, unsampled.length);
  await shoot(page, "picker-unsampled-1440-dark", { element: null });
  pass("回归：无样本链折叠展开", { unsampledRows });
  await context.close();
}

report.ok = report.assertions.every((item) => item.ok);
await browser.close();

const { writeFileSync } = await import("node:fs");
writeFileSync(path.join(HERE, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
