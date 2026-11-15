// PROXY protocol v2：表单开关 + 说明、列表标记截图。
//
// 前置：master(8787，fresh DB，admin/devpass) + vite dev(5173) 已启动，
// 且已有一个开启 proxy_protocol 的转发（本脚本只读，不写业务数据）。
// 用法：node web/screenshots/proxy-protocol/shots.mjs <server_id>
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = "http://localhost:5173";
const OUT = "web/screenshots/proxy-protocol";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const serverId = process.argv[2];
if (!serverId) throw new Error("usage: node shots.mjs <server_id>");
mkdirSync(OUT, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`ok - ${message}`);
}

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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const session = await login();
const cookie = { name: session.name, value: session.value, domain: "localhost", path: "/" };

for (const theme of ["light", "dark"]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  await context.addCookies([cookie]);
  const page = await context.newPage();

  // 列表：名称旁应有 PROXY v2 徽标。
  await page.goto(`${BASE}/servers/${serverId}/forwards`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const badge = page.locator('[data-proxy-protocol="true"]').first();
  await badge.waitFor({ state: "visible" });
  assert((await badge.textContent())?.includes("PROXY"), "列表显示 PROXY v2 标记");
  await page.screenshot({
    path: `${OUT}/forwards-list-${theme}.png`,
    fullPage: true,
  });

  // 表单：开关 + 「目标必须支持 v2」说明。
  await page.getByRole("button", { name: "操作转发规则「真实IP透传」" }).click();
  await page.getByRole("menuitem", { name: "编辑" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  const toggle = dialog.locator("#forward-proxy-protocol");
  await toggle.waitFor({ state: "visible" });
  assert(await toggle.isChecked(), "编辑已开启的规则时开关必须为开");
  const hint = dialog.getByText("目标服务需支持 PROXY protocol v2，否则会连接失败。");
  await hint.waitFor({ state: "visible" });
  assert(true, "表单显示双语说明（中文）");
  await page.screenshot({
    path: `${OUT}/forward-form-${theme}.png`,
    fullPage: false,
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await context.close();
}

await browser.close();
console.log("screenshots written to", OUT);
