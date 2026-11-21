// Settings savebar in normal document flow: mid-page (bar offscreen) + bottom.
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
const settingsResponse = await fetch(`${BASE}/api/v1/settings`, {
  headers: { Cookie: cookie },
});
if (!settingsResponse.ok) throw new Error(`settings ${settingsResponse.status}`);
const settings = await settingsResponse.json();
const settingsEncryptOff = {
  ...settings,
  items: { ...settings.items, backup_encrypt: false },
};

const NOW = Math.floor(Date.now() / 1000);
const UPDATES = {
  master: {
    current: "0.16.1",
    latest: "0.16.1",
    update_available: false,
    release_url: "https://github.com/jacob-bytes/pierwave/releases/tag/v0.16.1",
    released_at: NOW - 3 * 86_400,
    checked_at: NOW - 300,
    error: null,
  },
  agents: {
    current_protocol: 25,
    min_supported: 16,
    versions: [{ version: "0.16.1", count: 1 }],
  },
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {};
const THEMES = ["light", "dark"];
const SIZES = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

async function openPage(theme, size, { encryptOff = false } = {}) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
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
  if (encryptOff) {
    await context.route("**/api/v1/settings", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(settingsEncryptOff),
        });
        return;
      }
      await route.continue();
    });
  }
  return { context };
}

function flowInfo(page) {
  return page.evaluate(() => {
    const round = (value) => Math.round(value * 100) / 100;
    const main = document.querySelector("main");
    const bar = [...document.querySelectorAll('[data-slot="settings-savebar"]')]
      .find((el) => el.getBoundingClientRect().height > 0) ?? null;
    const barRect = bar?.getBoundingClientRect();
    const style = bar ? getComputedStyle(bar) : null;
    const cards = [...document.querySelectorAll('[data-slot="card"]')].filter(
      (el) => el.getBoundingClientRect().height > 0,
    );
    const lastCard = cards[cards.length - 1] ?? null;
    const lastRect = lastCard?.getBoundingClientRect();
    const buttonRect = bar?.querySelector("button")?.getBoundingClientRect();
    return {
      mainScrollHeight: main?.scrollHeight ?? null,
      mainClientHeight: main?.clientHeight ?? null,
      mainScrollTop: main?.scrollTop ?? null,
      viewportHeight: window.innerHeight,
      barTop: barRect ? round(barRect.top) : null,
      barBottom: barRect ? round(barRect.bottom) : null,
      barHeight: barRect ? round(barRect.height) : null,
      barWidth: barRect ? round(barRect.width) : null,
      barPosition: style?.position ?? null,
      barBackground: style?.backgroundColor ?? null,
      barBorderTop: style ? `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}` : null,
      barBorderWidth: style?.borderWidth ?? null,
      barBorderStyle: style?.borderStyle ?? null,
      barBoxShadow: style?.boxShadow ?? null,
      barBorderRadius: style?.borderRadius ?? null,
      barPadding: style
        ? `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`
        : null,
      barInsideCard: bar ? Boolean(bar.closest('[data-slot="card"]')) : null,
      buttonHeight: buttonRect ? round(buttonRect.height) : null,
      lastCardTitle:
        lastCard?.querySelector('[data-slot="card-title"]')?.textContent?.trim() ?? null,
      lastCardBottom: lastRect ? round(lastRect.bottom) : null,
      cardToBarGap:
        lastRect && barRect ? round(barRect.top - lastRect.bottom) : null,
      barToViewportBottom: barRect ? round(window.innerHeight - barRect.bottom) : null,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      barBelowViewport: barRect ? barRect.top > window.innerHeight : null,
    };
  });
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    for (const encryptOff of [false, true]) {
      const { context } = await openPage(theme, size, { encryptOff });
      const page = await context.newPage();
      await page.goto(`${BASE}/settings?tab=backup`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: "当前数据库大小" }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      const metrics = await page.evaluate(() => {
        const card = document
          .querySelector("#settings-backup-encrypt")
          ?.closest('[data-slot="card"]');
        const titles = [...document.querySelectorAll('[data-slot="card-title"]')]
          .filter((el) => el.getBoundingClientRect().height > 0)
          .map((el) => el.textContent?.trim());
        return {
          titles,
          encryptCardTitle:
            card?.querySelector('[data-slot="card-title"]')?.textContent?.trim() ??
            null,
          hasEncryptCardTitle: titles.includes("备份加密"),
          hasOffWarning: (document.body.innerText ?? "").includes("已关闭加密"),
          encryptChecked: document
            .querySelector("#settings-backup-encrypt")
            ?.getAttribute("aria-checked"),
          hasExportHint: (document.body.innerText ?? "").includes(
            "导出时使用当前加密设置",
          ),
        };
      });
      const state = encryptOff ? "off" : "on";
      const file = `${OUT}/settings-backup-${state}-${theme}-${size.width}.png`;
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
      });
      await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
      console.log("backup", state, theme, size.width, JSON.stringify(metrics));
      report[`backup-${state}-${theme}-${size.width}`] = { ...metrics, file };
      await context.close();
    }

    for (const tab of ["general", "security", "alerts"]) {
      const { context } = await openPage(theme, size);
      const page = await context.newPage();
      await page.goto(`${BASE}/settings?tab=${tab}`, { waitUntil: "networkidle" });
      await page
        .locator('[role="tabpanel"][data-state="active"] [data-slot="card-title"]')
        .first()
        .waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);

      // 页面中部：条应该在视口之外。
      await page.evaluate(() => {
        const main = document.querySelector("main");
        if (main) main.scrollTop = Math.floor((main.scrollHeight - main.clientHeight) / 2);
      });
      await page.waitForTimeout(200);
      const mid = await flowInfo(page);
      const midShot = `${OUT}/settings-${tab}-mid-${theme}-${size.width}.png`;
      await page.screenshot({ path: midShot, animations: "disabled" });

      // 页面最底部：条应完整可见。
      await page.evaluate(() => {
        const main = document.querySelector("main");
        if (main) main.scrollTop = main.scrollHeight;
      });
      await page.waitForTimeout(200);
      const bottom = await flowInfo(page);
      const bottomShot = `${OUT}/settings-${tab}-bottom-${theme}-${size.width}.png`;
      await page.screenshot({ path: bottomShot, animations: "disabled" });

      // 回到顶部量安全页顺序。
      await page.evaluate(() => {
        const main = document.querySelector("main");
        if (main) main.scrollTop = 0;
      });
      await page.waitForTimeout(150);
      const order = await page.evaluate(() => {
        const panel = document.querySelector('[role="tabpanel"][data-state="active"]');
        const titles = panel
          ? [...panel.querySelectorAll('[data-slot="card-title"]')]
              .filter((el) => el.getBoundingClientRect().height > 0)
              .map((el) => ({
                title: el.textContent?.trim(),
                y: el.getBoundingClientRect().top,
              }))
          : [];
        const api = titles.find((x) => x.title?.startsWith("API 访问"));
        const security = titles.find((x) => x.title === "安全");
        return {
          titles,
          apiBeforeSecurity: Boolean(api && security && api.y < security.y),
        };
      });
      console.log(
        tab,
        theme,
        size.width,
        JSON.stringify({ mid, bottom, order }),
      );
      report[`${tab}-${theme}-${size.width}`] = {
        mid,
        bottom,
        order,
        midShot,
        bottomShot,
      };
      await context.close();
    }
  }
}

await browser.close();
writeFileSync(`${OUT}/settings-final-report.json`, JSON.stringify(report, null, 2));
