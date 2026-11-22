// Real-backend screenshots for the overview insight views.
//
// Usage:
//   cd web && npm run build
//   PIERWAVE_BASE=http://127.0.0.1:8787 \
//   PIERWAVE_ADMIN_PASSWORD=devpass \
//   node web/screenshots/overview-views/real-shots.mjs
//
// The master must already be running and serving web/dist. This script does
// not mock any API: it logs in through the real endpoint and exercises the
// real `/api/v1/overview/server-health` and `/api/v1/settings` responses.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const OUT = fileURLToPath(new URL(".", import.meta.url));
const BASE = process.env.PIERWAVE_BASE ?? "http://127.0.0.1:8787";
const USERNAME = process.env.PIERWAVE_ADMIN_USER ?? "admin";
const PASSWORD = process.env.PIERWAVE_ADMIN_PASSWORD ?? "devpass";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT, { recursive: true });

const SCENARIOS = [
  { id: "real-server-dark-1440", view: null, theme: "dark", width: 1440 },
  { id: "real-server-dark-390", view: "server", theme: "dark", width: 390 },
  { id: "real-server-light-1440", view: "server", theme: "light", width: 1440 },
  { id: "real-server-light-390", view: "server", theme: "light", width: 390 },
  { id: "real-cost-dark-1440", view: "cost", theme: "dark", width: 1440 },
  { id: "real-cost-dark-390", view: "cost", theme: "dark", width: 390 },
  { id: "real-cost-light-1440", view: "cost", theme: "light", width: 1440 },
  { id: "real-cost-light-390", view: "cost", theme: "light", width: 390 },
];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  shots: [],
};
const errors = [];

async function findTarget(page, view) {
  await page.waitForFunction(
    () => document.querySelector("[data-overview-insight-section]") !== null,
    undefined,
    { timeout: 20000 },
  );
  const selector = view === "cost" ? "[data-cost-view]" : "[data-heatmap]";
  await page.waitForFunction(
    (target) =>
      document.querySelector(`[data-overview-insight-section] ${target}`) !==
      null,
    selector,
    { timeout: 20000 },
  );
}

for (const scenario of SCENARIOS) {
  const context = await browser.newContext({
    viewport: { width: scenario.width, height: 900 },
    deviceScaleFactor: 1,
  });
  const login = await context.request.post(`${BASE}/api/v1/auth/login`, {
    data: { username: USERNAME, password: PASSWORD },
  });
  if (!login.ok()) {
    throw new Error(`login failed: ${login.status()} ${await login.text()}`);
  }

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`${scenario.id}: console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`${scenario.id}: pageerror: ${error.message}`);
  });
  await page.addInitScript(
    ({ theme }) => {
      try {
        localStorage.setItem("pierwave.theme", theme);
        localStorage.setItem("pierwave.locale", "zh-CN");
      } catch {
        // ignore storage access errors
      }
    },
    { theme: scenario.theme },
  );

  const url = scenario.view
    ? `${BASE}/?view=${scenario.view}`
    : `${BASE}/`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await findTarget(page, scenario.view === "cost" ? "cost" : "server");
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(300);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const needed = await page.evaluate(() => {
      const main = document.querySelector("#main-content");
      return main ? Math.ceil(main.scrollHeight + 56 + 4) : 900;
    });
    if (needed <= 900) break;
    await page.setViewportSize({ width: scenario.width, height: needed });
    await page.waitForTimeout(80);
  }

  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("#main-content");
    const section = document.querySelector("[data-overview-insight-section]");
    const viewTabs = document.querySelector("[data-overview-view-tabs]");
    const heatmapScroll = document.querySelector("[data-heatmap-scroll]");
    const heatmapCell = document.querySelector("[data-heatmap-cell]");
    const costCalendar = document.querySelector("[data-cost-calendar]");
    const costCell = document.querySelector("[data-cost-cell]");
    const cellRect = heatmapCell?.getBoundingClientRect();
    const costRect = costCell?.getBoundingClientRect();
    const costView = document.querySelector("[data-cost-view]");
    const costText = costView?.innerText ?? "";
    return {
      pageWidth: doc.scrollWidth,
      pageHeight: main?.scrollHeight ?? null,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      overflowX: doc.scrollWidth > window.innerWidth + 1,
      mainOverflowX: main ? main.scrollWidth > main.clientWidth + 1 : false,
      sectionHeight: section?.getBoundingClientRect().height ?? null,
      tabs: viewTabs
        ? [...viewTabs.querySelectorAll('[data-slot="tabs-trigger"]')].map(
            (tab) => ({
              text: tab.textContent?.trim() ?? "",
              selected: tab.getAttribute("aria-selected") === "true",
            }),
          )
        : [],
      metrics: [...document.querySelectorAll("[data-insight-metric]")].map(
        (node) => ({
          label:
            node
              .querySelector("[data-insight-metric-label]")
              ?.textContent?.trim() ?? "",
          value:
            node
              .querySelector("[data-insight-metric-value]")
              ?.textContent?.trim() ?? "",
          hint:
            node
              .querySelector("[data-insight-metric-hint]")
              ?.textContent?.trim() ?? "",
        }),
      ),
      heatmap: heatmapCell
        ? {
            cells: document.querySelectorAll("[data-heatmap-cell]").length,
            cellWidth: cellRect?.width ?? null,
            cellHeight: cellRect?.height ?? null,
            scrollWidth: heatmapScroll?.scrollWidth ?? null,
            clientWidth: heatmapScroll?.clientWidth ?? null,
            scrollable:
              heatmapScroll !== null &&
              heatmapScroll.scrollWidth > heatmapScroll.clientWidth + 1,
          }
        : null,
      cost: costView
        ? {
            cells: document.querySelectorAll("[data-cost-cell]").length,
            cellWidth: costRect?.width ?? null,
            cellHeight: costRect?.height ?? null,
            scrollWidth: costCalendar?.scrollWidth ?? null,
            clientWidth: costCalendar?.clientWidth ?? null,
            scrollable:
              costCalendar !== null
                ? costCalendar.scrollWidth > costCalendar.clientWidth + 1
                : false,
            fxLine:
              costText
                .split("\n")
                .find((line) => line.includes("汇率")) ?? null,
            currentYearLine:
              costText
                .split("\n")
                .find(
                  (line) =>
                    line.includes("本年度剩余") ||
                    line.includes("本年度已无剩余月份"),
                ) ?? null,
            oneTimeLine:
              costText
                .split("\n")
                .find((line) => line.includes("不计入本年度")) ?? null,
          }
        : null,
      hasScrollHint: document.body.innerText.includes("左右滑动"),
      theme: doc.dataset.theme ?? null,
    };
  });

  const file = `app-${scenario.id}.png`;
  await page.screenshot({ path: `${OUT}${file}`, fullPage: true, animations: "disabled" });

  await page.setViewportSize({ width: scenario.width, height: 900 });
  await page.waitForTimeout(60);
  const pageHeightDelta = await page.evaluate(async () => {
    const main = document.querySelector("#main-content");
    const section = document.querySelector("[data-overview-insight-section]");
    if (!main || !section) return null;
    const before = main.scrollHeight;
    section.remove();
    await new Promise((resolvePromise) =>
      requestAnimationFrame(() => resolvePromise(null)),
    );
    return before - main.scrollHeight;
  });

  report.shots.push({ ...scenario, file, ...metrics, pageHeightDelta });
  await context.close();
}

await browser.close();

report.errors = errors;
writeFileSync(`${OUT}real-report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ shots: report.shots.length, errors }, null, 2));
for (const shot of report.shots) {
  console.log(
    [
      shot.file,
      `${shot.pageWidth}x${shot.pageHeight}`,
      `overflowX=${shot.overflowX}`,
      `delta=${shot.pageHeightDelta}`,
      `metrics=${shot.metrics.map((m) => `${m.label}=${m.value}`).join(" | ")}`,
      shot.heatmap
        ? `heatmapCells=${shot.heatmap.cells} cell=${shot.heatmap.cellWidth?.toFixed(1)}x${shot.heatmap.cellHeight?.toFixed(1)} scrollable=${shot.heatmap.scrollable}`
        : "",
      shot.cost
        ? `costCells=${shot.cost.cells} cell=${shot.cost.cellWidth?.toFixed(1)}x${shot.cost.cellHeight?.toFixed(1)} scrollable=${shot.cost.scrollable}`
        : "",
    ]
      .filter(Boolean)
      .join("  "),
  );
}
if (errors.length) process.exitCode = 1;
