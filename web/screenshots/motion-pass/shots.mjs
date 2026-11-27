#!/usr/bin/env node
/**
 * 动效验收（浏览器）/ Motion acceptance in a real browser.
 *
 * 覆盖 / Covers:
 * - 浮层进入 200ms、退出 150ms、cubic-bezier(0.22, 1, 0.36, 1)：
 *   Dialog / AlertDialog / Dropdown / Popover / Select / Sheet；
 *   Tooltip 是唯一例外：进入 150ms、退出 100ms（与 docs/DESIGN.md 一致）。
 * - Dialog / AlertDialog 进入关键帧纵向 −4px（居中落下 4px）。
 * - 选中指示器：复选框 / 单选圆点 / 开关滑块 200ms ease-spring，
 *   缩放从 50% 到 100%，过冲峰值 > 1、终值 1；开关滑块过冲后回到终点。
 * - 列表行：按下态背景、键盘 :focus-visible 时行尾箭头右移 2px
 *   （链路行 / 转发模板行 / 流量榜单 / 告警行）。
 * - reduced-motion：动画时长 < 1ms；复选框指示器（代表所有选中指示器）
 *   的 transition-duration 也 < 1ms，点击后直接呈现终态。
 * - 静止帧：每个浮层 / 指示器在动画结束后的元素截图与基线逐像素对比；
 *   亮色基线来自改动前构建，深色基线从本轮起记录（无更早的深色基线）。
 *   列表行另断言静止态背景透明、箭头位移为 0。
 *
 * 用静态服务直接服务 `web/dist`，`/api/v1/**` 全部由 Playwright 拦截 mock；
 * 不需要主控、数据库或登录会话。
 *
 * 前置 / Prerequisite（仓库根执行 / run from the repo root）:
 *   make web-build
 *   node web/screenshots/motion-pass/shots.mjs
 *
 * 基线 / Baselines:
 *   首次（或设计变更后）用改动前的构建重新生成，肉眼确认后提交：
 *   MOTION_PASS_BASELINE=1 node web/screenshots/motion-pass/shots.mjs
 *
 *   只重录一个主题（暗色基线从本轮起记录，之前没有）：
 *   MOTION_PASS_BASELINE=1 MOTION_PASS_BASELINE_THEME=dark \
 *     node web/screenshots/motion-pass/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DIST = resolve(ROOT, "dist");
const OUT = HERE;
const BASELINE = path.join(HERE, "baseline");
const BASELINE_MODE = process.env.MOTION_PASS_BASELINE === "1";
/**
 * 基线模式要重录的主题，默认亮 + 暗。
 * 本轮之前只有亮色基线（改动前构建的画面），暗色从本轮起记录；
 * 用 `MOTION_PASS_BASELINE_THEME=dark` 只补暗色，不覆盖亮色基线。
 */
const BASELINE_THEMES = (process.env.MOTION_PASS_BASELINE_THEME ?? "light,dark")
  .split(",")
  .map((theme) => theme.trim())
  .filter(Boolean);
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * 基线文件名：亮色沿用首轮提交的 `<name>.png`（改动前构建），
 * 暗色是本轮起新增的 `<name>-dark.png`。
 */
function baselineFile(name, theme) {
  return theme === "light" ? `${name}.png` : `${name}-${theme}.png`;
}

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
mkdirSync(BASELINE, { recursive: true });

const GB = 1024 ** 3;
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const CHAIN_BUCKET = 900;
const CHAIN_COUNT = 24;
const CHAIN_END = Math.floor(NOW / CHAIN_BUCKET) * CHAIN_BUCKET;
const CHAIN_START = CHAIN_END - (CHAIN_COUNT - 1) * CHAIN_BUCKET;

const EASE_OUT_SOFT = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_SPRING = "cubic-bezier(0.34, 1.46, 0.64, 1)";

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
    // 批量升级复选框只在「允许下发升级」时可选；这里打开以覆盖可点击态。
    allow_agent_upgrade: true,
    agent_target_version: null,
    xray_running: def.status === "online",
    nginx_running: def.status === "online",
    load1: 0.42,
    mem_used: 3.1 * GB,
    mem_total: 8 * GB,
    disk_used: 42 * GB,
    disk_total: 120 * GB,
    uptime_secs: 12 * 86400,
    latency_ms: 23,
    net_rx_bps: 1.2 * 1024 * 1024,
    net_tx_bps: 512 * 1024,
    health_at: NOW - 20,
    arch: "x86_64",
    realm_available: true,
    nftables_available: true,
    node_count: 2,
    node_enabled_count: 2,
    node_protocols: ["vless"],
    commands: {},
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
  package_split: [],
  chains: {
    total: 3,
    degraded: 1,
    blocked: 0,
    forwards_total: 2,
    forwards_failing: 0,
    handshake_failures: 0,
  },
  top: [
    {
      kind: "server",
      server_id: "srv-hk-01",
      name: "香港-01",
      traffic_7d: 18.4 * GB,
      load1: 0.42,
      online: true,
      rates: [],
    },
    {
      kind: "server",
      server_id: "srv-tokyo-01",
      name: "东京-01",
      traffic_7d: 9.2 * GB,
      load1: 0.31,
      online: true,
      rates: [],
    },
  ],
  top_users: [
    { user_id: "u-alice", username: "alice", traffic_7d: 9.2 * GB },
    { user_id: "u-bob", username: "bob", traffic_7d: 6.1 * GB },
  ],
  top_nodes: [
    {
      node_id: "node-hk-01",
      name: "HK-01",
      protocol: "vless",
      server_name: "香港-01",
      traffic_7d: 12.3 * GB,
    },
    {
      node_id: "node-tokyo-01",
      name: "TYO-01",
      protocol: "vless",
      server_name: "东京-01",
      traffic_7d: 6.8 * GB,
    },
  ],
  alerts: [],
  scope: { server_ids: SERVERS.map((server) => server.id), servers_matched: 3, filtered: false },
};

const NODES = [
  {
    id: "node-hk-01",
    server_id: "srv-hk-01",
    server_name: "香港-01",
    server_address: "203.0.113.11",
    tag: "hk",
    name: "HK-01",
    protocol: "vless",
    transport: "tcp",
    security: "tls",
    port: 21001,
    config: {},
    enabled: true,
    created_at: NOW - 30 * 86400,
  },
  {
    id: "node-tokyo-01",
    server_id: "srv-tokyo-01",
    server_name: "东京-01",
    server_address: "203.0.113.21",
    tag: "tokyo",
    name: "TYO-01",
    protocol: "vless",
    transport: "tcp",
    security: "tls",
    port: 21002,
    config: {},
    enabled: true,
    created_at: NOW - 30 * 86400,
  },
];

const ME_SUMMARY = {
  user: {
    id: "u-admin",
    username: "admin",
    email: null,
    role: "admin",
    short_code: "AD",
    used_bytes: 12 * GB,
    quota_bytes: 100 * GB,
    quota_exceeded: false,
  },
  package: {
    name: "100G 月卡",
    traffic_limit: 100 * GB,
    expires_at: NOW + 20 * 86400,
  },
  usage: {
    used_bytes: 12 * GB,
    remaining_bytes: 88 * GB,
    days_left: 20,
    status: "active",
  },
  nodes: NODES.map((node) => ({
    id: node.id,
    name: node.name,
    tag: node.tag,
    protocol: node.protocol,
    server_name: node.server_name,
  })),
  nodes_unavailable: 0,
  subscription: {
    url: `${"https://example.com"}/api/v1/subscribe/AD1234`,
    updated_at: NOW - HOUR,
  },
  forward_limit: 0,
  forward_servers: [],
  packages: [],
  traffic: { today_bytes: 1 * GB, month_bytes: 12 * GB },
  subscription_url: "https://example.com/api/v1/subscribe/AD1234",
};

const PACKAGES = [
  {
    id: "pkg-100g",
    name: "100G 月卡",
    quota_bytes: 100 * GB,
    period_days: 30,
    direction: "both",
    node_ratio: 1,
    speed_limit_kbps: 0,
    created_at: NOW - 10 * 86400,
    node_scope: "all",
    node_ids: [],
    node_count: NODES.length,
    user_count: 0,
    rule_template_id: null,
    subscription_template_id: null,
    forward_limit: 0,
    forward_server_ids: [],
    chain_limit: 0,
    chain_template_ids: [],
  },
];

const CHAIN_TEMPLATES = [
  {
    id: "tpl-apac",
    name: "亚太三跳",
    engine: "native",
    security: "tls",
    transport: "none",
    protocol: "tcp",
    enabled: false,
    created_at: NOW - 5 * 86400,
    groups: [
      { seq: 0, strategy: "round_robin", server_ids: ["srv-hk-01"], servers: [{ id: "srv-hk-01", name: "香港-01" }] },
      { seq: 1, strategy: "round_robin", server_ids: ["srv-tokyo-01"], servers: [{ id: "srv-tokyo-01", name: "东京-01" }] },
    ],
  },
];

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

function chainSeries(base) {
  return Array.from({ length: CHAIN_COUNT }, (_, index) => chainPoint(index, base));
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

function chainEntry({ id, name, entry, exit, nodes, base, status = { kind: "ok" } }) {
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
    entry: { server_id: "srv-hk-01", server_name: "香港-01", address: "203.0.113.11:21001" },
    exit: { server_id: "srv-tokyo-01", server_name: "东京-01", address: "203.0.113.21:21002" },
    nodes: [
      { seq: 0, server_id: "srv-hk-01", name: "香港入口", role: "source", status: "online", member_count: 1, members: [{ server_id: "srv-hk-01", name: "香港-01", status: "online" }] },
      { seq: 1, server_id: "srv-tokyo-01", name: "东京出口", role: "hop", status: "online", member_count: 1, members: [{ server_id: "srv-tokyo-01", name: "东京-01", status: "online" }] },
    ],
  }),
  chainEntry({
    id: "chain-hk-sg",
    name: "港新中转",
    base: 58,
    entry: { server_id: "srv-hk-01", server_name: "香港-01", address: "203.0.113.11:21011" },
    exit: { server_id: "srv-sg-01", server_name: "新加坡-01", address: "203.0.113.31:21012" },
    status: { kind: "degraded", cause: "slow" },
    nodes: [
      { seq: 0, server_id: "srv-hk-01", name: "香港入口", role: "source", status: "online", member_count: 1, members: [{ server_id: "srv-hk-01", name: "香港-01", status: "online" }] },
      { seq: 1, server_id: "srv-tokyo-01", name: "东京中转", role: "hop", status: "online", member_count: 1, members: [{ server_id: "srv-tokyo-01", name: "东京-01", status: "online" }] },
      { seq: 2, server_id: "srv-sg-01", name: "新加坡出口", role: "hop", status: "offline", member_count: 1, members: [{ server_id: "srv-sg-01", name: "新加坡-01", status: "offline" }] },
    ],
  }),
  chainEntry({
    id: "chain-jp-hk",
    name: "东京回环",
    base: 37,
    entry: { server_id: "srv-tokyo-01", server_name: "东京-01", address: "203.0.113.21:21021" },
    exit: { server_id: "srv-hk-01", server_name: "香港-01", address: "203.0.113.11:21022" },
    nodes: [
      { seq: 0, server_id: "srv-tokyo-01", name: "东京入口", role: "source", status: "online", member_count: 1, members: [{ server_id: "srv-tokyo-01", name: "东京-01", status: "online" }] },
      { seq: 1, server_id: "srv-hk-01", name: "香港出口", role: "hop", status: "online", member_count: 1, members: [{ server_id: "srv-hk-01", name: "香港-01", status: "online" }] },
    ],
  }),
];

// 开关的 onCheckedChange 会 PATCH 后失效查询；mock 保持可变状态，才能看到滑块动画。
let chainTemplateEnabled = false;

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function handleApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  const pathname = url.pathname;
  const method = request.method();

  if (pathname === "/api/v1/auth/me") {
    return json(route, {
      user: { id: "u-admin", username: "admin", role: "admin", short_code: "AD" },
    });
  }
  if (pathname === "/api/v1/health") {
    return json(route, { status: "ok", version: "0.18.1", panel_name: "PierWave" });
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
  if (pathname === "/api/v1/chain-templates" && method === "GET") {
    return json(route, {
      items: CHAIN_TEMPLATES.map((template) => ({
        ...template,
        enabled: chainTemplateEnabled,
      })),
    });
  }
  if (/^\/api\/v1\/chain-templates\/[^/]+$/.test(pathname) && method === "PATCH") {
    const body = request.postDataJSON() ?? {};
    if (typeof body.enabled === "boolean") chainTemplateEnabled = body.enabled;
    return json(route, {
      template: { ...CHAIN_TEMPLATES[0], enabled: chainTemplateEnabled },
    });
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
    return json(route, { generated_at: NOW, items: [] });
  }
  if (pathname === "/api/v1/packages") {
    return json(route, { items: PACKAGES });
  }
  if (pathname === "/api/v1/nodes") {
    return json(route, {
      items: NODES,
      total: NODES.length,
      page: 1,
      per_page: 200,
    });
  }
  if (pathname === "/api/v1/rule-templates") {
    return json(route, { items: [] });
  }
  if (pathname === "/api/v1/subscription-templates") {
    return json(route, { items: [] });
  }
  if (pathname === "/api/v1/me/summary") {
    return json(route, ME_SUMMARY);
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
const staticComparisons = [];
const baselineFiles = [];

async function openPage({
  theme,
  width = 1440,
  height = 900,
  target = "/",
  reducedMotion = "no-preference",
}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion,
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
  await page.route("**/api/v1/**", (route) => handleApi(route));
  await page.goto(`${BASE}${target}`, { waitUntil: "domcontentloaded" });
  return { context, page, errors };
}

async function settle(page, ms = 360) {
  await page.evaluate(() => document.fonts?.ready);
  await page.evaluate(
    () =>
      new Promise((resolvePromise) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolvePromise(null)),
        );
      }),
  );
  await page.waitForTimeout(ms);
}

async function screenshot(page, name, locator = null) {
  const file = `${OUT}/${name}.png`;
  if (locator) await locator.screenshot({ path: file });
  else await page.screenshot({ path: file });
  shots.push(name);
  console.log(`saved ${name}.png`);
}

function record(label, state) {
  checks.push({ label, ...state });
  console.log(`  ${label}: ${JSON.stringify(state)}`);
}

/** 记录一次元素截图，并在非基线模式下与改动前的基线逐像素对比。 */
async function compareStatic(page, name, locator, theme, { keepPointer = false } = {}) {
  // 静止帧要在「指针不悬停任何行」的状态下取，否则元素的最后一像素行会
  // 混进 hover 背景，和基线产生与动效无关的差异。Tooltip 例外：它必须
  // 保持 hover 才存在。
  if (!keepPointer) {
    await page.mouse.move(2, 2);
    // 祖先行 / Label 的 hover 背景有 150ms transition；等它落定再截图，
    // 否则元素最后一像素行会读到过渡中的颜色。
    await page.waitForTimeout(220);
  }
  const file = path.join(BASELINE, baselineFile(name, theme));
  // `duration-*` 同时设置 transition-duration；Radix 定位完成后仍可能触发
  // 一条过渡。截图前等元素自己的动画 / 过渡全部跑完，才是静止帧。
  await locator.evaluate(
    (element) =>
      new Promise((resolvePromise) => {
        const deadline = performance.now() + 2500;
        const check = () => {
          if (element.getAnimations().length === 0 || performance.now() > deadline) {
            resolvePromise(null);
          } else {
            requestAnimationFrame(check);
          }
        };
        check();
      }),
  );
  // 动画结束后浏览器可能还把这个元素留在合成层上，边缘 1px 的抗锯齿与
  // 降级后略有差别；多等 120ms 让合成状态落定，静止帧才是可复现的。
  await page.waitForTimeout(120);
  const buffer = await locator.screenshot();
  if (BASELINE_MODE) {
    writeFileSync(file, buffer);
    baselineFiles.push(baselineFile(name, theme).replace(/\.png$/, ""));
    console.log(`baseline ${baselineFile(name, theme)}`);
    return;
  }
  assert.ok(existsSync(file), `missing baseline ${baselineFile(name, theme)}`);
  const baseline = readFileSync(file);
  const diff = await page.evaluate(
    async ({ actual, before }) => {
      const load = (base64) =>
        new Promise((resolvePromise, rejectPromise) => {
          const image = new Image();
          image.onload = () => resolvePromise(image);
          image.onerror = rejectPromise;
          image.src = `data:image/png;base64,${base64}`;
        });
      const [after, prior] = await Promise.all([load(actual), load(before)]);
      if (after.width !== prior.width || after.height !== prior.height) {
        return {
          sizeMismatch: true,
          after: [after.width, after.height],
          before: [prior.width, prior.height],
        };
      }
      const canvas = document.createElement("canvas");
      canvas.width = after.width;
      canvas.height = after.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(after, 0, 0);
      const afterPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(prior, 0, 0);
      const priorPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let differingPixels = 0;
      let maxChannelDelta = 0;
      for (let index = 0; index < afterPixels.length; index += 4) {
        // 两边都全透明的像素不参与渲染：圆角元素的截图会在透明区留下
        // 每次略不相同的底色（alpha 都是 0），不能算作可见差异。
        if (afterPixels[index + 3] === 0 && priorPixels[index + 3] === 0) continue;
        const delta = Math.max(
          Math.abs(afterPixels[index] - priorPixels[index]),
          Math.abs(afterPixels[index + 1] - priorPixels[index + 1]),
          Math.abs(afterPixels[index + 2] - priorPixels[index + 2]),
          Math.abs(afterPixels[index + 3] - priorPixels[index + 3]),
        );
        if (delta > 2) differingPixels += 1;
        if (delta > maxChannelDelta) maxChannelDelta = delta;
      }
      return {
        width: after.width,
        height: after.height,
        differingPixels,
        totalPixels: after.width * after.height,
        maxChannelDelta,
      };
    },
    { actual: buffer.toString("base64"), before: baseline.toString("base64") },
  );
  staticComparisons.push({ name, theme, ...diff });
  assert.equal(diff.sizeMismatch, undefined, `${name}: baseline size changed`);
  /*
   * 两个元素允许极少量边缘差异，其余仍要求 0px：
   * - Tooltip：`duration-*` 同时设置 transition-duration，会让这个带圆角的
   *   小浮层在动画结束后被提升为合成层，圆角 1px 的抗锯齿比改动前（无过渡）
   *   略有差别。实测只落在右侧两个圆角，≤ 15px、单通道 ≤ 23。
   * - Sheet：面板宽是 390 × 3/4 = 292.5px，右缘落在半像素上；元素截图最右一列
   *   的抗锯齿随合成层降级时机在 3–15px 内浮动（单通道 ≤ ~16，全部在 x=292）。
   *   这是 1px 边缘的渲染噪声，肉眼不可见；面板内部任何真实变化仍会超过 24px。
   */
  const tolerance =
    name === "tooltip-content" || name === "sheet-content" ? 24 : 0;
  assert.equal(
    diff.differingPixels <= tolerance,
    true,
    `${name}: resting frame changed (${diff.differingPixels} px > ${tolerance})`,
  );
}

/**
 * 等目标元素出现动画读数后 resolve（进入或退出都由同一函数读）。
 * 用 MutationObserver + rAF 双保险：进入是新增节点，退出是 data-state 变化。
 */
function watchMotion(page, selectors) {
  return page.evaluate(
    ({ selectors }) =>
      new Promise((resolvePromise, rejectPromise) => {
        let frame = 0;
        let finished = false;
        const timeout = setTimeout(() => {
          cleanup();
          rejectPromise(new Error(`no animation for ${selectors.join(", ")}`));
        }, 6000);

        const snapshot = () => {
          const readings = [];
          for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (!element) return null;
            const animations = element.getAnimations();
            // Radix 首帧会临时把 animation 置 none 做定位；此时可能只有一条
            // 由默认 `transition-property: all` + duration 触发的过渡。
            // 等真正的 enter / exit keyframes 动画出现再读数。
            const animation = animations.find(
              (item) => item.animationName === "enter" || item.animationName === "exit",
            );
            if (!animation) return null;
            const style = getComputedStyle(element);
            readings.push({
              selector,
              state: element.getAttribute("data-state"),
              animationNames: animations.map((item) => item.animationName),
              durationMs: animation.effect.getTiming().duration,
              timingFunction: style.animationTimingFunction,
              fromTransform: animation.effect.getKeyframes()[0]?.transform ?? null,
            });
          }
          return readings;
        };

        const check = () => {
          if (finished) return;
          const readings = snapshot();
          if (!readings) return;
          finished = true;
          cleanup();
          resolvePromise(readings);
        };

        const observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
        });
        const tick = () => {
          check();
          if (!finished) frame = requestAnimationFrame(tick);
        };
        const cleanup = () => {
          observer.disconnect();
          cancelAnimationFrame(frame);
          clearTimeout(timeout);
        };
        tick();
      }),
    { selectors },
  );
}

async function enterMotion(page, selectors, trigger) {
  const watching = watchMotion(page, selectors);
  await trigger();
  return watching;
}

async function exitMotion(page, selectors, trigger) {
  const watching = watchMotion(page, selectors);
  await trigger();
  return watching;
}

/** 角色化的断言：进入 200 / 退出 150 / ease-out-soft。 */
function assertOverlayMotion(label, readings, entry = { enter: 200, exit: 150 }) {
  const [content] = readings;
  assert.equal(content.durationMs, entry.enter, `${label}: enter duration`);
  assert.equal(content.timingFunction, EASE_OUT_SOFT, `${label}: enter ease`);
  return content;
}

function assertExitMotion(label, readings, entry = { exit: 150 }) {
  const [content] = readings;
  assert.equal(content.durationMs, entry.exit, `${label}: exit duration`);
  assert.equal(content.timingFunction, EASE_OUT_SOFT, `${label}: exit ease`);
  return content;
}

/** 从关键帧里取纵向位移（translate3d 或 matrix 的 ty）。 */
function keyframeTranslateY(transform) {
  if (!transform) return null;
  const translate3d = /translate3d\(\s*[^,]+,\s*(-?[\d.]+)px/.exec(transform);
  if (translate3d) return Number(translate3d[1]);
  const matrix = /matrix\(([^)]+)\)/.exec(transform);
  if (matrix) {
    const parts = matrix[1].split(",").map((value) => Number(value.trim()));
    if (parts.length === 6) return parts[5];
  }
  return null;
}

function parseCssDuration(value) {
  if (!value) return null;
  const first = value.split(",")[0].trim();
  if (first.endsWith("ms")) return Number.parseFloat(first);
  if (first.endsWith("s")) return Number.parseFloat(first) * 1000;
  return Number.parseFloat(first);
}

/**
 * 用 Web Animations API 采样 CSS transition 的完整曲线。
 *
 * rAF 在无头浏览器里偶尔会连丢十几帧，正好错过 spring 的过冲峰值；
 * 这里在 transition 一出现就暂停它，按 currentTime 逐点取计算样式，
 * 既能稳定抓到峰值，也不需要额外依赖。
 *
 * `mode = "thumbOffset"` 时采样开关滑块相对根节点的左缘距离
 * （switch 的 translate 是 `calc(100% - 2px)`，计算样式不解析百分比）。
 */
async function probeTransition(page, { selector, property, trigger, mode = "style" }) {
  const probing = page.evaluate(
    ({ selector, property, mode }) =>
      new Promise((resolvePromise) => {
        const element = document.querySelector(selector);
        if (!element) {
          resolvePromise({ error: `missing ${selector}`, samples: [] });
          return;
        }
        const start = performance.now();
        const findTransition = () =>
          element
            .getAnimations()
            .find(
              (animation) =>
                animation.constructor.name === "CSSTransition" &&
                String(animation.transitionProperty ?? "")
                  .split(",")
                  .map((item) => item.trim())
                  .includes(property),
            );

        const sample = () => {
          if (mode === "thumbOffset") {
            const root = element.closest('[data-slot="switch"]');
            const thumb =
              element.getAttribute("data-slot") === "switch-thumb"
                ? element
                : element.querySelector('[data-slot="switch-thumb"]');
            if (!root || !thumb) return null;
            const value =
              thumb.getBoundingClientRect().left - root.getBoundingClientRect().left;
            return `${value}px`;
          }
          return getComputedStyle(element)[property];
        };

        const attempt = () => {
          const transition = findTransition();
          if (!transition) {
            if (performance.now() - start > 1200) {
              resolvePromise({ error: `no ${property} transition`, samples: [] });
              return;
            }
            setTimeout(attempt, 4);
            return;
          }
          transition.pause();
          const duration = Number(transition.effect.getTiming().duration) || 200;
          const samples = [];
          const steps = 80;
          for (let index = 0; index <= steps; index += 1) {
            const t = (duration * index) / steps;
            transition.currentTime = t;
            samples.push({ t: Math.round(t), raw: sample() });
          }
          transition.finish();
          resolvePromise({ duration, samples });
        };
        attempt();
      }),
    { selector, property, mode },
  );
  await trigger();
  return probing;
}

function numericValue(raw) {
  if (!raw) return null;
  const value = Number.parseFloat(String(raw));
  return Number.isFinite(value) ? value : null;
}

function peakOf(samples) {
  return samples.reduce(
    (peak, sample) => Math.max(peak, numericValue(sample.raw) ?? -Infinity),
    -Infinity,
  );
}

/** 用键盘建立 modality 后聚焦目标，确认 `:focus-visible` 命中。 */
async function focusWithKeyboard(page, locator) {
  await page.keyboard.press("Tab");
  await locator.focus();
  const visible = await page.evaluate(
    () => document.activeElement?.matches?.(":focus-visible") ?? false,
  );
  if (visible) return true;

  // 兜底：从头按 Tab 顺序走到目标（元素自身不可聚焦时由 test 失败兜住）。
  await page.evaluate(() => document.activeElement?.blur?.());
  for (let index = 0; index < 160; index += 1) {
    await page.keyboard.press("Tab");
    const focused = await locator.evaluate(
      (element) => element === document.activeElement,
    );
    if (focused) break;
  }
  return page.evaluate(
    () => document.activeElement?.matches?.(":focus-visible") ?? false,
  );
}

/** 鼠标按下并在同一次按下里读计算样式 + 截图，结束时移开再松手避免导航。 */
async function pressAndRead(page, locator, read, name) {
  const box = await locator.boundingBox();
  assert.ok(box, "pressed element has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(140);
  const value = await read();
  if (name) await screenshot(page, name);
  await page.mouse.move(0, 0);
  await page.mouse.up();
  return value;
}

function elementTranslate(selector, page) {
  return page.evaluate(
    (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        translate: style.translate,
        transform: style.transform,
      };
    },
    selector,
  );
}

// ---------------------------------------------------------------------------
// 场景 / Scenarios
// ---------------------------------------------------------------------------

const VERIFY = !BASELINE_MODE;

/** 基线模式只取静止帧，不校验动效读数。 */
const check = (condition, message) => {
  if (VERIFY) assert.ok(condition, message);
};
const equal = (actual, expected, message) => {
  if (VERIFY) assert.equal(actual, expected, message);
};
const matches = (actual, pattern, message) => {
  if (VERIFY) assert.match(actual, pattern, message);
};

/** 打开浮层：校验模式下读进入动画，基线模式下只打开并等元素出现。 */
async function openAndMeasure(page, selectors, trigger) {
  if (!VERIFY) {
    await trigger();
    await page.waitForSelector(selectors[0], { timeout: 5000 });
    return null;
  }
  return enterMotion(page, selectors, trigger);
}

/** 关闭浮层：校验模式下读退出动画，基线模式下只关闭并等元素卸载。 */
async function closeAndMeasure(page, selectors, trigger) {
  if (!VERIFY) {
    await trigger();
    await page
      .waitForSelector(selectors[0], { state: "detached", timeout: 3000 })
      .catch(() => {});
    return null;
  }
  return exitMotion(page, selectors, trigger);
}

async function waitForUi(page, selector, errors, label) {
  try {
    await page.waitForSelector(selector, { timeout: 20000 });
  } catch (error) {
    console.error(`等待 ${label} 失败 / failed:`, errors);
    console.error((await page.locator("body").innerText()).slice(0, 1600));
    await page.screenshot({ path: `${OUT}/_debug-${label.replace(/\W+/g, "-")}.png` });
    throw error;
  }
}

async function runOverviewScene(theme) {
  const { context, page, errors } = await openPage({ theme, target: "/?view=chain" });
  await waitForUi(page, "[data-chain-list-row]", errors, "chain-list");

  // ---- 链路列表行：按下 / 键盘聚焦箭头 ----
  const chainRow = page.locator("[data-chain-list-row]").first();
  await chainRow.scrollIntoViewIfNeeded();
  const rest = await page.evaluate(() => {
    const row = document.querySelector("[data-chain-list-row]");
    const chevron = document.querySelector("[data-chain-chevron]");
    return {
      background: getComputedStyle(row).backgroundColor,
      chevronTranslate: getComputedStyle(chevron).translate,
    };
  });
  record(`链路行静止态 / chain row at rest (${theme})`, rest);
  equal(rest.background, "rgba(0, 0, 0, 0)", "chain row rest bg must stay transparent");

  const pressed = await pressAndRead(
    page,
    chainRow,
    () =>
      page.evaluate(() => {
        const row = document.querySelector("[data-chain-list-row]");
        return getComputedStyle(row).backgroundColor;
      }),
    `chain-row-press-1440-${theme}`,
  );
  record(`链路行按下 / chain row pressed (${theme})`, { background: pressed });
  check(pressed !== "rgba(0, 0, 0, 0)", "chain row must show a pressed background");

  await chainRow.scrollIntoViewIfNeeded();
  const focused = await focusWithKeyboard(page, chainRow);
  check(focused, "chain row must be keyboard focus-visible");
  await settle(page, 200);
  const nudge = await elementTranslate("[data-chain-chevron]", page);
  record(`链路行键盘箭头 / chain chevron on keyboard focus (${theme})`, nudge);
  equal(numericValue(nudge.translate), 2, "chain chevron must nudge 2px");
  await screenshot(page, `chain-chevron-focus-1440-${theme}`);

  // ---- 流量榜单行 + 告警行 ----
  await page.goto(`${BASE}/?view=traffic`, { waitUntil: "domcontentloaded" });
  await waitForUi(page, "[data-traffic-view]", errors, "traffic-view");
  await settle(page, 500);

  const leaderboardRow = page
    .locator('[data-traffic-view] a[href="/servers"]')
    .filter({ hasText: "香港-01" })
    .first();
  await leaderboardRow.scrollIntoViewIfNeeded();
  const trafficRest = await leaderboardRow.evaluate((element) => {
    const chevron = element.querySelector("svg");
    return {
      background: getComputedStyle(element).backgroundColor,
      chevronTranslate: chevron ? getComputedStyle(chevron).translate : null,
    };
  });
  record(`榜单行静止态 / leaderboard row at rest (${theme})`, trafficRest);
  equal(trafficRest.background, "rgba(0, 0, 0, 0)", "leaderboard rest bg must stay transparent");

  const trafficPressed = await pressAndRead(
    page,
    leaderboardRow,
    () =>
      leaderboardRow.evaluate((element) => getComputedStyle(element).backgroundColor),
    `traffic-row-press-1440-${theme}`,
  );
  record(`榜单行按下 / leaderboard row pressed (${theme})`, { background: trafficPressed });
  check(trafficPressed !== "rgba(0, 0, 0, 0)", "leaderboard row must show pressed bg");

  const trafficFocused = await focusWithKeyboard(page, leaderboardRow);
  check(trafficFocused, "leaderboard row must be keyboard focus-visible");
  await settle(page, 200);
  const trafficNudge = await leaderboardRow.evaluate((element) => {
    // 行首可能还有状态点 / 趋势线图标，箭头是最后一个 svg。
    const chevrons = element.querySelectorAll("svg");
    const chevron = chevrons[chevrons.length - 1];
    return chevron ? getComputedStyle(chevron).translate : null;
  });
  record(`榜单行键盘箭头 / leaderboard chevron on keyboard focus (${theme})`, {
    translate: trafficNudge,
  });
  equal(numericValue(trafficNudge), 2, "leaderboard chevron must nudge 2px");
  await screenshot(page, `traffic-chevron-focus-1440-${theme}`);

  // ---- 告警行：外层 div.group 的 has-[a:active] 与箭头 group-has ----
  const alertLink = page
    .locator('[data-traffic-view] a[href="/servers"]')
    .filter({ hasText: "离线服务器" })
    .first();
  await alertLink.scrollIntoViewIfNeeded();
  const alertWrapper = alertLink.locator("xpath=..");
  const alertRest = await alertWrapper.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
  }));
  record(`告警行静止态 / alert row at rest (${theme})`, alertRest);
  equal(alertRest.background, "rgba(0, 0, 0, 0)", "alert wrapper rest bg must stay transparent");

  const alertPressed = await pressAndRead(
    page,
    alertLink,
    () => alertWrapper.evaluate((element) => getComputedStyle(element).backgroundColor),
    `alert-row-press-1440-${theme}`,
  );
  record(`告警行按下 / alert row pressed (${theme})`, { background: alertPressed });
  check(alertPressed !== "rgba(0, 0, 0, 0)", "alert wrapper must show pressed bg");

  const alertFocused = await focusWithKeyboard(page, alertLink);
  check(alertFocused, "alert link must be keyboard focus-visible");
  await settle(page, 200);
  const alertNudge = await alertLink.evaluate((element) => {
    // 告警行开头是状态图标，行尾箭头是最后一个 svg。
    const chevrons = element.querySelectorAll("svg");
    const chevron = chevrons[chevrons.length - 1];
    return chevron ? getComputedStyle(chevron).translate : null;
  });
  record(`告警行键盘箭头 / alert chevron on keyboard focus (${theme})`, {
    translate: alertNudge,
  });
  equal(numericValue(alertNudge), 2, "alert chevron must nudge 2px");
  await screenshot(page, `alert-chevron-focus-1440-${theme}`);

  assert.deepEqual(errors, [], `${theme}: overview must have no failed request / console error`);
  await context.close();
}

/**
 * Dialog 进入 / 退出：用概览「查看全部告警」那个常驻挂载的 Dialog。
 *
 * 表单类弹窗（PackageFormDialog 等）由父组件条件挂载，关闭时整棵树
 * 立刻卸载，退出动画在真实页面里根本不会播放；这里改用常驻的 Dialog，
 * 才能在同一元素上读到 enter / exit 两端。
 */
async function runTrafficDialogScene(theme) {
  const { context, page, errors } = await openPage({ theme, target: "/?view=traffic" });
  await waitForUi(page, "[data-traffic-view]", errors, "traffic-dialog");
  await settle(page, 500);

  const moreButton = page.getByRole("button", { name: /查看全部/ }).first();
  const dialogEnter = await openAndMeasure(
    page,
    ['[data-slot="dialog-content"]', '[data-slot="dialog-overlay"]'],
    async () => {
      await moreButton.click();
    },
  );
  if (dialogEnter) {
    const [dialogContent, dialogOverlay] = dialogEnter;
    record(`Dialog 进入 / dialog enter (${theme})`, {
      content: dialogContent,
      overlay: dialogOverlay,
    });
    assertOverlayMotion("dialog enter", [dialogContent]);
    equal(dialogOverlay.durationMs, 200, "dialog overlay enter must be 200ms");
    equal(dialogOverlay.timingFunction, EASE_OUT_SOFT, "dialog overlay ease");
    const dialogY = keyframeTranslateY(dialogContent.fromTransform);
    record(`Dialog 关键帧纵向 / dialog keyframe Y (${theme})`, {
      fromTransform: dialogContent.fromTransform,
      translateY: dialogY,
    });
    equal(dialogY, -4, "dialog content must enter from 4px above");
  }

  await settle(page);
  if (VERIFY) {
    const dialogStatic = await page.evaluate(() => {
      const content = document.querySelector('[data-slot="dialog-content"]');
      const style = getComputedStyle(content);
      return {
        opacity: style.opacity,
        runningAnimations: content.getAnimations().length,
        transform: style.transform,
      };
    });
    equal(dialogStatic.opacity, "1", "dialog must settle fully opaque");
    equal(dialogStatic.runningAnimations, 0, "dialog animation must finish");
  }
  await compareStatic(
    page,
    "dialog-content",
    page.locator('[data-slot="dialog-content"]'),
    theme,
  );
  if (VERIFY) await screenshot(page, `dialog-1440-${theme}`);

  const dialogExit = await closeAndMeasure(
    page,
    ['[data-slot="dialog-content"]', '[data-slot="dialog-overlay"]'],
    async () => {
      await page.keyboard.press("Escape");
    },
  );
  if (dialogExit) {
    record(`Dialog 退出 / dialog exit (${theme})`, {
      content: dialogExit[0],
      overlay: dialogExit[1],
    });
    assertExitMotion("dialog exit", [dialogExit[0]]);
    equal(dialogExit[1].durationMs, 150, "dialog overlay exit must be 150ms");
  }

  assert.deepEqual(errors, [], `${theme}: dialog must have no failed request / console error`);
  await context.close();
}

/**
 * AlertDialog 进入 / 退出：用「我的订阅 → 重置链接」。
 *
 * 它是少数常驻挂载（open 由 state 控制、组件不卸载）的 AlertDialog，
 * 因此 Esc 之后还能在同一元素上读到 150ms 的退出动画。
 */
async function runMeScene(theme) {
  const { context, page, errors } = await openPage({ theme, target: "/me/subscription" });
  await waitForUi(page, "text=我的订阅", errors, "me-subscription");
  await settle(page, 500);

  const resetButton = page.getByRole("button", { name: "重置链接", exact: true });
  const alertEnter = await openAndMeasure(
    page,
    ['[data-slot="alert-dialog-content"]', '[data-slot="alert-dialog-overlay"]'],
    async () => {
      await resetButton.click();
    },
  );
  if (alertEnter) {
    const [alertContent, alertOverlay] = alertEnter;
    record(`AlertDialog 进入 / alert-dialog enter (${theme})`, {
      content: alertContent,
      overlay: alertOverlay,
    });
    assertOverlayMotion("alert-dialog enter", [alertContent]);
    equal(alertOverlay.durationMs, 200, "alert overlay enter must be 200ms");
    const alertY = keyframeTranslateY(alertContent.fromTransform);
    record(`AlertDialog 关键帧纵向 / alert-dialog keyframe Y (${theme})`, {
      translateY: alertY,
    });
    equal(alertY, -4, "alert dialog content must enter from 4px above");
  }
  await settle(page);
  await compareStatic(
    page,
    "alert-dialog-content",
    page.locator('[data-slot="alert-dialog-content"]'),
    theme,
  );
  if (VERIFY) await screenshot(page, `alert-dialog-1440-${theme}`);

  const alertExit = await closeAndMeasure(
    page,
    ['[data-slot="alert-dialog-content"]', '[data-slot="alert-dialog-overlay"]'],
    async () => {
      await page.keyboard.press("Escape");
    },
  );
  if (alertExit) {
    record(`AlertDialog 退出 / alert-dialog exit (${theme})`, {
      content: alertExit[0],
      overlay: alertExit[1],
    });
    assertExitMotion("alert-dialog exit", [alertExit[0]]);
    equal(alertExit[1].durationMs, 150, "alert overlay exit must be 150ms");
  }

  assert.deepEqual(errors, [], `${theme}: me/subscription must have no failed request / console error`);
  await context.close();
}

async function runServersScene(theme) {
  const { context, page, errors } = await openPage({ theme, target: "/servers" });
  await waitForUi(page, "tbody [data-slot=checkbox]", errors, "servers-table");
  await settle(page, 400);

  // ---- Tooltip：进入 150ms / 退出 100ms ----
  const selectAll = page.locator("thead [data-slot=checkbox]").first();
  const tooltipEnter = await openAndMeasure(
    page,
    ['[data-slot="tooltip-content"]'],
    async () => {
      await selectAll.hover();
    },
  );
  if (tooltipEnter) {
    record(`Tooltip 进入 / tooltip enter (${theme})`, tooltipEnter[0]);
    equal(tooltipEnter[0].durationMs, 150, "tooltip enter must be 150ms");
    equal(tooltipEnter[0].timingFunction, EASE_OUT_SOFT, "tooltip enter ease");
  }
  await settle(page, 260);
  await compareStatic(
    page,
    "tooltip-content",
    page.locator('[data-slot="tooltip-content"]'),
    theme,
    { keepPointer: true },
  );
  await screenshot(page, `tooltip-1440-${theme}`);

  const tooltipExit = await closeAndMeasure(
    page,
    ['[data-slot="tooltip-content"]'],
    async () => {
      // 带 steps：一次跳跃不会触发 Radix 的 hoverable-content 离开判定。
      await page.mouse.move(4, 4, { steps: 8 });
    },
  );
  if (tooltipExit) {
    record(`Tooltip 退出 / tooltip exit (${theme})`, tooltipExit[0]);
    equal(tooltipExit[0].durationMs, 100, "tooltip exit must be 100ms");
  }
  await page
    .waitForSelector('[data-slot="tooltip-content"]', { state: "detached", timeout: 3000 })
    .catch(() => {});

  // ---- Checkbox：200ms + ease-spring + 50%→100% 过冲 ----
  const checkbox = page.locator("tbody [data-slot=checkbox]").first();
  const checkboxIndicator = checkbox.locator('[data-slot="checkbox-indicator"]');
  if (VERIFY) {
    const checkboxRest = await checkbox.evaluate((element) => {
      const indicator = element.querySelector('[data-slot="checkbox-indicator"]');
      const style = getComputedStyle(indicator);
      return {
        opacity: style.opacity,
        scale: style.scale,
        transitionDuration: style.transitionDuration,
        transitionTimingFunction: style.transitionTimingFunction,
        transitionProperty: style.transitionProperty,
        ariaHidden: indicator.getAttribute("aria-hidden"),
        tabindex: indicator.getAttribute("tabindex"),
      };
    });
    record(`Checkbox 静止态 / checkbox at rest (${theme})`, checkboxRest);
    equal(checkboxRest.opacity, "0");
    equal(numericValue(checkboxRest.scale), 0.5);
    equal(parseCssDuration(checkboxRest.transitionDuration), 200);
    equal(checkboxRest.transitionTimingFunction, EASE_SPRING);
    equal(checkboxRest.ariaHidden, "true");
    equal(checkboxRest.tabindex, null, "indicator must not add a focusable node");
  }
  await compareStatic(page, "checkbox-unchecked", checkbox, theme);

  if (VERIFY) {
    const checkboxProbe = await probeTransition(page, {
      selector: '[data-slot="checkbox-indicator"]',
      property: "scale",
      trigger: async () => {
        await checkbox.click();
      },
    });
    await settle(page, 260);
    const checkboxAfter = await checkboxIndicator.evaluate((element) => ({
      opacity: getComputedStyle(element).opacity,
      scale: getComputedStyle(element).scale,
    }));
    assert.equal(checkboxProbe.duration, 200, "checkbox transition must be 200ms");
    const checkboxPeak = peakOf(checkboxProbe.samples);
    record(`Checkbox 点击 / checkbox click (${theme})`, {
      peakScale: checkboxPeak,
      finalScale: numericValue(checkboxAfter.scale),
      finalOpacity: checkboxAfter.opacity,
    });
    check(checkboxPeak > 1, "checkbox scale must overshoot past 1");
    equal(numericValue(checkboxAfter.scale), 1);
    equal(checkboxAfter.opacity, "1");
  } else {
    await checkbox.click();
    await settle(page, 300);
  }
  await compareStatic(page, "checkbox-checked", checkbox, theme);
  await screenshot(page, `checkbox-1440-${theme}`);

  assert.deepEqual(errors, [], `${theme}: servers must have no failed request / console error`);
  await context.close();
}

async function runPackagesScene(theme) {
  const { context, page, errors } = await openPage({ theme, target: "/packages" });
  await waitForUi(page, "text=100G 月卡", errors, "packages-list");
  await settle(page, 400);

  const createButton = page.getByRole("button", { name: "新建套餐", exact: true });
  // 这个弹窗由父组件条件挂载，关闭时整棵 Radix 树立刻卸载，
  // 因此退出动画在真实页面里不可观察；Dialog 的进入 / 退出改在
  // 概览「查看全部告警」里读（那个 Dialog 常驻挂载）。
  await createButton.click();
  await page.waitForSelector('[data-slot="dialog-content"]');
  await settle(page);

  // ---- Select（popper）：进入 200 / 退出 150 ----

  const selectTrigger = page.locator("#package-subscription-template");
  await selectTrigger.scrollIntoViewIfNeeded();
  const selectEnter = await openAndMeasure(
    page,
    ['[data-slot="select-content"]'],
    async () => {
      await selectTrigger.click();
    },
  );
  if (selectEnter) {
    record(`Select 进入 / select enter (${theme})`, selectEnter[0]);
    assertOverlayMotion("select enter", selectEnter);
    const selectAlign = await page.evaluate(() => {
      const content = document.querySelector('[data-slot="select-content"]');
      return {
        dataAlignTrigger: content?.getAttribute("data-align-trigger"),
        animationName: getComputedStyle(content).animationName,
      };
    });
    record(`Select 对齐 / select item-aligned flag (${theme})`, selectAlign);
    equal(selectAlign.dataAlignTrigger, "false", "popper select must not be item-aligned");
    equal(selectAlign.animationName, "enter", "popper select must animate in");
  }
  await settle(page, 260);
  await compareStatic(
    page,
    "select-content",
    page.locator('[data-slot="select-content"]'),
    theme,
  );
  await screenshot(page, `select-1440-${theme}`);

  const selectExit = await closeAndMeasure(
    page,
    ['[data-slot="select-content"]'],
    async () => {
      await page.keyboard.press("Escape");
    },
  );
  if (selectExit) {
    record(`Select 退出 / select exit (${theme})`, selectExit[0]);
    assertExitMotion("select exit", selectExit);
  }

  // ---- Radio：200ms ease-spring，50%→100%，过冲后回到 1 ----
  const radioSelected = page.locator("#package-node-scope-selected");
  await radioSelected.scrollIntoViewIfNeeded();
  const radioItem = page.locator("#package-node-scope-selected");
  if (VERIFY) {
    const radioRest = await radioSelected.evaluate((item) => {
      const dot = item.querySelector('[data-slot="radio-group-indicator-dot"]');
      const style = dot ? getComputedStyle(dot) : null;
      return {
        opacity: style?.opacity ?? null,
        scale: style?.scale ?? null,
        transitionDuration: style?.transitionDuration ?? null,
        transitionTimingFunction: style?.transitionTimingFunction ?? null,
        transitionProperty: style?.transitionProperty ?? null,
        ariaHidden: dot?.getAttribute("aria-hidden") ?? null,
        tabindex: dot?.getAttribute("tabindex") ?? null,
      };
    });
    record(`Radio 静止态 / radio at rest (${theme})`, radioRest);
    equal(radioRest.opacity, "0");
    equal(numericValue(radioRest.scale), 0.5);
    equal(parseCssDuration(radioRest.transitionDuration), 200);
    equal(radioRest.transitionTimingFunction, EASE_SPRING);
    equal(radioRest.ariaHidden, "true");
    equal(radioRest.tabindex, null, "radio dot must not add a focusable node");
  }
  await compareStatic(page, "radio-unchecked", radioItem, theme);

  if (VERIFY) {
    const radioProbe = await probeTransition(page, {
      selector: '#package-node-scope-selected [data-slot="radio-group-indicator-dot"]',
      property: "scale",
      trigger: async () => {
        await radioSelected.click();
      },
    });
    await settle(page, 260);
    assert.equal(radioProbe.duration, 200, "radio transition must be 200ms");
    const radioAfter = await radioSelected.evaluate((item) => {
      const dot = item.querySelector('[data-slot="radio-group-indicator-dot"]');
      return dot
        ? { opacity: getComputedStyle(dot).opacity, scale: getComputedStyle(dot).scale }
        : null;
    });
    const radioPeak = peakOf(radioProbe.samples);
    record(`Radio 点击 / radio click (${theme})`, {
      peakScale: radioPeak,
      finalScale: numericValue(radioAfter?.scale),
      finalOpacity: radioAfter?.opacity,
    });
    check(radioPeak > 1, "radio scale must overshoot past 1");
    equal(numericValue(radioAfter?.scale), 1);
    equal(radioAfter?.opacity, "1");
  } else {
    await radioSelected.click();
    await settle(page, 300);
  }
  await compareStatic(page, "radio-checked", radioItem, theme);
  await screenshot(page, `radio-1440-${theme}`);

  await page.keyboard.press("Escape");
  await page
    .waitForSelector('[data-slot="dialog-content"]', { state: "detached", timeout: 3000 })
    .catch(() => {});
  await settle(page, 200);

  assert.deepEqual(errors, [], `${theme}: packages must have no failed request / console error`);
  await context.close();
}

async function runChainTemplatesScene(theme) {
  chainTemplateEnabled = false;
  const { context, page, errors } = await openPage({
    theme,
    target: "/chain-templates",
  });
  await waitForUi(page, "text=亚太三跳", errors, "chain-templates-list");
  await settle(page, 400);

  const switchRoot = page.locator('[data-slot="switch"]').first();
  const thumb = switchRoot.locator('[data-slot="switch-thumb"]');
  if (VERIFY) {
    const switchRest = await thumb.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        transitionTimingFunction: style.transitionTimingFunction,
        translate: style.translate,
      };
    });
    record(`Switch 静止态 / switch at rest (${theme})`, switchRest);
    matches(switchRest.transitionProperty, /translate|transform/);
    equal(parseCssDuration(switchRest.transitionDuration), 200);
    equal(switchRest.transitionTimingFunction, EASE_SPRING);
  }
  await compareStatic(page, "switch-off", switchRoot, theme);

  let switchRestOffset = null;
  if (VERIFY) {
    switchRestOffset = await switchRoot.evaluate((root) => {
      const element = root.querySelector('[data-slot="switch-thumb"]');
      return (
        element.getBoundingClientRect().left - root.getBoundingClientRect().left
      );
    });
  }
  if (VERIFY) {
    const switchProbe = await probeTransition(page, {
      selector: '[data-slot="switch-thumb"]',
      property: "translate",
      mode: "thumbOffset",
      trigger: async () => {
        await switchRoot.click();
      },
    });
    await page.waitForTimeout(500);
    assert.equal(switchProbe.duration, 200, "switch transition must be 200ms");
    const switchAfter = await switchRoot.evaluate((root) => {
      const element = root.querySelector('[data-slot="switch-thumb"]');
      const rootRect = root.getBoundingClientRect();
      const thumbRect = element.getBoundingClientRect();
      return {
        state: root.getAttribute("data-state"),
        offset: thumbRect.left - rootRect.left,
      };
    });
    const switchPeak = switchProbe.samples.reduce(
      (peak, sample) => Math.max(peak, numericValue(sample.raw) ?? -Infinity),
      -Infinity,
    );
    record(`Switch 点击 / switch click (${theme})`, {
      state: switchAfter.state,
      peakOffset: switchPeak,
      finalOffset: switchAfter.offset,
    });
    equal(switchAfter.state, "checked", "switch must end checked");
    // sm 开关：滑块宽 12px，`translate-x-[calc(100%-2px)]` = 自身 10px；
    // 根节点 1px 边框使最终左缘相对 root 为 11px。用静止偏移 + 10 断言。
    check(
      Math.abs(switchAfter.offset - (switchRestOffset + 10)) < 0.6,
      "sm thumb must end at the right edge (10px travel)",
    );
    check(switchPeak > switchAfter.offset, "switch thumb must overshoot before settling");
  } else {
    await switchRoot.click();
    await page.waitForTimeout(700);
  }
  await compareStatic(page, "switch-on", switchRoot, theme);
  await screenshot(page, `switch-1440-${theme}`);

  assert.deepEqual(errors, [], `${theme}: chain-templates must have no failed request / console error`);
  await context.close();
}

async function runSheetScene(theme) {
  const { context, page, errors } = await openPage({
    theme,
    width: 390,
    height: 844,
    target: "/?view=traffic",
  });
  await waitForUi(page, '[data-traffic-view]', errors, "sheet-overview");
  await settle(page, 500);

  const menuButton = page.getByRole("button", { name: "打开导航" });
  const sheetEnter = await openAndMeasure(
    page,
    ['[data-slot="sheet-content"]', '[data-slot="sheet-overlay"]'],
    async () => {
      await menuButton.click();
    },
  );
  if (sheetEnter) {
    record(`Sheet 进入 / sheet enter (${theme})`, {
      content: sheetEnter[0],
      overlay: sheetEnter[1],
    });
    equal(sheetEnter[0].durationMs, 200, "sheet enter must be 200ms");
    equal(sheetEnter[1].durationMs, 200, "sheet overlay enter must be 200ms");
    equal(sheetEnter[0].timingFunction, EASE_OUT_SOFT, "sheet enter ease");
  }
  await settle(page);
  await compareStatic(
    page,
    "sheet-content",
    page.locator('[data-slot="sheet-content"]'),
    theme,
  );
  await screenshot(page, `sheet-390-${theme}`);

  const sheetExit = await closeAndMeasure(
    page,
    ['[data-slot="sheet-content"]', '[data-slot="sheet-overlay"]'],
    async () => {
      await page.keyboard.press("Escape");
    },
  );
  if (sheetExit) {
    record(`Sheet 退出 / sheet exit (${theme})`, {
      content: sheetExit[0],
      overlay: sheetExit[1],
    });
    equal(sheetExit[0].durationMs, 150, "sheet exit must be 150ms");
    equal(sheetExit[1].durationMs, 150, "sheet overlay exit must be 150ms");
  }

  assert.deepEqual(errors, [], `${theme}: sheet must have no failed request / console error`);
  await context.close();
}

async function runDropdownAndPopoverScene(theme) {
  const { context, page, errors } = await openPage({ theme, target: "/?view=traffic" });
  await waitForUi(page, '[data-traffic-view]', errors, "dropdown-overview");
  await settle(page, 500);

  // ---- Dropdown（账号菜单）----
  const accountMenu = page.locator('[aria-label*="的账号菜单"]').first();
  const dropdownEnter = await openAndMeasure(
    page,
    ['[data-slot="dropdown-menu-content"]'],
    async () => {
      await accountMenu.click();
    },
  );
  if (dropdownEnter) {
    record(`Dropdown 进入 / dropdown enter (${theme})`, dropdownEnter[0]);
    assertOverlayMotion("dropdown enter", dropdownEnter);
  }
  await settle(page, 260);
  await compareStatic(
    page,
    "dropdown-content",
    page.locator('[data-slot="dropdown-menu-content"]'),
    theme,
  );
  await screenshot(page, `dropdown-1440-${theme}`);

  const dropdownExit = await closeAndMeasure(
    page,
    ['[data-slot="dropdown-menu-content"]'],
    async () => {
      await page.keyboard.press("Escape");
    },
  );
  if (dropdownExit) {
    record(`Dropdown 退出 / dropdown exit (${theme})`, dropdownExit[0]);
    assertExitMotion("dropdown exit", dropdownExit);
  }
  await page
    .waitForSelector('[data-slot="dropdown-menu-content"]', {
      state: "detached",
      timeout: 3000,
    })
    .catch(() => {});
  await settle(page, 220);

  // ---- Popover（概览服务器筛选）----
  const filterTrigger = page.locator("[data-server-filter-trigger]").first();
  const popoverEnter = await openAndMeasure(
    page,
    ['[data-slot="popover-content"]'],
    async () => {
      await filterTrigger.click();
    },
  );
  if (popoverEnter) {
    record(`Popover 进入 / popover enter (${theme})`, popoverEnter[0]);
    assertOverlayMotion("popover enter", popoverEnter);
  }
  await settle(page, 260);
  await compareStatic(
    page,
    "popover-content",
    page.locator('[data-slot="popover-content"]'),
    theme,
  );
  await screenshot(page, `popover-1440-${theme}`);

  const popoverExit = await closeAndMeasure(
    page,
    ['[data-slot="popover-content"]'],
    async () => {
      await page.keyboard.press("Escape");
    },
  );
  if (popoverExit) {
    record(`Popover 退出 / popover exit (${theme})`, popoverExit[0]);
    assertExitMotion("popover exit", popoverExit);
  }

  assert.deepEqual(errors, [], `${theme}: dropdown/popover must have no failed request / console error`);
  await context.close();
}

async function runReducedMotionScene() {
  const { context, page, errors } = await openPage({
    theme: "dark",
    target: "/packages",
    reducedMotion: "reduce",
  });
  await waitForUi(page, "text=100G 月卡", errors, "reduced-motion-packages");
  await settle(page, 300);

  await page.getByRole("button", { name: "新建套餐", exact: true }).click();
  await page.waitForSelector('[data-slot="dialog-content"]');
  await settle(page, 200);
  const reduced = await page.evaluate(() => {
    const content = document.querySelector('[data-slot="dialog-content"]');
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');
    const style = getComputedStyle(content);
    const overlayStyle = overlay ? getComputedStyle(overlay) : null;
    return {
      animationDuration: style.animationDuration,
      overlayAnimationDuration: overlayStyle?.animationDuration ?? null,
      animations: content.getAnimations().length,
    };
  });
  record("reduced-motion / 减弱动效", reduced);
  assert.ok(
    parseCssDuration(reduced.animationDuration) < 1,
    "reduced-motion must finish the dialog animation in under 1ms",
  );
  if (reduced.overlayAnimationDuration) {
    assert.ok(
      parseCssDuration(reduced.overlayAnimationDuration) < 1,
      "reduced-motion must finish the overlay animation in under 1ms",
    );
  }
  await screenshot(page, "reduced-motion-dialog-1440-dark");

  // ---- 指示器：减弱动效下过渡直接落到终态 ----
  // 复选框指示器与单选圆点共用同一条 reduced-motion 规则；这里用服务器页
  // 表格里的复选框做代表，既读静止态的 transition-duration，也确认点击后
  // 立刻是选中终态（减弱动效只缩短过程、不改变结果）。
  await page.goto(`${BASE}/servers`, { waitUntil: "domcontentloaded" });
  await waitForUi(page, "tbody [data-slot=checkbox]", errors, "reduced-motion-servers");
  await settle(page, 300);

  const reducedIndicator = await page.evaluate(() => {
    const indicator = document.querySelector(
      'tbody [data-slot="checkbox"] [data-slot="checkbox-indicator"]',
    );
    if (!indicator) return null;
    const style = getComputedStyle(indicator);
    return {
      transitionDuration: style.transitionDuration,
      animationDuration: style.animationDuration,
      animations: indicator.getAnimations().map((item) => ({
        name: item.animationName ?? null,
        duration: item.effect.getTiming().duration,
      })),
      opacity: style.opacity,
      scale: style.scale,
    };
  });
  record("reduced-motion 指示器 / indicator (dark)", reducedIndicator);
  assert.ok(reducedIndicator, "reduced-motion must find the checkbox indicator");
  const indicatorTransitionMs =
    parseCssDuration(reducedIndicator.transitionDuration) ?? Infinity;
  const indicatorAnimationMs = Math.min(
    ...[
      parseCssDuration(reducedIndicator.animationDuration),
      ...reducedIndicator.animations.map((item) => Number(item.duration)),
    ].map((value) => (Number.isFinite(value) ? value : Infinity)),
  );
  assert.ok(
    indicatorTransitionMs < 1 || indicatorAnimationMs < 1,
    `reduced-motion indicator must finish in under 1ms (transition ${indicatorTransitionMs}ms, animation ${indicatorAnimationMs}ms)`,
  );

  const reducedCheckbox = page.locator("tbody [data-slot=checkbox]").first();
  await reducedCheckbox.click();
  await page.waitForTimeout(80);
  const reducedChecked = await reducedCheckbox.evaluate((element) => {
    const indicator = element.querySelector('[data-slot="checkbox-indicator"]');
    return {
      opacity: getComputedStyle(indicator).opacity,
      scale: getComputedStyle(indicator).scale,
    };
  });
  record("reduced-motion 指示器点击 / indicator after click (dark)", reducedChecked);
  assert.equal(reducedChecked.opacity, "1", "reduced-motion must still show the checked tick");
  assert.equal(numericValue(reducedChecked.scale), 1, "reduced-motion must still end at scale 1");
  await screenshot(page, "reduced-motion-checkbox-1440-dark");

  assert.deepEqual(errors, [], "reduced-motion must have no failed request / console error");
  await context.close();
}

// ---------------------------------------------------------------------------
// 执行 / Run
// ---------------------------------------------------------------------------

if (process.env.MOTION_PASS_ONLY) {
  const only = process.env.MOTION_PASS_ONLY;
  const theme = process.env.MOTION_PASS_THEME ?? "dark";
  if (only === "overview") await runOverviewScene(theme);
  else if (only === "dialog") await runTrafficDialogScene(theme);
  else if (only === "alert-dialog") await runMeScene(theme);
  else if (only === "servers") await runServersScene(theme);
  else if (only === "packages") await runPackagesScene(theme);
  else if (only === "chain-templates") await runChainTemplatesScene(theme);
  else if (only === "dropdown") await runDropdownAndPopoverScene(theme);
  else if (only === "sheet") await runSheetScene(theme);
  else throw new Error(`unknown MOTION_PASS_ONLY=${only}`);
} else if (BASELINE_MODE) {
  // 基线只取静止帧；避免相对时间等动态内容进入基线。
  console.log(`baseline themes: ${BASELINE_THEMES.join(", ")}`);
  for (const theme of BASELINE_THEMES) {
    await runTrafficDialogScene(theme);
    await runPackagesScene(theme);
    await runServersScene(theme);
    await runChainTemplatesScene(theme);
    await runDropdownAndPopoverScene(theme);
    await runMeScene(theme);
    await runSheetScene(theme);
  }
  console.log(`\n${baselineFiles.length} baselines written to ${BASELINE}`);
} else {
  for (const theme of ["dark", "light"]) {
    await runOverviewScene(theme);
    await runTrafficDialogScene(theme);
    await runServersScene(theme);
    await runPackagesScene(theme);
    await runChainTemplatesScene(theme);
    await runDropdownAndPopoverScene(theme);
    await runMeScene(theme);
    await runSheetScene(theme);
  }
  await runReducedMotionScene();
}

await browser.close();
server.close();

writeFileSync(
  path.join(OUT, "report.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      base: BASE,
      mode: BASELINE_MODE ? "baseline" : "verify",
      // 只有全部断言通过才会写到这里；任何失败都会在断言处退出，不覆盖本文件。
      status: "ok",
      viewports: { desktop: [1440, 900], sheet: [390, 844] },
      expected: {
        overlayEnterMs: 200,
        overlayExitMs: 150,
        tooltipEnterMs: 150,
        tooltipExitMs: 100,
        easeOutSoft: EASE_OUT_SOFT,
        easeSpring: EASE_SPRING,
        dialogOffsetPx: -4,
        listChevronNudgePx: 2,
        reducedMotionIndicatorMs: 1,
      },
      shots,
      baselineThemes: ["light", "dark"],
      baselineNotes: {
        light:
          "pre-change build, kept as the regression reference / 改动前构建，作为回归基准",
        dark:
          "recorded from this round on; no pre-change dark baseline existed, so it was generated from the current build / 从本轮起记录：此前没有深色基线，用当前构建生成",
      },
      baselines: BASELINE_MODE
        ? baselineFiles
        : readdirSync(BASELINE)
            .filter((file) => file.endsWith(".png"))
            .sort(),
      staticComparisons,
      checks,
    },
    null,
    2,
  ),
);
console.log(
  `\n${shots.length} screenshots + ${checks.length} checks + ${staticComparisons.length} static comparisons saved to ${OUT}`,
);
