#!/usr/bin/env node
/**
 * 现状标注图：在真实页面上叠卡片高度与关键几何。
 * Annotated current-state screenshots: card heights + key geometry.
 *
 * 用法 / Usage:
 *   node web/screenshots/detail-polish/annotate-current.mjs
 *
 * 依赖已运行的 `vite preview`（默认 http://localhost:4173）。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detailFixture } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4173";
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

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
      /* next */
    }
  }
  const mod = await import("playwright");
  return mod.chromium;
}

function chromePath() {
  return [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]
    .filter(Boolean)
    .find((candidate) => existsSync(candidate));
}

const chromium = await loadPlaywright();
const executablePath = chromePath();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

for (const { width, height } of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript(() => {
    window.localStorage.setItem("pierwave.theme", "dark");
    window.localStorage.setItem("pierwave.locale", "zh-CN");
  });
  await page.route("**/api/**", async (route) => {
    if (!route.request().url().includes("/api/v1/public/status")) {
      await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detailFixture("healthy")),
    });
  });
  await page.goto(`${BASE_URL}/status/srv-hk`, { waitUntil: "load" });
  await page.waitForSelector('[data-slot="detail-overview"]');
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

  await page.evaluate((compact) => {
    const style = document.createElement("style");
    style.textContent = `
      .audit-outline { position: absolute; pointer-events: none; z-index: 20;
        border: 1px dashed color-mix(in oklab, var(--primary) 55%, transparent); border-radius: 13px; }
      .audit-tag { position: absolute; z-index: 21; padding: 2px 6px; border-radius: 5px;
        background: var(--primary); color: var(--primary-foreground);
        font: 600 10px/1.4 "Geist Variable", sans-serif; white-space: nowrap; }
      .audit-root { position: absolute; inset: 0; pointer-events: none; }
    `;
    document.head.append(style);
    const root = document.createElement("div");
    root.className = "audit-root";
    document.body.append(root);
    const notes = compact
      ? {
          "detail-overview": "① 425px · 速率列多 14px",
          "detail-availability": "② 276px · 行中空 41–77%",
          "detail-runtime": "③ 322px · 环 tile 空宽 39%",
          "detail-billing": "④ 217px · 已隐藏 4 值",
        }
      : {
          "detail-overview": "① 472px · 图表占 54%",
          "detail-availability": "② 472px · 行中空白 71–92%",
          "detail-runtime": "③ 330px · 每个环 tile 空宽 88px",
          "detail-billing": "④ 330px · 嵌套盒垂直空白 63% / 71%",
        };
    for (const [slot, note] of Object.entries(notes)) {
      const card = document.querySelector(`[data-slot="${slot}"]`);
      if (!card) continue;
      const box = card.getBoundingClientRect();
      const outline = document.createElement("div");
      outline.className = "audit-outline";
      outline.style.left = `${box.left + window.scrollX}px`;
      outline.style.top = `${box.top + window.scrollY}px`;
      outline.style.width = `${box.width}px`;
      outline.style.height = `${box.height}px`;
      root.append(outline);
      const tag = document.createElement("div");
      tag.className = "audit-tag";
      tag.textContent = note;
      tag.style.left = `${box.left + window.scrollX + 8}px`;
      tag.style.top = `${box.top + window.scrollY - 9}px`;
      root.append(tag);
    }
  }, width === 390);

  await page.screenshot({
    path: path.join(HERE, `annotated-current-healthy-dark-${width}.png`),
    fullPage: true,
    animations: "disabled",
  });
  console.log(`ok annotated-current-healthy-dark-${width}.png`);
  await page.close();
}

await browser.close();
