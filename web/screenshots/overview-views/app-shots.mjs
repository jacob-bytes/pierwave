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

/** 截图用分组：覆盖多组 + 一个未分组（曼谷）的情况。 */
function groupForServer(id) {
  if (id.includes("hk")) return "香港";
  if (id.includes("tokyo") || id.includes("osaka")) return "日本";
  if (id.includes("sg")) return "东南亚";
  if (id.includes("fra")) return "欧洲";
  if (id.includes("us")) return "北美";
  if (id.includes("dubai")) return "中东";
  return null;
}

const SERVER_LIST = SERVER_DEFS.map((def, index) => ({
  id: def.id,
  name: def.name,
  address: `10.0.0.${index + 1}`,
  xray_mode: "auto",
  status: def.status ?? "online",
  group_name: groupForServer(def.id),
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

/** 7 台「色阶演示」服务器，与 makeBandsHealth() 的 id / 名称一一对应。 */
const BAND_SERVER_LIST = [
  { id: "band-0", name: "节点-88", group_name: "演示组", status: "online" },
  { id: "band-1", name: "节点-92", group_name: "演示组", status: "online" },
  { id: "band-2", name: "节点-96", group_name: "演示组", status: "online" },
  { id: "band-3", name: "节点-98", group_name: "演示组", status: "online" },
  { id: "band-4", name: "节点-100", group_name: "演示组", status: "online" },
  { id: "band-offline", name: "离线-01", group_name: "异常组", status: "offline" },
  { id: "band-nosample", name: "无采样-01", group_name: "异常组", status: "online" },
].map((server, index) => ({
  ...server,
  address: `10.1.0.${index + 1}`,
  xray_mode: "auto",
  last_seen_at: NOW - 30,
  config_version: 1,
  created_at: NOW - 30 * 86400,
  load1: 0.4,
}));

/** 40 台「数量演示」服务器，与 makeManyHealth() 的 id / 名称一一对应。 */
const MANY_HEALTH_SERVER_LIST = Array.from({ length: 40 }, (_, index) => {
  const offline = index < 4;
  return {
    id: `many-${index + 1}`,
    name: `节点-${String(index + 1).padStart(2, "0")}`,
    address: `10.2.0.${index + 1}`,
    xray_mode: "auto",
    status: offline ? "offline" : "online",
    group_name: ["香港", "日本", "东南亚", "欧洲"][index % 4],
    last_seen_at: NOW - (offline ? 7 * HOUR : 30),
    config_version: 1,
    created_at: NOW - 30 * 86400,
    load1: index >= 4 && index < 8 ? 5 : 0.3,
  };
});

function serverItemsFor(mock) {
  if (mock === "serverBands") return BAND_SERVER_LIST;
  if (mock === "serverMany") return MANY_HEALTH_SERVER_LIST;
  if (mock === "costManyCurrencies") return MANY_SERVER_LIST;
  return SERVER_LIST;
}

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

function makeBandsHealth() {
  const bands = [
    { id: "band-0", name: "节点-88", ratio: 0.88 },
    { id: "band-1", name: "节点-92", ratio: 0.92 },
    { id: "band-2", name: "节点-96", ratio: 0.96 },
    { id: "band-3", name: "节点-98", ratio: 0.98 },
    { id: "band-4", name: "节点-100", ratio: 1 },
  ];
  const full = (ratio) =>
    Array.from({ length: 168 }, (_, index) => ({
      ts: START + index * HOUR,
      online_ratio: ratio,
      load1: 0.4,
      mem_ratio: 0.5,
      disk_ratio: 0.6,
      samples: 12,
    }));
  const servers = bands.map((band) => ({
    id: band.id,
    name: band.name,
    online_ratio: band.ratio,
    buckets: full(band.ratio),
  }));
  servers.push({
    id: "band-offline",
    name: "离线-01",
    online_ratio: 0,
    buckets: full(0),
  });
  servers.push({
    id: "band-nosample",
    name: "无采样-01",
    online_ratio: null,
    buckets: Array.from({ length: 168 }, () => null),
  });
  return {
    generated_at: NOW,
    hours: 168,
    bucket: HOUR,
    summary: {
      online_ratio_24h: 0.958,
      abnormal_servers: 5,
      worst_disk_ratio: 0.6,
    },
    servers,
  };
}

function makeManyHealth() {
  const servers = Array.from({ length: 40 }, (_, index) => {
    const offline = index < 4;
    const issue = index >= 4 && index < 8;
    return {
      id: `many-${index + 1}`,
      name: `节点-${String(index + 1).padStart(2, "0")}`,
      online_ratio: offline ? 0 : 1,
      buckets: Array.from({ length: 168 }, (_, bucketIndex) => ({
        ts: START + bucketIndex * HOUR,
        online: !offline,
        load1: issue ? 5 : 0.3 + (index % 5) * 0.1,
        mem_ratio: issue ? 0.92 : 0.5,
        disk_ratio: 0.6,
        samples: 12,
      })),
    };
  });
  return {
    generated_at: NOW,
    hours: 168,
    bucket: HOUR,
    summary: {
      online_ratio_24h: 0.9,
      abnormal_servers: 8,
      worst_disk_ratio: 0.6,
    },
    servers,
  };
}

function makeHealth(mock) {
  if (mock === "serverBands") return makeBandsHealth();
  if (mock === "serverMany") return makeManyHealth();

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

const MANY_CURRENCIES = [
  "CNY",
  "USD",
  "EUR",
  "JPY",
  "GBP",
  "AUD",
  "CAD",
  "CHF",
  "HKD",
  "SGD",
];

const MANY_CURRENCY_RATES = Object.fromEntries(
  MANY_CURRENCIES.map((currency, index) => [
    currency,
    currency === "CNY" ? 1 : 0.9 + index * 0.37,
  ]),
);

const MANY_SERVER_LIST = MANY_CURRENCIES.map((currency, index) => ({
  id: `many-fx-${currency.toLowerCase()}`,
  name: `${currency} 节点`,
  address: `10.20.0.${index + 1}`,
  xray_mode: "auto",
  status: "online",
  last_seen_at: NOW - 30,
  config_version: 1,
  created_at: NOW - 30 * 86400,
  price_cents: 10000 + index * 100,
  currency,
  billing_cycle: "monthly",
  billing_cycle_count: 1,
  billing_cycle_unit: "month",
  paid_until: "2027-01-31",
}));

const MANY_SETTINGS = {
  ...SETTINGS,
  fx_rates: JSON.stringify({
    base: "CNY",
    rates: MANY_CURRENCY_RATES,
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
    if (mock === "scopeReady") {
      const ids =
        url.searchParams
          .get("server_ids")
          ?.split(",")
          .map((id) => id.trim())
          .filter(Boolean) ?? [];
      // 按选中台数近似缩放，让 KPI 与图表在截图里互相对得上。
      const ratio = ids.length > 0 ? Math.min(1, Math.max(2, ids.length) / 12) : 1;
      const scale = (value) => Math.round(value * ratio);
      const selectedDefs = SERVER_LIST.filter((server) =>
        ids.includes(server.id),
      );
      return json(route, {
        ...AGGREGATE,
        kpi: {
          ...AGGREGATE.kpi,
          servers_online: selectedDefs.filter(
            (server) => server.status === "online",
          ).length,
          servers_total: ids.length,
          traffic_today: scale(AGGREGATE.kpi.traffic_today),
          traffic_month: scale(AGGREGATE.kpi.traffic_month),
        },
        series: AGGREGATE.series.map((point) => ({
          ...point,
          uplink: scale(point.uplink),
          downlink: scale(point.downlink),
        })),
        protocol_series: AGGREGATE.protocol_series.map((row) => ({
          ...row,
          days: row.days.map((day) => ({ ...day, bytes: scale(day.bytes) })),
        })),
        protocols: AGGREGATE.protocols.map((row) => ({
          ...row,
          traffic_7d: scale(row.traffic_7d),
        })),
        top: selectedDefs.slice(0, 5).map((server, index) => ({
          kind: "server",
          server_id: server.id,
          name: server.name,
          traffic_7d: (index + 1) * 3 * 1024 ** 3,
          load1: server.load1 ?? null,
          online: server.status === "online",
          rates: [],
        })),
        top_users: AGGREGATE.top_users.map((row) => ({
          ...row,
          traffic_7d: scale(row.traffic_7d),
        })),
        top_nodes: AGGREGATE.top_nodes.map((row) => ({
          ...row,
          traffic_7d: scale(row.traffic_7d),
        })),
        package_split: AGGREGATE.package_split.map((row) => ({
          ...row,
          traffic_7d: scale(row.traffic_7d),
        })),
        scope: {
          server_ids: ids,
          servers_matched: ids.length,
          filtered: ids.length > 0,
          global: true,
        },
        warnings: { unknown_ids: [] },
      });
    }
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
    return json(route, { items: serverItemsFor(mock) });
  }
  if (path === "/api/v1/settings") {
    if (mock === "costManyCurrencies") {
      return json(route, { items: MANY_SETTINGS, secret_errors: null });
    }
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
  // 概览级筛选会在所有 tab 复用 /servers；范围筛选时还会请求 /overview。
  server: {
    present: ["/api/v1/overview/server-health"],
    absent: ["/api/v1/chains", "/api/v1/settings"],
  },
  traffic: {
    present: ["/api/v1/overview", "/api/v1/stats/traffic", "/api/v1/enforcement/events"],
    absent: ["/api/v1/chains", "/api/v1/overview/server-health", "/api/v1/settings"],
  },
  cost: {
    present: ["/api/v1/servers", "/api/v1/settings"],
    absent: ["/api/v1/chains", "/api/v1/overview/server-health"],
  },
  chain: {
    present: ["/api/v1/chains"],
    absent: ["/api/v1/overview/server-health", "/api/v1/settings"],
  },
};

const EXPECTED_CARD_TITLES = {
  server: ["服务器 × 时间", "当前资源", "异常窗口"],
  traffic: ["近 7 天趋势", "流量分布", "流量榜单", "告警"],
  cost: ["未来 12 个月的开销", "开销大头", "币种构成", "续费日历", "一次性费用"],
  chain: ["转发链健康", "链路时延"],
};

/** 东南亚组（新加坡-01/02 + 曼谷-01）：包含一条降级链的中间跳。 */
const SOUTHEAST_ASIA_IDS = SERVER_LIST.filter(
  (server) => server.group_name === "东南亚",
).map((server) => server.id);

function scenarioServerIds(scenario) {
  if (scenario.servers === "all") {
    return serverItemsFor(scenario.mock).map((server) => server.id);
  }
  if (Array.isArray(scenario.servers)) return scenario.servers;
  return null;
}

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
  { id: "server-bands-dark-1440", view: "server", theme: "dark", width: 1440, mock: "serverBands" },
  { id: "server-bands-light-1440", view: "server", theme: "light", width: 1440, mock: "serverBands" },
  { id: "server-bands-dark-390", view: "server", theme: "dark", width: 390, mock: "serverBands" },
  { id: "server-bands-light-390", view: "server", theme: "light", width: 390, mock: "serverBands" },
  { id: "scope-filter-default-1440", view: "server", theme: "dark", width: 1440, mock: "normal", action: "openFilter" },
  { id: "scope-filter-default-light-1440", view: "server", theme: "light", width: 1440, mock: "normal", action: "openFilter" },
  { id: "scope-filter-expanded-1440", view: "server", theme: "dark", width: 1440, mock: "normal", action: "expandGroup" },
  { id: "scope-filter-expanded-390", view: "server", theme: "dark", width: 390, mock: "normal", action: "expandGroup" },
  { id: "scope-filter-partial-1440", view: "server", theme: "dark", width: 1440, mock: "normal", action: "indeterminateGroup" },
  { id: "scope-filter-default-many-1440", view: "server", theme: "dark", width: 1440, mock: "serverMany", action: "openFilter" },
  { id: "scope-filter-empty-390", view: "server", theme: "dark", width: 390, mock: "normal", action: "emptySelection" },
  { id: "scope-server-filtered-1440", view: "server", theme: "dark", width: 1440, mock: "normal", servers: SOUTHEAST_ASIA_IDS },
  { id: "scope-server-filtered-390", view: "server", theme: "dark", width: 390, mock: "normal", servers: SOUTHEAST_ASIA_IDS },
  { id: "scope-traffic-filtered-1440", view: "traffic", theme: "dark", width: 1440, mock: "normal", servers: SOUTHEAST_ASIA_IDS },
  { id: "scope-traffic-ready-1440", view: "traffic", theme: "dark", width: 1440, mock: "scopeReady", servers: SOUTHEAST_ASIA_IDS },
  { id: "scope-cost-filtered-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", servers: SOUTHEAST_ASIA_IDS },
  { id: "scope-chain-filtered-1440", view: "chain", theme: "dark", width: 1440, mock: "normal", servers: SOUTHEAST_ASIA_IDS },
  { id: "scope-empty-server-1440", view: "server", theme: "dark", width: 1440, mock: "normal", servers: [] },
  { id: "scope-empty-traffic-1440", view: "traffic", theme: "dark", width: 1440, mock: "normal", servers: [] },
  { id: "scope-empty-cost-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", servers: [] },
  { id: "scope-empty-chain-1440", view: "chain", theme: "dark", width: 1440, mock: "normal", servers: [] },
  { id: "scope-empty-server-390", view: "server", theme: "dark", width: 390, mock: "normal", servers: [] },
  { id: "server-filter-open-1440", view: "server", theme: "dark", width: 1440, mock: "normal", action: "openFilter" },
  { id: "server-filter-open-390", view: "server", theme: "dark", width: 390, mock: "normal", action: "openFilter" },
  { id: "server-filter-search-1440", view: "server", theme: "dark", width: 1440, mock: "normal", action: "searchFilter" },
  { id: "server-many-1440", view: "server", theme: "dark", width: 1440, mock: "serverMany" },
  { id: "server-many-all-1440", view: "server", theme: "dark", width: 1440, mock: "serverMany", action: "selectAllServers" },
  { id: "server-filter-clear-1440", view: "server", theme: "dark", width: 1440, mock: "serverMany", action: "clearServers" },
  { id: "server-line-filtered-1440", view: "server", theme: "dark", width: 1440, mock: "normal", servers: ["srv-hk-01", "srv-tokyo-01", "srv-sg-01"] },
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
  { id: "cost-fx-open-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", action: "fxOpen", expectedFxRows: 4 },
  { id: "cost-fx-open-390", view: "cost", theme: "dark", width: 390, mock: "normal", action: "fxOpen", expectedFxRows: 4 },
  { id: "cost-fx-open-light-1440", view: "cost", theme: "light", width: 1440, mock: "normal", action: "fxOpen", expectedFxRows: 4 },
  { id: "cost-fx-open-light-390", view: "cost", theme: "light", width: 390, mock: "normal", action: "fxOpen", expectedFxRows: 4 },
  { id: "cost-fx-many-1440", view: "cost", theme: "dark", width: 1440, mock: "costManyCurrencies", servers: "all", action: "fxOpen", expectedFxRows: 10 },
  { id: "cost-bar-tooltip-left-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", action: "barHoverLeft" },
  { id: "cost-bar-tooltip-middle-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", action: "barHoverMiddle" },
  { id: "cost-bar-tooltip-right-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", action: "barHoverRight" },
  { id: "cost-renewal-single-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", servers: "all", action: "renewalHoverSingle" },
  { id: "cost-renewal-single-390", view: "cost", theme: "dark", width: 390, mock: "normal", servers: "all", action: "renewalHoverSingle" },
  { id: "cost-renewal-multi-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", servers: "all", action: "renewalHoverMulti" },
  { id: "cost-renewal-multi-390", view: "cost", theme: "dark", width: 390, mock: "normal", servers: "all", action: "renewalHoverMulti" },
  { id: "cost-renewal-multi-light-1440", view: "cost", theme: "light", width: 1440, mock: "normal", servers: "all", action: "renewalHoverMulti" },
  { id: "cost-renewal-empty-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", servers: "all", action: "renewalEmpty" },
  { id: "cost-renewal-empty-390", view: "cost", theme: "dark", width: 390, mock: "normal", servers: "all", action: "renewalEmpty" },
  { id: "cost-renewal-empty-light-1440", view: "cost", theme: "light", width: 1440, mock: "normal", servers: "all", action: "renewalEmpty" },
  { id: "cost-renewal-empty-light-390", view: "cost", theme: "light", width: 390, mock: "normal", servers: "all", action: "renewalEmpty" },
  { id: "cost-renewal-future-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", servers: "all", action: "renewalFuture" },
  { id: "cost-renewal-future-390", view: "cost", theme: "dark", width: 390, mock: "normal", servers: "all", action: "renewalFuture" },
  { id: "cost-renewal-bounds-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", servers: "all", action: "renewalBounds" },
  { id: "cost-bar-tooltip-multi-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", servers: "all", action: "barHoverMulti" },
  { id: "cost-bar-tooltip-single-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", action: "barHoverSingle" },
  { id: "cost-bar-tooltip-empty-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", action: "barHoverEmpty" },
  { id: "cost-bar-tooltip-empty-390", view: "cost", theme: "dark", width: 390, mock: "normal", action: "barFocusEmpty" },
  { id: "cost-bar-tooltip-keyboard-1440", view: "cost", theme: "dark", width: 1440, mock: "normal", action: "barFocus" },
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

  const urlParams = new URLSearchParams();
  if (scenario.view) urlParams.set("view", scenario.view);
  const explicitServers = scenarioServerIds(scenario);
  if (explicitServers !== null) {
    urlParams.set("servers", explicitServers.join(","));
  }
  const url = urlParams.size > 0 ? `${base}/?${urlParams.toString()}` : `${base}/`;
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
  if (scenario.action === "openFilter") {
    await page.locator("[data-server-filter-trigger]").click();
    await page.waitForSelector("[data-server-filter-content]");
    await page.waitForTimeout(200);
  }
  if (scenario.action === "searchFilter") {
    await page.locator("[data-server-filter-trigger]").click();
    await page.waitForSelector("[data-server-filter-content]");
    await page.locator("[data-server-filter-search]").fill("香港");
    await page.waitForTimeout(200);
  }
  if (scenario.action === "selectAllServers") {
    await page.locator("[data-server-filter-trigger]").click();
    await page.waitForSelector("[data-server-filter-content]");
    await page.locator("[data-server-filter-all]").click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
  if (scenario.action === "clearServers") {
    await page.locator("[data-server-filter-trigger]").click();
    await page.waitForSelector("[data-server-filter-content]");
    await page.locator("[data-server-filter-clear]").click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
  if (scenario.action === "expandGroup") {
    await page.locator("[data-server-filter-trigger]").click();
    await page.waitForSelector("[data-server-filter-content]");
    await page
      .locator(
        `[data-server-filter-group="${scenario.group ?? "group:日本"}"] button`,
      )
      .first()
      .click();
    await page.waitForTimeout(200);
  }
  if (scenario.action === "indeterminateGroup") {
    await page.locator("[data-server-filter-trigger]").click();
    await page.waitForSelector("[data-server-filter-content]");
    await page
      .locator(
        `[data-server-filter-group="${scenario.group ?? "group:香港"}"] button`,
      )
      .first()
      .click();
    await page.waitForTimeout(200);
  }
  if (scenario.action === "emptySelection") {
    await page.locator("[data-server-filter-trigger]").click();
    await page.waitForSelector("[data-server-filter-content]");
    await page.locator("[data-server-filter-clear]").click();
    await page.waitForTimeout(200);
  }
  if (scenario.action === "selectGroup") {
    await page.locator("[data-server-filter-trigger]").click();
    await page.waitForSelector("[data-server-filter-content]");
    await page
      .locator(
        `[data-server-filter-group="${scenario.group ?? "group:东南亚"}"] [data-slot="checkbox"]`,
      )
      .first()
      .click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
  if (scenario.action === "resourceMemory") {
    await page
      .locator("[data-resource-card] [data-slot=\"tabs-trigger\"]")
      .filter({ hasText: "内存" })
      .click();
    await page.waitForTimeout(250);
  }
  if (scenario.action === "fxOpen") {
    await page.locator("[data-cost-fx-trigger]").click();
    await page.waitForSelector("[data-fx-popover]");
    await page.waitForTimeout(250);
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

  if (
    scenario.action === "barHoverMulti" ||
    scenario.action === "barHoverSingle" ||
    scenario.action === "barHoverEmpty" ||
    scenario.action === "barHoverLeft" ||
    scenario.action === "barHoverMiddle" ||
    scenario.action === "barHoverRight" ||
    scenario.action === "barFocus" ||
    scenario.action === "barFocusEmpty"
  ) {
    const index = await page.evaluate((kind) => {
      const bars = [...document.querySelectorAll("[data-month-bar]")];
      const counts = bars.map((bar) =>
        Number(bar.getAttribute("data-month-charge-count") ?? 0),
      );
      const totals = bars.map((bar) =>
        Number(bar.getAttribute("data-month-total-cents") ?? 0),
      );
      if (kind === "barHoverEmpty" || kind === "barFocusEmpty") {
        return totals.findIndex((value) => value === 0);
      }
      if (kind === "barHoverSingle") {
        return counts.findIndex((value) => value === 1);
      }
      if (kind === "barHoverLeft") return 0;
      if (kind === "barHoverRight") return bars.length - 1;
      if (kind === "barHoverMiddle") {
        return Math.floor(bars.length / 2);
      }
      return counts.reduce(
        (best, value, i) => (value > counts[best] ? i : best),
        0,
      );
    }, scenario.action);
    if (index >= 0) {
      const bar = page.locator("[data-month-bar]").nth(index);
      if (
        scenario.action === "barFocus" ||
        scenario.action === "barFocusEmpty"
      ) {
        await bar.focus();
      } else {
        await bar.hover();
      }
      await page.waitForTimeout(250);
    }
  }

  if (
    scenario.action === "renewalHoverSingle" ||
    scenario.action === "renewalHoverMulti" ||
    scenario.action === "renewalEmpty" ||
    scenario.action === "renewalFuture" ||
    scenario.action === "renewalBounds"
  ) {
    if (scenario.action === "renewalFuture") {
      for (let index = 0; index < 2; index += 1) {
        const next = page.locator("[data-renewal-next]");
        if (await next.isDisabled()) break;
        await next.click();
        await page.waitForTimeout(80);
      }
    } else if (scenario.action === "renewalBounds") {
      for (let index = 0; index < 20; index += 1) {
        const next = page.locator("[data-renewal-next]");
        if (await next.isDisabled()) break;
        await next.click();
        await page.waitForTimeout(40);
      }
    } else {
      for (let index = 0; index < 12; index += 1) {
        const info = await page.evaluate(() => {
          const days = [
            ...document.querySelectorAll("[data-renewal-day]"),
          ].map((day) =>
            Number(day.getAttribute("data-renewal-count") ?? 0),
          );
          return { counts: days, max: Math.max(0, ...days) };
        });
        const matched =
          scenario.action === "renewalEmpty"
            ? info.counts.length === 0
            : scenario.action === "renewalHoverMulti"
              ? info.max > 1
              : info.counts.some((count) => count === 1);
        if (matched) break;
        const next = page.locator("[data-renewal-next]");
        if (await next.isDisabled()) break;
        await next.click();
        await page.waitForTimeout(80);
      }
      if (scenario.action !== "renewalEmpty") {
        const counts = await page.evaluate(() =>
          [...document.querySelectorAll("[data-renewal-day]")].map((day) =>
            Number(day.getAttribute("data-renewal-count") ?? 0),
          ),
        );
        const index =
          scenario.action === "renewalHoverMulti"
            ? counts.reduce(
                (best, value, i) => (value > counts[best] ? i : best),
                0,
              )
            : counts.findIndex((count) => count === 1);
        if (index >= 0) {
          await page
            .locator("[data-renewal-day]")
            .nth(index)
            .hover();
          await page.waitForTimeout(250);
        }
      }
    }
  }

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
      selectedText:
        document
          .querySelector("[data-server-filter-trigger]")
          ?.textContent?.trim() ?? null,
      search: window.location.search,
      filterLayout: (() => {
        const tabs = document.querySelector("[data-overview-view-tabs]");
        const trigger = document.querySelector("[data-server-filter-trigger]");
        if (!tabs || !trigger) return null;
        const tabsRect = tabs.getBoundingClientRect();
        const filterRect = trigger.getBoundingClientRect();
        return {
          tabsTop: tabsRect.top,
          tabsBottom: tabsRect.bottom,
          tabsRight: tabsRect.right,
          filterTop: filterRect.top,
          filterRight: filterRect.right,
          sameRow: Math.abs(filterRect.top - tabsRect.top) < 8,
        };
      })(),
      kpiValues: [...document.querySelectorAll("[data-kpi-value]")].map(
        (node) => node.textContent?.trim() ?? "",
      ),
      kpiLabels: [...document.querySelectorAll("[data-kpi-label]")].map(
        (node) => node.textContent?.trim() ?? "",
      ),
      globalLabels: [...document.querySelectorAll("[data-kpi-global]")].map(
        (node) => node.textContent?.trim() ?? "",
      ),
      hasEmptyState: Boolean(
        document.querySelector(
          '[data-overview-insight-section] [data-slot="empty-state"]',
        ),
      ),
      trafficWarning: Boolean(
        document.querySelector("[data-traffic-scope-warning]"),
      ),
      filterTree: (() => {
        const content = document.querySelector("[data-server-filter-content]");
        if (!content) return null;
        const rect = content.getBoundingClientRect();
        const groups = [
          ...content.querySelectorAll("[data-server-filter-group]"),
        ].map((row) => ({
          key: row.getAttribute("data-server-filter-group"),
          expanded: row.getAttribute("aria-expanded"),
          state:
            row
              .querySelector('[data-slot="checkbox"]')
              ?.getAttribute("data-state") ?? null,
        }));
        return {
          modeTabs: content.querySelectorAll("[data-server-filter-mode]")
            .length,
          groups,
          serverRows: content.querySelectorAll("[data-server-filter-item]")
            .length,
          defaultHint: Boolean(
            content.querySelector("[data-server-filter-default-hint]"),
          ),
          rect: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            height: rect.height,
          },
        };
      })(),
      heatmapRows: document.querySelectorAll("[data-heatmap-row]").length,
      heatmapTabs: document.querySelectorAll(
        '[data-heatmap-card] [data-slot="tabs-trigger"]',
      ).length,
      heatmapRowScroll: (() => {
        const element = document.querySelector("[data-heatmap-row-scroll]");
        if (!element) return null;
        return {
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollable: element.scrollHeight > element.clientHeight + 1,
        };
      })(),
      heatmapStepColors: [0, 1, 2, 3, 4].map((step) => {
        const cell = document.querySelector(
          `[data-heatmap-cell][data-step="${step}"]`,
        );
        return cell ? getComputedStyle(cell).backgroundColor : null;
      }),
      lineSeries: document.querySelectorAll(
        "[data-resource-chart] .recharts-line",
      ).length,
      areaSeries: document.querySelectorAll(
        "[data-resource-chart] .recharts-area",
      ).length,
      fx: (() => {
        const popover = document.querySelector("[data-fx-popover]");
        const list = document.querySelector("[data-fx-list]");
        const rect = popover?.getBoundingClientRect();
        const rows = [...document.querySelectorAll("[data-fx-row]")];
        return {
          defaultText:
            document
              .querySelector("[data-cost-fx]")
              ?.textContent?.trim() ?? null,
          popoverOpen: Boolean(popover),
          rows: rows.length,
          rowTexts: rows.map((row) => row.textContent?.trim() ?? ""),
          unknownText:
            document
              .querySelector("[data-fx-unknown]")
              ?.textContent?.trim() ?? null,
          footerText:
            document
              .querySelector("[data-fx-footer]")
              ?.textContent?.trim() ?? null,
          rect: rect
            ? {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              }
            : null,
          list: list
            ? {
                scrollHeight: list.scrollHeight,
                clientHeight: list.clientHeight,
                scrollable: list.scrollHeight > list.clientHeight + 1,
              }
            : null,
          bodyHasRateLine: document.body.innerText.includes("1 USD ="),
        };
      })(),
      costBars: (() => {
        const chart = document.querySelector("[data-cost-bar-chart]");
        const bars = [...document.querySelectorAll("[data-month-bar]")];
        const cards = [...document.querySelectorAll("[data-cost-card]")];
        const tooltip = document.querySelector("[data-month-tooltip]");
        const barRect = (bar) => bar.getBoundingClientRect();
        const innerRect = (bar) =>
          bar.firstElementChild?.getBoundingClientRect() ?? null;
        return {
          chart: chart
            ? {
                width: chart.getBoundingClientRect().width,
                height: chart.getBoundingClientRect().height,
              }
            : null,
          count: bars.length,
          hasCalendar: Boolean(document.querySelector("[data-cost-calendar]")),
          labels: bars.map((bar) => {
            const index = Number(bar.getAttribute("data-month-index") ?? 0);
            return (
              document.querySelectorAll("[data-cost-bar-chart] > div:last-child > span")[
                index
              ]?.textContent?.trim() ?? ""
            );
          }),
          widths: bars.map((bar) => barRect(bar).width),
          heights: bars.map((bar) => innerRect(bar)?.height ?? 0),
          totals: bars.map((bar) =>
            Number(bar.getAttribute("data-month-total-cents") ?? 0),
          ),
          chargeCounts: bars.map((bar) =>
            Number(bar.getAttribute("data-month-charge-count") ?? 0),
          ),
          emptyCount: bars.filter(
            (bar) => Number(bar.getAttribute("data-month-total-cents") ?? 0) === 0,
          ).length,
          cards: cards.map((card) => {
            const rect = card.getBoundingClientRect();
            return {
              key: card.getAttribute("data-cost-card"),
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
              height: rect.height,
            };
          }),
          bottomGap: (() => {
            const last = cards.at(-1);
            if (!last || !main) return null;
            const rect = last.getBoundingClientRect();
            const mainRect = main.getBoundingClientRect();
            return Math.round(
              (main.scrollHeight -
                (rect.bottom - mainRect.top + main.scrollTop)) *
                10,
            ) / 10;
          })(),
          tooltip: tooltip
            ? (() => {
                const tooltipRect = tooltip.getBoundingClientRect();
                const plot = document.querySelector(
                  "[data-cost-bar-chart] [data-month-bar]",
                )?.parentElement;
                const plotRect = plot?.getBoundingClientRect() ?? null;
                const key = tooltip.getAttribute("data-month-key");
                const bar = [...bars].find(
                  (item) => item.getAttribute("data-month-key") === key,
                );
                const fill = bar?.firstElementChild;
                const barRect = bar?.getBoundingClientRect() ?? null;
                const fillRect = fill?.getBoundingClientRect() ?? null;
                return {
                  rect: {
                    left: tooltipRect.left,
                    right: tooltipRect.right,
                    top: tooltipRect.top,
                    bottom: tooltipRect.bottom,
                    width: tooltipRect.width,
                    height: tooltipRect.height,
                  },
                  plotRect: plotRect
                    ? {
                        left: plotRect.left,
                        right: plotRect.right,
                        top: plotRect.top,
                        bottom: plotRect.bottom,
                      }
                    : null,
                  barRect: barRect
                    ? {
                        left: barRect.left,
                        right: barRect.right,
                        top: barRect.top,
                        bottom: barRect.bottom,
                      }
                    : null,
                  barFillRect: fillRect
                    ? {
                        left: fillRect.left,
                        right: fillRect.right,
                        top: fillRect.top,
                        bottom: fillRect.bottom,
                      }
                    : null,
                  placement: tooltip.getAttribute("data-placement"),
                  total:
                  tooltip
                    .querySelector("[data-month-tooltip-total]")
                    ?.textContent?.trim() ?? null,
                rows: tooltip.querySelectorAll("[data-month-tooltip-server]")
                  .length,
                more:
                  tooltip
                    .querySelector("[data-month-tooltip-more]")
                    ?.textContent?.trim() ?? null,
                empty:
                  tooltip
                    .querySelector("[data-month-tooltip-empty]")
                    ?.textContent?.trim() ?? null,
                prepaid:
                  tooltip
                    .querySelector("[data-month-tooltip-prepaid]")
                    ?.textContent?.trim() ?? null,
                  oneTimeCount: [
                    ...tooltip.querySelectorAll("[data-month-tooltip-server]"),
                  ].filter((row) =>
                    row.textContent?.includes("一次性"),
                  ).length,
                };
              })()
            : null,
        };
      })(),
      renewal: (() => {
        const card = document.querySelector('[data-cost-card="renewal"]');
        if (!card) return null;
        const grid = card.querySelector("[data-renewal-grid]");
        const days = [...card.querySelectorAll("[data-renewal-day]")];
        const cells = [...card.querySelectorAll("[data-renewal-cell]")];
        const cell = cells[0]?.getBoundingClientRect() ?? null;
        const tooltip = document.querySelector("[data-renewal-tooltip]");
        const tooltipRect = tooltip?.getBoundingClientRect() ?? null;
        return {
          month:
            card.querySelector("[data-renewal-month]")?.textContent?.trim() ??
            null,
          summary:
            card.querySelector("[data-renewal-summary]")?.textContent?.trim() ??
            null,
          cells: cells.length,
          eventDays: days.length,
          totalCount: days.reduce(
            (sum, day) =>
              sum + Number(day.getAttribute("data-renewal-count") ?? 0),
            0,
          ),
          badges: days.map(
            (day) =>
              day.querySelector("[data-renewal-badge]")?.textContent?.trim() ??
              "",
          ),
          cellWidth: cell?.width ?? null,
          cellHeight: cell?.height ?? null,
          gridWidth: grid?.getBoundingClientRect().width ?? null,
          prevDisabled:
            card.querySelector("[data-renewal-prev]")?.hasAttribute(
              "disabled",
            ) ?? null,
          nextDisabled:
            card.querySelector("[data-renewal-next]")?.hasAttribute(
              "disabled",
            ) ?? null,
          tooltip: tooltip
            ? {
                rows: tooltip.querySelectorAll("[data-renewal-tooltip-row]")
                  .length,
                more:
                  tooltip
                    .querySelector("[data-renewal-tooltip-more]")
                    ?.textContent?.trim() ?? null,
                text: tooltip.textContent?.trim() ?? "",
                rect: tooltipRect
                  ? {
                      left: tooltipRect.left,
                      right: tooltipRect.right,
                      top: tooltipRect.top,
                      bottom: tooltipRect.bottom,
                    }
                  : null,
              }
            : null,
        };
      })(),
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

  if (scenario.mock === "normal" || scenario.mock === "scopeReady") {
    if (metrics.globalLabels.length !== 2) {
      errors.push(
        `${scenario.id}: global KPI annotations ${JSON.stringify(metrics.globalLabels)} != 2`,
      );
    }
    if (metrics.filterLayout) {
      if (scenario.width >= 768 && !metrics.filterLayout.sameRow) {
        errors.push(`${scenario.id}: filter is not on the tab row`);
      }
      if (
        scenario.width >= 768 &&
        metrics.filterLayout.filterRight - metrics.filterLayout.tabsRight > 320
      ) {
        errors.push(`${scenario.id}: filter drifted away from the tabs`);
      }
      if (
        scenario.width < 768 &&
        metrics.filterLayout.filterTop <= metrics.filterLayout.tabsBottom
      ) {
        errors.push(`${scenario.id}: mobile filter should wrap below tabs`);
      }
    }
    if (metrics.filterTree) {
      if (metrics.filterTree.modeTabs !== 0) {
        errors.push(`${scenario.id}: three-mode selector still present`);
      }
      const rect = metrics.filterTree.rect;
      if (rect.bottom > metrics.viewportHeight + 1 || rect.top < -1) {
        errors.push(
          `${scenario.id}: filter popover overflows viewport ${JSON.stringify(rect)}`,
        );
      }
      if (rect.right > metrics.viewportWidth + 1 || rect.left < -1) {
        errors.push(`${scenario.id}: filter popover horizontal overflow`);
      }
      if (rect.height > 470) {
        errors.push(`${scenario.id}: filter popover too tall ${rect.height}`);
      }
      if (
        ["openFilter", "expandGroup", "indeterminateGroup", "emptySelection"].includes(
          scenario.action ?? "",
        ) &&
        metrics.filterTree.groups.length === 0
      ) {
        errors.push(`${scenario.id}: filter tree has no groups`);
      }
      if (scenario.action === "openFilter") {
        if (metrics.filterTree.serverRows !== 0) {
          errors.push(
            `${scenario.id}: collapsed tree shows ${metrics.filterTree.serverRows} servers`,
          );
        }
      }
      if (scenario.action === "expandGroup") {
        if (metrics.filterTree.serverRows === 0) {
          errors.push(`${scenario.id}: expanded group shows no servers`);
        }
        if (
          !metrics.filterTree.groups.some((group) => group.expanded === "true")
        ) {
          errors.push(`${scenario.id}: no group expanded`);
        }
      }
      if (scenario.action === "searchFilter") {
        if (metrics.filterTree.serverRows === 0) {
          errors.push(`${scenario.id}: search did not expand matching group`);
        }
      }
      if (scenario.action === "indeterminateGroup") {
        if (
          !metrics.filterTree.groups.some(
            (group) => group.state === "indeterminate",
          )
        ) {
          errors.push(`${scenario.id}: no indeterminate group`);
        }
      }
      if (scenario.action === "emptySelection") {
        if (
          metrics.filterTree.groups.some(
            (group) =>
              group.state === "checked" || group.state === "indeterminate",
          )
        ) {
          errors.push(`${scenario.id}: cleared groups still checked`);
        }
      }
      if (
        scenario.id === "scope-filter-default-many-1440" &&
        !metrics.filterTree.defaultHint
      ) {
        errors.push(`${scenario.id}: missing problem-first default hint`);
      }
    }
  }
  if (explicitServers !== null) {
    if (!metrics.search.includes("servers=")) {
      errors.push(`${scenario.id}: URL missing servers= (${metrics.search})`);
    }
    if (explicitServers.length === 0) {
      if (metrics.metrics.length !== 0) {
        errors.push(
          `${scenario.id}: empty selection still renders ${metrics.metrics.length} KPIs`,
        );
      }
      if (!metrics.hasEmptyState) {
        errors.push(`${scenario.id}: empty selection missing empty state`);
      }
      if (metrics.kpiValues[0] !== "—" || metrics.kpiValues[3] !== "—") {
        errors.push(
          `${scenario.id}: empty selection KPI ${JSON.stringify(metrics.kpiValues)} should be —`,
        );
      }
    }
  }
  if (
    (scenario.action === "selectGroup" ||
      scenario.action === "selectAllServers" ||
      false) &&
    !metrics.search.includes("servers=")
  ) {
    errors.push(`${scenario.id}: selection not written to URL`);
  }
  if (
    scenario.id === "scope-traffic-filtered-1440" &&
    !metrics.trafficWarning
  ) {
    errors.push(`${scenario.id}: missing needs-newer-controller warning`);
  }
  if (scenario.id === "scope-traffic-ready-1440") {
    if (metrics.trafficWarning) {
      errors.push(`${scenario.id}: scope-ready response should not warn`);
    }
    if (
      metrics.kpiValues[3] === "—" ||
      metrics.kpiValues[3]?.startsWith("32")
    ) {
      errors.push(
        `${scenario.id}: filtered traffic KPI ${metrics.kpiValues[3]} still global`,
      );
    }
  }
  if (scenario.id === "scope-chain-filtered-1440" && metrics.metrics.length !== 3) {
    errors.push(
      `${scenario.id}: chain KPIs ${metrics.metrics.length} != 3`,
    );
  }

  if (scenario.mock === "normal" && explicitServers?.length !== 0) {
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
    (scenario.locale ?? "zh-CN") === "zh-CN" &&
    explicitServers === null &&
    !metrics.hasEmptyState
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

  if (
    (scenario.view ?? "server") === "server" &&
    scenario.mock === "normal" &&
    !["openFilter", "expandGroup", "indeterminateGroup", "emptySelection"].includes(
      scenario.action ?? "",
    ) &&
    explicitServers?.length !== 0
  ) {
    const selected = Number(
      metrics.selectedText?.match(/(\d+)\//)?.[1] ?? Number.NaN,
    );
    if (!Number.isFinite(selected) || selected > 8) {
      errors.push(
        `${scenario.id}: default selected ${selected} > 8 (${metrics.selectedText})`,
      );
    }
    if (metrics.heatmapTabs !== 0) {
      errors.push(
        `${scenario.id}: heatmap still has ${metrics.heatmapTabs} metric tabs`,
      );
    }
    if (metrics.heatmapRows !== selected) {
      errors.push(
        `${scenario.id}: heatmap rows ${metrics.heatmapRows} != selected ${selected}`,
      );
    }
    if (metrics.lineSeries > 5) {
      errors.push(
        `${scenario.id}: line chart defaults to ${metrics.lineSeries} series`,
      );
    }
  }
  if (metrics.areaSeries !== 0) {
    errors.push(`${scenario.id}: resource chart still renders area series`);
  }
  if (scenario.mock === "serverBands") {
    if (metrics.heatmapRows !== 7) {
      errors.push(`${scenario.id}: band rows ${metrics.heatmapRows} != 7`);
    }
    const colors = metrics.heatmapStepColors.filter(Boolean);
    if (colors.length !== 5 || new Set(colors).size !== 5) {
      errors.push(
        `${scenario.id}: 5 band colors missing (${JSON.stringify(colors)})`,
      );
    }
    const lightness = colors.map((color) =>
      Number(color.match(/oklab\(([\d.]+)/)?.[1] ?? Number.NaN),
    );
    if (
      lightness.some(
        (value, index) =>
          !Number.isFinite(value) ||
          (index > 0 && value >= lightness[index - 1]),
      )
    ) {
      errors.push(
        `${scenario.id}: band lightness is not increasing (${lightness})`,
      );
    }
  }
  if (scenario.mock === "serverMany" && scenario.action === undefined) {
    if (metrics.heatmapRows !== 8) {
      errors.push(`${scenario.id}: many default rows ${metrics.heatmapRows} != 8`);
    }
    if (!metrics.selectedText?.includes("已选 8/40")) {
      errors.push(`${scenario.id}: many default count ${metrics.selectedText}`);
    }
  }
  if (scenario.mock === "serverMany" && scenario.action === "selectAllServers") {
    if (metrics.heatmapRows !== 40) {
      errors.push(`${scenario.id}: all-selected rows ${metrics.heatmapRows} != 40`);
    }
    if (!metrics.heatmapRowScroll?.scrollable) {
      errors.push(`${scenario.id}: heatmap should scroll with 40 rows`);
    }
  }
  if (scenario.mock === "serverMany" && scenario.action === "clearServers") {
    if (metrics.heatmapRows !== 0) {
      errors.push(`${scenario.id}: cleared rows ${metrics.heatmapRows} != 0`);
    }
    if (metrics.selectedText?.includes("已选 0/40") !== true) {
      errors.push(`${scenario.id}: clear count ${metrics.selectedText}`);
    }
  }
  if (
    (scenario.view ?? null) === "cost" &&
    scenario.mock === "normal" &&
    scenario.action !== "fxOpen" &&
    explicitServers?.length !== 0
  ) {
    if (metrics.fx.popoverOpen) {
      errors.push(`${scenario.id}: FX popover open by default`);
    }
    const shortFx =
      (scenario.locale ?? "zh-CN") === "en"
        ? "Converted to CNY at FX rates"
        : "按汇率折算为 CNY";
    if (!metrics.fx.defaultText?.includes(shortFx)) {
      errors.push(`${scenario.id}: missing short FX sentence`);
    }
    if (metrics.fx.bodyHasRateLine) {
      errors.push(`${scenario.id}: full FX rate line visible by default`);
    }
  }
  if (scenario.action === "fxOpen") {
    if (!metrics.fx.popoverOpen) {
      errors.push(`${scenario.id}: FX popover did not open`);
    }
    if (metrics.fx.rows !== scenario.expectedFxRows) {
      errors.push(
        `${scenario.id}: FX rows ${metrics.fx.rows} != ${scenario.expectedFxRows}`,
      );
    }
    if (metrics.fx.rect && metrics.fx.rect.right > metrics.viewportWidth + 1) {
      errors.push(`${scenario.id}: FX popover overflows viewport`);
    }
    if (metrics.fx.rect && metrics.fx.rect.left < -1) {
      errors.push(`${scenario.id}: FX popover left overflow`);
    }
    if (scenario.mock === "normal" && !metrics.fx.unknownText) {
      errors.push(`${scenario.id}: missing unknown-currency warning`);
    }
    if (
      scenario.mock === "costManyCurrencies" &&
      !metrics.fx.list?.scrollable
    ) {
      errors.push(`${scenario.id}: FX list should scroll with many currencies`);
    }
  }

  if (
    (scenario.view ?? null) === "cost" &&
    scenario.mock !== "costEmpty" &&
    scenario.mock !== "costError" &&
    !(Array.isArray(scenario.servers) && scenario.servers.length === 0)
  ) {
    if (metrics.costBars?.count !== 12) {
      errors.push(
        `${scenario.id}: month bars ${metrics.costBars?.count} != 12`,
      );
    }
    if (metrics.costBars?.hasCalendar) {
      errors.push(`${scenario.id}: old payment calendar still rendered`);
    }
    if (
      metrics.costBars?.totals.some(
        (total, index) => total === 0 && metrics.costBars.heights[index] > 0.5,
      )
    ) {
      errors.push(`${scenario.id}: empty month has a positive-height bar`);
    }
    if (metrics.viewportWidth >= 1280 && metrics.costBars?.cards) {
      const byKey = new Map(
        metrics.costBars.cards.map((card) => [card.key, card]),
      );
      const month = byKey.get("month");
      const top = byKey.get("top");
      const mix = byKey.get("mix");
      const renewal = byKey.get("renewal");
      const once = byKey.get("once");
      if (
        month &&
        top &&
        (Math.abs(month.top - top.top) > 1.5 ||
          Math.abs(month.bottom - top.bottom) > 1.5)
      ) {
        errors.push(
          `${scenario.id}: month/top cards not aligned (${JSON.stringify({ month, top })})`,
        );
      }
      if (
        mix &&
        renewal &&
        (Math.abs(mix.top - renewal.top) > 1.5 ||
          Math.abs(mix.bottom - renewal.bottom) > 1.5)
      ) {
        errors.push(
          `${scenario.id}: mix/renewal cards not aligned (${JSON.stringify({ mix, renewal })})`,
        );
      }
      if (
        once &&
        month &&
        top &&
        (Math.abs(once.left - month.left) > 1.5 ||
          Math.abs(once.right - top.right) > 1.5)
      ) {
        errors.push(
          `${scenario.id}: one-time card is not full width (${JSON.stringify({ once, month })})`,
        );
      }
    }
    if (metrics.costBars?.bottomGap !== null && metrics.costBars.bottomGap > 24) {
      errors.push(
        `${scenario.id}: bottom gap ${metrics.costBars.bottomGap} > 24`,
      );
    }
    if (scenario.action === "barHoverMulti") {
      if (!metrics.costBars?.tooltip || metrics.costBars.tooltip.rows === 0) {
        errors.push(`${scenario.id}: multi-month tooltip has no servers`);
      }
      const maxCharges = Math.max(...(metrics.costBars?.chargeCounts ?? [0]));
      if (
        maxCharges > 8 &&
        !metrics.costBars?.tooltip?.more?.includes("另有")
      ) {
        errors.push(`${scenario.id}: missing >8 server hint`);
      }
    }
    if (scenario.action === "barHoverSingle") {
      if (metrics.costBars?.tooltip?.rows !== 1) {
        errors.push(
          `${scenario.id}: single-month tooltip rows ${metrics.costBars?.tooltip?.rows}`,
        );
      }
    }
    if (
      scenario.action === "barHoverEmpty" ||
      scenario.action === "barFocusEmpty"
    ) {
      if (!metrics.costBars?.tooltip?.empty?.includes("本月无开支")) {
        errors.push(`${scenario.id}: empty-month tooltip missing no-spend text`);
      }
    }
    if (scenario.action === "barFocus" && !metrics.costBars?.tooltip) {
      errors.push(`${scenario.id}: keyboard focus did not open tooltip`);
    }
    if (
      ["barHoverLeft", "barHoverMiddle", "barHoverRight"].includes(
        scenario.action,
      )
    ) {
      const tooltip = metrics.costBars?.tooltip;
      if (!tooltip?.rect || !tooltip.plotRect || !tooltip.barRect) {
        errors.push(`${scenario.id}: tooltip geometry missing`);
      } else {
        const { rect, plotRect, barRect, barFillRect } = tooltip;
        if (
          rect.left < plotRect.left - 1 ||
          rect.right > plotRect.right + 1 ||
          rect.top < plotRect.top - 1 ||
          rect.bottom > plotRect.bottom + 1
        ) {
          errors.push(
            `${scenario.id}: tooltip outside plot (${JSON.stringify({ rect, plotRect })})`,
          );
        }
        if (tooltip.placement === "above" || tooltip.placement === "below") {
          if (!barFillRect) {
            errors.push(`${scenario.id}: tooltip/bar gap missing`);
          } else {
            const above = rect.bottom <= barFillRect.top;
            const below = rect.top >= barFillRect.bottom;
            const gap = above
              ? barFillRect.top - rect.bottom
              : barFillRect.bottom - rect.top;
            if ((!above && !below) || gap < 8 || gap > 14) {
              errors.push(
                `${scenario.id}: tooltip/bar gap invalid (gap ${gap})`,
              );
            }
          }
        } else if (
          tooltip.placement === "left" ||
          tooltip.placement === "right"
        ) {
          const visualBar = barFillRect ?? barRect;
          const gap =
            tooltip.placement === "right"
              ? rect.left - visualBar.right
              : visualBar.left - rect.right;
          if (gap < 8 || gap > 14) {
            errors.push(
              `${scenario.id}: side tooltip/bar gap invalid (gap ${gap})`,
            );
          }
        } else {
          errors.push(
            `${scenario.id}: tooltip placement ${tooltip.placement} overlaps`,
          );
        }
        if (
          scenario.action === "barHoverMiddle" &&
          (tooltip.placement === "above" ||
            tooltip.placement === "below")
        ) {
          const delta = Math.abs(
            (rect.left + rect.right) / 2 -
              (barRect.left + barRect.right) / 2,
          );
          if (delta > 2) {
            errors.push(
              `${scenario.id}: middle tooltip not centered (delta ${delta})`,
            );
          }
        }
      }
    }
  }

  if (
    (scenario.view ?? null) === "cost" &&
    scenario.mock !== "costEmpty" &&
    scenario.mock !== "costError" &&
    metrics.renewal
  ) {
    const renewal = metrics.renewal;
    if (renewal.cells < 28 || renewal.cells > 31) {
      errors.push(`${scenario.id}: renewal cells ${renewal.cells}`);
    }
    if (renewal.badges.length !== renewal.eventDays) {
      errors.push(`${scenario.id}: renewal badge count mismatch`);
    }
    if (
      renewal.cellWidth !== null &&
      renewal.cellHeight !== null &&
      (renewal.cellWidth < 40 || renewal.cellHeight < 40)
    ) {
      errors.push(
        `${scenario.id}: renewal cell ${renewal.cellWidth}x${renewal.cellHeight} < 40`,
      );
    }
    if (renewal.eventDays > 0) {
      const summaryPattern =
        (scenario.locale ?? "zh-CN") === "en"
          ? /Renewals this month: \d+ day\(s\), \d+ server\(s\)/
          : /本月\s*\d+\s*天有到期，共\s*\d+\s*台/;
      if (!summaryPattern.test(renewal.summary ?? "")) {
        errors.push(
          `${scenario.id}: renewal summary format (${renewal.summary})`,
        );
      }
    } else if (!renewal.summary?.includes("本月没有需要续费的服务器")) {
      errors.push(
        `${scenario.id}: renewal empty summary (${renewal.summary})`,
      );
    }
    if (scenario.action === "renewalHoverSingle") {
      if (renewal.tooltip?.rows !== 1) {
        errors.push(
          `${scenario.id}: renewal single tooltip rows ${renewal.tooltip?.rows}`,
        );
      }
    }
    if (scenario.action === "renewalHoverMulti") {
      if ((renewal.tooltip?.rows ?? 0) < 2) {
        errors.push(
          `${scenario.id}: renewal multi tooltip rows ${renewal.tooltip?.rows}`,
        );
      }
    }
    if (scenario.action === "renewalEmpty") {
      if (renewal.eventDays !== 0) {
        errors.push(`${scenario.id}: renewal empty has ${renewal.eventDays} days`);
      }
    }
    if (scenario.action === "renewalFuture") {
      if (!renewal.month?.includes("2027")) {
        errors.push(`${scenario.id}: renewal future month ${renewal.month}`);
      }
      if (renewal.prevDisabled) {
        errors.push(`${scenario.id}: renewal prev disabled after moving ahead`);
      }
    }
    if (scenario.action === "renewalBounds") {
      if (!renewal.nextDisabled) {
        errors.push(`${scenario.id}: renewal next not disabled at last month`);
      }
    }
    if (
      renewal.tooltip?.rect &&
      (renewal.tooltip.rect.left < -1 ||
        renewal.tooltip.rect.right > metrics.viewportWidth + 1 ||
        renewal.tooltip.rect.top < -1 ||
        renewal.tooltip.rect.bottom > metrics.viewportHeight + 1)
    ) {
      errors.push(
        `${scenario.id}: renewal tooltip overflows viewport (${JSON.stringify(renewal.tooltip.rect)})`,
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

if (process.env.APP_SHOTS_SKIP_URL === "1") {
  report.urlBehavior = null;
} else {
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
await urlPage.getByRole("tab", { name: /成本开支/ }).click();
await urlPage.waitForFunction(
  () =>
    location.search === "?view=cost" &&
    document
      .querySelector(
        '[data-overview-view-tabs] [data-slot="tabs-trigger"][aria-selected="true"]',
      )
      ?.textContent?.includes("成本开支"),
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
await urlPage.getByRole("tab", { name: /资源状态/ }).click();
await urlPage.waitForFunction(
  () =>
    location.search === "" &&
    document
      .querySelector(
        '[data-overview-view-tabs] [data-slot="tabs-trigger"][aria-selected="true"]',
      )
      ?.textContent?.includes("资源状态"),
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

// 空选时四个 tab 都走空态，顶部 KPI 不把缺失数据画成 0。
await urlPage.locator("[data-server-filter-trigger]").click();
await urlPage.waitForSelector("[data-server-filter-content]");
await urlPage.locator("[data-server-filter-clear]").click();
await urlPage.keyboard.press("Escape");
await urlPage.waitForFunction(
  () =>
    new URLSearchParams(location.search).has("servers") &&
    new URLSearchParams(location.search).get("servers") === "" &&
    document
      .querySelector("[data-server-filter-trigger]")
      ?.textContent?.includes("已选 0/") &&
    document.querySelector("[data-kpi-value]")?.textContent?.trim() === "—",
);
urlBehavior.emptySearch = await urlPage.evaluate(() => location.search);
urlBehavior.emptyKpis = await urlPage.evaluate(() =>
  [...document.querySelectorAll("[data-kpi-value]")].map(
    (node) => node.textContent?.trim() ?? "",
  ),
);
urlBehavior.emptyViews = {};
for (const [tab, view] of [
  ["资源状态", "server"],
  ["流量趋势", "traffic"],
  ["成本开支", "cost"],
  ["链路时延", "chain"],
]) {
  await urlPage.getByRole("tab", { name: tab }).click();
  await urlPage.waitForTimeout(200);
  await urlPage.waitForFunction(
    (next) => {
      const search = new URLSearchParams(location.search);
      return (
        (next === null || search.get("view") === next) &&
        search.get("servers") === "" &&
        Boolean(
          document.querySelector(
            '[data-overview-insight-section] [data-slot="empty-state"]',
          ),
        )
      );
    },
    view === "server" ? null : view,
  );
  urlBehavior.emptyViews[view] = await urlPage.evaluate(() => ({
    search: location.search,
    emptyState: Boolean(
      document.querySelector(
        '[data-overview-insight-section] [data-slot="empty-state"]',
      ),
    ),
    insightMetrics: document.querySelectorAll("[data-insight-metric]").length,
  }));
}
for (const [view, state] of Object.entries(urlBehavior.emptyViews)) {
  if (!state.emptyState || state.insightMetrics !== 0) {
    errors.push(`urlBehavior: ${view} empty state missing`);
  }
}
if (urlBehavior.emptyKpis[0] !== "—" || urlBehavior.emptyKpis[3] !== "—") {
  errors.push(
    `urlBehavior: empty KPI ${JSON.stringify(urlBehavior.emptyKpis)} should hide 0`,
  );
}

// 组复选框选中整组；取消组内一台后变成半选。
await urlPage.locator("[data-server-filter-trigger]").click();
await urlPage.waitForSelector("[data-server-filter-content]");
const japanRow = urlPage.locator(
  '[data-server-filter-group="group:日本"]',
);
await japanRow.locator('[data-slot="checkbox"]').click();
await urlPage.waitForFunction(
  () =>
    new URLSearchParams(location.search)
      .get("servers")
      ?.includes("srv-tokyo-01") &&
    document
      .querySelector("[data-server-filter-trigger]")
      ?.textContent?.includes("已选 3/12"),
);
urlBehavior.groupToggleSearch = await urlPage.evaluate(() => location.search);
await japanRow.locator("button").first().click();
const japanServers = urlPage.locator(
  '[data-server-filter-section]:has([data-server-filter-group="group:日本"]) [data-server-filter-item]',
);
await japanServers.first().locator('[data-slot="checkbox"]').click();
await urlPage.waitForFunction(
  () =>
    document
      .querySelector(
        '[data-server-filter-group="group:日本"] [data-slot="checkbox"]',
      )
      ?.getAttribute("data-state") === "indeterminate" &&
    document
      .querySelector("[data-server-filter-trigger]")
      ?.textContent?.includes("已选 2/12"),
);
urlBehavior.partialState = await urlPage.evaluate(() =>
  document
    .querySelector(
      '[data-server-filter-group="group:日本"] [data-slot="checkbox"]',
    )
    ?.getAttribute("data-state"),
);
await urlPage.locator("[data-server-filter-clear]").click();
await urlPage.waitForFunction(
  () =>
    document
      .querySelector("[data-server-filter-trigger]")
      ?.textContent?.includes("已选 0/12"),
);

// 键盘：焦点在搜索框时 ↓ 进入第一组，空格勾选整组，再按一次取消。
await urlPage.locator("[data-server-filter-search]").focus();
await urlPage.keyboard.press("ArrowDown");
urlBehavior.keyboardFocus = await urlPage.evaluate(() =>
  document.activeElement?.getAttribute("data-server-filter-group"),
);
await urlPage.keyboard.press(" ");
await urlPage.waitForFunction(
  () =>
    new URLSearchParams(location.search)
      .get("servers")
      ?.includes("srv-us-01") &&
    document
      .querySelector("[data-server-filter-trigger]")
      ?.textContent?.includes("已选 1/12"),
);
urlBehavior.keyboardSearch = await urlPage.evaluate(() => location.search);
await urlPage
  .locator('[data-server-filter-group="group:北美"]')
  .focus();
await urlPage.keyboard.press(" ");
await urlPage.waitForFunction(
  () =>
    document
      .querySelector("[data-server-filter-trigger]")
      ?.textContent?.includes("已选 0/12"),
);
await urlPage.keyboard.press("Escape");
await urlPage.waitForFunction(
  () => document.querySelector("[data-server-filter-content]") === null,
);
urlBehavior.keyboardEscape = await urlPage.evaluate(
  () => document.querySelector("[data-server-filter-content]") === null,
);

// 选一个分组 → URL 带 servers= → 切 tab 仍保留同一选择。
await urlPage.locator("[data-server-filter-trigger]").click();
await urlPage.waitForSelector("[data-server-filter-content]");
await urlPage
  .locator(
    '[data-server-filter-group="group:东南亚"] [data-slot="checkbox"]',
  )
  .first()
  .click();
await urlPage.keyboard.press("Escape");
await urlPage.waitForFunction(
  () =>
    new URLSearchParams(location.search)
      .get("servers")
      ?.includes("srv-sg-01") &&
    document
      .querySelector("[data-server-filter-trigger]")
      ?.textContent?.includes("已选 2/12"),
);
urlBehavior.groupSearch = await urlPage.evaluate(() => location.search);
urlBehavior.groupSelected = await urlPage.evaluate(
  () =>
    document.querySelector("[data-server-filter-trigger]")?.textContent?.trim() ??
    null,
);
await urlPage.getByRole("tab", { name: /成本开支/ }).click();
await urlPage.waitForFunction(
  () =>
    location.search.includes("view=cost") &&
    new URLSearchParams(location.search).get("servers")?.includes("srv-sg-01") &&
    document
      .querySelector("[data-server-filter-trigger]")
      ?.textContent?.includes("已选 2/12"),
);
urlBehavior.costKeepsServers = await urlPage.evaluate(() => location.search);
urlBehavior.costSelected = await urlPage.evaluate(
  () =>
    document.querySelector("[data-server-filter-trigger]")?.textContent?.trim() ??
    null,
);
urlBehavior.sameDocumentAfterFilter = await urlPage.evaluate(
  () => window.__spaMarker === "kept",
);
if (urlBehavior.groupSelected !== urlBehavior.costSelected) {
  errors.push(
    `urlBehavior: selection lost across tabs (${urlBehavior.groupSelected} -> ${urlBehavior.costSelected})`,
  );
}
if (urlBehavior.partialState !== "indeterminate") {
  errors.push(`urlBehavior: group half-state ${urlBehavior.partialState}`);
}
if (urlBehavior.keyboardFocus !== "group:北美") {
  errors.push(`urlBehavior: keyboard focus ${urlBehavior.keyboardFocus}`);
}
if (!urlBehavior.keyboardEscape) {
  errors.push("urlBehavior: Escape did not close the filter");
}
if (
  !urlBehavior.groupToggleSearch?.includes("srv-tokyo-01") ||
  !urlBehavior.groupToggleSearch?.includes("srv-osaka-01")
) {
  errors.push(
    `urlBehavior: group checkbox did not select children (${urlBehavior.groupToggleSearch})`,
  );
}
await urlPage.close();
report.urlBehavior = urlBehavior;

}
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
      shot.costBars
        ? `bars=${shot.costBars.count} empty=${shot.costBars.emptyCount}`
        : "",
      `tabs=${shot.tabs.map((tab) => `${tab.text}${tab.selected ? "*" : ""}`).join(",")}`,
    ]
      .filter(Boolean)
      .join("  "),
  );
}
if (errors.length) process.exitCode = 1;
