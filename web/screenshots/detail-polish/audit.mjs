#!/usr/bin/env node
/**
 * 现状审计 / Current-state audit.
 *
 * 对真实的 `/status/:id`（vite preview + 拦截公开状态接口）在
 * 1440/390 × 亮/暗 × 健康/事故 下测量每张卡内部的几何：
 * 卡内列宽、行高、左右边缘、字号/字重/颜色、分隔线、空白、曲线与环形图。
 *
 * 用法 / Usage:
 *   node web/screenshots/detail-polish/audit.mjs
 *   BASE_URL=http://localhost:4173 node ...
 *
 * 只读：不写产品代码，只写本目录的 PNG / report.json。
 */
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detailFixture } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4173";
const THEMES = ["dark", "light"];
const STATES = ["healthy", "incident"];
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];
const TARGET_ID = "srv-hk";

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

for (const state of STATES) {
  for (const theme of THEMES) {
    for (const { width, height } of WIDTHS) {
      const label = `${state}-${theme}-${width}`;
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      page.on("pageerror", (error) =>
        console.error(`pageerror ${label}: ${error.message}`),
      );
      await page.addInitScript(
        ({ theme }) => {
          window.localStorage.setItem("pierwave.theme", theme);
          window.localStorage.setItem("pierwave.locale", "zh-CN");
        },
        { theme },
      );
      await page.route("**/api/**", async (route) => {
        if (!route.request().url().includes("/api/v1/public/status")) {
          await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(detailFixture(state)),
        });
      });
      await page.goto(`${BASE_URL}/status/${TARGET_ID}`, { waitUntil: "load" });
      await page.waitForSelector('[data-slot="detail-overview"]', { timeout: 15_000 });
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
        const styleOf = (element) => {
          if (!element) return null;
          const css = getComputedStyle(element);
          return {
            fontSize: css.fontSize,
            fontWeight: css.fontWeight,
            lineHeight: css.lineHeight,
            letterSpacing: css.letterSpacing,
            color: css.color,
            fontVariantNumeric: css.fontVariantNumeric,
            textAlign: css.textAlign,
            padding: [css.paddingTop, css.paddingRight, css.paddingBottom, css.paddingLeft],
            borderTopWidth: css.borderTopWidth,
            borderBottomWidth: css.borderBottomWidth,
            gap: css.gap,
          };
        };
        const cardSlots = {
          overview: "detail-overview",
          availability: "detail-availability",
          runtime: "detail-runtime",
          billing: "detail-billing",
        };
        const cards = {};
        for (const [key, slot] of Object.entries(cardSlots)) {
          const card = document.querySelector(`[data-slot="${slot}"]`);
          if (!card) continue;
          const cardRect = card.getBoundingClientRect();
          const css = getComputedStyle(card);
          const padding = {
            top: Number.parseFloat(css.paddingTop),
            right: Number.parseFloat(css.paddingRight),
            bottom: Number.parseFloat(css.paddingBottom),
            left: Number.parseFloat(css.paddingLeft),
          };
          const inner = {
            left: round(cardRect.left + padding.left),
            right: round(cardRect.right - padding.right),
            width: round(cardRect.width - padding.left - padding.right),
          };
          const blocks = [...card.children]
            .filter((element) => element.getBoundingClientRect().height > 0)
            .map((element) => ({
              slot: element.dataset.slot ?? null,
              tag: element.tagName.toLowerCase(),
              className: element.className?.toString().slice(0, 140) ?? "",
              text: text(element)?.slice(0, 120) ?? null,
              ...rect(element),
              ...styleOf(element),
            }));
          const leaves = [];
          for (const element of card.querySelectorAll("*")) {
            if (element.children.length > 0) continue;
            const value = element.textContent?.replace(/\s+/g, " ").trim();
            const box = element.getBoundingClientRect();
            if (!value || box.width <= 0 || box.height <= 0) continue;
            const leafStyle = styleOf(element);
            leaves.push({
              tag: element.tagName.toLowerCase(),
              text: value,
              slot: element.closest("[data-slot]")?.dataset.slot ?? null,
              stat: element.closest("[data-stat]")?.dataset.stat ?? null,
              detail: element.closest("[data-detail]")?.dataset.detail ?? null,
              ...rect(element),
              ...leafStyle,
              clipped: element.scrollWidth > element.clientWidth + 1,
            });
          }
          const rows = [];
          for (const item of card.querySelectorAll(
            '[data-slot="availability-detail"]',
          )) {
            const dt = item.querySelector("dt");
            const dd = item.querySelector("dd");
            const itemRect = item.getBoundingClientRect();
            const dtRect = dt?.getBoundingClientRect();
            const ddRect = dd?.getBoundingClientRect();
            rows.push({
              detail: item.dataset.detail,
              height: round(itemRect.height),
              paddingTop: getComputedStyle(item).paddingTop,
              paddingBottom: getComputedStyle(item).paddingBottom,
              hidden: itemRect.height === 0,
              label: text(dt),
              labelBox: dtRect ? rect(dt) : null,
              value: text(dd),
              valueBox: ddRect ? rect(dd) : null,
              middleGap:
                dtRect && ddRect ? round(ddRect.left - dtRect.right) : null,
              middleShare:
                dtRect && ddRect && inner.width > 0
                  ? round(((ddRect.left - dtRect.right) / inner.width) * 100)
                  : null,
              labelStyle: styleOf(dt),
              valueStyle: styleOf(dd),
            });
          }
          const stats = [];
          for (const item of card.querySelectorAll('[data-slot="detail-stat"]')) {
            const labelEl = item.querySelector("div");
            const valueEl = labelEl?.nextElementSibling;
            stats.push({
              stat: item.dataset.stat,
              label: text(labelEl),
              value: text(valueEl),
              box: rect(item),
              labelBox: rect(labelEl),
              valueBox: rect(valueEl),
              labelStyle: styleOf(labelEl),
              valueStyle: styleOf(valueEl),
            });
          }
          const rings = [...card.querySelectorAll('[role="img"]')].map((ring) => ({
            aria: ring.getAttribute("aria-label"),
            box: rect(ring),
            wrapper: rect(ring.parentElement),
            wrapperStyle: styleOf(ring.parentElement),
            inner: [...ring.querySelectorAll("strong, span")].map((el) => ({
              text: text(el),
              box: rect(el),
              ...styleOf(el),
            })),
          }));
          const sections = [...card.querySelectorAll("section")].map((section) => ({
            box: rect(section),
            text: text(section)?.slice(0, 120) ?? null,
            style: styleOf(section),
          }));
          const chart = card.querySelector('[data-slot="detail-chart"]');
          let chartInfo = null;
          if (chart) {
            const plot = chart.querySelector('[data-slot="availability-plot"]');
            const yAxis = plot?.previousElementSibling;
            const tickRow = plot?.nextElementSibling;
            const legend = chart.querySelector("div.mt-3.flex.flex-wrap");
            const title = chart.querySelector("h2");
            chartInfo = {
              box: rect(chart),
              title: title ? { text: text(title), box: rect(title), ...styleOf(title) } : null,
              plot: rect(plot),
              yAxis: rect(yAxis),
              tickRow: rect(tickRow),
              legend: rect(legend),
              legendStyle: styleOf(legend),
              plotMinHeight: plot ? getComputedStyle(plot).minHeight : null,
            };
          }
          cards[key] = {
            box: rect(card),
            padding,
            inner,
            gap: css.gap,
            blocks,
            leaves,
            rows,
            stats,
            rings,
            sections,
            chart: chartInfo,
            blankAfterLastBlock: (() => {
              const last = blocks[blocks.length - 1];
              return last ? round(cardRect.bottom - padding.bottom - last.bottom) : null;
            })(),
            gapsBetweenBlocks: blocks.slice(1).map((block, index) =>
              round(block.y - blocks[index].bottom),
            ),
            separatorCount: [...card.querySelectorAll("*")].filter((el) => {
              const s = getComputedStyle(el);
              return (
                (Number.parseFloat(s.borderTopWidth) > 0 ||
                  Number.parseFloat(s.borderBottomWidth) > 0) &&
                el.getBoundingClientRect().height > 0
              );
            }).length,
          };
        }
        const main = document.querySelector("main");
        const grid = main.querySelector('[data-slot="detail-grid"]');
        const footer = main.querySelector('[data-slot="detail-footer"]');
        return {
          scrollHeight: document.documentElement.scrollHeight,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          main: rect(main),
          grid: rect(grid),
          gridGap: grid ? getComputedStyle(grid).gap : null,
          footer: rect(footer),
          cardOrder: Object.fromEntries(
            Object.entries(cards).map(([key, card]) => [key, card.box]),
          ),
          cards,
        };
      });

      const out = path.join(HERE, `current-${label}.png`);
      await page.screenshot({ path: out, fullPage: true, animations: "disabled" });
      results.push({
        state,
        theme,
        width,
        file: path.basename(out),
        kb: Math.round(statSync(out).size / 1024),
        metrics,
      });
      console.log(`ok  current-${label}.png  page=${metrics.scrollHeight}px`);
      await page.close();
    }
  }
}

writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify({ baseUrl: BASE_URL, results }, null, 2)}\n`,
);
await browser.close();
console.log(`\nwrote report.json (${results.length} jobs)`);
