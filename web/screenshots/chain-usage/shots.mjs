#!/usr/bin/env node
/**
 * 「转发用量」并入概览 → 链路时延的验收截图 / Acceptance screenshots for the
 * merged forward-usage subpage.
 *
 * 覆盖 / Covers:
 * - 三个子页（转发链 / 转发模板 / 转发用量）的顺序与 URL；
 * - 用量子页 7 / 30 天窗口、空态、错误态、用户筛选；
 * - 1440 / 390 × 亮 / 暗，390 无横向溢出；
 * - 侧边栏不再有「转发用量」入口；
 * - 旧 `/forward-usage` 地址重定向到 `/?view=chain&section=usage`；
 * - 切子页不覆盖 `status` / `q` / `series`，离开链路时延清理 `section`；
 * - 用量子页的 `/api/v1/forward-traffic` 请求**不带** `server_ids`（后端尚不支持）。
 *
 * 用 Playwright 直接服务 `web/dist` 并在浏览器里 mock API，不需要主控 / 数据库。
 * Playwright 复用仓库内 npx 缓存，不新增依赖。
 *
 * 用法 / Usage:
 *   cd web && npm run build
 *   node screenshots/chain-usage/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
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
  {
    id: "srv-sg-01",
    name: "新加坡-01",
    group_name: "亚太",
    address: "203.0.113.31",
    status: "offline",
    country_code: "SG",
  },
];

function serverItem(def) {
  return {
    ...def,
    xray_mode: "auto",
    last_seen_at: def.status === "online" ? NOW - 30 : NOW - 3 * HOUR,
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
    offline_servers: 1,
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
    nodes: 6,
    traffic_today: 32 * GB,
    traffic_month: 254 * GB,
    uptime_24h: 96.4,
  },
  series: TRAFFIC_DAYS,
  protocol_series: [],
  protocols: [],
  chains: {
    total: 3,
    degraded: 1,
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
    loss_pct: index % 17 === 0 ? 2.5 : 0.4,
  };
}

function chainSeries(base, holes = []) {
  return Array.from({ length: CHAIN_COUNT }, (_, index) =>
    holes.includes(index) ? null : chainPoint(index, base),
  );
}

function chainSegment(seq, from, to, base) {
  return {
    seq,
    from,
    to,
    series: chainSeries(base),
    p50: base,
    delta_ms: 0,
    contribution_pct: 50,
    attempts: 5280,
    failures: 8,
    loss_pct: 0.15,
  };
}

function chainEntry({
  id,
  name,
  entry,
  exit,
  nodes,
  base,
  status = { kind: "ok" },
  lossPct = 0.42,
  holes = [],
}) {
  const segments = [];
  for (let index = 1; index < nodes.length; index += 1) {
    segments.push(
      chainSegment(index, nodes[index - 1].name, nodes[index].name, base + index),
    );
  }
  return {
    id,
    name,
    hops: nodes.length,
    estimated: false,
    missing_hops: [],
    last_hop: { measurable: true, reason: null },
    status,
    entry: {
      server_id: entry.server_id,
      server_name: entry.server_name,
      address: entry.address,
      ip: entry.address.split(":")[0],
      port: Number(entry.address.split(":")[1]),
    },
    exit: {
      server_id: exit.server_id,
      server_name: exit.server_name,
      address: exit.address,
      ip: exit.address.split(":")[0],
      port: Number(exit.address.split(":")[1]),
    },
    nodes,
    series: chainSeries(base, holes),
    segments,
    loss_pct: lossPct,
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
        members: [{ server_id: "srv-hk-01", name: "香港-01", status: "online" }],
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
    id: "chain-hk-sg",
    name: "港新中转",
    base: 58,
    lossPct: 3.06,
    holes: [88, 89, 90],
    entry: {
      server_id: "srv-hk-01",
      server_name: "香港-01",
      address: "203.0.113.11:21011",
    },
    exit: {
      server_id: "srv-sg-01",
      server_name: "新加坡-01",
      address: "203.0.113.31:21012",
    },
    nodes: [
      {
        seq: 0,
        server_id: "srv-hk-01",
        name: "香港入口",
        role: "source",
        status: "online",
        member_count: 1,
        members: [{ server_id: "srv-hk-01", name: "香港-01", status: "online" }],
      },
      {
        seq: 1,
        server_id: "srv-tokyo-01",
        name: "东京中转",
        role: "hop",
        status: "online",
        member_count: 1,
        members: [
          { server_id: "srv-tokyo-01", name: "东京-01", status: "online" },
        ],
      },
      {
        seq: 2,
        server_id: "srv-sg-01",
        name: "新加坡出口",
        role: "hop",
        status: "offline",
        member_count: 1,
        members: [
          { server_id: "srv-sg-01", name: "新加坡-01", status: "offline" },
        ],
      },
    ],
  }),
  chainEntry({
    id: "chain-jp-osaka",
    name: "东京大阪双线",
    base: 37,
    status: { kind: "degraded", cause: "slow" },
    entry: {
      server_id: "srv-tokyo-01",
      server_name: "东京-01",
      address: "203.0.113.21:21021",
    },
    exit: {
      server_id: "srv-hk-01",
      server_name: "香港-01",
      address: "203.0.113.11:21022",
    },
    nodes: [
      {
        seq: 0,
        server_id: "srv-tokyo-01",
        name: "东京入口",
        role: "source",
        status: "online",
        member_count: 1,
        members: [
          { server_id: "srv-tokyo-01", name: "东京-01", status: "online" },
        ],
      },
      {
        seq: 1,
        server_id: "srv-hk-01",
        name: "香港出口",
        role: "hop",
        status: "online",
        member_count: 1,
        members: [{ server_id: "srv-hk-01", name: "香港-01", status: "online" }],
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

const USAGE_ROWS = [
  {
    forward_id: "fw-fra",
    name: "法兰克福 · 中转",
    user_id: "u-bob",
    user_name: "bob",
    bytes: 18.4 * GB,
    weighted: 22.1 * GB,
  },
  {
    forward_id: "fw-hk",
    name: "香港 · 游戏",
    user_id: "u-alice",
    user_name: "alice",
    bytes: 9.2 * GB,
    weighted: 9.2 * GB,
  },
  {
    forward_id: "fw-sg",
    name: "新加坡 · 备份",
    user_id: "u-carol",
    user_name: "carol",
    bytes: 3.4 * GB,
    weighted: 6.8 * GB,
  },
];

function forwardUsage(days, mode) {
  const dayRows = Array.from({ length: days }, (_, index) => {
    const date = new Date((NOW - (days - 1 - index) * 86400) * 1000)
      .toISOString()
      .slice(0, 10);
    if (mode !== "normal") {
      return { day: date, bytes: 0, weighted: 0 };
    }
    const raw = (1.2 + (index % 5) * 0.35) * GB;
    return {
      day: date,
      bytes: Math.round(raw),
      weighted: Math.round(raw * 1.2),
    };
  });
  if (mode !== "normal") {
    return {
      totals: { bytes: 0, weighted: 0 },
      days: dayRows,
      by_forward: [],
    };
  }
  const scale = days / 7;
  const byForward = USAGE_ROWS.map((row) => ({
    ...row,
    bytes: Math.round(row.bytes * scale),
    weighted: Math.round(row.weighted * scale),
  }));
  const totals = byForward.reduce(
    (acc, row) => ({
      bytes: acc.bytes + row.bytes,
      weighted: acc.weighted + row.weighted,
    }),
    { bytes: 0, weighted: 0 },
  );
  return { totals, days: dayRows, by_forward: byForward };
}

function chainHealth() {
  return {
    generated_at: NOW,
    hours: 24,
    bucket: CHAIN_BUCKET,
    chains: CHAINS,
  };
}

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

async function handleApi(route, mock) {
  const url = new URL(route.request().url());
  const pathname = url.pathname;

  if (pathname === "/api/v1/auth/me") {
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
  if (pathname === "/api/v1/overview/chain-health") {
    const data = chainHealth();
    const ids =
      url.searchParams
        .get("server_ids")
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean) ?? [];
    if (ids.length > 0) {
      data.scope = {
        server_ids: ids,
        servers_matched: ids.length,
        filtered: true,
      };
      data.chains = data.chains.filter((chain) =>
        chain.nodes.some(
          (node) => node.server_id !== null && ids.includes(node.server_id),
        ),
      );
    }
    return json(route, data);
  }
  if (pathname === "/api/v1/overview/chain-templates") {
    return json(route, { generated_at: NOW, items: TEMPLATES });
  }
  if (pathname === "/api/v1/forward-traffic") {
    if (mock === "usage-error") {
      return json(route, { error: "boom", code: "internal" }, 500);
    }
    const days = Number(url.searchParams.get("days") ?? 7);
    const mode = mock === "usage-empty" ? "empty" : "normal";
    return json(route, forwardUsage(Number.isFinite(days) ? days : 7, mode));
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
const saved = [];

function query(page) {
  return new URL(page.url()).searchParams;
}

async function openPage({
  width = 1440,
  height = 1000,
  theme = "dark",
  locale = "zh-CN",
  mock = "normal",
  path: target = "/",
} = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const apiUrls = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v1/")) apiUrls.push(url);
  });
  await page.addInitScript(
    ({ theme, locale }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale },
  );
  await page.route("**/api/v1/**", (route) => handleApi(route, mock));
  await page.goto(`${BASE}${target}`, { waitUntil: "domcontentloaded" });
  return { context, page, errors, apiUrls };
}

async function shot(page, name, { fullPage = false } = {}) {
  // 点击 tab 后浏览器会把焦点留在触发器上，截图会多出一圈 focus ring；
  // 验收图看的是选中态的下划线，这里先移开焦点再拍。
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  saved.push(name);
  console.log(`saved ${name}.png`);
}

async function activeTabText(page) {
  return page
    .locator('[data-chain-section-tabs] [data-state="active"]')
    .first()
    .innerText();
}

async function subtabLabels(page) {
  return page
    .locator('[data-chain-section-tabs] [data-slot="tabs-trigger"]')
    .allInnerTexts();
}

function assertNoHorizontalOverflow(page, label) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
      main: main ? main.scrollWidth : 0,
      mainClient: main ? main.clientWidth : 0,
    };
  }).then((sizes) => {
    assert.ok(sizes.doc <= sizes.win + 1, `${label}: document overflows horizontally`);
    assert.ok(
      sizes.main <= sizes.mainClient + 1,
      `${label}: main content overflows horizontally (${sizes.main} > ${sizes.mainClient})`,
    );
  });
}

// ---------------------------------------------------------------------------
// 1) 三个子页在 1440 / 390 × 亮暗下的截图与 URL / 顺序断言
// ---------------------------------------------------------------------------
for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    const height = width === 390 ? 900 : 1000;
    const { page, context, errors, apiUrls } = await openPage({
      width,
      height,
      theme,
      path: "/?view=chain",
    });
    await page.waitForSelector("[data-chain-list]");

    // 子页顺序 + 默认值。
    assert.deepEqual(await subtabLabels(page), [
      "转发链",
      "转发模板",
      "转发用量",
    ]);
    assert.equal(await activeTabText(page), "转发链");
    assert.equal(query(page).get("view"), "chain");
    assert.equal(query(page).get("section"), null, "default chains writes no section");

    // 侧边栏不再有旧入口。
    const navText = await page.locator("aside nav").first().innerText();
    assert.ok(!navText.includes("转发用量"), "sidebar still has the usage entry");
    assert.ok(!navText.includes("Forward usage"), "sidebar still has the usage entry (en)");

    await shot(page, `chains-${width}-${theme}`, { fullPage: width === 1440 });

    await page.getByRole("tab", { name: "转发模板" }).click();
    await page.waitForSelector("[data-chain-template-insight]");
    assert.equal(query(page).get("section"), "templates");
    assert.equal(await activeTabText(page), "转发模板");
    await shot(page, `templates-${width}-${theme}`, { fullPage: width === 1440 });

    await page.getByRole("tab", { name: "转发用量" }).click();
    await page.waitForSelector("[data-chain-usage]");
    await page.getByText("法兰克福 · 中转", { exact: true }).waitFor();
    assert.equal(query(page).get("section"), "usage");
    assert.equal(query(page).get("view"), "chain");
    assert.equal(await activeTabText(page), "转发用量");

    // 旧入口已经不存在，页面级标题也已去掉：只剩子 tab 上的「转发用量」。
    const headers = await page.locator("h1, h2").allInnerTexts();
    assert.ok(
      !headers.includes("转发用量"),
      "page-level usage title must be gone",
    );

    if (width === 390) {
      await assertNoHorizontalOverflow(page, `usage-390-${theme}`);
    }
    await shot(page, `usage-7d-${width}-${theme}`, { fullPage: width === 1440 });

    // 30 天窗口：按钮状态 + 请求参数 + 合计数字都跟着变。
    const usageRequestsBefore = apiUrls.filter(
      (url) => url.pathname === "/api/v1/forward-traffic",
    );
    assert.ok(usageRequestsBefore.length >= 1, "usage request expected");
    assert.ok(
      usageRequestsBefore.some((url) => url.searchParams.get("days") === "7"),
      "default window must request 7 days",
    );
    await page.getByRole("button", { name: "30 天" }).click();
    await page.getByText("按天", { exact: true }).waitFor();
    await page.waitForTimeout(350);
    assert.equal(
      await page.getByRole("button", { name: "30 天" }).getAttribute("aria-pressed"),
      "true",
    );
    assert.ok(
      apiUrls.some(
        (url) =>
          url.pathname === "/api/v1/forward-traffic" &&
          url.searchParams.get("days") === "30" &&
          url.searchParams.get("server_ids") === null,
      ),
      "30-day usage request expected without server_ids",
    );
    await shot(page, `usage-30d-${width}-${theme}`, {
      fullPage: width === 1440,
    });

    // 刷新后窗口回到默认 7 天：URL 不存窗口，子页仍保持 usage。
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-chain-usage]");
    await page.getByText("法兰克福 · 中转", { exact: true }).waitFor();
    assert.equal(query(page).get("section"), "usage");
    assert.equal(
      await page.getByRole("button", { name: "7 天" }).getAttribute("aria-pressed"),
      "true",
    );

    // 离开链路时延主 tab：section 必须清理。
    await page.getByRole("tab", { name: "流量趋势" }).click();
    await page.waitForSelector("[data-traffic-view]");
    assert.equal(query(page).get("view"), "traffic");
    assert.equal(query(page).get("section"), null);
    assert.equal(await page.locator("[data-chain-section-tabs]").count(), 0);
    await page.getByRole("tab", { name: "链路时延" }).click();
    await page.waitForSelector("[data-chain-list]");
    assert.equal(query(page).get("section"), null);
    assert.equal(await activeTabText(page), "转发链");

    assert.deepEqual(errors, [], `${width}/${theme}: page errors`);
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// 2) 用户筛选（选 bob）与空态 / 错误态
// ---------------------------------------------------------------------------
{
  const { page, context, errors } = await openPage({
    theme: "dark",
    path: "/?view=chain&section=usage",
  });
  await page.waitForSelector("[data-chain-usage]");
  await page.getByText("法兰克福 · 中转", { exact: true }).waitFor();
  await page.locator('[aria-label="按用户筛选"]').click();
  await page.getByRole("option", { name: "bob", exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(
    await page.getByText("香港 · 游戏", { exact: true }).count(),
    0,
    "user filter must hide other users",
  );
  await shot(page, "usage-filter-bob-1440-dark");
  assert.deepEqual(errors, []);
  await context.close();
}

for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    const { page, context, errors } = await openPage({
      width,
      height: width === 390 ? 900 : 1000,
      theme,
      mock: "usage-empty",
      path: "/?view=chain&section=usage",
    });
    await page.waitForSelector("[data-chain-usage]");
    await page.getByText("近 7 天没有转发用量", { exact: true }).waitFor();
    if (width === 390) {
      await assertNoHorizontalOverflow(page, `usage-empty-390-${theme}`);
    }
    await shot(page, `usage-empty-${width}-${theme}`, {
      fullPage: width === 1440,
    });
    assert.deepEqual(errors, []);
    await context.close();
  }
}

{
  const { page, context, errors } = await openPage({
    theme: "dark",
    mock: "usage-error",
    path: "/?view=chain&section=usage",
  });
  await page.waitForSelector("[data-chain-usage]");
  await page.getByText("转发用量加载失败", { exact: true }).waitFor();
  await shot(page, "usage-error-1440-dark", { fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
}

// ---------------------------------------------------------------------------
// 3) 旧链接重定向 / 侧边栏 / 参数互不覆盖 / 服务器筛选不传给用量接口
// ---------------------------------------------------------------------------
{
  const { page, context, errors } = await openPage({
    theme: "dark",
    path: "/forward-usage",
  });
  await page.waitForSelector("[data-chain-usage]");
  await page.getByText("法兰克福 · 中转", { exact: true }).waitFor();
  const url = new URL(page.url());
  assert.equal(url.pathname, "/");
  assert.equal(url.searchParams.get("view"), "chain");
  assert.equal(url.searchParams.get("section"), "usage");
  assert.equal(await activeTabText(page), "转发用量");
  await shot(page, "legacy-redirect-usage-1440-dark", { fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
}

{
  // 侧边栏展开态：整屏截图；导航里不再有「转发用量」。
  const { page, context, errors } = await openPage({
    width: 1440,
    theme: "light",
    path: "/?view=chain&section=usage",
  });
  await page.waitForSelector("[data-chain-usage]");
  await page.getByText("法兰克福 · 中转", { exact: true }).waitFor();
  const navText = await page.locator("aside nav").first().innerText();
  for (const label of ["概览", "服务器", "用户", "订阅", "套餐", "转发链", "链模板", "节点", "日志", "设置"]) {
    assert.ok(navText.includes(label), `sidebar missing ${label}`);
  }
  assert.ok(!navText.includes("转发用量"));
  await shot(page, "sidebar-no-usage-entry-1440-light", { fullPage: false });
  assert.deepEqual(errors, []);
  await context.close();
}

{
  // 参数互不覆盖：切子页保留 status / q / series，改筛选也不改 section。
  const target =
    "/?view=chain&section=chains&status=blocked&q=%E6%B8%AF&series=chain-hk-jp&servers=srv-hk-01";
  const { page, context, errors } = await openPage({ theme: "dark", path: target });
  await page.waitForSelector("[data-chain-list]");
  const expected = {
    status: "blocked",
    q: "港",
    series: "chain-hk-jp",
    servers: "srv-hk-01",
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(query(page).get(key), value, `initial ${key}`);
  }

  await page.getByRole("tab", { name: "转发用量" }).click();
  await page.waitForSelector("[data-chain-usage]");
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(query(page).get(key), value, `${key} lost after switching to usage`);
  }
  await page.getByRole("tab", { name: "转发模板" }).click();
  await page.waitForSelector("[data-chain-template-insight]");
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(query(page).get(key), value, `${key} lost after switching to templates`);
  }
  await page.getByRole("tab", { name: "转发链" }).click();
  await page.waitForSelector("[data-chain-list]");
  assert.equal(query(page).get("section"), null);
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(query(page).get(key), value, `${key} lost after switching back`);
  }

  // 在链路列表里改筛选：section 不会被筛选写入逻辑覆盖（此处本就没有 section）。
  await page.locator("[data-chain-status-filter]").click();
  await page.locator('[data-chain-status-option="all"]').click();
  await page.waitForTimeout(200);
  assert.equal(query(page).get("status"), null);
  assert.equal(query(page).get("q"), "港");
  assert.equal(query(page).get("series"), "chain-hk-jp");
  assert.equal(query(page).get("section"), null);
  await shot(page, "params-preserved-1440-dark", { fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
}

{
  // 服务器筛选：用量接口不能带 server_ids，也不出现「筛选生效」提示。
  const { page, context, errors, apiUrls } = await openPage({
    theme: "dark",
    path: "/?view=chain&section=usage&servers=srv-hk-01",
  });
  await page.waitForSelector("[data-chain-usage]");
  await page.getByText("法兰克福 · 中转", { exact: true }).waitFor();
  const requests = apiUrls.filter(
    (url) => url.pathname === "/api/v1/forward-traffic",
  );
  assert.ok(requests.length > 0, "forward-traffic request expected");
  for (const request of requests) {
    assert.equal(
      request.searchParams.get("server_ids"),
      null,
      "forward-traffic must not receive server_ids",
    );
  }
  // 用量子页里不能出现「筛选生效」/ scope 警告。
  assert.equal(await page.locator("[data-chain-scope-warning]").count(), 0);
  const usageText = await page.locator("[data-chain-usage]").innerText();
  assert.ok(!usageText.includes("筛选"));
  await shot(page, "usage-server-filter-not-passed-1440-dark", {
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await context.close();
}

// ---------------------------------------------------------------------------
// 4) 英文界面（双语文案）与 90 天窗口
// ---------------------------------------------------------------------------
{
  const { page, context, errors } = await openPage({
    theme: "light",
    locale: "en",
    path: "/?view=chain&section=usage",
  });
  await page.waitForSelector("[data-chain-usage]");
  await page.getByText("By day", { exact: true }).waitFor();
  assert.deepEqual(await subtabLabels(page), ["Chains", "Templates", "Usage"]);
  await shot(page, "usage-7d-1440-light-en", { fullPage: true });
  await page.getByRole("button", { name: "90 days" }).click();
  await page.waitForTimeout(350);
  await shot(page, "usage-90d-1440-light-en", { fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
}

await browser.close();
server.close();
console.log(`\n${saved.length} screenshots saved to ${path.relative(process.cwd(), OUT)}`);
