// 恢复调度预览验收截图：有 diff / 有 token 警告 / 两者都有 / 两者都无。
//
// 前置：master 在 127.0.0.1:8801（fresh DB，admin/devpass，web/dist 已构建）。
//
// `POST /backup/restore` 与 `GET /backup/info` 用路由拦截固定响应，
// 这样不用真的准备四份「恢复后会回退设置」的备份，也不会留下 pending。
// 用法：node web/screenshots/restore-preview/shots.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = "http://127.0.0.1:8801";
const OUT = "web/screenshots/restore-preview";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const THEMES = ["light", "dark"];
const SIZES = [
  { width: 1440, height: 1400 },
  { width: 390, height: 1600 },
];

mkdirSync(OUT, { recursive: true });

async function login() {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "devpass" }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .find((item) => item.startsWith("pierwave_session="));
  if (!cookie) throw new Error("no session cookie");
  const [name, value] = cookie.split("=");
  return { name, value };
}

const PENDING = {
  uploaded_at: Math.floor(Date.now() / 1000) - 120,
  bytes: 734_003,
};

const DIFF = [
  { key: "backup_encrypt", before: false, after: true },
  {
    key: "public_status_servers",
    before: "公开 2 台 / 2 public",
    after: "公开 1 台 / 1 public",
  },
  { key: "telegram_bot_enabled", before: false, after: true },
  {
    key: "telegram_bot_token",
    before: null,
    after: null,
    secret: true,
  },
];

const STATES = [
  {
    name: "diff",
    settings_diff: DIFF,
    servers_needing_token_refresh: { count: 0, names: [] },
  },
  {
    name: "token",
    settings_diff: [],
    servers_needing_token_refresh: { count: 2, names: ["hk-1", "sg-2"] },
  },
  {
    name: "both",
    settings_diff: DIFF.slice(0, 3),
    servers_needing_token_refresh: { count: 1, names: ["hk-1"] },
  },
  {
    name: "none",
    settings_diff: [],
    servers_needing_token_refresh: { count: 0, names: [] },
  },
];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const cookie = await login();

async function withPage(theme, { width, height }, payload, fn) {
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

  const page = await context.newPage();
  let scheduled = false;

  await page.route(/\/api\/v1\/backup\/info$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        db_bytes: PENDING.bytes,
        too_large: false,
        max_bytes: 536_870_912,
        pending: scheduled ? PENDING : null,
      }),
    });
  });

  await page.route(/\/api\/v1\/backup\/restore(\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    scheduled = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        restart_required: true,
        pending: PENDING,
        ...payload,
      }),
    });
  });

  try {
    await fn(page);
  } finally {
    await context.close();
  }
}

for (const theme of THEMES) {
  for (const size of SIZES) {
    for (const state of STATES) {
      await withPage(theme, size, state, async (page) => {
        await page.goto(`${BASE}/settings?tab=backup`, {
          waitUntil: "networkidle",
        });
        await page
          .getByText("恢复数据", { exact: true })
          .first()
          .waitFor({ state: "visible" });

        await page.setInputFiles("#settings-backup-file", {
          name: "pierwave-backup.db",
          mimeType: "application/octet-stream",
          buffer: Buffer.alloc(2048, 1),
        });
        await page.locator("#settings-backup-confirm").click();
        await page
          .getByRole("button", { name: "上传并安排恢复" })
          .click();
        await page
          .getByText("已就绪，重启主控后生效", { exact: true })
          .waitFor({ state: "visible" });

        if (state.name === "diff" || state.name === "both") {
          const summary = page
            .getByText("将回退的设置", { exact: true })
            .first();
          await summary.click();
          if (state.name === "diff") {
            await page
              .getByText("某秘密被重置（值已隐藏）", { exact: true })
              .waitFor({ state: "visible" });
          } else {
            await page
              .getByText("公开页服务器", { exact: true })
              .waitFor({ state: "visible" });
          }
        }
        if (state.name === "token" || state.name === "both") {
          const summary = page
            .getByText(/台服务器需要重新安装 Agent 或重置 token/)
            .first();
          await summary.click();
          await page
            .getByText("恢复后这些服务器的 token 与现场 Agent 不一致", {
              exact: false,
            })
            .first()
            .waitFor({ state: "visible" });
        }

        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(250);

        const card = page
          .getByText("恢复数据", { exact: true })
          .first()
          .locator("xpath=ancestor::*[@data-slot='card'][1]");
        const file = `${OUT}/restore-${state.name}-${theme}-${size.width}.png`;
        await card.screenshot({ path: file });
        console.log(`saved ${file}`);
      });
    }
  }
}

await browser.close();
console.log("done");
