#!/usr/bin/env node
/**
 * 链路列表「起点 / 终点 + 跳数」与详情「逐段折线」的截图 + 契约验证。
 *
 * 数据来自真实主控（`data/preview-chain-latency.db` 的副本）：
 * - 链、节点、时延曲线、诊断、拓扑全部来自真实接口；
 * - 浏览器侧只对 `GET /api/v1/overview/chain-health` 注入**新契约字段**
 *   （`entry` / `exit` / `segments[].series` / 逐桶 `loss_pct`），
 *   因为后端 lane 尚未合并这些字段；注入后的响应与任务书里的 jsonc 同形。
 *
 * 前置 / Prerequisite:
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
 *   PIERWAVE_DB='sqlite://data/chain-hops-shots.db?mode=rwc' \
 *   ./target/debug/pierwave-master
 *   cd web && npm run dev        # http://localhost:5173
 *
 * 用法 / Usage:
 *   node web/screenshots/chain-endpoints-segments/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://localhost:5173";
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

/** 登录拿会话 cookie（与 scripts/e2e.sh 相同的 admin / devpass）。 */
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

async function api(pathname) {
  const response = await fetch(`${BASE}${pathname}`, {
    headers: { cookie: `${cookieName}=${cookieValue}` },
  });
  assert.equal(response.status, 200, `${pathname} must be 200`);
  return response.json();
}

const health = await api("/api/v1/overview/chain-health?hours=24&bucket=900");
const chainItems = (await api("/api/v1/chains")).items;
assert.ok(Array.isArray(health.chains) && health.chains.length > 0, "health has chains");
const chainIdByName = new Map(chainItems.map((chain) => [chain.name, chain.id]));

/**
 * 新契约注入计划。
 *
 * - `entry` / `exit` 按任务书给全；`来源哈希线` 的终点故意只给 server_name，
 *   用来验证 address = null → `—` 且 title 说明原因；
 * - 没有时延的段保持 `series: []`，验证「无历史数据」空态；
 * - `多线中转` 第 2 段逐桶丢包全 null，验证 tooltip 的 `—` 而不是回落窗口值。
 */
const ENDPOINTS = {
  三跳单线: {
    entry: {
      ip: "203.0.113.11",
      port: 443,
      address: "203.0.113.11:443",
      server_name: "香港-01",
    },
    exit: {
      ip: "198.51.100.21",
      port: 8443,
      address: "198.51.100.21:8443",
      server_name: "美国-04",
    },
  },
  多线中转: {
    entry: {
      ip: "203.0.113.12",
      port: 443,
      address: "203.0.113.12:443",
      server_name: "香港-01",
    },
    exit: {
      ip: "198.51.100.22",
      port: 8443,
      address: "198.51.100.22:8443",
      server_name: "美国-04",
    },
  },
  来源哈希线: {
    entry: {
      ip: "203.0.113.13",
      port: 8443,
      address: "203.0.113.13:8443",
      server_name: "香港-01",
    },
    // 只给名字，不给地址：列表必须显示 `—`，title 说明「未返回地址」。
    exit: { ip: null, port: null, address: null, server_name: "美国-04" },
  },
  缺一段延迟: {
    entry: {
      ip: "203.0.113.14",
      port: 443,
      address: "203.0.113.14:443",
      server_name: "香港-01",
    },
    exit: {
      ip: "198.51.100.24",
      port: 8443,
      address: "198.51.100.24:8443",
      server_name: "美国-04",
    },
  },
  全空延迟: {
    entry: {
      ip: "203.0.113.15",
      port: 443,
      address: "203.0.113.15:443",
      server_name: "香港-01",
    },
    exit: {
      ip: "198.51.100.25",
      port: 8443,
      address: "198.51.100.25:8443",
      server_name: "日本-02",
    },
  },
};

/** 整链窗口丢包 / 探测计数（列表「窗口丢包」列）。 */
const LOSS_PLAN = {
  三跳单线: { loss: 1.2, attempts: 720, failures: 9 },
  多线中转: { loss: 0.3, attempts: 720, failures: 2 },
  来源哈希线: { loss: null, attempts: 0, failures: 0 },
  缺一段延迟: { loss: 4.7, attempts: 149, failures: 7, partial: true },
  全空延迟: { loss: 0.04, attempts: 240, failures: 0 },
};

/** 逐段窗口丢包（与逐桶 `series[].loss_pct` 是两个数）。 */
const SEGMENT_LOSS_PLAN = {
  三跳单线: [
    { seq: 1, loss: 0.83, attempts: 240, failures: 2 },
    { seq: 2, loss: 2.92, attempts: 240, failures: 7 },
  ],
  多线中转: [
    { seq: 1, loss: 0.3, attempts: 720, failures: 2 },
    { seq: 2, loss: 0.1, attempts: 720, failures: 1 },
  ],
  来源哈希线: [{ seq: 1, loss: 0.04, attempts: 240, failures: 0 }],
};

function segmentLoss(name, seq, index, count) {
  if (name === "三跳单线") {
    // 最近约 3 小时变差：tooltip 的该时刻丢包必须能读出不同值。
    return index >= count - 12 ? (seq === 1 ? 2.9 : 4.7) : seq === 1 ? 0.3 : 0.2;
  }
  if (name === "多线中转") {
    // 第 2 段故意没有逐桶探测：tooltip 必须显示 —。
    return seq === 1 ? 0.3 : null;
  }
  if (name === "来源哈希线") return 0.04;
  return null;
}

function buildSegmentSeries(chain, segment, name) {
  const points = chain.series.filter(
    (point) => point && point.p50 !== null && point.samples > 0,
  );
  if (points.length === 0) return [];
  const latest = points[points.length - 1].p50;
  const scale = latest > 0 ? segment.p50 / latest : 0;
  return points.map((point, index) => ({
    ts: point.ts,
    p50:
      Math.round(Math.max(0, point.p50 * scale) * 10) / 10,
    p10: null,
    p90: null,
    samples: point.samples,
    loss_pct: segmentLoss(name, segment.seq, index, points.length),
  }));
}

function augment(payload) {
  for (const chain of payload.chains ?? []) {
    const endpoints = ENDPOINTS[chain.name];
    if (endpoints) {
      chain.entry = endpoints.entry;
      chain.exit = endpoints.exit;
    }
    const loss = LOSS_PLAN[chain.name];
    if (loss) {
      chain.loss_pct = loss.loss;
      chain.loss_partial = loss.partial ?? false;
      chain.loss_samples = {
        attempts: loss.attempts,
        failures: loss.failures,
      };
    }

    // 整链逐桶丢包（列表趋势图原有的「该时刻丢包」提示保持可用）。
    const chainPoints = chain.series ?? [];
    const latestTs = Math.max(
      ...chainPoints
        .filter((point) => point && Number.isFinite(point.ts))
        .map((point) => point.ts),
    );
    for (const point of chainPoints) {
      if (!point) continue;
      point.loss_pct =
        point.samples <= 0 || point.p50 === null
          ? null
          : chain.name === "三跳单线" && point.ts >= latestTs - 2 * 3600
            ? 4.7
            : chain.name === "多线中转"
              ? 0.3
              : chain.name === "缺一段延迟"
                ? 4.7
                : null;
    }

    // 逐段窗口丢包 / 探测计数 + 逐段序列（契约新增 `segments[].series`）。
    const segmentPlan = SEGMENT_LOSS_PLAN[chain.name] ?? [];
    for (const segment of chain.segments ?? []) {
      const plan = segmentPlan.find((item) => item.seq === segment.seq);
      segment.loss_pct = plan?.loss ?? null;
      segment.attempts = plan?.attempts ?? 0;
      segment.failures = plan?.failures ?? 0;
      segment.series =
        segment.p50 === null ? [] : buildSegmentSeries(chain, segment, chain.name);
    }
  }

  payload.summary = {
    ...(payload.summary ?? {}),
    loss_pct: 1.2,
    worst_loss: {
      chain_id: chainIdByName.get("缺一段延迟") ?? null,
      chain_name: "缺一段延迟",
      loss_pct: 4.7,
    },
  };
  return payload;
}

const injectedHealth = augment(structuredClone(health));
/** 旧主控：不返回 entry / exit / segments[].series，整列应为 `—`。 */
const legacyHealth = structuredClone(health);
for (const chain of legacyHealth.chains ?? []) {
  delete chain.entry;
  delete chain.exit;
  for (const segment of chain.segments ?? []) delete segment.series;
}

const results = [];
const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => results.push({ name, ok: true, detail }))
    .catch((error) => {
      results.push({ name, ok: false, detail: error.message });
      failures.push(`${name}: ${error.message}`);
    });
}

async function newContext(browser, width, height, theme, legacy = false) {
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
  await context.route("**/api/v1/overview/chain-health*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "cache-control": "no-store", "x-chain-health-cache": "miss" },
      body: JSON.stringify(legacy ? legacyHealth : injectedHealth),
    });
  });
  return context;
}

async function openList(page) {
  await page.goto(`${BASE}/?view=chain`, { waitUntil: "networkidle" });
  await page.locator("[data-chain-list]").waitFor();
  await page.locator("[data-chain-list-row]").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function shot(page, file) {
  await page.screenshot({ path: path.join(OUT, file) });
  console.log(`saved ${file}`);
}

async function openChain(page, name) {
  const id = chainIdByName.get(name);
  assert.ok(id, `chain ${name} must exist`);
  await page.locator(`[data-chain-list-row][data-chain-id="${id}"]`).click();
  await page.locator("[data-chain-dialog]").waitFor();
  await page.waitForTimeout(400);
}

async function closeWithEscape(page) {
  await page.keyboard.press("Escape");
  await page.locator("[data-chain-dialog]").waitFor({ state: "detached" });
  await page.waitForTimeout(200);
}

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

    await check(`[${key}] 列头含「起点 / 终点」与「跳数」`, async () => {
      const head = page.locator("[data-chain-list-head]");
      const visible = await head.isVisible();
      assert.equal(visible, width >= 640, "head visibility follows breakpoint");
      const text = visible
        ? (await head.innerText()).replace(/\s+/g, " ").trim()
        : "";
      if (width >= 640) {
        assert.match(text, /起点 \/ 终点/);
        assert.match(text, /跳数/);
        assert.match(text, /窗口丢包/);
      }
      return { visible, text };
    });

    await check(`[${key}] 每行都有起点/终点与独立跳数列`, async () => {
      const rows = page.locator("[data-chain-list-row]");
      const count = await rows.count();
      assert.ok(count >= 5, `expected >= 5 rows, got ${count}`);
      const data = await page.evaluate(() =>
        [...document.querySelectorAll("[data-chain-list-row]")].map((row) => ({
          id: row.getAttribute("data-chain-id"),
          name: row.querySelector("[title]")?.textContent?.trim() ?? "",
          address:
            row.querySelector("[data-chain-endpoint-address]")?.textContent
              ?.replace(/\s+/g, " ")
              .trim() ?? "",
          names:
            row.querySelector("[data-chain-endpoint-name]")?.textContent
              ?.replace(/\s+/g, " ")
              .trim() ?? "",
          hops:
            row.querySelector("[data-chain-hops]")?.textContent?.trim() ?? "",
          addressTitle:
            row
              .querySelector("[data-chain-endpoint-address]")
              ?.getAttribute("title") ?? "",
        })),
      );
      for (const row of data) {
        assert.match(row.address, /→/, `row ${row.name} address must use →`);
        assert.match(row.names, /→/, `row ${row.name} names must use →`);
        assert.match(row.hops, /跳/, `row ${row.name} must show N 跳`);
      }
      const noAddress = data.find((row) => /→\s*—$/.test(row.address));
      assert.ok(noAddress, "a null address row must render —");
      assert.match(noAddress.addressTitle, /没有可展示的地址/);
      return data;
    });

    const listOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    const layout = await page.evaluate(() => {
      const row = document.querySelector("[data-chain-list-row]");
      const main = row.querySelector("[data-chain-row-main]");
      const meta = row.querySelector("[data-chain-row-meta]");
      const box = (element) => element.getBoundingClientRect();
      return {
        height: Math.round(box(row).height),
        mainTop: Math.round(box(main).top),
        metaTop: Math.round(box(meta).top),
      };
    });
    await check(`[${key}] 390 两行布局、无横向溢出`, async () => {
      assert.ok(listOverflow <= 1, `horizontal overflow ${listOverflow}px`);
      if (width === 390) {
        assert.ok(
          layout.metaTop > layout.mainTop,
          `390 must stack rows (main ${layout.mainTop}, meta ${layout.metaTop})`,
        );
      } else {
        assert.equal(
          layout.mainTop,
          layout.metaTop,
          "desktop keeps one row",
        );
      }
      return { listOverflow, layout };
    });

    await shot(page, `list-${key}.png`);
    await page.locator("[data-chain-list-card]").scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    await shot(page, `rows-${key}.png`);

    // 详情：三段链 = 2 条有数据曲线 + 1 个缺失段的灰显图例。
    await openChain(page, "三跳单线");
    const dialog = page.locator("[data-chain-dialog]");
    const dialogBox = await dialog.boundingBox();
    const tableCount = await page.locator("[data-chain-dialog] table").count();
    const chartCount = await page.locator("[data-chain-segment-chart]").count();
    const lineCount = await page
      .locator("[data-chain-segment-chart] .recharts-line")
      .count();
    const legendItems = await page
      .locator("[data-segment-legend-item]")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          seq: node.getAttribute("data-seq"),
          hasData: node.getAttribute("data-has-data"),
          text: node.innerText.replace(/\s+/g, " ").trim(),
        })),
      );
    const contributionRows = await page.locator("[data-chain-segment]").count();
    const contributionBars = await page
      .locator("[data-segment-contribution]")
      .count();
    const currentReadouts = await page
      .locator("[data-segment-current]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.innerText.replace(/\s+/g, " ").trim()),
      );
    const lossReadouts = await page
      .locator("[data-segment-loss]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.innerText.replace(/\s+/g, " ").trim()),
      );

    await check(`[${key}] 详情不再用表格：一张多序列折线 + 图例 + 贡献条`, async () => {
      assert.equal(tableCount, 0, "detail must not render a table");
      assert.equal(chartCount, 1, `expected 1 multi-series chart, got ${chartCount}`);
      assert.equal(lineCount, 2, `expected 2 lines, got ${lineCount}`);
      assert.equal(legendItems.length, 3, "legend lists every hop");
      assert.equal(
        legendItems.filter((item) => item.hasData === "true").length,
        2,
        "two hops have history",
      );
      assert.equal(
        legendItems.filter((item) => item.hasData === "false").length,
        1,
        "the missing hop stays in the legend",
      );
      for (const item of legendItems) assert.match(item.text, /第 \d+ 段/);
      const missing = legendItems.find((item) => item.hasData === "false");
      assert.match(missing.text, /无历史数据/);
      assert.equal(contributionRows, 3, "one compact contribution row per hop");
      assert.equal(contributionBars, 3, "each hop keeps a contribution bar");
      for (const readout of currentReadouts) assert.match(readout, /P50/);
      for (const readout of lossReadouts) assert.match(readout, /窗口丢包/);
      assert.ok(
        lossReadouts.filter((readout) => /\d/.test(readout)).length >= 2,
        "data hops show their own window loss",
      );
      return {
        dialog: dialogBox
          ? {
              width: Math.round(dialogBox.width),
              height: Math.round(dialogBox.height),
            }
          : null,
        tableCount,
        chartCount,
        lineCount,
        legendItems,
        contributionRows,
        contributionBars,
        currentReadouts,
        lossReadouts,
      };
    });

    // 图例可点击隐藏/显示单段。
    const lineAfterToggle = async () => {
      await page
        .locator('[data-segment-legend-item][data-has-data="true"]')
        .first()
        .click();
      await page.waitForTimeout(150);
      const hiddenLines = await page
        .locator("[data-chain-segment-chart] .recharts-line")
        .count();
      const visibleCount = await page
        .locator("[data-chain-segment-chart]")
        .getAttribute("data-visible-count");
      await page
        .locator('[data-segment-legend-item][data-has-data="true"]')
        .first()
        .click();
      await page.waitForTimeout(150);
      return { hiddenLines, visibleCount };
    };
    const toggle = await lineAfterToggle();
    await check(`[${key}] 图例可隐藏/显示单段`, async () => {
      assert.equal(toggle.hiddenLines, 1, "hiding one hop leaves one line");
      assert.equal(toggle.visibleCount, "1");
      return toggle;
    });

    await page.locator("[data-chain-segments-card]").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const chartWrapper = page
      .locator("[data-chain-segment-chart] .recharts-wrapper")
      .first();
    const chartBox = await chartWrapper.boundingBox();
    assert.ok(chartBox, "segment chart must render");
    const dialogOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    await check(`[${key}] 图表高度与 390 无横向溢出`, async () => {
      const expected = width === 390 ? 240 : 260;
      assert.ok(
        Math.abs(chartBox.height - expected) <= 2,
        `expected ~${expected}px chart, got ${chartBox.height}`,
      );
      assert.ok(dialogOverflow <= 1, `dialog overflow ${dialogOverflow}px`);
      return { chartHeight: chartBox.height, dialogOverflow };
    });
    await shot(page, `detail-segments-${key}.png`);

    // tooltip：同一时刻按段序列出时延与该时刻丢包。
    await page.mouse.move(
      chartBox.x + chartBox.width * 0.68,
      chartBox.y + chartBox.height * 0.5,
    );
    await page.waitForTimeout(250);
    const tooltip = page.locator("[data-segment-tooltip]").first();
    await tooltip.waitFor();
    const tooltipText = (await tooltip.innerText()).replace(/\s+/g, " ").trim();
    const tooltipRows = await page
      .locator("[data-segment-tooltip-row]")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          seq: Number(node.getAttribute("data-seq")),
          text: node.innerText.replace(/\s+/g, " ").trim(),
          highest: node.getAttribute("data-highest"),
          lowest: node.getAttribute("data-lowest"),
        })),
      );
    await check(`[${key}] tooltip 按段序同时含时延与该时刻丢包`, async () => {
      assert.equal(tooltipRows.length, 2, "two visible hops in the tooltip");
      assert.deepEqual(
        tooltipRows.map((row) => row.seq),
        [1, 2],
        "tooltip rows follow hop order",
      );
      for (const row of tooltipRows) {
        assert.match(row.text, /\d+(\.\d+)? ms/);
        assert.match(row.text, /该时刻丢包/);
        assert.match(row.text, /\d+(\.\d+)?%/);
      }
      assert.equal(
        tooltipRows.filter((row) => row.highest === "true").length,
        1,
        "highest hop is annotated once",
      );
      assert.match(tooltipText, /最高/);
      return { tooltipText, tooltipRows };
    });
    await shot(page, `detail-tooltip-${key}.png`);
    await closeWithEscape(page);

    // 某段逐桶丢包为 null：该段 tooltip 显示 —，不借用窗口值。
    await openChain(page, "多线中转");
    await page.locator("[data-chain-segments-card]").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const secondChart = page
      .locator("[data-chain-segment-chart] .recharts-wrapper")
      .first();
    const secondBox = await secondChart.boundingBox();
    assert.ok(secondBox, "multi-series chart must render");
    await page.mouse.move(
      secondBox.x + secondBox.width * 0.6,
      secondBox.y + secondBox.height * 0.5,
    );
    await page.waitForTimeout(250);
    const nullLossTooltip = page.locator("[data-segment-tooltip]").first();
    await nullLossTooltip.waitFor();
    const nullRow = nullLossTooltip.locator(
      '[data-segment-tooltip-row][data-seq="2"]',
    );
    const nullRowText = (await nullRow.innerText()).replace(/\s+/g, " ").trim();
    await check(`[${key}] 某段 null 逐桶丢包显示 —`, async () => {
      assert.match(nullRowText, /该时刻丢包 —/);
      return nullRowText;
    });
    await shot(page, `detail-tooltip-null-${key}.png`);
    await closeWithEscape(page);

    // 全部段都没有历史数据：图例灰显 + 图表空态，不画 0ms 折线。
    await openChain(page, "缺一段延迟");
    await page.locator("[data-chain-segments-card]").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const emptyCount = await page.locator("[data-segment-empty]").count();
    const emptyText = await page
      .locator("[data-segment-empty]")
      .first()
      .innerText();
    const emptyCharts = await page
      .locator("[data-chain-segment-chart] .recharts-wrapper")
      .count();
    const greyLegends = await page
      .locator('[data-segment-legend-item][data-has-data="false"]')
      .count();
    await check(`[${key}] 无数据段灰显「无历史数据」空态`, async () => {
      assert.equal(emptyCount, 1, "one chart-level empty state");
      assert.equal(emptyText.trim(), "无历史数据");
      assert.equal(emptyCharts, 0, "no chart is drawn without data");
      assert.ok(greyLegends >= 2, "grey legends for hops without history");
      return { emptyCount, emptyText, emptyCharts, greyLegends };
    });
    await shot(page, `detail-empty-${key}.png`);
    await closeWithEscape(page);

    results.push({
      name: `[${key}] page errors`,
      ok: errors.length === 0,
      detail: errors,
    });
    if (errors.length > 0) failures.push(`[${key}] page errors: ${errors.join("; ")}`);
    await context.close();
  }
}

// 旧主控：entry/exit 缺失 → 整列 `—`，但列表仍可用。
{
  const context = await newContext(browser, 1440, 1000, "dark", true);
  const page = await context.newPage();
  await openList(page);
  const addresses = await page
    .locator("[data-chain-endpoint-address]")
    .allInnerTexts();
  const titles = await page
    .locator("[data-chain-endpoint-address]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title") ?? ""));
  await check("旧主控缺 entry/exit：整列 —，title 说明未返回", async () => {
    assert.ok(addresses.length >= 5);
    for (const text of addresses) {
      assert.match(text.replace(/\s+/g, " ").trim(), /^—\s*→\s*—$/);
    }
    for (const title of titles) assert.match(title, /未返回该端信息/);
    return { addresses, titles };
  });
  await page.locator("[data-chain-list-card]").scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot(page, "list-no-contract-1440-dark.png");
  await context.close();
}

await browser.close();

const report = { results, failures };
writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
