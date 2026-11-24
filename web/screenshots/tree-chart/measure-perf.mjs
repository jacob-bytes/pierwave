// DOM / 脉冲 / hover 写入 / 空闲帧率：同一份 fixture 在「修复前」「修复后」两个
// harness 上跑同一段测量，输出可直接对比的 JSON。
//
// 前置：`cd web && vite --port 5199`（新代码）或旧代码树里的同名 harness。
// 用法：BASE=http://localhost:5199 node web/screenshots/tree-chart/measure-perf.mjs
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://localhost:5199";
const FIXTURE = process.env.FIXTURE ?? "perf";
const LABEL = process.env.LABEL ?? "after";
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

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(
  `${BASE}/screenshots/tree-chart/harness.html?fixture=${FIXTURE}&theme=dark`,
  { waitUntil: "load" },
);
await page.evaluate(() => document.fonts?.ready);
await page.waitForSelector("[data-tree-node]", { timeout: 5000 });
await page.waitForTimeout(250);

/** 图表区域里的元素总数（= 文档中 data-tree-chart 子树）。 */
const dom = await page.evaluate(() => {
  const chart = document.querySelector("[data-tree-chart]");
  return {
    chartElements: chart === null ? 0 : chart.querySelectorAll("*").length,
    nodes: document.querySelectorAll("[data-tree-node]").length,
    edges: document.querySelectorAll("path[data-tree-edge]").length,
    labels: document.querySelectorAll("[data-tree-edge-label]").length,
    pulsePaths: document.querySelectorAll("[data-tree-pulse]").length,
    staticPulsePaths: document.querySelectorAll("[data-tree-pulse-static]").length,
    titles: document.querySelectorAll("[data-tree-chart] title").length,
    nodeCount: chart?.getAttribute("data-node-count") ?? null,
    edgeCount: chart?.getAttribute("data-edge-count") ?? null,
  };
});

/** 空闲帧率：不做任何交互，采 3 秒 rAF 间隔，报帧率 + p95 帧时长。 */
const fps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const stamps = [];
      const start = performance.now();
      const tick = (now) => {
        stamps.push(now);
        if (now - start < 3000) requestAnimationFrame(tick);
        else {
          const deltas = [];
          for (let index = 1; index < stamps.length; index += 1) {
            deltas.push(stamps[index] - stamps[index - 1]);
          }
          deltas.sort((a, b) => a - b);
          const total = stamps[stamps.length - 1] - stamps[0];
          resolve({
            frames: stamps.length,
            fps: Math.round(((stamps.length - 1) / total) * 1000),
            p95FrameMs:
              Math.round(deltas[Math.floor(deltas.length * 0.95)] * 10) / 10,
            longFrames: deltas.filter((value) => value > 20).length,
          });
        }
      };
      requestAnimationFrame(tick);
    }),
);

/** hover 一个中间节点：统计期间图表子树的属性 / 文本 / 子节点写入。 */
const hoverTarget = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll("[data-tree-node]")];
  const node =
    nodes.find((item) => item.getAttribute("data-depth") === "2") ?? nodes[0];
  const rect = node.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
});

await page.evaluate(() => {
  const chart = document.querySelector("[data-tree-chart]");
  window.__writes = { attributes: 0, characterData: 0, childList: 0 };
  window.__observer?.disconnect?.();
  window.__observer = new MutationObserver((records) => {
    for (const record of records) {
      window.__writes[record.type] += 1;
    }
  });
  window.__observer.observe(chart, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
});
await page.mouse.move(hoverTarget.x, hoverTarget.y);
await page.waitForTimeout(200);
const hoverWrites = await page.evaluate(() => {
  window.__observer?.disconnect?.();
  return { ...window.__writes };
});

const result = {
  label: LABEL,
  fixture: FIXTURE,
  base: BASE,
  dom,
  fps,
  hoverWrites,
  hoverTotal:
    hoverWrites.attributes + hoverWrites.characterData + hoverWrites.childList,
};
const out = path.join(HERE, `perf-${LABEL}.json`);
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
await browser.close();
