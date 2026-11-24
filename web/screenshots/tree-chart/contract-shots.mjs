// Chain-template contract shots: stale notice, unused candidates and the
// legacy contract (no new fields) at 1440 / 390 in both themes.
//
// Prerequisite:
//   cd web && ./node_modules/.bin/vite --port 5199 --strictPort
// Usage:
//   BASE=http://localhost:5199 node web/screenshots/tree-chart/contract-shots.mjs
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
const report = { generatedAt: new Date().toISOString(), shots: [], checks: [] };
const errors = [];

function url(fixture, theme) {
  return `${BASE}/screenshots/tree-chart/harness.html?fixture=${fixture}&theme=${theme}`;
}

async function open(fixture, theme, width) {
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    deviceScaleFactor: 1,
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`${fixture}/${theme}/${width}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`${fixture}/${theme}/${width}: ${error.message}`);
  });
  await page.goto(url(fixture, theme), { waitUntil: "load" });
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(120);
  return page;
}

async function metrics(page) {
  return page.evaluate(() => {
    const stale = document.querySelector("[data-template-stale]");
    const unused = [...document.querySelectorAll("[data-template-unused-member]")];
    return {
      staleText: stale?.textContent?.trim() ?? null,
      staleTitle: stale?.getAttribute("title") ?? null,
      unusedCount: unused.length,
      unusedNames: unused.map((item) => item.textContent?.trim() ?? ""),
      unusedStatuses: unused.map((item) => item.getAttribute("data-status")),
      treeNodes: document.querySelectorAll("[data-tree-node]").length,
    };
  });
}

async function shot(page, name, meta) {
  const file = `${name}.png`;
  await page.screenshot({
    path: path.join(HERE, file),
    fullPage: true,
    animations: "disabled",
  });
  report.shots.push({
    name: file,
    bytes: readFileSync(path.join(HERE, file)).length,
    ...meta,
  });
}

function check(name, value) {
  report.checks.push({ name, value });
}

for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    // stale: the notice is one line; the reason lives in the title.
    const stalePage = await open("stale", theme, width);
    const stale = await metrics(stalePage);
    assert.ok(stale.staleText, "stale: notice");
    assert.equal(
      stale.staleText,
      "模板已修改，以下按现有链的实际路径展示",
      "stale: copy",
    );
    assert.match(stale.staleTitle ?? "", /链的跳数（2）与模板（3）不一致/);
    assert.match(stale.staleTitle ?? "", /chain hop count \(2\) differs/);
    // stale fixture also carries one unused candidate.
    assert.equal(stale.unusedCount, 1, "stale: unused row");
    assert.equal(stale.unusedNames[0], "大阪-01");
    await shot(stalePage, `stale-${theme}-${width}`, {
      fixture: "stale",
      theme,
      width,
      stale: stale.staleText,
      unused: stale.unusedCount,
    });
    check(`stale/${theme}/${width}`, {
      text: stale.staleText,
      title: stale.staleTitle,
      unused: stale.unusedNames,
    });
    await stalePage.close();

    // unused: candidates only come from unused_candidates, with their status.
    const unusedPage = await open("unused", theme, width);
    const unused = await metrics(unusedPage);
    assert.equal(unused.staleText, null, "unused: no stale notice");
    assert.equal(unused.unusedCount, 2, "unused: rows");
    // 状态用 sr-only 文本补充颜色，textContent 会带上「离线 / 降级」前缀。
    assert.ok(unused.unusedNames[0].includes("东京-03"), "unused: 东京-03");
    assert.ok(unused.unusedNames[1].includes("东京-04"), "unused: 东京-04");
    assert.deepEqual(unused.unusedStatuses, ["offline", "degraded"]);
    await shot(unusedPage, `unused-${theme}-${width}`, {
      fixture: "unused",
      theme,
      width,
      unused: unused.unusedNames,
    });
    check(`unused/${theme}/${width}`, {
      names: unused.unusedNames,
      statuses: unused.unusedStatuses,
    });
    await unusedPage.close();

    // legacy: no new fields → no notice, no unused panel, topology still draws.
    const legacyPage = await open("multi", theme, width);
    const legacy = await metrics(legacyPage);
    assert.equal(legacy.staleText, null, "legacy: no stale notice");
    assert.equal(legacy.unusedCount, 0, "legacy: no unused panel");
    assert.ok(legacy.treeNodes > 0, "legacy: topology renders");
    await shot(legacyPage, `legacy-${theme}-${width}`, {
      fixture: "multi",
      theme,
      width,
      treeNodes: legacy.treeNodes,
    });
    check(`legacy/${theme}/${width}`, {
      stale: legacy.staleText,
      unused: legacy.unusedCount,
      treeNodes: legacy.treeNodes,
    });
    await legacyPage.close();
  }
}

assert.deepEqual(errors, [], `console errors: ${errors.join("\n")}`);
writeFileSync(
  path.join(HERE, "contract-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

await browser.close();
console.log(
  `contract shots: ${report.shots.length} images, ${report.checks.length} checks`,
);
