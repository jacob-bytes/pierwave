// 「设置 → 常规」示例块跟随输入 + 卡片顺序的截图与回归。
//
// 前置：master(8787，fresh preview DB，admin/devpass) + vite dev(5173) 已启动。
// 用法：node web/screenshots/examples-follow-input/shots.mjs
//
// /api/v1/updates 用路由拦截固定响应，避免依赖外网与 GitHub 限流；
// 其余设置接口走真实后端（fresh DB 的两个地址默认为空）。
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = "http://127.0.0.1:5173";
const OUT = "web/screenshots/examples-follow-input";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PLACEHOLDER = "https://your-domain.com";

mkdirSync(OUT, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`ok - ${message}`);
}

const NOW = Math.floor(Date.now() / 1000);
const UPDATES = {
  master: {
    current: "0.12.1",
    latest: "0.12.1",
    update_available: false,
    release_url: "https://github.com/jacob-bytes/pierwave/releases/tag/v0.12.1",
    released_at: NOW - 3 * 86_400,
    checked_at: NOW - 5 * 60,
    error: null,
  },
  agents: {
    current_protocol: 25,
    min_supported: 16,
    versions: [{ version: "0.5.1", count: 3 }],
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

async function openPage({ theme, width = 1440, height = 1000 }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    permissions: ["clipboard-read", "clipboard-write"],
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
      body: JSON.stringify(UPDATES),
    }),
  );

  const page = await context.newPage();
  await page.goto(`${BASE}/settings?tab=general`, { waitUntil: "networkidle" });

  const publicCard = page
    .locator('[data-slot="card"]')
    .filter({ hasText: "对外地址" })
    .first();
  await publicCard.getByText("对外地址", { exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);

  return {
    context,
    page,
    publicCard,
    note: publicCard.locator('[data-slot="info-note"]').first(),
    agentInput: page.locator("#settings-agent-base-url"),
    subscriptionInput: page.locator("#settings-subscription-base-url"),
  };
}

/** 示例块的两行文字（安装命令 / 订阅链接），去掉首尾空白。 */
async function noteValues(note) {
  const codes = note.locator("code");
  return {
    install: (await codes.nth(0).textContent()).trim(),
    subscription: (await codes.nth(1).textContent()).trim(),
  };
}

async function expectExamples(note, install, subscription, label) {
  await note
    .locator("code")
    .nth(0)
    .filter({ hasText: install })
    .waitFor({ timeout: 2000 });
  await note
    .locator("code")
    .nth(1)
    .filter({ hasText: subscription })
    .waitFor({ timeout: 2000 });
  assert(
    JSON.stringify(await noteValues(note)) ===
      JSON.stringify({ install, subscription }),
    `${label}: examples show exactly ${install} / ${subscription}`,
  );
}

// 1) 空值：占位域名，不出现当前访问地址。
{
  const { context, page, publicCard, note } = await openPage({
    theme: "light",
    height: 1900,
  });
  // 先截整页（此时滚动容器在顶部），再看示例块。
  await page.screenshot({
    path: `${OUT}/settings-general-order-light-1440.png`,
  });
  const values = await noteValues(note);
  assert(
    values.install === `${PLACEHOLDER}/api/agent/install.sh?token=<token>`,
    "empty: install example uses the placeholder domain",
  );
  assert(
    values.subscription === `${PLACEHOLDER}/api/v1/sub/abc123`,
    "empty: subscription example uses the placeholder domain",
  );
  const text = await note.textContent();
  assert(!text.includes("127.0.0.1"), "empty: no 127.0.0.1 in examples");
  assert(!text.includes("localhost"), "empty: no localhost in examples");
  await note.screenshot({ path: `${OUT}/examples-empty-light-1440.png` });
  await publicCard.screenshot({
    path: `${OUT}/public-card-empty-light-1440.png`,
  });
  const generalForm = page
    .locator("form")
    .filter({ has: page.locator("#settings-panel-name") });
  assert(
    (await generalForm.locator('[data-slot="card-title"]').allTextContents()).join(
      "|",
    ) === "面板|版本更新|对外地址|Agent 升级",
    "light: cards are ordered 面板 → 版本更新 → 对外地址 → Agent 升级",
  );
  console.log("saved empty + light full page");
  await context.close();
}

// 2) 只填 Agent：两个示例都跟随输入，且仍未保存。
{
  const { context, page, publicCard, note, agentInput, subscriptionInput } =
    await openPage({ theme: "light" });
  await agentInput.fill("https://panel.example.com");
  await subscriptionInput.fill("");
  await expectExamples(
    note,
    "https://panel.example.com/api/agent/install.sh?token=<token>",
    "https://panel.example.com/api/v1/sub/abc123",
    "agent only",
  );
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(100);
  await note.screenshot({
    path: `${OUT}/examples-agent-only-light-1440.png`,
  });
  await publicCard.screenshot({
    path: `${OUT}/public-card-agent-only-light-1440.png`,
  });
  console.log("saved agent-only");
  await context.close();
}

// 3) 两个都填：订阅链接优先用订阅地址；复制按钮复制当前示例。
{
  const { context, page, publicCard, note, agentInput, subscriptionInput } =
    await openPage({ theme: "light" });
  await agentInput.fill("https://panel.example.com/");
  await subscriptionInput.fill("https://sub.example.com/");
  await expectExamples(
    note,
    "https://panel.example.com/api/agent/install.sh?token=<token>",
    "https://sub.example.com/api/v1/sub/abc123",
    "both filled",
  );

  const installCode = (await note.locator("code").nth(0).textContent()).trim();
  await note.getByRole("button").nth(0).click();
  await note.getByText("已复制", { exact: true }).waitFor();
  assert(
    (await page.evaluate(() => navigator.clipboard.readText())) === installCode,
    "both filled: copy button copies the displayed install example",
  );
  // 截「已复制」态而不是刚点击的瞬间；等待按钮文字稳定。
  await note.screenshot({ path: `${OUT}/examples-both-light-1440.png` });
  await publicCard.screenshot({
    path: `${OUT}/public-card-both-light-1440.png`,
  });
  console.log("saved both-filled + copy assertion");
  await context.close();
}

// 4) 非法值：整块示例回到占位域名，不拼半截地址。
{
  const { context, page, publicCard, note, agentInput, subscriptionInput } =
    await openPage({ theme: "light" });
  await agentInput.fill("https://bad/path");
  await subscriptionInput.fill("not-a-url");
  await expectExamples(
    note,
    `${PLACEHOLDER}/api/agent/install.sh?token=<token>`,
    `${PLACEHOLDER}/api/v1/sub/abc123`,
    "invalid",
  );
  const text = await note.textContent();
  assert(!text.includes("https://bad"), "invalid: no half-built https://bad URL");
  assert(!text.includes("not-a-url"), "invalid: invalid input is not shown");
  // 让输入框失焦，截图里不出现焦点框。
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(100);
  await note.screenshot({ path: `${OUT}/examples-invalid-light-1440.png` });
  await publicCard.screenshot({
    path: `${OUT}/public-card-invalid-light-1440.png`,
  });
  console.log("saved invalid");
  await context.close();
}

// 5) 深色整页：同一顺序在深色下也成立。
{
  const { context, page } = await openPage({ theme: "dark", height: 1900 });
  await page.screenshot({
    path: `${OUT}/settings-general-order-dark-1440.png`,
  });
  const generalForm = page
    .locator("form")
    .filter({ has: page.locator("#settings-panel-name") });
  assert(
    (await generalForm.locator('[data-slot="card-title"]').allTextContents()).join(
      "|",
    ) === "面板|版本更新|对外地址|Agent 升级",
    "dark: cards are ordered 面板 → 版本更新 → 对外地址 → Agent 升级",
  );
  console.log("saved dark full page");
  await context.close();
}

await browser.close();
