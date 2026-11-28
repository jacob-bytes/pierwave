/**
 * 多路径链路时延卡的验收截图 / Multi-path chain latency acceptance shots.
 *
 * 用独立 Vite 页面渲染真实的 `ChainLatencyDetail`（真实组件 +
 * `normalizeChainHealth`），不依赖主控 / 数据库：
 *
 * - `failover`：主备 3 台、东京-01 离线 → 徽章「降级 · 东京-01 离线」、
 *   整体时延卡「多路径 · 按各跳中位数叠加」、段标题「第 1 段 · 主备 · 3 选 1」、
 *   悬停图例 / 线条追加成员明细（当前 = 东京-02）；
 * - `roundRobin`：轮询 3 台 → 「第 1 段 · 轮询 · 3 台分担」，没有「当前」标记；
 * - `single`：单成员 → 没有多路径说明、段标题保持「第 1 段」；
 * - `missingMembers`：节点有策略、段没有 `members[]` → 标题仍在，明细降级消失；
 * - `many`：10 台成员 → 明细 8 行 + `+2`，当前成员排第一。
 *
 * 前置 / Prerequisite:
 *   cd web && ./node_modules/.bin/vite --port 5199 --strictPort
 * 运行 / Run:
 *   BASE=http://localhost:5199 node web/screenshots/chain-multipath/shots.mjs
 *
 * 环境变量 / Env: BASE / PLAYWRIGHT_MODULE / CHROME_PATH / HEADED
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://localhost:5199";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const THEME_LABEL = { dark: "暗色", light: "亮色" };
const WIDTHS = [1440, 390];

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const npxRoot = path.join(ROOT, ".npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSafe(npxRoot)) {
      candidates.push(
        path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs"),
      );
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return import(candidate);
  }
  return import("playwright");
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

mkdirSync(HERE, { recursive: true });

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = { generatedAt: new Date().toISOString(), base: BASE, shots: [], checks: [] };
const errors = [];

function url(fixture, theme, lang = "zh-CN") {
  return `${BASE}/screenshots/chain-multipath/harness.html?fixture=${fixture}&theme=${theme}&lang=${lang}`;
}

async function open({ fixture, theme, width, lang = "zh-CN" }) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`${fixture}/${theme}/${width}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`${fixture}/${theme}/${width}: ${error.message}`);
  });
  await page.goto(url(fixture, theme, lang), { waitUntil: "load" });
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(250);
  return { context, page };
}

async function metrics(page) {
  return page.evaluate(() => {
    const text = (element) => element?.textContent?.trim() ?? "";
    const badge = document.querySelector(
      "[data-chain-detail-status] [data-chain-status-badge]",
    );
    const note = document.querySelector("[data-chain-multipath-note]");
    const legend = [...document.querySelectorAll("[data-segment-legend-item]")].map(
      (item) => ({
        seq: item.getAttribute("data-seq"),
        title: item.getAttribute("data-segment-title"),
        label: text(item),
        hasMembers: item.getAttribute("data-has-members") === "true",
      }),
    );
    const panel = document.querySelector("[data-segment-member-panel]");
    const panelRows = panel
      ? [...panel.querySelectorAll("[data-segment-member-row]")]
      : [];
    const tooltip = document.querySelector("[data-segment-tooltip]");
    const tooltipTables = tooltip
      ? [...tooltip.querySelectorAll("[data-segment-member-table]")]
      : [];
    const tooltipRows = tooltipTables.flatMap((table) => [
      ...table.querySelectorAll("[data-segment-member-row]"),
    ]);
    return {
      badgeText: text(badge),
      badgeState: badge?.getAttribute("data-state") ?? null,
      noteVisible: note !== null,
      noteText: text(note),
      noteTitle: note?.getAttribute("title") ?? "",
      legend,
      panel: panel === null
        ? null
        : {
            seq: panel.getAttribute("data-seq"),
            rows: panelRows.length,
            active: panelRows.filter(
              (row) => row.getAttribute("data-active") === "true",
            ).length,
            current: text(
              panelRows.find(
                (row) => row.getAttribute("data-active") === "true",
              )?.querySelector("[data-segment-member-current]"),
            ),
            more: text(panel.querySelector("[data-segment-member-more]")),
            first: text(panelRows[0]?.querySelector("span[title]")),
            names: panelRows.map((row) => text(row.querySelector("span[title]"))),
          },
      tooltipVisible: tooltip !== null,
      tooltipTables: tooltipTables.length,
      tooltipRows: tooltipRows.length,
      tooltipActive: tooltipRows.filter(
        (row) => row.getAttribute("data-active") === "true",
      ).length,
      tooltipTableSeq: tooltipTables[0]?.getAttribute("data-seq") ?? null,
      bodyText: document.body.innerText,
    };
  });
}

async function hoverLegend(page, seq) {
  await page
    .locator(`[data-segment-legend-item][data-seq="${seq}"]`)
    .hover();
  await page.waitForTimeout(220);
}

async function hoverChart(page) {
  const surface = page
    .locator("[data-chain-segment-chart] .recharts-surface")
    .first();
  await surface.scrollIntoViewIfNeeded();
  await page.waitForTimeout(120);
  const box = await surface.boundingBox();
  assert.ok(box !== null, "chart surface must be measurable");
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.45);
  await page.waitForTimeout(320);
}

async function shot(page, name, meta = {}) {
  const file = `${name}.png`;
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.screenshot({
    path: path.join(HERE, file),
    fullPage: true,
    animations: "disabled",
  });
  const bytes = readFileSync(path.join(HERE, file));
  report.shots.push({ name: file, bytes: bytes.length, ...meta });
}

/**
 * 视口截图：hover 浮层是全页截图的天敌（fullPage 会滚动页面，指针离开图例
 * 后面板就收起来）。先把逐段卡滚到顶部，再按当前视口截，保留 hover 状态。
 */
async function shotViewport(page, name, meta = {}) {
  const file = `${name}.png`;
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.screenshot({
    path: path.join(HERE, file),
    animations: "disabled",
  });
  const bytes = readFileSync(path.join(HERE, file));
  report.shots.push({ name: file, bytes: bytes.length, ...meta });
}

async function scrollSegmentsCardIntoView(page) {
  await page.evaluate(() => {
    document
      .querySelector("[data-chain-segments-card]")
      ?.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(160);
}

/**
 * 只截逐段卡：tooltip 是 chart 内的绝对定位浮层，整页截图会改变视口并让
 * Recharts 收掉 hover 状态；按 locator 截能保住当前指针位置。
 */
async function shotSegmentsCard(page, name, meta = {}) {
  const file = `${name}.png`;
  const card = page.locator("[data-chain-segments-card]");
  await card.screenshot({ path: path.join(HERE, file), animations: "disabled" });
  const bytes = readFileSync(path.join(HERE, file));
  report.shots.push({ name: file, bytes: bytes.length, ...meta });
}

function check(name, value) {
  report.checks.push({ name, value });
}

const EXPECTED = {
  failover: {
    badge: "降级 · 东京-01 离线",
    state: "degraded",
    note: true,
    titles: { 1: "第 1 段", 2: "第 2 段 · 主备 · 3 选 1" },
    panel: { rows: 3, active: 1, current: "当前", more: "" },
    tooltipTable: true,
  },
  roundRobin: {
    badge: "正常",
    state: "ok",
    note: true,
    titles: { 1: "第 1 段", 2: "第 2 段 · 轮询 · 3 台分担" },
    panel: { rows: 3, active: 0, current: "", more: "" },
    tooltipTable: true,
  },
  single: {
    badge: "正常",
    state: "ok",
    note: false,
    titles: { 1: "第 1 段", 2: "第 2 段" },
    panel: { rows: 1, active: 0, current: "", more: "" },
    tooltipTable: true,
  },
  missingMembers: {
    badge: "降级 · 东京-01 离线",
    state: "degraded",
    note: true,
    titles: { 1: "第 1 段", 2: "第 2 段 · 主备 · 3 选 1" },
    panel: null,
    tooltipTable: false,
  },
  many: {
    badge: "正常",
    state: "ok",
    note: true,
    titles: { 1: "第 1 段", 2: "第 2 段 · 主备 · 10 选 1" },
    panel: { rows: 8, active: 1, current: "当前", more: "+2" },
    tooltipTable: true,
  },
};

for (const fixture of Object.keys(EXPECTED)) {
  const expected = EXPECTED[fixture];
  for (const theme of ["dark", "light"]) {
    for (const width of WIDTHS) {
      const label = `${fixture}/${theme}/${width}`;
      const { context, page } = await open({ fixture, theme, width });
      try {
        const base = await metrics(page);
        assert.equal(base.badgeState, expected.state, `${label}: badge state`);
        assert.equal(base.badgeText, expected.badge, `${label}: badge text`);
        assert.equal(base.noteVisible, expected.note, `${label}: multi-path note`);
        if (expected.note) {
          assert.equal(
            base.noteText,
            "多路径 · 按各跳中位数叠加",
            `${label}: note copy`,
          );
          assert.match(base.noteTitle, /RTT/, `${label}: note explains RTT boundary`);
        }
        for (const [seq, title] of Object.entries(expected.titles)) {
          const item = base.legend.find((entry) => entry.seq === String(seq));
          assert.ok(item, `${label}: legend item ${seq}`);
          assert.equal(item.title, title, `${label}: legend title ${seq}`);
        }
        // 明细挂在源组：段 2 才是多成员组（入口段只有 1 台）。
        assert.equal(
          base.legend.find((entry) => entry.seq === "2")?.hasMembers,
          expected.panel !== null,
          `${label}: legend member affordance`,
        );
        // 首屏不能出现成员曲线 / 成员明细。
        assert.equal(base.panel, null, `${label}: no member panel before hover`);
        assert.equal(base.tooltipTables, 0, `${label}: no tooltip table before hover`);

        await shot(page, `${fixture}-${theme}-${width}`, {
          fixture,
          theme: THEME_LABEL[theme],
          width,
          badge: base.badgeText,
          note: base.noteVisible,
          titles: base.legend.map((entry) => entry.title),
        });

        // 悬停图例：成员明细卡（契约缺失时没有任何卡）。
        await page.mouse.move(2, 2);
        await page.waitForTimeout(80);
        await scrollSegmentsCardIntoView(page);
        await hoverLegend(page, 2);
        const hovered = await metrics(page);
        if (expected.panel === null) {
          assert.equal(hovered.panel, null, `${label}: no panel without members`);
        } else {
          assert.ok(hovered.panel, `${label}: legend hover shows member panel`);
          assert.equal(hovered.panel.seq, "2", `${label}: panel segment`);
          assert.equal(
            hovered.panel.rows,
            expected.panel.rows,
            `${label}: panel row count`,
          );
          assert.equal(
            hovered.panel.active,
            expected.panel.active,
            `${label}: current member count`,
          );
          assert.equal(
            hovered.panel.current,
            expected.panel.current,
            `${label}: current marker`,
          );
          assert.equal(
            hovered.panel.more,
            expected.panel.more,
            `${label}: +N overflow`,
          );
          if (fixture === "many") {
            assert.equal(
              hovered.panel.first,
              "法兰克福-10",
              `${label}: active member sorts first`,
            );
          }
        }
        await shotViewport(page, `${fixture}-${theme}-${width}-members`, {
          fixture,
          theme: THEME_LABEL[theme],
          width,
          hover: "legend",
          panel: hovered.panel,
        });

        // 悬停线条：tooltip 追加同一张明细表。
        await page.mouse.move(2, 2);
        await page.waitForTimeout(120);
        await hoverChart(page);
        const chartHover = await metrics(page);
        assert.ok(chartHover.tooltipVisible, `${label}: chart tooltip`);
        if (expected.tooltipTable) {
          assert.equal(
            chartHover.tooltipTables,
            1,
            `${label}: tooltip member table`,
          );
          assert.ok(chartHover.tooltipRows > 0, `${label}: tooltip member rows`);
          if (fixture === "many") {
            assert.ok(
              chartHover.tooltipRows <= 8,
              `${label}: tooltip rows capped at 8`,
            );
          }
        } else {
          assert.equal(
            chartHover.tooltipTables,
            0,
            `${label}: tooltip degrades without members contract`,
          );
        }
        await shotSegmentsCard(page, `${fixture}-${theme}-${width}-tooltip`, {
          fixture,
          theme: THEME_LABEL[theme],
          width,
          hover: "chart",
          tooltipRows: chartHover.tooltipRows,
          tooltipTable: chartHover.tooltipTables,
        });

        check(`${fixture}/${theme}/${width}`, {
          badge: base.badgeText,
          note: base.noteText,
          titles: base.legend.map((entry) => entry.title),
          panel: hovered.panel,
          tooltip: {
            tables: chartHover.tooltipTables,
            rows: chartHover.tooltipRows,
          },
        });
      } finally {
        await context.close();
      }
    }
  }
}

// 英文 pass：证明文案与标题都是双语的，不只是改了中文。
for (const width of WIDTHS) {
  const { context, page } = await open({
    fixture: "failover",
    theme: "dark",
    width,
    lang: "en",
  });
  try {
    const result = await metrics(page);
    assert.equal(result.badgeText, "Degraded · 东京-01 offline", "en badge");
    assert.equal(
      result.noteText,
      "Multi-path · summed per-hop medians",
      "en note",
    );
    assert.match(result.noteTitle, /not the RTT of a single connection/, "en hint");
    assert.equal(
      result.legend.find((entry) => entry.seq === "2")?.title,
      "Segment 2 · Active/standby · 1 of 3",
      "en segment title",
    );
    await scrollSegmentsCardIntoView(page);
    await hoverLegend(page, 2);
    const hovered = await metrics(page);
    assert.equal(hovered.panel?.rows, 3, "en panel rows");
    assert.equal(hovered.panel?.current, "Current", "en current marker");
    await shotViewport(page, `failover-en-${width}-dark-members`, {
      fixture: "failover",
      theme: "en dark",
      width,
      hover: "legend",
      panel: hovered.panel,
    });
    await page.mouse.move(2, 2);
    await hoverChart(page);
    const chartHover = await metrics(page);
    assert.equal(chartHover.tooltipTables, 1, "en tooltip member table");
    assert.equal(chartHover.tooltipActive, 1, "en tooltip current member");
    await shotSegmentsCard(page, `failover-en-${width}-dark-tooltip`, {
      fixture: "failover",
      theme: "en dark",
      width,
      hover: "chart",
      tooltipRows: chartHover.tooltipRows,
    });
  } finally {
    await context.close();
  }
}

assert.deepEqual(errors, [], `console errors: ${errors.join("\n")}`);
writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

await browser.close();
console.log(
  `chain-multipath shots: ${report.shots.length} images, ${report.checks.length} checks`,
);
