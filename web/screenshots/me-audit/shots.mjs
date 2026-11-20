// /me 用户端一致性审查：截图 + 几何/对比度采集。
// 只写本目录，不改产品代码。前置：主控在 127.0.0.1:8795，普通用户会话 token 由环境变量传入。
//
//   MEAUDIT_TOKEN=... node web/screenshots/me-audit/shots.mjs
//
// 输出：
//   {page}__{width}__{theme}.png          正常态（zh-CN）
//   lang/{page}__{width}__{theme}.png     英文正常态
//   states/{page}__{state}__{width}__{theme}.png
//   metrics.json                          每页几何/溢出/触控目标/对比度
//   state-metrics.json                    状态图对应页面的关键文本与几何
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.env.MEAUDIT_BASE ?? "http://127.0.0.1:8795";
const TOKEN = process.env.MEAUDIT_TOKEN;
if (!TOKEN) throw new Error("缺少 MEAUDIT_TOKEN");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = "web/screenshots/me-audit";
mkdirSync(`${OUT}/states`, { recursive: true });
mkdirSync(`${OUT}/lang`, { recursive: true });

const PAGES = [
  { id: "overview", path: "/me" },
  { id: "subscription", path: "/me/subscription" },
  { id: "forwards", path: "/me/forwards" },
  { id: "packages", path: "/me/packages" },
];
const THEMES = ["dark", "light"];
const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const cookie = { name: "pierwave_session", value: TOKEN, url: BASE, httpOnly: true, sameSite: "Lax" };

async function makeContext({ width, height, theme, locale = "zh-CN" }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  await context.addInitScript(
    ({ theme, locale }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale },
  );
  await context.addCookies([cookie]);
  await context.addInitScript(CONTRAST_HELPER);
  return context;
}

/** 把 oklch/rgb/hex 解析成 rgb，用 canvas 兜底，避免自己写色彩空间转换。 */
const CONTRAST_HELPER = `
  (() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    window.__meauditColor = (input) => {
      if (!input || input === 'transparent' || input === 'rgba(0, 0, 0, 0)') return null;
      try {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = input;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
      } catch { return null; }
    };
  })();
`;

/** 在页面内执行的几何/可访问性采集，返回纯 JSON。 */
function collect() {
  const vw = innerWidth;
  const de = document.documentElement;
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const describe = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: clean(el.className?.baseVal ?? el.className),
    text: clean(el.innerText || el.getAttribute("aria-label") || ""),
    rect: (() => {
      const r = el.getBoundingClientRect();
      return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), right: +r.right.toFixed(1) };
    })(),
  });
  const inScrollableX = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === "auto" || s.overflowX === "scroll") return describe(p).cls.slice(0, 80);
    }
    return null;
  };
  const overflow = [];
  for (const el of document.querySelectorAll("body *")) {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || s.position === "fixed") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.right > vw + 0.5 || r.left < -0.5) {
      const d = describe(el);
      d.scrollableAncestor = inScrollableX(el);
      overflow.push(d);
    }
  }
  const interactive = [];
  for (const el of document.querySelectorAll('button, a[href], [role="switch"], [role="tab"], select, input, [role="button"]')) {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.height < 40 || r.width < 40) {
      interactive.push({
        ...describe(el),
        ariaLabel: el.getAttribute("aria-label"),
        disabled: el.disabled === true,
      });
    }
  }
  const rows = [];
  for (const el of document.querySelectorAll("li")) {
    if (!el.closest('[data-slot="card"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.height <= 0) continue;
    rows.push({ text: clean(el.innerText).slice(0, 70), h: +r.height.toFixed(1), w: +r.width.toFixed(1) });
  }
  const resolve = (color) => window.__meauditColor(color);
  const luminance = ([r, g, b]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (fg, bg) => {
    const a = fg[3];
    return [
      Math.round(fg[0] * a + bg[0] * (1 - a)),
      Math.round(fg[1] * a + bg[1] * (1 - a)),
      Math.round(fg[2] * a + bg[2] * (1 - a)),
      1,
    ];
  };
  const bgOf = (el) => {
    for (let p = el; p; p = p.parentElement) {
      const c = resolve(getComputedStyle(p).backgroundColor);
      if (c && c[3] > 0.95) return c;
    }
    return resolve(getComputedStyle(document.body).backgroundColor) || [10, 10, 10, 1];
  };
  const samples = [];
  const seen = new Set();
  const selectors = [
    "h1",
    "h2",
    '[data-slot="card-title"]',
    '[data-slot="card-description"]',
    "p.text-muted-foreground",
    "span.text-muted-foreground",
    "a[aria-current]",
    "nav a",
    '[data-slot="badge"]',
    "button",
    "code",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const s = getComputedStyle(el);
    if (seen.has(el)) continue;
    seen.add(el);
    const fg0 = resolve(s.color);
    if (!fg0) continue;
    const bg = bgOf(el);
    const fg = fg0[3] < 0.99 ? blend(fg0, bg) : fg0;
    const L1 = luminance(fg);
    const L2 = luminance(bg);
    samples.push({
      selector: sel,
      text: clean(el.innerText).slice(0, 60),
      color: s.color,
      background: getComputedStyle(el).backgroundColor,
      contrast: +(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)).toFixed(2)),
      fontSize: s.fontSize,
      fontWeight: s.fontWeight,
    });
  }
  const numeric = [...document.querySelectorAll("body *")]
    .filter((el) => el.children.length === 0 && /^-?[\d.,]+\s*(B|KB|MB|GB|TB|GiB|MiB|TiB|天|days|%|\/)?$/.test(clean(el.innerText)))
    .slice(0, 30)
    .map((el) => {
      const s = getComputedStyle(el);
      return {
        text: clean(el.innerText),
        fontFamily: s.fontFamily,
        fontVariantNumeric: s.fontVariantNumeric,
        textAlign: s.textAlign,
        w: +el.getBoundingClientRect().width.toFixed(1),
      };
    });
  const cards = [...document.querySelectorAll('[data-slot="card"]')].map((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return { cls: clean(el.className), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), padding: s.padding, gap: s.gap };
  });
  const firstCard = cards[0];
  const pagePad = (() => {
    const main = document.querySelector("main");
    return main ? getComputedStyle(main).padding : null;
  })();
  return {
    href: location.pathname,
    locale: localStorage.getItem("pierwave.locale"),
    theme: document.documentElement.dataset.theme,
    viewport: { w: vw, h: innerHeight },
    doc: { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, scrollHeight: de.scrollHeight },
    pageOverflowX: de.scrollWidth - de.clientWidth,
    pagePad,
    cards,
    firstCard,
    rows,
    overflow: overflow.slice(0, 25),
    overflowCount: overflow.length,
    smallTargets: interactive.slice(0, 30),
    smallTargetCount: interactive.length,
    contrast: samples,
    numeric,
    text: clean(document.body.innerText).slice(0, 4000),
  };
}

async function settle(page) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(350);
}

const metrics = [];
const stateMetrics = [];

async function shot(params) {
  const { id, path, width, height, theme, locale = "zh-CN", routes, name, tag } = params;
  const context = await makeContext({ width, height, theme, locale });
  const page = await context.newPage();
  const consoleErrors = [];
  const failed = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on("requestfailed", (req) => failed.push(`${req.method()} ${req.url()} ${req.failure()?.errorText}`));
  if (routes) {
    for (const [pattern, handler] of routes) await page.route(pattern, handler);
  }
  const loading = tag === "state" && name === "loading";
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  if (loading) {
    await page.waitForTimeout(700);
  } else {
    await settle(page);
  }
  const data = await page.evaluate(collect);
  const file = tag === "normal"
    ? `${OUT}/${id}__${width}__${theme}.png`
    : tag === "lang"
      ? `${OUT}/lang/${id}__${width}__${theme}.png`
      : `${OUT}/states/${id}__${name}__${width}__${theme}.png`;
  await page.screenshot({ path: file, fullPage: true });
  const entry = { file, ...data, consoleErrors, failed };
  if (tag === "normal" || tag === "lang") metrics.push(entry);
  else stateMetrics.push(entry);
  await context.close();
  console.log("saved", file, `overflow=${data.pageOverflowX}`, `small=${data.smallTargetCount}`, `errors=${consoleErrors.length}`);
  return entry;
}

// ---- 正常态：4 页 × 亮/暗 × 1440/390 ----
for (const p of PAGES) {
  for (const theme of THEMES) {
    for (const size of SIZES) {
      await shot({ ...p, ...size, theme, tag: "normal" });
    }
  }
}

// ---- 英文：4 页 × 1440 暗 + 390 亮，检查是否有中文残留 ----
for (const p of PAGES) {
  await shot({ ...p, width: 1440, height: 900, theme: "dark", locale: "en", tag: "lang" });
  await shot({ ...p, width: 390, height: 844, theme: "light", locale: "en", tag: "lang" });
}

// ---- 状态图 ----
const stateContext = await makeContext({ width: 1440, height: 900, theme: "dark" });
const summaryRes = await stateContext.request.get(`${BASE}/api/v1/me/summary`);
const summary = await summaryRes.json();
const forwardsRes = await stateContext.request.get(`${BASE}/api/v1/me/forwards`);
const forwards = await forwardsRes.json();
await stateContext.close();

const emptySummary = {
  ...summary,
  package: null,
  usage: { used_bytes: 0, remaining_bytes: null, days_left: null, status: "none" },
  nodes: [],
  subscription: null,
  forward_servers: [],
  packages: [],
  traffic: { today_bytes: 0, month_bytes: 0 },
  subscription_url: "",
};

const json = (body, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const fail = (message = "boom") => ({
  status: 500,
  contentType: "application/json",
  body: JSON.stringify({ code: "internal", error: message }),
});

// 1) 壳层 summary 失败：所有分页共用的错误态
for (const width of [1440, 390]) {
  await shot({
    id: "overview", path: "/me", width, height: width === 1440 ? 900 : 844, theme: "dark",
    tag: "state", name: "error-summary",
    routes: [[`**/api/v1/me/summary`, (route) => route.fulfill(fail("database unavailable"))]],
  });
}

// 2) 页面级错误 + 空态 + loading（以 1440 暗 / 390 亮为主）
for (const p of PAGES) {
  const isForwards = p.id === "forwards";
  const isPackages = p.id === "packages";
  const isOverview = p.id === "overview";

  // 空态：概览用「无套餐」；订阅用空节点；转发用无转发/无链/无用量；套餐用空实例/空事件。
  const emptyRoutes = isForwards
    ? [
        [`**/api/v1/me/forwards`, (r) => r.fulfill(json({ items: [], quota: { used: 0, limit: 0 } }))],
        [/\/api\/v1\/me\/forward-traffic\?days=/, (r) => r.fulfill(json({ days: [], by_forward: [], totals: { bytes: 0, weighted: 0 } }))],
        [`**/api/v1/me/chains`, (r) => r.fulfill(json({ items: [], quota: { used: 0, limit: 0 } }))],
        [`**/api/v1/me/chain-templates`, (r) => r.fulfill(json({ items: [], quota: { used: 0, limit: 0 } }))],
      ]
    : isPackages
      ? [
          [`**/api/v1/me/summary`, (r) => r.fulfill(json(emptySummary))],
          [/\/api\/v1\/me\/events\?limit=/, (r) => r.fulfill(json({ items: [] }))],
        ]
      : isOverview
        ? [
            [`**/api/v1/me/summary`, (r) => r.fulfill(json(emptySummary))],
            [/\/api\/v1\/me\/traffic\?days=/, (r) => r.fulfill(json({ days: [], total: 0 }))],
            [`**/api/v1/sessions`, (r) => r.fulfill(json({ items: [] }))],
            [`**/api/v1/me/logins`, (r) => r.fulfill(json({ items: [] }))],
          ]
        : [[`**/api/v1/me/summary`, (r) => r.fulfill(json({ ...summary, nodes: [] }))]];

  await shot({
    ...p, width: 1440, height: 900, theme: "dark", tag: "state", name: "empty", routes: emptyRoutes,
  });
  await shot({
    ...p, width: 390, height: 844, theme: "light", tag: "state", name: "empty",
    routes: emptyRoutes.map(([pattern, fn]) => [pattern, fn]),
  });

  const errorRoutes = isForwards
    ? [[`**/api/v1/me/forwards`, (r) => r.fulfill(fail("forward list exploded"))]]
    : isPackages
      ? [[/\/api\/v1\/me\/events\?limit=/, (r) => r.fulfill(fail("events exploded"))]]
      : isOverview
        ? [[/\/api\/v1\/me\/traffic\?days=/, (r) => r.fulfill(fail("traffic exploded"))]]
        : [];
  if (errorRoutes.length) {
    await shot({
      ...p, width: 1440, height: 900, theme: "dark", tag: "state", name: "error",
      routes: errorRoutes,
    });
    await shot({
      ...p, width: 390, height: 844, theme: "light", tag: "state", name: "error",
      routes: errorRoutes,
    });
  }
}

// 3) 加载态：延迟页面级查询 15s，截骨架
for (const p of PAGES) {
  const target = p.id === "forwards" ? `**/api/v1/me/forwards` : p.id === "packages" ? /\/api\/v1\/me\/events\?limit=/ : /\/api\/v1\/me\/traffic\?days=/;
  if (p.id === "subscription") continue; // 订阅页没有独立查询，加载态由壳层承担
  await shot({
    ...p, width: 1440, height: 900, theme: "dark", tag: "state", name: "loading",
    routes: [[target, async (route) => { await new Promise((r) => setTimeout(r, 15000)); await route.continue(); }]],
  });
}

// 4) 已知可疑：配额 2 / 0 与「不支持自助转发」同屏（后端在套餐过期/改额度后会返回这个组合）
await shot({
  id: "forwards", path: "/me/forwards", width: 1440, height: 900, theme: "dark", tag: "state", name: "quota-zero",
  routes: [[`**/api/v1/me/forwards`, (r) => r.fulfill(json({ ...forwards, quota: { used: forwards.items.length, limit: 0 } }))]],
});
await shot({
  id: "forwards", path: "/me/forwards", width: 390, height: 844, theme: "light", tag: "state", name: "quota-zero",
  routes: [[`**/api/v1/me/forwards`, (r) => r.fulfill(json({ ...forwards, quota: { used: forwards.items.length, limit: 0 } }))]],
});

// 5) 打开「新建转发」对话框：配额 3/5 但没有被授权服务器
{
  const context = await makeContext({ width: 1440, height: 900, theme: "dark" });
  const page = await context.newPage();
  await page.goto(`${BASE}/me/forwards`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const add = page.getByRole("button", { name: /新建转发/ });
  if (await add.count()) {
    await add.first().click();
    await page.waitForTimeout(400);
    const dialog = page.getByRole("dialog");
    const exists = await dialog.count();
    const dialogText = exists ? (await dialog.innerText()).slice(0, 1200) : null;
    const submit = page.getByRole("button", { name: /创建转发/ });
    const submitDisabled = (await submit.count()) ? await submit.first().isDisabled() : null;
    const serverSelect = await page.locator("#my-forward-server").count();
    await page.screenshot({ path: `${OUT}/states/forwards__create-no-servers__1440__dark.png`, fullPage: true });
    stateMetrics.push({
      file: `${OUT}/states/forwards__create-no-servers__1440__dark.png`,
      dialogExists: Boolean(exists),
      dialogText,
      submitDisabled,
      serverSelectCount: serverSelect,
    });
    console.log("saved forwards create dialog", { dialogExists: Boolean(exists), submitDisabled, serverSelect });
  }
  await context.close();
}

writeFileSync(`${OUT}/metrics.json`, JSON.stringify(metrics, null, 2));
writeFileSync(`${OUT}/state-metrics.json`, JSON.stringify(stateMetrics, null, 2));
await browser.close();
console.log("done");
