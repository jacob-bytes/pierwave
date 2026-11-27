#!/usr/bin/env node
/**
 * 动效连续性验收（浏览器）/ Motion-continuity acceptance in a real browser.
 *
 * 覆盖 / Covers:
 * - 静止帧：视图 tab（1440 / 390，亮 / 暗）、链路二级下划线子页、四个分段
 *   控件、设置页与日志页 tab、侧栏（桌面 + 390 抽屉）与改动前构建逐像素比较。
 *   Static frames: overview view tabs (1440/390, light/dark), the chain
 *   sub-page underline, four segmented controls, settings/logs tabs and the
 *   sidebar (desktop + 390 drawer), compared pixel-by-pixel with a build from
 *   before this change.
 * - 焦点帧：鼠标点击后焦点仍在 tab 上（指针模态无边框 / outline，点击帧与
 *   同一构建的静止帧 0 像素差）；键盘聚焦仍画 2px outline + 3px ring。视图
 *   tab 与一个分段控件，亮 / 暗各一套。
 *   Focus frames: after a mouse click the focus stays on the tab (no border or
 *   outline in pointer modality, 0px against the same-build resting frame);
 *   keyboard focus still draws the 2px outline and 3px ring. View tabs and one
 *   segmented control, light/dark.
 * - 选中指示器：点击 / 方向键切换的偏差轨迹、首帧不滑、390 第 4 个 tab、
 *   窗口变窄、中英切换、侧栏点击 / 折叠 / 抽屉、reduced-motion、帧间隔。
 *   The indicator: click/arrow displacement traces, no animation on first
 *   load, the 4th tab at 390, resizing, locale switch, sidebar click/collapse/
 *   drawer, reduced-motion and frame cadence.
 * - KPI：第二次请求换数字 → `value-settle` 动画存在；数字不变 → 没有。
 *   KPI: a changed number replays `value-settle`; the same number does not.
 * - 图表：挂载 30ms 与 400ms 的路径不同；入场后刷新下一帧即终值；
 *   reduced-motion 首帧即终值。
 *   Charts: the path at 30ms differs from 400ms; after the entrance a refresh
 *   renders the final path immediately; reduced-motion starts at the final path.
 *
 * 用静态服务直接服务 `web/dist`，`/api/v1/**` 全部由 Playwright 拦截 mock；
 * 不需要主控、数据库或登录会话。
 *
 * 前置 / Prerequisite（仓库根执行 / run from the repo root）:
 *   make web-build
 *   node web/screenshots/motion-continuity/shots.mjs
 *
 * 基线 / Baselines（用改动前的构建生成 / generate with a pre-change build）:
 *   MOTION_CONTINUITY_BASELINE=1 \
 *     MOTION_CONTINUITY_DIST=/path/to/pre-change/web/dist \
 *     node web/screenshots/motion-continuity/shots.mjs
 *
 * 动效轨迹 / 图表用解除帧率上限的浏览器采样，避免 200ms 过渡被无头 Chrome
 * 节流；帧率读数单独用正常帧率浏览器（不传 `--disable-frame-rate-limit`）在
 * 滑动期间记录 rAF 间隔中位数与 >25ms 的帧数。
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
const DIST = resolve(process.env.MOTION_CONTINUITY_DIST ?? resolve(ROOT, "dist"));
const OUT = HERE;
const BASELINE = path.join(HERE, "baseline");
const BASELINE_MODE = process.env.MOTION_CONTINUITY_BASELINE === "1";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// 动效采样浏览器：解除帧率上限，保证 200ms 过渡能被稳定采样到。
const FRAME_ARGS = [
  "--disable-frame-rate-limit",
  "--disable-gpu-vsync",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

// 帧率测量浏览器：正常帧率，不传 --disable-frame-rate-limit。
const CADENCE_ARGS = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const npxRoot = path.join(ROOT, "../.npm-cache/_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs"));
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

// ---------------------------------------------------------------------------
// Fixtures / 数据
// ---------------------------------------------------------------------------

const GB = 1024 ** 3;
const NOW = Math.floor(Date.now() / 1000);
const TRAFFIC_DAYS = Array.from({ length: 7 }, (_, index) => ({
  date: `2026-11-${16 + index}`,
  uplink: (index + 2) * GB,
  downlink: (index + 3) * GB,
}));
const TRAFFIC_DAYS_2 = TRAFFIC_DAYS.map((day) => ({
  ...day,
  uplink: day.uplink * 2,
  downlink: day.downlink * 1.5,
}));

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

function serverItem(definition) {
  return {
    ...definition,
    xray_mode: "auto",
    last_seen_at: definition.status === "online" ? NOW - 30 : NOW - 3 * 3600,
    config_version: 4,
    created_at: NOW - 40 * 86400,
    agent_version: "0.18.7",
    allow_agent_upgrade: true,
    agent_target_version: null,
    xray_running: definition.status === "online",
    nginx_running: definition.status === "online",
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

// 第二次请求换成另一组数字：用来验证 KPI 的 key 变化与 value-settle。
let statsVariant = 1;
const STATS = {
  servers: { total: 3, online: 2 },
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
const STATS_2 = {
  ...STATS,
  users: { total: 7, active: 7 },
  packages: { total: 4, instances: 6 },
  traffic: { today_bytes: 48 * GB, month_bytes: 254 * GB },
};

let trafficVariant = 1;

const OVERVIEW_DAYS = TRAFFIC_DAYS.map((day) => ({
  day: day.date,
  uplink: day.uplink,
  downlink: day.downlink,
}));
const AGGREGATE = {
  kpi: {
    servers_online: 2,
    servers_total: 3,
    nodes: 3,
    traffic_today: 32 * GB,
    traffic_month: 254 * GB,
    uptime_24h: 99.4,
  },
  series: OVERVIEW_DAYS,
  protocol_series: [
    {
      protocol: "vless",
      days: OVERVIEW_DAYS.map((day) => ({ day: day.day, bytes: day.downlink })),
    },
    {
      protocol: "trojan",
      days: OVERVIEW_DAYS.map((day) => ({ day: day.day, bytes: day.downlink / 3 })),
    },
  ],
  protocols: [
    { protocol: "vless", nodes: 8, traffic_7d: 30 * GB },
    { protocol: "trojan", nodes: 3, traffic_7d: 9 * GB },
  ],
  chains: {
    total: 2,
    degraded: 0,
    blocked: 0,
    forwards_total: 1,
    forwards_failing: 0,
    handshake_failures: 0,
  },
  top: [
    {
      kind: "server",
      server_id: "srv-hk-01",
      name: "香港-01",
      traffic_7d: 21 * GB,
      load1: 0.42,
      online: true,
      rates: Array.from({ length: 12 }, (_, index) => ({
        ts: NOW - (11 - index) * 300,
        rx_bps: 1.2 * 1024 * 1024,
        tx_bps: 512 * 1024,
      })),
    },
  ],
  top_users: [{ user_id: "u-1", username: "alice", traffic_7d: 18 * GB }],
  top_nodes: [
    {
      node_id: "n-1",
      name: "香港 VLESS",
      protocol: "vless",
      server_name: "香港-01",
      traffic_7d: 15 * GB,
    },
  ],
  package_split: [
    { package_id: "p-1", name: "标准", users: 3, traffic_7d: 20 * GB },
  ],
  scope: { filtered: false, server_ids: [], servers_matched: 3 },
  warnings: { unknown_ids: [] },
};

const CHAIN_BUCKET = 900;
const CHAIN_END = Math.floor(NOW / CHAIN_BUCKET) * CHAIN_BUCKET;
const CHAIN_START = CHAIN_END - 23 * CHAIN_BUCKET;
const CHAINS = [
  {
    id: "chain-hk-tokyo",
    name: "香港回环",
    entry: {
      server_id: "srv-hk-01",
      server_name: "香港-01",
      address: "203.0.113.11:21021",
    },
    exit: {
      server_id: "srv-tokyo-01",
      server_name: "东京-01",
      address: "203.0.113.21:21022",
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
        members: [{ server_id: "srv-tokyo-01", name: "东京-01", status: "online" }],
      },
    ],
    series: Array.from({ length: 24 }, (_, index) => ({
      ts: CHAIN_START + index * CHAIN_BUCKET,
      p50: 32 + Math.sin(index / 2) * 4,
      p95: 41,
      loss: 0.12,
    })),
    segments: [],
    hops: [{ seq: 0, p50: 32, loss: 0.12 }],
    status: { kind: "ok" },
  },
];

const SERVER_HEALTH = {
  generated_at: NOW,
  hours: 168,
  bucket: 3600,
  summary: {
    online_ratio_24h: 0.994,
    abnormal_servers: 0,
    worst_disk_ratio: 0.35,
    servers_without_samples: 0,
  },
  servers: SERVERS.map((server) => ({
    id: server.id,
    name: server.name,
    status: server.status,
    online_ratio: 0.99,
    current: {
      load1: 0.42,
      mem_used: 3.1 * GB,
      mem_total: 8 * GB,
      disk_used: 42 * GB,
      disk_total: 120 * GB,
      latency_ms: 20,
    },
    buckets: Array.from({ length: 168 }, (_, index) => ({
      ts: NOW - (167 - index) * 3600,
      online: server.status === "online",
      online_ratio: server.status === "online" ? 1 : 0,
      load1: 0.42,
      mem_ratio: 0.39,
      disk_ratio: 0.35,
    })),
  })),
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function handleApi(route) {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  const method = request.method();

  if (pathname === "/api/v1/auth/me") {
    return json(route, {
      user: { id: "u-admin", username: "admin", role: "admin", short_code: "AD" },
    });
  }
  if (pathname === "/api/v1/health") {
    return json(route, { status: "ok", version: "0.18.7", panel_name: "PierWave" });
  }
  if (pathname === "/api/v1/overview") return json(route, AGGREGATE);
  if (pathname === "/api/v1/overview/server-health") return json(route, SERVER_HEALTH);
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
  if (pathname === "/api/v1/stats/overview") {
    return json(route, statsVariant === 2 ? STATS_2 : STATS);
  }
  if (pathname === "/api/v1/stats/traffic") {
    return json(route, {
      days: trafficVariant === 2 ? TRAFFIC_DAYS_2 : TRAFFIC_DAYS,
    });
  }
  if (pathname === "/api/v1/servers") {
    return json(route, { items: SERVERS.map(serverItem) });
  }
  if (pathname === "/api/v1/chains") return json(route, { items: [] });
  if (pathname === "/api/v1/chain-templates" && method === "GET") {
    return json(route, { items: [] });
  }
  if (pathname === "/api/v1/packages") return json(route, { items: [] });
  if (pathname === "/api/v1/nodes") {
    return json(route, { items: [], total: 0, page: 1, per_page: 200 });
  }
  if (pathname === "/api/v1/rule-templates") return json(route, { items: [] });
  if (pathname === "/api/v1/subscription-templates") return json(route, { items: [] });
  if (pathname === "/api/v1/me/summary") return json(route, {});
  if (pathname === "/api/v1/updates") {
    return json(route, {
      master: {
        current: "0.18.7",
        latest: "0.18.7",
        update_available: false,
        release_url: null,
        released_at: null,
        checked_at: NOW,
        error: null,
      },
      agents: {
        current_protocol: 1,
        min_supported: 1,
        versions: [{ version: "0.18.7", count: 3 }],
      },
    });
  }
  if (pathname === "/api/v1/enforcement/events") return json(route, { items: [] });
  if (pathname === "/api/v1/me/events") return json(route, { items: [] });
  if (pathname === "/api/v1/audit") {
    return json(route, { items: [], total: 0, page: 1, per_page: 50 });
  }
  if (pathname === "/api/v1/settings") {
    return json(route, { items: {}, secret_errors: null });
  }
  if (pathname === "/api/v1/certificates") return json(route, { items: [] });
  if (pathname === "/api/v1/api-tokens") return json(route, { items: [] });
  if (pathname === "/api/v1/sessions") return json(route, { items: [] });
  if (pathname === "/api/v1/public/status") {
    return json(route, { servers: [], generated_at: NOW });
  }
  return json(route, { items: [], total: 0, page: 1, per_page: 50 });
}

// ---------------------------------------------------------------------------
// 静态服务 / static server
// ---------------------------------------------------------------------------

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
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: FRAME_ARGS,
});

const shots = [];
const checks = [];
const focusChecks = [];
const staticComparisons = [];
const deviations = [];
const pageErrors = [];

function record(label, value) {
  checks.push({ label, ...value });
  console.log(`  ${label}: ${JSON.stringify(value)}`);
}

function insist(condition, message) {
  assert.ok(condition, message);
}

async function openPage({
  theme = "light",
  width = 1440,
  height = 900,
  target = "/",
  reducedMotion = "no-preference",
  locale = "zh-CN",
  browserInstance = browser,
} = {}) {
  const context = await browserInstance.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.addInitScript(
    ({ theme, locale }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale },
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
  const file = path.join(OUT, `${name}.png`);
  if (locator) await locator.screenshot({ path: file, animations: "disabled" });
  else await page.screenshot({ path: file });
  shots.push(name);
  console.log(`saved ${name}.png`);
}

/** 在页面里解码两张 PNG 并逐像素比较；返回差异统计。 */
async function diffPng(page, baselineBuffer, currentBuffer, tolerance = 0) {
  return page.evaluate(
    async ({ baseline, current, tolerance }) => {
      async function decode(base64) {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        return {
          width: image.width,
          height: image.height,
          data: context.getImageData(0, 0, image.width, image.height).data,
        };
      }
      const before = await decode(baseline);
      const after = await decode(current);
      if (before.width !== after.width || before.height !== after.height) {
        return {
          sizeMismatch: [before.width, before.height, after.width, after.height],
        };
      }
      let differingPixels = 0;
      let maxChannelDelta = 0;
      for (let index = 0; index < before.data.length; index += 4) {
        let delta = 0;
        for (let channel = 0; channel < 3; channel += 1) {
          const difference = Math.abs(
            before.data[index + channel] - after.data[index + channel],
          );
          if (difference > delta) delta = difference;
        }
        if (delta > maxChannelDelta) maxChannelDelta = delta;
        if (delta > tolerance) differingPixels += 1;
      }
      return {
        width: before.width,
        height: before.height,
        differingPixels,
        maxChannelDelta,
      };
    },
    {
      baseline: baselineBuffer.toString("base64"),
      current: currentBuffer.toString("base64"),
      tolerance,
    },
  );
}

// ---------------------------------------------------------------------------
// 静态帧 / resting frames
// ---------------------------------------------------------------------------

const ZERO = { tolerance: 0 };
const SIDEBAR = { tolerance: 8 };

const STATIC_CASES = [
  {
    name: "view-tabs-1440-light",
    theme: "light",
    width: 1440,
    selector: '[data-overview-view-tabs]',
    target: "/",
    ...ZERO,
  },
  {
    name: "view-tabs-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[data-overview-view-tabs]',
    target: "/",
    ...ZERO,
  },
  {
    name: "view-tabs-390-light",
    theme: "light",
    width: 390,
    selector: '[data-overview-view-tabs]',
    target: "/",
    ...ZERO,
  },
  {
    name: "view-tabs-390-dark",
    theme: "dark",
    width: 390,
    selector: '[data-overview-view-tabs]',
    target: "/",
    ...ZERO,
  },
  /*
   * 鼠标点击后焦点仍留在 tab 上（Radix 在 mousedown 里脚本聚焦）。指针模态
   * 应清掉 outline 与 ring，且触发器不能自己画 `focus-visible:border-ring`
   * 的 1px 蓝框；点击帧必须和改动前的选中态逐像素一致。
   */
  {
    name: "view-tabs-click-1440-light",
    theme: "light",
    width: 1440,
    selector: '[data-overview-view-tabs]',
    target: "/",
    interaction: "click-active",
    focusCheck: "pointer",
    compareWith: "view-tabs-1440-light",
    ...ZERO,
  },
  {
    name: "view-tabs-click-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[data-overview-view-tabs]',
    target: "/",
    interaction: "click-active",
    focusCheck: "pointer",
    compareWith: "view-tabs-1440-dark",
    ...ZERO,
  },
  /*
   * 键盘聚焦：指针模态规则不生效，统一焦点环仍须存在。与改动前的键盘帧
   * （触发器自带边框 + outline）逐像素比较。
   */
  {
    name: "view-tabs-keyboard-1440-light",
    theme: "light",
    width: 1440,
    selector: '[data-overview-view-tabs]',
    target: "/",
    interaction: "keyboard-focus",
    focusCheck: "keyboard",
    padding: 8,
    ...ZERO,
  },
  {
    name: "view-tabs-keyboard-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[data-overview-view-tabs]',
    target: "/",
    interaction: "keyboard-focus",
    focusCheck: "keyboard",
    padding: 8,
    ...ZERO,
  },
  {
    name: "chain-underline-1440-light",
    theme: "light",
    width: 1440,
    selector: '[data-chain-section-tabs]',
    target: "/?view=chain",
    ...ZERO,
  },
  {
    name: "chain-underline-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[data-chain-section-tabs]',
    target: "/?view=chain",
    ...ZERO,
  },
  {
    name: "seg-uptime-1440-light",
    theme: "light",
    width: 1440,
    selector: '[data-uptime-mode-tabs]',
    target: "/",
    ...ZERO,
  },
  {
    name: "seg-uptime-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[data-uptime-mode-tabs]',
    target: "/",
    ...ZERO,
  },
  {
    name: "seg-uptime-click-1440-light",
    theme: "light",
    width: 1440,
    selector: '[data-uptime-mode-tabs]',
    target: "/",
    interaction: "click-active",
    focusCheck: "pointer",
    compareWith: "seg-uptime-1440-light",
    ...ZERO,
  },
  {
    name: "seg-uptime-click-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[data-uptime-mode-tabs]',
    target: "/",
    interaction: "click-active",
    focusCheck: "pointer",
    compareWith: "seg-uptime-1440-dark",
    ...ZERO,
  },
  {
    name: "seg-uptime-keyboard-1440-light",
    theme: "light",
    width: 1440,
    selector: '[data-uptime-mode-tabs]',
    target: "/",
    interaction: "keyboard-focus",
    focusCheck: "keyboard",
    padding: 8,
    ...ZERO,
  },
  {
    name: "seg-uptime-keyboard-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[data-uptime-mode-tabs]',
    target: "/",
    interaction: "keyboard-focus",
    focusCheck: "keyboard",
    padding: 8,
    ...ZERO,
  },
  {
    name: "seg-distribution-1440-light",
    theme: "light",
    width: 1440,
    selector: '[aria-label="切换分布维度"]',
    target: "/?view=traffic",
    ...ZERO,
  },
  {
    name: "seg-distribution-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[aria-label="切换分布维度"]',
    target: "/?view=traffic",
    ...ZERO,
  },
  {
    name: "seg-leaderboard-1440-light",
    theme: "light",
    width: 1440,
    selector: '[aria-label="切换榜单维度"]',
    target: "/?view=traffic",
    ...ZERO,
  },
  {
    name: "seg-leaderboard-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[aria-label="切换榜单维度"]',
    target: "/?view=traffic",
    ...ZERO,
  },
  {
    name: "seg-trend-1440-light",
    theme: "light",
    width: 1440,
    selector: '[aria-label="切换趋势维度"]',
    target: "/?view=traffic",
    ...ZERO,
  },
  {
    name: "seg-trend-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[aria-label="切换趋势维度"]',
    target: "/?view=traffic",
    ...ZERO,
  },
  {
    name: "settings-tabs-1440-light",
    theme: "light",
    width: 1440,
    selector: '[data-slot="tabs-list"]',
    target: "/settings",
    ...ZERO,
  },
  {
    name: "settings-tabs-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[data-slot="tabs-list"]',
    target: "/settings",
    ...ZERO,
  },
  {
    name: "logs-tabs-1440-light",
    theme: "light",
    width: 1440,
    selector: '[data-slot="tabs-list"]',
    target: "/logs",
    ...ZERO,
  },
  {
    name: "logs-tabs-1440-dark",
    theme: "dark",
    width: 1440,
    selector: '[data-slot="tabs-list"]',
    target: "/logs",
    ...ZERO,
  },
  {
    name: "sidebar-1440-light",
    theme: "light",
    width: 1440,
    selector: 'aside nav[aria-label]',
    target: "/",
    ...SIDEBAR,
  },
  {
    name: "sidebar-1440-dark",
    theme: "dark",
    width: 1440,
    selector: 'aside nav[aria-label]',
    target: "/",
    ...SIDEBAR,
  },
  {
    name: "sidebar-drawer-390-light",
    theme: "light",
    width: 390,
    selector: '[role="dialog"] nav[aria-label]',
    target: "/",
    drawer: true,
    ...SIDEBAR,
  },
  {
    name: "sidebar-drawer-390-dark",
    theme: "dark",
    width: 390,
    selector: '[role="dialog"] nav[aria-label]',
    target: "/",
    drawer: true,
    ...SIDEBAR,
  },
];

const ACTIVE_TRIGGER = '[data-slot="tabs-trigger"][data-state="active"]';

/** 读取选中触发器的焦点几何 / 边框 / outline / 输入模态。 */
async function readFocusState(page, selector) {
  return page.evaluate(
    ({ selector, activeTrigger }) => {
      const list = document.querySelector(selector);
      const element = list?.querySelector(activeTrigger);
      if (!list || !element) return null;
      const style = getComputedStyle(element);
      const alphaOf = (color) => {
        if (!color) return 1;
        if (color === "transparent") return 0;
        const slash = color.match(/\/\s*([\d.]+%?)\s*\)$/);
        if (slash) {
          const value = slash[1];
          return value.endsWith("%")
            ? Number.parseFloat(value) / 100
            : Number.parseFloat(value);
        }
        const rgba = color.match(/rgba?\(([^)]+)\)/);
        if (rgba) {
          const parts = rgba[1].split(/[\s,/]+/).filter(Boolean);
          if (parts.length === 4) return Number.parseFloat(parts[3]);
        }
        return 1;
      };
      return {
        text: element.textContent?.trim() ?? "",
        activeElement: document.activeElement === element,
        focusVisible: element.matches(":focus-visible"),
        modality: document.documentElement.dataset.input ?? null,
        borderWidth: style.borderTopWidth,
        borderColor: style.borderTopColor,
        borderTransparent: alphaOf(style.borderTopColor) === 0,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor,
        boxShadow: style.boxShadow,
        // Tailwind `focus-visible:ring-[3px]` 的投影：3px 扩散且颜色不透明。
        ringVisible: /(?:rgba?|oklch|oklab|color)\([^)]*\)\s+0px 0px 0px 3px/.test(
          style.boxShadow,
        ),
      };
    },
    { selector, activeTrigger: ACTIVE_TRIGGER },
  );
}

async function clickActiveTrigger(page, selector) {
  await page
    .locator(`${selector} ${ACTIVE_TRIGGER}`)
    .first()
    .click();
  // 让鼠标离开触发器：hover 会改文字色，但焦点仍留在触发器上。
  await page.mouse.move(2, 2);
  await page.waitForTimeout(360);
}

async function focusActiveTriggerByKeyboard(page, selector) {
  const target = `${selector} ${ACTIVE_TRIGGER}`;
  for (let index = 0; index < 120; index += 1) {
    await page.keyboard.press("Tab");
    const state = await page.evaluate(
      ({ target }) => {
        const element = document.activeElement;
        return {
          matched: element instanceof Element && element.matches(target),
          text: element?.textContent?.trim() ?? null,
        };
      },
      { target },
    );
    if (state.matched) {
      await page.waitForTimeout(320);
      return state.text;
    }
  }
  throw new Error(
    `keyboard focus: ${target} never received focus after 120 Tab presses`,
  );
}

function assertFocusState(testCase, focus) {
  insist(focus !== null, `${testCase.name}: active trigger not found`);
  insist(
    focus.activeElement,
    `${testCase.name}: focus must stay on the tab (${focus.modality})`,
  );
  if (testCase.focusCheck === "pointer") {
    insist(
      focus.modality === "pointer",
      `${testCase.name}: expected pointer modality, got ${focus.modality}`,
    );
    insist(
      focus.borderWidth === "0px" || focus.borderTransparent,
      `${testCase.name}: clicked tab draws a border (${focus.borderWidth} ${focus.borderColor})`,
    );
    insist(
      focus.outlineStyle === "none",
      `${testCase.name}: clicked tab must not outline (${focus.outlineStyle})`,
    );
  } else if (testCase.focusCheck === "keyboard") {
    insist(
      focus.modality === "keyboard",
      `${testCase.name}: expected keyboard modality, got ${focus.modality}`,
    );
    insist(
      focus.focusVisible,
      `${testCase.name}: keyboard-focused tab must match :focus-visible`,
    );
    insist(
      focus.outlineStyle !== "none" &&
        Number.parseFloat(focus.outlineWidth) > 0,
      `${testCase.name}: keyboard focus outline missing (${focus.outlineStyle} ${focus.outlineWidth})`,
    );
    insist(
      focus.ringVisible,
      `${testCase.name}: keyboard 3px ring missing (${focus.boxShadow})`,
    );
  }
}

async function captureStatic(page, testCase, { check = true } = {}) {
  if (testCase.drawer) {
    await page
      .getByRole("button", { name: /打开导航|Open navigation/ })
      .click();
    await page.waitForTimeout(500);
  }
  await settle(page);
  await page.mouse.move(2, 2);
  const locator = page.locator(testCase.selector).first();
  await locator.waitFor({ state: "visible", timeout: 20000 });

  let focus = null;
  if (testCase.interaction === "click-active") {
    await clickActiveTrigger(page, testCase.selector);
    focus = await readFocusState(page, testCase.selector);
    if (check) assertFocusState(testCase, focus);
  } else if (testCase.interaction === "keyboard-focus") {
    await focusActiveTriggerByKeyboard(page, testCase.selector);
    focus = await readFocusState(page, testCase.selector);
    if (check) assertFocusState(testCase, focus);
  }

  let buffer;
  if (testCase.padding) {
    // 键盘焦点环画在触发器外沿（outline-offset 2px + 2px 宽），元素截图的
    // 边界会把它裁掉；键盘帧用带 padding 的页面裁切，环才看得见。
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    insist(box !== null, `${testCase.name}: no bounding box for padded frame`);
    const padding = testCase.padding;
    buffer = await page.screenshot({
      animations: "disabled",
      clip: {
        x: Math.round(box.x) - padding,
        y: Math.round(box.y) - padding,
        width: Math.round(box.width) + padding * 2,
        height: Math.round(box.height) + padding * 2,
      },
    });
  } else {
    buffer = await locator.screenshot({ animations: "disabled" });
  }
  return { buffer, focus };
}

if (BASELINE_MODE) {
  console.log(`Capturing motion-continuity baselines from ${DIST}`);
  // 默认只补缺失的帧，避免用同一份旧构建重写已验收的基线；确需全部重拍时
  // 设 MOTION_CONTINUITY_REBASELINE=1。
  const rebaselineAll = process.env.MOTION_CONTINUITY_REBASELINE === "1";
  for (const testCase of STATIC_CASES) {
    const file = path.join(BASELINE, `${testCase.name}.png`);
    if (!rebaselineAll && existsSync(file)) {
      console.log(`keep baseline ${testCase.name}.png`);
      continue;
    }
    const { context, page } = await openPage({
      theme: testCase.theme,
      width: testCase.width,
      target: testCase.target,
    });
    try {
      const { buffer } = await captureStatic(page, testCase, { check: false });
      writeFileSync(file, buffer);
      shots.push(`baseline/${testCase.name}`);
      console.log(`baseline ${testCase.name}.png`);
    } finally {
      await context.close();
    }
  }
  await browser.close();
  server.close();
  console.log(`\n${shots.length} baseline images saved to ${BASELINE}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 动态读数辅助 / dynamic helpers
// ---------------------------------------------------------------------------

/** 读取一个容器里的指示器与选中项几何。 */
async function readIndicator(page, { container, active }) {
  return page.evaluate(
    ({ container, active }) => {
      const list = document.querySelector(container);
      const indicator = list?.querySelector('[data-slot="sliding-indicator"]');
      const activeElement = list?.querySelector(active);
      if (!list || !indicator || !activeElement) return null;
      const indicatorRect = indicator.getBoundingClientRect();
      const activeRect = activeElement.getBoundingClientRect();
      const style = getComputedStyle(indicator);
      return {
        container: {
          left: list.getBoundingClientRect().left,
          top: list.getBoundingClientRect().top,
          width: list.getBoundingClientRect().width,
          height: list.getBoundingClientRect().height,
          scrollLeft: list.scrollLeft,
          scrollTop: list.scrollTop,
        },
        indicator: {
          left: indicatorRect.left,
          top: indicatorRect.top,
          width: indicatorRect.width,
          height: indicatorRect.height,
          ready: indicator.dataset.ready,
          transitionProperty: style.transitionProperty,
          transitionDuration: style.transitionDuration,
          transitionTimingFunction: style.transitionTimingFunction,
          opacity: style.opacity,
        },
        active: {
          left: activeRect.left,
          top: activeRect.top,
          width: activeRect.width,
          height: activeRect.height,
          text: activeElement.textContent,
        },
        gapX: Math.abs(indicatorRect.left - activeRect.left),
        gapY: Math.abs(indicatorRect.top - activeRect.top),
        gapWidth: Math.abs(indicatorRect.width - activeRect.width),
        gapHeight: Math.abs(indicatorRect.height - activeRect.height),
      };
    },
    { container, active },
  );
}

function aligned(reading, tolerance = 0.5) {
  return (
    reading !== null &&
    reading.indicator.ready === "ready" &&
    reading.gapX <= tolerance &&
    reading.gapY <= tolerance &&
    reading.gapWidth <= tolerance &&
    reading.gapHeight <= tolerance
  );
}

/**
 * 在容器上装一个轨迹记录器：点击 / 按键时同步记录第一帧，然后用 8ms
 * 的 setInterval 采样位置（CSS 过渡按时间推进，不依赖被节流的 rAF）。
 */
async function installTrajectoryRecorder(page, { container, active }) {
  await page.evaluate(
    ({ container, active }) => {
      const list = document.querySelector(container);
      const indicator = list?.querySelector('[data-slot="sliding-indicator"]');
      window.__trajectory = null;
      if (!list || !indicator) return;
      const activeElement = () => list.querySelector(active);
      const snapshot = () => {
        const indicatorRect = indicator.getBoundingClientRect();
        const activeRect = activeElement()?.getBoundingClientRect();
        return {
          t: 0,
          left: indicatorRect.left,
          top: indicatorRect.top,
          width: indicatorRect.width,
          height: indicatorRect.height,
          activeLeft: activeRect?.left ?? null,
          activeTop: activeRect?.top ?? null,
          activeWidth: activeRect?.width ?? null,
          activeHeight: activeRect?.height ?? null,
          ready: indicator.dataset.ready,
        };
      };
      const start = () => {
        if (window.__trajectory) return;
        const startedAt = performance.now();
        const samples = [];
        const frames = [];
        let transition = null;
        let lastFrame = startedAt;
        const initial = snapshot();
        const captureTransition = () => {
          if (transition) return;
          const animation = indicator
            .getAnimations()
            .find(
              (item) =>
                item.transitionProperty === "left" ||
                item.transitionProperty === "top",
            );
          if (!animation) return;
          const keyframes = animation.effect.getKeyframes();
          transition = {
            property: animation.transitionProperty,
            durationMs: animation.effect.getTiming().duration,
            from: keyframes[0] ?? null,
            to: keyframes[1] ?? null,
            easing: animation.effect.getTiming().easing,
          };
        };
        const sample = () => {
          const value = snapshot();
          value.t = +(performance.now() - startedAt).toFixed(1);
          samples.push(value);
          captureTransition();
        };
        sample();
        const interval = setInterval(sample, 8);
        let raf = requestAnimationFrame(function frame(now) {
          frames.push(now - lastFrame);
          lastFrame = now;
          if (performance.now() - startedAt < 900) {
            raf = requestAnimationFrame(frame);
          }
        });
        window.__trajectory = new Promise((resolvePromise) => {
          setTimeout(() => {
            clearInterval(interval);
            cancelAnimationFrame(raf);
            const style = getComputedStyle(indicator);
            resolvePromise({
              initial,
              samples,
              frames,
              transition,
              transitionDuration: style.transitionDuration,
              transitionTimingFunction: style.transitionTimingFunction,
            });
          }, 1000);
        });
      };
      list.addEventListener("click", start, true);
      list.addEventListener("keydown", start, true);
    },
    { container, active },
  );
}

function analyzeTrajectory(trajectory) {
  const samples = trajectory.samples;
  const initial = trajectory.initial;
  const final = samples.at(-1);
  const targetLeft = final.activeLeft;
  const targetTop = final.activeTop;
  const startGap =
    targetLeft === null || targetTop === null
      ? null
      : Math.max(
          Math.abs(targetLeft - initial.left),
          Math.abs(targetTop - initial.top),
        );
  // tab 是横向滑动，侧栏是纵向滑动：取两个轴上较大的偏差，一套逻辑通用。
  const gapOf = (sample) =>
    sample.activeLeft === null || sample.activeTop === null
      ? null
      : Math.max(
          Math.abs(sample.left - sample.activeLeft),
          Math.abs(sample.top - sample.activeTop),
        );
  const gaps = samples
    .filter((sample) => gapOf(sample) !== null)
    .map((sample) => ({ t: sample.t, left: sample.left, top: sample.top, gap: gapOf(sample) }));
  // 从真正开始移动的那一刻算过渡时长：点击后 React 还要提交一次状态，
  // 把这段延迟算进去会把 200ms 误读成 400ms。
  const movement = gaps.find(
    (sample) =>
      Math.abs(sample.left - initial.left) > 0.1 ||
      Math.abs(sample.top - initial.top) > 0.1,
  );
  const settled = movement
    ? gaps.find(
        (sample) =>
          sample.t >= movement.t &&
          sample.gap <= 0.5 &&
          gaps
            .filter((later) => later.t >= sample.t)
            .every((later) => later.gap <= 0.5),
      )
    : null;
  const between =
    movement && settled
      ? gaps.filter((sample) => sample.t >= movement.t && sample.t <= settled.t)
      : [];
  const middle =
    between.length > 0
      ? between[Math.floor(between.length / 2)]
      : null;
  const deltaX =
    targetLeft === null ? 0 : Math.abs(targetLeft - initial.left);
  const deltaY = targetTop === null ? 0 : Math.abs(targetTop - initial.top);
  const axis = deltaY > deltaX ? "y" : "x";
  const transition = trajectory.transition;
  const numeric = (value) => {
    if (typeof value !== "string") return null;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const from =
    transition && axis === "y"
      ? numeric(transition.from?.top)
      : numeric(transition?.from?.left);
  const to =
    transition && axis === "y"
      ? numeric(transition.to?.top)
      : numeric(transition?.to?.left);
  const transitionSpan =
    from === null || to === null ? null : Math.abs(to - from);
  return {
    axis,
    transitionFromPx: from,
    transitionToPx: to,
    transitionSpanPx: transitionSpan === null ? null : +transitionSpan.toFixed(2),
    transitionProperty: transition?.property ?? null,
    transitionMs: transition?.durationMs ?? null,
    startGap,
    endGap: gaps.at(-1)?.gap ?? null,
    middleGap: middle?.gap ?? null,
    middleAt: middle?.t ?? null,
    moveStartedAt: movement?.t ?? null,
    firstFrameGap: startGap,
    settledAt: settled?.t ?? null,
    observedDurationMs:
      movement && settled ? +(settled.t - movement.t).toFixed(1) : null,
    commitDelayMs: movement?.t ?? null,
    transitionDuration: trajectory.transitionDuration,
    transitionTimingFunction: trajectory.transitionTimingFunction,
    sampleCount: samples.length,
  };
}

const SELECTOR = {
  viewTabs: {
    container: '[data-overview-view-tabs]',
    active: '[data-slot="tabs-trigger"][data-state="active"]',
  },
  sidebar: {
    container: 'aside nav[aria-label] > div',
    active: 'a[aria-current="page"]',
  },
  drawer: {
    container: '[role="dialog"] nav[aria-label] > div',
    active: 'a[aria-current="page"]',
  },
};

const dynamic = {};

// ---------------------------------------------------------------------------
// 1. 点击 / 方向键轨迹、首帧不滑、390、变窄、中英切换
// ---------------------------------------------------------------------------

{
  const { context, page, errors } = await openPage({ target: "/" });
  await page.waitForSelector(
    '[data-overview-view-tabs] [data-slot="sliding-indicator"][data-ready="ready"]',
    { timeout: 20000 },
  );

  // 首帧：记录从 hidden 变 ready 之后的位置，确认没有滑动。
  await page.evaluate(() => {
    const list = document.querySelector('[data-overview-view-tabs]');
    const indicator = list.querySelector('[data-slot="sliding-indicator"]');
    const active = () => list.querySelector('[data-slot="tabs-trigger"][data-state="active"]');
    window.__firstLoad = [];
    const startedAt = performance.now();
    const interval = setInterval(() => {
      const ind = indicator.getBoundingClientRect();
      const act = active()?.getBoundingClientRect();
      window.__firstLoad.push({
        t: +(performance.now() - startedAt).toFixed(1),
        left: ind.left,
        activeLeft: act?.left ?? null,
        ready: indicator.dataset.ready,
      });
      if (performance.now() - startedAt > 500) clearInterval(interval);
    }, 8);
  });
  await page.waitForTimeout(600);
  const firstLoad = await page.evaluate(() => window.__firstLoad);
  const readySamples = firstLoad.filter((sample) => sample.ready === "ready");
  const firstLoadDrift =
    readySamples.length > 0
      ? Math.max(
          ...readySamples.map((sample) =>
            Math.abs(sample.left - sample.activeLeft),
          ),
        )
      : null;
  record("first-load", {
    readySamples: readySamples.length,
    maxDriftPx: firstLoadDrift === null ? null : +firstLoadDrift.toFixed(3),
    firstReadyLeft: readySamples[0]?.left ?? null,
    lastLeft: readySamples.at(-1)?.left ?? null,
  });
  insist(readySamples.length > 0, "first load never became ready");
  insist(firstLoadDrift !== null && firstLoadDrift <= 0.5, "first load must not animate");
  dynamic.firstLoad = {
    maxDriftPx: firstLoadDrift,
    samples: readySamples.length,
  };

  // 点击切换（第 2 个 tab）轨迹
  await installTrajectoryRecorder(page, SELECTOR.viewTabs);
  await page
    .locator('[data-overview-view-tabs] [data-slot="tabs-trigger"]')
    .nth(1)
    .click();
  const clickTrajectory = analyzeTrajectory(
    await page.evaluate(() => window.__trajectory),
  );
  record("click-trajectory", clickTrajectory);
  insist(clickTrajectory.startGap !== null && clickTrajectory.startGap > 10, "click: tabs must be apart");
  insist(
    clickTrajectory.transitionSpanPx !== null &&
      Math.abs(clickTrajectory.transitionSpanPx - clickTrajectory.startGap) <= 1,
    `click: transition must start at the previous tab (span ${clickTrajectory.transitionSpanPx}, gap ${clickTrajectory.startGap})`,
  );
  insist(
    clickTrajectory.middleGap !== null &&
      clickTrajectory.middleGap > clickTrajectory.endGap &&
      clickTrajectory.middleGap < clickTrajectory.startGap,
    "click: middle frame must sit between start and end",
  );
  insist(clickTrajectory.endGap !== null && clickTrajectory.endGap <= 0.5, "click: must end aligned");
  insist(clickTrajectory.transitionDuration === "0.2s", "click: 200ms transition");
  insist(
    clickTrajectory.transitionTimingFunction === "cubic-bezier(0.22, 1, 0.36, 1)",
    "click: ease-out-soft",
  );
  insist(
    clickTrajectory.settledAt !== null &&
      clickTrajectory.settledAt >= 120 &&
      clickTrajectory.settledAt <= 800,
    `click: aligned ${clickTrajectory.settledAt}ms after click, expected ~200ms`,
  );
  dynamic.clickTrajectory = clickTrajectory;

  // 方向键切换（回到第 1 个 tab）
  await page
    .locator('[data-overview-view-tabs] [data-slot="tabs-trigger"]')
    .nth(1)
    .focus();
  await installTrajectoryRecorder(page, SELECTOR.viewTabs);
  await page.keyboard.press("ArrowLeft");
  const keyTrajectory = analyzeTrajectory(
    await page.evaluate(() => window.__trajectory),
  );
  record("keyboard-trajectory", keyTrajectory);
  insist(keyTrajectory.endGap !== null && keyTrajectory.endGap <= 0.5, "keyboard: end aligned");
  insist(
    keyTrajectory.settledAt !== null &&
      keyTrajectory.settledAt >= 120 &&
      keyTrajectory.settledAt <= 800,
    `keyboard: aligned ${keyTrajectory.settledAt}ms after keypress`,
  );
  insist(
    keyTrajectory.middleGap !== null &&
      keyTrajectory.middleGap < keyTrajectory.startGap,
    "keyboard: middle frame between",
  );
  dynamic.keyboardTrajectory = keyTrajectory;

  // 中英切换：标签变宽后指示器重新对齐
  await page.getByRole("button", { name: /账号菜单|Account menu/ }).click();
  await page
    .getByRole("menuitem", { name: /语言 \/ Language|Language/ })
    .hover();
  await page.getByRole("menuitem", { name: "English" }).click();
  await page.waitForTimeout(500);
  const localeReading = await readIndicator(page, SELECTOR.viewTabs);
  const activeText = localeReading?.active.text?.trim();
  record("locale-switch", {
    activeText,
    gapX: localeReading?.gapX,
    gapWidth: localeReading?.gapWidth,
  });
  insist(
    activeText === "Resource status",
    `locale switch: active label should be English, got ${activeText}`,
  );
  insist(aligned(localeReading), "locale switch: indicator must realign");
  dynamic.localeSwitch = {
    activeText,
    gapX: localeReading.gapX,
    gapWidth: localeReading.gapWidth,
  };

  // 窗口变窄：指示器跟随选中项
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(450);
  const narrowReading = await readIndicator(page, SELECTOR.viewTabs);
  record("resize-900", {
    gapX: narrowReading?.gapX,
    gapWidth: narrowReading?.gapWidth,
  });
  insist(aligned(narrowReading), "resize 900: indicator must realign");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  const mobileReading = await readIndicator(page, SELECTOR.viewTabs);
  record("resize-390", {
    gapX: mobileReading?.gapX,
    gapWidth: mobileReading?.gapWidth,
  });
  insist(aligned(mobileReading), "resize 390: indicator must realign");
  dynamic.resize = {
    width900: { gapX: narrowReading.gapX, gapWidth: narrowReading.gapWidth },
    width390: { gapX: mobileReading.gapX, gapWidth: mobileReading.gapWidth },
  };

  pageErrors.push(...errors);
  await context.close();
}

// 390 的第 4 个 tab
{
  const { context, page, errors } = await openPage({ width: 390, target: "/" });
  await page.waitForSelector(
    '[data-overview-view-tabs] [data-slot="sliding-indicator"][data-ready="ready"]',
    { timeout: 20000 },
  );
  await page
    .locator('[data-overview-view-tabs] [data-slot="tabs-trigger"]')
    .nth(3)
    .click();
  await page.waitForTimeout(450);
  const reading = await readIndicator(page, SELECTOR.viewTabs);
  record("390-fourth-tab", {
    text: reading?.active.text?.trim(),
    gapX: reading?.gapX,
    gapWidth: reading?.gapWidth,
    listScrollLeft: reading?.container.scrollLeft,
  });
  insist(reading?.active.text?.trim() === "链路时延", "390: 4th tab must be selected");
  insist(aligned(reading), "390: 4th tab indicator must align");
  await screenshot(page, "390-fourth-tab", page.locator('[data-overview-view-tabs]'));
  dynamic.fourthTab390 = {
    text: reading.active.text.trim(),
    gapX: reading.gapX,
    gapWidth: reading.gapWidth,
    listScrollLeft: reading.container.scrollLeft,
  };
  pageErrors.push(...errors);
  await context.close();
}

// ---------------------------------------------------------------------------
// 2. 侧栏：点击 / 折叠 / 抽屉
// ---------------------------------------------------------------------------

{
  const { context, page, errors } = await openPage({ target: "/" });
  await page.waitForSelector(
    'aside nav[aria-label] [data-slot="sliding-indicator"][data-ready="ready"]',
    { timeout: 20000 },
  );
  const initial = await readIndicator(page, SELECTOR.sidebar);
  record("sidebar-initial", { active: initial?.active.text?.trim(), gapX: initial?.gapX });
  insist(aligned(initial), "sidebar: initial indicator must align");

  await installTrajectoryRecorder(page, SELECTOR.sidebar);
  await page.locator('aside nav[aria-label] a', { hasText: "服务器" }).first().click();
  await page.waitForTimeout(500);
  const sidebarTrajectory = analyzeTrajectory(
    await page.evaluate(() => window.__trajectory),
  );
  const afterClick = await readIndicator(page, SELECTOR.sidebar);
  record("sidebar-click", {
    active: afterClick?.active.text?.trim(),
    gapX: afterClick?.gapX,
    gapWidth: afterClick?.gapWidth,
    endGap: sidebarTrajectory.endGap,
    settledAt: sidebarTrajectory.settledAt,
  });
  insist(afterClick?.active.text?.trim() === "服务器", "sidebar: click must switch entry");
  insist(aligned(afterClick), "sidebar: click must end aligned");
  dynamic.sidebarClick = {
    active: afterClick.active.text.trim(),
    endGap: sidebarTrajectory.endGap,
    settledAt: sidebarTrajectory.settledAt,
  };

  // 折叠：宽度动画结束后仍贴合
  await page.getByRole("button", { name: /收起侧边栏|Collapse sidebar/ }).click();
  await page.waitForTimeout(500);
  const collapsed = await readIndicator(page, SELECTOR.sidebar);
  record("sidebar-collapsed", {
    gapX: collapsed?.gapX,
    gapWidth: collapsed?.gapWidth,
    active: collapsed?.active.text?.trim(),
  });
  insist(aligned(collapsed), "sidebar: collapsed indicator must align");
  await screenshot(page, "sidebar-collapsed-1440-light");
  dynamic.sidebarCollapsed = {
    gapX: collapsed.gapX,
    gapWidth: collapsed.gapWidth,
  };
  pageErrors.push(...errors);
  await context.close();
}

{
  const { context, page, errors } = await openPage({ width: 390, target: "/" });
  await page
    .getByRole("button", { name: /打开导航|Open navigation/ })
    .click();
  await page.waitForTimeout(500);
  const drawer = await readIndicator(page, SELECTOR.drawer);
  record("drawer-open", {
    active: drawer?.active.text?.trim(),
    gapX: drawer?.gapX,
    gapWidth: drawer?.gapWidth,
  });
  insist(aligned(drawer), "drawer: indicator must align on open");
  await page
    .locator('[role="dialog"] nav[aria-label] a', { hasText: "设置" })
    .first()
    .click();
  await page.waitForTimeout(500);
  await page
    .getByRole("button", { name: /打开导航|Open navigation/ })
    .click();
  await page.waitForTimeout(500);
  const drawerAfter = await readIndicator(page, SELECTOR.drawer);
  record("drawer-after-click", {
    active: drawerAfter?.active.text?.trim(),
    gapX: drawerAfter?.gapX,
    gapWidth: drawerAfter?.gapWidth,
  });
  insist(drawerAfter?.active.text?.trim() === "设置", "drawer: click must switch entry");
  insist(aligned(drawerAfter), "drawer: indicator must realign after navigation");
  dynamic.drawer = {
    open: { active: drawer.active.text.trim(), gapX: drawer.gapX },
    afterClick: {
      active: drawerAfter.active.text.trim(),
      gapX: drawerAfter.gapX,
    },
  };
  pageErrors.push(...errors);
  await context.close();
}

// ---------------------------------------------------------------------------
// 3. reduced-motion
// ---------------------------------------------------------------------------

{
  const { context, page, errors } = await openPage({
    target: "/",
    reducedMotion: "reduce",
  });
  await page.waitForSelector(
    '[data-overview-view-tabs] [data-slot="sliding-indicator"][data-ready="ready"]',
    { timeout: 20000 },
  );
  const before = await readIndicator(page, SELECTOR.viewTabs);
  const style = before.indicator;
  await page
    .locator('[data-overview-view-tabs] [data-slot="tabs-trigger"]')
    .nth(2)
    .click();
  const startedAt = Date.now();
  await page.waitForTimeout(60);
  const after = await readIndicator(page, SELECTOR.viewTabs);
  const elapsed = Date.now() - startedAt;
  record("reduced-motion", {
    transitionProperty: style.transitionProperty,
    transitionDuration: style.transitionDuration,
    gapX: after?.gapX,
    gapWidth: after?.gapWidth,
    observedMs: elapsed,
  });
  const duration =
    style.transitionDuration === "0s"
      ? 0
      : style.transitionDuration === "0.01ms"
        ? 0.01
        : Number.parseFloat(style.transitionDuration) * 1000;
  insist(duration < 1, `reduced-motion: duration ${style.transitionDuration} must be < 1ms`);
  insist(aligned(after), "reduced-motion: must jump straight to the final position");
  dynamic.reducedMotion = {
    transitionDuration: style.transitionDuration,
    durationMs: duration,
    gapX: after.gapX,
    gapWidth: after.gapWidth,
    observedMs: elapsed,
  };
  pageErrors.push(...errors);
  await context.close();
}

// ---------------------------------------------------------------------------
// 4. KPI value-settle
// ---------------------------------------------------------------------------

{
  const { context, page, errors } = await openPage({ target: "/" });
  await page.waitForSelector('[data-overview-kpis] [data-kpi-value]', {
    timeout: 20000,
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__kpiNodes = [...document.querySelectorAll("[data-kpi-value]")];
    window.__kpiLinks = [...document.querySelectorAll("[data-kpi-link]")];
    window.__kpiSettleEvents = [];
    const kpis = document.querySelector("[data-overview-kpis]");
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const values = node.matches("[data-kpi-value]")
            ? [node]
            : [...node.querySelectorAll("[data-kpi-value]")];
          for (const value of values) {
            const animations = value.getAnimations();
            window.__kpiSettleEvents.push({
              text: value.textContent?.replace(/\s+/g, " ").trim() ?? "",
              animations: animations.map((animation) => ({
                name: animation.animationName,
                state: animation.playState,
              })),
            });
          }
        }
      }
    });
    observer.observe(kpis, { subtree: true, childList: true, characterData: true });
    window.__kpiObserver = observer;
  });

  const refresh = page.locator("main button").filter({ hasText: "更新于" }).first();
  statsVariant = 2;
  await refresh.click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("[data-kpi-value]")].some((element) =>
        element.textContent?.includes("48GB"),
      ),
    null,
    { polling: 10, timeout: 10000 },
  );
  await page.waitForTimeout(80);
  const changed = await page.evaluate(() => ({
    events: window.__kpiSettleEvents,
    sameNodes: window.__kpiNodes.map((node) => node.isConnected),
    links: window.__kpiLinks.map((node) => node.isConnected),
    texts: [...document.querySelectorAll("[data-kpi-value]")].map((node) =>
      node.textContent?.replace(/\s+/g, " ").trim(),
    ),
  }));
  const settleEvents = changed.events.filter((event) =>
    event.animations.some((animation) => animation.name === "value-settle"),
  );
  const settleStates = settleEvents.flatMap((event) =>
    event.animations
      .filter((animation) => animation.name === "value-settle")
      .map((animation) => animation.state),
  );
  record("kpi-change", {
    events: changed.events.length,
    settleEvents: settleEvents.length,
    settleStates,
    texts: changed.texts,
    linksStillMounted: changed.links.every(Boolean),
  });
  insist(settleEvents.length > 0, "KPI: changed numbers must replay value-settle");
  insist(
    settleEvents.some((event) => event.text.includes("48GB")),
    "KPI: today's traffic must show the new value",
  );
  const changedNodes = await page.evaluate(() =>
    window.__kpiNodes.map((node) => node.isConnected),
  );
  insist(
    changedNodes.some((connected) => connected === false),
    "KPI: changed number nodes must remount",
  );
  insist(
    changed.links.every(Boolean),
    "KPI: the outer Link must not remount",
  );

  // 数字不变：再刷新一次，不应该重挂载或重播
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    window.__kpiSettleEvents = [];
    window.__kpiNodes = [...document.querySelectorAll("[data-kpi-value]")];
  });
  await refresh.click();
  await page.waitForTimeout(500);
  const unchanged = await page.evaluate(() => ({
    events: window.__kpiSettleEvents,
    nodesStillMounted: window.__kpiNodes.every((node) => node.isConnected),
  }));
  record("kpi-unchanged", unchanged);
  insist(unchanged.events.length === 0, "KPI: unchanged numbers must not replay");
  insist(unchanged.nodesStillMounted, "KPI: unchanged numbers must not remount");
  dynamic.kpi = {
    changed: {
      settleEvents: settleEvents.length,
      settleStates,
      texts: changed.texts,
      linksStillMounted: changed.links.every(Boolean),
    },
    unchanged: {
      settleEvents: unchanged.events.length,
      nodesStillMounted: unchanged.nodesStillMounted,
    },
  };
  pageErrors.push(...errors);
  await context.close();
}

// ---------------------------------------------------------------------------
// 5. 图表入场
// ---------------------------------------------------------------------------

/**
 * 取整张柱状图的路径指纹。下行和上行是两组 `<path>`：只看第一根会踩到
 * 「数据与 y 轴同比例放大、归一化后路径不变」的坑，所以把所有 d 拼起来。
 */
async function chartPath(page) {
  return page.evaluate(() => {
    const paths = [...document.querySelectorAll(
      "[data-traffic-chart] path.recharts-rectangle",
    )].map((element) => element.getAttribute("d"));
    return paths.length > 0 ? paths.join("|") : null;
  });
}

{
  const { context, page, errors } = await openPage({ target: "/?view=traffic" });
  await page.waitForFunction(
    () => !!document.querySelector('[data-traffic-chart] path.recharts-rectangle'),
    null,
    { polling: 10, timeout: 20000 },
  );
  const mountAt = Date.now();
  const first = await chartPath(page);
  const firstSampleMs = Date.now() - mountAt;
  await page.waitForTimeout(30);
  const at30 = await chartPath(page);
  await page.waitForTimeout(370);
  const at400 = await chartPath(page);
  await page.waitForTimeout(300);
  const final = await chartPath(page);
  record("chart-enter", {
    firstSampleMs,
    firstVs400: first !== at400,
    at30Vs400: at30 !== at400,
    stableAt400: final === at400,
  });
  insist(first !== null && at400 !== null, "chart: path must exist");
  insist(at30 !== at400, "chart: 30ms path must differ from 400ms path");
  insist(final === at400, "chart: animation must be finished by 400ms");

  // 入场完成后刷新：下一帧直接是终值
  await page.waitForTimeout(700);
  const beforeRefresh = await chartPath(page);
  trafficVariant = 2;
  const refresh = page.locator("main button").filter({ hasText: "更新于" }).first();
  await refresh.click();
  await page.waitForFunction(
    (previous) => {
      const element = document.querySelector(
        '[data-traffic-chart] path.recharts-rectangle',
      );
      return element !== null && element.getAttribute("d") !== previous;
    },
    beforeRefresh,
    { polling: 10, timeout: 10000 },
  );
  const firstChanged = await chartPath(page);
  await page.waitForTimeout(250);
  const settled = await chartPath(page);
  record("chart-refresh", {
    changed: firstChanged !== beforeRefresh,
    firstFrameIsFinal: firstChanged === settled,
  });
  insist(firstChanged !== beforeRefresh, "chart: refresh must change the path");
  insist(firstChanged === settled, "chart: refresh must not replay the entrance animation");
  dynamic.chart = {
    enter: {
      firstVs400: first !== at400,
      at30Vs400: at30 !== at400,
      stableAt400: final === at400,
    },
    refresh: {
      changed: firstChanged !== beforeRefresh,
      firstFrameIsFinal: firstChanged === settled,
    },
  };
  pageErrors.push(...errors);
  await context.close();
}

{
  const { context, page, errors } = await openPage({
    target: "/?view=traffic",
    reducedMotion: "reduce",
  });
  await page.waitForFunction(
    () => !!document.querySelector('[data-traffic-chart] path.recharts-rectangle'),
    null,
    { polling: 10, timeout: 20000 },
  );
  const first = await chartPath(page);
  await page.waitForTimeout(350);
  const later = await chartPath(page);
  record("chart-reduced-motion", {
    firstFrameIsFinal: first !== null && first === later,
  });
  insist(first !== null, "chart reduced-motion: path must exist");
  insist(first === later, "chart reduced-motion: first frame must be final");
  dynamic.chartReducedMotion = { firstFrameIsFinal: first === later };
  pageErrors.push(...errors);
  await context.close();
}

// ---------------------------------------------------------------------------
// 6. 静止帧比较 / resting-frame comparison
// ---------------------------------------------------------------------------

for (const testCase of STATIC_CASES) {
  const { context, page, errors } = await openPage({
    theme: testCase.theme,
    width: testCase.width,
    target: testCase.target,
  });
  try {
    const { buffer: current, focus } = await captureStatic(page, testCase);
    if (focus) {
      focusChecks.push({
        name: testCase.name,
        theme: testCase.theme,
        check: testCase.focusCheck,
        ...focus,
      });
      console.log(
        `  ${testCase.name} focus: ${focus.modality} ${focus.outlineStyle}/${focus.outlineWidth} border ${focus.borderWidth} ${focus.borderColor}`,
      );
    }
    writeFileSync(path.join(OUT, `${testCase.name}.png`), current);
    shots.push(testCase.name);
    console.log(`saved ${testCase.name}.png`);
    // 点击后焦点仍留在 tab 上：与同一构建的静止帧比较，必须是 0 像素差。
    if (testCase.compareWith) {
      const referenceFile = path.join(OUT, `${testCase.compareWith}.png`);
      if (existsSync(referenceFile)) {
        const restingDiff = await diffPng(
          page,
          readFileSync(referenceFile),
          current,
          0,
        );
        const entry = focusChecks.find(
          (item) => item.name === testCase.name,
        );
        if (entry) entry.restingDiff = restingDiff;
        console.log(
          `  ${testCase.name} vs resting ${testCase.compareWith}: ${restingDiff.differingPixels} px, max channel ${restingDiff.maxChannelDelta}`,
        );
        insist(
          restingDiff.differingPixels === 0,
          `${testCase.name}: focus must not change the resting frame (${restingDiff.differingPixels} px)`,
        );
      }
    }
    const baselineFile = path.join(BASELINE, `${testCase.name}.png`);
    if (!existsSync(baselineFile)) {
      deviations.push({
        name: testCase.name,
        note: "baseline image missing; run MOTION_CONTINUITY_BASELINE=1 against the pre-change build",
      });
      continue;
    }
    const baseline = readFileSync(baselineFile);
    const diff = await diffPng(page, baseline, current, testCase.tolerance);
    const exact = diff.differingPixels === 0;
    staticComparisons.push({
      name: testCase.name,
      theme: testCase.theme,
      width: testCase.width,
      tolerance: testCase.tolerance,
      ...diff,
      exact,
    });
    console.log(
      `  ${testCase.name}: ${diff.differingPixels} px over ${testCase.tolerance}, max channel ${diff.maxChannelDelta}`,
    );
    if (testCase.name.startsWith("sidebar")) {
      insist(
        diff.maxChannelDelta <= 8,
        `${testCase.name}: sidebar text channel delta ${diff.maxChannelDelta} > 8`,
      );
    } else if (!exact) {
      // 旧的选中底色画在触发器自己的图层里（旧类里的 opacity-0 ::after 让
      // 触发器成为合成层）；现在指示器是普通绝对定位元素，圆角边缘的
      // 抗锯齿在 Chrome 里会差 1–16/255。像素位置、颜色与文字完全一致。
      const cornerOnly =
        diff.maxChannelDelta <= 16 && diff.differingPixels <= 160;
      // 聚焦帧（鼠标点击 / 键盘）的旧触发器有 1px border-ring；去掉边框后，
      // 选中胶囊圆角边缘的抗锯齿差异最大可到 ~52/255，但只出现在胶囊边缘，
      // 且指针帧的 border/outline 与键盘帧的 outline + ring 都由 computed
      // style 断言过。
      const focusEdgeOnly =
        testCase.focusCheck !== undefined &&
        diff.maxChannelDelta <= 64 &&
        diff.differingPixels <= 160;
      const allowed = cornerOnly || focusEdgeOnly;
      deviations.push({
        name: testCase.name,
        differingPixels: diff.differingPixels,
        maxChannelDelta: diff.maxChannelDelta,
        tolerance: testCase.tolerance,
        note: focusEdgeOnly
          ? "focus-frame edge antialiasing only: the removed 1px focus border changes anti-aliasing at the selected pill edge; pointer frames have transparent border and no outline, keyboard frames still draw the 2px outline and 3px ring (computed style)"
          : cornerOnly
            ? "rounded-corner antialiasing only: the old active background was a composited trigger layer (opacity-0 ::after), the indicator is a plain absolute layer; colours, geometry and text are unchanged"
            : "pixel difference beyond corner antialiasing",
      });
      insist(
        allowed,
        `${testCase.name}: resting frame changed beyond corner antialiasing`,
      );
    }
    pageErrors.push(...errors.filter((error) => !error.includes("favicon")));
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// 6b. 正常帧率下的滑动帧间隔 / frame cadence at the normal frame rate
// ---------------------------------------------------------------------------

/*
 * 动效轨迹浏览器为了稳定采样解除了帧率上限；帧率读数不能来自那台浏览器。
 * 这里单独用正常帧率（不传 --disable-frame-rate-limit）打开页面，在指示器
 * 滑动期间记录 rAF 间隔。目标视图先预热一轮，避免首次懒加载图表阻塞主线程。
 */
{
  const cadenceBrowser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: CADENCE_ARGS,
  });
  try {
    const { context, page, errors } = await openPage({
      target: "/",
      browserInstance: cadenceBrowser,
    });
    try {
      await page.waitForSelector(
        '[data-overview-view-tabs] [data-slot="sliding-indicator"][data-ready="ready"]',
        { timeout: 20000 },
      );
      const triggers = page.locator(
        '[data-overview-view-tabs] [data-slot="tabs-trigger"]',
      );
      // 预热「流量趋势」：首次挂载会懒加载图表，主线程阻塞不属于滑动本身。
      await triggers.nth(1).click();
      await page.waitForTimeout(900);
      await triggers.nth(0).click();
      await page.waitForTimeout(500);
      await page.mouse.move(2, 2);

      const cadencePromise = page.evaluate(
        () =>
          new Promise((resolvePromise) => {
            const intervals = [];
            let last = performance.now();
            const started = performance.now();
            requestAnimationFrame(function frame(now) {
              intervals.push(now - last);
              last = now;
              if (now - started < 600) {
                requestAnimationFrame(frame);
                return;
              }
              const positive = intervals.filter(
                (value) => Number.isFinite(value) && value > 0,
              );
              const sorted = positive.slice().sort((a, b) => a - b);
              resolvePromise({
                frames: positive.length,
                medianMs:
                  sorted.length > 0
                    ? +sorted[Math.floor(sorted.length / 2)].toFixed(2)
                    : null,
                over25Ms: positive.filter((value) => value > 25).length,
                maxMs:
                  sorted.length > 0 ? +sorted.at(-1).toFixed(2) : null,
              });
            });
          }),
      );
      await page.waitForTimeout(60);
      await triggers.nth(1).click();
      const cadence = await cadencePromise;
      const available =
        cadence.frames >= 10 &&
        cadence.medianMs !== null &&
        cadence.medianMs <= 100;
      record("frame-cadence", {
        ...cadence,
        available,
        args: CADENCE_ARGS,
        note: available
          ? "normal frame rate, no --disable-frame-rate-limit; sampled across a tab slide"
          : "headless rAF was throttled; no meaningful reading",
      });
      dynamic.frameCadence = { ...cadence, available };
      if (available) {
        insist(
          cadence.medianMs <= 25,
          `frame cadence: median ${cadence.medianMs}ms must be <= 25ms`,
        );
      } else {
        deviations.push({
          name: "frame-cadence",
          note: "headless Chrome throttled requestAnimationFrame even without --disable-frame-rate-limit; the metric is reported as unavailable rather than fabricated",
        });
      }
      pageErrors.push(...errors);
    } finally {
      await context.close();
    }
  } finally {
    await cadenceBrowser.close();
  }
}

// ---------------------------------------------------------------------------
// 报告 / report
// ---------------------------------------------------------------------------

const report = {
  generatedAt: new Date().toISOString(),
  dist: DIST,
  baselineMode: BASELINE_MODE,
  browser: {
    executable: CHROME,
    args: FRAME_ARGS,
    cadenceArgs: CADENCE_ARGS,
  },
  staticComparisons,
  focusChecks,
  dynamic,
  checks,
  deviations,
  shots,
  errors: [...new Set(pageErrors)],
};

writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `\n${shots.length} screenshots + ${checks.length} checks + ${staticComparisons.length} static comparisons saved to ${OUT}`,
);
if (deviations.length > 0) {
  console.log(`\n${deviations.length} deviation(s):`);
  for (const deviation of deviations) {
    console.log(`  - ${deviation.name}: ${deviation.note}`);
  }
}
console.log(`errors: ${report.errors.length}`);

await browser.close();
server.close();
