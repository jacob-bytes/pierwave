// 404 page: public + authenticated, light/dark, 1440/390.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.env.BASE ?? "http://localhost:5173";
const OUT = "web/screenshots/agent119";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {};

for (const area of ["public", "console"]) {
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
      if (area === "console") {
        await context.addCookies([
          {
            name: cookieName,
            value: cookieValue,
            url: BASE,
            httpOnly: true,
            sameSite: "Lax",
          },
        ]);
      }
      const page = await context.newPage();
      const path =
        area === "public" ? "/status/no/such/path" : "/no-such-page";
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
      await page.locator('[data-slot="not-found"]').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      const metrics = await page.evaluate(() => {
        const root = document.querySelector('[data-slot="not-found"]');
        const card = root?.querySelector('[data-slot="card"]');
        const buttons = [...root.querySelectorAll("a,button")].map((el) => ({
          text: el.textContent?.trim(),
          href: el.getAttribute("href"),
          tag: el.tagName,
        }));
        return {
          path: location.pathname,
          root: root ? Math.round(root.getBoundingClientRect().height) : null,
          card: card ? Math.round(card.getBoundingClientRect().height) : null,
          buttons,
          has404: root?.textContent?.includes("404") ?? false,
          hasShell: Boolean(document.querySelector('[data-slot="sidebar"]')),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        };
      });
      const file = `${OUT}/notfound-${area}-${theme}-${width}.png`;
      await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
      console.log(area, theme, width, JSON.stringify(metrics));
      console.log(`saved ${file}`);
      report[`${area}-${theme}-${width}`] = { ...metrics, file };
      await context.close();
    }
  }
}

// 未登录访问受保护路径仍应先去登录，而不是 404。
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${BASE}/no-such-page`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  report.loggedOutProtected = { url: page.url() };
  console.log("logged-out protected ->", page.url());
  await context.close();
}

await browser.close();
writeFileSync(`${OUT}/notfound-report.json`, JSON.stringify(report, null, 2));
