// Tree chart acceptance shots: fixtures × theme × width + interactions.
//
// Prerequisite:
//   cd web && ./node_modules/.bin/vite --port 5199 --strictPort
// Usage:
//   node web/screenshots/tree-chart/shots.mjs
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

async function open({ fixture, theme, width, height, lang, reducedMotion }) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
    reducedMotion,
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
  await page.waitForSelector("[data-tree-node]", { timeout: 5000 });
  await page.waitForTimeout(120);
  return page;
}

async function metrics(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll("[data-tree-node]")];
    const edges = [...document.querySelectorAll("path[data-tree-edge]")].map((element) => ({
      d: element.getAttribute("d") ?? "",
      value: Number(element.closest("[data-tree-edge-group]")?.getAttribute("data-value") ?? 0),
      width: Number(element.closest("[data-tree-edge-group]")?.getAttribute("data-width") ?? 0),
      unavailable:
        element.closest("[data-tree-edge-group]")?.getAttribute("data-unavailable") === "true",
      pulse: element.closest("[data-tree-edge-group]")?.getAttribute("data-pulse") === "true",
    }));
    const byDepth = new Map();
    for (const node of nodes) {
      const depth = Number(node.getAttribute("data-depth"));
      if (byDepth.has(depth)) continue;
      const circle = node.querySelector("circle");
      byDepth.set(depth, Number(circle?.getAttribute("cx") ?? 0));
    }
    const targetLeaves = nodes.filter(
      (node) => node.getAttribute("data-kind") === "target",
    ).length;
    const fold = document.querySelector(
      '[data-tree-label][data-node-id="t:__fold__"]',
    );
    const scroll = document.querySelector("[data-tree-chart-scroll]");
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      edges,
      xByDepth: [...byDepth.entries()].sort((a, b) => a[0] - b[0]),
      targetLeaves,
      foldText: fold?.textContent?.trim() ?? null,
      haloCount: document.querySelectorAll("[data-tree-node-halo]").length,
      scrollWidth: scroll?.scrollWidth ?? 0,
      clientWidth: scroll?.clientWidth ?? 0,
      labels: [...document.querySelectorAll("[data-tree-edge-label]")].map(
        (element) => element.textContent?.trim() ?? "",
      ),
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
    assert.ok(edge.width >= 1 && edge.width <= 6, `${label}: edge width range`);
  }
}

async function shot(page, name, options = {}) {
  const file = `${name}.png`;
  await page.screenshot({
    path: path.join(HERE, file),
    fullPage: options.fullPage ?? true,
    animations: options.animations ?? "disabled",
  });
  const bytes = readFileSync(path.join(HERE, file));
  report.shots.push({ name: file, bytes: bytes.length, ...options.meta });
  return bytes;
}

// 1. Base matrix: 4 fixtures × 2 themes × 2 widths.
const EXPECTED = {
  single: { targets: 3, fold: null },
  multi: { targets: 4, fold: null },
  fold: { targets: 8, fold: "+4 个目标" },
  offline: { targets: 4, fold: null },
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
        result.targetLeaves,
        EXPECTED[fixture].targets,
        `${fixture}: leaf count`,
      );
      if (EXPECTED[fixture].fold !== null) {
        assert.equal(result.foldText, EXPECTED[fixture].fold, "fold label");
      }
      assert.ok(result.pulsePaths > 0, `${fixture}: pulse exists`);
      if (fixture === "offline") {
        assert.ok(
          result.edges.some((edge) => edge.unavailable),
          "offline fixture: unavailable path",
        );
      }
      if (width === 390) {
        assert.ok(
          result.scrollWidth > result.clientWidth,
          "390: chart scrolls horizontally instead of squeezing",
        );
      }
      await shot(page, `${fixture}-${theme}-${width}`, {
        meta: {
          fixture,
          theme,
          width,
          targetLeaves: result.targetLeaves,
          edges: result.edgeCount,
          scroll: [result.scrollWidth, result.clientWidth],
        },
      });
      await page.close();
    }
  }
}

// 1b. 390 horizontal scroll end: show the rest of the tree (fold marker / targets).
for (const fixture of ["multi", "fold", "offline"]) {
  const page = await open({ fixture, theme: "dark", width: 390, height: 844 });
  await page.evaluate(() => {
    const scroll = document.querySelector("[data-tree-chart-scroll]");
    if (scroll) scroll.scrollLeft = scroll.scrollWidth;
  });
  await page.waitForTimeout(120);
  const result = await metrics(page);
  await shot(page, `${fixture}-390-dark-end`, {
    meta: { scroll: [result.scrollWidth, result.clientWidth], targetLeaves: result.targetLeaves },
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
  const collapsed = await page.locator('[data-tree-node][data-node-id="m:2:洛杉矶-01"]').getAttribute("data-collapsed");
  assert.equal(collapsed, "true", "collapse toggles aria state");
  const hidden = await page.locator('[data-tree-node][data-node-id="m:2:洛杉矶-01"]').getAttribute("data-hidden-count");
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
  assert.equal(
    await page.locator('[data-hidden-count]').count() > 0,
    true,
    "plus badge rendered",
  );
  await shot(page, "multi-collapsed-1440-dark", {
    meta: { hidden, visibleNodes: result.nodeCount },
  });
  await page.close();
}

// 3. Hover a leaf: whole path to the root is highlighted.
{
  const page = await open({ fixture: "multi", theme: "dark", width: 1440, height: 1000 });
  await page.locator('[data-tree-node][data-node-id="t:4.4.4.4:2053"]').hover();
  await page.waitForTimeout(80);
  const result = await metrics(page);
  assert.ok(result.haloCount >= 4, `hover highlights path, got ${result.haloCount}`);
  report.checks.push({ name: "hover-node-halos", value: result.haloCount });
  await shot(page, "multi-hover-path-1440-dark", {
    meta: { halos: result.haloCount },
  });
  await page.close();
}

// 4. Hover an edge: both endpoints' paths to the root light up.
{
  const page = await open({ fixture: "multi", theme: "dark", width: 1440, height: 1000 });
  const point = await page.evaluate(() => {
    const group = [...document.querySelectorAll("[data-tree-edge-group]")].find(
      (element) => element.getAttribute("data-value") === "5",
    );
    const edge = group?.querySelector("path[data-tree-edge]");
    if (!edge) return null;
    const at = edge.getPointAtLength(edge.getTotalLength() / 2);
    const matrix = edge.getScreenCTM();
    if (!matrix) return null;
    return {
      x: matrix.a * at.x + matrix.c * at.y + matrix.e,
      y: matrix.b * at.x + matrix.d * at.y + matrix.f,
    };
  });
  assert.ok(point, "edge point");
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(120);
  const result = await metrics(page);
  assert.ok(result.haloCount >= 3, "edge hover highlights endpoints");
  report.checks.push({ name: "hover-edge-halos", value: result.haloCount });
  await shot(page, "multi-hover-edge-1440-dark", {
    meta: { halos: result.haloCount },
  });
  await page.close();
}

// 5. Folded targets: click +N to expand.
{
  const page = await open({ fixture: "fold", theme: "dark", width: 1440, height: 1000 });
  await page.locator('[data-tree-node][data-node-id="t:__fold__"]').click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  const result = await metrics(page);
  assert.equal(result.targetLeaves, 12, "expanded targets are all leaves");
  assert.equal(result.foldText, null, "fold marker disappears after expand");
  await shot(page, "fold-expanded-1440-dark", {
    meta: { targetLeaves: result.targetLeaves },
  });
  await page.close();
}

// 6. Pulse two frames (same viewport, animations enabled); then reduced motion.
{
  const page = await open({ fixture: "multi", theme: "dark", width: 1440, height: 1000 });
  await page.waitForTimeout(250);
  const first = await shot(page, "multi-pulse-frame-a-1440-dark", {
    animations: "allow",
    fullPage: false,
  });
  await page.waitForTimeout(1100);
  const second = await shot(page, "multi-pulse-frame-b-1440-dark", {
    animations: "allow",
    fullPage: false,
  });
  assert.notEqual(
    Buffer.compare(first, second),
    0,
    "pulse frames should differ while animation runs",
  );
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
    const staticPulse = document.querySelector("[data-tree-pulse-static]");
    return {
      pulseAnimation: pulse === null ? null : getComputedStyle(pulse).animationName,
      pulseOpacity: pulse === null ? null : getComputedStyle(pulse).opacity,
      staticOpacity: staticPulse === null ? null : getComputedStyle(staticPulse).opacity,
      halos: document.querySelectorAll("[data-tree-node-halo]").length,
    };
  });
  assert.equal(styles.pulseAnimation, "none", "reduced motion disables pulse animation");
  assert.equal(styles.pulseOpacity, "0", "animated pulse is hidden");
  assert.ok(Number(styles.staticOpacity) > 0, "static highlight remains");
  await shot(reduced, "multi-reduced-motion-1440-dark", {
    meta: { ...styles },
  });
  await reduced.close();
}

// 7. English labels on the widest fixture.
{
  const page = await open({
    fixture: "multi",
    theme: "dark",
    width: 1440,
    height: 1000,
    lang: "en",
  });
  const result = await metrics(page);
  assertLayout(result, "multi/en");
  await shot(page, "multi-en-1440-dark", { meta: { lang: "en" } });
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
console.log(`wrote ${report.shots.length} shots to ${HERE}`);
