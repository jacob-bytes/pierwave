// Render the three overview-view prototypes at 1440/390 × light/dark.
// Usage: node web/screenshots/overview-views/shots.mjs
// Playwright is taken from the repo's npx cache; no new project dependency.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const OUT = fileURLToPath(new URL(".", import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEWS = ["server", "cost", "chain"];
const THEMES = ["dark", "light"];
const WIDTHS = [1440, 390];

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = { generatedAt: new Date().toISOString(), shots: [] };
const errors = [];

for (const view of VIEWS) {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      const height = width === 390 ? 844 : 900;
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(`${view}/${theme}/${width}: ${message.text()}`);
      });
      page.on("pageerror", (error) => errors.push(`${view}/${theme}/${width}: ${error.message}`));
      const url = `file://${OUT}${view}.html?theme=${theme}&shot=1`;
      await page.goto(url, { waitUntil: "load" });
      await page.evaluate(() => document.fonts?.ready);
      await page.waitForTimeout(80);
      const metrics = await page.evaluate(() => {
        const doc = document.documentElement;
        const body = document.body;
        const main = document.querySelector(".page");
        return {
          scrollWidth: Math.max(doc.scrollWidth, body.scrollWidth),
          scrollHeight: Math.max(doc.scrollHeight, body.scrollHeight),
          clientWidth: doc.clientWidth,
          pageWidth: main?.getBoundingClientRect().width ?? null,
          pageHeight: main?.getBoundingClientRect().height ?? null,
          tabs: [...document.querySelectorAll(".tab")].map((tab) => ({
            text: tab.textContent.trim(),
            selected: tab.getAttribute("aria-selected"),
          })),
          h1: document.querySelector("h1")?.textContent,
          metricValues: [...document.querySelectorAll(".metric-value")].map((node) => node.textContent.trim()),
          cards: document.querySelectorAll(".card").length,
        };
      });
      const file = `${view}-${theme}-${width}.png`;
      await page.screenshot({ path: `${OUT}${file}`, fullPage: true, animations: "disabled" });
      report.shots.push({ view, theme, width, file, ...metrics, overflowX: metrics.scrollWidth > width + 1 });
      await page.close();
    }
  }
}

await browser.close();
report.errors = errors;
writeFileSync(`${OUT}report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ shots: report.shots.length, errors, report: `${OUT}report.json` }, null, 2));
for (const shot of report.shots) {
  console.log(`${shot.file}  ${shot.scrollWidth}x${shot.scrollHeight}  overflowX=${shot.overflowX}  cards=${shot.cards}  metrics=${shot.metricValues.join(" | ")}`);
}
if (errors.length) process.exitCode = 1;
