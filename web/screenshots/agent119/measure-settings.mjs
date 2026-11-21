// Settings general tab geometry + screenshots (before/after).
// Usage: node web/screenshots/agent119/measure-settings.mjs <label>
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.env.BASE ?? "http://localhost:5173";
const OUT = "web/screenshots/agent119";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const label = process.argv[2] ?? "before";
mkdirSync(OUT, { recursive: true });

const NOW = Math.floor(Date.now() / 1000);
const UPDATES = {
  master: {
    current: "0.16.1",
    latest: "0.16.1",
    update_available: false,
    release_url: "https://github.com/jacob-bytes/pierwave/releases/tag/v0.16.1",
    released_at: NOW - 3 * 86400,
    checked_at: NOW - 5 * 60,
    error: null,
  },
  agents: {
    current_protocol: 25,
    min_supported: 16,
    versions: [
      { version: "0.16.1", count: 3 },
      { version: "0.15.0", count: 1 },
    ],
  },
};

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "devpass" }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const cookie = login.headers
  .getSetCookie()
  .map((v) => v.split(";")[0])
  .find((v) => v.startsWith("pierwave_session="));
const [cookieName, cookieValue] = cookie.split("=");

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {};

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
    await context.addCookies([
      {
        name: cookieName,
        value: cookieValue,
        url: BASE,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await context.route("**/api/v1/updates", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(UPDATES),
      }),
    );
    const page = await context.newPage();
    await page.goto(`${BASE}/settings?tab=general`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "公开状态页" }).waitFor();
    // 等版本更新卡拿到数据，避免卡片还停在骨架高度时测量。
    await page.getByText("已是最新").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);

    const metrics = await page.evaluate(() => {
      const main = document.querySelector("main");
      const scroller = document.scrollingElement;
      const cards = [...document.querySelectorAll('[data-slot="card"]')].filter(
        (el) => el.closest('form') || el.textContent.includes("公开状态页"),
      );
      const cardData = [...document.querySelectorAll('[data-slot="card"]')]
        .filter((el) => el.querySelector('[data-slot="card-title"]'))
        .map((el) => {
          const title = el
            .querySelector('[data-slot="card-title"]')
            ?.textContent?.replace(/\s+/g, " ")
            .trim();
          const rect = el.getBoundingClientRect();
          return {
            title,
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            bottom: Math.round(rect.bottom),
          };
        });
      return {
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        mainScroll: main ? main.scrollHeight : null,
        mainClient: main ? main.clientHeight : null,
        mainHeight: main ? Math.round(main.getBoundingClientRect().height) : null,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        cards: cardData,
        formScroll: document.querySelector("main form")?.scrollHeight ?? null,
      };
    });
    console.log(`\n== ${label} ${theme} ${width} ==`);
    console.log(JSON.stringify(metrics.cards, null, 1));
    console.log(
      `page height ${metrics.mainScroll} (viewport ${metrics.mainClient}), overflowX ${
        metrics.scrollWidth - metrics.clientWidth
      }`,
    );

    // 设置页的滚动容器是 main；展开它，fullPage 才能截到整页。
    await page.evaluate(() => {
      for (const el of [document.documentElement, document.body]) {
        el.style.height = "auto";
        el.style.overflow = "visible";
      }
      const root = document.getElementById("root");
      if (root) {
        root.style.height = "auto";
        root.style.overflow = "visible";
        const shell = root.firstElementChild;
        if (shell instanceof HTMLElement) {
          shell.style.height = "auto";
          shell.style.overflow = "visible";
        }
      }
      const main = document.querySelector("main");
      if (main) {
        main.style.overflow = "visible";
        main.style.height = "auto";
      }
      // 截图时把吸底保存栏放回文档流，避免它盖住最后一张卡的底部。
      const savebar = document.querySelector('[data-slot="settings-savebar"]');
      if (savebar instanceof HTMLElement) savebar.style.position = "static";
      window.scrollTo(0, 0);
    });
    const file = `${OUT}/${label}-settings-${theme}-${width}.png`;
    await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
    console.log(`saved ${file}`);
    report[`${theme}-${width}`] = { ...metrics, file };
    await context.close();
  }
}

await browser.close();
const { writeFileSync } = await import("node:fs");
writeFileSync(`${OUT}/${label}-settings-report.json`, JSON.stringify(report, null, 2));
