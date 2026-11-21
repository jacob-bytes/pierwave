#!/usr/bin/env node
/**
 * 两套卡内布局原型的截图与几何测量。
 *
 * 用法 / Usage:
 *   node web/screenshots/detail-polish/render.mjs
 *
 * 直接打开本地 file://（不启动服务、不发网络请求），产出
 * p1-* / p2-* PNG、annotated-* PNG 与 prototypes.json。
 */
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const THEMES = ["dark", "light"];
const STATES = ["healthy", "incident"];
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];
const VARIANTS = [
  { id: "p1", file: "concept-1.html", label: "方案 1 · 指标栅格" },
  { id: "p2", file: "concept-2.html", label: "方案 2 · 主次分栏" },
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
  try {
    const mod = await import("playwright");
    if (mod.chromium) return mod.chromium;
  } catch {
    /* fall through */
  }
  throw new Error("找不到 playwright / playwright not found");
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

const results = [];

for (const variant of VARIANTS) {
  for (const state of STATES) {
    for (const theme of THEMES) {
      for (const { width, height } of WIDTHS) {
        const label = `${variant.id}-${state}-${theme}-${width}`;
        const page = await browser.newPage({
          viewport: { width, height },
          deviceScaleFactor: 1,
        });
        page.on("pageerror", (error) =>
          console.error(`pageerror ${label}: ${error.message}`),
        );
        const url = `${pathToFileURL(path.join(HERE, variant.file)).href}?state=${state}&theme=${theme}`;
        await page.goto(url, { waitUntil: "load" });
        await page.waitForSelector("[data-card]");
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );

        const metrics = await page.evaluate(() => {
          const round = (value) => Math.round(value * 100) / 100;
          const rect = (element) => {
            if (!element) return null;
            const box = element.getBoundingClientRect();
            return {
              x: round(box.x),
              y: round(box.y),
              width: round(box.width),
              height: round(box.height),
              right: round(box.right),
              bottom: round(box.bottom),
            };
          };
          const text = (element) =>
            element?.innerText.replace(/\s+/g, " ").trim() ?? null;
          const cards = {};
          for (const card of document.querySelectorAll("[data-card]")) {
            const box = rect(card);
            const css = getComputedStyle(card);
            const padding = {
              top: Number.parseFloat(css.paddingTop),
              right: Number.parseFloat(css.paddingRight),
              bottom: Number.parseFloat(css.paddingBottom),
              left: Number.parseFloat(css.paddingLeft),
            };
            const blocks = [...card.children]
              .filter((element) => element.getBoundingClientRect().height > 0)
              .map((element) => ({
                className: element.className?.toString().slice(0, 100) ?? "",
                text: text(element)?.slice(0, 90) ?? null,
                ...rect(element),
              }));
            const leaves = [];
            for (const element of card.querySelectorAll("*")) {
              if (element.children.length > 0) continue;
              const value = element.textContent?.replace(/\s+/g, " ").trim();
              const leafBox = element.getBoundingClientRect();
              if (!value || leafBox.width <= 1 || leafBox.height <= 1) continue;
              const leafCss = getComputedStyle(element);
              leaves.push({
                text: value,
                fontSize: leafCss.fontSize,
                fontWeight: leafCss.fontWeight,
                color: leafCss.color,
                fontVariantNumeric: leafCss.fontVariantNumeric,
                ...rect(element),
                clipped: element.scrollWidth > element.clientWidth + 1,
              });
            }
            const gaps = blocks.slice(1).map((block, index) =>
              round(block.y - blocks[index].bottom),
            );
            const last = blocks[blocks.length - 1];
            cards[card.dataset.card] = {
              box,
              padding,
              blocks,
              leaves,
              gaps,
              bigGaps: gaps.filter((gap) => gap > 24),
              blankAfterLastBlock: last
                ? round(box.bottom - padding.bottom - last.bottom)
                : null,
              numericTokens: leaves
                .filter(
                  (leaf) =>
                    !leaf.text.startsWith("更新于") &&
                    !leaf.text.startsWith("数据每") &&
                    !leaf.text.startsWith("最后上报"),
                )
                .reduce(
                  (sum, leaf) => sum + (leaf.text.match(/\d+(?:[.,]\d+)?/g)?.length ?? 0),
                  0,
                ),
              fontSizeSet: [...new Set(leaves.map((leaf) => leaf.fontSize))].sort(
                (a, b) => Number.parseFloat(a) - Number.parseFloat(b),
              ),
            };
          }
          const grid = document.querySelector(".grid");
          const footer = document.querySelector(".pagefoot");
          const main = document.querySelector("main");
          return {
            pageHeight: Math.ceil(main.getBoundingClientRect().bottom + window.scrollY),
            scrollHeight: document.documentElement.scrollHeight,
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            grid: rect(grid),
            gridGap: grid ? getComputedStyle(grid).gap : null,
            cards,
          };
        });

        await page.setViewportSize({
          width,
          height: Math.max(320, metrics.pageHeight),
        });
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        const out = path.join(HERE, `${label}.png`);
        await page.screenshot({ path: out, fullPage: true, animations: "disabled" });

        if (theme === "dark") {
          await page.evaluate((variantLabel) => {
            const style = document.createElement("style");
            style.textContent = `
              .audit-outline { position: absolute; pointer-events: none; z-index: 20;
                border: 1px dashed color-mix(in oklab, var(--primary) 55%, transparent); border-radius: 13px; }
              .audit-tag { position: absolute; z-index: 21; padding: 2px 6px; border-radius: 5px;
                background: var(--primary); color: var(--primary-foreground);
                font: 600 10px/1.4 "Geist Variable", sans-serif; white-space: nowrap; }
              .audit-tag.alt { background: var(--card); color: var(--foreground);
                border: 1px solid var(--border-strong); }
              .audit-root { position: absolute; inset: 0; pointer-events: none; }
            `;
            document.head.append(style);
            const root = document.createElement("div");
            root.className = "audit-root";
            document.body.append(root);
            const titles = { overview: "①", availability: "②", runtime: "③", billing: "④" };
            for (const card of document.querySelectorAll("[data-card]")) {
              const box = card.getBoundingClientRect();
              const scrollY = window.scrollY;
              const outline = document.createElement("div");
              outline.className = "audit-outline";
              outline.style.left = `${box.left + scrollX}px`;
              outline.style.top = `${box.top + scrollY}px`;
              outline.style.width = `${box.width}px`;
              outline.style.height = `${box.height}px`;
              root.append(outline);
              const tag = document.createElement("div");
              tag.className = "audit-tag";
              tag.textContent = `${titles[card.dataset.card]} ${Math.round(box.height)}px`;
              tag.style.left = `${box.left + scrollX + 8}px`;
              tag.style.top = `${box.top + scrollY - 9}px`;
              root.append(tag);
              const count = document.createElement("div");
              count.className = "audit-tag alt";
              count.textContent = variantLabel;
              count.style.right = `${document.documentElement.clientWidth - box.right + scrollX + 8}px`;
              count.style.top = `${box.top + scrollY - 9}px`;
              root.append(count);
            }
          }, variant.label);
          await page.screenshot({
            path: path.join(HERE, `annotated-${label}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }

        results.push({
          variant: variant.id,
          variantLabel: variant.label,
          state,
          theme,
          width,
          file: path.basename(out),
          kb: Math.round(statSync(out).size / 1024),
          metrics,
        });
        console.log(
          `ok  ${label}.png  page=${metrics.pageHeight}px  cards=${Object.values(
            metrics.cards,
          )
            .map((card) => Math.round(card.box.height))
            .join("/")}`,
        );
        await page.close();
      }
    }
  }
}

writeFileSync(
  path.join(HERE, "prototypes.json"),
  `${JSON.stringify({ results }, null, 2)}\n`,
);
await browser.close();
console.log(`\nwrote prototypes.json (${results.length} jobs)`);
