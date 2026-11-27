// 「节点分布」世界地图卡的截图 + 运行时断言。
//
// 前置：`cd web && npm run build`（脚本自己起静态服务器，不需要主控 / 数据库）。
// 用法：node web/scripts/shots-world-map.mjs
//
// 覆盖：资源状态视图里的位置（KPI 与「服务器 × 时间」之间）、1440/390 × 亮暗、
// 四档填充、质心圆点（3/4/5/6px、离线 / 降级状态色、N 标签）、hover / 聚焦、
// 图例、tooltip、小地区 HK / SG 可见且可点、鼠标点击与键盘 Enter 跳
// `/servers?country=`、服务器页地区 chip / 过滤 / 空态、地图空态、390 无横向
// 溢出、地图上下留白、四档对海洋的对比度、JSON 体积。
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = resolve(WEB, "..");
const BUILD_DIST = resolve(WEB, "dist");
/** 运行期用 dist 的快照，避免并行 lane 重新 build 时把静态资源换掉。 */
let DIST = BUILD_DIST;
const OUT = resolve(WEB, "screenshots/world-map");
const BEFORE = resolve(OUT, "before");
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAP_JSON = resolve(WEB, "src/lib/worldMapPaths.json");
const MAP_KEYS = Object.keys(JSON.parse(readFileSync(MAP_JSON, "utf8")));
/** 完整投影坐标系宽度；组件把 viewBox 纵向裁到 lat +78°..-56°。 */
const VIEW_WIDTH = 1000;
const HOUR = 3600;
const NOW = Math.floor(Date.now() / 1000);
const END = Math.floor(NOW / HOUR) * HOUR;
const START = END - 167 * HOUR;

mkdirSync(OUT, { recursive: true });

/**
 * Playwright 不在 web 的依赖里：优先 `PLAYWRIGHT_MODULE`，其次仓库内
 * `.npm-cache/_npx` 里安装的那份，最后回退到 `import("playwright")`。
 */
async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) {
    candidates.push(process.env.PLAYWRIGHT_MODULE);
  }
  const npxRoot = resolve(ROOT, ".npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(
        resolve(npxRoot, entry, "node_modules", "playwright", "index.mjs"),
      );
    }
  }
  candidates.push("playwright");
  for (const candidate of candidates) {
    try {
      if (candidate !== "playwright" && !existsSync(candidate)) continue;
      return await import(
        candidate === "playwright" ? "playwright" : pathToFileURL(candidate).href
      );
    } catch {
      // 继续尝试下一个候选路径。
    }
  }
  throw new Error("Playwright not found; set PLAYWRIGHT_MODULE or run npx playwright");
}

const { chromium } = await loadPlaywright();

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * 8 个国家 / 22 个节点，覆盖 4 档 fill 与两种描边：
 *   US 8（1 离线）→ 7+、destructive
 *   JP 5（1 异常）→ 4–6、warning
 *   DE 3 / FR 2   → 2–3
 *   CA / GB / AU  → 1、online
 *   BR 1（异常）  → 1、warning
 */
const COUNTRY_PLAN = [
  { code: "US", names: ["美西-01", "美西-02", "美东-01", "美东-02", "美中-01", "美中-02", "美南-01", "美南-02"], offline: 1, abnormal: 0, group: "北美" },
  { code: "JP", names: ["东京-01", "东京-02", "大阪-01", "大阪-02", "名古屋-01"], offline: 0, abnormal: 1, group: "日本" },
  { code: "DE", names: ["法兰克福-01", "法兰克福-02", "柏林-01"], offline: 0, abnormal: 0, group: "欧洲" },
  { code: "FR", names: ["巴黎-01", "马赛-01"], offline: 0, abnormal: 0, group: "欧洲" },
  { code: "CA", names: ["多伦多-01"], offline: 0, abnormal: 0, group: "北美" },
  { code: "GB", names: ["伦敦-01"], offline: 0, abnormal: 0, group: "欧洲" },
  { code: "BR", names: ["圣保罗-01"], offline: 0, abnormal: 1, group: "南美" },
  { code: "AU", names: ["悉尼-01"], offline: 0, abnormal: 0, group: "大洋洲" },
];

function buildServers({
  emptyNodes = false,
  emptyCountry = null,
  onlyCountry = null,
  smallRegions = false,
} = {}) {
  const items = [];
  let index = 0;
  for (const plan of COUNTRY_PLAN) {
    for (let n = 0; n < plan.names.length; n += 1) {
      index += 1;
      const offline = n < plan.offline;
      const abnormal = !offline && n < plan.offline + plan.abnormal;
      items.push({
        id: `srv-${index}`,
        name: plan.names[n],
        address: `10.10.0.${index}`,
        xray_mode: "auto",
        status: offline ? "offline" : "online",
        last_seen_at: offline ? NOW - 7 * HOUR : NOW - 30,
        config_version: 3,
        created_at: NOW - 30 * 86400,
        group_name: plan.group,
        agent_version: "0.16.2",
        allow_agent_upgrade: false,
        agent_target_version: null,
        xray_running: offline ? null : !abnormal,
        nginx_running: offline ? null : true,
        load1: offline ? null : abnormal ? 5.2 : 0.4,
        mem_used: offline ? null : 5 * 1024 ** 3,
        mem_total: offline ? null : 8 * 1024 ** 3,
        disk_used: offline ? null : 45 * 1024 ** 3,
        disk_total: offline ? null : 80 * 1024 ** 3,
        uptime_secs: offline ? null : 20 * 86400,
        latency_ms: offline ? null : 30 + index,
        health_at: offline ? null : NOW - 30,
        arch: "x86_64",
        os_name: "Ubuntu",
        os_version: "24.04",
        virt: "kvm",
        country_code: emptyNodes ? null : emptyCountry ?? plan.code,
        paid_until: null,
        price_cents: null,
        currency: null,
        billing_cycle: null,
        billing_cycle_count: null,
        billing_cycle_unit: null,
      });
    }
  }
  if (smallRegions) {
    // HK / SG 在 110m 里没有轮廓，由 50m 补齐；给 SG 两台，顺带验证 N 标签。
    const base =
      items.find((server) => server.status === "online") ?? items[0];
    return base
      ? [
          { ...base, id: "srv-hk", name: "香港-01", country_code: "HK" },
          { ...base, id: "srv-sg-1", name: "新加坡-01", country_code: "SG" },
          { ...base, id: "srv-sg-2", name: "新加坡-02", country_code: "SG" },
        ]
      : [];
  }
  if (onlyCountry) {
    // 用一台服务器演示指定地区（HK 不在 110m 轮廓里，由 50m 补齐）。
    const first = items[0];
    return first
      ? [{ ...first, name: "香港-01", country_code: onlyCountry }]
      : [];
  }
  return items;
}

function buildHealth(servers) {
  const buckets = (server) =>
    Array.from({ length: 168 }, (_, i) => {
      const online = server.status === "online";
      return {
        ts: START + i * HOUR,
        online,
        online_ratio: online ? 1 : 0,
        load1: online ? server.load1 ?? 0.4 : null,
        mem_ratio: online ? 0.62 : null,
        disk_ratio: online ? 0.55 : null,
        samples: 12,
      };
    });
  return {
    generated_at: NOW,
    hours: 168,
    bucket: HOUR,
    summary: {
      online_ratio_24h: 0.96,
      abnormal_servers: servers.filter(
        (server) => server.status === "offline" || !server.xray_running,
      ).length,
      worst_disk_ratio: 0.55,
    },
    servers: servers.map((server) => ({
      id: server.id,
      name: server.name,
      online_ratio: server.status === "offline" ? 0 : 1,
      buckets: buckets(server),
    })),
  };
}

const STATS = {
  servers: { total: 22, online: 21 },
  users: { total: 5, active: 5 },
  packages: { total: 2, instances: 3 },
  traffic: { today_bytes: 32 * 1024 ** 3, month_bytes: 254 * 1024 ** 3 },
  alerts: {
    expired_instances: 0,
    exhausted_instances: 0,
    offline_servers: 1,
    expiring_certs: 0,
  },
};

const TRAFFIC_DAYS = Array.from({ length: 7 }, (_, index) => ({
  date: `2026-11-${16 + index}`,
  uplink: (index + 2) * 1024 ** 3,
  downlink: (index + 5) * 1024 ** 3,
  weighted: (index + 7) * 1024 ** 3,
}));

const AGGREGATE = {
  kpi: {
    servers_online: 21,
    servers_total: 22,
    nodes: 22,
    traffic_today: 32 * 1024 ** 3,
    traffic_month: 254 * 1024 ** 3,
    uptime_24h: 96.4,
  },
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
};

const SETTINGS = {
  panel_name: "PierWave",
  login_max_attempts: 5,
  login_lock_secs: 600,
  session_ttl_hours: 72,
  agent_upgrade_concurrency: 1,
  public_status_enabled: 1,
  public_billing_visible: 1,
  fx_rates: "",
  fx_rates_updated_at: 0,
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function handleApi(route, scenario) {
  const url = new URL(route.request().url());
  const path = url.pathname;
  const servers = buildServers(scenario);

  if (path === "/api/v1/auth/me") {
    return json(route, {
      user: { id: "u-admin", username: "admin", role: "admin", short_code: "AD" },
    });
  }
  if (path === "/api/v1/health") {
    return json(route, { status: "ok", version: "0.16.2", panel_name: "PierWave" });
  }
  if (path === "/api/v1/settings") {
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
        versions: [{ version: "0.16.2", count: servers.length }],
      },
    });
  }
  if (path === "/api/v1/servers") {
    return json(route, { items: servers });
  }
  if (path === "/api/v1/nodes") {
    return json(route, {
      items: [],
      total: 0,
      page: 1,
      per_page: 200,
    });
  }
  if (path === "/api/v1/overview/server-health") {
    const ids =
      url.searchParams
        .get("server_ids")
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean) ?? [];
    const scoped =
      ids.length > 0
        ? servers.filter((server) => ids.includes(server.id))
        : servers;
    return json(route, buildHealth(scoped));
  }
  if (path === "/api/v1/overview") {
    return json(route, AGGREGATE);
  }
  if (path === "/api/v1/stats/overview") {
    return json(route, STATS);
  }
  if (path === "/api/v1/stats/traffic") {
    return json(route, { days: TRAFFIC_DAYS });
  }
  if (path === "/api/v1/chains") {
    return json(route, { items: [] });
  }
  if (path === "/api/v1/enforcement/events") {
    return json(route, { items: [] });
  }
  return json(route, { error: "not found", code: "not_found" }, 404);
}

/**
 * 复制一份 `web/dist` 快照再起静态服务器。并行 lane 可能在同一时刻 rebuild，
 * 直接服务 dist 会偶发 404 / 页面半截（截图脚本会 timeout）。
 */
async function snapshotDist() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const directory = mkdtempSync(resolve(tmpdir(), "pierwave-world-map-"));
    try {
      cpSync(BUILD_DIST, directory, { recursive: true });
      const html = readFileSync(resolve(directory, "index.html"), "utf8");
      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((match) => match[1])
        .filter((url) => url.startsWith("/assets/"))
        .map((url) => resolve(directory, url.slice(1)));
      if (assets.length > 0 && assets.every((file) => existsSync(file))) {
        return directory;
      }
    } catch {
      // build 正在写 dist；等下一轮再试。
    }
    rmSync(directory, { recursive: true, force: true });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("web/dist looks incomplete; run npm run build first");
}

function startStaticServer() {
  const prefix = DIST.endsWith(sep) ? DIST : `${DIST}${sep}`;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    let file = resolve(DIST, relative || "index.html");
    if (file !== DIST && !file.startsWith(prefix)) {
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

const report = {
  generatedAt: new Date().toISOString(),
  shots: [],
  checks: [],
  errors: [],
  metrics: {},
};

function check(name, condition, detail) {
  try {
    assert.ok(condition, detail);
    report.checks.push({ name, ok: true, detail: detail ?? null });
  } catch (error) {
    report.checks.push({ name, ok: false, detail: `${error.message}` });
    report.errors.push(`${name}: ${error.message}`);
  }
}

async function openPage(browser, base, { theme, locale = "zh-CN", width, height }) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.addInitScript(
    ({ theme, locale }) => {
      try {
        localStorage.setItem("pierwave.theme", theme);
        localStorage.setItem("pierwave.locale", locale);
      } catch {
        // ignore
      }
    },
    { theme, locale },
  );
  return { page, consoleErrors };
}

async function waitForMap(page) {
  await page.waitForSelector("[data-world-map]", { timeout: 30_000 });
  await page.waitForSelector("[data-world-map] [data-country]", {
    timeout: 30_000,
  });
  await page.waitForTimeout(120);
}

async function assertNoOverflow(page, label) {
  const metrics = await page.evaluate(() => {
    const main = document.querySelector("#main-content");
    const doc = document.documentElement;
    return {
      viewport: window.innerWidth,
      docScroll: doc.scrollWidth,
      bodyScroll: document.body.scrollWidth,
      mainClient: main?.clientWidth ?? null,
      mainScroll: main?.scrollWidth ?? null,
    };
  });
  check(
    `${label}: 390 / 视口无横向溢出`,
    metrics.docScroll <= metrics.viewport + 1 &&
      metrics.bodyScroll <= metrics.viewport + 1 &&
      (metrics.mainScroll === null ||
        metrics.mainClient === null ||
        metrics.mainScroll <= metrics.mainClient + 1),
    JSON.stringify(metrics),
  );
  return metrics;
}

async function capture(page, name) {
  const file = `${name}.png`;
  await page.screenshot({
    path: resolve(OUT, file),
    animations: "disabled",
  });
  report.shots.push({ name, file });
  return file;
}

async function captureCard(page, name) {
  const file = `${name}.png`;
  await page.locator("[data-world-map]").screenshot({
    path: resolve(OUT, file),
    animations: "disabled",
  });
  report.shots.push({ name, file });
  return file;
}

/**
 * 地图卡的渲染度量：路径 / 档位 / 质心圆点 / 图例 / 留白。
 * 圆点半径与文字按屏幕像素记录（SVG 用 viewBox 单位，需乘 scale）。
 */
async function mapMetrics(page) {
  return page.evaluate((viewWidth) => {
    const cardEl = document.querySelector("[data-world-map]");
    const svg = document.querySelector("[data-world-map-svg]");
    const legendEl = document.querySelector("[data-world-map-legend]");
    const card = cardEl.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const legend = legendEl.getBoundingClientRect();
    const paths = [
      ...document.querySelectorAll("[data-world-map] [data-country]"),
    ];
    const scale = svgRect.width / viewWidth;

    const marker = (code) => {
      const group = document.querySelector(
        `[data-world-map-marker="${code}"]`,
      );
      const dot = group?.querySelector("[data-world-map-dot]");
      const label = group?.querySelector("[data-world-map-count]");
      const dotRect = dot?.getBoundingClientRect();
      const labelRect = label?.getBoundingClientRect();
      const radius = dot ? Number(dot.getAttribute("r")) : null;
      const font = label ? parseFloat(getComputedStyle(label).fontSize) : null;
      return {
        exists: Boolean(group),
        fillClass: dot?.getAttribute("class") ?? "",
        fill: dot ? getComputedStyle(dot).fill : null,
        stroke: dot ? getComputedStyle(dot).stroke : null,
        radius,
        screenRadius: radius === null ? null : radius * scale,
        dotWidth: dotRect?.width ?? null,
        dotRight: dotRect?.right ?? null,
        label: label?.textContent ?? null,
        labelFont: font === null ? null : font * scale,
        labelLeft: labelRect?.left ?? null,
        labelRight: labelRect?.right ?? null,
        labelTop: labelRect?.top ?? null,
        labelBottom: labelRect?.bottom ?? null,
      };
    };

    const markers = {};
    for (const path of paths) {
      const code = path.getAttribute("data-country");
      if (path.getAttribute("data-tier") === "none") continue;
      markers[code] = marker(code);
    }

    const pathByCountry = new Map(
      paths.map((path) => [path.getAttribute("data-country"), path]),
    );
    const tier = (code) => pathByCountry.get(code)?.getAttribute("data-tier") ?? null;
    const worst = (code) =>
      pathByCountry.get(code)?.getAttribute("data-worst") ?? null;
    const classes = (code) => pathByCountry.get(code)?.getAttribute("class") ?? "";
    const fill = (code) =>
      pathByCountry.get(code)
        ? getComputedStyle(pathByCountry.get(code)).fill
        : null;

    let contentTop = Infinity;
    let contentBottom = -Infinity;
    for (const path of paths) {
      const rect = path.getBoundingClientRect();
      contentTop = Math.min(contentTop, Math.max(rect.top, svgRect.top));
      contentBottom = Math.max(
        contentBottom,
        Math.min(rect.bottom, svgRect.bottom),
      );
    }

    const legendItem = (selector) => {
      const item = legendEl.querySelector(selector);
      const swatch = item?.querySelector('[aria-hidden="true"]');
      const rect = swatch?.getBoundingClientRect();
      return {
        exists: Boolean(item),
        text: item?.textContent ?? null,
        width: rect?.width ?? null,
        height: rect?.height ?? null,
      };
    };

    return {
      pathCount: paths.length,
      nodeCountries: paths.filter(
        (path) => path.getAttribute("data-tier") !== "none",
      ).length,
      tiers: Object.fromEntries(
        ["US", "JP", "DE", "FR", "CA"].map((code) => [code, tier(code)]),
      ),
      worst: Object.fromEntries(
        ["US", "JP", "BR", "DE"].map((code) => [code, worst(code)]),
      ),
      fills: Object.fromEntries(
        ["CA", "DE", "JP", "US", "NZ"].map((code) => [code, fill(code)]),
      ),
      classes: Object.fromEntries(
        ["US", "JP", "DE", "FR", "CA"].map((code) => [code, classes(code)]),
      ),
      focusable: paths
        .filter((path) => path.getAttribute("data-tier") !== "none")
        .every((path) => path.getAttribute("tabindex") === "0"),
      noNodeFocusable: paths
        .filter((path) => path.getAttribute("data-tier") === "none")
        .every((path) => !path.hasAttribute("tabindex")),
      markers,
      svg: {
        width: svgRect.width,
        height: svgRect.height,
        top: svgRect.top,
        bottom: svgRect.bottom,
      },
      card: {
        width: card.width,
        height: card.height,
        top: card.top,
        bottom: card.bottom,
        right: card.right,
      },
      gaps: {
        top: contentTop - card.top,
        bottom: card.bottom - contentBottom,
        svgInsetTop: contentTop - svgRect.top,
        svgInsetBottom: svgRect.bottom - contentBottom,
      },
      legend: {
        text: legendEl.textContent ?? "",
        fontSize: parseFloat(getComputedStyle(legendEl).fontSize),
        width: legend.width,
        height: legend.height,
        top: legend.top,
        right: legend.right,
        bottom: legend.bottom,
        tier0: legendItem('[data-world-map-legend-tier="0"]'),
        tier3: legendItem('[data-world-map-legend-tier="3"]'),
        offline: legendItem("[data-world-map-legend-offline]"),
        abnormal: legendItem("[data-world-map-legend-abnormal]"),
        belowMap: legend.top >= svgRect.bottom - 1,
      },
      empty: Boolean(document.querySelector("[data-world-map-empty]")),
    };
  }, VIEW_WIDTH);
}

/**
 * 四档填充对海洋（卡片底色）的对比度。用 1×1 canvas 先铺卡片色、再叠填充色，
 * 直接读合成后的像素，避免在脚本里复刻 oklab / oklch 解析。
 */
async function measureContrast(page) {
  return page.evaluate(() => {
    const card = document.querySelector("[data-world-map]");
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2d canvas unavailable");
    const read = () => [...ctx.getImageData(0, 0, 1, 1).data];
    const pixel = (color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return read();
    };
    const over = (background, color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return read();
    };
    const luminance = ([r, g, b]) => {
      const channel = (value) => {
        const normalized = value / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const ratio = (a, b) => {
      const first = luminance(a);
      const second = luminance(b);
      return (
        (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
      );
    };

    const cardColor = getComputedStyle(card).backgroundColor;
    const cardPixel = pixel(cardColor);
    const entries = {};
    for (const code of ["CA", "DE", "JP", "US", "NZ"]) {
      const path = document.querySelector(`[data-country="${code}"]`);
      const fill = getComputedStyle(path).fill;
      const composited = over(cardColor, fill);
      entries[code] = {
        fill,
        rgb: composited.slice(0, 3),
        ratio: ratio(composited, cardPixel),
      };
    }
    return {
      cardColor,
      cardRgb: cardPixel.slice(0, 3),
      entries,
    };
  });
}

/** 改前 / 改后并排对照图（1440 亮暗各一张）。 */
async function captureCompare(browser) {
  for (const theme of ["dark", "light"]) {
    const beforeFile = resolve(
      BEFORE,
      `before-world-map-${theme}-1440.png`,
    );
    const afterFile = resolve(OUT, `world-map-${theme}-1440.png`);
    if (!existsSync(beforeFile) || !existsSync(afterFile)) {
      report.errors.push(`compare ${theme}: missing before/after image`);
      continue;
    }
    const before = readFileSync(beforeFile).toString("base64");
    const after = readFileSync(afterFile).toString("base64");
    const background = theme === "dark" ? "#0b0b0d" : "#f4f5f7";
    const foreground = theme === "dark" ? "#e7e7ea" : "#1c1d22";
    const muted = theme === "dark" ? "#9b9ba3" : "#5c5d66";
    const border = theme === "dark" ? "#2a2a2f" : "#e2e3e7";
    const page = await browser.newPage({
      viewport: { width: 1260, height: 700 },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"></head>` +
        `<body style="margin:0;background:${background};color:${foreground};` +
        `font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif">` +
        `<main style="padding:24px 24px 20px">` +
        `<p style="margin:0 0 12px;font-size:13px;color:${muted};letter-spacing:.02em">` +
        `节点分布世界地图 · 1440 ${theme === "dark" ? "暗色 / Dark" : "亮色 / Light"}</p>` +
        `<div style="display:flex;gap:24px;align-items:flex-start">` +
        `<figure style="margin:0;flex:0 0 580px">` +
        `<figcaption style="margin:0 0 8px;font-size:14px;font-weight:600">改前 / Before</figcaption>` +
        `<img alt="before" src="data:image/png;base64,${before}" style="display:block;width:580px;border-radius:8px;border:1px solid ${border}">` +
        `</figure>` +
        `<figure style="margin:0;flex:0 0 580px">` +
        `<figcaption style="margin:0 0 8px;font-size:14px;font-weight:600">改后 / After</figcaption>` +
        `<img alt="after" src="data:image/png;base64,${after}" style="display:block;width:580px;border-radius:8px;border:1px solid ${border}">` +
        `</figure></div></main></body></html>`,
      { waitUntil: "load" },
    );
    // 等两张 data URI 图片真正 decode 完再量高度；否则会按未加载时的
    // 高度截一张「首屏 + 滚动后首屏」的重复图。
    await page.evaluate(() =>
      Promise.all(
        [...document.images].map((image) =>
          image.decode().catch(() => undefined),
        ),
      ),
    );
    const height = await page.evaluate(() =>
      Math.ceil(document.body.scrollHeight),
    );
    await page.setViewportSize({ width: 1260, height: Math.max(height, 200) });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(50);
    const file = `compare-${theme}-1440.png`;
    await page.screenshot({
      path: resolve(OUT, file),
      clip: { x: 0, y: 0, width: 1260, height },
      animations: "disabled",
    });
    report.shots.push({ name: `compare-${theme}-1440`, file });
    check(
      `对比图 ${theme}: 改前 / 改后并排生成`,
      height > 200,
      `${height}px`,
    );
    await page.close();
  }
}

DIST = await snapshotDist();
const { server: staticServer, port } = await startStaticServer();
const BASE = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
});

try {
  // ---- 1. 1440 亮暗：地图卡 + 概览位置 ----------------
  for (const [theme, width] of [
    ["dark", 1440],
    ["light", 1440],
    ["dark", 390],
    ["light", 390],
  ]) {
    const { page, consoleErrors } = await openPage(browser, BASE, {
      theme,
      width,
      height: width === 390 ? 844 : 900,
    });
    const scenario = { emptyNodes: false };
    await page.route("**/api/v1/**", (route) => handleApi(route, scenario));
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await waitForMap(page);

    const layout = await page.evaluate(() => {
      const kpi = document.querySelector("[data-server-kpis]");
      const map = document.querySelector("[data-world-map]");
      const heat = document.querySelector("[data-heatmap-card]");
      return {
        kpiBottom: kpi?.getBoundingClientRect().bottom ?? null,
        mapTop: map?.getBoundingClientRect().top ?? null,
        mapBottom: map?.getBoundingClientRect().bottom ?? null,
        heatTop: heat?.getBoundingClientRect().top ?? null,
      };
    });
    check(
      `${theme}/${width}: 地图在 KPI 与服务器 × 时间之间`,
      layout.kpiBottom !== null &&
        layout.mapTop !== null &&
        layout.heatTop !== null &&
        layout.kpiBottom <= layout.mapTop &&
        layout.mapBottom <= layout.heatTop,
      JSON.stringify(layout),
    );

    const map = await mapMetrics(page);
    const contrast = await measureContrast(page);
    report.metrics[`${theme}-${width}`] = {
      pathCount: map.pathCount,
      nodeCountries: map.nodeCountries,
      card: map.card,
      svg: map.svg,
      gaps: map.gaps,
      markers: map.markers,
      legend: map.legend,
      contrast: contrast.entries,
    };

    check(
      `${theme}/${width}: 渲染全部国家路径（${MAP_KEYS.length}）`,
      map.pathCount === MAP_KEYS.length,
      String(map.pathCount),
    );
    check(`${theme}/${width}: 8 个有节点国家`, map.nodeCountries === 8, String(map.nodeCountries));
    check(
      `${theme}/${width}: 着色档位 US=3 JP=2 DE/FR=1 CA=0`,
      map.tiers.US === "3" &&
        map.tiers.JP === "2" &&
        map.tiers.DE === "1" &&
        map.tiers.FR === "1" &&
        map.tiers.CA === "0",
      JSON.stringify(map.tiers),
    );
    check(
      `${theme}/${width}: 状态 worst US=offline、JP/BR=abnormal、DE=online`,
      map.worst.US === "offline" &&
        map.worst.JP === "abnormal" &&
        map.worst.BR === "abnormal" &&
        map.worst.DE === "online",
      JSON.stringify(map.worst),
    );
    check(
      `${theme}/${width}: 四档 fill 20/35/55/80 + primary/40 描边，无整国红 / 黄描边`,
      map.classes.CA.includes("fill-primary/20") &&
        map.classes.DE.includes("fill-primary/35") &&
        map.classes.JP.includes("fill-primary/55") &&
        map.classes.US.includes("fill-primary/80") &&
        map.classes.US.includes("stroke-primary/40") &&
        !map.classes.US.includes("stroke-destructive") &&
        !map.classes.JP.includes("stroke-warning") &&
        map.fills.US !== map.fills.DE &&
        map.fills.DE !== map.fills.CA,
      JSON.stringify({ fills: map.fills, classes: map.classes }),
    );

    const closeTo = (value, expected, tolerance = 0.25) =>
      typeof value === "number" && Math.abs(value - expected) <= tolerance;
    const fillAlpha = (value) => {
      const match =
        value.match(/\/\s*([0-9.]+)\)/) ??
        value.match(/rgba\([^)]*,\s*([0-9.]+)\)/);
      return match ? Number(match[1]) : 1;
    };
    const marker = (code) => map.markers[code];
    check(
      `${theme}/${width}: 质心圆点半径 6/5/4/3px 且圆点用卡片色描边`,
      closeTo(marker("US")?.screenRadius, 6) &&
        closeTo(marker("JP")?.screenRadius, 5) &&
        closeTo(marker("DE")?.screenRadius, 4) &&
        closeTo(marker("FR")?.screenRadius, 4) &&
        closeTo(marker("CA")?.screenRadius, 3) &&
        closeTo(marker("AU")?.screenRadius, 3) &&
        Object.values(map.markers).every(
          (item) => item?.exists && item.fillClass.includes("stroke-card"),
        ),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(map.markers).map(([code, item]) => [
            code,
            { radius: item?.screenRadius, fillClass: item?.fillClass },
          ]),
        ),
      ),
    );
    check(
      `${theme}/${width}: 离线 US 红点、降级 JP/BR 黄点、在线 primary`,
      marker("US")?.fillClass.includes("fill-destructive") &&
        marker("JP")?.fillClass.includes("fill-warning") &&
        marker("BR")?.fillClass.includes("fill-warning") &&
        marker("DE")?.fillClass.includes("fill-primary") &&
        marker("CA")?.fillClass.includes("fill-primary"),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(map.markers).map(([code, item]) => [
            code,
            item?.fillClass,
          ]),
        ),
      ),
    );
    check(
      `${theme}/${width}: ≥2 台国家在圆点右侧显示 12px N 标签`,
      marker("US")?.label === "8" &&
        marker("JP")?.label === "5" &&
        marker("DE")?.label === "3" &&
        marker("FR")?.label === "2" &&
        marker("CA")?.label === null &&
        Object.values(map.markers)
          .filter((item) => item?.label !== null)
          .every(
            (item) =>
              closeTo(item.labelFont, 12, 0.4) &&
              item.labelLeft >= item.dotRight - 1,
          ),
      JSON.stringify(
        Object.fromEntries(
          Object.entries(map.markers).map(([code, item]) => [
            code,
            {
              label: item?.label,
              font: item?.labelFont,
              dotRight: item?.dotRight,
              labelLeft: item?.labelLeft,
            },
          ]),
        ),
      ),
    );
    const labeledMarkers = Object.values(map.markers).filter(
      (item) => item?.label !== null,
    );
    const labelsOverlap = labeledMarkers.some((first, index) =>
      labeledMarkers.slice(index + 1).some(
        (second) =>
          first.labelLeft < second.labelRight &&
          second.labelLeft < first.labelRight &&
          first.labelTop < second.labelBottom &&
          second.labelTop < first.labelBottom,
      ),
    );
    check(
      `${theme}/${width}: 相邻国家的 N 标签互不重叠`,
      !labelsOverlap,
      JSON.stringify(
        Object.fromEntries(
          labeledMarkers.map((item) => [
            `${item.labelLeft},${item.labelTop}`,
            item.label,
          ]),
        ),
      ),
    );
    check(
      `${theme}/${width}: 图例在卡片底部右侧、12px、10×10、四档 + 离线/异常`,
      map.legend.text.includes("1 台") &&
        map.legend.text.includes("2–3 台") &&
        map.legend.text.includes("4–6 台") &&
        map.legend.text.includes("7+ 台") &&
        map.legend.text.includes("离线") &&
        map.legend.text.includes("异常") &&
        map.legend.fontSize === 12 &&
        map.legend.belowMap &&
        map.legend.right <= map.card.right + 1 &&
        map.legend.bottom <= map.card.bottom + 1 &&
        [map.legend.tier0, map.legend.tier3].every(
          (item) => closeTo(item.width, 10) && closeTo(item.height, 10),
        ) &&
        map.legend.offline.exists &&
        map.legend.abnormal.exists &&
        (width !== 1440 || map.legend.height <= 20),
      JSON.stringify(map.legend),
    );
    check(
      `${theme}/${width}: 地图内容贴住裁切后的上下边（无额外海洋留白）`,
      map.gaps.svgInsetTop <= 0.15 * map.card.height &&
        map.gaps.svgInsetBottom <= 0.15 * map.card.height,
      JSON.stringify(map.gaps),
    );
    if (width === 1440) {
      check(
        `${theme}/1440: 地图上下留白 ≤ 卡片高度 15%`,
        map.gaps.top <= 0.15 * map.card.height &&
          map.gaps.bottom <= 0.15 * map.card.height,
        JSON.stringify({
          cardHeight: map.card.height,
          top: map.gaps.top,
          bottom: map.gaps.bottom,
          topRatio: map.gaps.top / map.card.height,
          bottomRatio: map.gaps.bottom / map.card.height,
        }),
      );
    }
    if (theme === "light" && width === 1440) {
      const entries = contrast.entries;
      check(
        "亮色 1440: 四档填充对海洋对比度递增且每档可区分",
        entries.CA.ratio < entries.DE.ratio &&
          entries.DE.ratio < entries.JP.ratio &&
          entries.JP.ratio < entries.US.ratio &&
          entries.CA.ratio >= 1.35 &&
          entries.DE.ratio >= 1.8 &&
          entries.JP.ratio >= 2.7 &&
          entries.US.ratio >= 5 &&
          entries.NZ.ratio >= 1.2,
        JSON.stringify(entries),
      );
    }
    check(
      `${theme}/${width}: 有节点国家可聚焦、无节点国家不可聚焦`,
      map.focusable && map.noNodeFocusable,
    );
    if (width === 390) await assertNoOverflow(page, `${theme}/${width}`);

    if (theme === "dark" && width === 1440) {
      // 概览位置：KPI + 地图 + 「服务器 × 时间」同屏。
      await page.locator("[data-world-map]").scrollIntoViewIfNeeded();
      await capture(page, "overview-map-dark-1440");
    }
    await captureCard(page, `world-map-${theme}-${width}`);

    // hover：fill 提亮一档 + 1.5px primary 描边 + tooltip 不变。
    const de = page.locator('[data-country="DE"]');
    const base = await de.evaluate((element) => ({
      fill: getComputedStyle(element).fill,
      strokeWidth: getComputedStyle(element).strokeWidth,
    }));
    await de.hover({ force: true });
    await page.waitForSelector("[data-world-map-tooltip]", { timeout: 5_000 });
    await page.waitForTimeout(300);
    const hover = await page.evaluate(() => {
      const path = document.querySelector('[data-country="DE"]');
      return {
        fill: getComputedStyle(path).fill,
        strokeWidth: getComputedStyle(path).strokeWidth,
        tip: document.querySelector("[data-world-map-tooltip]")?.textContent ?? "",
      };
    });
    check(
      `${theme}/${width}: hover 提亮一档 + 1.5px 描边 + tooltip`,
      fillAlpha(hover.fill) > fillAlpha(base.fill) + 0.1 &&
        base.strokeWidth === "0.5px" &&
        hover.strokeWidth === "1.5px" &&
        hover.tip.includes("德国"),
      JSON.stringify({ base, hover }),
    );
    await captureCard(page, `world-map-hover-${theme}-${width}`);

    // 键盘聚焦：同 hover 的提亮 + focus ring。
    await page.mouse.move(0, 0);
    await page.waitForTimeout(80);
    await de.focus();
    await page.waitForTimeout(350);
    const focus = await page.evaluate(() => {
      const path = document.querySelector('[data-country="DE"]');
      return {
        fill: getComputedStyle(path).fill,
        strokeWidth: getComputedStyle(path).strokeWidth,
        ring: Boolean(document.querySelector("[data-world-map-focus-ring]")),
        tip: document.querySelector("[data-world-map-tooltip]")?.textContent ?? "",
      };
    });
    check(
      `${theme}/${width}: 键盘聚焦有提亮 + 1.5px 描边 + focus ring`,
      Math.abs(fillAlpha(focus.fill) - fillAlpha(hover.fill)) <= 0.02 &&
        focus.strokeWidth === "1.5px" &&
        focus.ring &&
        focus.tip.includes("德国"),
      JSON.stringify(focus),
    );
    if (width === 1440 && theme === "dark") {
      await captureCard(page, "world-map-focus-1440");
    }
    check(
      `${theme}/${width}: 页面无 console error`,
      consoleErrors.length === 0,
      consoleErrors.join(" | "),
    );
    await page.close();
  }

  // ---- 2. tooltip + 键盘 Enter 跳转 + 服务器页过滤 ----------------
  {
    const { page, consoleErrors } = await openPage(browser, BASE, {
      theme: "dark",
      width: 1440,
      height: 900,
    });
    await page.route("**/api/v1/**", (route) => handleApi(route, {}));
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await waitForMap(page);

    const de = page.locator('[data-country="DE"]');
    await de.hover({ force: true });
    await page.waitForSelector("[data-world-map-tooltip]", { timeout: 5_000 });
    const tip = await page.evaluate(() => ({
      text: document.querySelector("[data-world-map-tooltip]")?.textContent ?? "",
      rect: document
        .querySelector("[data-world-map-tooltip]")
        ?.getBoundingClientRect(),
      card: document
        .querySelector("[data-world-map]")
        ?.getBoundingClientRect(),
    }));
    check(
      "tooltip: 本地化国家名 + 台数/在线 + 前 3 个节点",
      tip.text.includes("德国") &&
        tip.text.includes("3 台 · 在线 3") &&
        tip.text.includes("法兰克福-01") &&
        tip.text.includes("法兰克福-02") &&
        tip.text.includes("柏林-01"),
      tip.text,
    );
    check(
      "tooltip: 不超出地图卡左右边界",
      tip.rect &&
        tip.card &&
        tip.rect.left >= tip.card.left - 1 &&
        tip.rect.right <= tip.card.right + 1,
      JSON.stringify({ tip: tip.rect, card: tip.card }),
    );
    const cardBox = await page.locator("[data-world-map]").boundingBox();
    if (cardBox) {
      await page.screenshot({
        path: resolve(OUT, "world-map-tooltip-1440.png"),
        clip: cardBox,
        animations: "disabled",
      });
      report.shots.push({
        name: "world-map-tooltip-1440",
        file: "world-map-tooltip-1440.png",
      });
    }

    // 键盘：聚焦有节点国家 + Enter → /servers?country=DE
    await de.focus();
    await page.waitForSelector("[data-world-map-tooltip]", { timeout: 5_000 });
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/servers\?country=DE$/, { timeout: 10_000 });
    await page.waitForSelector('[data-slot="server-country-filter"]', {
      timeout: 10_000,
    });
    const filtered = await page.evaluate(() => {
      const chip = document.querySelector('[data-slot="server-country-filter"]');
      const rows = [...document.querySelectorAll("tbody tr")];
      return {
        url: location.pathname + location.search,
        chip: chip?.textContent?.trim() ?? null,
        country: chip?.getAttribute("data-country") ?? null,
        rows: rows.length,
        names: rows
          .map((row) => row.textContent?.trim() ?? "")
          .filter((text) => text.length > 0),
      };
    });
    check(
      "键盘 Enter: URL = /servers?country=DE",
      filtered.url === "/servers?country=DE",
      filtered.url,
    );
    check(
      "键盘 Enter: chip 显示地区 DE，列表只留 3 台德国服务器",
      filtered.chip?.includes("地区 DE") &&
        filtered.country === "DE" &&
        filtered.rows === 3 &&
        filtered.names.every(
          (text) =>
            text.includes("法兰克福-01") ||
            text.includes("法兰克福-02") ||
            text.includes("柏林-01"),
        ),
      JSON.stringify({ chip: filtered.chip, rows: filtered.rows }),
    );
    await capture(page, "server-country-filter-1440");

    // 清除 chip → URL 回到 /servers
    await page.locator('[data-slot="server-country-filter"]').click();
    await page.waitForFunction(
      () =>
        !location.search.includes("country=") &&
        !document.querySelector('[data-slot="server-country-filter"]'),
    );
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 22,
    );
    const cleared = await page.evaluate(() => ({
      url: location.pathname + location.search,
      chip: Boolean(document.querySelector('[data-slot="server-country-filter"]')),
      rows: document.querySelectorAll("tbody tr").length,
    }));
    check(
      "点击 chip: 清除 country 参数并恢复全部服务器",
      cleared.url === "/servers" && !cleared.chip && cleared.rows === 22,
      JSON.stringify(cleared),
    );
    check("服务器页无 console error", consoleErrors.length === 0, consoleErrors.join(" | "));
    await page.close();
  }

  // ---- 3. 鼠标点击地图 → 服务器页 ----------------
  {
    const { page } = await openPage(browser, BASE, {
      theme: "dark",
      width: 1440,
      height: 900,
    });
    await page.route("**/api/v1/**", (route) => handleApi(route, {}));
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await waitForMap(page);
    await page.locator('[data-country="JP"]').dispatchEvent("click");
    await page.waitForURL(/\/servers\?country=JP$/, { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 5,
    );
    const clicked = await page.evaluate(() => ({
      url: location.pathname + location.search,
      chip: document
        .querySelector('[data-slot="server-country-filter"]')
        ?.textContent?.trim(),
      rows: document.querySelectorAll("tbody tr").length,
    }));
    check(
      "鼠标点击: URL = /servers?country=JP，5 台日本服务器",
      clicked.url === "/servers?country=JP" &&
        clicked.chip?.includes("地区 JP") &&
        clicked.rows === 5,
      JSON.stringify(clicked),
    );
    await page.close();
  }

  // ---- 4. 小地区 HK / SG：50m 补全 + 质心圆点可见、可点 ----------------
  {
    const { page } = await openPage(browser, BASE, {
      theme: "dark",
      width: 1440,
      height: 900,
    });
    await page.route("**/api/v1/**", (route) =>
      handleApi(route, { smallRegions: true }),
    );
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await waitForMap(page);
    await page.locator("[data-world-map]").scrollIntoViewIfNeeded();
    const small = await page.evaluate(() => {
      const svg = document
        .querySelector("[data-world-map-svg]")
        .getBoundingClientRect();
      const info = (code) => {
        const path = document.querySelector(`[data-country="${code}"]`);
        const group = document.querySelector(
          `[data-world-map-marker="${code}"]`,
        );
        const dot = group?.querySelector("[data-world-map-dot]");
        const label = group?.querySelector("[data-world-map-count]");
        const dotRect = dot?.getBoundingClientRect();
        const labelRect = label?.getBoundingClientRect();
        return {
          path: Boolean(path),
          role: path?.getAttribute("role"),
          tabIndex: path?.getAttribute("tabindex"),
          tier: path?.getAttribute("data-tier"),
          aria: path?.getAttribute("aria-label"),
          dLength: path?.getAttribute("d")?.length ?? 0,
          marker: Boolean(group),
          fillClass: dot?.getAttribute("class") ?? "",
          radius: dot
            ? (Number(dot.getAttribute("r")) * svg.width) / 1000
            : null,
          dotWidth: dotRect?.width ?? null,
          label: label?.textContent ?? null,
          labelFont: label
            ? (parseFloat(getComputedStyle(label).fontSize) * svg.width) / 1000
            : null,
          labelLeft: labelRect?.left ?? null,
          dotRight: dotRect?.right ?? null,
        };
      };
      return { HK: info("HK"), SG: info("SG") };
    });
    check(
      "香港 / 新加坡（50m 补全）：路径存在且可聚焦",
      small.HK.path &&
        small.HK.role === "button" &&
        small.HK.tabIndex === "0" &&
        small.HK.tier === "0" &&
        small.HK.dLength > 0 &&
        small.HK.aria?.includes("香港") &&
        small.HK.aria?.includes("1 台节点") &&
        small.SG.path &&
        small.SG.tier === "1" &&
        small.SG.dLength > 0 &&
        small.SG.aria?.includes("新加坡"),
      JSON.stringify(small),
    );
    check(
      "小地区圆点：HK r=3px、SG r=4px + N=2 标签，均可见",
      small.HK.marker &&
        Math.abs(small.HK.radius - 3) <= 0.2 &&
        small.HK.dotWidth >= 5.9 &&
        small.SG.marker &&
        Math.abs(small.SG.radius - 4) <= 0.2 &&
        small.SG.dotWidth >= 7.9 &&
        small.SG.label === "2" &&
        Math.abs(small.SG.labelFont - 12) <= 0.4 &&
        small.SG.labelLeft >= small.SG.dotRight - 1,
      JSON.stringify(small),
    );
    await captureCard(page, "world-map-small-regions-1440");

    await page.locator('[data-country="HK"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/servers\?country=HK$/, { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelectorAll("tbody tr").length === 1,
    );
    const filtered = await page.evaluate(() => ({
      url: location.pathname + location.search,
      chip: document
        .querySelector('[data-slot="server-country-filter"]')
        ?.textContent?.trim(),
      rows: document.querySelectorAll("tbody tr").length,
    }));
    check(
      "香港：Enter 跳 /servers?country=HK，chip 与过滤行正确",
      filtered.url === "/servers?country=HK" &&
        filtered.chip?.includes("地区 HK") &&
        filtered.rows === 1,
      JSON.stringify(filtered),
    );
    await page.close();
  }
  {
    const { page } = await openPage(browser, BASE, {
      theme: "dark",
      width: 390,
      height: 844,
    });
    await page.route("**/api/v1/**", (route) =>
      handleApi(route, { smallRegions: true }),
    );
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await waitForMap(page);
    await page.locator("[data-world-map]").scrollIntoViewIfNeeded();
    await assertNoOverflow(page, "390 small regions");
    const small = await page.evaluate(() => {
      const svg = document
        .querySelector("[data-world-map-svg]")
        .getBoundingClientRect();
      const info = (code) => {
        const dot = document.querySelector(
          `[data-world-map-marker="${code}"] [data-world-map-dot]`,
        );
        const label = document.querySelector(
          `[data-world-map-marker="${code}"] [data-world-map-count]`,
        );
        const rect = dot?.getBoundingClientRect();
        return {
          radius: dot
            ? (Number(dot.getAttribute("r")) * svg.width) / 1000
            : null,
          width: rect?.width ?? null,
          label: label?.textContent ?? null,
        };
      };
      return { HK: info("HK"), SG: info("SG") };
    });
    check(
      "390 小地区：HK / SG 圆点仍为 3 / 4px 且可见",
      Math.abs(small.HK.radius - 3) <= 0.2 &&
        small.HK.width >= 5.9 &&
        Math.abs(small.SG.radius - 4) <= 0.2 &&
        small.SG.width >= 7.9 &&
        small.SG.label === "2",
      JSON.stringify(small),
    );
    await captureCard(page, "world-map-small-regions-390");
    await page
      .locator('[data-world-map-marker="SG"] [data-world-map-dot]')
      .click({ force: true });
    await page.waitForURL(/\/servers\?country=SG$/, { timeout: 10_000 });
    await page.waitForSelector('[data-slot="server-country-filter"]', {
      timeout: 10_000,
    });
    await page.waitForSelector("text=新加坡-01", { timeout: 10_000 });
    await page.waitForSelector("text=新加坡-02", { timeout: 10_000 });
    const filtered = await page.evaluate(() => {
      const text = document.body.innerText;
      return {
        url: location.pathname + location.search,
        chip: document
          .querySelector('[data-slot="server-country-filter"]')
          ?.textContent?.trim(),
        first: text.includes("新加坡-01"),
        second: text.includes("新加坡-02"),
        empty: text.includes("该地区没有服务器"),
      };
    });
    check(
      "390 点击 SG 圆点：跳 /servers?country=SG，两台都在列表里",
      filtered.url === "/servers?country=SG" &&
        filtered.chip?.includes("地区 SG") &&
        filtered.first &&
        filtered.second &&
        !filtered.empty,
      JSON.stringify(filtered),
    );
    await page.close();
  }

  // ---- 5. 390 tooltip：不超出卡片 / 视口 ----------------
  {
    const { page } = await openPage(browser, BASE, {
      theme: "dark",
      width: 390,
      height: 844,
    });
    await page.route("**/api/v1/**", (route) => handleApi(route, {}));
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await waitForMap(page);
    await page.locator("[data-world-map]").scrollIntoViewIfNeeded();
    await page.locator('[data-country="DE"]').hover({ force: true });
    await page.waitForSelector("[data-world-map-tooltip]", { timeout: 5_000 });
    const bounds = await page.evaluate(() => {
      const tip = document
        .querySelector("[data-world-map-tooltip]")
        ?.getBoundingClientRect();
      const card = document
        .querySelector("[data-world-map]")
        ?.getBoundingClientRect();
      return { tip, card, viewport: window.innerWidth };
    });
    check(
      "390 tooltip: 文案完整且不超出卡片 / 视口",
      bounds.tip &&
        bounds.card &&
        bounds.tip.left >= bounds.card.left - 1 &&
        bounds.tip.right <= bounds.card.right + 1 &&
        bounds.tip.left >= 0 &&
        bounds.tip.right <= bounds.viewport + 1,
      JSON.stringify(bounds),
    );
    const box = await page.locator("[data-world-map]").boundingBox();
    if (box) {
      await page.screenshot({
        path: resolve(OUT, "world-map-tooltip-390.png"),
        clip: box,
        animations: "disabled",
      });
      report.shots.push({
        name: "world-map-tooltip-390",
        file: "world-map-tooltip-390.png",
      });
    }
    await page.close();
  }

  // ---- 6. 地区空态 + 390 服务器页 ----------------
  {
    const { page } = await openPage(browser, BASE, {
      theme: "dark",
      width: 1440,
      height: 900,
    });
    await page.route("**/api/v1/**", (route) => handleApi(route, {}));
    await page.goto(`${BASE}/servers?country=NZ`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("text=该地区没有服务器", { timeout: 15_000 });
    const empty = await page.evaluate(() => ({
      chip: document
        .querySelector('[data-slot="server-country-filter"]')
        ?.textContent?.trim(),
      title: [...document.querySelectorAll("h1,h2,h3,p,div")].some((node) =>
        node.textContent?.includes("该地区没有服务器"),
      ),
      clear: [...document.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("清除地区筛选"),
      ),
    }));
    check(
      "服务器页地区空态：标题 + 清除按钮 + chip",
      empty.title && empty.clear && empty.chip?.includes("地区 NZ"),
      JSON.stringify(empty),
    );
    await capture(page, "server-country-empty-1440");
    await page.close();
  }
  {
    const { page } = await openPage(browser, BASE, {
      theme: "dark",
      width: 390,
      height: 844,
    });
    await page.route("**/api/v1/**", (route) => handleApi(route, {}));
    await page.goto(`${BASE}/servers?country=JP`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector('[data-slot="server-country-filter"]', {
      timeout: 15_000,
    });
    await page.waitForTimeout(200);
    await assertNoOverflow(page, "390 servers?country=JP");
    await capture(page, "server-country-filter-390");
    await page.close();
  }

  // ---- 7. 地图空态（服务器存在但没有国家） ----------------
  for (const [theme, width] of [
    ["dark", 1440],
    ["dark", 390],
    ["light", 1440],
    ["light", 390],
  ]) {
    const { page } = await openPage(browser, BASE, {
      theme,
      width,
      height: width === 390 ? 844 : 900,
    });
    await page.route("**/api/v1/**", (route) =>
      handleApi(route, { emptyNodes: true }),
    );
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await waitForMap(page);
    const empty = await page.evaluate(() => ({
      legend: document.querySelector("[data-world-map-legend]")?.textContent ?? "",
      hasEmpty: Boolean(document.querySelector("[data-world-map-empty]")),
      nodeCountries: [
        ...document.querySelectorAll('[data-world-map] [data-country]'),
      ].filter((path) => path.getAttribute("data-tier") !== "none").length,
      map: Boolean(document.querySelector("[data-world-map-svg]")),
    }));
    check(
      `${theme}/${width}: 空态仍显示地图，图例注明暂无节点`,
      empty.map && empty.hasEmpty && empty.legend.includes("暂无节点") && empty.nodeCountries === 0,
      JSON.stringify(empty),
    );
    if (width === 390) await assertNoOverflow(page, `${theme}/${width} empty`);
    await captureCard(page, `world-map-empty-${theme}-${width}`);
    await page.close();
  }

  // ---- 8. 改前 / 改后对比图（1440 亮暗各一张） ----------------
  await captureCompare(browser);

  // ---- 9. 体积 ----------------
  const bytes = statSync(MAP_JSON).size;
  report.metrics.jsonBytes = bytes;
  check("worldMapPaths.json ≤170KB", bytes <= 170 * 1024, `${bytes} bytes`);
} catch (error) {
  report.errors.push(`fatal: ${error.stack ?? error.message}`);
} finally {
  await browser.close();
  staticServer.close();
  if (DIST !== BUILD_DIST) rmSync(DIST, { recursive: true, force: true });
}

report.ok = report.errors.length === 0;
writeFileSync(
  resolve(OUT, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify(
    {
      ok: report.ok,
      shots: report.shots.length,
      checks: report.checks.length,
      failed: report.checks.filter((item) => !item.ok),
      errors: report.errors,
      out: OUT,
    },
    null,
    2,
  ),
);
if (!report.ok) process.exitCode = 1;
