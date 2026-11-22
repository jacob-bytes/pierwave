// Render the implemented overview insight views at 1440/390 × light/dark,
// plus empty / error / unsupported / chain-placeholder states.
//
// Usage:
//   cd web && npm run build
//   node web/screenshots/overview-views/app-shots.mjs
//
// The script serves `web/dist` and mocks the API in Playwright, so it does not
// need a running controller or a seeded database. No new project dependency:
// Playwright is taken from the repo's npx cache (same as shots.mjs).
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

mkdirSync(OUT, { recursive: true });

const NOW = Math.floor(Date.now() / 1000);
const END = Math.floor(NOW / HOUR) * HOUR;
const START = END - 167 * HOUR;

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

function bucket(index, overrides = {}) {
  return {
    ts: START + index * HOUR,
    online: true,
    load1: 0.42,
    mem_ratio: 0.44,
    disk_ratio: 0.53,
    ...overrides,
  };
}

function seriesBuckets(patch) {
  return Array.from({ length: 168 }, (_, index) => {
    const override = patch(index);
    return override === null ? null : bucket(index, override ?? {});
  });
}

/** 12 servers: 9 periodic (CNY/USD/EUR/JPY), 1 one-time, 1 unknown AED, 1 no cycle. */
const SERVER_DEFS = [
  {
    id: "srv-hk-01",
    name: "香港-01",
    currency: "CNY",
    price_cents: 26800,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-01-31",
    current: { load1: 0.42, mem_used: 3650722201, mem_total: 8589934592, disk_used: 45097156608, disk_total: 85899345920, latency_ms: 28 },
  },
  {
    id: "srv-hk-02",
    name: "香港-02",
    currency: "CNY",
    price_cents: 12800,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2026-12-31",
    current: { load1: 0.54, mem_used: 4982162063, mem_total: 8589934592, disk_used: 54975581389, disk_total: 85899345920, latency_ms: 31 },
  },
  {
    id: "srv-hk-03",
    name: "香港-03",
    status: "offline",
    currency: "CNY",
    price_cents: 8800,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2026-11-30",
    current: { load1: 0.28, mem_used: 3350074490, mem_total: 8589934592, disk_used: 48962627174, disk_total: 85899345920, latency_ms: 35 },
    patch: (index) =>
      index >= 160 && index <= 162 ? { online: false } : {},
  },
  {
    id: "srv-tokyo-01",
    name: "东京-01",
    currency: "USD",
    price_cents: 120000,
    billing_cycle: "yearly",
    billing_cycle_count: 1,
    billing_cycle_unit: "year",
    paid_until: null,
    current: { load1: 0.74, mem_used: 5583457484, mem_total: 8589934592, disk_used: 58411555225, disk_total: 85899345920, latency_ms: 42 },
  },
  {
    id: "srv-tokyo-02",
    name: "东京-02",
    currency: "USD",
    price_cents: 36000,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-03-31",
    current: { load1: 0.99, mem_used: 7043746365, mem_total: 8589934592, disk_used: 78168404787, disk_total: 85899345920, latency_ms: 48 },
    patch: () => ({ disk_ratio: 0.91, mem_ratio: 0.82, load1: 0.99 }),
  },
  {
    id: "srv-sg-01",
    name: "新加坡-01",
    currency: "CNY",
    price_cents: 99900,
    billing_cycle: "yearly",
    billing_cycle_count: 1,
    billing_cycle_unit: "year",
    paid_until: "2027-02-28",
    current: { load1: 0.41, mem_used: 4380866641, mem_total: 8589934592, disk_used: 51539607552, disk_total: 85899345920, latency_ms: 52 },
  },
  {
    id: "srv-sg-02",
    name: "新加坡-02",
    currency: "CNY",
    price_cents: 15800,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-01-31",
    current: { load1: 0.62, mem_used: 5927054868, mem_total: 8589934592, disk_used: 65283502899, disk_total: 85899345920, latency_ms: 55 },
    patch: (index) =>
      index >= 150 && index <= 152
        ? { load1: 5.2, mem_ratio: 0.69 }
        : { mem_ratio: 0.69 },
  },
  {
    id: "srv-fra-01",
    name: "法兰克福-01",
    currency: "EUR",
    price_cents: 30400,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-02-28",
    current: { load1: 0.35, mem_used: 4123168604, mem_total: 8589934592, disk_used: 47244640256, disk_total: 85899345920, latency_ms: 210 },
  },
  {
    id: "srv-osaka-01",
    name: "大阪-01",
    currency: "JPY",
    price_cents: 128000,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-01-31",
    current: { load1: 0.22, mem_used: 3865470566, mem_total: 8589934592, disk_used: 52400652288, disk_total: 85899345920, latency_ms: 61 },
    patch: (index) => (index >= 100 && index <= 104 ? null : {}),
  },
  {
    id: "srv-us-01",
    name: "美西-01",
    currency: "CNY",
    price_cents: 199900,
    billing_cycle: "once",
    billing_cycle_count: 1,
    billing_cycle_unit: "once",
    paid_until: "2027-06-30",
    current: null,
    noBuckets: true,
  },
  {
    id: "srv-dubai-01",
    name: "迪拜-01",
    currency: "AED",
    price_cents: 32000,
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: "2027-02-28",
    current: { load1: 0.31, mem_used: 4466765987, mem_total: 8589934592, disk_used: 50680614092, disk_total: 85899345920, latency_ms: 130 },
  },
  {
    id: "srv-bangkok-01",
    name: "曼谷-01",
    currency: "CNY",
    price_cents: 50000,
    paid_until: null,
    current: { load1: 0.18, mem_used: 3435973836, mem_total: 8589934592, disk_used: 37795712204, disk_total: 85899345920, latency_ms: 88 },
  },
];

const SERVER_LIST = SERVER_DEFS.map((def, index) => ({
  id: def.id,
  name: def.name,
  address: `10.0.0.${index + 1}`,
  xray_mode: "auto",
  status: def.status ?? "online",
  last_seen_at: NOW - (def.status === "offline" ? 7 * HOUR : 30),
  config_version: 3,
  created_at: NOW - 30 * 86400,
  agent_version: "0.16.2",
  allow_agent_upgrade: false,
  agent_target_version: null,
  xray_running: def.status === "offline" ? null : true,
  nginx_running: def.status === "offline" ? null : true,
  load1: def.current?.load1 ?? null,
  mem_used: def.current?.mem_used ?? null,
  mem_total: def.current?.mem_total ?? null,
  disk_used: def.current?.disk_used ?? null,
  disk_total: def.current?.disk_total ?? null,
  uptime_secs: 86400 * 20,
  latency_ms: def.current?.latency_ms ?? null,
  health_at: def.status === "offline" ? null : NOW - 30,
  arch: "x86_64",
  os_name: "Ubuntu",
  os_version: "24.04",
  virt: "kvm",
  country_code: def.id.includes("hk")
    ? "HK"
    : def.id.includes("tokyo")
      ? "JP"
      : def.id.includes("sg")
        ? "SG"
        : def.id.includes("fra")
          ? "DE"
          : def.id.includes("osaka")
            ? "JP"
            : def.id.includes("us")
              ? "US"
              : def.id.includes("dubai")
                ? "AE"
                : "TH",
  paid_until: def.paid_until ?? null,
  price_cents: def.price_cents ?? null,
  currency: def.currency ?? null,
  billing_cycle: def.billing_cycle ?? null,
  billing_cycle_count: def.billing_cycle_count ?? null,
  billing_cycle_unit: def.billing_cycle_unit ?? null,
}));

function healthServer(def, index = 0) {
  const current = def.current;
  const baseLoad = current?.load1 ?? 0.42;
  const baseMem =
    current?.mem_total && current.mem_total > 0
      ? current.mem_used / current.mem_total
      : 0.44;
  const baseDisk =
    current?.disk_total && current.disk_total > 0
      ? current.disk_used / current.disk_total
      : 0.53;
  const buckets = def.noBuckets
    ? Array.from({ length: 168 }, () => null)
    : seriesBuckets((i) => {
        // 让 mock 曲线有起伏，截图能看出面积图是多序列而不是几条平线。
        const wave = (Math.sin((i + index * 3) / 9) + 1) / 2;
        const base = {
          load1: Math.max(0, baseLoad * (0.7 + 0.6 * wave)),
          mem_ratio: Math.min(0.99, baseMem * (0.85 + 0.3 * wave)),
          disk_ratio: Math.min(0.99, baseDisk * (0.92 + 0.16 * wave)),
        };
        return { ...base, ...(def.patch?.(i) ?? {}) };
      });
  const onlineBuckets = buckets.filter((item) => item !== null);
  const onlineRatio =
    onlineBuckets.length === 0
      ? null
      : onlineBuckets.filter((item) => item.online).length /
        onlineBuckets.length;
  return {
    id: def.id,
    name: def.name,
    online_ratio: onlineRatio,
    buckets,
  };
}

function makeHealth(mock) {
  const servers =
    mock === "serverResourceEmpty"
      ? SERVER_DEFS.map((def) => ({
          id: def.id,
          name: def.name,
          online_ratio: 1,
          buckets: Array.from({ length: 168 }, (_, index) => ({
            ts: START + index * HOUR,
            online: true,
            load1: null,
            mem_ratio: null,
            disk_ratio: null,
          })),
        }))
      : SERVER_DEFS.map((def, index) => healthServer(def, index));
  return {
    generated_at: NOW,
    hours: 168,
    bucket: HOUR,
    summary: {
      online_ratio_24h: 0.964,
      abnormal_servers: 3,
      worst_disk_ratio: 0.91,
    },
    servers,
  };
}

const TRAFFIC_DAYS = Array.from({ length: 7 }, (_, index) => ({
  date: `2026-11-${16 + index}`,
  uplink: (index + 2) * 1024 ** 3,
  downlink: (index + 5) * 1024 ** 3,
  weighted: (index + 7) * 1024 ** 3,
}));

const AGGREGATE = {
  kpi: {
    servers_online: 11,
    servers_total: 12,
    nodes: 12,
    traffic_today: 32 * 1024 ** 3,
    traffic_month: 254 * 1024 ** 3,
    uptime_24h: 96.4,
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
    degraded: 0,
    blocked: 0,
    forwards_total: 2,
    forwards_failing: 0,
    handshake_failures: 0,
  },
  top: SERVER_DEFS.slice(0, 5).map((def, index) => ({
    kind: "server",
    server_id: def.id,
    name: def.name,
    traffic_7d: (index + 1) * 21 * 1024 ** 3,
    load1: def.current?.load1 ?? null,
    online: (def.status ?? "online") === "online",
    rates: [],
  })),
  top_users: [
    { user_id: "u1", username: "alice", traffic_7d: 32 * 1024 ** 3 },
    { user_id: "u2", username: "bob", traffic_7d: 21 * 1024 ** 3 },
    { user_id: "u3", username: "carol", traffic_7d: 12 * 1024 ** 3 },
  ],
  top_nodes: [
    { node_id: "n1", name: "HK-01 VLESS", protocol: "vless", server_name: "香港-01", traffic_7d: 24 * 1024 ** 3 },
    { node_id: "n2", name: "JP-01 HY2", protocol: "hysteria2", server_name: "东京-01", traffic_7d: 18 * 1024 ** 3 },
  ],
  package_split: [
    { package_id: "p1", name: "标准套餐", users: 4, traffic_7d: 62 * 1024 ** 3 },
    { package_id: "p2", name: "高级套餐", users: 2, traffic_7d: 46 * 1024 ** 3 },
  ],
};

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
        members: [
          {
            server_id: "srv-hk-01",
            server_name: "香港-01",
            listen_port: 8443,
            priority: 0,
            weight: 1,
            forward_id: "f0",
            listening: true,
            target_ok: true,
            target_error: null,
            latency_ms: 28,
            target_latency_ms: null,
            degraded: false,
          },
        ],
      },
      {
        id: "g1",
        seq: 1,
        name: null,
        strategy: "round_robin",
        cert_id: null,
        degraded: false,
        members: [
          {
            server_id: "srv-tokyo-01",
            server_name: "东京-01",
            listen_port: 8443,
            priority: 0,
            weight: 1,
            forward_id: "f1",
            listening: true,
            target_ok: true,
            target_error: null,
            latency_ms: 42,
            target_latency_ms: null,
            degraded: false,
          },
        ],
      },
    ],
    created_at: NOW - 30 * 86400,
    updated_at: NOW - HOUR,
  },
  {
    id: "chain-demo-blocked",
    name: "混合链-演示",
    target_host: "blocked.example.com",
    target_port: 443,
    enabled: true,
    engine: "realm",
    protocol: "tcp",
    udp: false,
    transport: "tls",
    degraded: false,
    blocked_reason: "目标端口不可达",
    path_mode: "single",
    total_latency_ms: null,
    groups: [
      {
        id: "g0",
        seq: 0,
        name: null,
        strategy: "round_robin",
        cert_id: null,
        degraded: false,
        members: [
          {
            server_id: "srv-fra-01",
            server_name: "法兰克福-01",
            listen_port: 9443,
            priority: 0,
            weight: 1,
            forward_id: "f2",
            listening: true,
            target_ok: false,
            target_error: "timeout",
            latency_ms: 210,
            target_latency_ms: null,
            degraded: false,
          },
        ],
      },
    ],
    created_at: NOW - 20 * 86400,
    updated_at: NOW - HOUR,
  },
  {
    id: "chain-demo-degraded",
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
        strategy: "round_robin",
        cert_id: null,
        degraded: false,
        members: [
          {
            server_id: "srv-hk-02",
            server_name: "香港-02",
            listen_port: 10443,
            priority: 0,
            weight: 1,
            forward_id: "f3",
            listening: true,
            target_ok: true,
            target_error: null,
            latency_ms: 31,
            target_latency_ms: null,
            degraded: false,
          },
        ],
      },
      {
        id: "g1",
        seq: 1,
        name: null,
        strategy: "round_robin",
        cert_id: null,
        degraded: true,
        members: [
          {
            server_id: "srv-sg-01",
            server_name: "新加坡-01",
            listen_port: 10443,
            priority: 0,
            weight: 1,
            forward_id: "f4",
            listening: true,
            target_ok: false,
            target_error: "timeout",
            latency_ms: 52,
            target_latency_ms: null,
            degraded: true,
          },
        ],
      },
    ],
    created_at: NOW - 10 * 86400,
    updated_at: NOW - HOUR,
  },
];

const STATS = {
  servers: { total: 12, online: 11 },
  users: { total: 6, active: 6 },
  packages: { total: 4, instances: 5 },
  traffic: {
    today_bytes: 32 * 1024 ** 3,
    month_bytes: 254 * 1024 ** 3,
  },
  alerts: {
    expired_instances: 0,
    exhausted_instances: 0,
    offline_servers: 1,
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

function emptyBilling(server) {
  const copy = { ...server };
  for (const key of [
    "price_cents",
    "currency",
    "billing_cycle",
    "billing_cycle_count",
    "billing_cycle_unit",
    "paid_until",
  ]) {
    delete copy[key];
  }
  return copy;
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function handleApi(route, mock) {
  const url = new URL(route.request().url());
  const path = url.pathname;

  if (path === "/api/v1/auth/me") {
    return json(route, {
      user: { id: "u-admin", username: "admin", role: "admin", short_code: "AD" },
    });
  }
  if (path === "/api/v1/health") {
    return json(route, { status: "ok", version: "0.16.2", panel_name: "PierWave" });
  }
  if (path === "/api/v1/overview/server-health") {
    if (mock === "serverUnsupported") {
      return json(route, { error: "not found", code: "not_found" }, 404);
    }
    if (mock === "serverForbidden") {
      return json(route, { error: "forbidden", code: "forbidden" }, 403);
    }
    if (mock === "serverError") {
      return json(route, { error: "internal error" }, 500);
    }
    if (mock === "serverEmpty") {
      return json(route, {
        generated_at: NOW,
        hours: 168,
        bucket: HOUR,
        summary: {
          online_ratio_24h: null,
          abnormal_servers: 0,
          worst_disk_ratio: null,
        },
        servers: [],
      });
    }
    return json(route, makeHealth(mock));
  }
  if (path === "/api/v1/overview") {
    if (mock === "trafficError") {
      return json(route, { error: "internal error" }, 500);
    }
    if (mock === "trafficEmpty") {
      return json(route, {
        ...AGGREGATE,
        series: [],
        protocol_series: [],
        protocols: [],
        chains: {
          total: 0,
          degraded: 0,
          blocked: 0,
          forwards_total: 0,
          forwards_failing: 0,
          handshake_failures: 0,
        },
        top: [],
        top_users: [],
        top_nodes: [],
        package_split: [],
      });
    }
    return json(route, AGGREGATE);
  }
  if (path === "/api/v1/stats/overview") {
    if (mock === "trafficEmpty") {
      return json(route, {
        ...STATS,
        alerts: {
          expired_instances: 0,
          exhausted_instances: 0,
          offline_servers: 0,
          expiring_certs: 0,
        },
      });
    }
    return json(route, STATS);
  }
  if (path === "/api/v1/stats/traffic") {
    if (mock === "trafficError") {
      return json(route, { error: "internal error" }, 500);
    }
    if (mock === "trafficEmpty") {
      return json(route, { days: [] });
    }
    return json(route, { days: TRAFFIC_DAYS });
  }
  if (path === "/api/v1/servers") {
    if (mock === "costError") {
      return json(route, { error: "internal error" }, 500);
    }
    if (mock === "costEmpty") {
      return json(route, { items: SERVER_LIST.map(emptyBilling) });
    }
    return json(route, { items: SERVER_LIST });
  }
  if (path === "/api/v1/settings") {
    if (mock === "costManual") {
      return json(route, {
        items: {
          ...SETTINGS,
          fx_rates: JSON.stringify({
            base: "CNY",
            rates: { USD: 7.2, EUR: 7.8, JPY: 0.048 },
            fetched_at: NOW - HOUR,
            source: "manual",
          }),
        },
        secret_errors: null,
      });
    }
    return json(route, { items: SETTINGS, secret_errors: null });
  }
  if (path === "/api/v1/updates") {
    return json(route, {
      master: {
        current: "0.16.2",
        latest: "0.16.2",
        update_available: false,
        release_url: null,
        released_at: null,
        checked_at: NOW,
        error: null,
      },
      agents: {
        current_protocol: 1,
        min_supported: 1,
        versions: [{ version: "0.16.2", count: SERVER_LIST.length }],
      },
    });
  }
  if (path === "/api/v1/chains") {
    if (mock === "chainError") {
      return json(route, { error: "internal error" }, 500);
    }
    if (mock === "chainEmpty") {
      return json(route, { items: [] });
    }
    return json(route, { items: CHAINS });
  }
  if (path === "/api/v1/enforcement/events") {
    return json(route, { items: [] });
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
      // SPA fallback
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

const EXPECTED_API = {
  server: {
    present: ["/api/v1/overview/server-health"],
    absent: ["/api/v1/overview", "/api/v1/chains", "/api/v1/servers", "/api/v1/settings"],
  },
  traffic: {
    present: ["/api/v1/overview", "/api/v1/stats/traffic", "/api/v1/enforcement/events"],
    absent: ["/api/v1/chains", "/api/v1/overview/server-health", "/api/v1/servers", "/api/v1/settings"],
  },
  cost: {
    present: ["/api/v1/servers", "/api/v1/settings"],
    absent: ["/api/v1/overview", "/api/v1/chains", "/api/v1/overview/server-health"],
  },
  chain: {
    present: ["/api/v1/chains"],
    absent: ["/api/v1/overview", "/api/v1/overview/server-health", "/api/v1/servers", "/api/v1/settings"],
  },
};

const EXPECTED_CARD_TITLES = {
  server: ["服务器 × 时间", "当前资源", "异常窗口"],
  traffic: ["近 7 天趋势", "流量分布", "流量榜单", "告警"],
  cost: ["未来 12 个月付款日历", "开销大头", "币种构成", "一次性费用"],
  chain: ["转发链健康", "链路时延"],
};

const SCENARIOS = [
  { id: "server-dark-1440", view: null, theme: "dark", width: 1440, mock: "normal" },
  { id: "server-light-1440", view: "server", theme: "light", width: 1440, mock: "normal" },
  { id: "server-dark-390", view: "server", theme: "dark", width: 390, mock: "normal" },
  { id: "server-light-390", view: "server", theme: "light", width: 390, mock: "normal" },
  { id: "cost-dark-1440", view: "cost", theme: "dark", width: 1440, mock: "normal" },
  { id: "cost-light-1440", view: "cost", theme: "light", width: 1440, mock: "normal" },
  { id: "cost-dark-390", view: "cost", theme: "dark", width: 390, mock: "normal" },
  { id: "cost-light-390", view: "cost", theme: "light", width: 390, mock: "normal" },
  { id: "traffic-dark-1440", view: "traffic", theme: "dark", width: 1440, mock: "normal" },
  { id: "traffic-light-1440", view: "traffic", theme: "light", width: 1440, mock: "normal" },
  { id: "traffic-dark-390", view: "traffic", theme: "dark", width: 390, mock: "normal" },
  { id: "traffic-light-390", view: "traffic", theme: "light", width: 390, mock: "normal" },
  { id: "traffic-empty-1440", view: "traffic", theme: "dark", width: 1440, mock: "trafficEmpty" },
  { id: "traffic-error-1440", view: "traffic", theme: "dark", width: 1440, mock: "trafficError" },
  { id: "chain-empty-1440", view: "chain", theme: "dark", width: 1440, mock: "chainEmpty" },
  { id: "chain-error-1440", view: "chain", theme: "dark", width: 1440, mock: "chainError" },
  { id: "server-memory-1440", view: "server", theme: "dark", width: 1440, mock: "normal", action: "heatmapMemory" },
  { id: "server-filter-1440", view: "server", theme: "dark", width: 1440, mock: "normal", action: "resourceFilter" },
  { id: "server-resource-memory-1440", view: "server", theme: "dark", width: 1440, mock: "normal", action: "resourceMemory" },
  { id: "server-resource-empty-1440", view: "server", theme: "dark", width: 1440, mock: "serverResourceEmpty" },
  { id: "server-empty-1440", view: "server", theme: "dark", width: 1440, mock: "serverEmpty" },
  { id: "server-empty-390", view: "server", theme: "dark", width: 390, mock: "serverEmpty" },
  { id: "server-unsupported-1440", view: "server", theme: "dark", width: 1440, mock: "serverUnsupported" },
  { id: "server-error-1440", view: "server", theme: "dark", width: 1440, mock: "serverError" },
  { id: "server-forbidden-1440", view: "server", theme: "dark", width: 1440, mock: "serverForbidden" },
  { id: "cost-empty-1440", view: "cost", theme: "dark", width: 1440, mock: "costEmpty" },
  { id: "cost-empty-390", view: "cost", theme: "dark", width: 390, mock: "costEmpty" },
  { id: "cost-error-1440", view: "cost", theme: "dark", width: 1440, mock: "costError" },
  { id: "chain-dark-1440", view: "chain", theme: "dark", width: 1440, mock: "normal" },
  { id: "chain-light-1440", view: "chain", theme: "light", width: 1440, mock: "normal" },
  { id: "chain-dark-390", view: "chain", theme: "dark", width: 390, mock: "normal" },
  { id: "server-en-390", view: "server", theme: "dark", width: 390, mock: "normal", locale: "en" },
  { id: "cost-en-390", view: "cost", theme: "dark", width: 390, mock: "normal", locale: "en" },
  { id: "cost-manual-1440", view: "cost", theme: "dark", width: 1440, mock: "costManual" },
  { id: "cost-dec-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", clockMs: Date.UTC(2026, 11, 15, 4, 0, 0) },
  { id: "cost-dec-390", view: "cost", theme: "dark", width: 390, mock: "normal", clockMs: Date.UTC(2026, 11, 15, 4, 0, 0) },
];

const only = process.env.APP_SHOTS_ONLY?.split(",").filter(Boolean) ?? [];
const activeScenarios =
  only.length === 0
    ? SCENARIOS
    : SCENARIOS.filter((scenario) => only.includes(scenario.id));

const { server, port } = await startStaticServer();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {
  generatedAt: new Date().toISOString(),
  dist: DIST,
  shots: [],
};
const errors = [];

for (const scenario of activeScenarios) {
  const page = await browser.newPage({
    viewport: { width: scenario.width, height: 900 },
    deviceScaleFactor: 1,
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // 空态 / 错误态用例故意返回 404 / 500，浏览器会打一条资源错误；
    // 这不是产品缺陷，不写进最终 errors。
    if (
      scenario.mock !== "normal" &&
      message.text().includes("Failed to load resource")
    ) {
      return;
    }
    errors.push(`${scenario.id}: console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    errors.push(`${scenario.id}: pageerror: ${error.message}`);
  });
  const httpErrors = [];
  page.on("response", (response) => {
    if (response.status() >= 400) {
      httpErrors.push(
        `${response.status()} ${new URL(response.url()).pathname}`,
      );
    }
  });
  await page.addInitScript(
    ({ theme, locale }) => {
      try {
        localStorage.setItem("pierwave.theme", theme);
        localStorage.setItem("pierwave.locale", locale);
      } catch {
        // ignore storage access errors
      }
    },
    { theme: scenario.theme, locale: scenario.locale ?? "zh-CN" },
  );
  if (scenario.clockMs !== undefined) {
    await page.addInitScript(
      ({ clockMs }) => {
        const RealDate = Date;
        class FixedDate extends RealDate {
          constructor(...args) {
            if (args.length === 0) super(clockMs);
            else super(...args);
          }
          static now() {
            return clockMs;
          }
        }
        // @ts-ignore - test-only clock override
        window.Date = FixedDate;
      },
      { clockMs: scenario.clockMs },
    );
  }
  const apiPaths = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/")) apiPaths.push(path);
  });
  await page.route("**/api/v1/**", (route) => handleApi(route, scenario.mock));

  const url = scenario.view
    ? `${base}/?view=${scenario.view}`
    : `${base}/`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("[data-overview-insight-section]") !== null,
    undefined,
    { timeout: 20000 },
  );
  await page.waitForFunction(
    () => {
      const section = document.querySelector("[data-overview-insight-section]");
      if (!section) return false;
      return Boolean(
        section.querySelector(
          '[data-heatmap], [data-traffic-view], [data-cost-view], [data-chain-view], [data-slot="empty-state"], [data-slot="list-error"]',
        ),
      );
    },
    undefined,
    { timeout: 20000 },
  );
  if (scenario.action === "heatmapMemory") {
    await page
      .locator("[data-heatmap-card] [data-slot=\"tabs-trigger\"]")
      .filter({ hasText: "内存" })
      .click();
    await page.waitForTimeout(200);
  }
  if (scenario.action === "resourceMemory") {
    await page
      .locator("[data-resource-card] [data-slot=\"tabs-trigger\"]")
      .filter({ hasText: "内存" })
      .click();
    await page.waitForTimeout(250);
  }
  if (scenario.action === "resourceFilter") {
    await page.locator("[data-resource-filter]").click();
    const chips = page.locator("[data-resource-chip]");
    if ((await chips.count()) > 1) await chips.nth(1).click();
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(250);

  // 先把视口拉高到内容高度，才能截到完整页面（main 是内部滚动容器）。
  if (process.env.APP_SHOTS_NO_RESIZE !== "1")
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const needed = await page.evaluate(() => {
      const main = document.querySelector("#main-content");
      return main ? Math.ceil(main.scrollHeight + 56 + 4) : 900;
    });
    if (needed <= 900) break;
    await page.setViewportSize({
      width: scenario.width,
      height: needed,
    });
    await page.waitForTimeout(80);
  }
  // 视口变大后 compositor 可能还留着旧 tile；等两帧再截图，避免底部出现旧页头。
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
      }),
  );
  await page.waitForTimeout(400);

  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.querySelector("#main-content");
    const section = document.querySelector("[data-overview-insight-section]");
    const viewTabs = document.querySelector("[data-overview-view-tabs]");
    const heatmap = document.querySelector("[data-heatmap]");
    const heatmapScroll = document.querySelector("[data-heatmap-scroll]");
    const costCalendar = document.querySelector("[data-cost-calendar]");
    const heatmapCell = document.querySelector("[data-heatmap-cell]");
    const costCell = document.querySelector("[data-cost-cell]");
    const cellRect = heatmapCell?.getBoundingClientRect();
    const costRect = costCell?.getBoundingClientRect();
    return {
      pageWidth: doc.scrollWidth,
      pageHeight: main?.scrollHeight ?? null,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      overflowX: doc.scrollWidth > window.innerWidth + 1,
      mainOverflowX: main ? main.scrollWidth > main.clientWidth + 1 : false,
      sectionHeight: section?.getBoundingClientRect().height ?? null,
      tabs: viewTabs
        ? [...viewTabs.querySelectorAll('[data-slot="tabs-trigger"]')].map(
            (tab) => ({
              text: tab.textContent?.trim() ?? "",
              selected: tab.getAttribute("aria-selected") === "true",
            }),
          )
        : [],
      cardTitles: [...document.querySelectorAll("[data-overview-insight-section] [data-slot=\"card-title\"]")].map(
        (node) => node.textContent?.trim() ?? "",
      ),
      metrics: [...document.querySelectorAll("[data-insight-metric]")].map(
        (node) => ({
          label:
            node
              .querySelector("[data-insight-metric-label]")
              ?.textContent?.trim() ?? "",
          value:
            node
              .querySelector("[data-insight-metric-value]")
              ?.textContent?.trim() ?? "",
          hint:
            node
              .querySelector("[data-insight-metric-hint]")
              ?.textContent?.trim() ?? "",
        }),
      ),
      tabsList: viewTabs
        ? {
            display: getComputedStyle(viewTabs).display,
            width: viewTabs.getBoundingClientRect().width,
            className: viewTabs.className,
          }
        : null,
      heatmap: heatmap
        ? {
            cellWidth: cellRect?.width ?? null,
            cellHeight: cellRect?.height ?? null,
            gap: (() => {
              const cells = [...document.querySelectorAll("[data-heatmap-cell]")];
              const a = cells[0]?.getBoundingClientRect();
              const b = cells[1]?.getBoundingClientRect();
              return a && b
                ? Math.round((b.left - a.right) * 10) / 10
                : null;
            })(),
            scrollWidth: heatmapScroll?.scrollWidth ?? null,
            clientWidth: heatmapScroll?.clientWidth ?? null,
            scrollable:
              heatmapScroll !== null &&
              heatmapScroll.scrollWidth > heatmapScroll.clientWidth + 1,
          }
        : null,
      heatmapLegend: (() => {
        const element = document.querySelector("[data-heatmap-legend]");
        if (!element) return null;
        return {
          height: element.getBoundingClientRect().height,
          text: element.textContent?.trim() ?? "",
        };
      })(),
      resourceChart: (() => {
        const element =
          document.querySelector(
            "[data-resource-chart] .recharts-responsive-container",
          ) ?? document.querySelector("[data-resource-chart]");
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })(),
      costCalendar: costCalendar
        ? {
            cellWidth: costRect?.width ?? null,
            cellHeight: costRect?.height ?? null,
            scrollWidth: costCalendar.scrollWidth,
            clientWidth: costCalendar.clientWidth,
            scrollable: costCalendar.scrollWidth > costCalendar.clientWidth + 1,
          }
        : null,
      hasScrollHint: document.body.innerText.includes("左右滑动"),
      theme: doc.dataset.theme ?? null,
      dom: {
        asideCount: document.querySelectorAll("aside").length,
        mainCount: document.querySelectorAll("main").length,
        rootChildren: document.getElementById("root")?.children.length ?? null,
        bodyHeight: document.body.getBoundingClientRect().height,
        docHeight: document.documentElement.getBoundingClientRect().height,
        mainScrollHeight: main?.scrollHeight ?? null,
        mainClientHeight: main?.clientHeight ?? null,
      },
      costDebug: (() => {
        const view = document.querySelector("[data-cost-view]");
        if (!view) return null;
        const metrics = [...view.querySelectorAll("[data-slot=card-content] p")]
          .slice(0, 12)
          .map((node) => node.textContent?.trim());
        const calendar = view.querySelector("[data-cost-calendar]");
        if (!calendar) return { metrics, calendar: null };
        const grids = [...calendar.querySelectorAll("div.grid")].slice(0, 4);
        return {
          metrics,
          monthHeaders: grids[0]
            ? [...grids[0].children].map((child) => ({
                text: child.textContent?.trim(),
                left: child.getBoundingClientRect().left,
                width: child.getBoundingClientRect().width,
              }))
            : [],
          rows: grids.slice(1).map((grid) => ({
            cells: [...grid.children].map((child) => ({
              text: child.textContent?.trim(),
              left: Math.round(child.getBoundingClientRect().left),
              width: Math.round(child.getBoundingClientRect().width),
            })),
          })),
        };
      })(),
      debug: {
        mainClientWidth: main?.clientWidth ?? null,
        mainScrollWidth: main?.scrollWidth ?? null,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        rootScrollWidth: doc.scrollWidth,
        directChildren: main
          ? [...main.children].map((child) => ({
              tag: child.tagName,
              cls: child.className,
              width: child.getBoundingClientRect().width,
              scrollWidth: child.scrollWidth,
            }))
          : [],
        wideElements: [...document.querySelectorAll("#main-content *")]
          .filter((element) => {
            if (
              element.closest("[data-heatmap-scroll]") ||
              element.closest("[data-cost-calendar]")
            ) {
              return false;
            }
            const rect = element.getBoundingClientRect();
            return rect.right > (main?.clientWidth ?? 0) + 1;
          })
          .slice(0, 12)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              slot: element.getAttribute("data-slot"),
              cls: String(element.className).slice(0, 160),
              left: rect.left,
              right: rect.right,
              width: rect.width,
            };
          }),
      },
    };
  });

  if (scenario.mock === "normal") {
    const view = scenario.view ?? "server";
    const expectedApi = EXPECTED_API[view];
    const paths = new Set(apiPaths);
    for (const path of expectedApi.present) {
      if (!paths.has(path)) {
        errors.push(`${scenario.id}: missing API call ${path}`);
      }
    }
    for (const path of expectedApi.absent) {
      if (paths.has(path)) {
        errors.push(`${scenario.id}: unexpected API call ${path}`);
      }
    }
  }
  if (
    (scenario.mock === "normal" || scenario.mock === "costManual") &&
    (scenario.locale ?? "zh-CN") === "zh-CN"
  ) {
    const view = scenario.view ?? "server";
    const expected = EXPECTED_CARD_TITLES[view];
    if (
      expected &&
      JSON.stringify(metrics.cardTitles) !== JSON.stringify(expected)
    ) {
      errors.push(
        `${scenario.id}: card titles ${JSON.stringify(metrics.cardTitles)} != ${JSON.stringify(expected)}`,
      );
    }
  }

  const file = `app-${scenario.id}.png`;
  await page.screenshot({ path: `${OUT}${file}`, fullPage: false, animations: "disabled" });

  // 回到 900 高的视口再移除新区域：此时 main 仍是滚动容器，
  // scrollHeight 的变化才等于新区域给页面增加的高度。
  await page.setViewportSize({ width: scenario.width, height: 900 });
  await page.waitForTimeout(60);
  const pageHeightDelta = await page.evaluate(async () => {
    const main = document.querySelector("#main-content");
    const section = document.querySelector("[data-overview-insight-section]");
    if (!main || !section) return null;
    const before = main.scrollHeight;
    section.remove();
    await new Promise((resolvePromise) =>
      requestAnimationFrame(() => resolvePromise(null)),
    );
    return before - main.scrollHeight;
  });

  report.shots.push({
    ...scenario,
    file,
    apiPaths: [...new Set(apiPaths)],
    httpErrors,
    ...metrics,
    pageHeightDelta,
  });
  await page.close();
}

// 运行时断言：默认 tab、?view= 写入/清除、切换不整页刷新。
const urlPage = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
await urlPage.addInitScript(() => {
  try {
    localStorage.setItem("pierwave.theme", "dark");
    localStorage.setItem("pierwave.locale", "zh-CN");
  } catch {
    // ignore
  }
});
await urlPage.route("**/api/v1/**", (route) => handleApi(route, "normal"));
await urlPage.goto(`${base}/`, { waitUntil: "domcontentloaded" });
await urlPage.waitForFunction(
  () => document.querySelector("[data-heatmap]") !== null,
  undefined,
  { timeout: 20000 },
);
const urlBehavior = {
  defaultSearch: await urlPage.evaluate(() => location.search),
  defaultSelected: await urlPage.evaluate(
    () =>
      document
        .querySelector(
          '[data-overview-view-tabs] [data-slot="tabs-trigger"][aria-selected="true"]',
        )
        ?.textContent?.trim() ?? null,
  ),
};
await urlPage.evaluate(() => {
  window.__spaMarker = "kept";
});
await urlPage.getByRole("tab", { name: /成本开销/ }).click();
await urlPage.waitForFunction(
  () =>
    location.search === "?view=cost" &&
    document
      .querySelector(
        '[data-overview-view-tabs] [data-slot="tabs-trigger"][aria-selected="true"]',
      )
      ?.textContent?.includes("成本开销"),
);
urlBehavior.costSearch = await urlPage.evaluate(() => location.search);
urlBehavior.costSelected = await urlPage.evaluate(
  () =>
    document
      .querySelector(
        '[data-overview-view-tabs] [data-slot="tabs-trigger"][aria-selected="true"]',
      )
      ?.textContent?.trim() ?? null,
);
urlBehavior.sameDocument = await urlPage.evaluate(
  () => window.__spaMarker === "kept",
);
await urlPage.getByRole("tab", { name: /服务器状态/ }).click();
await urlPage.waitForFunction(
  () =>
    location.search === "" &&
    document
      .querySelector(
        '[data-overview-view-tabs] [data-slot="tabs-trigger"][aria-selected="true"]',
      )
      ?.textContent?.includes("服务器状态"),
);
urlBehavior.serverSearch = await urlPage.evaluate(() => location.search);
urlBehavior.serverSelected = await urlPage.evaluate(
  () =>
    document
      .querySelector(
        '[data-overview-view-tabs] [data-slot="tabs-trigger"][aria-selected="true"]',
      )
      ?.textContent?.trim() ?? null,
);
urlBehavior.sameDocumentAfterReturn = await urlPage.evaluate(
  () => window.__spaMarker === "kept",
);
await urlPage.close();
report.urlBehavior = urlBehavior;

await browser.close();
await new Promise((resolvePromise) => server.close(resolvePromise));

report.errors = errors;
writeFileSync(`${OUT}app-report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      shots: report.shots.length,
      errors,
      report: `${OUT}app-report.json`,
    },
    null,
    2,
  ),
);
for (const shot of report.shots) {
  console.log(
    [
      shot.file,
      `${shot.pageWidth}x${shot.pageHeight}`,
      `overflowX=${shot.overflowX}`,
      `mainOverflowX=${shot.mainOverflowX}`,
      `delta=${shot.pageHeightDelta}`,
      shot.heatmap
        ? `heatmapCell=${shot.heatmap.cellWidth?.toFixed(1)}x${shot.heatmap.cellHeight?.toFixed(1)} scrollable=${shot.heatmap.scrollable}`
        : "",
      shot.costCalendar
        ? `costCell=${shot.costCalendar.cellWidth?.toFixed(1)}x${shot.costCalendar.cellHeight?.toFixed(1)} scrollable=${shot.costCalendar.scrollable}`
        : "",
      `tabs=${shot.tabs.map((tab) => `${tab.text}${tab.selected ? "*" : ""}`).join(",")}`,
    ]
      .filter(Boolean)
      .join("  "),
  );
}
if (errors.length) process.exitCode = 1;
