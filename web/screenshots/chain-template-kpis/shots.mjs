#!/usr/bin/env node
/**
 * 「链路时延 → 转发模板」四格 KPI 的验收截图 + 断言。
 *
 * 正常态用真实主控 / 真实列表接口（不注入 mock）；空态与降级态只在浏览器层
 * 改写 `/api/v1/overview/chain-templates` 的响应，列表本身仍走现有四态。
 *
 * 前置 / Prerequisite:
 *   cd web && npm run build                  # 主控直接读 web/dist
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
 *     PIERWAVE_DB='sqlite://data/preview.db?mode=rwc' \
 *     ./target/debug/pierwave-master
 *
 *   预览库 admin 密码不是 devpass 时，用 `ADMIN_PASSWORD` 指向已有密码。
 *
 * 用法 / Usage:
 *   node web/screenshots/chain-template-kpis/shots.mjs
 *
 * 输出 / Output:
 *   16 张 1440/390 × 亮暗 × 正常/空/降级的截图，外加异常 0 / 只有降级 /
 *   loading / error 各一张；
 *   `report.json` 记录每个断言的期望值、实测值与几何数据。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const ADMIN = process.env.ADMIN_PASSWORD ?? "devpass";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEWPORTS = [1440, 390];
const THEMES = /** @type {const} */ (["dark", "light"]);

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const npxRoot = path.join(ROOT, ".npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(
        path.join(npxRoot, entry, "node_modules", "playwright", "index.mjs"),
      );
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

const loginResponse = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: ADMIN }),
});
assert.equal(
  loginResponse.status,
  200,
  "admin login failed — set ADMIN_PASSWORD to the preview DB's admin password",
);
const sessionCookie = loginResponse.headers
  .getSetCookie()
  .map((item) => item.split(";")[0])
  .find((item) => item.startsWith("pierwave_session="));
assert.ok(sessionCookie, "session cookie must exist");
const [cookieName, cookieValue] = sessionCookie.split("=");

/* ------------------------------------------------------------------ *
 * 真实列表响应与前端同口径的期望值
 * ------------------------------------------------------------------ */

const listResponse = await fetch(
  `${BASE}/api/v1/overview/chain-templates`,
  { headers: { Cookie: sessionCookie } },
);
assert.equal(
  listResponse.status,
  200,
  `GET /api/v1/overview/chain-templates -> ${listResponse.status}`,
);
const payload = await listResponse.json();
assert.ok(Array.isArray(payload.items), "list response must contain items[]");

const expected = (() => {
  const items = payload.items;
  const enabledItems = items.filter((item) => item.enabled === true);
  const blocked = enabledItems.filter(
    (item) => item.status?.kind === "blocked",
  ).length;
  const degraded = enabledItems.filter(
    (item) => item.status?.kind === "degraded",
  ).length;
  return {
    total: items.length,
    enabled: enabledItems.length,
    disabled: items.length - enabledItems.length,
    inUse: items.filter((item) => item.chains > 0).length,
    chains: items.reduce((sum, item) => sum + Math.max(0, item.chains), 0),
    users: items.reduce((sum, item) => sum + Math.max(0, item.users), 0),
    blocked,
    degraded,
    abnormal: blocked + degraded,
  };
})();

const zh = {
  total: `${expected.total} 个`,
  inUse: `${expected.inUse} 个`,
  users: `${expected.users} 人`,
  abnormal: `${expected.abnormal} 个`,
  totalHint: `启用 ${expected.enabled} · 停用 ${expected.disabled}`,
  inUseHint: `共 ${expected.chains} 条链`,
  usersHint: "管理员链不计入",
  abnormalHint: `阻断 ${expected.blocked} · 降级 ${expected.degraded}`,
};
const DASH = "—";

/* ------------------------------------------------------------------ *
 * 断言 / 截图基础设施
 * ------------------------------------------------------------------ */

const results = [];
const failures = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    failures.push(`${name}: ${error.message}`);
  }
}

async function newContext(browser, width, theme) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  await context.addInitScript(
    ({ theme }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", "zh-CN");
    },
    { theme },
  );
  await context.addCookies([
    {
      name: cookieName,
      value: cookieValue,
      url: BASE,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return context;
}

/** 异常为 0 / 只有降级的模板样本，用来验收数字颜色。 */
const HEALTHY_ITEMS = [
  {
    id: "tpl-ok-1",
    name: "港新单跳",
    hops: 1,
    enabled: true,
    chains: 2,
    users: 1,
    status: { kind: "ok", cause: null },
    strategies: [],
    targets: [],
  },
  {
    id: "tpl-ok-2",
    name: "港日双路",
    hops: 3,
    enabled: true,
    chains: 1,
    users: 1,
    status: { kind: "ok", cause: null },
    strategies: [],
    targets: [],
  },
];
const DEGRADED_ONLY_ITEMS = [
  HEALTHY_ITEMS[0],
  {
    ...HEALTHY_ITEMS[1],
    status: { kind: "degraded", cause: null },
  },
];

/** 空 / 旧主控 / 接口失败 / 异常 0 / 只有降级 的模板列表响应。 */
async function interceptTemplates(context, mode) {
  if (mode === "normal") return;
  await context.route("**/api/v1/overview/chain-templates", (route) => {
    if (mode === "empty") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          generated_at: Math.floor(Date.now() / 1000),
          items: [],
        }),
      });
    }
    if (mode === "healthy" || mode === "degraded-only") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          generated_at: Math.floor(Date.now() / 1000),
          items: mode === "healthy" ? HEALTHY_ITEMS : DEGRADED_ONLY_ITEMS,
        }),
      });
    }
    if (mode === "unsupported") {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "not found", code: "not_found" }),
      });
    }
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "internal error" }),
    });
  });
}

async function openTemplates(page, mode = "normal") {
  await page.goto(`${BASE}/?view=chain&section=templates`, {
    waitUntil: "networkidle",
  });
  await page.locator("[data-chain-template-page]").waitFor();
  await page.locator("[data-chain-template-kpis]").waitFor();
  if (mode === "normal") {
    await page.locator("[data-chain-template-row]").first().waitFor();
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

const READ = () => {
  const rect = (element) => element?.getBoundingClientRect().toJSON() ?? null;
  const cells = [...document.querySelectorAll("[data-template-kpi]")].map(
    (cell) => {
      const value = cell.querySelector("[data-chain-kpi-value]");
      const hint = cell.querySelector("[data-chain-kpi-hint]");
      const label = cell.querySelector("p");
      return {
        kind: cell.dataset.templateKpi,
        label: label?.textContent?.trim() ?? null,
        value: value?.textContent?.trim() ?? null,
        hint: hint?.textContent?.trim() ?? null,
        valueClass: value?.className ?? null,
        valueFont: value ? getComputedStyle(value).fontSize : null,
        hintFont: hint ? getComputedStyle(hint).fontSize : null,
        rect: rect(cell),
      };
    },
  );
  const rows = [...document.querySelectorAll("[data-chain-template-row]")].map(
    (row) => ({
      id: row.dataset.templateId ?? null,
      enabled: row.dataset.templateEnabled === "true",
      chains: Number(row.dataset.templateChains ?? "0"),
      users: Number(row.dataset.templateUsers ?? "0"),
      status: row.dataset.status ?? null,
    }),
  );
  const kpiCard = document.querySelector("[data-chain-template-kpis]");
  const listCard = document.querySelector("[data-chain-template-insight]");
  return {
    cells,
    rows,
    kpiState: kpiCard?.dataset.state ?? null,
    listState: listCard?.dataset.state ?? null,
    kpiRect: rect(kpiCard),
    listRect: rect(listCard),
    kpiText: kpiCard?.innerText?.trim() ?? null,
    listText: listCard?.innerText?.trim() ?? null,
    docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    viewportWidth: window.innerWidth,
  };
};

async function placeSection(page, width) {
  await page.locator("[data-chain-template-kpis]").evaluate(
    (element, width) => {
      element.scrollIntoView({ block: width <= 480 ? "start" : "center" });
      if (width <= 480) window.scrollBy(0, -8);
    },
    width,
  );
  await page.waitForTimeout(250);
}

async function shoot(page, file, width) {
  await placeSection(page, width);
  await page.screenshot({ path: path.join(HERE, file) });
}

function assertGeometry(cells, viewportWidth, width) {
  assert.equal(cells.length, 4, "must render exactly four KPI cells");
  const [a, b, c, d] = cells.map((cell) => cell.rect);
  assert.ok(a && b && c && d, "every KPI cell must have a box");
  if (width <= 480) {
    // 390：2×2 —— 前两张同一行，后两张另起一行。
    assert.ok(Math.abs(a.top - b.top) <= 1, "first two cells must share a row");
    assert.ok(Math.abs(c.top - d.top) <= 1, "last two cells must share a row");
    assert.ok(c.top > b.top + 1, "second row must start below the first");
    assert.ok(Math.abs(a.left - c.left) <= 1, "second row must align left");
    assert.ok(Math.abs(b.left - d.left) <= 1, "second row must align right");
  } else {
    // 1440：一行四列。
    assert.ok(
      Math.max(...cells.map((cell) => cell.rect.top)) -
        Math.min(...cells.map((cell) => cell.rect.top)) <=
        1,
      "wide layout must keep all four cells on one row",
    );
  }
  for (const cell of cells) {
    assert.ok(cell.rect.left >= -1, `${cell.kind} must not overflow left`);
    assert.ok(
      cell.rect.right <= viewportWidth + 1,
      `${cell.kind} must not overflow right`,
    );
    assert.ok(cell.rect.width > 80, `${cell.kind} must keep a usable width`);
    assert.equal(cell.valueFont, "28px", `${cell.kind} value must be 28px`);
  }
}

function aggregateRows(rows) {
  const enabled = rows.filter((row) => row.enabled);
  const blocked = enabled.filter((row) => row.status === "blocked").length;
  const degraded = enabled.filter((row) => row.status === "degraded").length;
  return {
    total: rows.length,
    enabled: enabled.length,
    disabled: rows.length - enabled.length,
    inUse: rows.filter((row) => row.chains > 0).length,
    chains: rows.reduce((sum, row) => sum + row.chains, 0),
    users: rows.reduce((sum, row) => sum + row.users, 0),
    blocked,
    degraded,
    abnormal: blocked + degraded,
  };
}

/* ------------------------------------------------------------------ *
 * 正常态：真实接口，1440/390 × 亮暗
 * ------------------------------------------------------------------ */

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
});

for (const width of VIEWPORTS) {
  for (const theme of THEMES) {
    const label = `${width}-${theme}`;
    const context = await newContext(browser, width, theme);
    const page = await context.newPage();
    await openTemplates(page);
    const state = await page.evaluate(READ);
    await placeSection(page, width);
    const placed = await page.evaluate(READ);

    await check(`normal ${label}: 四个 KPI 存在且顺序固定`, () => {
      assert.deepEqual(
        state.cells.map((cell) => cell.kind),
        ["total", "in-use", "users", "abnormal"],
      );
      assert.deepEqual(
        state.cells.map((cell) => cell.label),
        ["模板总数", "使用中的模板", "使用用户", "异常模板"],
      );
      return state.cells.map((cell) => cell.label);
    });

    await check(`normal ${label}: 数值与列表接口聚合一致`, () => {
      const values = state.cells.map((cell) => cell.value);
      assert.deepEqual(values, [zh.total, zh.inUse, zh.users, zh.abnormal]);
      assert.equal(state.rows.length, expected.total);
      assert.deepEqual(aggregateRows(state.rows), {
        total: expected.total,
        enabled: expected.enabled,
        disabled: expected.disabled,
        inUse: expected.inUse,
        chains: expected.chains,
        users: expected.users,
        blocked: expected.blocked,
        degraded: expected.degraded,
        abnormal: expected.abnormal,
      });
      return { values, rows: aggregateRows(state.rows) };
    });

    await check(`normal ${label}: 副行文案与 13px 字号`, () => {
      assert.deepEqual(
        state.cells.map((cell) => cell.hint),
        [zh.totalHint, zh.inUseHint, zh.usersHint, zh.abnormalHint],
      );
      for (const cell of state.cells) {
        assert.equal(cell.hintFont, "13px", `${cell.kind} hint must be 13px`);
      }
      return state.cells.map((cell) => cell.hint);
    });

    await check(`normal ${label}: 异常模板非 0 用 destructive 数字`, () => {
      const abnormal = state.cells.find((cell) => cell.kind === "abnormal");
      assert.ok(
        abnormal?.valueClass?.includes("text-destructive"),
        `abnormal tone: ${abnormal?.valueClass}`,
      );
      return abnormal.valueClass;
    });

    await check(`normal ${label}: 栅格与无横向溢出`, () => {
      assertGeometry(placed.cells, placed.viewportWidth, width);
      assert.equal(placed.docOverflow, 0, "document must not scroll sideways");
      assert.equal(state.kpiState, "ready");
      assert.equal(state.listState, "ready");
      return {
        cells: placed.cells.map((cell) => ({
          kind: cell.kind,
          w: Math.round(cell.rect.width),
          h: Math.round(cell.rect.height),
          x: Math.round(cell.rect.left),
          y: Math.round(cell.rect.top),
        })),
        docOverflow: placed.docOverflow,
      };
    });

    await shoot(page, `templates-${label}.png`, width);
    await context.close();
  }
}

/* ------------------------------------------------------------------ *
 * 空态 / 旧主控（降级）/ 接口失败
 * ------------------------------------------------------------------ */

for (const mode of ["empty", "unsupported"]) {
  for (const width of VIEWPORTS) {
    for (const theme of THEMES) {
      const label = `${width}-${theme}`;
      const context = await newContext(browser, width, theme);
      await interceptTemplates(context, mode);
      const page = await context.newPage();
      await openTemplates(page, mode);
      const state = await page.evaluate(READ);
      await placeSection(page, width);
      const placed = await page.evaluate(READ);

      await check(`${mode} ${label}: 四格都是 —，不是 0`, () => {
        assert.deepEqual(
          state.cells.map((cell) => cell.value),
          [DASH, DASH, DASH, DASH],
        );
        assert.deepEqual(
          state.cells.map((cell) => cell.hint),
          [null, null, null, null],
        );
        assert.equal(
          state.cells.some((cell) => /(^|\D)0(\D|$)/.test(cell.value ?? "")),
          false,
          "dash state must not render 0",
        );
        return state.cells.map((cell) => cell.value);
      });

      await check(`${mode} ${label}: KPI 与列表一起降级`, () => {
        assert.equal(state.kpiState, mode === "empty" ? "empty" : "unavailable");
        assert.equal(state.listState, mode === "empty" ? "empty" : "unavailable");
        if (mode === "empty") {
          assert.ok(state.listText?.includes("还没有转发链模板"));
        } else {
          assert.ok(state.listText?.includes("需要新版本主控"));
          assert.ok(state.listText?.includes("升级主控后刷新"));
        }
        assertGeometry(placed.cells, placed.viewportWidth, width);
        assert.equal(placed.docOverflow, 0);
        return { kpiState: state.kpiState, listState: state.listState };
      });

      await shoot(page, `${mode}-${label}.png`, width);
      await context.close();
    }
  }
}

/* 异常模板为 0：数字必须是 0 + 正常前景色，不能一直红/黄。 */
{
  const context = await newContext(browser, 1440, "dark");
  await interceptTemplates(context, "healthy");
  const page = await context.newPage();
  await openTemplates(page, "normal");
  const state = await page.evaluate(READ);
  await check("healthy 1440-dark: 异常为 0 显示 0 + 正常色", () => {
    assert.deepEqual(
      state.cells.map((cell) => cell.value),
      ["2 个", "2 个", "2 人", "0 个"],
    );
    const abnormal = state.cells.find((cell) => cell.kind === "abnormal");
    assert.ok(abnormal.valueClass.includes("text-foreground"));
    assert.ok(!abnormal.valueClass.includes("text-destructive"));
    assert.ok(!abnormal.valueClass.includes("text-warning"));
    assert.equal(abnormal.hint, "阻断 0 · 降级 0");
    return { value: abnormal.value, className: abnormal.valueClass };
  });
  await shoot(page, "abnormal-zero-1440-dark.png", 1440);
  await context.close();
}

/* 只有降级、没有阻断：数字用 warning，不能用 destructive。 */
{
  const context = await newContext(browser, 1440, "dark");
  await interceptTemplates(context, "degraded-only");
  const page = await context.newPage();
  await openTemplates(page, "normal");
  const state = await page.evaluate(READ);
  await check("degraded-only 1440-dark: 只有降级用 warning", () => {
    const abnormal = state.cells.find((cell) => cell.kind === "abnormal");
    assert.equal(abnormal.value, "1 个");
    assert.equal(abnormal.hint, "阻断 0 · 降级 1");
    assert.ok(abnormal.valueClass.includes("text-warning"));
    assert.ok(!abnormal.valueClass.includes("text-destructive"));
    return { value: abnormal.value, className: abnormal.valueClass };
  });
  await shoot(page, "abnormal-warning-1440-dark.png", 1440);
  await context.close();
}

/* 接口 500：与旧主控一样整块降级，但给的是可重试错误。 */
{
  const context = await newContext(browser, 1440, "dark");
  await interceptTemplates(context, "error");
  const page = await context.newPage();
  await openTemplates(page, "error");
  const state = await page.evaluate(READ);
  await check("error 1440-dark: 接口失败时 KPI 与错误态同屏，不用 0 冒充", () => {
    assert.equal(state.kpiState, "unavailable");
    assert.equal(state.listState, "unavailable");
    assert.deepEqual(
      state.cells.map((cell) => cell.value),
      [DASH, DASH, DASH, DASH],
    );
    assert.ok(state.listText?.includes("数据加载失败"));
    assert.ok(state.listText?.includes("重试"));
    return state.listText?.split("\n").slice(0, 4);
  });
  await shoot(page, "error-1440-dark.png", 1440);
  await context.close();
}

/* 加载中：延迟模板接口，确认 KPI 骨架与列表骨架同时出现。 */
{
  const context = await newContext(browser, 1440, "dark");
  await context.route("**/api/v1/overview/chain-templates", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    await route.continue();
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/?view=chain&section=templates`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("[data-chain-template-kpis-skeleton]").waitFor();
  await page.locator("[data-chain-template-skeleton]").waitFor();
  const loading = await page.evaluate(() => ({
    kpiSkeletonCells: document.querySelectorAll(
      "[data-chain-template-kpi-skeleton]",
    ).length,
    listSkeleton: Boolean(
      document.querySelector("[data-chain-template-skeleton]"),
    ),
    kpiPresent: Boolean(document.querySelector("[data-chain-template-kpis]")),
  }));
  await check("loading 1440-dark: KPI 与列表同时铺骨架", () => {
    assert.equal(loading.kpiSkeletonCells, 4);
    assert.equal(loading.listSkeleton, true);
    assert.equal(loading.kpiPresent, false);
    return loading;
  });
  // 骨架阶段还没有 `[data-chain-template-kpis]`：不能再走 shoot() 的
  // locator.evaluate（Playwright 会等真实卡片出现，等到接口返回后拍成正常态）。
  await page
    .locator("[data-chain-template-kpis-skeleton]")
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(HERE, "loading-1440-dark.png") });
  await context.close();
}

await browser.close();

writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      base: BASE,
      expected,
      zh,
      results,
      failures,
    },
    null,
    2,
  )}\n`,
);

if (failures.length > 0) {
  console.error(`FAILED (${failures.length}):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(
  `OK: ${results.length} checks, ${results.length - failures.length} passed`,
);
