// /me overview bottom cards: before/after geometry + screenshots.
// Usage: node web/screenshots/agent119/measure-me-overview.mjs before|after
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.env.BASE ?? "http://localhost:5173";
const OUT = "web/screenshots/agent119";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const label = process.argv[2] === "after" ? "after" : "before";
mkdirSync(OUT, { recursive: true });

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "devpass" }),
});
if (!login.ok) throw new Error(`login ${login.status}`);
const cookie = login.headers.getSetCookie().map((v) => v.split(";")[0])
  .find((v) => v.startsWith("pierwave_session="));
const [cookieName, cookieValue] = cookie.split("=");

const NOW = Math.floor(Date.now() / 1000);
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";

const SESSIONS = {
  items: [
    {
      id: "s-current",
      user_id: "u-admin",
      user_agent: CHROME_MAC,
      ip: "203.0.113.10",
      created_at: NOW - 1_800,
      last_seen_at: NOW - 20,
      expires_at: NOW + 86_400,
      current: true,
    },
    {
      id: "s-phone",
      user_id: "u-admin",
      user_agent: SAFARI_IPHONE,
      ip: "198.51.100.7",
      created_at: NOW - 7_200,
      last_seen_at: NOW - 600,
      expires_at: NOW + 86_400,
      current: false,
    },
  ],
};
const LOGINS = {
  items: [
    {
      id: "l-1",
      ip: "203.0.113.10",
      user_agent: CHROME_MAC,
      created_at: NOW - 1_800,
    },
    {
      id: "l-2",
      ip: "198.51.100.7",
      user_agent: SAFARI_IPHONE,
      created_at: NOW - 90_000,
    },
  ],
};
const TRAFFIC = {
  days: Array.from({ length: 7 }, (_, index) => {
    const date = new Date((NOW - (6 - index) * 86_400) * 1_000)
      .toISOString()
      .slice(0, 10);
    return {
      date,
      uplink: 120 * 1024 * 1024 * (index + 1),
      downlink: 540 * 1024 * 1024 * (index + 1),
      weighted: 660 * 1024 * 1024 * (index + 1),
    };
  }),
};

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
    let loginRequests = 0;
    await context.route("**/api/v1/**", async (route) => {
      const url = route.request().url();
      if (url.includes("/api/v1/me/logins")) {
        loginRequests += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(LOGINS),
        });
        return;
      }
      if (/\/api\/v1\/sessions(\?|$)/.test(url)) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(SESSIONS),
        });
        return;
      }
      if (url.includes("/api/v1/me/traffic")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(TRAFFIC),
        });
        return;
      }
      await route.continue();
    });

    const page = await context.newPage();
    await page.goto(`${BASE}/me`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "登录设备" }).waitFor();
    if (label === "before") {
      await page.getByRole("heading", { name: "最近登录" }).waitFor();
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);

    const metrics = await page.evaluate(() => {
      const round = (value) => Math.round(value * 100) / 100;
      const main = document.querySelector("main");
      const cards = [...main.querySelectorAll('[data-slot="card"]')]
        .filter((el) => el.getBoundingClientRect().height > 0)
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          const content = el.querySelector('[data-slot="card-content"]');
          const contentRect = content?.getBoundingClientRect();
          const descendants = [...el.querySelectorAll("*")]
            .filter((node) => {
              const box = node.getBoundingClientRect();
              return box.height > 0 && box.width > 0;
            })
            .map((node) => node.getBoundingClientRect().bottom);
          const lastBottom = descendants.length > 0 ? Math.max(...descendants) : rect.bottom;
          const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
          return {
            title: el.querySelector('[data-slot="card-title"]')?.textContent?.trim() ?? null,
            x: round(rect.x),
            y: round(rect.y),
            width: round(rect.width),
            height: round(rect.height),
            bottom: round(rect.bottom),
            contentBottom: contentRect ? round(contentRect.bottom) : null,
            innerBlank: round(Math.max(0, rect.bottom - lastBottom - paddingBottom)),
          };
        });

      const devices = cards.find((card) => card.title === "登录设备");
      const devicesCard = [...main.querySelectorAll('[data-slot="card"]')]
        .find((el) => el.querySelector('[data-slot="card-title"]')?.textContent?.trim() === "登录设备");
      const exitButtons = devicesCard
        ? [...devicesCard.querySelectorAll("button")]
            .filter((button) => /退出/.test(button.textContent ?? ""))
            .map((button) => {
              const rect = button.getBoundingClientRect();
              return {
                text: button.textContent?.replace(/\s+/g, " ").trim(),
                width: round(rect.width),
                height: round(rect.height),
              };
            })
        : [];
      return {
        cardTitles: cards.map((card) => card.title),
        cards,
        devices,
        hasRecentLoginText: (document.body.innerText ?? "").includes("最近登录"),
        loginRequests: null,
        exitButtons,
        pageHeight: main?.scrollHeight ?? null,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    metrics.loginRequests = loginRequests;
    console.log(`\n== ${label} ${theme} ${width} ==`);
    console.log(JSON.stringify(metrics, null, 1));

    // 展开内部滚动容器，截整页。
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
      window.scrollTo(0, 0);
    });
    const file = `${OUT}/me-overview-${label}-${theme}-${width}.png`;
    await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
    console.log(`saved ${file}`);
    report[`${label}-${theme}-${width}`] = { ...metrics, file };
    await context.close();
  }
}

await browser.close();
writeFileSync(`${OUT}/me-overview-${label}-report.json`, JSON.stringify(report, null, 2));
