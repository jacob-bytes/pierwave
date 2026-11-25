// Screenshots + assertions for the overview KPI / sub-tab / heatmap / traffic
// leaderboard fixes.
//
// Usage:
//   cd web && npm run build
//   node screenshots/overview-kpi-fixes/shots.mjs
//
// Serves `web/dist` and mocks every API the overview needs, so no controller or
// database is involved. Playwright is taken from the repo's npx cache (same
// approach as screenshots/overview-views/app-shots.mjs).
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const OUT = fileURLToPath(new URL(".", import.meta.url));
const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHINESE = "zh-CN";
const HOUR = 3600;
const NOW = Math.floor(Date.now() / 1000);
const END = Math.floor(NOW / HOUR) * HOUR;
const START = END - 167 * HOUR;

mkdirSync(OUT, { recursive: true });

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

/**
 * 10 台服务器：
 * - 4 台有在线样本（其中 1 台在窗口尾部离线，属于「部分离线」，保留展开）；
 * - 5 台整段离线；
 * - 1 台整段无采样。
 * 因此折叠后聚合行是 6 台，热力图可见 4 + 1 行。
 */
const SERVER_DEFS = [
  {
    id: "hk-01",
    name: "香港-01",
    group: "香港",
    status: "online",
    health: "online",
    currency: "CNY",
    price_cents: 26800,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-01-31",
    load1: 0.42,
    mem: [3650722201, 8589934592],
    disk: [45097156608, 85899345920],
  },
  {
    id: "hk-02",
    name: "香港-02",
    group: "香港",
    status: "online",
    health: "online",
    currency: "USD",
    price_cents: 12000,
    billing_cycle: "yearly",
    billing_cycle_count: 1,
    billing_cycle_unit: "year",
    paid_until: "2027-03-31",
    load1: 0.51,
    mem: [4982162063, 8589934592],
    disk: [54975581389, 85899345920],
  },
  {
    id: "tokyo-01",
    name: "东京-01",
    group: "日本",
    status: "online",
    health: "partial",
    currency: "CNY",
    price_cents: 36000,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-02-28",
    load1: 0.62,
    mem: [5927054868, 8589934592],
    disk: [65283502899, 85899345920],
  },
  {
    id: "sg-01",
    name: "新加坡-01",
    group: "东南亚",
    status: "online",
    health: "online",
    currency: "EUR",
    price_cents: 30400,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-02-28",
    load1: 0.35,
    mem: [4123168604, 8589934592],
    disk: [78168404787, 85899345920],
  },
  {
    id: "fra-01",
    name: "法兰克福-01",
    group: "欧洲",
    status: "offline",
    health: "offline",
    currency: "USD",
    price_cents: 15800,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-01-31",
    load1: 0.28,
    mem: [3350074490, 8589934592],
    disk: [48962627174, 85899345920],
  },
  {
    id: "fra-02",
    name: "法兰克福-02",
    group: "欧洲",
    status: "offline",
    health: "offline",
    currency: "CNY",
    price_cents: 12800,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-01-31",
    load1: 0.31,
    mem: [4466765987, 8589934592],
    disk: [50680614092, 85899345920],
  },
  {
    id: "us-01",
    name: "美西-01",
    group: "北美",
    status: "offline",
    health: "offline",
    currency: "CNY",
    price_cents: 199900,
    billing_cycle: "once",
    billing_cycle_count: 1,
    billing_cycle_unit: "once",
    paid_until: "2027-06-30",
    load1: 0.44,
    mem: [4294967296, 8589934592],
    disk: [42949672960, 85899345920],
  },
  {
    id: "us-02",
    name: "美西-02",
    group: "北美",
    status: "offline",
    health: "offline",
    currency: "CNY",
    price_cents: 9900,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-01-31",
    load1: 0.37,
    mem: [3865470566, 8589934592],
    disk: [47244640256, 85899345920],
  },
  {
    id: "syd-01",
    name: "悉尼-01",
    group: "大洋洲",
    status: "offline",
    health: "offline",
    currency: "JPY",
    price_cents: 128000,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-01-31",
    load1: 0.22,
    mem: [3865470566, 8589934592],
    disk: [52400652288, 85899345920],
  },
  {
    id: "osaka-01",
    name: "大阪-01",
    group: "日本",
    status: "unknown",
    health: "nosample",
    currency: "CNY",
    price_cents: 50000,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: null,
    load1: null,
    mem: [0, 8589934592],
    disk: [0, 85899345920],
  },
];

const OFFLINE_DEFS = SERVER_DEFS.filter(
  (def) => def.health === "offline" || def.health === "nosample",
);

function serverItem(def, index) {
  const [memUsed, memTotal] = def.mem;
  const [diskUsed, diskTotal] = def.disk;
  return {
    id: def.id,
    name: def.name,
    address: `10.0.0.${index + 1}`,
    xray_mode: "auto",
    status: def.status,
    group_name: def.group,
    last_seen_at: def.status === "offline" ? NOW - 7 * HOUR : NOW - 30,
    config_version: 3,
    created_at: NOW - 30 * 86400,
    agent_version: "0.18.3",
    allow_agent_upgrade: false,
    agent_target_version: null,
    xray_running: def.status === "offline" ? null : true,
    nginx_running: def.status === "offline" ? null : true,
    load1: def.load1,
    mem_used: def.health === "nosample" ? null : memUsed,
    mem_total: def.status === "offline" ? null : memTotal,
    disk_used: def.health === "nosample" ? null : diskUsed,
    disk_total: def.status === "offline" ? null : diskTotal,
    uptime_secs: 86400 * 20,
    latency_ms: def.load1 === null ? null : 28 + index * 7,
    health_at: def.health === "nosample" ? null : NOW - 30,
    arch: "x86_64",
    os_name: "Ubuntu",
    os_version: "24.04",
    virt: "kvm",
    country_code: ["HK", "HK", "JP", "SG", "DE", "DE", "US", "US", "AU", "JP"][
      index
    ],
    paid_until: def.paid_until,
    price_cents: def.price_cents,
    currency: def.currency,
    billing_cycle: def.billing_cycle,
    billing_cycle_count: def.billing_cycle_count,
    billing_cycle_unit: def.billing_cycle_unit,
  };
}

const SERVER_LIST = SERVER_DEFS.map(serverItem);

function healthBucket(ts, def, index) {
  const online =
    def.health === "offline"
      ? false
      : def.health === "partial"
        ? index < 138
        : true;
  return {
    ts,
    online,
    online_ratio: online ? (def.health === "partial" ? 0.973 : 0.999) : 0,
    load1_avg: def.load1 ?? 0.4,
    load1_max: (def.load1 ?? 0.4) + 0.2,
    mem_ratio_max: 0.44,
    disk_ratio_max:
      def.id === "sg-01" ? 0.91 : 0.53,
    samples: 12,
    outage_samples: online ? 0 : 12,
  };
}

function healthServer(def, index) {
  const buckets =
    def.health === "nosample"
      ? Array.from({ length: 168 }, () => null)
      : Array.from({ length: 168 }, (_, bucketIndex) => {
          const ts = START + bucketIndex * HOUR;
          return healthBucket(ts, def, bucketIndex);
        });
  const sampled = buckets.filter(Boolean);
  return {
    id: def.id,
    name: def.name,
    status: def.status,
    online_ratio:
      sampled.length === 0
        ? null
        : sampled.filter((bucket) => bucket.online).length / sampled.length,
    buckets,
  };
}

const SERVER_HEALTH = {
  generated_at: END,
  hours: 168,
  bucket: HOUR,
  summary: {
    online_ratio_24h: 0.742,
    abnormal_servers: 6,
    worst_disk_ratio: 0.91,
    servers_without_samples: 1,
    offline_servers: 6,
    resource_servers: 0,
    max_disk_server: "新加坡-01",
  },
  servers: SERVER_DEFS.map(healthServer),
};

const TRAFFIC_DAYS = Array.from({ length: 7 }, (_, index) => ({
  date: `2026-11-${16 + index}`,
  uplink: (index + 2) * 1024 ** 3,
  downlink: (index + 5) * 1024 ** 3,
  weighted: (index + 7) * 1024 ** 3,
}));

const AGGREGATE = {
  kpi: {
    servers_online: 4,
    servers_total: 10,
    nodes: 10,
    traffic_today: 32 * 1024 ** 3,
    traffic_month: 254 * 1024 ** 3,
    uptime_24h: 74.2,
  },
  series: TRAFFIC_DAYS.map((day) => ({
    day: day.date,
    uplink: day.uplink,
    downlink: day.downlink,
  })),
  protocol_series: [
    {
      protocol: "vless",
      days: TRAFFIC_DAYS.map((day, index) => ({
        day: day.date,
        bytes: (index + 3) * 1024 ** 3,
      })),
    },
    {
      protocol: "hysteria2",
      days: TRAFFIC_DAYS.map((day, index) => ({
        day: day.date,
        bytes: (index + 1) * 512 * 1024 ** 2,
      })),
    },
  ],
  protocols: [
    { protocol: "vless", nodes: 7, traffic_7d: 84 * 1024 ** 3 },
    { protocol: "hysteria2", nodes: 3, traffic_7d: 18 * 1024 ** 3 },
    { protocol: "trojan", nodes: 2, traffic_7d: 6 * 1024 ** 3 },
  ],
  chains: {
    total: 2,
    degraded: 1,
    blocked: 0,
    forwards_total: 2,
    forwards_failing: 0,
    handshake_failures: 0,
  },
  top: SERVER_DEFS.slice(0, 5).map((def, index) => ({
    kind: "server",
    server_id: def.id,
    name: def.name,
    traffic_7d: (5 - index) * 21 * 1024 ** 3,
    load1: [0.42, 0.51, 0.62, 0.35, 0.28][index],
    online: def.status !== "offline",
    rates: [],
  })),
  top_users: [
    { user_id: "u1", username: "alice", traffic_7d: 32 * 1024 ** 3 },
    { user_id: "u2", username: "bob", traffic_7d: 21 * 1024 ** 3 },
    { user_id: "u3", username: "carol", traffic_7d: 12 * 1024 ** 3 },
  ],
  top_nodes: [
    {
      node_id: "n1",
      name: "HK-01 VLESS",
      protocol: "vless",
      server_name: "香港-01",
      traffic_7d: 24 * 1024 ** 3,
    },
    {
      node_id: "n2",
      name: "JP-01 HY2",
      protocol: "hysteria2",
      server_name: "东京-01",
      traffic_7d: 18 * 1024 ** 3,
    },
  ],
  package_split: [
    { package_id: "p1", name: "标准套餐", users: 4, traffic_7d: 62 * 1024 ** 3 },
    { package_id: "p2", name: "高级套餐", users: 2, traffic_7d: 46 * 1024 ** 3 },
  ],
};

const STATS = {
  servers: { total: 10, online: 4 },
  users: { total: 6, active: 6 },
  packages: { total: 4, instances: 5 },
  traffic: {
    today_bytes: 32 * 1024 ** 3,
    month_bytes: 254 * 1024 ** 3,
  },
  alerts: {
    expired_instances: 0,
    exhausted_instances: 0,
    offline_servers: 6,
    expiring_certs: 0,
  },
};

const SETTINGS = {
  panel_name: "PierWave",
  login_max_attempts: 5,
  login_lock_secs: 600,
  session_ttl_hours: 72,
  agent_upgrade_concurrency: 1,
  public_status_enabled: 1,
  public_billing_visible: 1,
  fx_rates: JSON.stringify({
    base: "CNY",
    rates: { USD: 7.2, EUR: 7.8, JPY: 0.048 },
    fetched_at: NOW - HOUR,
    source: "open.er-api.com",
  }),
  fx_rates_updated_at: NOW - HOUR,
};

function member(def, index, seq, latency) {
  return {
    server_id: def.id,
    server_name: def.name,
    listen_port: 8443 + seq * 1000,
    priority: 0,
    weight: 1,
    forward_id: `f-${index}-${seq}`,
    listening: true,
    target_ok: true,
    target_error: null,
    latency_ms: latency,
    target_latency_ms: null,
    degraded: false,
  };
}

const CHAINS = [
  {
    id: "chain-hk-jp-sg",
    name: "港日新链",
    target_host: "example.com",
    target_port: 443,
    enabled: true,
    engine: "realm",
    protocol: "tcp",
    udp: false,
    transport: "tls",
    degraded: false,
    blocked_reason: null,
    path_mode: "single",
    total_latency_ms: 67,
    groups: [
      {
        id: "g0",
        seq: 0,
        name: null,
        strategy: "round_robin",
        cert_id: null,
        degraded: false,
        members: [member(SERVER_DEFS[0], 0, 0, 28)],
      },
      {
        id: "g1",
        seq: 1,
        name: null,
        strategy: "round_robin",
        cert_id: null,
        degraded: false,
        members: [member(SERVER_DEFS[2], 2, 1, 39)],
      },
    ],
    created_at: NOW - 30 * 86400,
    updated_at: NOW - HOUR,
  },
  {
    id: "chain-degraded",
    name: "四跳长链-演示",
    target_host: "long.example.com",
    target_port: 443,
    enabled: true,
    engine: "realm",
    protocol: "tcp",
    udp: false,
    transport: "tls",
    degraded: true,
    blocked_reason: null,
    path_mode: "single",
    total_latency_ms: 120,
    groups: [
      {
        id: "g0",
        seq: 0,
        name: null,
        strategy: "failover",
        cert_id: null,
        degraded: false,
        members: [member(SERVER_DEFS[1], 1, 0, 31)],
      },
      {
        id: "g1",
        seq: 1,
        name: null,
        strategy: "failover",
        cert_id: null,
        degraded: true,
        members: [member(SERVER_DEFS[3], 3, 1, 52)],
      },
    ],
    created_at: NOW - 10 * 86400,
    updated_at: NOW - HOUR,
  },
];

function chainSeries(base, count = 96) {
  const bucket = 900;
  return Array.from({ length: count }, (_, index) => ({
    ts: END - (count - 1 - index) * bucket,
    p50: base + Math.sin(index / 6) * 4,
    p10: base - 6 + Math.cos(index / 8) * 2,
    p90: base + 9 + Math.sin(index / 9) * 3,
    samples: 3,
    loss_pct: index % 17 === 0 ? 0.4 : 0,
  }));
}

const CHAIN_HEALTH = {
  generated_at: END,
  hours: 24,
  bucket: 900,
  summary: {
    hop_p50_ms: 31,
    delta_ms: 12,
    slow_chains: 1,
    total_chains: 2,
    worst_hop: {
      chain_id: "chain-degraded",
      chain_name: "四跳长链-演示",
      seq: 1,
      p50_ms: 52,
    },
    loss_pct: 0.4,
  },
  chains: [
    {
      id: "chain-hk-jp-sg",
      name: "港日新链",
      hops: 2,
      status: { kind: "ok", cause: null },
      estimated: false,
      series: chainSeries(30),
      segments: [
        {
          seq: 1,
          from: "香港-01",
          to: "东京-01",
          p50: 28,
          delta_ms: 0,
          contribution_pct: 0,
          attempts: 96,
          failures: 0,
          loss_pct: 0,
        },
        {
          seq: 2,
          from: "东京-01",
          to: "example.com",
          p50: 39,
          delta_ms: 11,
          contribution_pct: 100,
          attempts: 96,
          failures: 1,
          loss_pct: 1.04,
        },
      ],
      diagnosis: { kind: "single_hop", seq: 2 },
    },
    {
      id: "chain-degraded",
      name: "四跳长链-演示",
      hops: 2,
      status: { kind: "degraded", cause: "slow" },
      estimated: false,
      series: chainSeries(58),
      segments: [
        {
          seq: 1,
          from: "香港-02",
          to: "新加坡-01",
          p50: 31,
          delta_ms: 2,
          contribution_pct: 20,
          attempts: 96,
          failures: 0,
          loss_pct: 0,
        },
        {
          seq: 2,
          from: "新加坡-01",
          to: "long.example.com",
          p50: 52,
          delta_ms: 29,
          contribution_pct: 80,
          attempts: 96,
          failures: 4,
          loss_pct: 4.17,
        },
      ],
      diagnosis: { kind: "single_hop", seq: 2 },
    },
  ],
};

const TEMPLATES = {
  generated_at: END,
  items: [
    {
      id: "tpl-1",
      name: "港日新 · 标准",
      hops: 3,
      enabled: true,
      chains: 2,
      users: 4,
      status: { kind: "ok", cause: null },
      strategies: [{ strategy: "round_robin", chains: 2, users: 4 }],
      targets: [{ host: "example.com", port: 443, chains: 2 }],
    },
    {
      id: "tpl-2",
      name: "欧洲四跳 · 高可用",
      hops: 4,
      enabled: true,
      chains: 1,
      users: 2,
      status: { kind: "degraded", cause: "member_offline" },
      strategies: [{ strategy: "failover", chains: 1, users: 2 }],
      targets: [{ host: "long.example.com", port: 443, chains: 1 }],
    },
    {
      id: "tpl-3",
      name: "美西直连",
      hops: 1,
      enabled: true,
      chains: 1,
      users: 3,
      status: { kind: "ok", cause: null },
      strategies: [{ strategy: "lowest_latency", chains: 1, users: 3 }],
      targets: [{ host: "us.example.com", port: 8443, chains: 1 }],
    },
    {
      id: "tpl-4",
      name: "备份链路",
      hops: 2,
      enabled: false,
      chains: 0,
      users: 0,
      status: { kind: "unknown", cause: "disabled" },
      strategies: [],
      targets: [],
    },
    {
      id: "tpl-5",
      name: "东京中转",
      hops: 2,
      enabled: true,
      chains: 0,
      users: 0,
      status: { kind: "ok", cause: null },
      strategies: [],
      targets: [],
    },
  ],
};

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
      user: {
        id: "u-admin",
        username: "admin",
        role: "admin",
        short_code: "AD",
      },
    });
  }
  if (path === "/api/v1/health") {
    return json(route, {
      status: "ok",
      version: "0.18.3",
      panel_name: "PierWave",
    });
  }
  if (path === "/api/v1/updates") {
    return json(route, {
      master: {
        current: "0.18.3",
        latest: "0.18.3",
        update_available: false,
        release_url: null,
        released_at: null,
        checked_at: NOW,
        error: null,
      },
      agents: {
        current_protocol: 1,
        min_supported: 1,
        versions: [{ version: "0.18.3", count: SERVER_LIST.length }],
      },
    });
  }
  if (path === "/api/v1/servers") {
    return json(route, { items: SERVER_LIST });
  }
  if (path === "/api/v1/settings") {
    return json(route, { items: SETTINGS, secret_errors: null });
  }
  if (path === "/api/v1/overview/server-health") {
    return json(route, SERVER_HEALTH);
  }
  if (path === "/api/v1/overview") {
    return json(route, {
      ...AGGREGATE,
      scope: {
        server_ids: SERVER_LIST.map((server) => server.id),
        servers_matched: SERVER_LIST.length,
        filtered: false,
        global: true,
      },
      warnings: { unknown_ids: [] },
    });
  }
  if (path === "/api/v1/overview/chain-health") {
    return json(route, CHAIN_HEALTH);
  }
  if (path === "/api/v1/overview/chain-templates") {
    return json(route, TEMPLATES);
  }
  if (path === "/api/v1/stats/overview") {
    return json(route, STATS);
  }
  if (path === "/api/v1/stats/traffic") {
    return json(route, { days: TRAFFIC_DAYS });
  }
  if (path === "/api/v1/enforcement/events") {
    return json(route, { items: [] });
  }
  if (path === "/api/v1/chains") {
    return json(route, { items: CHAINS });
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

const KPI_SELECTOR = {
  server: "[data-server-kpis]",
  cost: "[data-cost-kpis]",
  chain: "[data-chain-kpis]",
  templates: "[data-chain-template-kpis]",
};

const KPI_VIEWS = [
  { id: "server", query: "view=server", wait: "[data-server-kpis]" },
  { id: "cost", query: "view=cost", wait: "[data-cost-kpis]" },
  { id: "chain", query: "view=chain", wait: "[data-chain-kpis]" },
  {
    id: "templates",
    query: "view=chain&section=templates",
    wait: "[data-chain-template-kpis]",
  },
];

const errors = [];
const report = { generatedAt: new Date().toISOString(), kpi: {}, heatmap: {}, subtabs: {}, traffic: {} };

const { server, port } = await startStaticServer();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function openPage({ theme, width, query }) {
  const page = await browser.newPage({
    viewport: { width, height: 1000 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(
        `${response.status()} ${new URL(response.url()).pathname}`,
      );
    }
  });
  await page.addInitScript(
    ({ theme, locale }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale: CHINESE },
  );
  await page.route("**/api/v1/**", (route) => handleApi(route));
  await page.goto(`${base}/?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-overview-insight]", { timeout: 20000 });
  return page;
}

/** 读取 KPI 条的栅格 / 字号 / 高度。 */
async function readKpi(page, selector) {
  return page.evaluate((sel) => {
    const card = document.querySelector(sel);
    if (!card) return null;
    const cells = [...card.querySelectorAll("[data-chain-kpi-cell]")];
    const content = card.querySelector('[data-slot="card-content"]');
    const rects = cells.map((cell) => cell.getBoundingClientRect());
    const value = cells[0]?.querySelector("[data-chain-kpi-value]");
    const hint = cells[0]?.querySelector("[data-chain-kpi-hint]");
    const label = cells[0]?.querySelector("[data-chain-kpi-label]");
    const grid = content ? getComputedStyle(content).gridTemplateColumns : "";
    return {
      height: Math.round(card.getBoundingClientRect().height * 10) / 10,
      cells: cells.length,
      cellHeights: rects.map(
        (rect) => Math.round(rect.height * 10) / 10,
      ),
      rows: new Set(rects.map((rect) => Math.round(rect.top))).size,
      columns: new Set(rects.map((rect) => Math.round(rect.left))).size,
      gridColumns: grid.split(" ").filter(Boolean).length,
      valueSize: value ? getComputedStyle(value).fontSize : null,
      hintSize: hint ? getComputedStyle(hint).fontSize : null,
      labelSize: label ? getComputedStyle(label).fontSize : null,
      firstWidth: rects[0] ? Math.round(rects[0].width) : null,
      secondWidth: rects[1] ? Math.round(rects[1].width) : null,
    };
  }, selector);
}

for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    const bars = [];
    for (const view of KPI_VIEWS) {
      const page = await openPage({ theme, width, query: view.query });
      try {
        await page.waitForSelector(view.wait, { timeout: 20000 });
        await page.waitForTimeout(250);
        const kpi = await readKpi(page, KPI_SELECTOR[view.id]);
        if (!kpi) {
          errors.push(`${view.id}/${theme}/${width}: KPI missing`);
          continue;
        }
        // 期望：桌面 4 列 / 390 2 列，KPI 条高度 = 单行或两行。
        if (kpi.gridColumns !== (width >= 640 ? 4 : 2)) {
          errors.push(
            `${view.id}/${theme}/${width}: grid has ${kpi.gridColumns} columns`,
          );
        }
        if (width >= 640) {
          if (kpi.rows !== 1) {
            errors.push(`${view.id}/${theme}/${width}: ${kpi.rows} KPI rows on desktop`);
          }
        } else if (kpi.rows !== 2) {
          errors.push(`${view.id}/${theme}/${width}: ${kpi.rows} KPI rows on mobile`);
        }
        if (kpi.valueSize !== "28px") {
          errors.push(`${view.id}/${theme}/${width}: value ${kpi.valueSize}`);
        }
        if (kpi.hintSize !== "13px") {
          errors.push(`${view.id}/${theme}/${width}: hint ${kpi.hintSize}`);
        }
        if (kpi.labelSize !== "12px") {
          errors.push(`${view.id}/${theme}/${width}: label ${kpi.labelSize}`);
        }
        if (view.id === "server" || view.id === "cost") {
          // 首格跨两列：桌面宽度 ≈ 两倍普通格，390 占满整行。
          if (
            width >= 640 &&
            kpi.firstWidth !== null &&
            kpi.secondWidth !== null &&
            Math.abs(kpi.firstWidth - kpi.secondWidth * 2) > 3
          ) {
            errors.push(
              `${view.id}/${theme}/${width}: lead cell ${kpi.firstWidth}px vs 2×${kpi.secondWidth}px`,
            );
          }
        }
        bars.push({ view: view.id, ...kpi });
        report.kpi[`${view.id}-${theme}-${width}`] = kpi;

        await page.screenshot({
          path: `${OUT}kpi-${view.id}-${theme}-${width}.png`,
          fullPage: true,
        });
        const card = page.locator(KPI_SELECTOR[view.id]);
        await card.screenshot({
          path: `${OUT}kpi-bar-${view.id}-${theme}-${width}.png`,
        });
      } finally {
        await page.close();
      }
    }
    // 四个 KPI 条的高度必须一致（同断点）。
    const heights = bars.map((bar) => bar.height);
    if (new Set(heights).size !== 1) {
      errors.push(
        `kpi height mismatch ${theme}/${width}: ${JSON.stringify(heights)}`,
      );
    }
    report.kpi[`heights-${theme}-${width}`] = heights;
    writeFileSync(
      `${OUT}kpi-bars-${theme}-${width}.json`,
      `${JSON.stringify(bars, null, 2)}\n`,
    );
  }
}

// 二级子页：下划线样式 + 位置。
for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    const page = await openPage({
      theme,
      width,
      query: "view=chain",
    });
    try {
      await page.waitForSelector("[data-chain-section-tabs]", {
        timeout: 20000,
      });
      const tab = await page.evaluate(() => {
        const list = document.querySelector("[data-chain-section-tabs]");
        const active = list?.querySelector(
          '[data-slot="tabs-trigger"][data-state="active"]',
        );
        const inactive = list?.querySelector(
          '[data-slot="tabs-trigger"]:not([data-state="active"])',
        );
        if (!active || !inactive) return null;
        const activeStyle = getComputedStyle(active);
        const inactiveStyle = getComputedStyle(inactive);
        const after = getComputedStyle(active, "::after");
        return {
          label: active.textContent?.trim() ?? "",
          fontSize: activeStyle.fontSize,
          activeColor: activeStyle.color,
          inactiveColor: inactiveStyle.color,
          backgroundColor: activeStyle.backgroundColor,
          afterHeight: after.height,
          afterColor: after.backgroundColor,
          afterDisplay: after.display,
          listHeight: list.getBoundingClientRect().height,
        };
      });
      if (!tab) errors.push(`subtabs/${theme}/${width}: tabs missing`);
      else {
        report.subtabs[`${theme}-${width}`] = tab;
        if (tab.fontSize !== "12px") {
          errors.push(`subtabs/${theme}/${width}: font ${tab.fontSize}`);
        }
        if (tab.afterHeight !== "2px") {
          errors.push(`subtabs/${theme}/${width}: underline ${tab.afterHeight}`);
        }
        if (tab.afterDisplay === "none") {
          errors.push(`subtabs/${theme}/${width}: underline hidden`);
        }
        if (tab.backgroundColor !== "rgba(0, 0, 0, 0)") {
          errors.push(`subtabs/${theme}/${width}: pill background ${tab.backgroundColor}`);
        }
        if (tab.activeColor === tab.inactiveColor) {
          errors.push(`subtabs/${theme}/${width}: active and muted colors are equal`);
        }
      }
      // 截图整行（主 tab + 筛选 + 子页），便于核对位置。
      await page
        .locator("[data-overview-view-tabs]")
        .locator("xpath=..")
        .screenshot({ path: `${OUT}subtabs-${theme}-${width}.png` });
    } finally {
      await page.close();
    }
  }
}

// 热力图：折叠 / 展开 / tooltip / 键盘行。
for (const width of [1440, 390]) {
  const page = await openPage({
    theme: "dark",
    width,
    query: "view=server&mode=heatmap",
  });
  try {
    await page.waitForSelector("[data-heatmap-offline-row-name]", {
      timeout: 20000,
    });
    await page.waitForTimeout(200);
    const collapsed = await page.evaluate(() => {
      const group = document.querySelector("[data-heatmap-offline-row-name]");
      const cells = [...document.querySelectorAll("[data-heatmap-cell]")];
      const serverRows = [...document.querySelectorAll("[data-heatmap-row]")];
      return {
        groupText: group?.textContent?.trim() ?? "",
        groupAria: group?.getAttribute("aria-label") ?? "",
        groupExpanded: group?.getAttribute("aria-expanded") ?? null,
        serverRows: serverRows.length,
        cells: cells.length,
        tabStops: cells.filter((cell) => cell.getAttribute("tabindex") === "0")
          .length,
        maxDataRow: Math.max(
          ...cells.map((cell) => Number(cell.dataset.row ?? -1)),
        ),
        groupRows: document.querySelectorAll("[data-heatmap-offline-row]")
          .length,
      };
    });
    report.heatmap[`collapsed-${width}`] = collapsed;
    if (!collapsed.groupText.includes("6 台全程离线")) {
      errors.push(`heatmap/${width}: group text ${collapsed.groupText}`);
    }
    if (!collapsed.groupAria.includes("法兰克福-01")) {
      errors.push(`heatmap/${width}: group aria misses names`);
    }
    if (collapsed.groupExpanded !== "false") {
      errors.push(`heatmap/${width}: group aria-expanded ${collapsed.groupExpanded}`);
    }
    if (collapsed.serverRows !== 4) {
      errors.push(`heatmap/${width}: ${collapsed.serverRows} server rows collapsed`);
    }
    if (collapsed.groupRows !== 1) {
      errors.push(`heatmap/${width}: ${collapsed.groupRows} aggregate rows`);
    }
    if (collapsed.tabStops !== 1) {
      errors.push(`heatmap/${width}: ${collapsed.tabStops} tab stops`);
    }
    if (collapsed.maxDataRow !== 3) {
      errors.push(`heatmap/${width}: max data-row ${collapsed.maxDataRow}`);
    }

    // 聚合行 hover 显示 6 台名称。
    await page.locator("[data-heatmap-offline-row-name]").hover();
    await page.waitForSelector("[data-heatmap-tooltip]:not([hidden])");
    const tip = await page
      .locator("[data-heatmap-tooltip]:not([hidden])")
      .textContent();
    report.heatmap[`tooltip-${width}`] = tip?.trim() ?? "";
    for (const name of ["法兰克福-01", "法兰克福-02", "美西-01", "美西-02", "悉尼-01", "大阪-01"]) {
      if (!tip?.includes(name)) {
        errors.push(`heatmap/${width}: tooltip misses ${name}`);
      }
    }
    if (width === 1440) {
      await page.screenshot({
        path: `${OUT}heatmap-tooltip-${width}.png`,
      });
    }
    // 移开鼠标，避免 tooltip 盖住折叠后的行（截图要能核对行数）。
    await page.mouse.move(0, 0);
    await page.waitForFunction(() =>
      document
        .querySelector("[data-heatmap-tooltip]")
        ?.hasAttribute("hidden"),
    );
    await page.locator("[data-heatmap-card]").screenshot({
      path: `${OUT}heatmap-collapsed-${width}.png`,
    });

    // 展开：10 台逐行恢复，聚合行仍在，可用它收起。
    await page.locator("[data-heatmap-offline-row-name]").click();
    await page.waitForFunction(
      () => document.querySelectorAll("[data-heatmap-row]").length === 10,
    );
    const expanded = await page.evaluate(() => {
      const group = document.querySelector("[data-heatmap-offline-row-name]");
      const cells = [...document.querySelectorAll("[data-heatmap-cell]")];
      return {
        groupExpanded: group?.getAttribute("aria-expanded") ?? null,
        serverRows: document.querySelectorAll("[data-heatmap-row]").length,
        groupRows: document.querySelectorAll("[data-heatmap-offline-row]").length,
        cells: cells.length,
        tabStops: cells.filter((cell) => cell.getAttribute("tabindex") === "0")
          .length,
        maxDataRow: Math.max(
          ...cells.map((cell) => Number(cell.dataset.row ?? -1)),
        ),
      };
    });
    report.heatmap[`expanded-${width}`] = expanded;
    if (expanded.groupExpanded !== "true") {
      errors.push(`heatmap/${width}: expanded aria-expanded ${expanded.groupExpanded}`);
    }
    if (expanded.serverRows !== 10) {
      errors.push(`heatmap/${width}: ${expanded.serverRows} rows expanded`);
    }
    if (expanded.groupRows !== 1) {
      errors.push(`heatmap/${width}: aggregate row disappeared when expanded`);
    }
    if (expanded.cells !== 10 * 168) {
      errors.push(`heatmap/${width}: ${expanded.cells} cells expanded`);
    }
    if (expanded.tabStops !== 1) {
      errors.push(`heatmap/${width}: ${expanded.tabStops} tab stops expanded`);
    }
    if (expanded.maxDataRow !== 9) {
      errors.push(`heatmap/${width}: max data-row expanded ${expanded.maxDataRow}`);
    }
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await page.mouse.move(0, 0);
    await page.waitForFunction(() =>
      document
        .querySelector("[data-heatmap-tooltip]")
        ?.hasAttribute("hidden"),
    );
    await page.locator("[data-heatmap-card]").screenshot({
      path: `${OUT}heatmap-expanded-${width}.png`,
    });

    // 键盘：聚焦一个格子后按 End / ArrowDown，行号连续，且不会落到折叠行。
    const firstCell = page.locator("[data-heatmap-cell][data-row='0']").first();
    await firstCell.focus();
    await page.waitForTimeout(120);
    const focusBefore = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        row: active?.getAttribute("data-row") ?? null,
        col: active?.getAttribute("data-col") ?? null,
        isCell: active?.hasAttribute("data-heatmap-cell") ?? false,
      };
    });
    await page.keyboard.press("End");
    await page.waitForTimeout(120);
    const focusEnd = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        row: active?.getAttribute("data-row") ?? null,
        col: active?.getAttribute("data-col") ?? null,
        isCell: active?.hasAttribute("data-heatmap-cell") ?? false,
      };
    });
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(120);
    const focusAfter = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        row: active?.getAttribute("data-row") ?? null,
        col: active?.getAttribute("data-col") ?? null,
        isCell: active?.hasAttribute("data-heatmap-cell") ?? false,
      };
    });
    report.heatmap[`keyboard-${width}`] = {
      before: focusBefore,
      end: focusEnd,
      after: focusAfter,
    };
    if (
      !focusBefore.isCell ||
      focusBefore.row !== "0" ||
      focusEnd.col !== "167" ||
      !focusAfter.isCell ||
      focusAfter.row !== "1" ||
      focusAfter.col !== "167"
    ) {
      errors.push(
        `heatmap/${width}: keyboard ${JSON.stringify({ focusBefore, focusEnd, focusAfter })}`,
      );
    }
  } finally {
    await page.close();
  }
}

// 流量榜单：桌面 / 390 都有「负载」标注。
for (const width of [1440, 390]) {
  const page = await openPage({
    theme: "dark",
    width,
    query: "view=traffic",
  });
  try {
    await page.waitForSelector("[data-traffic-view]", { timeout: 20000 });
    await page.waitForTimeout(500);
    const labels = await page.evaluate(() => {
      const view = document.querySelector("[data-traffic-view]");
      if (!view) return null;
      const rows = [...view.querySelectorAll("li")];
      const row = rows.find((item) =>
        item.textContent?.includes("香港-01"),
      );
      return {
        text: row?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        loadLabels: (row?.textContent?.match(/负载/g) ?? []).length,
      };
    });
    report.traffic[`${width}`] = labels;
    if (!labels || labels.loadLabels < 1) {
      errors.push(`traffic/${width}: leaderboard row has no 负载 label`);
    }
    const leaderboard = page
      .locator('[data-traffic-view] [data-slot="card"]')
      .filter({ hasText: "流量榜单" })
      .first();
    await leaderboard.screenshot({
      path: `${OUT}traffic-leaderboard-${width}.png`,
    });
    await page.screenshot({
      path: `${OUT}traffic-load-${width}.png`,
    });
  } finally {
    await page.close();
  }
}

// 四种 KPI 条并排对照：同断点同主题的高度一眼可比。
for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    const entries = KPI_VIEWS.map((view) => {
      const file = `${OUT}kpi-bar-${view.id}-${theme}-${width}.png`;
      return {
        label: {
          server: "资源状态 / Resource status",
          cost: "成本开支 / Cost spend",
          chain: "链路时延 / Chain latency",
          templates: "转发模板 / Chain templates",
        }[view.id],
        height: report.kpi[`${view.id}-${theme}-${width}`]?.height,
        data: readFileSync(file).toString("base64"),
      };
    });
    const sheet = await browser.newPage({
      viewport: { width: width === 1440 ? 1240 : 390, height: 900 },
      deviceScaleFactor: 1,
    });
    await sheet.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>
        body{margin:0;padding:24px;background:#0d0d10;color:#eee;font:14px/1.5 system-ui,sans-serif}
        h1{font-size:16px;margin:0 0 16px}
        figure{margin:0 0 18px}
        figcaption{font-size:12px;color:#aaa;margin-bottom:6px}
        img{display:block;max-width:100%;border-radius:8px}
      </style></head><body>
      <h1>KPI bars · ${width}px · ${theme}</h1>
      ${entries
        .map(
          (entry) => `<figure><figcaption>${entry.label} — ${entry.height}px</figcaption><img src="data:image/png;base64,${entry.data}" alt="${entry.label}"></figure>`,
        )
        .join("")}
      </body></html>`,
    );
    await sheet.screenshot({
      path: `${OUT}kpi-bars-${theme}-${width}.png`,
      fullPage: true,
    });
    await sheet.close();
  }
}

await browser.close();
await new Promise((resolvePromise) => server.close(resolvePromise));

report.errors = errors;
writeFileSync(`${OUT}report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      shots: report.kpi ? Object.keys(report.kpi).length : 0,
      errors,
      report: `${OUT}report.json`,
    },
    null,
    2,
  ),
);
if (errors.length > 0) process.exitCode = 1;
