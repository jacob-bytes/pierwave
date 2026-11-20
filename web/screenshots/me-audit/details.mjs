// 补充截图与定向几何测量：卡片级截图 + 组件尺寸。
//   MEAUDIT_TOKEN=... node web/screenshots/me-audit/details.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.env.MEAUDIT_BASE ?? "http://127.0.0.1:8795";
const TOKEN = process.env.MEAUDIT_TOKEN;
if (!TOKEN) throw new Error("missing MEAUDIT_TOKEN");
const OUT = "web/screenshots/me-audit/cards";
mkdirSync(OUT, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const out = [];

async function open(path, { width, height, theme = "dark", locale = "zh-CN" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme });
  await context.addInitScript(({ theme, locale }) => {
    localStorage.setItem("pierwave.theme", theme);
    localStorage.setItem("pierwave.locale", locale);
  }, { theme, locale });
  await context.addCookies([{ name: "pierwave_session", value: TOKEN, url: BASE, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { context, page };
}

async function shots(path, prefix, sizes) {
  for (const size of sizes) {
    const { context, page } = await open(path, size);
    const cards = page.locator('[data-slot="card"]');
    const count = await cards.count();
    const info = [];
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      const box = await card.boundingBox();
      const text = (await card.innerText()).slice(0, 300);
      const file = `${OUT}/${prefix}__card${i + 1}__${size.width}__${size.theme}.png`;
      await card.screenshot({ path: file, animations: "disabled" });
      info.push({ file, box, text });
    }
    // 额外：精确测量关键元素
    const detail = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const rect = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1) };
      };
      const switches = [...document.querySelectorAll('[role="switch"]')].map((el) => ({
        text: el.getAttribute("aria-label"),
        ...rect(el),
        track: getComputedStyle(el).height,
      }));
      const labels = [...document.querySelectorAll("li .w-8")].map((el) => ({
        text: el.innerText,
        ...rect(el),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      const nodeRows = [...document.querySelectorAll("li")].filter((li) => li.querySelector("code") === null).map((li) => ({
        text: li.innerText.replace(/\s+/g, " ").slice(0, 50),
        ...rect(li),
        scrollWidth: li.scrollWidth,
        clientWidth: li.clientWidth,
        childOverflow: [...li.querySelectorAll("*")].filter((c) => {
          const r = c.getBoundingClientRect();
          const p = li.getBoundingClientRect();
          return r.right > p.right + 0.5;
        }).length,
      }));
      return {
        switches,
        labels,
        nodeRows: nodeRows.slice(0, 30),
        main: (() => {
          const m = q("main");
          return m ? { scrollHeight: m.scrollHeight, clientHeight: m.clientHeight, scrollWidth: m.scrollWidth, clientWidth: m.clientWidth } : null;
        })(),
      };
    });
    out.push({ path, size, cards: info, detail });
    console.log("captured", path, size.width, size.theme, "cards", count, "switches", detail.switches.length);
    await context.close();
  }
}

await shots("/me", "overview", [
  { width: 1440, height: 900, theme: "dark" },
  { width: 390, height: 844, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
]);
await shots("/me/subscription", "subscription", [
  { width: 390, height: 844, theme: "dark" },
  { width: 1440, height: 900, theme: "light" },
]);
await shots("/me/forwards", "forwards", [
  { width: 390, height: 844, theme: "dark" },
  { width: 1440, height: 900, theme: "light" },
]);
await shots("/me/packages", "packages", [
  { width: 390, height: 844, theme: "dark" },
  { width: 1440, height: 900, theme: "light" },
]);
writeFileSync(`${OUT}/details.json`, JSON.stringify(out, null, 2));
await browser.close();
