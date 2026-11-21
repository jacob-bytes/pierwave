// B13/B14 验收截图：Webhook 三态（已配置 / 未配置 / 清除确认）与备份超限禁用。
//
// 前置：
//   1. master 在 127.0.0.1:8798（fresh DB，admin/devpass，PIERWAVE_MAX_BACKUP_MB=1）
//   2. 该库已膨胀到 > 1 MB，使 /backup/info 返回 too_large=true
//   3. web/dist 已构建
// 用法：node web/screenshots/webhook-backup-contract/shots.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = "http://127.0.0.1:8798";
const OUT = "web/screenshots/webhook-backup-contract";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WEBHOOK = "https://hooks.example.test/services/T0KEN-in-path?key=query-secret";
const THEMES = ["light", "dark"];
const ALERT_SIZES = [
  { width: 1440, height: 1100 },
  { width: 390, height: 1000 },
];
// 备份 tab 比视口高：视口必须装得下整张卡，否则内部滚动容器会把
// 视口外的内容裁掉，element screenshot 只能截到一片空白。
const BACKUP_SIZES = [
  { width: 1440, height: 1800 },
  { width: 390, height: 2400 },
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
  return { name, value, header: cookie };
}

async function patchSettings(cookie, body) {
  const res = await fetch(`${BASE}/api/v1/settings`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      cookie: cookie.header,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`PATCH settings ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function backupInfo(cookie) {
  const res = await fetch(`${BASE}/api/v1/backup/info`, {
    headers: { cookie: cookie.header },
  });
  if (!res.ok) throw new Error(`backup info ${res.status}`);
  return res.json();
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const cookie = await login();

async function withPage(theme, { width, height }, fn) {
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
  try {
    await fn(page);
  } finally {
    await context.close();
  }
}

async function openSettings(page, tab, waitText) {
  await page.goto(`${BASE}/settings?tab=${tab}`, { waitUntil: "networkidle" });
  await page.getByText(waitText, { exact: true }).first().waitFor({
    state: "visible",
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

function cardOf(page, title) {
  return page
    .getByText(title, { exact: true })
    .first()
    .locator("xpath=ancestor::*[@data-slot='card'][1]");
}

async function shot(page, target, name, options = {}) {
  const file = `${OUT}/${name}.png`;
  if (target === "page") {
    await page.screenshot({ path: file, ...options });
  } else {
    await target.screenshot({ path: file, ...options });
  }
  console.log(`saved ${file}`);
}

// 1) Webhook 已配置：GET 不回显地址，只显示「留空保持」状态。
await patchSettings(cookie, { webhook_url: WEBHOOK });
for (const theme of THEMES) {
  for (const size of ALERT_SIZES) {
    await withPage(theme, size, async (page) => {
      await openSettings(page, "alerts", "Webhook");
      const input = page.getByPlaceholder("留空保持现有地址");
      await input.waitFor({ state: "visible" });
      const value = await input.inputValue();
      if (value !== "") throw new Error(`webhook echoed a value: ${value}`);
      await shot(
        page,
        cardOf(page, "Webhook"),
        `webhook-configured-${theme}-${size.width}`,
      );
    });
  }
}

// 2) Webhook 未配置：placeholder 回到示例地址，没有清除入口。
await patchSettings(cookie, { webhook_url: null });
for (const theme of THEMES) {
  for (const size of ALERT_SIZES) {
    await withPage(theme, size, async (page) => {
      await openSettings(page, "alerts", "Webhook");
      await page
        .getByPlaceholder("https://example.com/hooks/pierwave")
        .waitFor({ state: "visible" });
      if (
        (await page.getByRole("button", { name: "清除 Webhook" }).count()) !== 0
      ) {
        throw new Error("未配置时不应显示清除入口");
      }
      await shot(
        page,
        cardOf(page, "Webhook"),
        `webhook-empty-${theme}-${size.width}`,
      );
    });
  }
}

// 3) 清除确认：恢复已配置后点「清除 Webhook」，截确认弹层。
await patchSettings(cookie, { webhook_url: WEBHOOK });
for (const theme of THEMES) {
  for (const size of ALERT_SIZES) {
    await withPage(theme, size, async (page) => {
      await openSettings(page, "alerts", "Webhook");
      await page.getByRole("button", { name: "清除 Webhook" }).click();
      await page.getByRole("alertdialog").waitFor({ state: "visible" });
      await page
        .getByText("清除后所有 Webhook 告警会停止发送", { exact: false })
        .first()
        .waitFor({ state: "visible" });
      await page.waitForTimeout(200);
      await shot(
        page,
        "page",
        `webhook-clear-confirm-${theme}-${size.width}`,
      );
    });
  }
}

// 4) 备份超限：导出与立即备份都禁用，并显示 1 MB 上限。
const info = await backupInfo(cookie);
if (info.too_large !== true) {
  throw new Error(`backup info is not too_large: ${JSON.stringify(info)}`);
}
for (const theme of THEMES) {
  for (const size of BACKUP_SIZES) {
    await withPage(theme, size, async (page) => {
      await openSettings(page, "backup", "当前数据库大小");
      await page
        .getByText("数据库已超过导出与异地备份上限 1 MB", { exact: false })
        .first()
        .waitFor({ state: "visible" });

      const download = page.getByRole("button", { name: "下载备份" });
      if (!(await download.isDisabled())) {
        throw new Error("导出按钮在 too_large 时仍可点击");
      }
      const remoteRun = page.getByRole("button", { name: "立即备份" });
      if (!(await remoteRun.isDisabled())) {
        throw new Error("立即备份按钮在 too_large 时仍可点击");
      }

      await shot(
        page,
        page.locator('[role="tabpanel"][aria-label="备份与恢复"]'),
        `backup-too-large-${theme}-${size.width}`,
      );
      await shot(
        page,
        cardOf(page, "异地备份"),
        `remote-upload-blocked-${theme}-${size.width}`,
      );
    });
  }
}

await browser.close();
console.log("done");
