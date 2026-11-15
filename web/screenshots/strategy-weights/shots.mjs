// 「转发链 → 选路策略：加权 / 最少连接」截图与交互自检。
//
// 前置：master(8787，fresh DB，admin/devpass) + vite dev(5173) 已启动。
// 用法：node web/screenshots/strategy-weights/shots.mjs
//
// 脚本自带数据准备：建 3 台服务器 + 一条两组链（组 2 有 2 台成员），
// 然后打开编辑弹窗，把组 2 的策略切到「加权」，填权重 2 / 5 后截图。
// 不保存（保存会真实改写监听配置），只截表单与下拉。
import { mkdirSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = "http://localhost:5173";
const OUT = "web/screenshots/strategy-weights";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHAIN_NAME = "策略截图-加权";

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
  return { name, value, header: cookie };
}

async function api(cookie, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const value = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  return value;
}

async function seed(cookie) {
  const names = ["策略-A", "策略-B", "策略-C"];
  const addresses = ["10.20.0.1", "10.20.0.2", "10.20.0.3"];
  for (const [index, name] of names.entries()) {
    await api(cookie, "POST", "/api/v1/servers", {
      name,
      address: addresses[index],
    });
  }
  const list = await api(cookie, "GET", "/api/v1/servers");
  const byName = new Map(list.items.map((server) => [server.name, server.id]));
  const [a, b, c] = names.map((name) => byName.get(name));
  assert(Boolean(a && b && c), "3 台截图服务器已创建");

  const existing = await api(cookie, "GET", "/api/v1/chains");
  if (!existing.items.some((chain) => chain.name === CHAIN_NAME)) {
    await api(cookie, "POST", "/api/v1/chains", {
      name: CHAIN_NAME,
      target_host: "1.1.1.1",
      target_port: 443,
      enabled: true,
      engine: "native",
      protocol: "tcp",
      transport: "none",
      groups: [
        {
          strategy: "round_robin",
          public_port: 8443,
          members: [{ server_id: a, listen_port: 20401, priority: 0 }],
        },
        {
          strategy: "round_robin",
          members: [
            { server_id: b, listen_port: 20402, priority: 0, weight: 1 },
            { server_id: c, listen_port: 20403, priority: 1, weight: 1 },
          ],
        },
      ],
    });
  }
  assert(true, `链「${CHAIN_NAME}」已就绪`);
}

async function openEditor(context) {
  const page = await context.newPage();
  await page.goto(`${BASE}/chains`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);

  // 桌面是表格行、窄屏是卡片；操作按钮的 aria-label 两种布局一致。
  const action = page.getByRole("button", {
    name: `操作转发链「${CHAIN_NAME}」`,
  });
  await action.waitFor({ state: "visible" });
  await action.click();
  await page.getByRole("menuitem", { name: "编辑" }).click();

  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });

  // 展开第 2 跳并选中「加权」。
  await dialog.getByRole("button", { name: "展开第 2 跳" }).click();
  const group = dialog.locator('[data-group-index="1"]');
  await group.waitFor({ state: "visible" });
  await group.getByRole("combobox", { name: "第 2 跳的选路策略" }).click();
  await page.getByRole("option", { name: /加权/ }).click();

  // 权重输入出现，填 2 / 5（只截表单，不保存）。
  const weights = group.locator('input[aria-label*="权重"]');
  await weights.nth(0).waitFor({ state: "visible" });
  assert((await weights.count()) === 2, "加权 + 多成员组显示 2 个权重输入");
  await weights.nth(0).fill("2");
  await weights.nth(1).fill("5");
  await page.waitForTimeout(150);
  return { page, dialog, group };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const session = await login();
await seed(session.header);

for (const theme of ["light", "dark"]) {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 1000 },
      deviceScaleFactor: 1,
      colorScheme: theme,
      locale: "zh-CN",
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
        name: session.name,
        value: session.value,
        url: `${BASE}/`,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    const { page, group } = await openEditor(context);

    // 1) 策略下拉：重新打开，确认两个新选项都在。
    await group.getByRole("combobox", { name: "第 2 跳的选路策略" }).click();
    const options = page.getByRole("option");
    await options.first().waitFor({ state: "visible" });
    const labels = await options.allTextContents();
    assert(
      labels.some((label) => label.includes("加权")),
      `下拉包含「加权」（${theme} ${width}）`,
    );
    assert(
      labels.some((label) => label.includes("最少连接")),
      `下拉包含「最少连接」（${theme} ${width}）`,
    );
    await page.screenshot({
      path: `${OUT}/strategy-dropdown-${theme}-${width}.png`,
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(120);

    // 2) 权重输入：桌面截组卡片；窄屏弹窗内部滚动，按视口截更容易看全两个输入。
    await group.scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
    if (width === 390) {
      await group.locator('input[aria-label*="权重"]').last().scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      await page.screenshot({
        path: `${OUT}/weight-input-${theme}-${width}.png`,
      });
    } else {
      await group.screenshot({
        path: `${OUT}/weight-input-${theme}-${width}.png`,
      });
    }

    console.log(`ok - 截图完成：${theme} ${width}`);
    await context.close();
  }
}

await browser.close();
