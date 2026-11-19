// 390/768 溢出、触控目标与审计状态色的改前/改后取证。
//
// 前置：master(8787, admin/devpass) + vite dev(5173) + 已跑 seed.mjs。
// 用法：node web/screenshots/terminology-audit/shots.mjs before|after
//
// 输出：web/screenshots/terminology-audit/<label>/*.png
//       web/screenshots/terminology-audit/measurements-<label>.json
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.env.BASE ?? "http://localhost:5173";
const API = process.env.API ?? "http://127.0.0.1:8787";
const OUT = "web/screenshots/terminology-audit";
const label = process.argv[2] === "after" ? "after" : "before";
const DIR = `${OUT}/${label}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MOBILE = { width: 390, height: 844 };
const TABLET = { width: 768, height: 1024 };

mkdirSync(DIR, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`ok - ${message}`);
}

async function loginCookie() {
  const res = await fetch(`${API}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "devpass" }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status}`);
  return res.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .find((item) => item.startsWith("pierwave_session="));
}

/** 页面内执行：整页横向溢出与元素几何。 */
function pageMetrics() {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x * 10) / 10,
      y: Math.round(r.y * 10) / 10,
      w: Math.round(r.width * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      right: Math.round(r.right * 10) / 10,
      bottom: Math.round(r.bottom * 10) / 10,
    };
  };
  const doc = document.documentElement;
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    page: {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      overflowX: doc.scrollWidth - doc.clientWidth,
    },
  };
}

/** 有效命中区：从元素中心向外逐像素探测 elementFromPoint（含伪元素）。 */
function hitArea(el) {
  const r = el.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);
  const hits = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    return hit === el || (hit !== null && el.contains(hit));
  };
  if (!hits(cx, cy)) return null;
  let left = cx;
  let right = cx;
  let top = cy;
  let bottom = cy;
  for (let d = 1; d <= 40; d += 1) {
    if (!hits(cx - d, cy)) break;
    left = cx - d;
  }
  for (let d = 1; d <= 40; d += 1) {
    if (!hits(cx + d, cy)) break;
    right = cx + d;
  }
  for (let d = 1; d <= 40; d += 1) {
    if (!hits(cx, cy - d)) break;
    top = cy - d;
  }
  for (let d = 1; d <= 40; d += 1) {
    if (!hits(cx, cy + d)) break;
    bottom = cy + d;
  }
  return { w: right - left + 1, h: bottom - top + 1 };
}

async function measureTouch(page, selector, name) {
  const el = page.locator(selector).first();
  if ((await el.count()) === 0) return { name, missing: true };
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(60);
  const data = await el.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    const hits = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return hit === node || (hit !== null && node.contains(hit));
    };
    if (!hits(cx, cy)) return null;
    let left = cx;
    let right = cx;
    let top = cy;
    let bottom = cy;
    for (let d = 1; d <= 40; d += 1) {
      if (!hits(cx - d, cy)) break;
      left = cx - d;
    }
    for (let d = 1; d <= 40; d += 1) {
      if (!hits(cx + d, cy)) break;
      right = cx + d;
    }
    for (let d = 1; d <= 40; d += 1) {
      if (!hits(cx, cy - d)) break;
      top = cy - d;
    }
    for (let d = 1; d <= 40; d += 1) {
      if (!hits(cx, cy + d)) break;
      bottom = cy + d;
    }
    return {
      rect: {
        w: Math.round(rect.width * 10) / 10,
        h: Math.round(rect.height * 10) / 10,
      },
      hit: { w: right - left + 1, h: bottom - top + 1 },
      aria: node.getAttribute("aria-label"),
      text: (node.textContent ?? "").trim().slice(0, 40),
    };
  });
  return { name, ...(data ?? { missing: true }) };
}

async function makePage(browser, cookie, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: "zh-CN",
    colorScheme: "dark",
  });
  await context.addCookies([
    {
      name: "pierwave_session",
      value: cookie.split("=")[1],
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("theme", "dark");
  });
  return { context, page };
}

async function goto(page, path) {
  console.log(`goto ${path}`);
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(400);
}

async function logsScenario(browser, cookie) {
  const { context, page } = await makePage(browser, cookie, MOBILE);
  await goto(page, "/logs?tab=audit");
  await page.waitForFunction(
    () =>
      document.querySelector("[data-slot=table-container]")?.getClientRects()
        .length ||
      document.querySelector("[data-slot=mobile-data-card]") !== null,
    undefined,
    { timeout: 15_000 },
  );

  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x * 10) / 10,
        w: Math.round(r.width * 10) / 10,
        right: Math.round(r.right * 10) / 10,
        h: Math.round(r.height * 10) / 10,
      };
    };
    const tabsLists = [...document.querySelectorAll("[data-slot=tabs-list]")];
    const category = tabsLists
      .map((list) => ({
        list,
        count: list.querySelectorAll("[role=tab]").length,
      }))
      .sort((a, b) => b.count - a.count)[0];
    const categoryScroll = category?.list.closest("[data-slot=scroll-fade]");
    const table = [
      ...document.querySelectorAll("[data-slot=table-container]"),
    ].find((el) => el.getClientRects().length > 0);
    const actor = document.querySelector(
      'input[aria-label="按操作者搜索审计日志"]',
    );
    const target = document.querySelector(
      'input[aria-label="按对象搜索审计日志"]',
    );
    const refresh = [...document.querySelectorAll("button")].find(
      (btn) =>
        btn.getClientRects().length > 0 &&
        (btn.textContent ?? "").includes("刷新"),
    );
    return {
      page: {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        overflowX: doc.scrollWidth - doc.clientWidth,
      },
      actor: rect(actor),
      target: rect(target),
      refresh: rect(refresh),
      categoryTabs: category
        ? {
            count: category.count,
            stripWidth: Math.round(category.list.scrollWidth),
            rect: rect(category.list),
            scroll: categoryScroll
              ? {
                  rect: rect(categoryScroll),
                  scrollWidth: categoryScroll.scrollWidth,
                  clientWidth: categoryScroll.clientWidth,
                  clipped:
                    categoryScroll.scrollWidth - categoryScroll.clientWidth,
                  fadeRight:
                    categoryScroll.getAttribute("data-fade-right") ?? null,
                }
              : null,
          }
        : null,
      table: table
        ? {
            rect: rect(table),
            scrollWidth: table.scrollWidth,
            clientWidth: table.clientWidth,
            clipped: table.scrollWidth - table.clientWidth,
            hint: Boolean(
              document.querySelector("[data-slot=table-scroll-hint]"),
            ),
          }
        : null,
      cards: (() => {
        const cards = [
          ...document.querySelectorAll("[data-slot=mobile-data-card]"),
        ].filter((el) => el.getClientRects().length > 0);
        if (cards.length === 0) return null;
        const first = cards[0].getBoundingClientRect();
        return {
          count: cards.length,
          first: {
            x: Math.round(first.x),
            w: Math.round(first.width),
            right: Math.round(first.right),
          },
          overflowX: Math.max(
            0,
            ...cards.map(
              (el) => el.getBoundingClientRect().right - window.innerWidth,
            ),
          ),
        };
      })(),
    };
  });

  await page.screenshot({ path: `${DIR}/logs-390-audit.png`, fullPage: true });
  await page.screenshot({
    path: `${DIR}/logs-390-audit-viewport.png`,
    fullPage: false,
  });
  await context.close();
  return metrics;
}

async function settingsScenario(browser, cookie, viewport, suffix) {
  const { context, page } = await makePage(browser, cookie, viewport);
  await goto(page, "/settings");
  await page.waitForSelector("[data-slot=tabs-list]", { timeout: 15_000 });
  await page.waitForTimeout(200);
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const lists = [...document.querySelectorAll("[data-slot=tabs-list]")];
    const list = lists.sort(
      (a, b) =>
        b.querySelectorAll("[role=tab]").length -
        a.querySelectorAll("[role=tab]").length,
    )[0];
    const tabs = list ? [...list.querySelectorAll("[role=tab]")] : [];
    const last = tabs.at(-1);
    const r = list?.getBoundingClientRect();
    const scroller = list?.closest("[data-slot=scroll-fade]");
    return {
      page: {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
        overflowX: doc.scrollWidth - doc.clientWidth,
      },
      tabCount: tabs.length,
      list: r
        ? {
            x: Math.round(r.x),
            w: Math.round(r.width),
            right: Math.round(r.right),
            scrollWidth: list.scrollWidth,
            clientWidth: list.clientWidth,
            clipped: list.scrollWidth - list.clientWidth,
          }
        : null,
      lastVisible: last
        ? (() => {
            const lr = last.getBoundingClientRect();
            return lr.right <= window.innerWidth + 1 && lr.left >= -1;
          })()
        : null,
      container: scroller
        ? {
            clientWidth: scroller.clientWidth,
            scrollWidth: scroller.scrollWidth,
            clipped: scroller.scrollWidth - scroller.clientWidth,
            fadeRight: scroller.getAttribute("data-fade-right"),
            fadeLeft: scroller.getAttribute("data-fade-left"),
          }
        : null,
      fade: (() => {
        if (!scroller) return false;
        return scroller.getAttribute("data-fade-right") === "true";
      })(),
    };
  });
  await page.screenshot({
    path: `${DIR}/settings-${suffix}.png`,
    fullPage: false,
  });
  await context.close();
  return metrics;
}

async function auditColorsScenario(browser, cookie) {
  const { context, page } = await makePage(browser, cookie, {
    width: 1280,
    height: 1200,
  });
  await goto(page, "/logs?tab=audit");
  await page.waitForSelector("[data-slot=table-container]:visible");
  const badges = await page.evaluate(() => {
    const labels = [
      "登录成功",
      "修改设置",
      "创建规则模板",
      "删除转发链",
      "登录失败",
      "轮换服务器 Token",
    ];
    const rows = [...document.querySelectorAll("tbody tr")].filter(
      (row) => row.getClientRects().length > 0,
    );
    const out = [];
    for (const row of rows) {
      const badge = row.querySelector("[data-slot=badge]");
      if (!badge) continue;
      const text = (badge.textContent ?? "").trim();
      if (!labels.some((label) => text.includes(label))) continue;
      const style = getComputedStyle(badge);
      out.push({
        text,
        color: style.color,
        background: style.backgroundColor,
        className: badge.className,
      });
    }
    return out;
  });
  await page.screenshot({
    path: `${DIR}/audit-status-colors.png`,
    fullPage: false,
  });
  await context.close();
  return badges;
}

async function touchScenario(browser, cookie) {
  const { context, page } = await makePage(browser, cookie, MOBILE);
  const results = {};

  await goto(page, "/subscriptions");
  await page.waitForSelector("[data-slot=mobile-data-card]", {
    timeout: 15_000,
  });
  results.subscriptions = [
    await measureTouch(page, 'button[aria-label^="复制"]', "复制订阅链接"),
    await measureTouch(page, 'button[aria-label^="查看"][aria-label*="二维码"]', "二维码"),
    await measureTouch(page, 'a[aria-label*="订阅链接"]', "打开订阅链接"),
  ];
  await page.screenshot({
    path: `${DIR}/subscriptions-390.png`,
    fullPage: false,
  });

  await goto(page, "/servers");
  await page.waitForSelector("[data-slot=mobile-data-card]", {
    timeout: 15_000,
  });
  results.servers = [
    await measureTouch(page, 'button[aria-label*="详情"]', "详情"),
    await measureTouch(page, 'button[aria-label*="更多操作"]', "更多"),
  ];
  await page.screenshot({ path: `${DIR}/servers-390.png`, fullPage: false });

  await goto(page, "/users");
  await page.waitForSelector("[data-slot=mobile-data-card]", {
    timeout: 15_000,
  });
  results.users = [
    await measureTouch(page, 'button[aria-label^="操作"]', "更多"),
  ];
  await page.screenshot({ path: `${DIR}/users-390.png`, fullPage: false });

  await goto(page, "/chains");
  await page.waitForSelector("[data-slot=mobile-data-card]", {
    timeout: 15_000,
  });
  results.chains = [
    await measureTouch(page, 'button[aria-label^="查看"][aria-label*="拓扑"]', "拓扑"),
    await measureTouch(page, 'button[aria-label^="操作转发链"]', "更多"),
  ];
  await page.screenshot({ path: `${DIR}/chains-390.png`, fullPage: false });

  await goto(page, "/settings");
  await page.waitForSelector("[data-slot=tabs-list]", { timeout: 15_000 });
  results.settings = [
    await measureTouch(page, '[data-slot=tabs-trigger]', "tab"),
  ];

  await goto(page, "/logs?tab=audit");
  await page.waitForSelector("[data-slot=tabs-list]", { timeout: 15_000 });
  results.logs = [
    await measureTouch(page, '[data-slot=tabs-trigger]', "tab"),
    await measureTouch(
      page,
      'button:has-text("刷新"):visible',
      "刷新",
    ),
  ];

  await context.close();
  return results;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const cookie = await loginCookie();
  assert(Boolean(cookie), "logged in");

  console.log("logs scenario");
  const logs = await logsScenario(browser, cookie);
  console.log("settings 390");
  const settings390 = await settingsScenario(browser, cookie, MOBILE, "390");
  console.log("settings 768");
  const settings768 = await settingsScenario(browser, cookie, TABLET, "768");
  console.log("audit colors");
  const colors = await auditColorsScenario(browser, cookie);
  console.log("touch");
  const touch = await touchScenario(browser, cookie);

  const report = { label, logs, settings390, settings768, colors, touch };
  writeFileSync(
    `${OUT}/measurements-${label}.json`,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
