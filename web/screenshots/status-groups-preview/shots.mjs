#!/usr/bin/env node
/**
 * 公开状态页分组筛选截图 / Public status group-filter screenshots.
 *
 * 用法 / Usage:
 *   node web/screenshots/status-groups-preview/shots.mjs before
 *   node web/screenshots/status-groups-preview/shots.mjs after
 *   node web/screenshots/status-groups-preview/shots.mjs all
 *
 * before/after 会选中一个分组，验证「清除筛选 x / y 台」；all 不筛选，
 * 用来确认 10 个节点（含无数据的一台）全部渲染。
 *
 * 页面来自真实的后端（默认 http://127.0.0.1:8795），数据库是 data/preview.db。
 * 环境变量：BASE_URL、PLAYWRIGHT_MODULE、CHROME_PATH、GROUP_NAME。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8795";
const PHASE = process.argv[2];
const GROUP_NAME = process.env.GROUP_NAME ?? "香港";
const THEMES = ["light", "dark"];
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

if (PHASE !== "before" && PHASE !== "after" && PHASE !== "all") {
  console.error("usage: shots.mjs <before|after|all>");
  process.exit(2);
}
mkdirSync(HERE, { recursive: true });

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) {
    candidates.push(process.env.PLAYWRIGHT_MODULE);
  }
  const local = path.join(
    ROOT,
    ".npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs",
  );
  if (existsSync(local)) candidates.push(local);
  const npxRoot = path.join(ROOT, ".npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(path.join(npxRoot, entry, "node_modules/playwright/index.mjs"));
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
  throw new Error("找不到 playwright，请设置 PLAYWRIGHT_MODULE");
}

const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
].find((candidate) => candidate && existsSync(candidate));

const chromium = await loadPlaywright();
const browser = await chromium.launch({
  headless: true,
  ...(chromePath ? { executablePath: chromePath } : {}),
});

const results = [];

for (const theme of THEMES) {
  for (const { width, height } of WIDTHS) {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
      locale: "zh-CN",
    });
    await page.addInitScript((value) => {
      window.localStorage.setItem("pierwave.theme", value);
    }, theme);
    await page.goto(`${BASE_URL}/status`, { waitUntil: "networkidle" });

    // before/after 选中一个分组，让「清除筛选 x / y 台」出现在工具栏里。
    if (PHASE !== "all") {
      const groupButton = page
        .locator("button")
        .filter({ hasText: GROUP_NAME })
        .first();
      if ((await groupButton.count()) > 0) {
        await groupButton.click();
      }
    }
    await page.waitForTimeout(400);

    const metrics = await page.evaluate(() => {
      const groupRow = document.querySelector('[aria-label*="分组"]');
      const buttons = groupRow
        ? [...groupRow.querySelectorAll("button")].map((button) => ({
            text: button.textContent?.trim() ?? "",
            ariaLabel: button.getAttribute("aria-label"),
            title: button.getAttribute("title"),
          }))
        : [];
      const clear = [...document.querySelectorAll("button")].find((button) =>
        (button.textContent ?? "").includes("清除筛选"),
      );
      const clearRow = clear?.parentElement;
      // 第一张 [data-slot=card] 是 Hero 汇总卡，其余是节点卡片。
      const cards = [...document.querySelectorAll('[data-slot="card"]')].slice(1);
      const bodyText = document.body.textContent ?? "";
      return {
        buttons,
        cardCount: cards.length,
        hasNotReported: bodyText.includes("未上报"),
        clearRowText: clearRow?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        docScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        innerWidth: window.innerWidth,
        pageHeight: document.documentElement.scrollHeight,
      };
    });

    const out = path.join(
      HERE,
      PHASE === "all"
        ? `all-nodes-${theme}-${width}.png`
        : `${PHASE}-group-${theme}-${width}.png`,
    );
    await page.screenshot({ path: out, fullPage: true });
    results.push({ phase: PHASE, theme, width, out, ...metrics });
    await page.close();
  }
}

await browser.close();
writeFileSync(
  path.join(HERE, `${PHASE}-report.json`),
  `${JSON.stringify(results, null, 2)}\n`,
);
for (const result of results) {
  console.log(
    `${result.theme} ${result.width}: overflow=${result.docScrollWidth > result.innerWidth ? result.docScrollWidth - result.innerWidth : 0}px clear="${result.clearRowText}" buttons=${JSON.stringify(result.buttons)}`,
  );
}
