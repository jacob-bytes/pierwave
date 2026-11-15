// 「设置 → 常规 → 版本更新」分组布局截图。
//
// 前置：master(8787，fresh preview DB，admin/devpass) + vite dev(5173) 已启动。
// 用法：node web/screenshots/settings-updates-layout/shots.mjs before|after
//
// /api/v1/updates 用路由拦截固定响应，避免依赖外网与 GitHub 限流；
// 设置页其它接口走真实后端（fresh DB 只有默认值）。
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = "http://127.0.0.1:5173";
const OUT = "web/screenshots/settings-updates-layout";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const label = process.argv[2] === "after" ? "after" : "before";

mkdirSync(OUT, { recursive: true });

const NOW = Math.floor(Date.now() / 1000);
const RELEASE_URL = "https://github.com/jacob-bytes/pierwave/releases/tag/v0.11.3";

const DATA = {
  upToDate: {
    master: {
      current: "0.11.3",
      latest: "0.11.3",
      update_available: false,
      release_url: RELEASE_URL,
      released_at: NOW - 3 * 86_400,
      checked_at: NOW - 5 * 60,
      error: null,
    },
    agents: {
      current_protocol: 25,
      min_supported: 16,
      versions: [
        { version: "0.5.1", count: 3 },
        { version: "0.4.1", count: 1 },
      ],
    },
  },
  failed: {
    master: {
      current: "0.11.3",
      latest: "0.11.3",
      update_available: false,
      release_url: RELEASE_URL,
      released_at: NOW - 3 * 86_400,
      checked_at: NOW - 5 * 60,
      error:
        "GitHub Releases 返回 HTTP 503 / GitHub Releases responded with HTTP 503",
    },
    agents: {
      current_protocol: 25,
      min_supported: 16,
      versions: [
        { version: "0.5.1", count: 3 },
        { version: "0.4.1", count: 1 },
      ],
    },
  },
  noAgents: {
    master: {
      current: "0.11.3",
      latest: "0.11.3",
      update_available: false,
      release_url: RELEASE_URL,
      released_at: NOW - 3 * 86_400,
      checked_at: NOW - 5 * 60,
      error: null,
    },
    agents: { current_protocol: 25, min_supported: 16, versions: [] },
  },
};

async function cookieFor(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .find((item) => item.startsWith("pierwave_session="));
  if (!cookie) throw new Error("no session cookie");
  const [name, value] = cookie.split("=");
  return { name, value };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const cookie = await cookieFor("admin", "devpass");

const SHOTS = [
  { name: "general", data: DATA.upToDate, wait: "已是最新" },
  { name: "failed", data: DATA.failed, wait: "上次检测失败" },
  { name: "no-agents", data: DATA.noAgents, wait: "还没有 Agent 上报版本" },
];
const THEMES = ["light", "dark"];
const SIZES = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

for (const shot of SHOTS) {
  for (const theme of THEMES) {
    for (const { width, height } of SIZES) {
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
          name: cookie.name,
          value: cookie.value,
          url: `${BASE}/`,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await context.route("**/api/v1/updates", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(shot.data),
        }),
      );

      const page = await context.newPage();
      await page.goto(`${BASE}/settings?tab=general`, {
        waitUntil: "networkidle",
      });
      const heading = page.getByRole("heading", { name: "版本更新" });
      await heading.waitFor({ state: "visible" });
      await page.getByText(shot.wait).first().waitFor({ state: "visible" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);

      const section = heading.locator("xpath=ancestor::section[1]");
      const file = `${OUT}/${label}-${shot.name}-${theme}-${width}.png`;
      await section.screenshot({ path: file });
      console.log(`saved ${file}`);

      await context.close();
    }
  }
}

await browser.close();
