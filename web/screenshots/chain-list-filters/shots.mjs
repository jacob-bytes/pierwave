// 链路列表筛选 / 搜索 / 排序 / 空态验收截图与断言。
//
// Usage:
//   cd web && npm run build
//   node screenshots/chain-list-filters/shots.mjs
//
// Serves `web/dist` and mocks every API the overview needs, so no controller or
// database is involved. Playwright is taken from the repo's npx cache (same
// approach as screenshots/overview-kpi-compact/shots.mjs).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL(".", import.meta.url));
const DIST =
  process.env.DIST_DIR ?? fileURLToPath(new URL("../../dist/", import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PLAYWRIGHT =
  "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";
const NOW = Math.floor(Date.now() / 1000);
const BUCKET = 900;
const END = Math.floor(NOW / BUCKET) * BUCKET;
const HOUR = 3600;
const DAY = 86_400;

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

mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ *
 * Mock 数据 / fixtures
 * ------------------------------------------------------------------ */

const SERVERS = [
  { id: "hk-01", name: "香港-01", ip: "203.0.113.10", group: "香港", status: "online" },
  { id: "hk-02", name: "香港-02", ip: "203.0.113.11", group: "香港", status: "online" },
  { id: "tokyo-01", name: "东京-01", ip: "198.51.100.20", group: "日本", status: "online" },
  { id: "tokyo-02", name: "东京-02", ip: "198.51.100.21", group: "日本", status: "online" },
  { id: "osaka-01", name: "大阪-01", ip: "198.51.100.30", group: "日本", status: "offline" },
  { id: "sg-01", name: "新加坡-01", ip: "192.0.2.40", group: "东南亚", status: "online" },
  { id: "fra-01", name: "法兰克福-01", ip: "192.0.2.50", group: "欧洲", status: "online" },
];
const SERVER_BY_NAME = new Map(SERVERS.map((server) => [server.name, server]));

const TEMPLATE_DEFS = [
  {
    id: "tpl-1",
    name: "港日中转模板",
    engine: "realm",
    security: "tls",
    transport: "none",
    protocol: "tcp",
    enabled: true,
    created_at: NOW - 90 * DAY,
    groups: [],
  },
  {
    id: "tpl-2",
    name: "港新直连模板",
    engine: "realm",
    security: "tls",
    transport: "none",
    protocol: "tcp",
    enabled: true,
    created_at: NOW - 60 * DAY,
    groups: [],
  },
  {
    id: "tpl-3",
    name: "欧洲四跳模板",
    engine: "tunnel",
    security: "tls",
    transport: "tls",
    protocol: "tcp",
    enabled: true,
    created_at: NOW - 30 * DAY,
    groups: [],
  },
];

/**
 * 24 条链，状态数量：正常 15 / 降级 3 / 阻断 2 / 未知 2 / 样本不足 1 /
 * 停用 1。名称里带「港日」的正好 6 条，对应需求里的 `q=港日 → 6 条`。
 */
const CHAIN_DEFS = [
  { name: "港日中转链", route: ["香港-01", "东京-01"], status: "ok", p50: 46, delta: 2, loss: 0.4, age: 2, template: "tpl-1" },
  { name: "港日多路径", route: ["香港-01", "东京-01", "大阪-01", "新加坡-01"], status: "degraded", cause: "slow", p50: 82, delta: 14, loss: 1.8, age: 4, template: "tpl-1" },
  { name: "港日直达", route: ["香港-02", "东京-02"], status: "ok", p50: 32, delta: 1, loss: 0, age: 1 },
  { name: "港日备份链", route: ["香港-01", "新加坡-01"], status: "ok", p50: 55, delta: 3, loss: 0.2, age: 6 },
  { name: "港日-大阪", route: ["香港-01", "大阪-01"], status: "blocked", cause: "node_offline", node: "大阪-01", p50: 61, delta: 5, loss: 2.4, age: 3, template: "tpl-1" },
  { name: "香港-东京链", route: ["香港-02", "东京-01"], status: "ok", p50: 41, delta: 2, loss: 0.1, age: 8 },
  { name: "港新直达链", route: ["香港-01", "新加坡-01"], status: "ok", p50: 38, delta: 1, loss: 0, age: 2, template: "tpl-2" },
  { name: "港新多路径", route: ["香港-02", "新加坡-01"], status: "degraded", cause: "node_unhealthy", node: "新加坡-01", p50: 74, delta: 11, loss: 1.2, age: 5, template: "tpl-2" },
  { name: "港美西链", route: ["香港-01", "东京-02"], status: "ok", p50: 124, delta: 12, loss: 0.3, age: 7 },
  { name: "港欧中转链", route: ["香港-01", "东京-01", "法兰克福-01"], status: "unknown", cause: "unmeasurable", p50: 168, delta: 6, loss: null, age: 12, template: "tpl-3" },
  { name: "东京-新加坡链", route: ["东京-01", "新加坡-01"], status: "ok", p50: 67, delta: 2, loss: 0.2, age: 9 },
  { name: "东京-法兰克福链", route: ["东京-02", "法兰克福-01"], status: "ok", p50: 182, delta: 3, loss: 0.5, age: 10, template: "tpl-3" },
  { name: "东京-洛杉矶链", route: ["东京-01", "东京-02"], status: "degraded", cause: "slow", p50: 96, delta: 12, loss: 2.1, age: 11 },
  { name: "大阪-香港链", route: ["大阪-01", "香港-01"], status: "blocked", cause: "node_offline", node: "大阪-01", p50: 58, delta: 4, loss: 3.2, age: 15 },
  { name: "新加坡-东京链", route: ["新加坡-01", "东京-01"], status: "ok", p50: 71, delta: 2, loss: 0.1, age: 13 },
  { name: "新加坡-悉尼链", route: ["新加坡-01", "东京-02"], status: "ok", p50: 88, delta: 3, loss: 0.4, age: 16 },
  { name: "法兰克福-纽约链", route: ["法兰克福-01", "东京-01"], status: "ok", p50: 210, delta: 5, loss: 0.6, age: 18, template: "tpl-3" },
  { name: "香港-曼谷链", route: ["香港-01", "新加坡-01"], status: "ok", p50: 52, delta: 2, loss: 0.2, age: 20 },
  { name: "香港-台北链", route: ["香港-02", "东京-02"], status: "ok", p50: 29, delta: 1, loss: 0, age: 21 },
  { name: "香港-首尔链", route: ["香港-01", "东京-01"], status: "unknown", cause: "unmeasurable", p50: 44, delta: 2, loss: null, age: 22 },
  { name: "港日测试链", route: ["香港-01", "东京-02"], status: "insufficient", p50: null, delta: null, loss: null, age: null },
  { name: "香港-吉隆坡链", route: ["香港-02", "新加坡-01"], status: "ok", p50: 63, delta: 2, loss: 0.3, age: 25 },
  { name: "香港-新加坡链", route: ["香港-01", "新加坡-01"], status: "ok", p50: 40, delta: 1, loss: 0.1, age: 27, template: "tpl-2" },
  { name: "香港-曼谷（已停用）", route: ["香港-02", "东京-01"], status: "ok", p50: 57, delta: 2, loss: 0.2, age: 30, disabled: true },
];

const EXPECTED_COUNTS = {
  all: 24,
  ok: 15,
  degraded: 3,
  blocked: 2,
  unknown: 2,
  insufficient: 1,
  disabled: 1,
};
const EXPECTED_Q_HITS = 6;

function tsForAge(ageMinutes) {
  return END - ageMinutes * 60;
}

function makeSeries(base, ageMinutes) {
  const last = tsForAge(ageMinutes);
  return Array.from({ length: 96 }, (_, index) => {
    const ts = last - (95 - index) * BUCKET;
    const value = base + Math.sin(index / 5) * 3 + (index / 95) * 4;
    return {
      ts,
      p50: Math.round(value * 10) / 10,
      p10: Math.max(1, Math.round((value - 5) * 10) / 10),
      p90: Math.round((value + 7) * 10) / 10,
      samples: 3,
      loss_pct: null,
    };
  });
}

function endpointOf(server, index) {
  return {
    ip: server.ip,
    port: 443 + index,
    address: `${server.ip}:${443 + index}`,
    server_name: server.name,
  };
}

function makeChainHealth(def, index) {
  const id = `chain-${String(index + 1).padStart(2, "0")}`;
  const route = def.route.map((name) => SERVER_BY_NAME.get(name));
  const entry = route[0];
  const exit = route[route.length - 1];
  const target = "链目标";
  const insufficient = def.status === "insufficient";
  const age = def.age ?? 5;
  const lastSeq = route.length;
  const segments = [];

  for (let seq = 1; seq <= route.length; seq += 1) {
    const from = route[seq - 1].name;
    const to = seq < route.length ? route[seq].name : target;
    const isLast = seq === route.length;
    segments.push({
      seq,
      from,
      to,
      // 样本不足：值为空，不能补 0；其余链每段都有一个读数。
      p50: insufficient ? null : Math.round((def.p50 / route.length + seq * 2) * 10) / 10,
      delta_ms: insufficient ? null : isLast ? def.delta : 0,
      contribution_pct: insufficient ? null : isLast ? 100 : 0,
      loss_pct: insufficient ? null : isLast ? def.loss : 0,
      attempts: insufficient ? null : 240,
      failures:
        insufficient || def.loss === null ? null : Math.round(def.loss * 2.4),
      series: [],
    });
  }

  const nodes = route.map((server, seq) => ({
    seq,
    name: server.name,
    role: seq === 0 ? "source" : "hop",
    status: server.status,
    members: [
      {
        server_id: server.id,
        name: server.name,
        status: server.status,
      },
    ],
    member_count: 1,
  }));
  nodes.push({
    seq: route.length,
    name: target,
    role: "target",
    status: null,
    members: [],
    member_count: null,
  });

  const status =
    def.status === "blocked"
      ? {
          kind: "blocked",
          cause: "node_offline",
          node: { seq: Math.max(1, route.findIndex((server) => server.name === def.node)), name: def.node },
        }
      : def.status === "degraded"
        ? {
            kind: "degraded",
            cause: def.cause,
            node:
              def.cause === "node_unhealthy"
                ? { seq: route.findIndex((server) => server.name === def.node), name: def.node }
                : null,
          }
        : def.status === "unknown"
          ? { kind: "unknown", cause: "unmeasurable", node: null }
          : { kind: "ok", cause: null, node: null };

  return {
    id,
    name: def.name,
    hops: route.length,
    status,
    last_hop: {
      measurable: def.status !== "unknown",
      reason: def.status === "unknown" ? "engine_unsupported" : null,
    },
    entry: endpointOf(entry, 0),
    exit: endpointOf(exit, route.length - 1),
    nodes,
    missing_hops: insufficient ? [lastSeq] : [],
    estimated: route.length > 2,
    series: insufficient ? [] : makeSeries(def.p50, age),
    segments,
    diagnosis: insufficient
      ? { kind: "unknown", seq: null }
      : { kind: "single_hop", seq: lastSeq },
    loss_pct: insufficient ? null : def.loss,
    loss_partial: false,
    loss_samples: insufficient
      ? { attempts: 0, failures: 0 }
      : { attempts: 240, failures: def.loss === null ? 0 : Math.round(def.loss * 2.4) },
  };
}

const CHAIN_HEALTH_LIST = CHAIN_DEFS.map(makeChainHealth);

const CHAIN_HEALTH = {
  generated_at: END,
  hours: 24,
  bucket: BUCKET,
  summary: {
    hop_p50_ms: 46,
    delta_ms: 4,
    slow_chains: 4,
    total_chains: CHAIN_HEALTH_LIST.length,
    worst_hop: {
      chain_id: "chain-17",
      chain_name: "法兰克福-纽约链",
      seq: 2,
      p50_ms: 210,
    },
    loss_pct: 3.2,
    worst_loss: {
      chain_id: "chain-14",
      chain_name: "大阪-香港链",
      loss_pct: 3.2,
    },
  },
  chains: CHAIN_HEALTH_LIST,
};

function makeChainConfig(def, index) {
  const id = `chain-${String(index + 1).padStart(2, "0")}`;
  return {
    id,
    name: def.name,
    target_host: `target-${index + 1}.example.com`,
    target_port: 443,
    enabled: !def.disabled,
    engine: "realm",
    protocol: "tcp",
    udp: false,
    transport: "tls",
    degraded: def.status === "degraded",
    blocked_reason: def.status === "blocked" ? "节点离线" : null,
    blocked_code: null,
    source: def.template ? "user" : "admin",
    template_id: def.template ?? null,
    owner_user_id: null,
    entry_address: `${SERVER_BY_NAME.get(def.route[0]).ip}:${443 + index}`,
    path_mode: def.route.length > 1 ? "multi" : "single",
    total_latency_ms: def.p50,
    availability_24h: def.status === "insufficient" ? null : 0.99,
    loss_24h: def.loss === null ? null : def.loss / 100,
    probe_attempts_24h: 240,
    availability_threshold_percent: 99,
    groups: def.route.map((name, seq) => {
      const server = SERVER_BY_NAME.get(name);
      return {
        id: `${id}-g${seq}`,
        seq,
        name: null,
        strategy: "round_robin",
        cert_id: null,
        public_port: null,
        degraded: seq === def.route.length - 1 && def.status === "degraded",
        members: [
          {
            server_id: server.id,
            server_name: server.name,
            listen_port: 20000 + index * 10 + seq,
            priority: 0,
            weight: 1,
            forward_id: `f-${id}-${seq}`,
            listening: server.status === "online",
            target_ok: server.status === "online",
            target_error: null,
            last_seen_at: new Date(NOW * 1000).toISOString(),
            traffic_in: 1024 ** 2,
            traffic_out: 1024 ** 2,
            latency_ms: def.p50 ?? null,
            target_latency_ms: null,
            degraded: false,
            availability_24h: 0.99,
            probe_attempts_24h: 240,
            loss_24h: def.loss === null ? null : def.loss / 100,
          },
        ],
      };
    }),
    created_at: NOW - (30 - index) * DAY,
    updated_at: NOW - HOUR,
  };
}

const CHAINS = CHAIN_DEFS.map(makeChainConfig);

const SERVER_LIST = SERVERS.map((server, index) => ({
  id: server.id,
  name: server.name,
  group_name: server.group,
  address: server.ip,
  status: server.status,
  version: "0.18.4",
  last_seen_at: new Date((NOW - index * 30) * 1000).toISOString(),
  created_at: NOW - 120 * DAY,
}));

const AGGREGATE = {
  kpi: {
    servers_online: 6,
    servers_total: 7,
    nodes: 7,
    traffic_today: 32 * 1024 ** 3,
    traffic_month: 254 * 1024 ** 3,
    uptime_24h: 92.4,
  },
  series: [],
  protocol_series: [],
  protocols: [],
  chains: {
    total: CHAIN_DEFS.length,
    degraded: EXPECTED_COUNTS.degraded,
    blocked: EXPECTED_COUNTS.blocked,
    forwards_total: 48,
    forwards_failing: 0,
    handshake_failures: 0,
  },
  top: [],
  top_users: [],
  top_nodes: [],
  package_split: [],
  scope: {
    server_ids: SERVERS.map((server) => server.id),
    servers_matched: SERVERS.length,
    filtered: false,
  },
  warnings: { unknown_ids: [] },
};

const STATS = {
  servers: { total: 7, online: 6 },
  users: { total: 9, active: 9 },
  packages: { total: 5, instances: 7 },
  traffic: { today_bytes: 32 * 1024 ** 3, month_bytes: 254 * 1024 ** 3 },
  alerts: {
    expired_instances: 0,
    exhausted_instances: 0,
    offline_servers: 1,
    expiring_certs: 0,
  },
};

const SERVER_HEALTH = {
  generated_at: END,
  hours: 24,
  bucket: BUCKET,
  summary: {
    online_ratio_24h: 0.92,
    abnormal_servers: 1,
    worst_disk_ratio: 0.62,
    servers_without_samples: 0,
    offline_servers: 1,
    resource_servers: 7,
    max_disk_server: "香港-01",
  },
  servers: [],
};

const SETTINGS = {
  panel_name: "PierWave",
  login_max_attempts: 5,
  login_lock_secs: 600,
  session_ttl_hours: 72,
  agent_upgrade_concurrency: 1,
  public_status_enabled: 1,
  public_billing_visible: 1,
  fx_rates: JSON.stringify({ base: "CNY", rates: {}, fetched_at: NOW - HOUR }),
  fx_rates_updated_at: NOW - HOUR,
};

const UPDATES = {
  master: {
    current: "0.18.4",
    latest: "0.18.4",
    update_available: false,
    release_url: null,
    released_at: null,
    checked_at: NOW,
    error: null,
  },
  agents: {
    current_protocol: 1,
    min_supported: 1,
    versions: [{ version: "0.18.4", count: SERVERS.length }],
  },
};

/* ------------------------------------------------------------------ *
 * Mock server / API
 * ------------------------------------------------------------------ */

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function handleApi(route) {
  const url = new URL(route.request().url());
  const path = url.pathname;

  if (path === "/api/v1/auth/me") {
    return json(route, {
      user: { id: "u-admin", username: "admin", role: "admin", short_code: "AD" },
    });
  }
  if (path === "/api/v1/health") {
    return json(route, { status: "ok", version: "0.18.4", panel_name: "PierWave" });
  }
  if (path === "/api/v1/updates") return json(route, UPDATES);
  if (path === "/api/v1/servers") return json(route, { items: SERVER_LIST });
  if (path === "/api/v1/settings") {
    return json(route, { items: SETTINGS, secret_errors: null });
  }
  if (path === "/api/v1/overview/server-health") return json(route, SERVER_HEALTH);
  if (path === "/api/v1/overview/chain-health") return json(route, CHAIN_HEALTH);
  if (path === "/api/v1/chain-templates") {
    return json(route, { items: TEMPLATE_DEFS });
  }
  if (path === "/api/v1/overview") return json(route, AGGREGATE);
  if (path === "/api/v1/stats/overview") return json(route, STATS);
  if (path === "/api/v1/stats/traffic") {
    return json(route, { days: Array.from({ length: 7 }, (_, index) => ({
      date: `2026-11-${16 + index}`,
      uplink: (index + 2) * 1024 ** 3,
      downlink: (index + 5) * 1024 ** 3,
      weighted: (index + 7) * 1024 ** 3,
    })) });
  }
  if (path === "/api/v1/chains") return json(route, { items: CHAINS });
  if (path === "/api/v1/enforcement/events") return json(route, { items: [] });
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

/* ------------------------------------------------------------------ *
 * 浏览器 / 断言 / 截图
 * ------------------------------------------------------------------ */

const { server, port } = await startStaticServer();
const base = `http://127.0.0.1:${port}`;
const { chromium } = await import(PLAYWRIGHT);
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const results = [];
const failures = [];
const screenshots = [];
let latencyReport = null;

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    failures.push(`${name}: ${error.message}`);
  }
}

async function openPage({ theme = "dark", width = 1440, query = "view=chain" }) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    colorScheme: theme,
    deviceScaleFactor: 1,
  });
  await context.addInitScript(
    ({ theme }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", "zh-CN");
    },
    { theme },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("Failed to load resource")
    ) {
      failures.push(`console: ${message.text()}`);
    }
  });
  await page.route("**/api/v1/**", handleApi);
  await page.goto(`${base}/?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-chain-list-card]", { timeout: 20_000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll("[data-chain-list-row]").length > 0 ||
      Boolean(document.querySelector("[data-chain-list-empty]")),
    undefined,
    { timeout: 20_000 },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { context, page };
}

async function snapshotCard(page, name) {
  // 列表卡可能比视口高（24 行）：把卡头滚到视口顶部再截整屏，避免
  // 元素截图在超长元素上被截断成一大片空白。截图保留页面上下文。
  await page.locator("[data-chain-list-card]").evaluate((card) => {
    // 概览页的滚动容器是 <main>，不是 window；用 scrollIntoView 让最近的
    // 可滚动祖先把卡头带到容器顶部。
    card.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await page.waitForTimeout(200);
  const path = resolve(OUT, name);
  await page.screenshot({ path });
  screenshots.push(name);
}

async function snapshotViewport(page, name) {
  const path = resolve(OUT, name);
  await page.screenshot({ path });
  screenshots.push(name);
}

async function rowStatuses(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-chain-list-row]")].map((row) =>
      row.querySelector("[data-chain-status]")?.dataset.chainStatus ?? null,
    ),
  );
}

async function rowCount(page) {
  return page.locator("[data-chain-list-row]").count();
}

async function countText(page) {
  return (await page.locator("[data-chain-list-count]").textContent())?.trim() ?? "";
}

async function statusCounts(page) {
  await page.locator("[data-chain-list-card]").evaluate((card) => {
    card.scrollIntoView({ block: "start", behavior: "instant" });
  });
  await page.waitForTimeout(150);
  await page.locator("[data-chain-status-filter]").click();
  await page.locator('[data-chain-status-option="all"]').waitFor();
  const counts = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("[data-chain-status-count]")].map((element) => [
        element.dataset.chainStatusCount,
        Number(element.textContent.trim()),
      ]),
    ),
  );
  await page.keyboard.press("Escape");
  return counts;
}

async function rowMetrics(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-chain-list-row]")].map((row) => {
      const number = (selector) => {
        const text = row.querySelector(selector)?.textContent?.trim() ?? "";
        const parsed = Number.parseFloat(text.replace(/[^\d.-]/g, ""));
        return Number.isFinite(parsed) ? parsed : null;
      };
      return {
        id: row.dataset.chainId,
        name: row.querySelector("[data-chain-row-lead] span")?.textContent?.trim() ?? "",
        p50: number("[data-chain-p50]"),
        loss: number("[data-chain-loss]"),
        status: row.querySelector("[data-chain-status]")?.dataset.chainStatus ?? null,
      };
    }),
  );
}

async function assertNoOverflow(page, label) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const card = document.querySelector("[data-chain-list-card]");
    return {
      docScroll: doc.scrollWidth,
      docClient: doc.clientWidth,
      cardScroll: card?.scrollWidth ?? 0,
      cardClient: card?.clientWidth ?? 0,
      viewport: window.innerWidth,
    };
  });
  assert.ok(
    metrics.docScroll <= metrics.docClient + 1,
    `${label}: document overflows (${metrics.docScroll} > ${metrics.docClient})`,
  );
  assert.ok(
    metrics.cardScroll <= metrics.cardClient + 1,
    `${label}: card overflows (${metrics.cardScroll} > ${metrics.cardClient})`,
  );
}

const THEMES = ["dark", "light"];
const WIDTHS = [1440, 390];
const STATUS_QUERY = {
  all: "view=chain",
  ok: "view=chain&status=ok",
  degraded: "view=chain&status=degraded",
  blocked: "view=chain&status=blocked",
  unknown: "view=chain&status=unknown",
  insufficient: "view=chain&status=insufficient",
  disabled: "view=chain&status=disabled",
};

/* 1. 状态各档：截图 + 行内状态与徽章口径一致 + 数量。 */
for (const theme of THEMES) {
  for (const status of Object.keys(STATUS_QUERY)) {
    await check(`status ${status} (${theme})`, async () => {
      const { context, page } = await openPage({
        theme,
        width: 1440,
        query: STATUS_QUERY[status],
      });
      const statuses = await rowStatuses(page);
      const count = await rowCount(page);
      assert.equal(count, EXPECTED_COUNTS[status], `${status}: row count`);
      if (status !== "all") {
        assert.ok(
          statuses.every((item) => item === status),
          `${status}: every visible row must show the selected badge state`,
        );
      }
      assert.equal(
        await countText(page),
        status === "all" ? "24 条" : `24 条 · 筛出 ${EXPECTED_COUNTS[status]} 条`,
        `${status}: count text`,
      );
      await snapshotCard(page, `status-${status}-${theme}-1440.png`);
      await context.close();
      return { rows: count, statuses: [...new Set(statuses)] };
    });
  }
}

/* 2. 390 下每一档同样渲染 + 无横向溢出。 */
for (const theme of THEMES) {
  for (const status of Object.keys(STATUS_QUERY)) {
    await check(`status ${status} 390 (${theme})`, async () => {
      const { context, page } = await openPage({
        theme,
        width: 390,
        query: STATUS_QUERY[status],
      });
      await assertNoOverflow(page, `status ${status} 390 ${theme}`);
      const rows = await rowCount(page);
      await snapshotCard(page, `status-${status}-${theme}-390.png`);
      await context.close();
      return { rows };
    });
  }
}

/* 3. 下拉里的状态数量，与行内数量一致；1440 / 390 都看得到数量。 */
for (const theme of THEMES) {
  for (const width of WIDTHS) {
    await check(`status counts dropdown (${theme}, ${width})`, async () => {
      const { context, page } = await openPage({ theme, width });
      const counts = await statusCounts(page);
      assert.deepEqual(counts, EXPECTED_COUNTS);
      await page.locator("[data-chain-status-filter]").click();
      await page.locator('[data-chain-status-option="blocked"]').waitFor();
      await snapshotViewport(page, `status-dropdown-${theme}-${width}.png`);
      await context.close();
      return counts;
    });
  }
}

/* 4. 关键词过滤：名称 / 地址 / 服务器 / 模板，URL 与计数同步。 */
await check("search by chain name writes q and filters rows", async () => {
  const { context, page } = await openPage({ width: 1440 });
  await page.locator("[data-chain-search]").fill("港日");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-chain-list-row]").length === 6,
  );
  assert.equal(new URL(page.url()).searchParams.get("q"), "港日");
  assert.equal(await countText(page), "24 条 · 筛出 6 条");
  assert.equal(await rowCount(page), EXPECTED_Q_HITS);
  await snapshotCard(page, "search-港日-dark-1440.png");
  await context.close();
  return { rows: 6 };
});

await check("search matches entry/exit address and server name", async () => {
  const { context, page } = await openPage({ width: 1440 });
  await page.locator("[data-chain-search]").fill("大阪-01");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-chain-list-row]").length === 3,
  );
  const metrics = await rowMetrics(page);
  assert.deepEqual(
    metrics.map((row) => row.id).sort(),
    ["chain-02", "chain-05", "chain-14"],
  );
  await page.locator("[data-chain-search]").fill("198.51.100.30");
  await page.waitForTimeout(150);
  // 只有起点 / 终点地址参与搜索：大阪-01 作为出口命中 05，作为入口命中 14。
  assert.equal(await rowCount(page), 2, "address search should hit entry/exit chains");
  await context.close();
  return metrics.map((row) => row.name);
});

await check("search matches template name", async () => {
  const { context, page } = await openPage({ width: 1440 });
  await page.locator("[data-chain-search]").fill("港日中转模板");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-chain-list-row]").length === 3,
  );
  const metrics = await rowMetrics(page);
  assert.deepEqual(
    metrics.map((row) => row.id).sort(),
    ["chain-01", "chain-02", "chain-05"],
  );
  await context.close();
  return metrics.map((row) => row.name);
});

await check("search and status filter stack", async () => {
  const { context, page } = await openPage({
    width: 1440,
    query: "view=chain&status=blocked&q=港日",
  });
  assert.equal(await rowCount(page), 1);
  assert.deepEqual(await rowStatuses(page), ["blocked"]);
  assert.equal(await countText(page), "24 条 · 筛出 1 条");
  await snapshotCard(page, "combined-blocked-港日-dark-1440.png");
  await context.close();
  return { rows: 1 };
});

await check("typing updates q without losing characters", async () => {
  const { context, page } = await openPage({ width: 1440 });
  const input = page.locator("[data-chain-search]");
  await input.pressSequentially("203", { delay: 80 });
  await page.waitForTimeout(400);
  assert.equal(await input.inputValue(), "203");
  assert.equal(new URL(page.url()).searchParams.get("q"), "203");
  assert.ok((await rowCount(page)) > 0, "address digits should match chains");
  await context.close();
  return { value: "203" };
});

await check("keyword filter latency on 24 chains", async () => {
  const { context, page } = await openPage({ width: 1440 });
  const cases = [
    { query: "港日", rows: 6 },
    { query: "港日中转模板", rows: 3 },
    { query: "大阪-01", rows: 3 },
    { query: "198.51.100.30", rows: 2 },
    { query: "不存在的链路", rows: 0 },
  ];
  const samples = [];
  for (const item of cases) {
    for (let round = 0; round < 2; round += 1) {
      await page.locator("[data-chain-search]").fill("");
      await page.waitForFunction(
        () =>
          document.querySelectorAll("[data-chain-list-row]").length === 24 &&
          !new URLSearchParams(location.search).has("q"),
      );
      const ms = await page.evaluate(
        ({ query, expectedRows }) => {
          const input = document.querySelector("[data-chain-search]");
          if (!(input instanceof HTMLInputElement)) {
            throw new Error("search input missing");
          }
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set;
          if (!setter) throw new Error("value setter missing");
          const start = performance.now();
          setter.call(input, query);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return new Promise((resolve, reject) => {
            let frames = 0;
            const tick = () => {
              const rows = document.querySelectorAll(
                "[data-chain-list-row]",
              ).length;
              const empty = Boolean(
                document.querySelector("[data-chain-list-empty]"),
              );
              if (rows === expectedRows || (expectedRows === 0 && empty)) {
                resolve(performance.now() - start);
                return;
              }
              frames += 1;
              if (frames > 240) {
                reject(new Error(`timeout waiting for ${expectedRows} rows`));
                return;
              }
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
        },
        { query: item.query, expectedRows: item.rows },
      );
      await page.waitForFunction(
        (q) => new URLSearchParams(location.search).get("q") === q,
        item.query,
      );
      samples.push({ query: item.query, ms: Math.round(ms * 10) / 10 });
    }
  }
  const values = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const medianMs = values[Math.floor(values.length / 2)];
  const maxMs = values[values.length - 1];
  const minMs = values[0];
  // 24 条链的纯前端过滤不应接近 1 秒；这里只做防退化，不用来卡性能预算。
  assert.ok(medianMs < 500, `median input latency ${medianMs}ms is too high`);
  latencyReport = { samples, minMs, medianMs, maxMs, method: "input event → filtered rows painted (requestAnimationFrame)" };
  await context.close();
  return latencyReport;
});

await check("search clear button resets q", async () => {
  const { context, page } = await openPage({ width: 1440 });
  await page.locator("[data-chain-search]").fill("港日");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-chain-list-row]").length === 6,
  );
  await page.locator("[data-chain-search-clear]").click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-chain-list-row]").length === 24,
  );
  assert.equal(new URL(page.url()).searchParams.get("q"), null);
  assert.equal(await page.locator("[data-chain-search]").inputValue(), "");
  await context.close();
  return { rows: 24 };
});

/* 5. 空态：文案 + 清除筛选按钮；点完恢复全部。 */
await check("empty state copy and clear filters button", async () => {
  const { context, page } = await openPage({
    width: 1440,
    query: "view=chain&status=blocked&q=不存在的链路",
  });
  const empty = page.locator("[data-chain-list-empty]");
  await empty.waitFor();
  assert.equal((await empty.textContent())?.includes("没有匹配的链路"), true);
  assert.equal(await countText(page), "24 条 · 筛出 0 条");
  await snapshotCard(page, "empty-dark-1440.png");
  await page.locator("[data-chain-clear-filters]").click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("[data-chain-list-row]").length === 24 &&
      !document.querySelector("[data-chain-list-empty]"),
  );
  const url = new URL(page.url());
  assert.equal(url.searchParams.get("status"), null);
  assert.equal(url.searchParams.get("q"), null);
  assert.equal(await countText(page), "24 条");
  await context.close();
  return { empty: true };
});

/* 6. URL 持久化：刷新后筛选与搜索仍在。 */
await check("filters survive a reload", async () => {
  const { context, page } = await openPage({ width: 1440 });
  await page.locator("[data-chain-search]").fill("港日");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-chain-list-row]").length === 6,
  );
  await page.locator("[data-chain-status-filter]").click();
  await page.locator('[data-chain-status-option="degraded"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll("[data-chain-list-row]").length === 1,
  );
  const url = new URL(page.url());
  assert.equal(url.searchParams.get("q"), "港日");
  assert.equal(url.searchParams.get("status"), "degraded");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-chain-list-row]");
  assert.equal(await page.locator("[data-chain-search]").inputValue(), "港日");
  assert.equal(await rowCount(page), 1);
  assert.deepEqual(await rowStatuses(page), ["degraded"]);
  const triggerText = (await page.locator("[data-chain-status-filter]").textContent())?.trim() ?? "";
  assert.ok(triggerText.includes("降级"), `trigger should show 降级, got ${triggerText}`);
  const finalUrl = page.url();
  await context.close();
  return { url: finalUrl };
});

/* 7. 390 关键词 / 叠加 / 空态 / 排序 + 亮暗截图。 */
for (const theme of THEMES) {
  await check(`390 keyword + combined + empty (${theme})`, async () => {
    const { context, page } = await openPage({
      theme,
      width: 390,
      query: "view=chain&q=港日",
    });
    assert.equal(await rowCount(page), 6);
    assert.equal(await countText(page), "24 条 · 筛出 6 条");
    await assertNoOverflow(page, `390 search ${theme}`);
    await snapshotCard(page, `search-港日-${theme}-390.png`);

    await page.goto(`${base}/?view=chain&status=blocked&q=港日`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("[data-chain-list-row]");
    assert.equal(await rowCount(page), 1);
    await assertNoOverflow(page, `390 combined ${theme}`);
    await snapshotCard(page, `combined-blocked-港日-${theme}-390.png`);

    await page.goto(`${base}/?view=chain&q=不存在的链路`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("[data-chain-list-empty]").waitFor();
    await assertNoOverflow(page, `390 empty ${theme}`);
    await snapshotCard(page, `empty-${theme}-390.png`);
    await context.close();
    return { search: 6, combined: 1, empty: true };
  });
}

/* 8. 排序：表头点击切换升降序；下拉覆盖最近样本。 */
await check("P50 header toggles ascending / descending", async () => {
  const { context, page } = await openPage({ width: 1440 });
  const before = (await rowMetrics(page)).map((row) => row.id);
  await page.locator('[data-chain-sort-header="p50"]').click();
  await page.waitForTimeout(150);
  const ascending = await rowMetrics(page);
  const values = ascending.map((row) => row.p50).filter((value) => value !== null);
  assert.deepEqual(values, [...values].sort((a, b) => a - b), "P50 ascending");
  assert.notDeepEqual(ascending.map((row) => row.id), before, "sort changes order");
  assert.ok(
    ((await page.locator('[data-chain-sort-header="p50"]').getAttribute("aria-label")) ?? "")
      .includes("升序"),
  );
  await snapshotCard(page, "sort-p50-asc-dark-1440.png");

  await page.locator('[data-chain-sort-header="p50"]').click();
  await page.waitForTimeout(150);
  const descending = await rowMetrics(page);
  const descValues = descending.map((row) => row.p50).filter((value) => value !== null);
  assert.deepEqual(
    descValues,
    [...descValues].sort((a, b) => b - a),
    "P50 descending",
  );
  await context.close();
  return { ascending: ascending.length, descending: descending.length };
});

await check("loss sort selector and default order reset", async () => {
  const { context, page } = await openPage({ width: 1440 });
  await page.locator("[data-chain-sort]").click();
  await page.locator('[data-chain-sort-option="loss-desc"]').click();
  await page.waitForTimeout(150);
  const losses = (await rowMetrics(page))
    .map((row) => row.loss)
    .filter((value) => value !== null);
  assert.deepEqual(losses, [...losses].sort((a, b) => b - a), "loss descending");
  await page.locator("[data-chain-sort]").click();
  await page.locator('[data-chain-sort-option="default"]').click();
  await page.waitForTimeout(150);
  assert.equal(
    await page.locator('[data-chain-sort]').textContent().then((text) => text?.trim()),
    "默认顺序",
  );
  await context.close();
  return { losses: losses.length };
});

await check("sort selector exposes latest sample", async () => {
  const { context, page } = await openPage({ width: 1440 });
  await page.locator("[data-chain-sort]").click();
  const options = await page.evaluate(() =>
    [...document.querySelectorAll("[data-chain-sort-option]")].map((element) => ({
      value: element.dataset.chainSortOption,
      text: element.textContent?.trim() ?? "",
    })),
  );
  assert.ok(options.some((option) => option.value === "latest-desc"));
  assert.ok(options.some((option) => option.value === "p50-asc"));
  assert.ok(options.some((option) => option.value === "loss-desc"));
  assert.ok(options.every((option) => option.text.includes("·") || option.value === "default"));
  await page.locator('[data-chain-sort-option="latest-desc"]').click();
  await page.waitForTimeout(150);
  assert.ok(
    ((await page.locator("[data-chain-sort]").textContent()) ?? "").includes("最近样本"),
  );
  await context.close();
  return options;
});

/* 9. 离开链路时延 tab 清理筛选参数。 */
await check("status/q coexist with series/section and all leave the chain tab", async () => {
  const { context, page } = await openPage({
    width: 1440,
    query:
      "view=chain&section=chains&series=chain-01,chain-02&status=blocked&q=港日",
  });
  const initial = new URL(page.url());
  assert.equal(initial.searchParams.get("status"), "blocked");
  assert.equal(initial.searchParams.get("q"), "港日");
  assert.equal(initial.searchParams.get("section"), "chains");
  assert.equal(
    initial.searchParams.get("series"),
    "chain-01,chain-02",
    "筛选不能覆盖兄弟 lane 的 series",
  );

  // 改关键词：series / section / status 都不能被筛选写入覆盖。
  await page.locator("[data-chain-search]").fill("香港");
  await page.waitForFunction(
    () => new URLSearchParams(location.search).get("q") === "香港",
  );
  const afterFilter = new URL(page.url());
  assert.equal(afterFilter.searchParams.get("status"), "blocked");
  assert.equal(afterFilter.searchParams.get("section"), "chains");
  assert.equal(afterFilter.searchParams.get("series"), "chain-01,chain-02");

  await page.getByRole("tab", { name: "流量" }).click();
  await page.waitForFunction(
    () => !new URLSearchParams(location.search).has("status"),
  );
  const left = new URL(page.url());
  assert.equal(left.searchParams.get("view"), "traffic");
  for (const key of ["status", "q", "series", "section", "chain"]) {
    assert.equal(left.searchParams.get(key), null, `${key} 不能跟到其它 tab`);
  }
  const finalUrl = page.url();
  await context.close();
  return { initial: initial.search, afterFilter: afterFilter.search, finalUrl };
});

/* 10. 亮暗主题 390 筛选栏近景。 */
for (const theme of THEMES) {
  await check(`390 filter header (${theme})`, async () => {
    const { context, page } = await openPage({ theme, width: 390 });
    await assertNoOverflow(page, `390 header ${theme}`);
    await snapshotCard(page, `header-${theme}-390.png`);
    await context.close();
    return { width: 390 };
  });
}

await browser.close();
server.close();

const report = {
  generatedAt: new Date().toISOString(),
  expectedCounts: EXPECTED_COUNTS,
  expectedQueryHits: EXPECTED_Q_HITS,
  latency: latencyReport,
  screenshots,
  results,
  failures,
};
writeFileSync(resolve(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

for (const result of results) {
  console.log(`${result.ok ? "✔" : "✘"} ${result.name}`);
}
console.log(
  `\n${results.length - failures.length}/${results.length} checks passed; ${screenshots.length} screenshots`,
);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
