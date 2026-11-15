// 「对外地址 → 示例」与「版本更新 → 升级命令」两个 InfoNote 的截图与回归。
//
// 前置：master(8787，fresh DB，admin/devpass) + vite dev(5173) 已启动。
// 用法：node web/screenshots/info-note/shots.mjs
//
// /api/v1/updates 用路由拦截固定响应；设置页其它接口走真实后端。
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = "http://127.0.0.1:5173";
const OUT = "web/screenshots/info-note";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NOW = Math.floor(Date.now() / 1000);
const RELEASE_URL = "https://github.com/jacob-bytes/pierwave/releases/tag/v0.12.0";

mkdirSync(OUT, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`ok - ${message}`);
}

const agents = {
  current_protocol: 25,
  min_supported: 16,
  versions: [
    { version: "0.5.1", count: 3 },
    { version: "0.4.1", count: 1 },
  ],
};

const scenarios = {
  update: {
    master: {
      current: "0.11.3",
      latest: "0.12.0",
      update_available: true,
      release_url: RELEASE_URL,
      released_at: NOW - 3 * 86_400,
      checked_at: NOW - 5 * 60,
      error: null,
    },
    agents,
  },
  current: {
    master: {
      current: "0.11.3",
      latest: "0.11.3",
      update_available: false,
      release_url: RELEASE_URL,
      released_at: NOW - 3 * 86_400,
      checked_at: NOW - 5 * 60,
      error: null,
    },
    agents,
  },
  failed: {
    master: {
      current: "0.11.3",
      latest: "0.12.0",
      update_available: true,
      release_url: RELEASE_URL,
      released_at: NOW - 3 * 86_400,
      checked_at: NOW - 5 * 60,
      error: "GitHub Releases 返回 HTTP 503 / GitHub Releases responded with HTTP 503",
    },
    agents,
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

/** 打开设置页并返回两张卡与各自的 InfoNote。 */
async function openPage({ theme, width, height, locale, data }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.addInitScript(
    ({ theme, locale }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale },
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
      body: JSON.stringify(data),
    }),
  );

  const page = await context.newPage();
  await page.goto(`${BASE}/settings?tab=general`, { waitUntil: "networkidle" });

  const labels =
    locale === "en"
      ? { public: "Public addresses", updates: "Updates" }
      : { public: "对外地址", updates: "版本更新" };
  const cards = page.locator('[data-slot="card"]');
  const publicCard = cards.filter({ hasText: labels.public }).first();
  const updatesCard = cards.filter({ hasText: labels.updates }).first();
  await publicCard.getByText(labels.public).waitFor();
  await updatesCard.getByText(labels.updates).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);

  return {
    context,
    page,
    publicCard,
    updatesCard,
    publicNote: publicCard.locator('[data-slot="info-note"]').first(),
    upgradeNote: updatesCard.locator('[data-slot="info-note"]').first(),
  };
}

const THEMES = ["light", "dark"];
const SIZES = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

// 1) 有新版本：两个提示块 + 复制成功态（亮/暗 × 1440/390）。
for (const theme of THEMES) {
  for (const { width, height } of SIZES) {
    const { context, page, publicCard, updatesCard, publicNote, upgradeNote } =
      await openPage({
        theme,
        width,
        height,
        locale: "zh-CN",
        data: scenarios.update,
      });

    assert(
      (await publicNote.count()) === 1,
      `public example note visible (${theme}/${width})`,
    );
    assert(
      (await publicNote.getByRole("button").count()) === 2,
      `public example rows both have copy buttons (${theme}/${width})`,
    );
    assert(
      (await upgradeNote.count()) === 1,
      `upgrade hint visible when update available (${theme}/${width})`,
    );
    assert(
      (await upgradeNote.textContent()).includes(
        "curl -fsSL https://raw.githubusercontent.com/jacob-bytes/pierwave/main/scripts/install.sh | sudo bash -s -- upgrade",
      ),
      `upgrade hint shows the confirmed command (${theme}/${width})`,
    );

    // 订阅链接行的复制成功态：按钮变「已复制」，剪贴板拿到同一段文本。
    const subscriptionCode = (
      await publicNote.locator("code").nth(1).textContent()
    ).trim();
    await publicNote.getByRole("button").nth(1).click();
    await publicNote.getByText("已复制", { exact: true }).waitFor();
    assert(
      (await page.evaluate(() => navigator.clipboard.readText())) ===
        subscriptionCode,
      `subscription example copied to clipboard (${theme}/${width})`,
    );
    await publicNote.screenshot({
      path: `${OUT}/examples-copied-${theme}-${width}.png`,
    });
    await page.waitForTimeout(200);
    await publicCard.screenshot({
      path: `${OUT}/examples-card-${theme}-${width}.png`,
    });

    // 等上一条 toast 消失，避免两张成功提示叠在一起。
    await page
      .locator("[data-sonner-toast]")
      .first()
      .waitFor({ state: "detached", timeout: 10_000 });

    // 升级命令的复制成功态 + toast（toast 固定在视口右上角）。
    const upgradeCode = (
      await upgradeNote.locator("code").first().textContent()
    ).trim();
    await upgradeNote.getByRole("button").click();
    await upgradeNote.getByText("已复制", { exact: true }).waitFor();
    assert(
      (await page.evaluate(() => navigator.clipboard.readText())) === upgradeCode,
      `upgrade command copied to clipboard (${theme}/${width})`,
    );
    await page.waitForTimeout(120);
    await page.screenshot({
      path: `${OUT}/upgrade-toast-${theme}-${width}.png`,
    });
    await upgradeNote.screenshot({
      path: `${OUT}/upgrade-copied-${theme}-${width}.png`,
    });
    await updatesCard.screenshot({
      path: `${OUT}/upgrade-card-${theme}-${width}.png`,
    });

    console.log(`saved update shots ${theme}/${width}`);
    await context.close();
  }
}

// 2) 英文文案（亮色 1440）：确认两处提示块都是双语文案。
{
  const { context, publicNote, upgradeNote } = await openPage({
    theme: "light",
    width: 1440,
    height: 1000,
    locale: "en",
    data: scenarios.update,
  });
  assert(
    (await publicNote.textContent()).includes("Install command"),
    "public example labels are translated",
  );
  assert(
    (await upgradeNote.textContent()).includes("Upgrade command"),
    "upgrade hint title is translated",
  );
  await publicNote.screenshot({ path: `${OUT}/examples-en-light-1440.png` });
  await upgradeNote.screenshot({ path: `${OUT}/upgrade-en-light-1440.png` });
  console.log("saved en shots");
  await context.close();
}

// 3) 回归：已是最新 / 检测失败时不渲染升级提示块。
for (const [name, data] of [
  ["up-to-date", scenarios.current],
  ["failed", scenarios.failed],
]) {
  for (const theme of THEMES) {
    const { context, publicNote, updatesCard, upgradeNote } = await openPage({
      theme,
      width: 1440,
      height: 1000,
      locale: "zh-CN",
      data,
    });
    assert(
      (await upgradeNote.count()) === 0,
      `${name}: no upgrade hint (${theme})`,
    );
    assert(
      (await publicNote.count()) === 1,
      `${name}: public example note still visible (${theme})`,
    );
    await updatesCard.screenshot({
      path: `${OUT}/regression-${name}-${theme}-1440.png`,
    });
    console.log(`saved regression ${name} ${theme}`);
    await context.close();
  }
}

await browser.close();
