// Chain latency acceptance shots: last-hop unmeasurable (realm / native-udp),
// the unknown badge, the old-controller fallback and the degraded contrast.
//
// Prerequisite:
//   cd web && ./node_modules/.bin/vite --port 5199 --strictPort
// Usage:
//   BASE=http://localhost:5199 node web/screenshots/chain-health/shots.mjs
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
const report = { generatedAt: new Date().toISOString(), shots: [], checks: [] };
const errors = [];

function url(fixture, theme, lang = "zh-CN") {
  return `${BASE}/screenshots/chain-health/harness.html?fixture=${fixture}&theme=${theme}&lang=${lang}`;
}

async function open({ fixture, theme, width }) {
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
    const text = (element) => element?.textContent?.trim() ?? "";
    const lastEdge = [...document.querySelectorAll("[data-chain-topology-edge]")].at(-1);
    const lastSegment = [...document.querySelectorAll("[data-chain-segment]")].at(-1);
    const lastLegend = [...document.querySelectorAll("[data-segment-legend-item]")].at(-1);
    const badge = document.querySelector("[data-chain-detail-status] [data-chain-status-badge]");
    const warning = [...document.querySelectorAll("[data-chain-topology-card] p")].find(
      (element) => element.textContent?.includes("最后一跳无历史数据"),
    );
    return {
      badgeText: text(badge),
      badgeState: badge?.getAttribute("data-state") ?? null,
      lastEdgeUnmeasurable:
        lastEdge?.getAttribute("data-unmeasurable") === "true",
      lastEdgeMissing: lastEdge?.getAttribute("data-missing") === "true",
      lastEdgeLatency: text(
        lastEdge?.querySelector("[data-chain-topology-edge-latency]"),
      ),
      lastEdgeReason: text(
        lastEdge?.querySelector('[data-chain-topology-edge-loss][data-kind="unmeasurable-reason"]'),
      ),
      lastEdgeTitle: lastEdge?.getAttribute("title") ?? "",
      lastSegmentUnmeasurable:
        lastSegment?.getAttribute("data-unmeasurable") === "true",
      lastSegmentText: text(
        lastSegment?.querySelector("[data-segment-unmeasurable]"),
      ),
      lastLegendText: text(
        lastLegend?.querySelector("[data-segment-legend-note]"),
      ),
      lastLegendUnmeasurable:
        lastLegend?.getAttribute("data-unmeasurable") === "true",
      missingLastHopVisible: warning !== undefined,
      segmentRows: document.querySelectorAll("[data-chain-segment]").length,
      topologyNodes: document.querySelectorAll("[data-chain-topology-node]").length,
      bodyText: document.body.innerText,
    };
  });
}

async function shot(page, name, meta = {}) {
  const file = `${name}.png`;
  await page.screenshot({
    path: path.join(HERE, file),
    fullPage: true,
    animations: "disabled",
  });
  const bytes = readFileSync(path.join(HERE, file));
  report.shots.push({ name: file, bytes: bytes.length, ...meta });
  return bytes;
}

function check(name, value) {
  report.checks.push({ name, value });
}

const EXPECTED = {
  realm: {
    badge: "未知 · 不可测量",
    state: "unknown",
    reason: "（引擎不支持探测）",
  },
  udp: {
    badge: "未知 · 不可测量",
    state: "unknown",
    reason: "（协议不支持探测）",
  },
  legacy: {
    // 旧契约没有 status / last_hop：回退到样本判定，最后一跳仍是「无历史数据」。
    state: "ok",
    missing: true,
  },
  degraded: {
    badge: "降级 · 东京-02 异常",
    state: "degraded",
  },
};

const fixtures = Object.keys(EXPECTED);

for (const fixture of fixtures) {
  for (const theme of ["dark", "light"]) {
    for (const width of WIDTHS) {
      const page = await open({ fixture, theme, width });
      const result = await metrics(page);
      const expected = EXPECTED[fixture];
      const label = `${fixture}/${theme}/${width}`;

      assert.ok(result.segmentRows > 0, `${label}: segment rows`);
      assert.ok(result.topologyNodes > 0, `${label}: topology nodes`);
      assert.equal(result.badgeState, expected.state, `${label}: badge state`);
      if (expected.badge) {
        assert.equal(result.badgeText, expected.badge, `${label}: badge text`);
      }
      if (expected.reason) {
        assert.equal(result.lastEdgeUnmeasurable, true, `${label}: unmeasurable edge`);
        assert.equal(result.lastEdgeLatency, "不可测量", `${label}: edge label`);
        assert.equal(result.lastEdgeReason, expected.reason, `${label}: reason line`);
        assert.equal(result.lastSegmentUnmeasurable, true, `${label}: segment flag`);
        assert.equal(
          result.lastSegmentText,
          `不可测量${expected.reason}`,
          `${label}: segment wording`,
        );
        assert.equal(result.lastLegendUnmeasurable, true, `${label}: legend flag`);
        assert.equal(
          result.lastLegendText,
          `不可测量${expected.reason}`,
          `${label}: legend wording`,
        );
        assert.equal(
          result.missingLastHopVisible,
          false,
          `${label}: no legacy missing warning`,
        );
        assert.ok(
          !result.bodyText.includes("无历史数据"),
          `${label}: legacy copy must be gone`,
        );
      }
      if (expected.missing) {
        assert.equal(result.lastEdgeUnmeasurable, false, `${label}: legacy edge`);
        assert.equal(result.lastEdgeMissing, true, `${label}: legacy missing edge`);
        assert.equal(result.lastEdgeLatency, "无历史数据", `${label}: legacy label`);
        assert.equal(result.missingLastHopVisible, true, `${label}: legacy warning`);
        assert.equal(result.lastSegmentUnmeasurable, false, `${label}: legacy segment`);
        assert.equal(
          result.lastLegendText,
          "无历史数据",
          `${label}: legacy legend`,
        );
      }

      await shot(page, `${fixture}-${theme}-${width}`, {
        fixture,
        theme: THEME_LABEL[theme],
        width,
        badge: result.badgeText,
        reason: result.lastEdgeReason,
      });
      // 390 默认视口只看得到链的前半段；再补一张滚到末端的图，让最后一跳
      // 的「不可测量 + 原因」完整可见（与 tree-chart 的 `-end` 图同口径）。
      if (width === 390) {
        await page.evaluate(() => {
          const scroller = document.querySelector(
            "[data-chain-topology-scroll]",
          );
          if (scroller) scroller.scrollLeft = scroller.scrollWidth;
        });
        await page.waitForTimeout(60);
        await shot(page, `${fixture}-${theme}-390-end`, {
          fixture,
          theme: THEME_LABEL[theme],
          width,
          scrolledToEnd: true,
        });
      }
      check(`${fixture}/${theme}/${width}`, {
        badge: result.badgeText,
        state: result.badgeState,
        lastEdge: result.lastEdgeLatency,
        reason: result.lastEdgeReason,
        segment: result.lastSegmentText,
        legacyWarning: result.missingLastHopVisible,
      });
      await page.close();
    }
  }
}

// English pass proves the copy is bilingual, not only visually mapped.
for (const width of WIDTHS) {
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    deviceScaleFactor: 1,
  });
  await page.goto(`${url("realm", "dark", "en")}`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(120);
  const result = await metrics(page);
  assert.equal(result.badgeText, "Unknown · Unmeasurable", "en badge");
  assert.equal(result.lastEdgeLatency, "Unmeasurable", "en edge");
  assert.equal(
    result.lastEdgeReason,
    "(engine probing unsupported)",
    "en reason",
  );
  await shot(page, `realm-en-${width}-dark`, {
    fixture: "realm",
    theme: "en dark",
    width,
    badge: result.badgeText,
    reason: result.lastEdgeReason,
  });
  await page.close();
}

assert.deepEqual(errors, [], `console errors: ${errors.join("\n")}`);
writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

await browser.close();
console.log(
  `chain-health shots: ${report.shots.length} images, ${report.checks.length} checks`,
);
