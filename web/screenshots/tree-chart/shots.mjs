// Tree chart acceptance shots: fixtures × theme × width + F1–F9 interactions.
//
// Prerequisite:
//   cd web && ./node_modules/.bin/vite --port 5199 --strictPort
// Usage:
//   node web/screenshots/tree-chart/shots.mjs
//
// 每个断言都是「修复后」的证据；性能前后对比另见 measure-perf.mjs
// （perf-before.json / perf-after.json）。
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

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const npxRoot = path.join(ROOT, ".npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSafe(npxRoot)) {
      candidates.push(path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs"));
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
const report = { generatedAt: new Date().toISOString(), shots: [], checks: [] };
const errors = [];

function url(fixture, theme, lang = "zh-CN") {
  return `${BASE}/screenshots/tree-chart/harness.html?fixture=${fixture}&theme=${theme}&lang=${lang}`;
}

async function open({
  fixture,
  theme,
  width,
  height,
  lang,
  reducedMotion,
  hasTouch,
  isMobile,
}) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion,
    hasTouch,
    isMobile,
  });
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
  await page.waitForTimeout(150);
  return page;
}

async function metrics(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll("[data-tree-node]")];
    const edges = [...document.querySelectorAll("[data-tree-edge-group]")].map(
      (element) => ({
        id: element.getAttribute("data-edge-id") ?? "",
        d: element.getAttribute("d") ?? "",
        value: Number(element.getAttribute("data-value") ?? 0),
        width: Number(element.getAttribute("data-width") ?? 0),
        unavailable: element.getAttribute("data-unavailable") === "true",
        degraded: element.getAttribute("data-degraded") === "true",
        pulse: element.getAttribute("data-pulse") === "true",
      }),
    );
    const byDepth = new Map();
    for (const node of nodes) {
      const depth = Number(node.getAttribute("data-depth"));
      if (byDepth.has(depth)) continue;
      const dot = document.querySelector(
        `[data-tree-node-dot][data-tree-index="${node.getAttribute("data-tree-index")}"]`,
      );
      byDepth.set(depth, Number(dot?.getAttribute("cx") ?? 0));
    }
    const kindCount = (kind) =>
      nodes.filter((node) => node.getAttribute("data-kind") === kind).length;
    const labels = [...document.querySelectorAll("[data-tree-label]")].map(
      (element) => element.textContent?.trim() ?? "",
    );
    const scroll = document.querySelector("[data-tree-chart-scroll]");
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      edges,
      xByDepth: [...byDepth.entries()].sort((a, b) => a[0] - b[0]),
      targets: kindCount("target"),
      folds: kindCount("fold"),
      foldTexts: labels.filter((text) => text.startsWith("+")),
      labels,
      edgeLabels: [...document.querySelectorAll("[data-tree-edge-label]")].map(
        (element) => element.textContent?.trim() ?? "",
      ),
      haloCount: document.querySelectorAll("[data-tree-node-halo]").length,
      scrollWidth: scroll?.scrollWidth ?? 0,
      clientWidth: scroll?.clientWidth ?? 0,
      pulsePaths: document.querySelectorAll("[data-tree-pulse]").length,
      staticPulsePaths: document.querySelectorAll("[data-tree-pulse-static]").length,
    };
  });
}

function assertLayout(result, label) {
  assert.ok(result.edgeCount > 0, `${label}: no edges`);
  for (const edge of result.edges) {
    assert.match(edge.d, /^M /, `${label}: edge curve must start with M`);
    assert.ok(edge.d.includes(" C "), `${label}: edge must be cubic bezier`);
  }
  for (let index = 1; index < result.xByDepth.length; index += 1) {
    assert.ok(
      result.xByDepth[index][1] > result.xByDepth[index - 1][1],
      `${label}: column x must increase with depth`,
    );
  }
  const sorted = [...result.edges].sort((a, b) => a.value - b.value);
  assert.ok(
    sorted[0].width <= sorted[sorted.length - 1].width,
    `${label}: edge width must follow chains`,
  );
  for (const edge of result.edges) {
    assert.ok(edge.width >= 1.5 && edge.width <= 6, `${label}: edge width range`);
  }
}

async function shot(page, name, meta = {}, options = {}) {
  const file = `${name}.png`;
  await page.screenshot({
    path: path.join(HERE, file),
    fullPage: options.fullPage ?? true,
    animations: options.animations ?? "disabled",
  });
  const bytes = readFileSync(path.join(HERE, file));
  report.shots.push({ name: file, bytes: bytes.length, ...meta });
  return bytes;
}

function check(name, value) {
  report.checks.push({ name, value });
}

/** 图表滚动容器与 tooltip 的几何：判断是否被裁切。 */
async function geometry(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector("[data-tree-chart-scroll]");
    const tooltip = document.querySelector("[data-chart-tooltip]");
    const chart = document.querySelector("[data-tree-chart]");
    const rect = (element) => {
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
    };
    const style = tooltip === null ? null : getComputedStyle(tooltip);
    return {
      scroll: rect(scroll),
      tooltip: rect(tooltip),
      tooltipVisible:
        tooltip !== null &&
        style.visibility !== "hidden" &&
        style.display !== "none",
      chart: rect(chart),
      tooltipId: tooltip?.id ?? null,
      ariaLive: tooltip?.getAttribute("aria-live") ?? null,
    };
  });
}

// 1. Base matrix: fixtures × 2 themes × 2 widths.
const EXPECTED = {
  single: { targets: 3, folds: 0 },
  multi: { targets: 4, folds: 0 },
  fold: { targets: 8, folds: 1 },
  offline: { targets: 4, folds: 0 },
  "fold-multi": { targets: 16, folds: 2 },
  degraded: { targets: 4, folds: 0 },
};
for (const fixture of Object.keys(EXPECTED)) {
  for (const theme of ["dark", "light"]) {
    for (const width of [1440, 390]) {
      const page = await open({
        fixture,
        theme,
        width,
        height: width === 390 ? 844 : 1000,
      });
      const result = await metrics(page);
      assertLayout(result, `${fixture}/${theme}/${width}`);
      assert.equal(
        result.targets,
        EXPECTED[fixture].targets,
        `${fixture}: visible target leaves`,
      );
      assert.equal(result.folds, EXPECTED[fixture].folds, `${fixture}: fold nodes`);
      assert.ok(result.pulsePaths > 0, `${fixture}: pulse exists`);
      assert.equal(result.staticPulsePaths, 0, `${fixture}: no static pulse copies`);
      assert.ok(result.pulsePaths <= 10, `${fixture}: pulse capped at 10`);
      if (fixture === "offline") {
        assert.ok(
          result.edges.some((edge) => edge.unavailable),
          "offline fixture: unavailable path",
        );
        // F2：不可用边标签是 —，不是历史 P50。
        const targetEdgeLabel = await page.evaluate(() => {
          const edge = [...document.querySelectorAll("[data-tree-edge-group]")].find(
            (element) => element.getAttribute("data-unavailable") === "true",
          );
          const index = edge?.getAttribute("data-tree-edge-index");
          return (
            document
              .querySelector(`[data-tree-edge-label][data-tree-edge-index="${index}"]`)
              ?.textContent?.trim() ?? null
          );
        });
        assert.ok(
          targetEdgeLabel !== null && targetEdgeLabel.startsWith("—"),
          `offline fixture: unavailable label is —, got ${targetEdgeLabel}`,
        );
      }
      if (fixture === "degraded") {
        assert.ok(
          result.edges.some((edge) => edge.degraded),
          "degraded fixture: degraded path",
        );
        const degradedPulses = await page.evaluate(() => {
          const degradedIndexes = [
            ...document.querySelectorAll('[data-tree-edge-group][data-degraded="true"]'),
          ].map((element) => element.getAttribute("data-tree-edge-index"));
          return degradedIndexes.filter(
            (index) =>
              document.querySelector(
                `[data-tree-pulse][data-tree-edge-index="${index}"]`,
              ) !== null,
          ).length;
        });
        assert.equal(degradedPulses, 0, "degraded path never pulses");
      }
      if (width === 390) {
        assert.ok(
          result.scrollWidth > result.clientWidth,
          "390: chart scrolls horizontally instead of squeezing",
        );
      }
      await shot(page, `${fixture}-${theme}-${width}`, {
        fixture,
        theme,
        width,
        targets: result.targets,
        folds: result.folds,
        edges: result.edgeCount,
        pulsePaths: result.pulsePaths,
        scroll: [result.scrollWidth, result.clientWidth],
      });
      await page.close();
    }
  }
}

// 1b. 390 horizontal scroll end (tooltip + rest of the tree visible).
for (const fixture of ["multi", "fold-multi", "offline"]) {
  const page = await open({ fixture, theme: "dark", width: 390, height: 844 });
  await page.evaluate(() => {
    const scroll = document.querySelector("[data-tree-chart-scroll]");
    if (scroll) scroll.scrollLeft = scroll.scrollWidth;
  });
  await page.waitForTimeout(120);
  const result = await metrics(page);
  await shot(page, `${fixture}-390-dark-end`, {
    scroll: [result.scrollWidth, result.clientWidth],
    targets: result.targets,
  });
  await page.close();
}

// 2. Collapse an intermediate node: +N appears and subtree disappears.
{
  const page = await open({ fixture: "multi", theme: "dark", width: 1440, height: 1000 });
  await page.locator('[data-tree-node][data-node-id="m:2:洛杉矶-01"]').click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  const result = await metrics(page);
  const collapsed = await page
    .locator('[data-tree-node][data-node-id="m:2:洛杉矶-01"]')
    .getAttribute("data-collapsed");
  assert.equal(collapsed, "true", "collapse toggles aria state");
  const hidden = await page
    .locator('[data-tree-node][data-node-id="m:2:洛杉矶-01"]')
    .getAttribute("data-hidden-count");
  assert.ok(Number(hidden) > 0, "collapse exposes hidden count");
  assert.ok(
    (
      await page
        .locator('[data-tree-label][data-node-id="m:2:洛杉矶-01"]')
        .textContent()
    ).includes(`+${hidden}`),
    "collapsed node shows +N",
  );
  assert.ok(result.nodeCount < 20, "subtree nodes are removed");
  // F9：折叠后 aria 里的节点 / 边数用实际可见数，而不是折叠前的总数。
  const aria = await page.evaluate(() => {
    const chart = document.querySelector("[data-tree-chart]");
    return {
      label: document.querySelector("svg[role='group']")?.getAttribute("aria-label") ?? "",
      nodes: chart?.getAttribute("data-node-count") ?? "",
      edges: chart?.getAttribute("data-edge-count") ?? "",
    };
  });
  assert.ok(
    aria.label.includes(`${aria.nodes} 个节点`),
    `aria uses visible node count, got ${aria.label}`,
  );
  assert.ok(
    aria.label.includes(`${aria.edges} 条路径`),
    `aria uses visible edge count, got ${aria.label}`,
  );
  check("collapse-hidden", hidden);
  check("collapse-aria", aria);
  await shot(page, "multi-collapsed-1440-dark", { hidden, visibleNodes: result.nodeCount });
  await page.close();
}

// 3. F1: per-parent folding — each parent keeps its own targets and its own +N.
{
  const page = await open({ fixture: "fold-multi", theme: "dark", width: 1440, height: 1000 });
  const before = await metrics(page);
  const p1Before = before.labels.filter((text) => text.startsWith("10.1.0.")).length;
  const p2Before = before.labels.filter((text) => text.startsWith("10.2.0.")).length;
  assert.equal(p1Before, 8, "p1 keeps 8 targets");
  assert.equal(p2Before, 8, "p2 keeps 8 targets");
  assert.equal(before.folds, 2, "each parent gets its own +N");
  assert.deepEqual(before.foldTexts.sort(), ["+2 个目标", "+2 个目标"]);
  check("fold-multi-before", { p1: p1Before, p2: p2Before, folds: before.folds });
  await shot(page, "fold-multi-collapsed-1440-dark", {
    p1: p1Before,
    p2: p2Before,
    folds: before.folds,
  });

  // 点 p1 的 +N：只展开这一组。
  const foldId = await page.evaluate(() => {
    const rect = [...document.querySelectorAll("[data-tree-node]")].find(
      (element) => element.getAttribute("data-kind") === "fold",
    );
    return rect?.getAttribute("data-node-id") ?? null;
  });
  assert.ok(foldId?.includes("m:1:p1"), `first fold belongs to p1, got ${foldId}`);
  await page.locator(`[data-tree-node][data-node-id="${foldId}"]`).click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(180);
  const expanded = await metrics(page);
  assert.equal(
    expanded.labels.filter((text) => text.startsWith("10.1.0.")).length,
    10,
    "p1 expands to all 10 targets",
  );
  assert.equal(
    expanded.labels.filter((text) => text.startsWith("10.2.0.")).length,
    8,
    "p2 stays folded",
  );
  assert.equal(expanded.folds, 1, "only p2 keeps a +N");
  assert.equal(
    await page.locator("[data-template-targets-collapse]").count(),
    1,
    "collapse-targets button appears",
  );
  await shot(page, "fold-multi-expanded-p1-1440-dark", {
    p1: 10,
    p2: 8,
    folds: expanded.folds,
  });

  await page.locator("[data-template-targets-collapse]").click();
  await page.waitForTimeout(180);
  const restored = await metrics(page);
  assert.equal(restored.folds, 2, "collapse targets restores both +N");
  assert.equal(
    restored.labels.filter((text) => text.startsWith("10.1.0.")).length,
    8,
  );
  check("fold-multi-restored", { folds: restored.folds });
  await page.close();
}

// 4. Hover a leaf: whole path to the root is highlighted (F6).
{
  const page = await open({ fixture: "multi", theme: "dark", width: 1440, height: 1000 });
  await page.locator('[data-tree-node][data-node-id="t:4.4.4.4:2053"]').hover();
  await page.waitForTimeout(120);
  const result = await metrics(page);
  assert.ok(result.haloCount >= 4, `hover highlights path, got ${result.haloCount}`);
  const dimmed = await page.evaluate(
    () => document.querySelector("[data-tree-chart]")?.getAttribute("data-tree-dim"),
  );
  assert.equal(dimmed, "true", "root data-tree-dim drives the dim rule");
  const css = await page.evaluate(
    () => document.querySelector("[data-tree-highlight]")?.textContent ?? "",
  );
  assert.ok(css.includes("data-tree-index"), "generated highlight css present");
  check("hover-node-halos", result.haloCount);
  await shot(page, "multi-hover-path-1440-dark", { halos: result.haloCount });
  await page.close();
}

// 4b. Hover an incoming cross edge's target: cross edge + its source path light up.
{
  const page = await open({ fixture: "multi", theme: "dark", width: 1440, height: 1000 });
  const crossEdges = await page.evaluate(() =>
    [...document.querySelectorAll("[data-tree-edge-group]")]
      .map((element) => ({
        id: element.getAttribute("data-edge-id") ?? "",
        tree: element.getAttribute("data-tree-edge") === "true",
      }))
      .filter((edge) => !edge.tree)
      .map((edge) => edge.id),
  );
  assert.ok(crossEdges.length > 0, "fixture has cross edges");
  // 直接 hover 汇合点（洛杉矶-01），它的 incoming 交叉边应跟着点亮。
  await page.locator('[data-tree-node][data-node-id="m:2:洛杉矶-01"]').hover();
  await page.waitForTimeout(120);
  const hotEdges = await page.evaluate(() => {
    const css = document.querySelector("[data-tree-highlight]")?.textContent ?? "";
    return [...document.querySelectorAll("[data-tree-edge-group]")].map((element) => ({
      id: element.getAttribute("data-edge-id"),
      tree: element.getAttribute("data-tree-edge") === "true",
      hot: css.includes(`[data-tree-edge-group][data-tree-edge-index="${element.getAttribute("data-tree-edge-index")}"]`),
    }));
  });
  assert.ok(
    hotEdges.some((edge) => edge.hot && !edge.tree),
    "incoming cross edge joins the highlight",
  );
  check("cross-edge-hot", hotEdges.filter((edge) => edge.hot && !edge.tree).length);
  await shot(page, "multi-hover-cross-1440-dark", {
    hotCrossEdges: hotEdges.filter((edge) => edge.hot && !edge.tree).length,
  });
  await page.close();
}

// 5. Folded targets: click +N to expand all of that parent's targets.
{
  const page = await open({ fixture: "fold", theme: "dark", width: 1440, height: 1000 });
  await page.locator('[data-tree-node][data-node-id^="t:__fold__"]').click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  const result = await metrics(page);
  assert.equal(result.targets, 12, "expanded targets are all leaves");
  assert.equal(result.folds, 0, "fold marker disappears after expand");
  await shot(page, "fold-expanded-1440-dark", { targets: result.targets });
  await page.close();
}

// 5b. F5: 390 触点首点只选中（显示 tooltip），再点才折叠。
{
  const page = await open({
    fixture: "multi",
    theme: "dark",
    width: 390,
    height: 844,
    hasTouch: true,
    isMobile: true,
  });
  const hoverCapable = await page.evaluate(
    () => matchMedia("(hover: hover)").matches,
  );
  assert.equal(hoverCapable, false, "emulated touch has no hover");
  const node = page.locator('[data-tree-node][data-node-id="m:2:洛杉矶-01"]');
  await node.tap();
  await page.waitForTimeout(180);
  const first = await page.evaluate(() => ({
    collapsed: document
      .querySelector('[data-tree-node][data-node-id="m:2:洛杉矶-01"]')
      ?.getAttribute("data-collapsed"),
    tooltip: document.querySelector("[data-chart-tooltip]")?.textContent ?? "",
  }));
  assert.equal(first.collapsed, "false", "first tap only selects");
  assert.ok(first.tooltip.includes("洛杉矶-01"), "first tap shows the tooltip");
  await shot(page, "tap-first-390-dark", first);
  await node.tap();
  await page.waitForTimeout(180);
  const second = await page.evaluate(() => ({
    collapsed: document
      .querySelector('[data-tree-node][data-node-id="m:2:洛杉矶-01"]')
      ?.getAttribute("data-collapsed"),
    hidden: document
      .querySelector('[data-tree-node][data-node-id="m:2:洛杉矶-01"]')
      ?.getAttribute("data-hidden-count"),
  }));
  assert.equal(second.collapsed, "true", "second tap collapses");
  assert.ok(Number(second.hidden) > 0, "second tap hides the subtree");
  check("tap-two-step", { first, second });
  await shot(page, "tap-second-390-dark", second);
  await page.close();
}

// 6. F2/F7: hover unavailable / degraded edges — tooltip never shows a stale P50
//    as the current value; aria-label carries status + last-known.
{
  const page = await open({ fixture: "offline", theme: "dark", width: 1440, height: 1000 });
  const unavailable = page
    .locator('[data-tree-edge-group][data-unavailable="true"]')
    .first();
  const point = await unavailable.evaluate((hit) => ({
    aria: hit.getAttribute("aria-label") ?? "",
    index: hit.getAttribute("data-tree-edge-index"),
  }));
  assert.ok(point, "unavailable edge hit path");
  assert.ok(point.aria.includes("不可用"), `aria has unavailable, got ${point.aria}`);
  assert.ok(point.aria.includes("最近已知"), `aria has last known, got ${point.aria}`);
  // 用 focus 打开 tooltip：曲线中点不一定在命中路径上，focus 是确定性的。
  await unavailable.focus();
  await page.waitForTimeout(180);
  const tooltip = await page.evaluate((index) => {
    const label = document
      .querySelector(`[data-tree-edge-label][data-tree-edge-index="${index}"]`)
      ?.textContent?.trim();
    const box = document.querySelector("[data-template-tree-edge-tooltip]");
    return { label, text: box?.textContent?.replace(/\s+/g, " ").trim() ?? "" };
  }, point.index);
  assert.ok(tooltip.label?.startsWith("—"), `edge label is —, got ${tooltip.label}`);
  assert.ok(tooltip.text.includes("不可用"), "tooltip says unavailable");
  assert.ok(tooltip.text.includes("最近已知"), "tooltip marks the old value as last known");
  report.checks.push({ name: "unavailable-tooltip", value: tooltip.text });
  await shot(page, "offline-unavailable-tooltip-1440-dark", { tooltip: tooltip.text });
  await page.close();

  const degraded = await open({ fixture: "degraded", theme: "dark", width: 1440, height: 1000 });
  const degradedEdge = degraded
    .locator('[data-tree-edge-group][data-degraded="true"]')
    .first();
  const degradedPoint = await degradedEdge.evaluate((hit) => ({
    aria: hit.getAttribute("aria-label") ?? "",
  }));
  assert.ok(degradedPoint, "degraded edge hit path");
  assert.ok(degradedPoint.aria.includes("降级"), "aria says degraded");
  await degradedEdge.focus();
  await degraded.waitForTimeout(180);
  const degradedTooltip = await degraded.evaluate(
    () =>
      document
        .querySelector("[data-template-tree-edge-tooltip]")
        ?.textContent?.replace(/\s+/g, " ")
        .trim() ?? "",
  );
  assert.ok(degradedTooltip.includes("降级"), "tooltip says degraded");
  assert.ok(degradedTooltip.includes("最近已知"), "degraded value is last known");
  report.checks.push({ name: "degraded-tooltip", value: degradedTooltip });
  await shot(degraded, "degraded-tooltip-1440-dark", { tooltip: degradedTooltip });
  await degraded.close();
}

// 7. F3: tooltip placement — top row flips below, 390 end clamps inside, focus works.
{
  const page = await open({ fixture: "multi", theme: "dark", width: 1440, height: 600 });
  // 顶部节点：选布局里 y 最小的那一个（首行），不是根（根在中间行）。
  const topNodeId = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("[data-tree-node]")];
    nodes.sort(
      (a, b) => Number(a.getAttribute("y")) - Number(b.getAttribute("y")),
    );
    return nodes[0]?.getAttribute("data-node-id") ?? null;
  });
  assert.ok(topNodeId, "top-most node");
  await page.locator(`[data-tree-node][data-node-id="${topNodeId}"]`).hover();
  await page.waitForTimeout(180);
  const top = await geometry(page);
  assert.equal(top.tooltipVisible, true, "tooltip visible");
  assert.ok(top.tooltip.top >= top.scroll.top - 1, "top tooltip is inside the scroll box");
  assert.ok(top.tooltip.bottom <= top.scroll.bottom + 1, "top tooltip not clipped below");
  const topBox = await page
    .locator(`[data-tree-node][data-node-id="${topNodeId}"]`)
    .boundingBox();
  assert.ok(
    top.tooltip.top >= topBox.y + topBox.height - 2,
    "top-row tooltip flips below the anchor",
  );
  check("tooltip-top-row", {
    tooltipTop: Math.round(top.tooltip.top),
    scrollTop: Math.round(top.scroll.top),
  });
  await shot(page, "tooltip-top-row-1440-dark", {
    tooltip: [Math.round(top.tooltip.left), Math.round(top.tooltip.top)],
  });
  await page.close();

  // 390 滚到末端：tooltip 横向夹回可见窗口。
  const narrow = await open({ fixture: "multi", theme: "dark", width: 390, height: 844 });
  await narrow.evaluate(() => {
    const scroll = document.querySelector("[data-tree-chart-scroll]");
    if (scroll) scroll.scrollLeft = scroll.scrollWidth;
  });
  await narrow.waitForTimeout(120);
  const rightmost = await narrow.evaluate(() => {
    const scroll = document.querySelector("[data-tree-chart-scroll]");
    const box = scroll.getBoundingClientRect();
    const candidates = [...document.querySelectorAll("[data-node-id]")]
      .map((element) => ({ id: element.getAttribute("data-node-id"), box: element.getBoundingClientRect() }))
      .filter((item) => item.box.width > 0 && item.box.left >= box.left && item.box.right <= box.right + 1);
    candidates.sort((a, b) => b.box.right - a.box.right);
    return candidates[0]?.id ?? null;
  });
  assert.ok(rightmost, "node near the scroll end");
  await narrow.locator(`[data-tree-node][data-node-id="${rightmost}"]`).hover();
  await narrow.waitForTimeout(180);
  const end = await geometry(narrow);
  assert.equal(end.tooltipVisible, true, "390 end tooltip visible");
  assert.ok(
    end.tooltip.left >= end.scroll.left - 1,
    `tooltip left ${end.tooltip.left} inside ${end.scroll.left}`,
  );
  assert.ok(
    end.tooltip.right <= end.scroll.right + 1,
    `tooltip right ${end.tooltip.right} inside ${end.scroll.right}`,
  );
  assert.ok(end.tooltip.top >= end.scroll.top - 1, "390 end tooltip top inside");
  assert.ok(end.tooltip.bottom <= end.scroll.bottom + 1, "390 end tooltip bottom inside");
  check("tooltip-390-end", {
    tooltip: [Math.round(end.tooltip.left), Math.round(end.tooltip.right)],
    scroll: [Math.round(end.scroll.left), Math.round(end.scroll.right)],
  });
  await shot(narrow, "tooltip-390-end-390-dark", {
    tooltip: [Math.round(end.tooltip.left), Math.round(end.tooltip.right)],
    scroll: [Math.round(end.scroll.left), Math.round(end.scroll.right)],
  });
  await narrow.close();

  // 键盘 focus：同一套定位 + aria-describedby 指向 tooltip。
  const keyboard = await open({ fixture: "multi", theme: "light", width: 1440, height: 900 });
  const focusTarget = keyboard.locator('[data-tree-node][data-node-id="t:1.1.1.1:443"]');
  await focusTarget.focus();
  await keyboard.waitForTimeout(180);
  const focused = await geometry(keyboard);
  assert.equal(focused.tooltipVisible, true, "focus opens the tooltip");
  assert.equal(focused.ariaLive, "polite", "tooltip is a polite live region");
  const describedBy = await focusTarget.getAttribute("aria-describedby");
  assert.equal(describedBy, focused.tooltipId, "trigger is wired to the tooltip");
  assert.ok(focused.tooltip.top >= focused.scroll.top - 1, "focus tooltip inside");
  assert.ok(focused.tooltip.bottom <= focused.scroll.bottom + 1, "focus tooltip inside");
  check("tooltip-focus", { describedBy, ariaLive: focused.ariaLive });
  await shot(keyboard, "tooltip-focus-1440-light", {
    describedBy,
    tooltip: [Math.round(focused.tooltip.left), Math.round(focused.tooltip.top)],
  });
  await keyboard.close();
}

// 8. F4: pulse frames + reduced motion keeps the same path statically visible.
{
  const page = await open({ fixture: "multi", theme: "dark", width: 1440, height: 1000 });
  await page.waitForTimeout(250);
  const first = await shot(page, "multi-pulse-frame-a-1440-dark", {}, { animations: "allow", fullPage: false });
  await page.waitForTimeout(1100);
  const second = await shot(page, "multi-pulse-frame-b-1440-dark", {}, { animations: "allow", fullPage: false });
  assert.notEqual(Buffer.compare(first, second), 0, "pulse frames should differ while animation runs");
  await page.close();

  const reduced = await open({
    fixture: "multi",
    theme: "dark",
    width: 1440,
    height: 1000,
    reducedMotion: "reduce",
  });
  const styles = await reduced.evaluate(() => {
    const pulse = document.querySelector("[data-tree-pulse]");
    const copies = document.querySelectorAll("[data-tree-pulse-static]");
    const style = pulse === null ? null : getComputedStyle(pulse);
    return {
      pulseAnimation: style?.animationName ?? null,
      pulseOpacity: style?.opacity ?? null,
      pulseStrokeOpacity: style?.strokeOpacity ?? null,
      pulseDash: style?.strokeDasharray ?? null,
      staticCopies: copies.length,
      pulsePath: pulse?.getAttribute("d") ?? null,
      visiblePath: document.querySelector("path[data-tree-edge]")?.getAttribute("d") ?? null,
    };
  });
  assert.equal(styles.pulseAnimation, "none", "reduced motion disables the animation");
  assert.equal(styles.staticCopies, 0, "no static duplicate path");
  assert.ok(Number(styles.pulseOpacity) > 0, "same pulse path stays visible");
  assert.ok(
    Math.abs(Number(styles.pulseStrokeOpacity) - 0.42) < 0.01,
    `static pulse keeps 0.42 stroke opacity, got ${styles.pulseStrokeOpacity}`,
  );
  assert.equal(styles.pulseDash, "none", "static stroke is solid, not a short dash");
  check("reduced-motion", styles);
  await shot(reduced, "multi-reduced-motion-1440-dark", styles);
  await reduced.close();
}

// 9. F5: aria carries status / users / unavailable; hit area ≥44; labels truncated.
{
  const page = await open({ fixture: "multi", theme: "dark", width: 1440, height: 1000 });
  const aria = await page.evaluate(() => {
    const member = document.querySelector('[data-tree-node][data-node-id="m:1:东京-01"]');
    const target = document.querySelector('[data-tree-node][data-node-id="t:1.1.1.1:443"]');
    const edge = document.querySelector("[data-tree-edge-group]");
    const hit = document.querySelector("[data-tree-node][data-node-id='t:1.1.1.1:443']");
    const box = hit.getBoundingClientRect();
    return {
      member: member?.getAttribute("aria-label") ?? "",
      target: target?.getAttribute("aria-label") ?? "",
      edge: edge?.getAttribute("aria-label") ?? "",
      hit: { width: Math.round(box.width), height: Math.round(box.height) },
    };
  });
  // 状态文案按四档给出：在线成员 / 未知目标 / 边的用户数。
  assert.ok(aria.member.includes("在线"), `member aria has status, got ${aria.member}`);
  assert.ok(aria.member.includes("用户"), `member aria has users, got ${aria.member}`);
  assert.ok(aria.target.includes("用户"), `target aria has users, got ${aria.target}`);
  assert.ok(aria.edge.includes("用户"), `edge aria has users, got ${aria.edge}`);
  assert.ok(aria.hit.height >= 44, `hit area height ${aria.hit.height}`);
  assert.ok(aria.hit.width >= 44, `hit area width ${aria.hit.width}`);
  check("aria-labels", aria);
  await page.close();

  const longPage = await open({ fixture: "longlabel", theme: "dark", width: 1440, height: 800 });
  const truncated = await longPage.evaluate(() => {
    const labels = [...document.querySelectorAll("[data-tree-label]")].map(
      (element) => element.textContent?.trim() ?? "",
    );
    const node = [...document.querySelectorAll("[data-tree-node]")].find((element) =>
      (element.getAttribute("aria-label") ?? "").includes("a-very-long-target-hostname"),
    );
    const charCount = [...(node?.getAttribute("aria-label") ?? "")];
    return {
      labels,
      aria: node?.getAttribute("aria-label") ?? "",
      longest: labels.reduce((max, text) => Math.max(max, [...text].length), 0),
      ariaLength: charCount.length,
    };
  });
  assert.ok(
    truncated.labels.some((text) => text.endsWith("…")),
    "long label is truncated with …",
  );
  assert.ok(truncated.longest <= 25, `label length <= 25, got ${truncated.longest}`);
  assert.ok(
    truncated.aria.includes("a-very-long-target-hostname.example.com:443"),
    "aria keeps the full name",
  );
  check("long-label", truncated);
  await shot(longPage, "longlabel-1440-dark", truncated);
  await longPage.close();
}

// 10. F9: 0 chains → empty state, no isolated root.
{
  const page = await open({ fixture: "empty", theme: "dark", width: 1440, height: 800 });
  const result = await page.evaluate(() => ({
    emptyState: document.querySelectorAll('[data-slot="empty-state"]').length,
    nodes: document.querySelectorAll("[data-tree-node]").length,
    title: document.querySelector('[data-slot="empty-state"]')?.textContent?.trim() ?? null,
  }));
  assert.equal(result.emptyState, 1, "0-chain topology shows an empty state");
  assert.equal(result.nodes, 0, "no isolated root node");
  assert.ok(result.title?.includes("暂无流量"), `empty title, got ${result.title}`);
  check("empty-topology", result);
  await shot(page, "empty-topology-1440-dark", result);
  await page.close();
}

// 11. English labels on the widest fixture (including the new copy).
{
  const page = await open({ fixture: "fold-multi", theme: "dark", width: 1440, height: 1000, lang: "en" });
  const result = await metrics(page);
  assertLayout(result, "fold-multi/en");
  assert.equal(result.folds, 2);
  assert.deepEqual(result.foldTexts.sort(), ["+2 targets", "+2 targets"]);
  await shot(page, "fold-multi-en-1440-dark", { lang: "en", folds: result.folds });
  await page.close();
}

writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify({ ...report, errors }, null, 2)}\n`,
);
await browser.close();

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`wrote ${report.shots.length} shots and ${report.checks.length} checks to ${HERE}`);
