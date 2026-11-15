// 「版本更新」布局改动后的交互回归：
// 1) 间隔 / 两个开关改动后，底部保存栏从 disabled 变为 enabled（脏态）；
// 2) 「立即检测」进入 pending，完成后徽标与 toast 正常。
//
// 前置同 shots.mjs：master(8787) + vite dev(5173)。
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = "http://127.0.0.1:5173";
const OUT = "web/screenshots/settings-updates-layout";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NOW = Math.floor(Date.now() / 1000);
const RELEASE_URL = "https://github.com/jacob-bytes/pierwave/releases/tag/v0.12.0";

mkdirSync(OUT, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`ok - ${message}`);
}

const upToDate = {
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
};

const updateAvailable = {
  master: {
    ...upToDate.master,
    latest: "0.12.0",
    update_available: true,
    checked_at: NOW,
    release_url: RELEASE_URL,
  },
  agents: upToDate.agents,
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
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  colorScheme: "light",
});
await context.addInitScript(() => {
  localStorage.setItem("pierwave.theme", "light");
  localStorage.setItem("pierwave.locale", "zh-CN");
});
await context.addCookies([
  {
    name: cookie.name,
    value: cookie.value,
    url: `${BASE}/`,
    httpOnly: true,
    sameSite: "Lax",
  },
]);
await context.route("**/api/v1/updates/check", async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(updateAvailable),
  });
});
await context.route("**/api/v1/updates", (route) =>
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(upToDate),
  }),
);

const page = await context.newPage();
await page.goto(`${BASE}/settings?tab=general`, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "版本更新" }).waitFor();
await page.getByText("已是最新").first().waitFor();

const save = page.getByRole("button", { name: "保存", exact: true });
assert(await save.isDisabled(), "未修改时保存按钮 disabled");

const interval = page.locator("#settings-update-interval");
await interval.fill("12");
assert(await save.isEnabled(), "修改检测间隔后保存按钮 enabled");

const enabledSwitch = page.locator("#settings-update-enabled");
assert((await enabledSwitch.getAttribute("aria-checked")) === "true", "自动检测默认开启");
await enabledSwitch.click();
assert(await save.isEnabled(), "关闭自动检测后保存按钮 enabled");

const notifySwitch = page.locator("#settings-update-notify");
assert((await notifySwitch.getAttribute("aria-checked")) === "true", "发现新版本时通知默认开启");
await notifySwitch.click();
assert(
  (await notifySwitch.getAttribute("aria-checked")) === "false",
  "发现新版本时通知可关闭",
);

// 脏态截图：三个设置项已改动，保存栏可点。
await page.screenshot({
  path: `${OUT}/regression-dirty-light-1440.png`,
  fullPage: true,
});
console.log(`saved ${OUT}/regression-dirty-light-1440.png`);

const check = page.getByRole("button", { name: "立即检测", exact: true });
await check.click();
await page.getByRole("button", { name: "检测中…", exact: true }).waitFor();
assert(
  await page.getByRole("button", { name: "检测中…", exact: true }).isDisabled(),
  "检测进行中按钮 disabled",
);
await page.screenshot({
  path: `${OUT}/regression-checking-light-1440.png`,
  fullPage: true,
});
console.log(`saved ${OUT}/regression-checking-light-1440.png`);

await page.getByText("更新检测已完成").waitFor();
assert(true, "检测完成 toast 出现");
await page.getByText("有新版本").first().waitFor();
assert(true, "检测完成后显示「有新版本」徽标");
assert(
  (await page.locator("#settings-update-interval").inputValue()) === "12",
  "检测完成后表单值未被重置",
);
await page.screenshot({
  path: `${OUT}/regression-checked-light-1440.png`,
  fullPage: true,
});
console.log(`saved ${OUT}/regression-checked-light-1440.png`);

await context.close();
await browser.close();
