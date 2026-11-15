// 异地备份（WebDAV）设置卡截图。
//
// 前置：
//   1. 本地假 WebDAV 服务器：`python3 /tmp/pierwave-shots/fake_dav.py`（127.0.0.1:8796）
//   2. master：PIERWAVE_ADDR=127.0.0.1:8797，fresh DB，admin/devpass，web/dist 已构建
//   3. 已通过 API 保存 WebDAV 设置并成功上传过一次（卡片上能看到最近文件）。
// 用法：node web/screenshots/remote-backup/shots.mjs
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = "http://127.0.0.1:8797";
const OUT = "docs/images/remote-backup";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(OUT, { recursive: true });

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

async function openCard({ theme, width, height }) {
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
  await page.goto(`${BASE}/settings?tab=backup`, { waitUntil: "networkidle" });
  const title = page.getByText("异地备份", { exact: true }).first();
  await title.waitFor({ state: "visible" });
  const card = title.locator("xpath=ancestor::*[@data-slot='card'][1]");
  // 等最近文件列表真的渲染出来，避免截到 loading 骨架。
  await page
    .getByText("pierwave-backup-20261114-030000.db.gz", { exact: false })
    .first()
    .waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
  return { context, page, card };
}

// 1) 设置卡：亮/深 × 1440/390。
for (const theme of ["light", "dark"]) {
  for (const { width, height } of [
    { width: 1440, height: 1000 },
    // 390 宽度下这张卡比 844 高：用更高的视口整卡截图，宽度仍是 390。
    { width: 390, height: 1500 },
  ]) {
    const { context, card } = await openCard({ theme, width, height });
    const file = `${OUT}/remote-backup-${theme}-${width}.png`;
    await card.screenshot({ path: file });
    console.log(`saved ${file}`);
    await context.close();
  }
}

// 2) 测试连接结果（真实按钮 → 真实 PROPFIND）。
for (const theme of ["light", "dark"]) {
  const { context, page, card } = await openCard({
    theme,
    width: 1440,
    height: 1000,
  });
  await page.getByRole("button", { name: "测试连接" }).click();
  await card
    .getByText("连接成功", { exact: true })
    .waitFor({ state: "visible" });
  await page.waitForTimeout(250);
  const file = `${OUT}/remote-backup-test-${theme}-1440.png`;
  await card.screenshot({ path: file });
  console.log(`saved ${file}`);
  await context.close();
}

// 3) 立即备份结果（真实按钮 → 真实 VACUUM INTO + gzip + PUT）。
for (const theme of ["light", "dark"]) {
  const { context, page, card } = await openCard({
    theme,
    width: 1440,
    height: 1000,
  });
  await page.getByRole("button", { name: "立即备份" }).click();
  await card
    .getByText("已上传", { exact: false })
    .first()
    .waitFor({ state: "visible" });
  await page.waitForTimeout(600);
  const file = `${OUT}/remote-backup-run-${theme}-1440.png`;
  await card.screenshot({ path: file });
  console.log(`saved ${file}`);
  await context.close();
}

// 4) 手机宽度下的「立即备份」结果。
const { context, page, card } = await openCard({
  theme: "light",
  width: 390,
  height: 1500,
});
await page.getByRole("button", { name: "立即备份" }).click();
await card
  .getByText("已上传", { exact: false })
  .first()
  .waitFor({ state: "visible" });
await page.waitForTimeout(600);
const mobileFile = `${OUT}/remote-backup-run-light-390.png`;
await card.screenshot({ path: mobileFile });
console.log(`saved ${mobileFile}`);
await context.close();

await browser.close();
