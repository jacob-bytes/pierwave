// 「节点分布」世界地图卡的截图 + 运行时断言。
//
// 前置：`cd web && npm run build`（脚本自己起静态服务器，不需要主控 / 数据库）。
// 用法：node web/scripts/shots-world-map.mjs
//
// 覆盖：资源状态视图里的位置（KPI 与「服务器 × 时间」之间）、1440/390 × 亮暗、
// 着色档位、offline / abnormal 描边、图例、tooltip、鼠标点击与键盘 Enter 跳
// `/servers?country=`、服务器页地区 chip / 过滤 / 空态、地图空态、390 无横向
// 溢出、JSON ≤150KB。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = resolve(WEB, "..");
const DIST = resolve(WEB, "dist");
const OUT = resolve(WEB, "screenshots/world-map");
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAP_JSON = resolve(WEB, "src/lib/worldMapPaths.json");
const MAP_KEYS = Object.keys(JSON.parse(readFileSync(MAP_JSON, "utf8")));
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

    const map = await page.evaluate(() => {
      const svg = document.querySelector("[data-world-map-svg]");
      const paths = [...document.querySelectorAll("[data-world-map] [data-country]")];
      const nodes = paths.filter((path) => path.getAttribute("data-tier") !== "none");
      const tier = (code) => {
        const path = paths.find((item) => item.getAttribute("data-country") === code);
        return path?.getAttribute("data-tier") ?? null;
      };
      const cls = (code) => {
        const path = paths.find((item) => item.getAttribute("data-country") === code);
        return path?.getAttribute("class") ?? "";
      };
      const stroke = (code) => {
        const path = paths.find((item) => item.getAttribute("data-country") === code);
        return path ? getComputedStyle(path).stroke : null;
      };
      const fill = (code) => {
        const path = paths.find((item) => item.getAttribute("data-country") === code);
        return path ? getComputedStyle(path).fill : null;
      };
      const legend = document.querySelector("[data-world-map-legend]")?.textContent ?? "";
      const box = document.querySelector("[data-world-map]")?.getBoundingClientRect();
      return {
        pathCount: paths.length,
        nodeCountries: nodes.length,
        tiers: {
          US: tier("US"),
          JP: tier("JP"),
          DE: tier("DE"),
          FR: tier("FR"),
          CA: tier("CA"),
        },
        worst: {
          US: document.querySelector('[data-country="US"]')?.getAttribute("data-worst"),
          JP: document.querySelector('[data-country="JP"]')?.getAttribute("data-worst"),
          BR: document.querySelector('[data-country="BR"]')?.getAttribute("data-worst"),
          DE: document.querySelector('[data-country="DE"]')?.getAttribute("data-worst"),
        },
        classes: {
          US: cls("US"),
          JP: cls("JP"),
          BR: cls("BR"),
          DE: cls("DE"),
          CA: cls("CA"),
        },
        strokes: { US: stroke("US"), JP: stroke("JP"), DE: stroke("DE") },
        fills: { US: fill("US"), DE: fill("DE"), CA: fill("CA") },
        legend,
        width: box?.width ?? null,
        height: box?.height ?? null,
        svgBox: svg?.getBoundingClientRect(),
        focusable: nodes.every((path) => path.getAttribute("tabindex") === "0"),
        noNodeFocusable: paths
          .filter((path) => path.getAttribute("data-tier") === "none")
          .every((path) => !path.hasAttribute("tabindex")),
      };
    });

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
      `${theme}/${width}: 描边 worst US=offline、JP/BR=abnormal、DE=online`,
      map.worst.US === "offline" &&
        map.worst.JP === "abnormal" &&
        map.worst.BR === "abnormal" &&
        map.worst.DE === "online",
      JSON.stringify(map.worst),
    );
    check(
      `${theme}/${width}: 离线 / 异常国家有描边色，在线没有`,
      map.classes.US.includes("stroke-destructive") &&
        map.classes.JP.includes("stroke-warning") &&
        map.classes.BR.includes("stroke-warning") &&
        !map.classes.DE.includes("stroke-destructive") &&
        !map.classes.DE.includes("stroke-warning") &&
        map.strokes.US !== map.strokes.DE &&
        map.strokes.JP !== map.strokes.DE,
      JSON.stringify(map.strokes),
    );
    check(
      `${theme}/${width}: 有节点国家按台数加深（US 比 DE 深）`,
      map.fills.US !== map.fills.DE && map.fills.DE !== map.fills.CA,
      JSON.stringify(map.fills),
    );
    check(
      `${theme}/${width}: 图例包含无节点 / 4 档 / 离线 / 异常`,
      map.legend.includes("无节点") &&
        map.legend.includes("1 台") &&
        map.legend.includes("2–3 台") &&
        map.legend.includes("4–6 台") &&
        map.legend.includes("7+ 台") &&
        map.legend.includes("离线") &&
        map.legend.includes("异常"),
      map.legend,
    );
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

  // ---- 4. 香港：110m 没有轮廓，由 50m 补齐后仍可点击 ----------------
  {
    const { page } = await openPage(browser, BASE, {
      theme: "dark",
      width: 1440,
      height: 900,
    });
    await page.route("**/api/v1/**", (route) =>
      handleApi(route, { onlyCountry: "HK" }),
    );
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    await waitForMap(page);
    const hk = await page.evaluate(() => {
      const path = document.querySelector('[data-country="HK"]');
      return {
        exists: Boolean(path),
        role: path?.getAttribute("role"),
        tabIndex: path?.getAttribute("tabindex"),
        tier: path?.getAttribute("data-tier"),
        aria: path?.getAttribute("aria-label"),
        d: path?.getAttribute("d")?.length ?? 0,
      };
    });
    check(
      "香港（50m 补全）：地图路径存在且可聚焦",
      hk.exists &&
        hk.role === "button" &&
        hk.tabIndex === "0" &&
        hk.tier === "0" &&
        hk.d > 0 &&
        hk.aria?.includes("香港") &&
        hk.aria?.includes("1 台节点"),
      JSON.stringify(hk),
    );
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

  // ---- 8. 体积 ----------------
  const bytes = statSync(MAP_JSON).size;
  check("worldMapPaths.json ≤150KB", bytes <= 150 * 1024, `${bytes} bytes`);
} catch (error) {
  report.errors.push(`fatal: ${error.stack ?? error.message}`);
} finally {
  await browser.close();
  staticServer.close();
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
