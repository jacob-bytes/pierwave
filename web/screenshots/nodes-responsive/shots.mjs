// 节点相关页面截图：NodesIndex / Nodes × 亮暗 × 1440/390。
//
// 前置：已构建 web/dist，且一份 fresh DB 的 master 已启动：
//   PIERWAVE_ADDR=127.0.0.1:8798 PIERWAVE_DB='sqlite:///tmp/pierwave-nodes-shots/db.sqlite?mode=rwc' \
//   PIERWAVE_ADMIN_PASSWORD=devpass ./target/debug/pierwave-master
// 用法：node web/screenshots/nodes-responsive/shots.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8798";
const OUT = "preview-ui/nodes-responsive";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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
  return cookie;
}

async function api(cookie, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Cookie: cookie,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const value = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text}`);
  return value;
}

async function seed() {
  const cookie = await login();
  const existing = (await api(cookie, "/api/v1/servers")).items;
  const byName = new Map(existing.map((item) => [item.name, item]));
  const servers = [];
  for (const [name, address, group] of [
    ["香港 · HKG", "203.0.113.21", "香港"],
    ["日本 · NRT", "203.0.113.31", "日本"],
    ["新加坡 · SIN", "203.0.113.41", "新加坡"],
  ]) {
    const found = byName.get(name);
    if (found) {
      servers.push(found);
      continue;
    }
    const created = await api(cookie, "/api/v1/servers", {
      name,
      address,
      xray_mode: "external",
      group_name: group,
    });
    servers.push(created.server);
  }

  const [hk, jp, sg] = servers;
  const nodePayloads = [
    {
      name: "hk-reality",
      protocol: "vless",
      transport: "tcp",
      security: "reality",
      port: 443,
      region: "HK",
      tags: ["香港", "直连"],
      config: {},
    },
    {
      name: "jp-ws",
      protocol: "trojan",
      transport: "ws",
      security: "none",
      port: 8443,
      region: "JP",
      tags: ["日本", "中转"],
      config: {},
    },
    {
      name: "sg-trojan",
      protocol: "trojan",
      transport: "tcp",
      security: "none",
      port: 1443,
      region: "SG",
      tags: ["新加坡"],
      config: {},
    },
  ];
  const existingNodes = await api(cookie, `/api/v1/servers/${hk.id}/nodes`);
  const nodeNames = new Set((existingNodes.items ?? existingNodes).map((node) => node.name));
  for (const payload of nodePayloads) {
    if (nodeNames.has(payload.name)) continue;
    await api(cookie, `/api/v1/servers/${hk.id}/nodes`, payload);
  }
  const jpNodes = await api(cookie, `/api/v1/servers/${jp.id}/nodes`);
  if (!(jpNodes.items ?? jpNodes).some((node) => node.name === "nrt-vless")) {
    await api(cookie, `/api/v1/servers/${jp.id}/nodes`, {
      name: "nrt-vless",
      protocol: "vless",
      transport: "tcp",
      security: "none",
      port: 443,
      region: "JP",
      tags: ["日本"],
      config: {},
    });
  }

  // 应用配置，把服务器的配置版本推到 v3，截图里能看到「配置 v3」。
  let current = (
    await api(cookie, "/api/v1/servers")
  ).items.find((item) => item.id === hk.id);
  while (current.config_version < 3) {
    await api(cookie, `/api/v1/servers/${hk.id}/apply`, {});
    current = (
      await api(cookie, "/api/v1/servers")
    ).items.find((item) => item.id === hk.id);
  }

  return { cookie, server: current, emptyServer: sg };
}

const { cookie, server } = await seed();

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
});
const report = { generatedAt: new Date().toISOString(), shots: [] };
const errors = [];

async function capture({ pageName, path, theme, width, expectTable }) {
  const height = width === 390 ? 900 : 900;
  const context = await browser.newContext({
    viewport: { width, height },
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
  const [name, value] = cookie.split("=");
  await context.addCookies([
    { name, value, url: `${BASE}/`, httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`${pageName}/${theme}/${width}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    errors.push(`${pageName}/${theme}/${width}: ${error.message}`);
  });

  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);

  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const cardSelector = '[data-slot="card"]';
    const firstCard = document.querySelector(cardSelector);
    const table = document.querySelector("table");
    const firstCell = table?.querySelector("tbody td");
    const lastCell = table
      ? [...table.querySelectorAll("tbody td")].at(-1)
      : null;
    const stickyLeft = table?.querySelector('tbody td[data-sticky="left"]');
    const stickyRight = table?.querySelector('tbody td[data-sticky="right"]');
    const moreToggles = [...document.querySelectorAll(
      '[data-slot="mobile-card-more-toggle"]',
    )];
    return {
      viewport: window.innerWidth,
      scrollWidth: Math.max(doc.scrollWidth, document.body.scrollWidth),
      cardCount: document.querySelectorAll(cardSelector).length,
      cardShadow: firstCard ? getComputedStyle(firstCard).boxShadow : null,
      pageHeader: Boolean(document.querySelector('[data-slot="page-header"]')),
      heading: document.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim(),
      animationName: document.querySelector(".animate-enter")
        ? getComputedStyle(document.querySelector(".animate-enter")).animationName
        : null,
      tableExists: Boolean(table),
      mobileCards: document.querySelectorAll('[data-slot="mobile-data-card"]').length,
      sticky: {
        left: stickyLeft ? getComputedStyle(stickyLeft).position : null,
        right: stickyRight ? getComputedStyle(stickyRight).position : null,
        firstCellPosition: firstCell ? getComputedStyle(firstCell).position : null,
        lastCellPosition: lastCell ? getComputedStyle(lastCell).position : null,
      },
      moreToggles: moreToggles.map((item) => item.textContent.trim()),
      hasConfigV3: document.body.textContent.includes("配置 v3"),
    };
  });

  assert(metrics.pageHeader, `${pageName}/${theme}/${width}: PageHeader 存在`);
  assert(
    metrics.scrollWidth <= width + 1,
    `${pageName}/${theme}/${width}: 页面无横向滚动 (${metrics.scrollWidth} <= ${width + 1})`,
  );
  if (pageName === "nodes") {
    assert(metrics.hasConfigV3, `${pageName}/${theme}/${width}: 显示「配置 v3」`);
  } else {
    assert(metrics.cardCount >= 3, `${pageName}/${theme}/${width}: 使用公共 Card`);
    assert(
      metrics.cardShadow !== "none",
      `${pageName}/${theme}/${width}: Card 带 shadow-card`,
    );
  }
  if (expectTable === true) {
    assert(metrics.tableExists, `${pageName}/${theme}/${width}: 桌面表格存在`);
    assert(
      metrics.sticky.left === "sticky" && metrics.sticky.right === "sticky",
      `${pageName}/${theme}/${width}: 名称/操作列 sticky`,
    );
  } else if (expectTable === "mobile") {
    assert(!metrics.tableExists, `${pageName}/${theme}/${width}: 390 不渲染表格`);
    assert(
      metrics.mobileCards > 0,
      `${pageName}/${theme}/${width}: 390 渲染 MobileDataCard`,
    );
    assert(
      metrics.moreToggles.length > 0,
      `${pageName}/${theme}/${width}: 390 有可折叠的「更多」`,
    );
  }

  const file = `${OUT}/${pageName}-${theme}-${width}.png`;
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  const { viewport, scrollWidth, ...rest } = metrics;
  report.shots.push({ page: pageName, theme, width, file, viewport, scrollWidth, ...rest });
  await context.close();
}

for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    await capture({
      pageName: "nodes-index",
      path: "/nodes",
      theme,
      width,
      expectTable: false,
    });
    await capture({
      pageName: "nodes",
      path: `/servers/${server.id}/nodes`,
      theme,
      width,
      expectTable: width === 1440 ? true : "mobile",
    });
  }
}

// 390 展开「更多」：端口 / 7 天流量 / 更新时间可见，且仍无横向滚动。
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 900 },
    colorScheme: "dark",
    locale: "zh-CN",
  });
  await context.addInitScript(() => {
    localStorage.setItem("pierwave.theme", "dark");
    localStorage.setItem("pierwave.locale", "zh-CN");
  });
  const [name, value] = cookie.split("=");
  await context.addCookies([
    { name, value, url: `${BASE}/`, httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  await page.goto(`${BASE}/servers/${server.id}/nodes`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(300);
  await page
    .locator('[data-slot="mobile-card-more-toggle"]')
    .first()
    .click();
  await page.waitForTimeout(200);
  const more = await page.evaluate(() => {
    const dl = document.querySelector('[data-slot="mobile-card-more"]');
    return {
      text: dl?.textContent?.replace(/\s+/g, " ").trim(),
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  assert(Boolean(more.text) && more.text.includes("443"), "390 更多：端口可见");
  assert(more.text.includes("7 天流量"), "390 更多：流量可见");
  assert(more.text.includes("更新时间"), "390 更多：更新时间可见");
  assert(more.scrollWidth <= 391, "390 更多展开后无横向滚动");
  const file = `${OUT}/nodes-dark-390-more.png`;
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  report.shots.push({
    page: "nodes-more",
    theme: "dark",
    width: 390,
    file,
    expanded: more,
  });
  await context.close();
}

// 1024：桌面表格开始横向滚动，滚动提示必须出现在可见区域内（复用 table.tsx）。
{
  const context = await browser.newContext({
    viewport: { width: 1024, height: 900 },
    colorScheme: "dark",
    locale: "zh-CN",
  });
  await context.addInitScript(() => {
    localStorage.setItem("pierwave.theme", "dark");
    localStorage.setItem("pierwave.locale", "zh-CN");
  });
  const [name, value] = cookie.split("=");
  await context.addCookies([
    { name, value, url: `${BASE}/`, httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  await page.goto(`${BASE}/servers/${server.id}/nodes`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(300);
  const hint = await page.evaluate(() => {
    const node = document.querySelector('[data-slot="table-scroll-hint"]');
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      text: node.textContent.trim(),
      left: rect.left,
      right: rect.right,
      viewport: window.innerWidth,
      visible: rect.width > 0 && rect.right <= window.innerWidth + 1,
    };
  });
  assert(Boolean(hint), "1024: 表格溢出时显示滚动提示");
  assert(hint.visible, `1024: 滚动提示在可见区域内 (${hint.left}-${hint.right} / ${hint.viewport})`);
  const file = `${OUT}/nodes-dark-1024.png`;
  await page.screenshot({ path: file, fullPage: true, animations: "disabled" });
  report.shots.push({
    page: "nodes",
    theme: "dark",
    width: 1024,
    file,
    scrollHint: hint,
  });
  await context.close();
}

await browser.close();
report.errors = errors;
writeFileSync(`${OUT}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
for (const shot of report.shots.filter((item) => item.file)) {
  console.log(
    `${shot.file}  scrollWidth=${shot.scrollWidth}  table=${shot.tableExists}  cards=${shot.mobileCards}  v3=${shot.hasConfigV3}`,
  );
}
if (errors.length) process.exitCode = 1;
