// Screenshots + assertions for the overview KPI cards as navigation entries,
// the "Updated HH:MM" page-header control and the global tag on the chains card.
//
// 验收 / Covers:
// - 四卡异常 / 正常两态，1440 / 390，亮 / 暗；
// - hover 轻微反馈、键盘 Enter 跳转、四张卡的最终 href；
// - 页头「更新于 HH:MM ↻」新形态：请求中 aria-busy + 不 disabled + 重入保护；
// - 异常数字 semantic color（离线 / 阻断 destructive、降级 warning、0 值 muted）；
// - 图标块无异常 muted 背景、有异常跟随语义色；转发链卡带「全局」标。
//
// Usage:
//   cd web && npm run build
//   node screenshots/overview-kpi-links/shots.mjs
//
// Serves `web/dist` and mocks every API the overview needs, so no controller or
// database is involved. Playwright is taken from the repo's npx cache (same
// approach as screenshots/overview-kpi-compact/shots.mjs).
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

// 正常态：所有服务器都在线，热力图 / 24h 在线率不出现异常窗口。
// 「四卡正常态」截图里上下两块必须自洽，否则看起来像数据错了。
const NORMAL_HEALTH = {
  ...SERVER_HEALTH,
  summary: {
    ...SERVER_HEALTH.summary,
    online_ratio_24h: 1,
    abnormal_servers: 0,
    servers_without_samples: 0,
    offline_servers: 0,
    resource_servers: 0,
  },
  servers: SERVER_DEFS.map((def, index) => ({
    id: def.id,
    name: def.name,
    status: "online",
    online_ratio: 1,
    buckets: Array.from({ length: 168 }, (_, bucketIndex) => ({
      ...healthBucket(START + bucketIndex * HOUR, { ...def, health: "online" }, bucketIndex),
      online: true,
      online_ratio: 0.999,
      outage_samples: 0,
    })),
  })),
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
    total_chains: 3,
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
    {
      // 让「阻断 1」的卡片与链路列表的 ?status=blocked 筛选对得上。
      id: "chain-blocked",
      name: "备用链-阻断",
      hops: 2,
      status: { kind: "blocked", cause: "node_offline" },
      estimated: false,
      series: chainSeries(80),
      segments: [
        {
          seq: 1,
          from: "法兰克福-01",
          to: "新加坡-01",
          p50: 180,
          delta_ms: 140,
          contribution_pct: 100,
          attempts: 0,
          failures: 0,
          loss_pct: null,
        },
        {
          seq: 2,
          from: "新加坡-01",
          to: "blocked.example.com",
          p50: null,
          delta_ms: null,
          contribution_pct: 0,
          attempts: 0,
          failures: 0,
          loss_pct: null,
        },
      ],
      diagnosis: { kind: "single_hop", seq: 1 },
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

async function handleApi(route, normal = false) {
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
    // 正常态：同一批服务器全部在线（0 台离线 → 卡片回概览服务器视图）。
    const items = normal
      ? SERVER_LIST.map((server) => ({ ...server, status: "online" }))
      : SERVER_LIST;
    return json(route, { items });
  }
  if (path === "/api/v1/settings") {
    return json(route, { items: SETTINGS, secret_errors: null });
  }
  if (path === "/api/v1/overview/server-health") {
    return json(route, normal ? NORMAL_HEALTH : SERVER_HEALTH);
  }
  if (path === "/api/v1/chain-templates") {
    // 链路列表会顺带取模板名做搜索；mock 一个空列表即可。
    return json(route, { items: [] });
  }
  if (path === "/api/v1/overview") {
    const aggregate = normal
      ? {
          ...AGGREGATE,
          kpi: { ...AGGREGATE.kpi, servers_online: 10, servers_total: 10 },
          chains: { ...AGGREGATE.chains, blocked: 0, degraded: 0 },
          top: AGGREGATE.top.map((item) => ({ ...item, online: true })),
        }
      : AGGREGATE;
    return json(route, {
      ...aggregate,
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
    const stats = normal
      ? {
          ...STATS,
          servers: { total: SERVER_LIST.length, online: SERVER_LIST.length },
          alerts: { ...STATS.alerts, offline_servers: 0 },
        }
      : STATS;
    return json(route, stats);
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
  // 点击「用户与套餐」卡会离开概览；给用户页需要的列表一个空响应，
  // 这样验收脚本不会把正常的空列表当成 404。
  if (
    path === "/api/v1/users" ||
    path === "/api/v1/packages" ||
    path === "/api/v1/subscriptions"
  ) {
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

const KPI_LABEL = {
  server: "资源状态 / Resource status",
  cost: "成本开支 / Cost spend",
  chain: "链路时延 / Chain latency",
  templates: "转发模板 / Chain templates",
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

const round = (value) => Math.round(value * 10) / 10;
const errors = [];
const report = {
  generatedAt: new Date().toISOString(),
  top: {},
  skeleton: {},
  kpi: {},
  kpiHeights: {},
  kpiHeightSpread: {},
  tabs: {},
  navigation: {},
  keyboard: {},
  refresh: {},
  hover: {},
  colors: {},
  i18n: {},
};

const { server, port } = await startStaticServer();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function openPage({
  theme,
  width,
  query,
  delayPath,
  normal = false,
  delayMs = 1200,
  requestLog,
  ignorePageErrors = false,
  locale = CHINESE,
}) {
  const page = await browser.newPage({
    viewport: { width, height: 1000 },
    deviceScaleFactor: 1,
  });
  if (requestLog) {
    page.on("request", (request) => {
      requestLog.push(new URL(request.url()).pathname);
    });
  }
  page.on("pageerror", (error) => {
    if (!ignorePageErrors) errors.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (
      !ignorePageErrors &&
      message.type() === "error" &&
      !message.text().includes("Failed to load resource")
    ) {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("response", (response) => {
    if (!ignorePageErrors && response.status() >= 400) {
      errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
    }
  });
  await page.addInitScript(
    ({ theme, locale }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale },
  );
  await page.route("**/api/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const delayed = Array.isArray(delayPath)
      ? delayPath.includes(pathname)
      : pathname === delayPath;
    if (delayPath && delayed) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return handleApi(route, normal);
  });
  await page.goto(`${base}/?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-overview-insight]", { timeout: 20000 });
  // 顶部「转发链」来自 /api/v1/overview，等它拿到数字再截图 / 断言。
  await page.waitForFunction(
    () => {
      const value = document
        .querySelector("[data-kpi-chains-total]")
        ?.textContent?.trim();
      return Boolean(value) && value !== "—";
    },
    undefined,
    { timeout: 20000 },
  );
  return page;
}

/** 顶部四卡：文案、数值、栅格、溢出。 */
async function readTopCards(page) {
  return page.evaluate(() => {
    const section = document.querySelector("[data-overview-kpis]");
    if (!section) return null;
    const cards = [...section.querySelectorAll("[data-kpi-card]")];
    const rect = section.getBoundingClientRect();
    const style = getComputedStyle(section);
    const readText = (element) =>
      (element?.textContent ?? "").replace(/\s+/g, " ").trim();
    return {
      count: cards.length,
      rows: new Set(
        cards.map((card) => Math.round(card.getBoundingClientRect().top)),
      ).size,
      columns: style.gridTemplateColumns.split(" ").filter(Boolean).length,
      gap: style.gap,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      globals: section.querySelectorAll("[data-kpi-global]").length,
      cards: cards.map((card) => {
        const box = card.getBoundingClientRect();
        const value = card.querySelector("[data-kpi-value]");
        const hint = card.querySelector("[data-kpi-hint]");
        const label = card.querySelector("[data-kpi-label]");
        const valueBox = value?.getBoundingClientRect();
        const hintBox = hint?.getBoundingClientRect();
        return {
          label: readText(label?.firstElementChild ?? label),
          value: readText(value),
          hint: readText(hint),
          top: Math.round(box.top),
          left: Math.round(box.left),
          width: Math.round(box.width * 10) / 10,
          height: Math.round(box.height * 10) / 10,
          scrollWidth: card.scrollWidth,
          clientWidth: card.clientWidth,
          valueHeight: valueBox ? Math.round(valueBox.height * 10) / 10 : null,
          hintHeight: hintBox ? Math.round(hintBox.height * 10) / 10 : null,
          valueBottom:
            valueBox && hintBox
              ? Math.round((hintBox.bottom - valueBox.bottom) * 10) / 10
              : null,
          valueClipped: value
            ? value.scrollHeight > value.clientHeight + 1
            : null,
        };
      }),
      merged: {
        users: readText(document.querySelector("[data-kpi-users-total]")),
        instances: readText(
          document.querySelector("[data-kpi-package-instances]"),
        ),
      },
      chains: {
        total: readText(document.querySelector("[data-kpi-chains-total]")),
      },
      documentOverflow: Math.max(
        0,
        document.documentElement.scrollWidth - window.innerWidth,
      ),
    };
  });
}

/** KPI 条：栅格 / 字号 / 高度 / 溢出。 */
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
      width: Math.round(card.getBoundingClientRect().width * 10) / 10,
      cells: cells.length,
      cellHeights: rects.map((rect) => Math.round(rect.height * 10) / 10),
      rows: new Set(rects.map((rect) => Math.round(rect.top))).size,
      columns: new Set(rects.map((rect) => Math.round(rect.left))).size,
      gridColumns: grid.split(" ").filter(Boolean).length,
      valueSize: value ? getComputedStyle(value).fontSize : null,
      hintSize: hint ? getComputedStyle(hint).fontSize : null,
      labelSize: label ? getComputedStyle(label).fontSize : null,
      firstWidth: rects[0] ? Math.round(rects[0].width) : null,
      secondWidth: rects[1] ? Math.round(rects[1].width) : null,
      cellsDetail: cells.map((cell) => {
        const box = cell.getBoundingClientRect();
        const valueElement = cell.querySelector("[data-chain-kpi-value]");
        const hintElement = cell.querySelector("[data-chain-kpi-hint]");
        const valueBox = valueElement?.getBoundingClientRect();
        const labelElement = cell.querySelector("[data-chain-kpi-label]");
        const labelBox = labelElement?.getBoundingClientRect();
        const hintBox = hintElement?.getBoundingClientRect();
        const style = getComputedStyle(cell);
        const hintStyle = hintElement ? getComputedStyle(hintElement) : null;
        const last = hintElement ?? valueElement;
        const lastBox = last?.getBoundingClientRect();
        const contentTop = labelBox?.top ?? valueBox?.top ?? box.top;
        const contentBottom = lastBox?.bottom ?? box.top;
        const hintPaddingTop = hintStyle ? parseFloat(hintStyle.paddingTop) : 0;
        return {
          top: Math.round(box.top * 10) / 10,
          height: Math.round(box.height * 10) / 10,
          scrollWidth: cell.scrollWidth,
          clientWidth: cell.clientWidth,
          minHeight: style.minHeight,
          paddingTop: parseFloat(style.paddingTop),
          paddingBottom: parseFloat(style.paddingBottom),
          labelHeight: labelBox ? Math.round(labelBox.height * 10) / 10 : null,
          valueHeight: valueBox ? Math.round(valueBox.height * 10) / 10 : null,
          hintHeight: hintBox ? Math.round(hintBox.height * 10) / 10 : null,
          hintTextHeight:
            hintBox && hintStyle
              ? Math.round((hintBox.height - hintPaddingTop) * 10) / 10
              : null,
          hintLineHeight: hintStyle
            ? parseFloat(hintStyle.lineHeight)
            : null,
          hintLineClamp: hintStyle?.webkitLineClamp ?? null,
          hintTextOverflow: hintStyle?.textOverflow ?? null,
          contentHeight:
            Math.round((contentBottom - contentTop) * 10) / 10,
          contentTop: Math.round(contentTop * 10) / 10,
          contentBottom: Math.round(contentBottom * 10) / 10,
          bottomGap: Math.round((box.bottom - contentBottom) * 10) / 10,
          topGap: Math.round((contentTop - box.top) * 10) / 10,
          valueText: (valueElement?.textContent ?? "").trim(),
          hintText: (hintElement?.textContent ?? "").trim(),
        };
      }),
    };
  }, selector);
}

/** 骨架 KPI 条的高度：应与加载完成后的真卡同高（server 视图）。 */
async function readKpiSkeleton(page) {
  return page.evaluate(() => {
    const cell = document.querySelector("[data-chain-kpi-skeleton]");
    const card = cell?.closest('[data-slot="card"]');
    if (!card) return null;
    const cells = [...card.querySelectorAll("[data-chain-kpi-skeleton]")];
    return {
      height: Math.round(card.getBoundingClientRect().height * 10) / 10,
      cells: cells.map(
        (element) =>
          Math.round(element.getBoundingClientRect().height * 10) / 10,
      ),
      rows: new Set(
        cells.map((element) =>
          Math.round(element.getBoundingClientRect().top),
        ),
      ).size,
    };
  });
}

function assertTopCards(top, theme, width) {
  if (!top) {
    errors.push(`top ${theme}/${width}: top cards missing`);
    return;
  }
  const expectColumns = width >= 640 ? 4 : 2;
  const expectRows = width >= 640 ? 1 : 2;
  if (top.count !== 4) {
    errors.push(`top ${theme}/${width}: ${top.count} cards, expected 4`);
  }
  if (top.columns !== expectColumns || top.rows !== expectRows) {
    errors.push(
      `top ${theme}/${width}: grid ${top.columns}×${top.rows}, expected ${expectColumns}×${expectRows}`,
    );
  }
  const labels = top.cards.map((card) => card.label);
  const expected = ["在线服务器", "用户与套餐", "转发链", "今日流量"];
  if (JSON.stringify(labels) !== JSON.stringify(expected)) {
    errors.push(
      `top ${theme}/${width}: labels ${JSON.stringify(labels)} != ${JSON.stringify(expected)}`,
    );
  }
  const merged = top.cards[1];
  if (merged?.label !== "用户与套餐") {
    errors.push(`top ${theme}/${width}: merged card label ${merged?.label}`);
  }
  if (top.merged.users !== "9" || top.merged.instances !== "7") {
    errors.push(
      `top ${theme}/${width}: merged numbers ${top.merged.users}/${top.merged.instances}`,
    );
  }
  if (merged?.value !== "9 用户 / 7 实例") {
    errors.push(`top ${theme}/${width}: merged value ${merged?.value}`);
  }
  if (merged?.hint !== "9 个用户 · 5 个套餐模板") {
    errors.push(`top ${theme}/${width}: merged hint ${merged?.hint}`);
  }
  if (top.chains.total !== "3") {
    errors.push(`top ${theme}/${width}: chain total ${top.chains.total}`);
  }
  if (top.cards[2]?.hint !== "阻断 1 · 降级 2") {
    errors.push(`top ${theme}/${width}: chain hint ${top.cards[2]?.hint}`);
  }
  if (top.globals !== 2) {
    errors.push(`top ${theme}/${width}: ${top.globals} global tags, expected 2`);
  }
  for (const card of top.cards) {
    if (card.scrollWidth > card.clientWidth + 1) {
      errors.push(
        `top ${theme}/${width}: ${card.label} overflows (${card.scrollWidth} > ${card.clientWidth})`,
      );
    }
  }
  if (top.documentOverflow > 0) {
    errors.push(`top ${theme}/${width}: document overflows by ${top.documentOverflow}px`);
  }
}

function assertKpi(kpi, view, theme, width) {
  if (!kpi) {
    errors.push(`${view}/${theme}/${width}: KPI missing`);
    return;
  }
  const expectColumns = width >= 640 ? 4 : 2;
  const expectRows = width >= 640 ? 1 : 2;
  if (kpi.gridColumns !== expectColumns) {
    errors.push(
      `${view}/${theme}/${width}: grid ${kpi.gridColumns} cols, expected ${expectColumns}`,
    );
  }
  if (kpi.rows !== expectRows) {
    errors.push(
      `${view}/${theme}/${width}: ${kpi.rows} KPI rows, expected ${expectRows}`,
    );
  }
  if (kpi.valueSize !== "28px") {
    errors.push(`${view}/${theme}/${width}: value ${kpi.valueSize}`);
  }
  if (kpi.hintSize !== "13px") {
    errors.push(`${view}/${theme}/${width}: hint ${kpi.hintSize}`);
  }
  if (kpi.labelSize !== "12px") {
    errors.push(`${view}/${theme}/${width}: label ${kpi.labelSize}`);
  }

  const rows = new Map();
  for (const [index, cell] of kpi.cellsDetail.entries()) {
    // 1. 不允许再靠 min-h 撑高度。
    if (cell.minHeight !== "0px" && cell.minHeight !== "auto") {
      errors.push(
        `${view}/${theme}/${width}[${index}]: min-height ${cell.minHeight}`,
      );
    }
    // 2. 底边只剩 padding：最后一行文字到卡片底边 ≈ padding-bottom。
    if (
      cell.bottomGap < cell.paddingBottom - 1 ||
      cell.bottomGap > cell.paddingBottom + 2
    ) {
      errors.push(
        `${view}/${theme}/${width}[${index}]: bottom gap ${cell.bottomGap}px vs padding ${cell.paddingBottom}px`,
      );
    }
    // 3. 副行必须单行（line-clamp-1），高度 = line-height。
    if (cell.hintLineClamp !== "1") {
      errors.push(
        `${view}/${theme}/${width}[${index}]: hint line-clamp ${cell.hintLineClamp}`,
      );
    }
    if (
      cell.hintTextHeight === null ||
      Math.abs(cell.hintTextHeight - cell.hintLineHeight) > 1
    ) {
      errors.push(
        `${view}/${theme}/${width}[${index}]: hint text ${cell.hintTextHeight}px vs line-height ${cell.hintLineHeight}px`,
      );
    }
    // 4. 横向不溢出。
    if (cell.scrollWidth > cell.clientWidth + 1) {
      errors.push(
        `${view}/${theme}/${width}[${index}]: horizontal overflow ${cell.scrollWidth} > ${cell.clientWidth}`,
      );
    }
    const row = rows.get(cell.top) ?? [];
    row.push({ cell, index });
    rows.set(cell.top, row);
  }

  // 5. 同行等高，且行高 = 行内最高的「内容 + padding」。
  for (const [top, row] of rows) {
    const heights = new Set(row.map(({ cell }) => cell.height));
    if (heights.size !== 1) {
      errors.push(
        `${view}/${theme}/${width}: row ${top} has unequal heights ${JSON.stringify([...heights])}`,
      );
    }
    const rowHeight = Math.max(...row.map(({ cell }) => cell.height));
    const maxNeeded = Math.max(
      ...row.map(
        ({ cell }) =>
          cell.contentHeight + cell.paddingTop + cell.paddingBottom,
      ),
    );
    if (rowHeight - maxNeeded > 2) {
      errors.push(
        `${view}/${theme}/${width}: row ${top} has ${Math.round((rowHeight - maxNeeded) * 10) / 10}px of blank`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 验收：KPI 卡作为入口 + 页头「更新于 HH:MM」
// ---------------------------------------------------------------------------

async function waitForOverviewReady(page) {
  await page.waitForSelector("[data-overview-kpis]", { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const value = document
        .querySelector("[data-kpi-chains-total]")
        ?.textContent?.trim();
      return Boolean(value) && value !== "—";
    },
    undefined,
    { timeout: 20000 },
  );
  await page.waitForTimeout(150);
}

const MODES = [
  { id: "abnormal", normal: false },
  { id: "normal", normal: true },
];

const EXPECTED = {
  abnormal: {
    // 6 台离线 / 1 条阻断 / 2 条降级。
    hrefs: [
      "/servers?only=abnormal",
      "/users",
      "/?view=chain&section=chains&status=blocked",
      "/?view=traffic",
    ],
    tones: ["destructive", "neutral", "destructive", "neutral"],
    serverHint: "6 台离线",
    chainHint: "阻断 1 · 降级 2",
  },
  normal: {
    // 全部在线 / 0 阻断 / 0 降级。
    hrefs: ["/?view=server", "/users", "/?view=chain&section=chains", "/?view=traffic"],
    tones: ["neutral", "neutral", "neutral", "neutral"],
    serverHint: "全部在线",
    chainHint: "阻断 0 · 降级 0",
  },
};

function check(condition, message) {
  if (!condition) errors.push(message);
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    errors.push(`${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

async function readEntries(page) {
  return page.evaluate(() => {
    const section = document.querySelector("[data-overview-kpis]");
    if (!section) return null;
    const read = (element) =>
      (element?.textContent ?? "").replace(/\s+/g, " ").trim();
    const links = [...section.querySelectorAll("[data-kpi-link]")];
    const cards = [...section.querySelectorAll("[data-kpi-card]")];
    return {
      links: links.map((link) => ({
        tag: link.tagName,
        href: link.getAttribute("href"),
      })),
      cards: cards.map((card) => {
        const hint = card.querySelector("[data-kpi-hint]");
        const icon = card.querySelector("[data-kpi-icon]");
        const iconStyle = icon ? getComputedStyle(icon) : null;
        return {
          label: read(card.querySelector("[data-kpi-label]")),
          value: read(card.querySelector("[data-kpi-value]")),
          hint: read(hint),
          tone: card.getAttribute("data-kpi-tone"),
          iconClass: icon?.className ?? "",
          iconBg: iconStyle?.backgroundColor ?? null,
          iconColor: iconStyle?.color ?? null,
          hintSpans: hint
            ? [...hint.querySelectorAll("span")].map((span) => ({
                text: read(span),
                className: span.className,
                color: getComputedStyle(span).color,
              }))
            : [],
        };
      }),
      globals: section.querySelectorAll("[data-kpi-global]").length,
      overflow: Math.max(
        0,
        document.documentElement.scrollWidth - window.innerWidth,
      ),
      header: (() => {
        const button = document.querySelector(
          '[data-slot="page-header"] button',
        );
        return button
          ? {
              text: read(button),
              ariaBusy: button.getAttribute("aria-busy"),
              disabled: button.disabled,
            }
          : null;
      })(),
      shellRefresh: (() => {
        const button = document.querySelector('header button[title="刷新"]');
        return button
          ? {
              title: button.getAttribute("title"),
              ariaLabel: button.getAttribute("aria-label"),
            }
          : null;
      })(),
    };
  });
}

function numericSpans(card) {
  return card.hintSpans.filter((span) => /^\d+$/.test(span.text));
}

function assertEntries(entries, mode, theme, width) {
  const tag = `${mode.id}/${theme}/${width}`;
  if (!entries) {
    errors.push(`${tag}: KPI entries missing`);
    return;
  }
  eq(entries.links.length, 4, `${tag} link count`);
  eq(entries.cards.length, 4, `${tag} card count`);
  for (let index = 0; index < 4; index += 1) {
    eq(entries.links[index].tag, "A", `${tag} card ${index} is a link`);
    eq(
      entries.links[index].href,
      EXPECTED[mode.id].hrefs[index],
      `${tag} card ${index} href`,
    );
    eq(
      entries.cards[index].tone,
      EXPECTED[mode.id].tones[index],
      `${tag} card ${index} tone`,
    );
  }
  eq(entries.globals, 2, `${tag} global tags`);
  eq(entries.overflow, 0, `${tag} document overflow`);
  eq(entries.cards[0].hint, EXPECTED[mode.id].serverHint, `${tag} server hint`);
  eq(entries.cards[2].hint, EXPECTED[mode.id].chainHint, `${tag} chain hint`);

  const header = entries.header;
  check(Boolean(header), `${tag} header refresh button missing`);
  if (header) {
    check(
      /^更新于 \d{2}:\d{2}$/.test(header.text),
      `${tag} header text ${JSON.stringify(header.text)}`,
    );
    check(!header.text.includes("刷新"), `${tag} old refresh label still shown`);
    eq(header.ariaBusy, "false", `${tag} idle aria-busy`);
    eq(header.disabled, false, `${tag} header button must not be disabled`);
  }
  check(Boolean(entries.shellRefresh), `${tag} shell refresh missing`);

  if (mode.normal) {
    for (const [index, card] of entries.cards.entries()) {
      check(
        card.iconClass.includes("bg-muted"),
        `${tag} card ${index} icon should be muted without anomalies`,
      );
      check(
        !/primary|destructive|warning/.test(card.iconClass),
        `${tag} card ${index} icon leaked a state colour`,
      );
    }
    eq(numericSpans(entries.cards[0]).length, 0, `${tag} offline count at 0`);
    const chainNumbers = numericSpans(entries.cards[2]);
    eq(chainNumbers.length, 2, `${tag} chain zero counts`);
    for (const number of chainNumbers) {
      check(
        number.className.includes("text-muted-foreground"),
        `${tag} zero chain count should stay muted (${number.className})`,
      );
    }
  } else {
    for (const index of [0, 2]) {
      check(
        entries.cards[index].iconClass.includes("bg-destructive/10"),
        `${tag} card ${index} icon should follow destructive`,
      );
      check(
        entries.cards[index].iconClass.includes("text-destructive"),
        `${tag} card ${index} icon colour should be destructive`,
      );
    }
    const offline = numericSpans(entries.cards[0]);
    eq(offline.length, 1, `${tag} offline count`);
    check(
      offline[0]?.className.includes("text-destructive"),
      `${tag} offline count should be destructive`,
    );
    const chainNumbers = numericSpans(entries.cards[2]);
    eq(chainNumbers.length, 2, `${tag} chain anomaly counts`);
    check(
      chainNumbers[0]?.className.includes("text-destructive"),
      `${tag} blocked count should be destructive`,
    );
    check(
      chainNumbers[1]?.className.includes("text-warning"),
      `${tag} degraded count should be warning`,
    );
  }
}

/** 逐卡点击，断言最终 pathname + search；键盘 Enter 额外验一次。 */
async function checkClickTargets(mode) {
  const theme = "dark";
  const width = 1440;
  const page = await openPage({
    theme,
    width,
    query: "view=server",
    normal: mode.normal,
    ignorePageErrors: true,
  });
  try {
    await waitForOverviewReady(page);
    for (let index = 0; index < 4; index += 1) {
      if (index > 0) {
        await page.goto(`${base}/?view=server`, {
          waitUntil: "domcontentloaded",
        });
        await waitForOverviewReady(page);
      }
      const expected = EXPECTED[mode.id].hrefs[index];
      await Promise.all([
        page.waitForURL(
          (url) => `${url.pathname}${url.search}` === expected,
          { timeout: 15000 },
        ),
        page.locator("[data-kpi-link]").nth(index).click(),
      ]);
      const actual = `${new URL(page.url()).pathname}${new URL(page.url()).search}`;
      eq(actual, expected, `click ${mode.id} card ${index}`);
      report.navigation[`${mode.id}-${index}`] = actual;
      await page.waitForTimeout(400);
      await page.screenshot({
        path: `${OUT}click-${mode.id}-${index}-${theme}-${width}.png`,
      });
    }

    // 键盘用户：聚焦「今日流量」卡按 Enter，和点击走同一个 Link。
    await page.goto(`${base}/?view=server`, { waitUntil: "domcontentloaded" });
    await waitForOverviewReady(page);
    const trafficCard = page.locator("[data-kpi-link]").nth(3);
    await trafficCard.focus();
    const focused = await trafficCard.evaluate(
      (element) => document.activeElement === element,
    );
    check(focused, `${mode.id}: traffic card is not focusable`);
    await Promise.all([
      page.waitForURL(
        (url) => `${url.pathname}${url.search}` === "/?view=traffic",
        { timeout: 15000 },
      ),
      page.keyboard.press("Enter"),
    ]);
    const keyboardUrl = `${new URL(page.url()).pathname}${new URL(page.url()).search}`;
    eq(keyboardUrl, "/?view=traffic", `${mode.id}: keyboard Enter target`);
    report.keyboard[`${mode.id}-enter`] = keyboardUrl;
  } finally {
    await page.close();
  }
}

/** 页头刷新：请求中 aria-busy + 不 disabled + 焦点不丢 + 连点只发一次。 */
async function checkRefresh(theme, width) {
  const requestLog = [];
  const page = await openPage({
    theme,
    width,
    query: "view=server",
    delayPath: "/api/v1/stats/overview",
    delayMs: 1200,
    requestLog,
  });
  try {
    await page.waitForFunction(
      () =>
        /^更新于 \d{2}:\d{2}$/.test(
          document
            .querySelector('[data-slot="page-header"] button')
            ?.textContent?.trim() ?? "",
        ),
      undefined,
      { timeout: 15000 },
    );
    const statsRequests = () =>
      requestLog.filter((path) => path === "/api/v1/stats/overview").length;
    const initialRequests = statsRequests();
    const header = page.locator('[data-slot="page-header"] button');
    const idle = await header.evaluate((button) => ({
      text: button.textContent.trim(),
      busy: button.getAttribute("aria-busy"),
      disabled: button.disabled,
    }));
    eq(idle.busy, "false", `refresh/${theme}/${width}: idle aria-busy`);
    eq(idle.disabled, false, `refresh/${theme}/${width}: idle disabled`);

    // 同一帧内连点两次；ref 防重入，应该只多一轮请求。
    const clicked = await page.evaluate(() => {
      const button = document.querySelector(
        '[data-slot="page-header"] button',
      );
      button.focus();
      button.click();
      button.click();
      return {
        focused: document.activeElement === button,
        disabled: button.disabled,
      };
    });
    check(clicked.focused, `refresh/${theme}/${width}: focus left the button`);
    eq(clicked.disabled, false, `refresh/${theme}/${width}: became disabled`);

    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-slot="page-header"] button')
          ?.getAttribute("aria-busy") === "true",
      undefined,
      { timeout: 5000 },
    );
    const busy = await header.evaluate((button) => ({
      busy: button.getAttribute("aria-busy"),
      disabled: button.disabled,
      focused: document.activeElement === button,
    }));
    eq(busy.busy, "true", `refresh/${theme}/${width}: busy aria-busy`);
    eq(busy.disabled, false, `refresh/${theme}/${width}: busy disabled`);
    check(busy.focused, `refresh/${theme}/${width}: focus left while busy`);
    await page
      .locator('[data-slot="page-header"]')
      .screenshot({ path: `${OUT}header-busy-${theme}-${width}.png` });

    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-slot="page-header"] button')
          ?.getAttribute("aria-busy") === "false",
      undefined,
      { timeout: 15000 },
    );
    await page.waitForTimeout(150);
    const afterRequests = statsRequests();
    eq(
      afterRequests - initialRequests,
      1,
      `refresh/${theme}/${width}: duplicate refresh requests`,
    );
    const settled = await header.evaluate((button) => ({
      text: button.textContent.trim(),
      busy: button.getAttribute("aria-busy"),
      disabled: button.disabled,
    }));
    check(
      /^更新于 \d{2}:\d{2}$/.test(settled.text),
      `refresh/${theme}/${width}: settled text ${JSON.stringify(settled.text)}`,
    );
    eq(settled.busy, "false", `refresh/${theme}/${width}: settled aria-busy`);
    eq(settled.disabled, false, `refresh/${theme}/${width}: settled disabled`);
    report.refresh[`${theme}-${width}`] = {
      initialRequests,
      afterRequests,
      idle,
      busy,
      settled,
    };
  } finally {
    await page.close();
  }
}

for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    for (const mode of MODES) {
      const page = await openPage({
        theme,
        width,
        query: "view=server",
        normal: mode.normal,
      });
      try {
        await page.waitForSelector("[data-overview-kpis]");
        await page.waitForTimeout(250);
        const entries = await readEntries(page);
        assertEntries(entries, mode, theme, width);
        report.top[`${mode.id}-${theme}-${width}`] = entries;

        await page.locator("[data-overview-kpis]").screenshot({
          path: `${OUT}cards-${mode.id}-${theme}-${width}.png`,
        });
        await page
          .locator('[data-slot="page-header"]')
          .screenshot({
            path: `${OUT}header-${mode.id}-${theme}-${width}.png`,
          });
        await page.screenshot({
          path: `${OUT}page-top-${mode.id}-${theme}-${width}.png`,
        });

        const chainCard = page
          .locator("[data-kpi-link]")
          .nth(2)
          .locator("[data-kpi-card]");
        const beforeHover = await chainCard.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        await page.locator("[data-kpi-link]").nth(2).hover();
        await page.waitForTimeout(220);
        const afterHover = await chainCard.evaluate(
          (element) => getComputedStyle(element).backgroundColor,
        );
        check(
          beforeHover !== afterHover,
          `${mode.id}/${theme}/${width}: hover has no feedback`,
        );
        report.hover[`${mode.id}-${theme}-${width}`] = {
          before: beforeHover,
          after: afterHover,
        };
        await page.locator("[data-overview-kpis]").screenshot({
          path: `${OUT}hover-${mode.id}-${theme}-${width}.png`,
        });
      } finally {
        await page.close();
      }
    }
  }
}

// 有异常 / 无异常两态的色彩必须真的不同（语义色不能只在 class 里）。
for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    const abnormal = report.top[`abnormal-${theme}-${width}`];
    const normal = report.top[`normal-${theme}-${width}`];
    if (!abnormal || !normal) continue;
    check(
      abnormal.cards[0].iconBg !== normal.cards[0].iconBg,
      `colors/${theme}/${width}: offline icon background not semantic`,
    );
    check(
      abnormal.cards[2].iconBg !== normal.cards[2].iconBg,
      `colors/${theme}/${width}: chain icon background not semantic`,
    );
    const abnormalOffline = numericSpans(abnormal.cards[0])[0]?.color;
    check(
      abnormalOffline !== undefined &&
        abnormalOffline !== numericSpans(normal.cards[2])[0]?.color,
      `colors/${theme}/${width}: anomaly numbers not coloured`,
    );
    report.colors[`${theme}-${width}`] = {
      abnormalOffline,
      normalMuted: normal.cards[0].hintSpans[0]?.color ?? null,
    };
  }
}

for (const mode of MODES) {
  await checkClickTargets(mode);
}
for (const theme of ["dark", "light"]) {
  for (const width of [1440, 390]) {
    await checkRefresh(theme, width);
  }
}

// 英文文案成对：页头「Updated HH:MM」、四卡标签与异常提示都要跟着语言走。
for (const mode of MODES) {
  const page = await openPage({
    theme: "dark",
    width: 1440,
    query: "view=server",
    normal: mode.normal,
    locale: "en",
  });
  try {
    await waitForOverviewReady(page);
    const entries = await readEntries(page);
    const expectedHeader = /^Updated \d{2}:\d{2}$/;
    check(
      expectedHeader.test(entries.header?.text ?? ""),
      `en/${mode.id}: header ${JSON.stringify(entries.header?.text)}`,
    );
    eq(
      entries.cards[0].hint,
      mode.normal ? "All online" : "6 offline",
      `en/${mode.id}: server hint`,
    );
    eq(
      entries.cards[2].hint,
      mode.normal ? "Blocked 0 · degraded 0" : "Blocked 1 · degraded 2",
      `en/${mode.id}: chain hint`,
    );
    report.i18n[`en-${mode.id}`] = {
      header: entries.header?.text,
      serverHint: entries.cards[0].hint,
      chainHint: entries.cards[2].hint,
    };
    await page.locator("[data-overview-kpis]").screenshot({
      path: `${OUT}cards-en-${mode.id}-dark-1440.png`,
    });
    await page
      .locator('[data-slot="page-header"]')
      .screenshot({ path: `${OUT}header-en-${mode.id}-dark-1440.png` });
  } finally {
    await page.close();
  }
}

await browser.close();
await new Promise((resolvePromise) => server.close(resolvePromise));

report.errors = errors;
writeFileSync(`${OUT}report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      shots: Object.keys(report.top).length,
      navigation: report.navigation,
      refresh: report.refresh,
      errors,
      report: `${OUT}report.json`,
    },
    null,
    2,
  ),
);
if (errors.length > 0) process.exitCode = 1;
