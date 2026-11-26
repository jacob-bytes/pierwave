#!/usr/bin/env node
/**
 * 输入模态焦点环的验收截图 / Acceptance screenshots for input-modality focus rings.
 *
 * 覆盖 / Covers:
 * - 点击概览「转发模板」子 tab 后：activeElement 仍匹配 `:focus-visible`，
 *   但计算样式 `outline-style: none`（没有 2px 蓝框）；
 * - 再按 Tab 进入主面板（`[role="tabpanel"]`）：面板由 `index.css` 的统一规则
 *   描边（`outline-style: solid`、2px、偏移 2px），`<html data-input>` 为 `keyboard`；
 * - 鼠标点击面板内容区空白：`<html data-input>` 回到 `pointer`，面板仍持有焦点，
 *   但统一焦点环被 `html[data-input="pointer"] :focus-visible` 清掉（`none`）；
 * - 按 Shift+Tab 回到子 tab 后：2px 焦点环恢复；
 * - 登录页输入框：鼠标点击不描边、键盘 Tab 后描边（不被误伤）；
 * - 1440 × 亮 / 暗，子 tab 与主面板各两张图。
 *
 * 用 Playwright 直接服务 `web/dist` 并在浏览器里 mock API，不需要主控 / 数据库。
 *
 * 用法 / Usage（仓库根执行 / run from the repo root）:
 *   make web-build
 *   node web/screenshots/input-modality/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DIST = resolve(ROOT, "dist");
const OUT = HERE;
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) {
    candidates.push(process.env.PLAYWRIGHT_MODULE);
  }
  const npxRoot = path.join(ROOT, "../.npm-cache/_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(
        path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs"),
      );
    }
  }
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (mod.chromium) return mod.chromium;
    } catch {
      /* try next */
    }
  }
  const mod = await import("playwright");
  return mod.chromium;
}

const chromium = await loadPlaywright();
mkdirSync(OUT, { recursive: true });

const GB = 1024 ** 3;
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const CHAIN_BUCKET = 900;
const CHAIN_COUNT = 96;
const CHAIN_END = Math.floor(NOW / CHAIN_BUCKET) * CHAIN_BUCKET;
const CHAIN_START = CHAIN_END - (CHAIN_COUNT - 1) * CHAIN_BUCKET;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// ---------------------------------------------------------------------------
// 数据 / Fixtures
// ---------------------------------------------------------------------------

const SERVERS = [
  {
    id: "srv-hk-01",
    name: "香港-01",
    group_name: "亚太",
    address: "203.0.113.11",
    status: "online",
    country_code: "HK",
  },
  {
    id: "srv-tokyo-01",
    name: "东京-01",
    group_name: "日本",
    address: "203.0.113.21",
    status: "online",
    country_code: "JP",
  },
];

function serverItem(def) {
  return {
    ...def,
    xray_mode: "auto",
    last_seen_at: NOW - 30,
    config_version: 4,
    created_at: NOW - 40 * 86400,
    agent_version: "0.18.1",
    allow_agent_upgrade: false,
    agent_target_version: null,
    node_count: 2,
    node_enabled_count: 2,
    node_protocols: ["vless"],
  };
}

const STATS = {
  servers: { total: SERVERS.length, online: 2 },
  users: { total: 6, active: 6 },
  packages: { total: 4, instances: 5 },
  traffic: { today_bytes: 32 * GB, month_bytes: 254 * GB },
  alerts: {
    expired_instances: 0,
    exhausted_instances: 0,
    offline_servers: 0,
    expiring_certs: 0,
  },
};

const TRAFFIC_DAYS = Array.from({ length: 7 }, (_, index) => ({
  date: `2026-11-${16 + index}`,
  uplink: (index + 2) * GB,
  downlink: (index + 5) * GB,
  weighted: (index + 7) * GB,
}));

const AGGREGATE = {
  kpi: {
    servers_online: 2,
    servers_total: SERVERS.length,
    nodes: 4,
    traffic_today: 32 * GB,
    traffic_month: 254 * GB,
    uptime_24h: 99.2,
  },
  series: TRAFFIC_DAYS,
  protocol_series: [],
  protocols: [],
  chains: {
    total: 2,
    degraded: 0,
    blocked: 0,
    forwards_total: 2,
    forwards_failing: 0,
    handshake_failures: 0,
  },
  top: [],
  alerts: [],
};

function chainPoint(index, base) {
  const wave = Math.sin((index + base) / 5) * 2.4;
  return {
    ts: CHAIN_START + index * CHAIN_BUCKET,
    p50: Number((base + wave).toFixed(1)),
    p10: Number((base + wave - 4).toFixed(1)),
    p90: Number((base + wave + 5).toFixed(1)),
    samples: 10,
    loss_pct: 0.4,
  };
}

function chainSeries(base) {
  return Array.from({ length: CHAIN_COUNT }, (_, index) =>
    chainPoint(index, base),
  );
}

function chainEntry({ id, name, base, entry, exit, nodes }) {
  const segments = [];
  for (let index = 1; index < nodes.length; index += 1) {
    segments.push({
      seq: index,
      from: nodes[index - 1].name,
      to: nodes[index].name,
      series: chainSeries(base + index),
      p50: base + index,
      delta_ms: 0,
      contribution_pct: 50,
      attempts: 5280,
      failures: 8,
      loss_pct: 0.15,
    });
  }
  return {
    id,
    name,
    hops: nodes.length,
    estimated: false,
    missing_hops: [],
    last_hop: { measurable: true, reason: null },
    status: { kind: "ok" },
    entry,
    exit,
    nodes,
    series: chainSeries(base),
    segments,
    loss_pct: 0.42,
    loss_samples: { attempts: 5280, failures: 22 },
    loss_partial: false,
    diagnosis: { kind: "overall" },
  };
}

const CHAINS = [
  chainEntry({
    id: "chain-hk-jp",
    name: "港日直达",
    base: 42,
    entry: {
      server_id: "srv-hk-01",
      server_name: "香港-01",
      address: "203.0.113.11:21001",
    },
    exit: {
      server_id: "srv-tokyo-01",
      server_name: "东京-01",
      address: "203.0.113.21:21002",
    },
    nodes: [
      {
        seq: 0,
        server_id: "srv-hk-01",
        name: "香港入口",
        role: "source",
        status: "online",
        member_count: 1,
        members: [
          { server_id: "srv-hk-01", name: "香港-01", status: "online" },
        ],
      },
      {
        seq: 1,
        server_id: "srv-tokyo-01",
        name: "东京出口",
        role: "hop",
        status: "online",
        member_count: 1,
        members: [
          { server_id: "srv-tokyo-01", name: "东京-01", status: "online" },
        ],
      },
    ],
  }),
  chainEntry({
    id: "chain-hk-tokyo",
    name: "港日中转",
    base: 58,
    entry: {
      server_id: "srv-hk-01",
      server_name: "香港-01",
      address: "203.0.113.11:21011",
    },
    exit: {
      server_id: "srv-tokyo-01",
      server_name: "东京-01",
      address: "203.0.113.21:21012",
    },
    nodes: [
      {
        seq: 0,
        server_id: "srv-hk-01",
        name: "香港入口",
        role: "source",
        status: "online",
        member_count: 1,
        members: [
          { server_id: "srv-hk-01", name: "香港-01", status: "online" },
        ],
      },
      {
        seq: 1,
        server_id: "srv-tokyo-01",
        name: "东京出口",
        role: "hop",
        status: "online",
        member_count: 1,
        members: [
          { server_id: "srv-tokyo-01", name: "东京-01", status: "online" },
        ],
      },
    ],
  }),
];

const TEMPLATES = [
  {
    id: "tpl-apac",
    name: "亚太三跳",
    hops: 3,
    enabled: true,
    chains: 2,
    users: 1,
    status: { kind: "ok", cause: null },
    strategies: [],
    targets: [],
  },
  {
    id: "tpl-backup",
    name: "备份双线",
    hops: 2,
    enabled: true,
    chains: 1,
    users: 1,
    status: { kind: "degraded", cause: "slow" },
    strategies: [],
    targets: [],
  },
];

// ---------------------------------------------------------------------------
// API mock / 静态文件服务
// ---------------------------------------------------------------------------

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function handleApi(route, { loggedOut }) {
  const pathname = new URL(route.request().url()).pathname;

  if (pathname === "/api/v1/auth/me") {
    if (loggedOut) {
      return json(route, { error: "unauthorized", code: "unauthorized" }, 401);
    }
    return json(route, {
      user: { id: "u-admin", username: "admin", role: "admin", short_code: "AD" },
    });
  }
  if (pathname === "/api/v1/health") {
    return json(route, {
      status: "ok",
      version: "0.18.1",
      panel_name: "PierWave",
    });
  }
  if (pathname === "/api/v1/overview") {
    return json(route, AGGREGATE);
  }
  if (pathname === "/api/v1/stats/overview") {
    return json(route, STATS);
  }
  if (pathname === "/api/v1/stats/traffic") {
    return json(route, { days: TRAFFIC_DAYS });
  }
  if (pathname === "/api/v1/servers") {
    return json(route, { items: SERVERS.map(serverItem) });
  }
  if (pathname === "/api/v1/chains") {
    return json(route, { items: [] });
  }
  if (pathname === "/api/v1/chain-templates") {
    return json(route, { items: [] });
  }
  if (pathname === "/api/v1/overview/chain-health") {
    return json(route, {
      generated_at: NOW,
      hours: 24,
      bucket: CHAIN_BUCKET,
      chains: CHAINS,
    });
  }
  if (pathname === "/api/v1/overview/chain-templates") {
    return json(route, { generated_at: NOW, items: TEMPLATES });
  }
  if (pathname === "/api/v1/updates") {
    return json(route, {
      master: {
        current: "0.18.1",
        latest: "0.18.1",
        update_available: false,
        release_url: null,
        released_at: null,
        checked_at: NOW,
        error: null,
      },
      agents: {
        current_protocol: 1,
        min_supported: 1,
        versions: [{ version: "0.18.1", count: SERVERS.length }],
      },
    });
  }
  if (pathname === "/api/v1/enforcement/events") {
    return json(route, { items: [] });
  }
  if (pathname === "/api/v1/settings") {
    return json(route, { items: {}, secret_errors: null });
  }

  return json(route, { error: "not found", code: "not_found" }, 404);
}

function startStaticServer() {
  const distPrefix = DIST.endsWith(sep) ? DIST : `${DIST}${sep}`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    let file = resolve(DIST, relative || "index.html");
    if (file !== DIST && !file.startsWith(distPrefix)) {
      response.writeHead(403);
      response.end("forbidden");
      return;
    }
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = resolve(file, "index.html");
      const body = await readFile(file);
      response.writeHead(200, {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch {
      try {
        const body = await readFile(resolve(DIST, "index.html"));
        response.writeHead(200, { "Content-Type": TYPES[".html"] });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end("not found");
      }
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({ server, port: server.address().port });
    });
  });
}

const { server, port } = await startStaticServer();
const BASE = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const shots = [];
const checks = [];

async function openPage({ theme, loggedOut = false, path: target = "/" }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(
    ({ theme }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", "zh-CN");
    },
    { theme },
  );
  await page.route("**/api/v1/**", (route) => handleApi(route, { loggedOut }));
  await page.goto(`${BASE}${target}`, { waitUntil: "domcontentloaded" });
  return { context, page, errors };
}

/** 读 activeElement 的焦点环计算样式 + 全局输入模态。 */
function readFocus(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    const style = active ? getComputedStyle(active) : null;
    return {
      modality: document.documentElement.dataset.input ?? null,
      tag: active?.tagName ?? null,
      text: active?.textContent?.trim().slice(0, 40) ?? null,
      focusVisible: active?.matches?.(":focus-visible") ?? false,
      outlineStyle: style?.outlineStyle ?? null,
      outlineWidth: style?.outlineWidth ?? null,
      outlineOffset: style?.outlineOffset ?? null,
      outlineColor: style?.outlineColor ?? null,
      boxShadow: style?.boxShadow ?? null,
    };
  });
}

/** 读当前可见 tabpanel 自身的焦点环 + 指针模态（面板可能不是 activeElement）。 */
function readPanelFocus(page) {
  return page.evaluate(() => {
    const panel = [...document.querySelectorAll('[role="tabpanel"]')].find(
      (candidate) => candidate.getClientRects().length > 0,
    );
    if (!panel) return null;
    const style = getComputedStyle(panel);
    return {
      modality: document.documentElement.dataset.input ?? null,
      tag: panel.tagName,
      focused: document.activeElement === panel,
      focusVisible: panel.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
      outlineColor: style.outlineColor,
    };
  });
}

/**
 * 点面板内容区的非交互空白：面板可聚焦，点它自己的内容区才不会把焦点
 * 交给别的控件。从右下角向内找第一个不在链接 / 按钮 / 输入框里的点。
 */
async function clickPanelBlank(page) {
  const point = await page.evaluate(() => {
    const panel = [...document.querySelectorAll('[role="tabpanel"]')].find(
      (candidate) => candidate.getClientRects().length > 0,
    );
    if (!panel) return null;
    panel.scrollIntoView({ block: "center" });
    const rect = panel.getBoundingClientRect();
    const focusable =
      'a,button,input,select,textarea,[role="button"],[role="tab"],[role="link"],[contenteditable="true"]';
    const lastX = Math.min(rect.right, window.innerWidth) - 2;
    const lastY = Math.min(rect.bottom, window.innerHeight) - 2;
    for (let y = lastY; y > Math.max(rect.top, 0) + 1; y -= 2) {
      for (let x = lastX; x > Math.max(rect.left, 0) + 1; x -= 2) {
        const element = document.elementFromPoint(x, y);
        if (!element || !panel.contains(element) || element === panel) continue;
        if (element.closest(focusable)) continue;
        return { x, y };
      }
    }
    return null;
  });
  assert.ok(point, "找不到面板内容区的空白点 / no blank spot inside the tab panel");
  await page.mouse.click(point.x, point.y);
  return point;
}

/** box-shadow 里有非透明层才算「看得见的 ring」；全透明层等于没有。 */
function hasVisibleShadow(value) {
  if (!value || value === "none") return false;
  return value
    .replace(/rgba\(0, 0, 0, 0\)/g, "#0000")
    .split(/,(?![^(]*\))/)
    .some((part) => !/#0000|transparent/.test(part));
}

async function settle(page) {
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(
    () =>
      new Promise((resolvePromise) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolvePromise(null)),
        );
      }),
  );
  await page.waitForTimeout(300);
}

async function screenshot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  shots.push(name);
  console.log(`saved ${name}.png`);
}

/** 页面没进入预期状态时把错误和可见文本打出来，避免只看到 waitForSelector 超时。 */
async function waitForUi(page, selector, errors) {
  try {
    await page.waitForSelector(selector, { timeout: 20000 });
  } catch (error) {
    console.error(`等待 ${selector} 失败 / failed:`, errors);
    console.error((await page.locator("body").innerText()).slice(0, 1200));
    await page.screenshot({ path: `${OUT}/_debug.png` });
    throw error;
  }
}

function record(label, state) {
  checks.push({ label, ...state });
  console.log(`  ${label}: ${JSON.stringify(state)}`);
}

for (const theme of ["dark", "light"]) {
  const { context, page, errors } = await openPage({
    theme,
    path: "/?view=chain",
  });

  await waitForUi(page, "[data-chain-list]", errors);
  const templateTab = page.getByRole("tab", { name: "转发模板", exact: true });
  await templateTab.click();
  await waitForUi(page, "[data-chain-template-insight]", errors);
  await settle(page);

  // 1) 鼠标点击：activeElement 仍是子 tab，浏览器仍判 :focus-visible，
  //    但指针模态下 outline 必须是 none（不能出现 2px 蓝框）。
  const clicked = await readFocus(page);
  record(`点击后 / after click (${theme})`, clicked);
  assert.equal(clicked.modality, "pointer");
  assert.equal(clicked.text, "转发模板");
  assert.equal(clicked.focusVisible, true, "浏览器仍报告 focus-visible");
  assert.equal(clicked.outlineStyle, "none", "指针模态不应描边");
  assert.equal(
    hasVisibleShadow(clicked.boxShadow),
    false,
    "指针模态不应留 ring 阴影",
  );
  await screenshot(page, `no-ring-after-click-1440-${theme}`);

  // 2) 键盘继续 Tab：焦点从子 tab 进入主面板（Radix tabpanel，tabIndex=0）。
  //    keydown 把 html 切到 keyboard，index.css 的统一规则命中面板：2px + 偏移 2px。
  await page.keyboard.press("Tab");
  await settle(page);
  const panelTabbed = await readPanelFocus(page);
  record(`键盘 Tab 到面板后 / panel after Tab (${theme})`, panelTabbed);
  assert.equal(panelTabbed.modality, "keyboard");
  assert.equal(panelTabbed.tag, "DIV");
  assert.equal(panelTabbed.focused, true, "Tab 应把焦点交给面板");
  assert.equal(panelTabbed.focusVisible, true);
  assert.equal(panelTabbed.outlineStyle, "solid", "键盘模态下面板必须有焦点环");
  assert.equal(panelTabbed.outlineWidth, "2px");
  assert.equal(panelTabbed.outlineOffset, "2px");
  assert.notEqual(panelTabbed.outlineColor, "rgba(0, 0, 0, 0)");
  await screenshot(page, `panel-ring-after-tab-1440-${theme}`);

  // 3) 焦点还在面板上时用鼠标点面板内容区空白：面板仍是 activeElement、
  //    仍匹配 `:focus-visible`，但指针模态的全局规则把环清掉，只剩 `none`。
  await clickPanelBlank(page);
  await settle(page);
  const panelClicked = await readPanelFocus(page);
  record(`点击面板空白后 / panel after click (${theme})`, panelClicked);
  assert.equal(panelClicked.modality, "pointer");
  assert.equal(panelClicked.focused, true, "点击面板内容后焦点仍应在面板上");
  assert.equal(panelClicked.focusVisible, true);
  assert.equal(panelClicked.outlineStyle, "none", "指针模态下面板不应描边");
  await screenshot(page, `panel-no-ring-after-click-1440-${theme}`);

  // 4) Shift+Tab 回到同一个子 tab：焦点环留在 tab 上，面板让出焦点。
  await page.keyboard.press("Shift+Tab");
  await settle(page);
  const tabbed = await readFocus(page);
  record(`键盘 Tab 后 / after Tab (${theme})`, tabbed);
  assert.equal(tabbed.modality, "keyboard");
  assert.equal(tabbed.text, "转发模板");
  assert.equal(tabbed.focusVisible, true);
  assert.equal(tabbed.outlineStyle, "solid", "键盘模态必须有焦点环");
  assert.equal(tabbed.outlineWidth, "2px");
  assert.notEqual(tabbed.outlineColor, "rgba(0, 0, 0, 0)");
  await screenshot(page, `ring-after-tab-1440-${theme}`);

  assert.deepEqual(errors, [], `${theme}: 不应有失败请求 / console 错误`);
  await context.close();
}

// 3) 登录页输入框：鼠标点击不描边，键盘 Tab 后描边。
{
  const { context, page, errors } = await openPage({
    theme: "dark",
    loggedOut: true,
    path: "/login",
  });
  await page.waitForSelector("#login-username");
  await settle(page);

  await page.click("#login-username");
  const clicked = await readFocus(page);
  record("登录输入框点击后 / login input after click", clicked);
  assert.equal(clicked.modality, "pointer");
  assert.equal(clicked.tag, "INPUT");
  assert.equal(clicked.focusVisible, true);
  assert.equal(clicked.outlineStyle, "none");
  assert.equal(
    hasVisibleShadow(clicked.boxShadow),
    false,
    "指针模态不应留 ring 阴影",
  );

  await page.keyboard.press("Tab"); // 密码框
  await page.keyboard.press("Shift+Tab"); // 回到用户名框
  await settle(page);
  const tabbed = await readFocus(page);
  record("登录输入框键盘 Tab 后 / login input after Tab", tabbed);
  assert.equal(tabbed.modality, "keyboard");
  assert.equal(tabbed.tag, "INPUT");
  assert.equal(tabbed.text !== null, true);
  assert.equal(tabbed.outlineStyle, "solid");
  assert.equal(tabbed.outlineWidth, "2px");

  // 未登录访问 /login 时 /auth/me 返回 401 是预期行为，其余请求 / 报错不允许出现。
  const unexpectedErrors = errors.filter(
    (entry) => !entry.includes("401"),
  );
  assert.deepEqual(unexpectedErrors, [], "登录页不应有其它失败请求 / console 错误");
  await context.close();
}

await browser.close();
server.close();

writeFileSync(
  path.join(OUT, "report.json"),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), base: BASE, shots, checks },
    null,
    2,
  ),
);
console.log(`\n${shots.length} screenshots + ${checks.length} checks saved to ${OUT}`);
