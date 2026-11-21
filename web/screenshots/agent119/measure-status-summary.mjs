// Availability conclusion on /status/:id: healthy / incident / no samples.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";
import { detailFixture } from "../status-detail/fixtures.mjs";

const BASE = process.env.BASE ?? "http://localhost:5173";
const OUT = "web/screenshots/agent119";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {};

for (const state of ["healthy", "incident", "nodata"]) {
  const fixture = detailFixture(state);
  // 详情页优先使用精确分钟；fixture 补上后端已有的 outage_minutes_24h。
  const target = fixture.servers[0];
  fixture.servers[0] = {
    ...target,
    outage_minutes_24h:
      state === "incident" ? 192 : state === "healthy" ? 0 : null,
  };
  for (const theme of ["light", "dark"]) {
    for (const { width, height } of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
        colorScheme: theme,
      });
      await context.addInitScript(
        ({ theme }) => {
          localStorage.setItem("pierwave.theme", theme);
          localStorage.setItem("pierwave.locale", "zh-CN");
        },
        { theme },
      );
      await context.route("**/api/**", async (route) => {
        const url = route.request().url();
        if (url.includes("/api/v1/public/status/srv-hk")) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              server: fixture.servers[0],
              series_24h: fixture.series_24h ?? null,
            }),
          });
          return;
        }
        if (url.includes("/api/v1/public/status")) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(fixture),
          });
          return;
        }
        await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      });
      const page = await context.newPage();
      await page.goto(`${BASE}/status/srv-hk`, { waitUntil: "networkidle" });
      await page.locator('[data-slot="detail-availability"]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      const metrics = await page.evaluate(() => {
        const round = (v) => Math.round(v * 100) / 100;
        const card = document.querySelector('[data-slot="detail-availability"]');
        const summary = document.querySelector('[data-slot="availability-summary"]');
        const main = document.querySelector("main");
        const overview = document.querySelector('[data-slot="detail-overview"]');
        const grid = document.querySelector('[data-slot="detail-metric-grid"]');
        const boxes = [...main.querySelectorAll('[data-slot^="detail-"]')]
          .filter((el) => ["detail-overview", "detail-availability", "detail-runtime", "detail-billing"].includes(el.dataset.slot))
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { slot: el.dataset.slot, x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
          });
        const summaryRect = summary?.getBoundingClientRect();
        const gridRect = grid?.getBoundingClientRect();
        return {
          summary: summary?.textContent?.replace(/\s+/g, " ").trim() ?? null,
          summaryY: summaryRect ? round(summaryRect.y) : null,
          summaryFont: summary ? getComputedStyle(summary).fontSize : null,
          summaryHeight: summaryRect ? round(summaryRect.height) : null,
          gridY: gridRect ? round(gridRect.y) : null,
          cardHeight: card ? round(card.getBoundingClientRect().height) : null,
          overviewHeight: overview ? round(overview.getBoundingClientRect().height) : null,
          boxes,
          pageHeight: document.documentElement.scrollHeight,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        };
      });
      const file = `${OUT}/status-summary-${state}-${theme}-${width}.png`;
      await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
      console.log(state, theme, width, JSON.stringify(metrics));
      console.log(`saved ${file}`);
      report[`${state}-${theme}-${width}`] = { ...metrics, file };
      await context.close();
    }
  }
}

await browser.close();
writeFileSync(`${OUT}/status-summary-report.json`, JSON.stringify(report, null, 2));
