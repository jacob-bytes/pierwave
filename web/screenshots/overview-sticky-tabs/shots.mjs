// Screenshots + geometry assertions for the sticky overview view toolbar.
//
// Usage:
//   cd web && npm run build
//   node screenshots/overview-sticky-tabs/shots.mjs
//
// Serves `web/dist` and mocks every API the overview needs, so no controller or
// database is involved. Playwright is taken from the repo's npx cache (same
// approach as screenshots/overview-kpi-compact/shots.mjs).
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const OUT = fileURLToPath(new URL(".", import.meta.url));
const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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

function healthServer(def) {
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
    total: 3,
    degraded: 2,
    blocked: 1,
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
  users: { total: 9, active: 9 },
  packages: { total: 5, instances: 7 },
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
  if (path === "/api/v1/chain-templates") {
    // 链路列表会顺带取模板名做搜索；mock 一个空列表即可。
    return json(route, { items: [] });
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


// ---------------------------------------------------------------------------
// Extra chains: the chain view must be tall enough that the toolbar can reach
// the top of the scroll container and stay there while the list scrolls.
// ---------------------------------------------------------------------------

const EXTRA_CHAINS = 10;

for (let index = 0; index < EXTRA_CHAINS; index += 1) {
  const def = SERVER_DEFS[index % SERVER_DEFS.length];
  const id = `chain-sticky-${index + 1}`;
  const name = `吸顶演示链-${String(index + 1).padStart(2, "0")}`;
  const target = `edge-${index + 1}.example.com`;
  const latency = 26 + index * 3;
  const degraded = index === 2;

  CHAINS.push({
    id,
    name,
    target_host: target,
    target_port: 443,
    enabled: true,
    engine: "realm",
    protocol: "tcp",
    udp: false,
    transport: "tls",
    degraded,
    blocked_reason: null,
    path_mode: "single",
    total_latency_ms: latency + 9,
    groups: [
      {
        id: "g0",
        seq: 0,
        name: null,
        strategy: "round_robin",
        cert_id: null,
        degraded: false,
        members: [member(def, index, 0, latency)],
      },
    ],
    created_at: NOW - 20 * 86400,
    updated_at: NOW - HOUR,
  });

  CHAIN_HEALTH.chains.push({
    id,
    name,
    hops: 2,
    status: degraded
      ? { kind: "degraded", cause: "slow" }
      : { kind: "ok", cause: null },
    estimated: false,
    series: chainSeries(28 + index),
    segments: [
      {
        seq: 1,
        from: def.name,
        to: "东京-01",
        p50: latency,
        delta_ms: 0,
        contribution_pct: 0,
        attempts: 96,
        failures: 0,
        loss_pct: 0,
      },
      {
        seq: 2,
        from: "东京-01",
        to: target,
        p50: latency + 9,
        delta_ms: 9,
        contribution_pct: 100,
        attempts: 96,
        failures: degraded ? 2 : 0,
        loss_pct: degraded ? 2.1 : 0,
      },
    ],
    diagnosis: { kind: "single_hop", seq: 2 },
  });
}

CHAIN_HEALTH.summary.total_chains = CHAIN_HEALTH.chains.length;
CHAIN_HEALTH.summary.slow_chains = CHAIN_HEALTH.chains.filter(
  (chain) => chain.status.kind === "degraded",
).length;

// ---------------------------------------------------------------------------
// Screenshots + geometry assertions
// ---------------------------------------------------------------------------

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const THEMES = ["dark", "light"];
const LOCALE = "zh-CN";

const report = {
  generatedAt: new Date().toISOString(),
  themes: {},
  assertions: [],
  pageErrors: [],
};
const failures = [];
const pageErrors = [];

function check(condition, message, detail) {
  const ok = Boolean(condition);
  report.assertions.push({ ok, message, ...(detail ? { detail } : {}) });
  if (!ok) failures.push(`${message}${detail ? ` (${JSON.stringify(detail)})` : ""}`);
}

const { server, port } = await startStaticServer();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function openPage({ theme, width, height }) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (error) => {
    pageErrors.push({ theme, width, error: error.message });
  });
  await page.addInitScript(
    ({ theme: value, locale }) => {
      localStorage.setItem("pierwave.theme", value);
      localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale: LOCALE },
  );
  await page.route("**/api/v1/**", (route) => handleApi(route));
  await page.goto(`${base}/?view=chain`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-overview-view-toolbar]", { timeout: 20000 });
  await page.waitForSelector("[data-chain-list-row]", { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  // 图表进入动画 + 惰性 chunk 完成后布局才稳定。
  await page.waitForTimeout(900);
  return page;
}

/** 工具栏 / 分隔线 / 内容区滚动的全部几何信息。 */
async function readGeometry(page) {
  return page.evaluate(() => {
    const toolbar = document.querySelector("[data-overview-view-toolbar]");
    const scroller = document.getElementById("main-content");
    if (!toolbar || !scroller) return null;
    const style = getComputedStyle(toolbar);
    const after = getComputedStyle(toolbar, "::after");
    const box = toolbar.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    return {
      scrollTop: Math.round(scroller.scrollTop * 10) / 10,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      mainTop: Math.round(scrollerBox.top * 10) / 10,
      mainLeft: Math.round(scrollerBox.left * 10) / 10,
      top: Math.round(box.top * 10) / 10,
      left: Math.round(box.left * 10) / 10,
      width: Math.round(box.width * 10) / 10,
      height: Math.round(box.height * 10) / 10,
      bottom: Math.round(box.bottom * 10) / 10,
      stuck: toolbar.dataset.stuck,
      position: style.position,
      zIndex: style.zIndex,
      marginInline: style.marginInline,
      paddingInline: style.paddingInline,
      background: style.backgroundColor,
      afterOpacity: after.opacity,
      afterContent: after.content,
      afterHeight: after.height,
      afterBackground: after.backgroundColor,
      afterBottom: after.bottom,
      documentOverflow: Math.max(
        0,
        document.documentElement.scrollWidth - window.innerWidth,
      ),
      dark: document.documentElement.classList.contains("dark"),
    };
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const toolbar = document.querySelector("[data-overview-view-toolbar]");
    const scroller = document.getElementById("main-content");
    if (!toolbar || !scroller) return null;
    const toolbarBox = toolbar.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    return {
      flowOffsetAtTop: Math.round(
        (scroller.scrollTop + toolbarBox.top - scrollerBox.top) * 10,
      ) / 10,
      maxScroll: scroller.scrollHeight - scroller.clientHeight,
    };
  });
}

async function settle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.waitForTimeout(80);
}

async function setScroll(page, top) {
  await page.evaluate((value) => {
    document.getElementById("main-content").scrollTop = value;
  }, top);
  await settle(page);
}

async function shoot(page, name) {
  const path = `${OUT}${name}.png`;
  await page.screenshot({ path, animations: "disabled" });
  return name;
}

function assertDesktopTop(theme, geo) {
  check(geo !== null, `${theme} desktop: geometry readable`);
  if (!geo) return;
  check(geo.dark === (theme === "dark"), `${theme} desktop: theme applied`, {
    dark: geo.dark,
  });
  check(geo.scrollTop === 0, `${theme} desktop: starts unscrolled`, {
    scrollTop: geo.scrollTop,
  });
  check(geo.stuck === "false", `${theme} desktop: unscrolled is not stuck`);
  check(
    geo.afterOpacity === "0",
    `${theme} desktop: separator hidden before sticking`,
    { opacity: geo.afterOpacity },
  );
  check(
    geo.background === "rgba(0, 0, 0, 0)" ||
      geo.background === "transparent",
    `${theme} desktop: no background before sticking`,
    { background: geo.background },
  );
  check(
    geo.top > geo.mainTop + 40,
    `${theme} desktop: toolbar still in normal flow`,
    { top: geo.top, mainTop: geo.mainTop },
  );
  check(
    geo.scrollWidth <= geo.clientWidth + 1,
    `${theme} desktop: no horizontal overflow`,
    { scrollWidth: geo.scrollWidth, clientWidth: geo.clientWidth },
  );
  check(
    geo.documentOverflow === 0,
    `${theme} desktop: document never scrolls sideways`,
    { documentOverflow: geo.documentOverflow },
  );
}

function assertDesktopStuck(theme, geo, firstTop) {
  check(geo !== null, `${theme} desktop scrolled: geometry readable`);
  if (!geo) return;
  check(geo.stuck === "true", `${theme} desktop scrolled: stuck flag on`);
  check(
    Math.abs(geo.top - geo.mainTop) <= 1,
    `${theme} desktop scrolled: toolbar pinned to content top`,
    { top: geo.top, mainTop: geo.mainTop },
  );
  if (firstTop !== undefined) {
    check(
      Math.abs(geo.top - firstTop) <= 1,
      `${theme} desktop scrolled: toolbar top stays constant`,
      { before: firstTop, after: geo.top },
    );
  }
  check(
    geo.position === "sticky",
    `${theme} desktop scrolled: position is sticky`,
    { position: geo.position },
  );
  check(
    geo.zIndex === "20",
    `${theme} desktop scrolled: z-index stays below overlays`,
    { zIndex: geo.zIndex },
  );
  check(
    geo.afterOpacity === "1",
    `${theme} desktop scrolled: separator visible while stuck`,
    { opacity: geo.afterOpacity },
  );
  check(
    geo.afterHeight === "1px",
    `${theme} desktop scrolled: separator is exactly 1px`,
    { height: geo.afterHeight },
  );
  check(
    geo.afterBackground !== "rgba(0, 0, 0, 0)",
    `${theme} desktop scrolled: separator uses a theme token`,
    { background: geo.afterBackground },
  );
  check(
    geo.background !== "rgba(0, 0, 0, 0)" &&
      geo.background !== "transparent",
    `${theme} desktop scrolled: faint background appears`,
    { background: geo.background },
  );
  check(
    Math.abs(geo.left - geo.mainLeft) <= 1,
    `${theme} desktop scrolled: background starts at the content edge`,
    { left: geo.left, mainLeft: geo.mainLeft },
  );
  check(
    Math.abs(geo.width - geo.clientWidth) <= 1,
    `${theme} desktop scrolled: full-bleed background adds no overflow`,
    { width: geo.width, clientWidth: geo.clientWidth },
  );
  check(
    geo.scrollWidth <= geo.clientWidth + 1,
    `${theme} desktop scrolled: still no horizontal scroll`,
    { scrollWidth: geo.scrollWidth, clientWidth: geo.clientWidth },
  );
}

function assertMobile(theme, geo) {
  check(geo !== null, `${theme} mobile: geometry readable`);
  if (!geo) return;
  check(geo.dark === (theme === "dark"), `${theme} mobile: theme applied`, {
    dark: geo.dark,
  });
  check(
    geo.position !== "sticky",
    `${theme} mobile: toolbar never sticks`,
    { position: geo.position },
  );
  check(geo.stuck === "false", `${theme} mobile: never enters stuck state`);
  check(
    geo.afterContent === "none",
    `${theme} mobile: separator pseudo-element does not exist`,
    { content: geo.afterContent },
  );
  check(
    geo.scrollWidth <= geo.clientWidth + 1,
    `${theme} mobile: no horizontal overflow`,
    { scrollWidth: geo.scrollWidth, clientWidth: geo.clientWidth },
  );
}

for (const theme of THEMES) {
  const entry = {
    theme,
    desktop: {},
    mobile: {},
    shots: [],
  };
  report.themes[theme] = entry;

  // ---- 1440 -------------------------------------------------------------
  const desktopPage = await openPage({ theme, ...DESKTOP });
  try {
    const top = await readGeometry(desktopPage);
    entry.desktop.unscrolled = top;
    assertDesktopTop(theme, top);
    entry.shots.push(await shoot(desktopPage, `desktop-top-${theme}-1440x900`));

    const { flowOffsetAtTop, maxScroll } = await measure(desktopPage);
    entry.desktop.flowOffsetAtTop = flowOffsetAtTop;
    entry.desktop.maxScroll = maxScroll;
    const stuckTarget = Math.min(flowOffsetAtTop + 260, maxScroll);
    check(
      maxScroll >= flowOffsetAtTop + 260,
      `${theme} desktop: chain view is tall enough to pin the toolbar`,
      { maxScroll, flowOffsetAtTop },
    );

    await setScroll(desktopPage, stuckTarget);
    const stuck = await readGeometry(desktopPage);
    entry.desktop.stuck = stuck;
    assertDesktopStuck(theme, stuck);
    entry.shots.push(
      await shoot(desktopPage, `desktop-stuck-${theme}-1440x900`),
    );

    // 继续往下滚，吸顶行不能跟着走。
    const deeperTarget = Math.min(stuckTarget + 240, maxScroll);
    await setScroll(desktopPage, deeperTarget);
    const deeper = await readGeometry(desktopPage);
    entry.desktop.deeper = deeper;
    assertDesktopStuck(theme, deeper, stuck?.top);

    // 吸顶状态下下拉筛选器照常打开，且层级在吸顶行之上。
    await desktopPage.locator("[data-server-filter-trigger]").click();
    await desktopPage.waitForSelector("[data-server-filter-content]", {
      timeout: 5000,
    });
    const overlay = await desktopPage.evaluate(() => {
      const content = document.querySelector("[data-server-filter-content]");
      const toolbar = document.querySelector("[data-overview-view-toolbar]");
      if (!content || !toolbar) return null;
      const box = content.getBoundingClientRect();
      return {
        visible: box.width > 0 && box.height > 0,
        zIndex: getComputedStyle(content).zIndex,
        toolbarZ: getComputedStyle(toolbar).zIndex,
      };
    });
    entry.desktop.popover = overlay;
    check(
      overlay?.visible === true,
      `${theme} desktop: server filter opens while stuck`,
    );
    check(
      Number(overlay?.zIndex) > Number(overlay?.toolbarZ),
      `${theme} desktop: overlay sits above the sticky toolbar`,
      overlay ?? undefined,
    );
    await desktopPage.keyboard.press("Escape");
    await desktopPage.waitForTimeout(250);

    // 切主视图：内容区回到顶部，吸顶状态与分隔线一起消失。
    await desktopPage
      .locator('[data-overview-view-tabs] [data-slot="tabs-trigger"]')
      .nth(1)
      .click();
    await desktopPage.waitForFunction(
      () => new URL(window.location.href).searchParams.get("view") === "traffic",
      undefined,
      { timeout: 10000 },
    );
    await settle(desktopPage);
    const switched = await readGeometry(desktopPage);
    entry.desktop.afterViewSwitch = switched;
    check(switched?.scrollTop === 0, `${theme} desktop: view switch resets scrollTop to 0`, {
      scrollTop: switched?.scrollTop,
    });
    check(
      switched?.stuck === "false",
      `${theme} desktop: view switch clears the stuck state`,
    );
    check(
      switched?.afterOpacity === "0",
      `${theme} desktop: separator hidden again after switching`,
      { opacity: switched?.afterOpacity },
    );
    check(
      switched !== null && switched.top > switched.mainTop + 40,
      `${theme} desktop: toolbar is back in normal flow after switching`,
      switched
        ? { top: switched.top, mainTop: switched.mainTop }
        : undefined,
    );
  } finally {
    await desktopPage.close();
  }

  // ---- 390 --------------------------------------------------------------
  const mobilePage = await openPage({ theme, ...MOBILE });
  try {
    const top = await readGeometry(mobilePage);
    entry.mobile.unscrolled = top;
    assertMobile(theme, top);
    check(
      top !== null && top.left - top.mainLeft >= 20,
      `${theme} mobile: no full-bleed negative margins`,
      top ? { left: top.left, mainLeft: top.mainLeft } : undefined,
    );
    entry.shots.push(await shoot(mobilePage, `mobile-top-${theme}-390x844`));

    const { flowOffsetAtTop, maxScroll } = await measure(mobilePage);
    const target = Math.min(flowOffsetAtTop + 300, maxScroll);
    await setScroll(mobilePage, target);
    const scrolled = await readGeometry(mobilePage);
    entry.mobile.scrolled = scrolled;
    assertMobile(theme, scrolled);
    check(
      scrolled !== null && scrolled.top < scrolled.mainTop - 20,
      `${theme} mobile: toolbar scrolls away instead of sticking`,
      scrolled ? { top: scrolled.top, mainTop: scrolled.mainTop } : undefined,
    );
    check(
      scrolled?.scrollWidth <= (scrolled?.clientWidth ?? 0) + 1,
      `${theme} mobile scrolled: no horizontal overflow`,
      scrolled
        ? { scrollWidth: scrolled.scrollWidth, clientWidth: scrolled.clientWidth }
        : undefined,
    );
    entry.shots.push(
      await shoot(mobilePage, `mobile-scrolled-${theme}-390x844`),
    );
  } finally {
    await mobilePage.close();
  }
}

report.pageErrors = pageErrors;
check(
  pageErrors.length === 0,
  "no uncaught page errors during the sticky-toolbar runs",
  pageErrors,
);
report.failures = failures;
writeFileSync(`${OUT}report.json`, `${JSON.stringify(report, null, 2)}\n`);

await browser.close();
await new Promise((resolvePromise) => server.close(resolvePromise));

if (failures.length > 0) {
  console.error(`FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`ok - ${report.assertions.length} sticky-toolbar assertions`);
}
