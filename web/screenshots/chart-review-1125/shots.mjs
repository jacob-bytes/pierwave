/**
 * 概览图表 review 修复的截图与实测 / Screenshots + measurements for the
 * overview chart review fixes.
 *
 * 覆盖 / Measures:
 * - 在线率趋势 x 轴：每天一个刻度、标签不重复（24h/168h 由单测覆盖）；
 * - 流量 / 协议 y 轴：1 / 2 / 2.5 / 5 × 10^n 的整齐步长 + 1024 进位标签；
 * - 网格线：横向点线（`--border` + 0.6 透明 + `2 4`），竖向只在链路趋势；
 * - tooltip 外壳：`bg-popover` / 12px 内边距 / 12px 正文 / 11px 次要 / tabular；
 * - 资源图 y 轴：负载默认指标下自动到 25%，0 基线保留；
 * - 链路趋势图例：无样本链默认折叠成「N 条暂无样本」。
 *
 * 运行 / Usage:
 *   cd web && npm run build
 *   node screenshots/chart-review-1125/shots.mjs
 *
 * 脚本用 Playwright 拦截 `/api/v1/**`，起一个只读的 dist 静态服务器，
 * 不需要主控、数据库或登录态。Playwright 走仓库内 npx 缓存（与既有截图脚本一致）。
 */
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const OUT = fileURLToPath(new URL(".", import.meta.url));
const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const HOUR = 3_600;
const NOW = Math.floor(Date.now() / 1_000);
const END = Math.floor(NOW / HOUR) * HOUR;
const START = END - 167 * HOUR;
const GB = 1024 ** 3;

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

/* ------------------------------------------------------------------ */
/* 假数据 / Fixtures                                                   */
/* ------------------------------------------------------------------ */

const SERVER_DEFS = [
  { id: "srv-hk-01", name: "香港-01", group: "香港", load: 0.42, mem: 0.58, disk: 0.71, offline: [120, 121, 122] },
  { id: "srv-hk-02", name: "香港-02", group: "香港", load: 0.31, mem: 0.44, disk: 0.62 },
  { id: "srv-tokyo-01", name: "东京-01", group: "日本", load: 0.55, mem: 0.63, disk: 0.88, degraded: [60, 61, 62, 63] },
  { id: "srv-tokyo-02", name: "东京-02", group: "日本", load: 0.24, mem: 0.37, disk: 0.55 },
  { id: "srv-sg-01", name: "新加坡-01", group: "东南亚", load: 0.38, mem: 0.51, disk: 0.67 },
  { id: "srv-fra-01", name: "法兰克福-01", group: "欧洲", load: 0.67, mem: 0.72, disk: 0.93 },
];

const SERVER_LIST = SERVER_DEFS.map((def, index) => ({
  id: def.id,
  name: def.name,
  address: `10.10.0.${index + 1}`,
  xray_mode: "auto",
  status: "online",
  group_name: def.group,
  last_seen_at: NOW - 30,
  config_version: 3,
  created_at: NOW - 30 * 86_400,
  agent_version: "0.16.2",
  allow_agent_upgrade: false,
  agent_target_version: null,
  xray_running: true,
  nginx_running: true,
  load1: def.load,
  mem_used: Math.round(def.mem * 8 * GB),
  mem_total: 8 * GB,
  disk_used: Math.round(def.disk * 80 * GB),
  disk_total: 80 * GB,
  uptime_secs: 86_400 * 20,
  latency_ms: 28,
  health_at: NOW - 30,
  arch: "x86_64",
  os_name: "Ubuntu",
  os_version: "24.04",
  virt: "kvm",
  country_code: "HK",
}));

function healthBody() {
  const servers = SERVER_DEFS.map((def, index) => {
    let samples = 0;
    let online = 0;
    const buckets = Array.from({ length: 168 }, (_, i) => {
      const ts = START + i * HOUR;
      const offlineHere = (def.offline ?? []).includes(i);
      const degradedHere = (def.degraded ?? []).includes(i);
      const wave = (Math.sin((i + index * 5) / 13) + 1) / 2;
      const ratio = offlineHere ? 0 : degradedHere ? 0.6 : 1;
      samples += 1;
      online += ratio;
      return {
        ts,
        online: !offlineHere,
        online_ratio: ratio,
        load1: Number((def.load * (0.7 + 0.8 * wave)).toFixed(2)),
        mem_ratio: Math.min(0.95, def.mem * (0.9 + 0.2 * wave)),
        disk_ratio: def.disk,
        samples: 12,
        outage_samples: offlineHere ? 12 : 0,
      };
    });
    return {
      id: def.id,
      name: def.name,
      online_ratio: samples > 0 ? online / samples : null,
      buckets,
    };
  });
  return {
    generated_at: NOW,
    hours: 168,
    bucket: HOUR,
    summary: {
      online_ratio_24h: 0.968,
      abnormal_servers: 2,
      worst_disk_ratio: 0.88,
    },
    servers,
  };
}

const DAYS = [
  "2026-11-16",
  "2026-11-17",
  "2026-11-18",
  "2026-11-19",
  "2026-11-20",
  "2026-11-21",
  "2026-11-22",
];
const UPLINK_GB = [5.2, 6.1, 5.8, 7.4, 6.2, 8.1, 5.9];
const DOWNLINK_GB = [32.4, 36.8, 29.5, 38.6, 33.1, 37.2, 27.9];

const TRAFFIC_DAYS = DAYS.map((date, index) => {
  const uplink = Math.round(UPLINK_GB[index] * 1000) / 1000 * GB;
  const downlink = Math.round(DOWNLINK_GB[index] * 1000) / 1000 * GB;
  return {
    date,
    uplink: Math.round(uplink),
    downlink: Math.round(downlink),
    weighted: Math.round(uplink + downlink),
  };
});

const PROTOCOL_SERIES = [
  // 与逐日下行同一量级：协议折线加起来 ≈ 当天总流量，截图里不会自相矛盾。
  { protocol: "vless", values: [32.4, 36.8, 29.5, 38.6, 33.1, 37.2, 27.9] },
  { protocol: "hysteria2", values: [2.4, 2.6, 2.2, 2.8, 2.5, 2.7, 2.1] },
  { protocol: "trojan", values: [0.8, 0.9, 0.7, 1, 0.8, 0.9, 0.7] },
].map((row) => ({
  protocol: row.protocol,
  days: DAYS.map((day, index) => ({
    day,
    bytes: Math.round(row.values[index] * 1000) / 1000 * GB,
  })),
}));

const AGGREGATE = {
  kpi: {
    servers_online: 6,
    servers_total: 6,
    nodes: 12,
    traffic_today: 32 * GB,
    traffic_month: 254 * GB,
    uptime_24h: 96.8,
  },
  series: TRAFFIC_DAYS.map((day) => ({
    day: day.date,
    uplink: day.uplink,
    downlink: day.downlink,
  })),
  protocol_series: PROTOCOL_SERIES,
  protocols: [
    { protocol: "vless", nodes: 7, traffic_7d: 92 * GB },
    { protocol: "hysteria2", nodes: 3, traffic_7d: 18 * GB },
    { protocol: "trojan", nodes: 2, traffic_7d: 5 * GB },
  ],
  chains: {
    total: 9,
    degraded: 1,
    blocked: 0,
    forwards_total: 8,
    forwards_failing: 0,
    handshake_failures: 0,
  },
  top: SERVER_DEFS.slice(0, 5).map((def, index) => ({
    kind: "server",
    server_id: def.id,
    name: def.name,
    traffic_7d: (index + 1) * 18 * GB,
    load1: def.load,
    online: true,
    rates: [],
  })),
  top_users: [
    { user_id: "u1", username: "alice", traffic_7d: 32 * GB },
    { user_id: "u2", username: "bob", traffic_7d: 21 * GB },
    { user_id: "u3", username: "carol", traffic_7d: 12 * GB },
  ],
  top_nodes: [
    { node_id: "n1", name: "HK-01 VLESS", protocol: "vless", server_name: "香港-01", traffic_7d: 24 * GB },
    { node_id: "n2", name: "JP-01 HY2", protocol: "hysteria2", server_name: "东京-01", traffic_7d: 18 * GB },
  ],
  package_split: [
    { package_id: "p1", name: "标准套餐", users: 4, traffic_7d: 62 * GB },
    { package_id: "p2", name: "高级套餐", users: 2, traffic_7d: 46 * GB },
  ],
  scope: {
    server_ids: [],
    servers_matched: 6,
    filtered: false,
    global: true,
  },
  warnings: { unknown_ids: [] },
};

const STATS = {
  servers: { total: 6, online: 6 },
  users: { total: 12, active: 10 },
  packages: { total: 4, instances: 5 },
  traffic: { today_bytes: 32 * GB, month_bytes: 254 * GB },
  alerts: {
    expired_instances: 0,
    exhausted_instances: 0,
    offline_servers: 0,
    expiring_certs: 0,
  },
};

const CHAIN_DEFS = [
  { id: "chain-hk-tokyo", name: "港日链路", sampled: true, from: "香港-01", to: "东京-01" },
  { id: "chain-hk-sg", name: "港新链路", sampled: true, from: "香港-02", to: "新加坡-01" },
  { id: "chain-tokyo-fra", name: "日欧链路", sampled: true, from: "东京-02", to: "法兰克福-01" },
  { id: "chain-hk-fra", name: "港欧链路", sampled: true, from: "香港-01", to: "法兰克福-01" },
  { id: "chain-sg-us", name: "新美链路", sampled: false, from: "新加坡-01", to: "洛杉矶-01" },
  { id: "chain-hk-osaka", name: "港阪链路", sampled: false, from: "香港-02", to: "大阪-01" },
  { id: "chain-tokyo-sg", name: "日新链路", sampled: false, from: "东京-01", to: "新加坡-01" },
  { id: "chain-fra-us", name: "欧美链路", sampled: false, from: "法兰克福-01", to: "纽约-01" },
  { id: "chain-sg-fra", name: "新欧链路", sampled: false, from: "新加坡-01", to: "法兰克福-01" },
];

const SERIES_LENGTH = 96;
const SERIES_START = END - 24 * HOUR;

function chainSeries(seed) {
  return Array.from({ length: SERIES_LENGTH }, (_, i) => {
    const p50 = 22 + seed * 5 + Math.sin((i + seed * 3) / 7) * 5;
    return {
      ts: SERIES_START + i * 900,
      p50: Number(p50.toFixed(1)),
      p10: Number((p50 * 0.86).toFixed(1)),
      p90: Number((p50 * 1.22).toFixed(1)),
      samples: 4,
      loss_pct: i % 23 === 0 ? 2.4 : 0,
    };
  });
}

function segmentSeries(seed, seq, base) {
  return Array.from({ length: SERIES_LENGTH }, (_, i) => {
    const p50 = base + seed * 2 + Math.sin((i + seq * 5) / 9) * 3;
    return {
      ts: SERIES_START + i * 900,
      p50: Number(Math.max(1, p50).toFixed(1)),
      p10: Number(Math.max(0.5, p50 * 0.8).toFixed(1)),
      p90: Number((p50 * 1.3).toFixed(1)),
      samples: 4,
      loss_pct: i % 31 === 0 ? 1.8 : 0,
    };
  });
}

function chainHealthChain(def, index) {
  const base = 22 + (index % 4) * 5;
  const segments = def.sampled
    ? [
        {
          seq: 1,
          from: def.from,
          to: def.to,
          p50: Number((base + 4).toFixed(1)),
          delta_ms: 1.4,
          contribution_pct: 72,
          attempts: SERIES_LENGTH,
          failures: 1,
          loss_pct: 0.9,
          series: segmentSeries(index, 1, base + 4),
        },
        {
          seq: 2,
          from: def.to,
          to: "10.0.0.8",
          p50: Number((base - 14).toFixed(1)),
          delta_ms: 0.4,
          contribution_pct: 28,
          attempts: SERIES_LENGTH,
          failures: 0,
          loss_pct: 0,
          series: segmentSeries(index, 2, base - 14),
        },
      ]
    : [];
  return {
    id: def.id,
    name: def.name,
    hops: 2,
    missing_hops: [],
    estimated: false,
    status: { kind: def.sampled ? "ok" : "unknown", cause: null, node: null },
    last_hop: { measurable: true, reason: null },
    entry: {
      server_id: def.sampled ? SERVER_DEFS[index % 4].id : null,
      server_name: def.from,
      address: `203.0.113.${20 + index}`,
      ip: `203.0.113.${20 + index}`,
      port: 443,
      address_source: null,
    },
    exit: {
      server_id: def.sampled ? SERVER_DEFS[(index + 1) % 4].id : null,
      server_name: def.to,
      address: "198.51.100.20",
      ip: "198.51.100.20",
      port: 443,
      address_source: null,
    },
    nodes: [
      { seq: 0, server_id: SERVER_DEFS[index % 4].id, name: def.from, role: "source", status: "online", members: [] },
      { seq: 1, server_id: SERVER_DEFS[(index + 1) % 4].id, name: def.to, role: "hop", status: "online", members: [] },
      { seq: 2, server_id: null, name: "example.com", role: "target", status: null, members: [] },
    ],
    series: def.sampled ? chainSeries(index) : [],
    segments,
    diagnosis: def.sampled ? { kind: "single_hop", seq: 1 } : { kind: "unknown" },
    loss_pct: def.sampled ? 0.9 : null,
    loss_partial: false,
    loss_samples: def.sampled ? { attempts: SERIES_LENGTH * 2, failures: 1 } : null,
  };
}

function chainHealthBody() {
  return {
    generated_at: NOW,
    hours: 24,
    bucket: 900,
    summary: {
      hop_p50_ms: 26.4,
      delta_ms: 2.1,
      slow_chains: 1,
      total_chains: 9,
      worst_hop: { chain_id: "chain-hk-fra", chain_name: "港欧链路", seq: 1, p50_ms: 38.2 },
      loss_pct: 1.1,
      worst_loss: { chain_id: "chain-hk-fra", chain_name: "港欧链路", loss_pct: 2.4 },
    },
    chains: CHAIN_DEFS.map(chainHealthChain),
    scope: { server_ids: [], servers_matched: 6, filtered: false, global: true },
    warnings: { unknown_ids: [] },
  };
}

const CHAIN_ITEMS = CHAIN_DEFS.map((def, index) => ({
  id: def.id,
  name: def.name,
  target_host: "example.com",
  target_port: 443,
  enabled: true,
  engine: "realm",
  protocol: "tcp",
  udp: false,
  transport: "tls",
  degraded: def.sampled ? index === 3 : false,
  blocked_reason: null,
  created_at: NOW - 10 * 86_400,
  updated_at: NOW - HOUR,
}));

function latencyPoints(chainId) {
  const def = CHAIN_DEFS.find((item) => item.id === chainId);
  if (!def || !def.sampled) return [];
  const base = 22 + (CHAIN_DEFS.indexOf(def) % 4) * 5;
  const points = [];
  for (let i = 0; i < SERIES_LENGTH; i += 1) {
    const ts = SERIES_START + i * 900;
    points.push({ ts, seq: 1, server_id: "srv-hk-01", latency_ms: Number((base + 4 + Math.sin(i / 9) * 3).toFixed(1)) });
    points.push({ ts, seq: 2, server_id: "srv-tokyo-01", latency_ms: Number((base - 14 + Math.sin(i / 11) * 2).toFixed(1)) });
  }
  return points;
}

/* ------------------------------------------------------------------ */
/* 静态服务 + API 拦截                                                 */
/* ------------------------------------------------------------------ */

function json(route, body, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
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
    return json(route, { status: "ok", version: "0.16.2", panel_name: "PierWave" });
  }
  if (path === "/api/v1/overview/server-health") return json(route, healthBody());
  if (path === "/api/v1/overview/chain-health") return json(route, chainHealthBody());
  if (path === "/api/v1/overview") return json(route, AGGREGATE);
  if (path === "/api/v1/stats/overview") return json(route, STATS);
  if (path === "/api/v1/stats/traffic") return json(route, { days: TRAFFIC_DAYS });
  if (path === "/api/v1/servers") return json(route, { items: SERVER_LIST });
  if (path === "/api/v1/chains") return json(route, { items: CHAIN_ITEMS });
  if (path === "/api/v1/enforcement/events") return json(route, { items: [] });
  const latency = /^\/api\/v1\/chains\/([^/]+)\/latency$/.exec(path);
  if (latency) {
    return json(route, { points: latencyPoints(decodeURIComponent(latency[1])) });
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
      agents: { current_protocol: 1, min_supported: 1, versions: [{ version: "0.16.2", count: 6 }] },
    });
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
    server.listen(0, "127.0.0.1", () => resolvePromise({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ */
/* 采集 / Measurements                                                 */
/* ------------------------------------------------------------------ */

const report = {
  generatedAt: new Date().toISOString(),
  shots: [],
  charts: [],
  tooltips: [],
  legends: [],
  overflow: [],
  errors: [],
};

function unique(values) {
  return new Set(values).size === values.length;
}

async function chartMetrics(page, rootSelector) {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return null;
    const texts = (inner) =>
      [...root.querySelectorAll(inner)]
        .map((node) => (node.textContent ?? "").trim())
        .filter(Boolean);
    const grid = [...root.querySelectorAll(".recharts-cartesian-grid line")].map((line) => ({
      dash: line.getAttribute("stroke-dasharray"),
      stroke: line.getAttribute("stroke"),
      opacity: line.getAttribute("stroke-opacity"),
      vertical: line.getAttribute("x1") === line.getAttribute("x2"),
    }));
    const box = root.getBoundingClientRect();
    return {
      // recharts 3.10 把刻度文本放在独立的 z-index 层，不在 `.recharts-xAxis` 的 <g> 里。
      xTicks: texts(".recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value"),
      yTicks: texts(".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value"),
      grid,
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
  }, rootSelector);
}

async function tooltipComputed(page, selector) {
  return page.evaluate((inner) => {
    const node = document.querySelector(inner);
    if (!node) return null;
    const style = getComputedStyle(node);
    return {
      background: style.backgroundColor,
      border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
      radius: style.borderTopLeftRadius,
      padding: [
        style.paddingTop,
        style.paddingRight,
        style.paddingBottom,
        style.paddingLeft,
      ].join(" "),
      fontSize: style.fontSize,
      boxShadow: style.boxShadow,
      fontVariantNumeric: style.fontVariantNumeric,
      text: (node.innerText ?? "").split("\n").map((line) => line.trim()).filter(Boolean),
    };
  }, selector);
}

async function pageOverflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
}

async function shot(page, locator, file, keepPointer = false) {
  // 静态截图先把指针移开，避免上一张图的 hover 把 tooltip 带进来；
  // 交互特写传 keepPointer=true，保留刚触发的 tooltip。
  if (!keepPointer) await page.mouse.move(2, 2);
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(260);
  await locator.screenshot({ path: join(OUT, file) });
  report.shots.push(file);
}

async function measure(page, id, rootSelector) {
  const metrics = await chartMetrics(page, rootSelector);
  if (!metrics) {
    report.errors.push(`${id}: missing ${rootSelector}`);
    return null;
  }
  const entry = { id, ...metrics, xTicksUnique: unique(metrics.xTicks) };
  report.charts.push(entry);
  return entry;
}

async function hoverChart(page, wrapperSelector) {
  const wrapper = page.locator(wrapperSelector).first();
  await wrapper.scrollIntoViewIfNeeded();
  const box = await wrapper.boundingBox();
  if (!box) throw new Error(`no box for ${wrapperSelector}`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.move(x + 2, y + 1);
}

/* ------------------------------------------------------------------ */
/* 页面 / Page helpers                                                 */
/* ------------------------------------------------------------------ */

const { server: staticServer, port } = await startStaticServer();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function newPage(theme, width) {
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 844 : 1_000 },
    deviceScaleFactor: 1,
  });
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => report.errors.push(`pageerror: ${error.message}`));
  await page.addInitScript(
    ({ theme, locale }) => {
      try {
        localStorage.setItem("pierwave.theme", theme);
        localStorage.setItem("pierwave.locale", locale);
      } catch {
        // ignore
      }
    },
    { theme, locale: "zh-CN" },
  );
  await page.route("**/api/v1/**", (route) => handleApi(route));
  return page;
}

async function gotoView(page, query) {
  await page.goto(`${base}/?${query}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-overview-insight-section]", { timeout: 20_000 });
}

async function serverView(page) {
  await gotoView(page, "view=server");
  await page.waitForSelector("[data-uptime-trend] .recharts-wrapper", { timeout: 20_000 });
  await page.waitForSelector("[data-resource-chart] .recharts-wrapper", { timeout: 20_000 });
}

async function trafficView(page) {
  await gotoView(page, "view=traffic");
  await page.waitForSelector("[data-traffic-chart] .recharts-wrapper", { timeout: 20_000 });
}

async function chainView(page) {
  await gotoView(page, "view=chain");
  await page.waitForSelector("[data-chain-trend-legend]", { timeout: 20_000 });
}

function cardOf(locator) {
  return locator.locator('xpath=ancestor::*[@data-slot="card"][1]');
}

/** 流量趋势卡片：切 tab 后总流量图会卸载，只能从页面锚定。 */
function trafficCard(page) {
  return page
    .locator('[data-slot="card"]')
    .filter({ hasText: "近 7 天趋势" })
    .first();
}

const MATRIX = [
  ["dark", 1440],
  ["light", 1440],
  ["dark", 390],
  ["light", 390],
];

for (const [theme, width] of MATRIX) {
  const suffix = `${theme}-${width}`;
  const page = await newPage(theme, width);

  /* 资源状态：在线率趋势 + 当前资源（负载默认指标） */
  await serverView(page);
  await shot(page, cardOf(page.locator("[data-uptime-trend]")), `uptime-${suffix}.png`);
  await measure(page, `uptime-${suffix}`, "[data-uptime-trend]");
  await shot(page, page.locator("[data-resource-card]"), `resource-load-${suffix}.png`);
  await measure(page, `resource-load-${suffix}`, "[data-resource-chart]");
  report.overflow.push({ page: `server-${suffix}`, ...(await pageOverflow(page)) });

  /* 流量趋势：总流量 + 协议 */
  await trafficView(page);
  // 切到协议 tab 后总流量图会卸载，所以卡片定位必须锚在页面上，不能锚在图上。
  const trendCard = trafficCard(page);
  await shot(page, trendCard, `traffic-${suffix}.png`);
  await measure(page, `traffic-${suffix}`, "[data-traffic-chart]");
  await trendCard.getByRole("tab", { name: "协议", exact: true }).click();
  await page.waitForSelector("[data-protocol-trend-chart] .recharts-line", { timeout: 20_000 });
  await shot(page, trendCard, `protocol-${suffix}.png`);
  await measure(page, `protocol-${suffix}`, "[data-protocol-trend-chart]");
  report.overflow.push({ page: `traffic-${suffix}`, ...(await pageOverflow(page)) });

  /* 链路时延：趋势图例折叠 */
  await chainView(page);
  await shot(page, page.locator("[data-chain-trend-card]"), `chain-trend-${suffix}.png`);
  await measure(page, `chain-trend-${suffix}`, "[data-chain-trend-chart]");
  const defaultLegend = await page.evaluate(() => {
    const legend = document.querySelector("[data-chain-trend-legend]");
    const toggle = document.querySelector("[data-chain-legend-unsampled-toggle]");
    return {
      sampledItems: legend ? legend.querySelectorAll("[data-chain-legend-item]").length : 0,
      toggleText: toggle ? (toggle.textContent ?? "").trim() : null,
      toggleExpanded: toggle ? toggle.getAttribute("aria-expanded") : null,
      listedItems: document.querySelectorAll("[data-chain-legend-unsampled-item]").length,
    };
  });
  report.legends.push({ id: `chain-trend-${suffix}`, ...defaultLegend });
  report.overflow.push({ page: `chain-${suffix}`, ...(await pageOverflow(page)) });

  await page.close();
}

/* ------------------------------------------------------------------ */
/* 交互特写 / Interaction close-ups                                    */
/* ------------------------------------------------------------------ */

async function interactionRun(theme, width) {
  const suffix = `${theme}-${width}`;
  const page = await newPage(theme, width);

  /* tooltip：在线率 / 资源 */
  await serverView(page);
  await hoverChart(page, "[data-uptime-trend] .recharts-wrapper");
  await page.waitForSelector("[data-uptime-tooltip]", { timeout: 10_000 });
  await shot(page, cardOf(page.locator("[data-uptime-trend]")), `tooltip-uptime-${suffix}.png`, true);
  report.tooltips.push({ id: `uptime-${suffix}`, ...(await tooltipComputed(page, "[data-uptime-tooltip]")) });

  await hoverChart(page, "[data-resource-chart] .recharts-wrapper");
  await page.waitForSelector("[data-resource-tooltip]", { timeout: 10_000 });
  await shot(page, page.locator("[data-resource-card]"), `tooltip-resource-${suffix}.png`, true);
  report.tooltips.push({ id: `resource-${suffix}`, ...(await tooltipComputed(page, "[data-resource-tooltip]")) });

  /* tooltip：流量 / 协议 */
  await trafficView(page);
  const trendCard = trafficCard(page);
  const bars = page.locator("[data-traffic-chart] .recharts-bar-rectangle");
  await bars.nth(3).hover();
  await page.waitForSelector("[data-traffic-tooltip]", { timeout: 10_000 });
  await shot(page, trendCard, `tooltip-traffic-${suffix}.png`, true);
  report.tooltips.push({ id: `traffic-${suffix}`, ...(await tooltipComputed(page, "[data-traffic-tooltip]")) });

  await trendCard.getByRole("tab", { name: "协议", exact: true }).click();
  await page.waitForSelector("[data-protocol-trend-chart] .recharts-line", { timeout: 20_000 });
  await hoverChart(page, "[data-protocol-trend-chart] .recharts-wrapper");
  await page.waitForSelector("[data-protocol-tooltip]", { timeout: 10_000 });
  await shot(page, trendCard, `tooltip-protocol-${suffix}.png`, true);
  report.tooltips.push({ id: `protocol-${suffix}`, ...(await tooltipComputed(page, "[data-protocol-tooltip]")) });

  /* 图例：默认收起 → 展开 */
  await chainView(page);
  const chainCard = page.locator("[data-chain-trend-card]");
  await page.locator("[data-chain-legend-unsampled-toggle]").click();
  await page.waitForSelector("[data-chain-legend-unsampled-list]", { timeout: 10_000 });
  await shot(page, chainCard, `chain-legend-expanded-${suffix}.png`);
  const expandedLegend = await page.evaluate(() => ({
    sampledItems: document.querySelectorAll("[data-chain-trend-legend] [data-chain-legend-item]").length,
    toggleExpanded: document
      .querySelector("[data-chain-legend-unsampled-toggle]")
      ?.getAttribute("aria-expanded"),
    listedItems: document.querySelectorAll("[data-chain-legend-unsampled-item]").length,
  }));
  report.legends.push({ id: `chain-trend-expanded-${suffix}`, ...expandedLegend });

  await hoverChart(page, "[data-chain-trend-chart] .recharts-wrapper");
  await page.waitForSelector("[data-chain-trend-tooltip]", { timeout: 10_000 });
  await shot(page, chainCard, `tooltip-chain-trend-${suffix}.png`, true);
  report.tooltips.push({ id: `chain-${suffix}`, ...(await tooltipComputed(page, "[data-chain-trend-tooltip]")) });

  /* 逐段图 + 整体迷你图的 tooltip：从深链接打开详情弹窗 */
  await gotoView(page, "view=chain&chain=chain-hk-tokyo");
  await page.waitForSelector('[role="dialog"]', { timeout: 20_000 });
  await page.waitForSelector("[data-chain-segment-chart] .recharts-wrapper", { timeout: 20_000 });
  const dialog = page.locator('[role="dialog"]');
  await hoverChart(page, "[data-chain-segment-chart] .recharts-wrapper");
  await page.waitForSelector("[data-segment-tooltip]", { timeout: 10_000 });
  await shot(page, dialog, `tooltip-segment-${suffix}.png`, true);
  report.tooltips.push({ id: `segment-${suffix}`, ...(await tooltipComputed(page, "[data-segment-tooltip]")) });

  const sparkline = page.locator("[data-chain-sparkline]").first();
  const sparkBox = await sparkline.boundingBox();
  if (sparkBox) {
    await page.mouse.move(sparkBox.x + sparkBox.width * 0.6, sparkBox.y + sparkBox.height / 2);
  }
  await page.waitForSelector("[data-chain-sparkline-tooltip]", { timeout: 10_000 });
  await shot(page, dialog, `tooltip-sparkline-${suffix}.png`, true);
  report.tooltips.push({ id: `sparkline-${suffix}`, ...(await tooltipComputed(page, "[data-chain-sparkline-tooltip]")) });

  report.overflow.push({ page: `dialog-${suffix}`, ...(await pageOverflow(page)) });
  await page.close();
}

await interactionRun("dark", 1440);
await interactionRun("dark", 390);

await browser.close();
staticServer.close();

/* ------------------------------------------------------------------ */
/* 结论 / Assertions                                                   */
/* ------------------------------------------------------------------ */

const failures = [];
for (const chart of report.charts) {
  if (!chart.xTicksUnique) failures.push(`${chart.id}: duplicate x tick labels ${chart.xTicks.join(",")}`);
  for (const line of chart.grid) {
    if (line.dash !== "2 4") failures.push(`${chart.id}: grid dash ${line.dash}`);
    if (line.stroke !== "var(--border)") failures.push(`${chart.id}: grid stroke ${line.stroke}`);
    if (line.opacity !== "0.6") failures.push(`${chart.id}: grid opacity ${line.opacity}`);
  }
}
for (const entry of report.tooltips) {
  if (!entry) {
    failures.push("tooltip: missing shell");
    continue;
  }
  if (entry.padding !== "12px 12px 12px 12px") failures.push(`${entry.id}: tooltip padding ${entry.padding}`);
  if (entry.fontSize !== "12px") failures.push(`${entry.id}: tooltip font-size ${entry.fontSize}`);
  if (entry.fontVariantNumeric !== "tabular-nums") failures.push(`${entry.id}: tooltip tabular ${entry.fontVariantNumeric}`);
}
for (const row of report.overflow) {
  if (row.overflow) failures.push(`${row.page}: horizontal overflow ${row.scrollWidth} > ${row.innerWidth}`);
}
report.assertions = { passed: failures.length === 0, failures };

writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`shots: ${report.shots.length}`);
console.log(`charts: ${report.charts.length}`);
if (failures.length > 0) {
  console.error(`FAIL\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("assertions: all passed");
}
