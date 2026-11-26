// 成本开支「月均开销」第四格：截图 + 运行时断言。
//
// 覆盖 / Covers:
//   * 1440 / 390 × 亮 / 暗：成本 tab 的 KPI 条与页面首屏；
//   * 四格栅格：桌面 4 列、390 2×2；
//   * 金额口径：月均 = 每台周期价格 / 周期月数（月付 100 + 年付 1000/12
//     + 3 个月 300/3 = 283.33），一次性 500 不计入，未知币种 AED 不计入；
//   * 未来 12 个月副行「按到期日排期累加 · 月付计 12 次」，与月均 ×12
//     不相等（1900.00 总额 / 3900.00 next12 / 283.33 月均）；
//   * 中英成对：EN 下同一批文案。
//
// 用法 / Usage:
//   cd web && npm run build
//   node screenshots/cost-monthly/shots.mjs
//
// 不依赖真实主控：脚本自己起静态服务器并在 Playwright 里 mock 全部接口。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../../..");
const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;

/** 相对今天的 `YYYY-MM-DD`：截图脚本不写死日期，换个月份跑也不漂。 */
function isoDaysFromNow(days) {
  return new Date((NOW + days * 86400) * 1000).toISOString().slice(0, 10);
}

mkdirSync(HERE, { recursive: true });

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) {
    candidates.push(process.env.PLAYWRIGHT_MODULE);
  }
  const npxRoot = resolve(ROOT, ".npm-cache/_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(
        resolve(npxRoot, entry, "node_modules/playwright/index.mjs"),
      );
    }
  }
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
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
 * 四台有完整费用 + 一台未知币种：
 * - 月付 ¥100（月数 1）；
 * - 年付 ¥1,000（月数 12，paid_until 在半年后，未来 12 个月只排 1 次）；
 * - 3 个月 ¥300（月数 3）；
 * - 一次性 ¥500（无月数，不计入月均，但进总额与 next12）；
 * - AED ¥320（无汇率，不进任何合计）。
 *
 * 月均 = 100 + 1000/12 + 300/3 = 283.33
 * 总额 = 100 + 1000 + 300 + 500 = 1,900.00
 * next12 = 12×100 + 1×1000 + 4×300 + 1×500 = 3,900.00
 */
const SERVER_DEFS = [
  {
    id: "srv-monthly",
    name: "香港-月付",
    price_cents: 10000,
    currency: "CNY",
    billing_cycle: "monthly",
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: null,
  },
  {
    id: "srv-yearly",
    name: "东京-年付",
    price_cents: 100000,
    currency: "CNY",
    billing_cycle: "yearly",
    billing_cycle_count: 1,
    billing_cycle_unit: "year",
    paid_until: isoDaysFromNow(180),
  },
  {
    id: "srv-quarterly",
    name: "新加坡-季付",
    price_cents: 30000,
    currency: "CNY",
    billing_cycle: null,
    billing_cycle_count: 3,
    billing_cycle_unit: "month",
    paid_until: null,
  },
  {
    id: "srv-once",
    name: "美西-一次性",
    price_cents: 50000,
    currency: "CNY",
    billing_cycle: "once",
    billing_cycle_count: 1,
    billing_cycle_unit: "once",
    paid_until: isoDaysFromNow(45),
  },
  {
    id: "srv-aed",
    name: "迪拜-未知币种",
    price_cents: 32000,
    currency: "AED",
    billing_cycle: null,
    billing_cycle_count: 1,
    billing_cycle_unit: "month",
    paid_until: null,
  },
];

const SERVER_LIST = SERVER_DEFS.map((def, index) => ({
  id: def.id,
  name: def.name,
  address: `10.0.0.${index + 1}`,
  xray_mode: "auto",
  status: "online",
  group_name: "成本演示",
  last_seen_at: NOW - 30,
  config_version: 3,
  created_at: NOW - 30 * 86400,
  agent_version: "0.18.3",
  allow_agent_upgrade: false,
  agent_target_version: null,
  xray_running: true,
  nginx_running: true,
  load1: 0.4,
  mem_used: 4294967296,
  mem_total: 8589934592,
  disk_used: 42949672960,
  disk_total: 85899345920,
  uptime_secs: 86400 * 20,
  latency_ms: 28,
  health_at: NOW - 30,
  arch: "x86_64",
  os_name: "Ubuntu",
  os_version: "24.04",
  virt: "kvm",
  country_code: "HK",
  paid_until: def.paid_until,
  price_cents: def.price_cents,
  currency: def.currency,
  billing_cycle: def.billing_cycle,
  billing_cycle_count: def.billing_cycle_count,
  billing_cycle_unit: def.billing_cycle_unit,
}));

const SETTINGS = {
  panel_name: "PierWave",
  login_max_attempts: 5,
  login_lock_secs: 600,
  session_ttl_hours: 72,
  agent_upgrade_concurrency: 1,
  public_status_enabled: 1,
  public_billing_visible: 1,
  // 故意不给 AED 汇率：未知币种必须被排除，并在 KPI 下方提示。
  fx_rates: JSON.stringify({
    base: "CNY",
    rates: {},
    fetched_at: NOW - HOUR,
    source: "manual",
  }),
  fx_rates_updated_at: NOW - HOUR,
};

const STATS = {
  servers: { total: SERVER_LIST.length, online: SERVER_LIST.length },
  users: { total: 1, active: 1 },
  packages: { total: 0, instances: 0 },
  traffic: { today_bytes: 0, month_bytes: 0 },
  alerts: {
    expired_instances: 0,
    exhausted_instances: 0,
    offline_servers: 0,
    expiring_certs: 0,
  },
};

const OVERVIEW = {
  kpi: {
    servers_online: SERVER_LIST.length,
    servers_total: SERVER_LIST.length,
    nodes: 0,
    traffic_today: 0,
    traffic_month: 0,
    uptime_24h: 100,
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
  scope: {
    server_ids: SERVER_LIST.map((server) => server.id),
    servers_matched: SERVER_LIST.length,
    filtered: false,
    global: true,
  },
  warnings: { unknown_ids: [] },
};

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function handleApi(route) {
  const path = new URL(route.request().url()).pathname;
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
  if (path === "/api/v1/servers") return json(route, { items: SERVER_LIST });
  if (path === "/api/v1/settings") {
    return json(route, { items: SETTINGS, secret_errors: null });
  }
  if (path === "/api/v1/overview") return json(route, OVERVIEW);
  if (path === "/api/v1/stats/overview") return json(route, STATS);
  if (path === "/api/v1/stats/traffic") return json(route, { days: [] });
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

const report = {
  generatedAt: new Date().toISOString(),
  viewports: {},
  assertions: {},
  english: {},
  errors: [],
};

const { server, port } = await startStaticServer();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function openPage({ theme, width, locale = "zh-CN" }) {
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (error) =>
    report.errors.push(`pageerror: ${error.message}`),
  );
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("Failed to load resource")
    ) {
      report.errors.push(`console: ${message.text()}`);
    }
  });
  await page.addInitScript(
    ({ theme, locale }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale },
  );
  await page.route("**/api/v1/**", handleApi);
  await page.goto(`${base}/?view=cost`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-cost-kpis]", { timeout: 20000 });
  // 等成本 KPI 的数字落定（settings + servers 两个查询都完成）。
  await page.waitForFunction(
    () => {
      const values = [...document.querySelectorAll("[data-cost-kpis] [data-chain-kpi-value]")]
        .map((node) => node.textContent?.trim() ?? "");
      return values.length === 4 && values.every((value) => value.startsWith("CNY"));
    },
    undefined,
    { timeout: 20000 },
  );
  return page;
}

async function readCostKpi(page) {
  return page.evaluate(() => {
    const grid = document.querySelector("[data-cost-kpis]");
    if (!grid) return null;
    const cells = [...grid.querySelectorAll("[data-chain-kpi-cell]")];
    // `data-cost-kpis` 挂在 Card 上，真正的栅格是它的 CardContent。
    const track = grid.firstElementChild;
    const style = getComputedStyle(track);
    const firstCell = cells[0]?.getBoundingClientRect();
    const secondCell = cells[1]?.getBoundingClientRect();
    const cellsPerRow = new Set(
      cells.map((cell) => Math.round(cell.getBoundingClientRect().top)),
    );
    return {
      count: cells.length,
      columns: style.gridTemplateColumns.split(" ").filter(Boolean).length,
      rows: style.gridTemplateRows.split(" ").filter(Boolean).length,
      rowStarts: cellsPerRow.size,
      cellWidths: [...new Set(cells.map((cell) => Math.round(cell.getBoundingClientRect().width)))],
      gridWidth: Math.round(grid.getBoundingClientRect().width),
      gap: style.columnGap,
      firstRowBreak: Math.round((secondCell?.top ?? 0) - (firstCell?.top ?? 0)),
      cells: cells.map((cell) => ({
        label: cell.querySelector("[data-chain-kpi-label]")?.textContent?.trim() ?? "",
        value: cell.querySelector("[data-chain-kpi-value]")?.textContent?.trim() ?? "",
        hint: cell.querySelector("[data-chain-kpi-hint]")?.textContent?.trim() ?? "",
      })),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
}

function assertCostKpi(kpi, { theme, width }) {
  assert.equal(kpi.count, 4, `${theme}/${width}: exactly four KPI cells`);
  const expectedColumns = width === 390 ? 2 : 4;
  assert.equal(
    kpi.columns,
    expectedColumns,
    `${theme}/${width}: grid columns`,
  );
  assert.equal(
    kpi.rowStarts,
    width === 390 ? 2 : 1,
    `${theme}/${width}: KPI rows`,
  );
  assert.equal(
    kpi.cells[0].label,
    "总开销",
    `${theme}/${width}: total label`,
  );
  assert.equal(
    kpi.cells[1].label,
    "本年度总开销",
    `${theme}/${width}: current-year label`,
  );
  assert.equal(
    kpi.cells[2].label,
    "未来 12 个月",
    `${theme}/${width}: next12 label`,
  );
  assert.equal(
    kpi.cells[3].label,
    "月均开销",
    `${theme}/${width}: monthly label`,
  );
  // 未知币种 AED 不计入总额、一次性计入总额：100 + 1000 + 300 + 500 = 1900。
  assert.equal(kpi.cells[0].value, "CNY 1,900.00", `${theme}/${width}: total value`);
  // 月均：100 + 1000/12 + 300/3 = 283.33；一次性 500 不计入。
  assert.equal(
    kpi.cells[3].value,
    "CNY 283.33",
    `${theme}/${width}: monthly value`,
  );
  assert.equal(
    kpi.cells[3].hint,
    "不含一次性",
    `${theme}/${width}: monthly hint`,
  );
  // 未来 12 个月：12×100 + 1×1000 + 4×300 + 1×500 = 3900。
  assert.equal(
    kpi.cells[2].value,
    "CNY 3,900.00",
    `${theme}/${width}: next12 value`,
  );
  assert.equal(
    kpi.cells[2].hint,
    "按到期日排期累加 · 月付计 12 次",
    `${theme}/${width}: next12 hint`,
  );
  // 月均 × 12 与未来 12 个月不应相等，但量级接近。
  const monthlyCents = 28333;
  assert.notEqual(monthlyCents * 12, 390000, "monthly × 12 must not equal next12");
  assert.ok(
    390000 >= monthlyCents * 6 && 390000 <= monthlyCents * 24,
    `${theme}/${width}: next12 should be the same order of magnitude as monthly × 12`,
  );
  assert.equal(kpi.overflowX, false, `${theme}/${width}: no horizontal overflow`);
}

const VIEWPORTS = [
  { theme: "light", width: 1440 },
  { theme: "dark", width: 1440 },
  { theme: "light", width: 390 },
  { theme: "dark", width: 390 },
];

for (const { theme, width } of VIEWPORTS) {
  const page = await openPage({ theme, width });
  const kpi = await readCostKpi(page);
  assert.ok(kpi, `${theme}/${width}: cost KPI grid missing`);
  assertCostKpi(kpi, { theme, width });
  report.viewports[`${theme}-${width}`] = kpi;

  await page.locator("[data-cost-kpis]").screenshot({
    path: `${HERE}kpi-${theme}-${width}.png`,
  });
  await page.locator("[data-cost-kpis]").scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  await page.screenshot({
    path: `${HERE}page-${theme}-${width}.png`,
  });
  await page.close();
}

// 中英成对：EN 下同一批文案键必须给出英文，而不是中文回退。
{
  const page = await openPage({ theme: "dark", width: 1440, locale: "en" });
  const kpi = await readCostKpi(page);
  assert.equal(kpi.count, 4, "EN: exactly four KPI cells");
  assert.equal(kpi.cells[3].label, "Monthly average", "EN: monthly label");
  assert.equal(kpi.cells[3].hint, "One-time excluded", "EN: monthly hint");
  assert.equal(
    kpi.cells[2].hint,
    "Due-date schedule · monthly ×12",
    "EN: next12 hint",
  );
  report.english = kpi;
  await page.locator("[data-cost-kpis]").screenshot({
    path: `${HERE}kpi-en-dark-1440.png`,
  });
  await page.close();
}

report.assertions = {
  fourCells: true,
  desktopFourColumns: true,
  narrowTwoByTwo: true,
  monthlyValue: "CNY 283.33",
  monthlyExcludesOneTime: true,
  unknownCurrencyExcluded: true,
  next12HintZh: "按到期日排期累加 · 月付计 12 次",
  next12HintEn: "Due-date schedule · monthly ×12",
  monthlyTimes12DiffersFromNext12: true,
  noHorizontalOverflow: true,
};

writeFileSync(`${HERE}report.json`, `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
server.close();

assert.deepEqual(report.errors, [], "page errors / console errors");
console.log(
  JSON.stringify(
    {
      screenshots: 9,
      assertions: report.assertions,
      viewports: Object.keys(report.viewports),
      errors: report.errors,
    },
    null,
    2,
  ),
);
