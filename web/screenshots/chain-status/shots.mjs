#!/usr/bin/env node
/**
 * 链状态（正常 / 降级 / 阻断 / 样本不足）与状态点尺寸的验收截图 + 断言。
 *
 * 后端另一条 lane 尚未把 `chains[].status` 合入本机二进制；这里在浏览器层
 * 按约定的契约补 `status`，并把 3 条真实链分别标成阻断 / 正常（变慢）/
 * 降级，用于同时验收三种视觉状态。节点 `nodes[].status` 本来就是真实接口
 * 返回的（香港 / 东京 / 新加坡 / 大阪），阻断链上的一颗红点也是真实的
 * 「大阪-01 离线」——这正是回归要求：节点离线、其它跳样本正常 → 阻断。
 *
 * 为了让「正常 + 变慢」同时出现，脚本只把「港新直达链」第一段的
 * `delta_ms` 调成 9（≥ 8ms 阈值）；曲线 / P50 / 丢包仍是真实样本。
 *
 * 前置 / Prerequisite:
 *   cp data/preview.db data/chain-status-preview.db   # 并平移样本到当前窗口
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
 *   PIERWAVE_DB='sqlite://data/chain-status-preview.db?mode=rwc' \
 *     ./target/debug/pierwave-master
 *   cd web && npm run dev
 *
 * 用法 / Usage:
 *   node web/screenshots/chain-status/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
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
assert.equal(loginResponse.status, 200, "admin login failed");
const sessionCookie = loginResponse.headers
  .getSetCookie()
  .map((item) => item.split(";")[0])
  .find((item) => item.startsWith("pierwave_session="));
assert.ok(sessionCookie, "session cookie must exist");

async function apiGet(url) {
  const response = await fetch(`${BASE}${url}`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(response.status, 200, `GET ${url} -> ${response.status}`);
  return response.json();
}

const health24 = await apiGet("/api/v1/overview/chain-health?hours=24&bucket=900");
const byName = new Map(health24.chains.map((chain) => [chain.name, chain]));
const BLOCKED = byName.get("港日中转链");
const NORMAL = byName.get("港新直达链");
const DEGRADED = byName.get("港日多路径");
assert.ok(BLOCKED?.id && NORMAL?.id && DEGRADED?.id, "need the three preview chains");

const INJECTED_STATUS = {
  [BLOCKED.id]: {
    kind: "blocked",
    cause: "node_offline",
    node: { seq: 3, name: "大阪-01" },
  },
  [NORMAL.id]: { kind: "ok", cause: null, node: null },
  [DEGRADED.id]: {
    kind: "degraded",
    cause: "node_unhealthy",
    node: { seq: 1, name: "东京-01" },
  },
};

/**
 * 只补契约字段：
 * - `chains[].status`（后端 lane 尚未合入）；
 * - 让「正常」链出现一次「变慢」（改一段 delta，阈值仍是 8ms）；
 * - 降级链把故障点从大阪换到东京，保持拓扑红点与徽章原因一致。
 */
function enrich(payload) {
  for (const chain of payload.chains ?? []) {
    chain.status = INJECTED_STATUS[chain.id] ?? null;
    if (chain.id === DEGRADED.id) {
      for (const node of chain.nodes ?? []) {
        if (node.name === "东京-01") node.status = "unhealthy";
        if (node.name === "大阪-01") node.status = "online";
      }
    }
    if (chain.id === NORMAL.id) {
      const segment = [...(chain.segments ?? [])].sort((a, b) => a.seq - b.seq)[0];
      if (segment) segment.delta_ms = 9;
      payload.summary.slow_chains = 2;
    }
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * 截图 / 断言基础设施
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

async function newPage(browser, width, theme, options = {}) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 1000 },
    colorScheme: theme,
    reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
    deviceScaleFactor: 1,
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
      name: sessionCookie.split("=")[0],
      value: sessionCookie.split("=")[1],
      url: BASE,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.route("**/api/v1/overview/chain-health*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: enrich(body) });
  });
  return { context, page: await context.newPage() };
}

async function openList(page) {
  await page.goto(`${BASE}/?view=chain`, { waitUntil: "networkidle" });
  await page.locator("[data-chain-list-card]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function openDetail(page, chainId) {
  await page.goto(`${BASE}/?view=chain&chain=${chainId}`, {
    waitUntil: "networkidle",
  });
  await page.locator("[data-chain-detail-status]").waitFor();
  await page.locator("[data-chain-topology]").waitFor();
  // 状态徽章的 data-state 必须已经落到 DOM，避免读到上一帧。
  await page.waitForFunction(
    () => Boolean(document.querySelector("[data-chain-status-badge]")?.dataset.state),
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

/** 浏览器把 `49.0` 序列化成 `49`；比较颜色前统一掉无意义的 `.0`。 */
function normalizeColor(value) {
  return value.replace(/(\d)\.0(?=[\s)])/g, "$1");
}

async function shootCard(page, selector, file) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `no box for ${selector}`);
  await page.screenshot({ path: path.join(HERE, file), clip: box });
}

async function shootViewport(page, file) {
  await page.screenshot({ path: path.join(HERE, file) });
}

const READ_LIST = () => {
  const readColor = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const rows = [...document.querySelectorAll("[data-chain-list-row]")].map(
    (row) => {
      const status = row.querySelector("[data-chain-status]");
      const dot = row.querySelector("[data-chain-status-dot]");
      const dotRect = dot?.getBoundingClientRect();
      const slow = row.querySelector("[data-chain-slow-badge]");
      const reason = row.querySelector("[data-chain-status-reason]");
      return {
        id: row.dataset.chainId,
        state: status?.dataset.chainStatus ?? null,
        label: status?.textContent?.trim() ?? null,
        title: status?.getAttribute("title") ?? null,
        dot: dot
          ? {
              width: dotRect.width,
              height: dotRect.height,
              background: getComputedStyle(dot).backgroundColor,
            }
          : null,
        slow: slow?.textContent?.trim() ?? null,
        reason: reason?.textContent?.trim() ?? null,
        rowOverflow:
          row.scrollWidth > row.clientWidth + 1
            ? { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth }
            : null,
      };
    },
  );
  return {
    rows,
    docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    primary: readColor("--primary"),
    warning: readColor("--warning"),
    destructive: readColor("--destructive"),
  };
};

const READ_DETAIL = () => {
  const readColor = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const badge = document.querySelector("[data-chain-status-badge]");
  const nodes = [...document.querySelectorAll("[data-chain-topology-node]")].map(
    (node) => {
      const dot = node.querySelector("[data-chain-topology-node-dot]");
      const rect = dot?.getBoundingClientRect();
      return {
        name: node.title,
        role: node.dataset.role,
        status: node.dataset.status,
        dot: dot
          ? {
              width: rect.width,
              height: rect.height,
              background: getComputedStyle(dot).backgroundColor,
              animation: getComputedStyle(dot).animationName,
            }
          : null,
      };
    },
  );
  return {
    badge: badge
      ? {
          state: badge.dataset.state,
          text: badge.textContent?.trim() ?? "",
          title: badge.getAttribute("title"),
        }
      : null,
    badgeDot: (() => {
      const dot = document.querySelector("[data-chain-status-badge-dot]");
      const rect = dot?.getBoundingClientRect();
      return rect ? { width: rect.width, height: rect.height } : null;
    })(),
    nodes,
    success: readColor("--success"),
    destructive: readColor("--destructive"),
    warning: readColor("--warning"),
  };
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
});

for (const width of VIEWPORTS) {
  for (const theme of THEMES) {
    const tag = `${width} ${theme}`;

    /* ----------------------------- 列表 ----------------------------- */
    const { context, page } = await newPage(browser, width, theme);
    await openList(page);
    const list = await page.evaluate(READ_LIST);
    const statusById = new Map(list.rows.map((row) => [row.id, row]));

    await check(`${tag}: list shows 阻断 / 正常 / 降级`, () => {
      assert.equal(statusById.get(BLOCKED.id)?.state, "blocked");
      assert.equal(statusById.get(BLOCKED.id)?.label, "阻断");
      assert.equal(statusById.get(NORMAL.id)?.state, "ok");
      assert.equal(statusById.get(NORMAL.id)?.label, "正常");
      assert.equal(statusById.get(DEGRADED.id)?.state, "degraded");
      assert.equal(statusById.get(DEGRADED.id)?.label, "降级");
      return list.rows.map((row) => `${row.label}:${row.state}`);
    });

    await check(`${tag}: list status dot is 8px with semantic colours`, () => {
      for (const row of list.rows) {
        assert.ok(row.dot, `${row.id} needs a status dot`);
        assert.equal(row.dot.width, 8, `${row.id} width`);
        assert.equal(row.dot.height, 8, `${row.id} height`);
        const expected =
          row.state === "blocked"
            ? list.destructive
            : row.state === "degraded"
              ? list.warning
              : list.primary;
        assert.equal(
          normalizeColor(row.dot.background),
          normalizeColor(expected),
          `${row.id} colour`,
        );
      }
      return list.rows.map((row) => row.dot);
    });

    await check(`${tag}: offline node adds an inline reason and a title`, () => {
      const row = statusById.get(BLOCKED.id);
      assert.equal(row.reason, "节点 大阪-01 离线");
      assert.match(row.title, /^阻断 · 节点 大阪-01 离线$/);
      assert.equal(statusById.get(DEGRADED.id)?.reason, "节点 东京-01 异常");
      assert.equal(statusById.get(NORMAL.id)?.reason, null);
      return { blocked: row.reason, degraded: statusById.get(DEGRADED.id)?.reason };
    });

    await check(`${tag}: slow badge only on an ok chain`, () => {
      // 阻断链的时延同样 ≥ 8ms，但状态已经是阻断，不能同时挂「变慢」。
      assert.equal(statusById.get(BLOCKED.id)?.slow, null);
      assert.equal(statusById.get(DEGRADED.id)?.slow, null);
      assert.equal(statusById.get(NORMAL.id)?.slow, "变慢");
      return { blocked: null, degraded: null, ok: "变慢" };
    });

    await check(`${tag}: list rows and page do not overflow`, () => {
      for (const row of list.rows) {
        assert.equal(row.rowOverflow, null, `${row.id} overflows`);
      }
      if (width === 390) assert.ok(list.docOverflow <= 1, `page ${list.docOverflow}px wider`);
      return { docOverflow: list.docOverflow };
    });

    const listFile = `list-${width}-${theme}.png`;
    if (width === 390) {
      await page.locator("[data-chain-list-card]").scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      await shootViewport(page, listFile);
    } else {
      await shootCard(page, "[data-chain-list-card]", listFile);
    }
    await context.close();

    /* ---------------------------- 详情（阻断） ---------------------------- */
    const blockedPage = await newPage(browser, width, theme);
    await openDetail(blockedPage.page, BLOCKED.id);
    const blocked = await blockedPage.page.evaluate(READ_DETAIL);

    await check(`${tag}: detail badge is 阻断 · 大阪-01 离线`, () => {
      assert.equal(blocked.badge?.state, "blocked");
      assert.equal(blocked.badge?.text, "阻断 · 大阪-01 离线");
      assert.ok(blocked.badgeDot);
      assert.equal(blocked.badgeDot.width, 8);
      return blocked.badge;
    });

    await check(`${tag}: topology dot is 7px and the offline node is red`, () => {
      const serverNodes = blocked.nodes.filter((node) => node.role !== "target");
      assert.ok(serverNodes.length >= 3);
      for (const node of serverNodes) {
        assert.ok(node.dot, `${node.name} needs a dot`);
        assert.equal(node.dot.width, 7, `${node.name} width`);
        assert.equal(node.dot.height, 7, `${node.name} height`);
      }
      const offline = blocked.nodes.find((node) => node.name === "大阪-01");
      assert.equal(offline?.status, "offline");
      assert.equal(normalizeColor(offline?.dot?.background ?? ""), normalizeColor(blocked.destructive));
      assert.equal(offline?.dot?.animation, "none");
      const online = blocked.nodes.find((node) => node.status === "online");
      assert.equal(normalizeColor(online?.dot?.background ?? ""), normalizeColor(blocked.success));
      assert.equal(online?.dot?.animation, "status-breathe");
      const target = blocked.nodes.find((node) => node.role === "target");
      assert.equal(target?.dot, null);
      return blocked.nodes;
    });

    if (width === 390) {
      await shootViewport(blockedPage.page, `detail-blocked-${width}-${theme}.png`);
    } else {
      await shootCard(blockedPage.page, "[data-chain-dialog]", `detail-blocked-${width}-${theme}.png`);
    }
    await blockedPage.context.close();

    /* ---------------------------- 详情（降级） ---------------------------- */
    const degradedPage = await newPage(browser, width, theme);
    await openDetail(degradedPage.page, DEGRADED.id);
    const degraded = await degradedPage.page.evaluate(READ_DETAIL);
    await check(`${tag}: detail badge is 降级 · 东京-01 异常`, () => {
      assert.equal(degraded.badge?.state, "degraded");
      assert.equal(degraded.badge?.text, "降级 · 东京-01 异常");
      const unhealthy = degraded.nodes.find((node) => node.name === "东京-01");
      assert.equal(unhealthy?.status, "unhealthy");
      assert.equal(normalizeColor(unhealthy?.dot?.background ?? ""), normalizeColor(degraded.destructive));
      return degraded.badge;
    });
    if (width === 1440) {
      await shootCard(
        degradedPage.page,
        "[data-chain-dialog]",
        `detail-degraded-${width}-${theme}.png`,
      );
    }
    await degradedPage.context.close();
  }
}

/* ------------------------- prefers-reduced-motion ------------------------- */
{
  const { context, page } = await newPage(browser, 1440, "dark", {
    reducedMotion: true,
  });
  await openDetail(page, BLOCKED.id);
  const detail = await page.evaluate(READ_DETAIL);
  await check("reduced motion stops the breathing dot", () => {
    const online = detail.nodes.find((node) => node.status === "online");
    assert.ok(online?.dot);
    assert.equal(online.dot.animation, "none");
    return { online: online?.name };
  });
  await context.close();
}

await browser.close();

writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      base: BASE,
      chains: {
        blocked: { id: BLOCKED.id, name: BLOCKED.name },
        normal: { id: NORMAL.id, name: NORMAL.name },
        degraded: { id: DEGRADED.id, name: DEGRADED.name },
      },
      total: results.length,
      passed: results.filter((result) => result.ok).length,
      results,
    },
    null,
    2,
  )}\n`,
);

if (failures.length > 0) {
  console.error(`FAILED ${failures.length}/${results.length}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`PASS ${results.length}/${results.length}`);
