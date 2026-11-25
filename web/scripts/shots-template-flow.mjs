// 转发链模板拓扑（React Flow 画布）的截图 + 运行时断言。
//
// 前置：
//   1) 生产构建已在 web/dist（`cd web && npm run build`）；
//   2) master 跑在 127.0.0.1:8787，且 admin 密码 devpass（隔离库 / 临时库都行）；
//   3) 本脚本用 Playwright route 注入模板列表 / 详情 / 链路时延 mock，不依赖真实模板数据。
//
// 覆盖：3 跳 / 4 跳 / 6 跳、折叠 / 展开、hover 路径、tooltip、100% / 50% / 150% 缩放、
// 390、亮暗、空态、旧主控降级、reduced-motion；并断言每列可见卡 ≤5、首屏缩放
// 0.9–1、滚轮不缩放、Ctrl/⌘ 滚轮缩放、拖拽不丢图、折叠只展开本列、Tab 可达、
// 动画边 ≤10、DOM ≤600、React Flow 署名 ≥12px。
//
// 用法：node web/scripts/shots-template-flow.mjs [baseUrl]
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const WEB = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(WEB, "screenshots", "template-flow");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT, { recursive: true });

const NOW = Math.floor(Date.now() / 1000);
const report = { base: BASE, screenshots: [], assertions: {}, errors: [] };

/* ------------------------------------------------------------------ */
/* 数据：3 / 4 / 6 跳模板 + 空模板                                     */
/* ------------------------------------------------------------------ */

function member(name, chains, users, status = "online", serverId = name) {
  return { server_id: serverId, name, status, chains, users };
}

function edge(fromSeq, fromMember, toSeq, toMember, chains, p50 = 20, users = 1) {
  return {
    seq: toSeq,
    from: { seq: fromSeq, member: fromMember },
    to: { seq: toSeq, member: toMember },
    chains,
    users,
    p50_ms: p50,
    loss_pct: 0,
  };
}

function target(host, port, chains) {
  return { host, port, chains, users: [] };
}

function strategy(name, chains, users) {
  return { strategy: name, chains, users };
}

/** 3 跳：入口 2 台 → 东京 3 台（含降级）→ 洛杉矶 3 台（含离线）→ 6 个目标。 */
function detail3Hop() {
  const nodes = [
    {
      seq: 0,
      role: "source",
      name: "香港入口",
      members: [member("香港-01", 6, 4), member("香港-02", 3, 2)],
    },
    {
      seq: 1,
      role: "hop",
      name: "东京中转",
      members: [
        member("东京-01", 5, 3),
        member("东京-02", 3, 2, "degraded"),
        member("东京-03", 1, 1),
      ],
    },
    {
      seq: 2,
      role: "hop",
      name: "洛杉矶中转",
      members: [
        member("洛杉矶-01", 5, 3),
        member("洛杉矶-02", 3, 2, "offline"),
        member("洛杉矶-03", 1, 1),
      ],
    },
    {
      seq: 3,
      role: "target",
      name: "目标",
      members: [
        member("1.2.3.4:443", 3, 2),
        member("5.6.7.8:8443", 2, 1),
        member("9.9.9.9:443", 1, 1),
        member("10.0.0.1:443", 2, 1),
        member("10.0.0.2:443", 1, 1),
        member("10.0.0.3:443", 1, 1),
      ],
    },
  ];
  const edges = [
    edge(0, "香港-01", 1, "东京-01", 4, 15.5, 3),
    edge(0, "香港-01", 1, "东京-02", 2, 18.2, 2),
    edge(0, "香港-02", 1, "东京-01", 1, 22.4, 1),
    edge(0, "香港-02", 1, "东京-02", 1, 24.1, 1),
    edge(0, "香港-02", 1, "东京-03", 1, 26, 1),
    edge(1, "东京-01", 2, "洛杉矶-01", 3, 120.4, 3),
    edge(1, "东京-01", 2, "洛杉矶-02", 1, 140, 1),
    edge(1, "东京-02", 2, "洛杉矶-01", 2, 128.6, 2),
    edge(1, "东京-02", 2, "洛杉矶-02", 1, 150, 1),
    edge(1, "东京-02", 2, "洛杉矶-03", 1, 152, 1),
    edge(1, "东京-03", 2, "洛杉矶-03", 1, 158, 1),
    edge(2, "洛杉矶-01", 3, "1.2.3.4:443", 2, 160.2, 2),
    edge(2, "洛杉矶-01", 3, "5.6.7.8:8443", 2, 168, 1),
    edge(2, "洛杉矶-01", 3, "9.9.9.9:443", 1, 171, 1),
    edge(2, "洛杉矶-02", 3, "10.0.0.1:443", 2, 190, 1),
    edge(2, "洛杉矶-02", 3, "10.0.0.2:443", 1, 195, 1),
    edge(2, "洛杉矶-03", 3, "10.0.0.3:443", 1, 205, 1),
  ];
  return {
    template: { id: "tpl-3", name: "香港 → 东京 → 洛杉矶", hops: 3, created_at: NOW - 86400 * 9 },
    nodes,
    edges,
    targets: [
      target("1.2.3.4", 443, 3),
      target("5.6.7.8", 8443, 2),
      target("9.9.9.9", 443, 1),
      target("10.0.0.1", 443, 2),
      target("10.0.0.2", 443, 1),
      target("10.0.0.3", 443, 1),
    ],
    users: [],
    series: usageSeries(24),
    strategies: [strategy("ip_hashed", 5, 3), strategy("round_robin", 4, 2)],
  };
}

/** 4 跳：第 1 / 第 3 跳各 7 台（必折叠），目标 7 个。 */
function detail4Hop() {
  const nodes = [
    {
      seq: 0,
      role: "source",
      name: "香港入口",
      members: [member("香港-01", 7, 5)],
    },
    {
      seq: 1,
      role: "hop",
      name: "东京中转",
      members: Array.from({ length: 7 }, (_, index) =>
        member(
          `东京-0${index + 1}`,
          7 - index,
          5 - Math.floor(index / 2),
          index === 5 ? "degraded" : "online",
        ),
      ),
    },
    {
      seq: 2,
      role: "hop",
      name: "洛杉矶中转",
      members: [member("洛杉矶-01", 4, 3), member("洛杉矶-02", 3, 2)],
    },
    {
      seq: 3,
      role: "hop",
      name: "法兰克福中转",
      members: Array.from({ length: 7 }, (_, index) =>
        member(
          `法兰克福-0${index + 1}`,
          7 - index,
          4,
          index === 6 ? "offline" : "online",
        ),
      ),
    },
    {
      seq: 4,
      role: "target",
      name: "目标",
      members: Array.from({ length: 7 }, (_, index) =>
        member(`172.16.0.${index + 1}:8443`, 7 - index, 3),
      ),
    },
  ];
  const edges = [];
  for (let index = 0; index < 7; index += 1) {
    edges.push(
      edge(0, "香港-01", 1, `东京-0${index + 1}`, 7 - index, 12 + index, 4),
    );
  }
  for (let index = 0; index < 7; index += 1) {
    edges.push(
      edge(
        1,
        `东京-0${index + 1}`,
        2,
        index % 2 === 0 ? "洛杉矶-01" : "洛杉矶-02",
        Math.max(1, 7 - index),
        40 + index,
        3,
      ),
    );
  }
  for (let index = 0; index < 7; index += 1) {
    edges.push(
      edge(
        2,
        index < 4 ? "洛杉矶-01" : "洛杉矶-02",
        3,
        `法兰克福-0${index + 1}`,
        Math.max(1, 7 - index),
        90 + index,
        3,
      ),
    );
  }
  for (let index = 0; index < 7; index += 1) {
    edges.push(
      edge(
        3,
        `法兰克福-0${index + 1}`,
        4,
        `172.16.0.${index + 1}:8443`,
        Math.max(1, 7 - index),
        140 + index,
        2,
      ),
    );
  }
  return {
    template: { id: "tpl-4", name: "香港 → 东京 → 洛杉矶 → 法兰克福", hops: 4, created_at: NOW - 86400 * 4 },
    nodes,
    edges,
    targets: Array.from({ length: 7 }, (_, index) =>
      target(`172.16.0.${index + 1}`, 8443, 7 - index),
    ),
    users: [],
    series: usageSeries(24),
    strategies: [strategy("failover", 7, 4), strategy("lowest_latency", 3, 2)],
  };
}

/** 6 跳：每跳 3 台、目标 4 个 —— 深度 + 多层扇出，DOM 仍要 ≤600。 */
function detail6Hop() {
  const perColumn = 3;
  const hops = 6;
  const targets = 4;
  const nodes = [];
  const edges = [];
  for (let seq = 0; seq <= hops; seq += 1) {
    const role = seq === 0 ? "source" : seq === hops ? "target" : "hop";
    nodes.push({
      seq,
      role,
      name: `第 ${seq} 跳`,
      members:
        role === "target"
          ? Array.from({ length: targets }, (_, index) =>
              member(`10.0.${seq}.${index + 1}:443`, targets - index, 4),
            )
          : Array.from({ length: perColumn }, (_, index) =>
              member(
                `s-${seq}-${String(index + 1).padStart(2, "0")}`,
                10 - seq - index,
                4 - index,
                seq === 4 && index === 2 ? "offline" : "online",
              ),
            ),
    });
  }
  for (let seq = 1; seq <= hops; seq += 1) {
    for (let index = 0; index < perColumn; index += 1) {
      edges.push(
        edge(
          seq - 1,
          seq === 1
            ? `s-0-${String(index + 1).padStart(2, "0")}`
            : `s-${seq - 1}-${String(index + 1).padStart(2, "0")}`,
          seq,
          seq === hops
            ? `10.0.${seq}.${index + 1}:443`
            : `s-${seq}-${String(index + 1).padStart(2, "0")}`,
          10 - seq - index,
          10 + seq * 10 + index,
          3,
        ),
      );
      if (seq < hops) {
        edges.push(
          edge(
            seq - 1,
            seq === 1
              ? `s-0-${String(index + 1).padStart(2, "0")}`
              : `s-${seq - 1}-${String(index + 1).padStart(2, "0")}`,
            seq,
            `s-${seq}-${String(((index + 1) % perColumn) + 1).padStart(2, "0")}`,
            8 - seq - index,
            14 + seq * 10 + index,
            2,
          ),
        );
      }
    }
    if (seq === hops) {
      // 目标列多一个上游：3 台 → 4 个目标，必然有 +N。
      edges.push(
        edge(
          seq - 1,
          `s-${seq - 1}-01`,
          seq,
          `10.0.${seq}.${targets}:443`,
          2,
          210,
          1,
        ),
      );
    }
  }
  return {
    template: { id: "tpl-6", name: "香港 → 东京 → 洛杉矶 → 法兰克福 → 伦敦 → 圣保罗", hops: 6, created_at: NOW },
    nodes,
    edges,
    targets: Array.from({ length: targets }, (_, index) =>
      target(`10.0.${hops}.${index + 1}`, 443, targets - index),
    ),
    users: [],
    series: usageSeries(24),
    strategies: [strategy("ip_hashed", 12, 9), strategy("weighted", 8, 4)],
  };
}

function detailEmpty() {
  return {
    template: { id: "tpl-empty", name: "备用模板（未建链）", hops: 2, created_at: NOW - 86400 * 30 },
    nodes: [
      { seq: 0, role: "source", name: "香港入口", members: [member("香港-01", 0, 0)] },
      { seq: 1, role: "hop", name: "东京中转", members: [member("东京-01", 0, 0)] },
      { seq: 2, role: "target", name: "目标", members: [] },
    ],
    edges: [edge(0, "香港-01", 1, "东京-01", 0, null)],
    targets: [],
    users: [],
    series: [],
    strategies: [],
    unused_candidates: [{ seq: 1, server_id: "东京-01", name: "东京-01", status: "offline" }],
  };
}

function usageSeries(hours) {
  const count = hours * 4;
  const end = Math.floor(NOW / 900) * 900;
  return Array.from({ length: count }, (_, index) => ({
    ts: end - (count - 1 - index) * 900,
    chains: Math.min(7, 2 + Math.floor((index + 1) / 12)),
    users: Math.min(5, 1 + Math.floor((index + 1) / 16)),
  }));
}

const LIST_ITEMS = [
  {
    id: "tpl-3",
    name: "香港 → 东京 → 洛杉矶",
    hops: 3,
    enabled: true,
    chains: 9,
    users: 4,
    status: { kind: "ok", cause: null },
    strategies: [strategy("ip_hashed", 5, 3)],
    targets: [target("1.2.3.4", 443, 3)],
  },
  {
    id: "tpl-4",
    name: "香港 → 东京 → 洛杉矶 → 法兰克福",
    hops: 4,
    enabled: true,
    chains: 7,
    users: 4,
    status: { kind: "degraded", cause: "member_unhealthy" },
    strategies: [strategy("failover", 7, 4)],
    targets: [target("172.16.0.1", 8443, 7)],
  },
  {
    id: "tpl-6",
    name: "香港 → 东京 → 洛杉矶 → 法兰克福 → 伦敦 → 圣保罗",
    hops: 6,
    enabled: true,
    chains: 20,
    users: 20,
    status: { kind: "ok", cause: null },
    strategies: [strategy("ip_hashed", 12, 9)],
    targets: [target("10.0.6.1", 443, 20)],
  },
  {
    id: "tpl-empty",
    name: "备用模板（未建链）",
    hops: 2,
    enabled: false,
    chains: 0,
    users: 0,
    status: { kind: "blocked", cause: "disabled" },
    strategies: [],
    targets: [],
  },
];

const DETAILS = {
  "tpl-3": detail3Hop,
  "tpl-4": detail4Hop,
  "tpl-6": detail6Hop,
  "tpl-empty": detailEmpty,
};

function chainHealthPayload() {
  const bucket = 900;
  const end = Math.floor(NOW / bucket) * bucket;
  return {
    generated_at: NOW,
    hours: 24,
    bucket,
    summary: {
      hop_p50_ms: 64,
      delta_ms: 12,
      slow_chains: 1,
      total_chains: 9,
      worst_hop: { chain_id: "chain-1", chain_name: "香港 → 东京", seq: 2, p50_ms: 41 },
    },
    chains: [],
    scope: { server_ids: [], filtered: false },
    warnings: {},
  };
}

/* ------------------------------------------------------------------ */
/* mock + 浏览器                                                       */
/* ------------------------------------------------------------------ */

async function mockApi(page, options = {}) {
  await page.route("**/api/v1/overview/chain-templates**", async (route) => {
    const url = new URL(route.request().url());
    const base = "/api/v1/overview/chain-templates";
    if (url.pathname === base) {
      if (options.listStatus === 404) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "not_found" } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ generated_at: NOW, items: LIST_ITEMS }),
      });
      return;
    }
    if (options.detailStatus === 404) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_found" } }),
      });
      return;
    }
    const id = decodeURIComponent(url.pathname.slice(base.length + 1));
    const hours = Number(url.searchParams.get("hours") ?? "24") === 168 ? 168 : 24;
    const build = DETAILS[id] ?? detail3Hop;
    const payload = build();
    // 使用量窗口换成请求的小时数，其它形状保持一致。
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...payload, series: usageSeries(hours) }),
    });
  });
  await page.route("**/api/v1/overview/chain-health*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(chainHealthPayload()),
    });
  });
}

const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "devpass" }),
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const cookie = login.headers
  .getSetCookie()
  .map((item) => item.split(";")[0])
  .find((item) => item.startsWith("pierwave_session="));
if (!cookie) throw new Error("no session cookie");
const [cookieName, cookieValue] = cookie.split("=");

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function newPage({ width, height, theme, locale = "zh-CN", reducedMotion = false, options = {} }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    reducedMotion: reducedMotion ? "reduce" : "no-preference",
  });
  await context.addInitScript(
    ({ theme, locale }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale },
  );
  await context.addCookies([
    {
      name: cookieName,
      value: cookieValue,
      url: `${BASE}/`,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await mockApi(page, options);
  return { context, page, errors };
}

async function openList(page) {
  await page.goto(`${BASE}/?view=chain&section=templates`, {
    waitUntil: "networkidle",
  });
  await page.locator("[data-chain-template-insight]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
}

async function openDetail(page, index = 0) {
  await page.locator("[data-chain-template-row]").nth(index).click();
  await page.locator("[data-template-dialog]").waitFor();
  await page.locator("[data-template-detail]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function waitFlow(page) {
  await page.locator("[data-template-flow-canvas]").waitFor();
  // React Flow 先量节点尺寸、再算连线位置；Dialog 的入场动画会让这一步更晚。
  // 等第一条连线出现，避免在「只有卡片没有线」的中间帧上断言。
  await page
    .locator("[data-template-flow-edge]").first()
    .waitFor({ state: "attached", timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

async function shot(locator, file, options = {}) {
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({ path: path.join(OUT, file), ...options });
  report.screenshots.push(file);
  console.log(`saved ${file}`);
}

async function zoomPercent(page) {
  const text = await page.locator("[data-flow-zoom-value]").textContent();
  return Number((text ?? "0%").replace("%", ""));
}

async function clickZoom(page, selector, times = 1) {
  for (let index = 0; index < times; index += 1) {
    await page.locator(selector).click();
    await page.waitForTimeout(120);
  }
}

function cardCountsByColumn(page) {
  return page.evaluate(() => {
    const counts = {};
    for (const card of document.querySelectorAll("[data-template-flow-card]")) {
      const column = card.getAttribute("data-column") ?? "?";
      counts[column] = (counts[column] ?? 0) + 1;
    }
    return counts;
  });
}

/* ------------------------------------------------------------------ */
/* 1) 3 跳：首屏缩放 / 每列卡片 / DOM / 动画边 / 署名 / 触屏            */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
  });
  await openList(page);
  // 首屏耗时：从点击行到第一张卡片可见（含懒加载 chunk 请求）。
  await page.evaluate(() => {
    window.__flowStart = performance.now();
  });
  await page.locator("[data-chain-template-row]").first().click();
  await page.locator("[data-template-dialog]").waitFor();
  await page.locator("[data-template-detail]").waitFor();
  await page.locator("[data-template-flow-card]").first().waitFor();
  const firstPaintMs = await page.evaluate(() =>
    Math.round(performance.now() - (window.__flowStart ?? performance.now())),
  );
  await waitFlow(page);

  const zoom = await zoomPercent(page);
  assert.ok(zoom >= 90 && zoom <= 100, `首屏缩放应在 90–100%，实际 ${zoom}%`);

  const counts = await cardCountsByColumn(page);
  for (const [column, count] of Object.entries(counts)) {
    assert.ok(count <= 5, `第 ${column} 列可见卡 ${count} 张，超过 5`);
  }

  const chunkTiming = await page.evaluate(() => {
    const entry = performance
      .getEntriesByType("resource")
      .find((item) => item.name.includes("ChainTemplateFlow-"));
    return entry === undefined
      ? null
      : {
          name: entry.name.split("/").pop(),
          durationMs: Math.round(entry.duration),
          transferSize: entry.transferSize,
          decodedBodySize: entry.decodedBodySize,
        };
  });
  const pulseCount = await page.locator(".template-flow-pulse").count();
  assert.ok(pulseCount > 0, "应有脉冲边");
  assert.ok(pulseCount <= 10, `动画边 ${pulseCount} 条，超过 10`);

  const dom = await page.evaluate(
    () => document.querySelectorAll("[data-template-flow] *").length,
  );
  assert.ok(dom <= 600, `画布 DOM ${dom} 个，超过 600`);

  const style = await page.evaluate(() => {
    const attribution = document.querySelector(".react-flow__attribution");
    const pane = document.querySelector(".react-flow__pane");
    const attributionStyle = attribution ? getComputedStyle(attribution) : null;
    const paneStyle = pane ? getComputedStyle(pane) : null;
    return {
      attributionFontSize: attributionStyle?.fontSize ?? null,
      attributionColor: attributionStyle?.color ?? null,
      mutedColor: (() => {
        const legend = document.querySelector(
          "[data-template-topology-card] .text-muted-foreground",
        );
        return legend === null ? null : getComputedStyle(legend).color;
      })(),
      touchAction: paneStyle?.touchAction ?? null,
    };
  });
  assert.equal(style.attributionFontSize, "12px", "署名应为 12px");
  assert.equal(
    style.attributionColor,
    style.mutedColor,
    "署名应该用 muted-foreground",
  );
  assert.equal(style.touchAction, "pan-y", "pane 需要 touch-action: pan-y");

  const foldCards = await page.locator('[data-template-flow-card][data-kind="fold"]').count();
  const targetFolds = await page.locator("[data-template-flow-target-fold]").count();
  assert.ok(targetFolds > 0, "3 跳目标列应有 +N 目标标签");

  const width = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(width.scrollWidth <= width.innerWidth, "页面不应横向溢出");

  assert.deepEqual(errors, []);
  await shot(page.locator("[data-template-dialog]"), "3hop-1440-dark.png");
  await shot(page.locator("[data-template-topology-card]"), "3hop-topology-1440-dark.png");

  report.assertions["3hop"] = {
    zoom,
    perColumn: counts,
    pulseCount,
    dom,
    attributionFontSize: style.attributionFontSize,
    touchAction: style.touchAction,
    foldCards,
    targetFolds,
    firstPaintMs,
    chunkTiming,
  };

  /* ---- hover 路径：其余卡片 35% ---- */
  const target = page.locator("[data-template-flow-card][data-role='target']").first();
  await target.hover();
  await page.waitForTimeout(250);
  const hot = await page.evaluate(() => ({
    hot: document.querySelectorAll('[data-template-flow-card][data-hot="true"]').length,
    dim: document.querySelectorAll('[data-template-flow-card][data-hot="false"]').length,
  }));
  assert.ok(hot.dim > 0, "hover 时应压暗非路径卡片");
  assert.ok(hot.hot >= 2, "hover 时应点亮到入口的路径");
  await shot(page.locator("[data-template-dialog]"), "hover-path-1440-dark.png");
  report.assertions["hover"] = hot;

  /* ---- tooltip ---- */
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
  const foldedTargetCard = page
    .locator("[data-template-flow-card]")
    .filter({ has: page.locator("[data-template-flow-target-fold]") })
    .first();
  await foldedTargetCard.hover();
  const tooltip = page.locator('[data-slot="tooltip-content"]');
  await tooltip.waitFor({ state: "visible" });
  await page.waitForTimeout(200);
  const tooltipText = (await tooltip.textContent()) ?? "";
  assert.ok(tooltipText.includes("被折叠的目标"), `tooltip 应列出被折叠目标：${tooltipText}`);
  await page.screenshot({ path: path.join(OUT, "tooltip-1440-dark.png") });
  report.screenshots.push("tooltip-1440-dark.png");
  console.log("saved tooltip-1440-dark.png");

  /* ---- 缩放 100% / 50% / 150% ---- */
  await page.mouse.move(5, 5);
  await clickZoom(page, "[data-flow-zoom-in]");
  assert.equal(await zoomPercent(page), 100, "一次 + 应落到 100%");
  const fonts = await page.evaluate(() => {
    const size = (selector, root = document) => {
      const element = root.querySelector(selector);
      return element === null ? null : parseFloat(getComputedStyle(element).fontSize);
    };
    const card = document.querySelector("[data-template-flow-card]");
    return {
      title: size("[data-template-flow-card-title]", card),
      status: size("[data-template-flow-status-text]", card),
      subtitle: size("[data-template-flow-card-subtitle]", card),
      pill: size("[data-template-flow-pill]"),
      attribution: size(".react-flow__attribution"),
    };
  });
  // 100% 缩放下所有 UI 文字 ≥11px，署名 ≥12px（字号下限见 DESIGN.md）。
  for (const [key, value] of Object.entries(fonts)) {
    const floor = key === "attribution" ? 12 : 11;
    assert.ok(
      value !== null && value >= floor,
      `${key} 字号 ${value}px 低于 ${floor}px`,
    );
  }
  report.assertions["fonts"] = fonts;
  await shot(page.locator("[data-template-topology-card]"), "zoom-100-1440-dark.png");
  await clickZoom(page, "[data-flow-zoom-out]", 2);
  assert.equal(await zoomPercent(page), 50, "两次 − 应落到 50%");
  await shot(page.locator("[data-template-topology-card]"), "zoom-50-1440-dark.png");
  await clickZoom(page, "[data-flow-zoom-in]", 4);
  assert.equal(await zoomPercent(page), 150, "四次 + 应落到 150%");
  await shot(page.locator("[data-template-topology-card]"), "zoom-150-1440-dark.png");
  report.assertions["zoomButtons"] = { "100": true, "50": true, "150": true };
  // 适应窗口回到首屏档位（≤100%）。
  await page.locator("[data-flow-zoom-fit]").click();
  await page.waitForTimeout(200);
  const fitZoom = await zoomPercent(page);
  assert.ok(fitZoom >= 40 && fitZoom <= 100, `适应窗口应在 40–100%，实际 ${fitZoom}%`);
  report.assertions["fitZoom"] = fitZoom;

  /* ---- 滚轮：普通滚轮滚弹窗，Ctrl / ⌘ 滚轮缩放 ---- */
  const dialogScroll = page.locator("[data-template-dialog-scroll]");
  await page.evaluate(() => {
    document.querySelector("[data-template-dialog-scroll]").scrollTop = 0;
  });
  const canvasBox = await page.locator("[data-template-flow-canvas]").boundingBox();
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + 80);
  const beforeWheelZoom = await zoomPercent(page);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(250);
  const afterWheelZoom = await zoomPercent(page);
  const scrollTop = await dialogScroll.evaluate((node) => node.scrollTop);
  assert.equal(afterWheelZoom, beforeWheelZoom, "普通滚轮不应缩放画布");
  assert.ok(scrollTop > 0, "普通滚轮应滚动弹窗");

  await page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane");
    pane.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -180,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.waitForTimeout(300);
  const afterCtrlZoom = await zoomPercent(page);
  assert.notEqual(afterCtrlZoom, afterWheelZoom, "Ctrl + 滚轮应缩放画布");
  assert.ok(afterCtrlZoom <= 160, "Ctrl + 滚轮不应超过 160%");

  await page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane");
    pane.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: 180,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.waitForTimeout(300);
  const afterMetaZoom = await zoomPercent(page);
  assert.notEqual(afterMetaZoom, afterCtrlZoom, "⌘ + 滚轮应缩放画布");
  report.assertions["wheel"] = {
    beforeWheelZoom,
    afterWheelZoom,
    scrollTop,
    afterCtrlZoom,
    afterMetaZoom,
  };

  /* ---- 双击不缩放 ---- */
  const beforeDblClick = await zoomPercent(page);
  const canvasBoxDbl = await page.locator("[data-template-flow-canvas]").boundingBox();
  await page.mouse.dblclick(
    canvasBoxDbl.x + canvasBoxDbl.width - 40,
    canvasBoxDbl.y + canvasBoxDbl.height - 20,
  );
  await page.waitForTimeout(300);
  assert.equal(await zoomPercent(page), beforeDblClick, "双击不应缩放画布");
  report.assertions["dblClick"] = { zoom: beforeDblClick };

  /* ---- 拖拽平移：不丢图（卡片数量不变，视口位移） ---- */
  await page.locator("[data-flow-zoom-fit]").click();
  await page.waitForTimeout(250);
  const beforeDrag = await page.evaluate(() => ({
    transform: document.querySelector(".react-flow__viewport").style.transform,
    cards: document.querySelectorAll("[data-template-flow-card]").length,
  }));
  const box = await page.locator("[data-template-flow-canvas]").boundingBox();
  await page.mouse.move(box.x + box.width - 40, box.y + box.height - 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 160, box.y + box.height - 90, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const afterDrag = await page.evaluate(() => ({
    transform: document.querySelector(".react-flow__viewport").style.transform,
    cards: document.querySelectorAll("[data-template-flow-card]").length,
  }));
  assert.equal(afterDrag.cards, beforeDrag.cards, "拖拽后卡片数量不应变化");
  assert.notEqual(afterDrag.transform, beforeDrag.transform, "拖拽应平移视口");
  report.assertions["drag"] = { beforeDrag, afterDrag };

  /* ---- Tab 可达 ---- */
  await page.locator("[data-template-flow-card]").first().focus();
  const tabbed = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      inCanvas: Boolean(active?.closest("[data-template-flow]")),
      tag: active?.tagName ?? null,
      focusable: document.querySelectorAll(
        "[data-template-flow] [tabindex='0'], [data-template-flow] button",
      ).length,
    };
  });
  assert.ok(tabbed.inCanvas, "焦点应能落在画布卡片上");
  assert.ok(tabbed.focusable >= 4, "画布内应有可 Tab 到的卡片");
  report.assertions["tab"] = tabbed;

  /* ---- 亮色主题 ---- */
  // Tab 测试会把焦点留在卡片上（trigger 会开 tooltip、点高亮），先清掉。
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    localStorage.setItem("pierwave.theme", "light");
    const root = document.documentElement;
    root.dataset.theme = "light";
    root.classList.remove("dark");
    root.style.colorScheme = "light";
  });
  await page.waitForTimeout(500);
  await shot(page.locator("[data-template-topology-card]"), "3hop-1440-light.png");

  report.errors.push(...errors.map((error) => `3hop: ${error}`));
  assert.deepEqual(errors, []);
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 1b) 英文：缩放栏与折叠标签都要有英文文案                            */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
    locale: "en",
  });
  await openList(page);
  await openDetail(page, 0);
  await waitFlow(page);
  const enFit = (await page.locator("[data-flow-zoom-fit]").textContent())?.trim();
  const enZoom = (await page.locator("[data-flow-zoom-value]").textContent())?.trim();
  assert.equal(enFit, "Fit to view", "英文缩放栏文案");
  assert.ok(/^\d+%$/.test(enZoom ?? ""), `缩放读数 ${enZoom}`);
  const enCard = await page
    .locator("[data-template-flow-card]")
    .first()
    .getAttribute("aria-label");
  assert.ok((enCard ?? "").includes("Entry"), `英文卡片 aria：${enCard}`);
  await shot(page.locator("[data-template-topology-card]"), "zoom-bar-1440-dark-en.png");
  report.assertions["en"] = { fit: enFit, zoom: enZoom, aria: enCard };
  assert.deepEqual(errors, []);
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 2) 4 跳：折叠 / 展开 / 恢复默认                                     */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
  });
  await openList(page);
  await openDetail(page, 1);
  await waitFlow(page);
  await shot(page.locator("[data-template-dialog]"), "4hop-1440-dark.png");
  const collapsed = await cardCountsByColumn(page);
  const foldCount = await page
    .locator('[data-template-flow-card][data-kind="fold"]')
    .count();
  assert.ok(foldCount >= 2, "4 跳应有至少两张折叠卡");
  assert.ok(await page.locator("[data-template-flow-reset]").count() === 0);
  await shot(page.locator("[data-template-topology-card]"), "collapsed-1440-dark.png");

  const firstFold = page.locator('[data-template-flow-card][data-kind="fold"]').first();
  const foldColumn = await firstFold.getAttribute("data-column");
  await firstFold.click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(350);
  const expanded = await cardCountsByColumn(page);
  assert.ok(
    expanded[foldColumn] > collapsed[foldColumn],
    `展开后第 ${foldColumn} 列应显示更多卡片`,
  );
  // 只展开本列：其它列的折叠卡还在。
  const foldsAfter = await page
    .locator('[data-template-flow-card][data-kind="fold"]')
    .count();
  assert.equal(foldsAfter, foldCount - 1, "只应展开点击的那一列");
  assert.ok(await page.locator("[data-template-flow-reset]").count() === 1);
  await shot(page.locator("[data-template-topology-card]"), "expanded-1440-dark.png");

  // 键盘：Enter / 空格与点击同语义（折叠卡是 role=button）。
  await page.locator("[data-template-flow-reset]").click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const keyboardFold = page
    .locator('[data-template-flow-card][data-kind="fold"]')
    .first();
  await keyboardFold.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const keyboardFolds = await page
    .locator('[data-template-flow-card][data-kind="fold"]')
    .count();
  assert.equal(keyboardFolds, foldCount - 1, "Enter 应展开该列");
  report.assertions["keyboard"] = {
    foldsAfterEnter: keyboardFolds,
    foldsBefore: foldCount,
  };

  // 整图（适应窗口）：5 列比 1040 的弹窗宽，默认 90% 需要平移才看得到目标列。
  await page.locator("[data-flow-zoom-fit]").click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(350);
  await shot(page.locator("[data-template-topology-card]"), "expanded-fit-1440-dark.png");

  await page.locator("[data-template-flow-reset]").click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(350);
  const restored = await page.evaluate(() => ({
    folds: document.querySelectorAll('[data-template-flow-card][data-kind="fold"]').length,
    reset: document.querySelectorAll("[data-template-flow-reset]").length,
  }));
  assert.equal(restored.folds, foldCount, "恢复默认后折叠卡应回来");
  assert.equal(restored.reset, 0, "恢复默认后按钮消失");
  await shot(page.locator("[data-template-topology-card]"), "collapsed-fit-1440-dark.png");

  // 折叠卡 tooltip：列前 8 名 + 最差状态（截图放在折叠/展开之后，避免 tooltip 残留）。
  const foldCard = page.locator('[data-template-flow-card][data-kind="fold"]').first();
  await foldCard.hover();
  const foldTooltip = page.locator('[data-slot="tooltip-content"]');
  await foldTooltip.waitFor({ state: "visible" });
  await page.waitForTimeout(200);
  const foldTooltipText = (await foldTooltip.textContent()) ?? "";
  assert.ok(
    foldTooltipText.includes("被折叠的成员"),
    `折叠卡 tooltip 应列出成员：${foldTooltipText}`,
  );
  await page.screenshot({ path: path.join(OUT, "tooltip-fold-1440-dark.png") });
  report.screenshots.push("tooltip-fold-1440-dark.png");
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);

  // 目标 +N 标签只展开这一组。
  const targetFold = page.locator("[data-template-flow-target-fold]").first();
  if ((await targetFold.count()) > 0) {
    const before = await page.evaluate(
      () => document.querySelectorAll("[data-template-flow-card][data-role='target']").length,
    );
    await targetFold.click();
    await page.waitForTimeout(300);
    const after = await page.evaluate(
      () => document.querySelectorAll("[data-template-flow-card][data-role='target']").length,
    );
    assert.ok(after >= before, "展开目标组后目标卡不应减少");
  }

  const foldDom = await page.evaluate(
    () => document.querySelectorAll("[data-template-flow] *").length,
  );
  assert.ok(foldDom <= 600, `4 跳画布 DOM ${foldDom} 个，超过 600`);
  report.assertions["fold"] = {
    collapsed,
    expanded,
    foldColumn,
    foldsAfter,
    restored,
    dom: foldDom,
  };
  assert.deepEqual(errors, []);
  report.errors.push(...errors.map((error) => `4hop: ${error}`));
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 3) 6 跳：列数 / 折叠 / DOM 预算                                     */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
  });
  await openList(page);
  await openDetail(page, 2);
  await waitFlow(page);
  const counts = await cardCountsByColumn(page);
  assert.ok(Object.keys(counts).length >= 6, "6 跳应有 7 列");
  for (const [column, count] of Object.entries(counts)) {
    assert.ok(count <= 5, `第 ${column} 列 ${count} 张卡，超过 5`);
  }
  const domBreakdown = await page.evaluate(() => ({
    total: document.querySelectorAll("[data-template-flow] *").length,
    cards: document.querySelectorAll("[data-template-flow-card]").length,
    cardsDom: document.querySelectorAll(".react-flow__node *").length,
    handles: document.querySelectorAll(".react-flow__handle").length,
    edges: document.querySelectorAll("[data-template-flow-edge]").length,
    edgeGroups: document.querySelectorAll("[data-template-flow-edge-group]").length,
    edgesDom: document.querySelectorAll(".react-flow__edges *").length,
    pulses: document.querySelectorAll(".template-flow-pulse").length,
    pills: document.querySelectorAll("[data-template-flow-pill]").length,
    chrome: document.querySelectorAll("[data-template-flow] > *").length,
  }));
  const dom = domBreakdown.total;
  console.log("6hop dom", domBreakdown);
  assert.ok(dom <= 600, `6 跳画布 DOM ${dom} 个，超过 600`);
  const zoom = await zoomPercent(page);
  assert.ok(zoom >= 90 && zoom <= 100, `6 跳首屏缩放 ${zoom}% 不在 90–100%`);
  await shot(page.locator("[data-template-dialog]"), "6hop-1440-dark.png");
  // 6 跳整图：适应窗口后能一眼看到「入口 → … → 目标」。
  await page.locator("[data-flow-zoom-fit]").click();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(350);
  const fitZoom = await zoomPercent(page);
  await shot(page.locator("[data-template-topology-card]"), "6hop-fit-1440-dark.png");
  report.assertions["6hop"] = { counts, dom, zoom, fitZoom };
  assert.deepEqual(errors, []);
  report.errors.push(...errors.map((error) => `6hop: ${error}`));
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 4) 390：1 倍 + 横向滚动，页面不横向溢出                             */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 390,
    height: 844,
    theme: "dark",
  });
  await openList(page);
  try {
    await openDetail(page, 2);
  } catch (error) {
    const rows = await page.locator("[data-chain-template-row]").count();
    const html = await page
      .locator("[data-template-dialog]")
      .innerHTML()
      .catch(() => "<no dialog>");
    console.log("390 failure", { rows, html: html.slice(0, 800), url: page.url() });
    throw error;
  }
  await waitFlow(page);
  const compact = await page.evaluate(() => {
    const host = document.querySelector("[data-template-flow]");
    return {
      mode: host.getAttribute("data-template-flow-mode"),
      scrollWidth: host.scrollWidth,
      clientWidth: host.clientWidth,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      zoomBarVisible: Boolean(
        document.querySelector("[data-template-flow-zoom]")?.offsetParent,
      ),
      transform: document.querySelector(".react-flow__viewport").style.transform,
    };
  });
  assert.equal(compact.mode, "compact");
  assert.ok(compact.scrollWidth > compact.clientWidth, "390 画布应可横向滚动");
  assert.ok(compact.overflow <= 0, `390 页面横向溢出 ${compact.overflow}px`);
  assert.equal(compact.zoomBarVisible, false, "390 不显示缩放栏");
  assert.ok(compact.transform.includes("scale(1)"), "390 固定 1 倍");
  await page.screenshot({ path: path.join(OUT, "6hop-390-dark.png") });
  report.screenshots.push("6hop-390-dark.png");
  console.log("saved 6hop-390-dark.png");

  // 画布上竖滑滚弹窗（touch-action: pan-y 的运行时验证）。
  const paneTouch = await page.evaluate(
    () => getComputedStyle(document.querySelector(".react-flow__pane")).touchAction,
  );
  assert.equal(paneTouch, "pan-y");
  report.assertions["390"] = { ...compact, paneTouch };
  assert.deepEqual(errors, []);
  report.errors.push(...errors.map((error) => `390: ${error}`));
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 5) 空态 + 旧主控降级                                                */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
  });
  await openList(page);
  await openDetail(page, 3);
  await page.waitForTimeout(200);
  const empty = await page.evaluate(() => ({
    cards: document.querySelectorAll("[data-template-flow-card]").length,
    text: document.querySelector("[data-template-topology]")?.textContent ?? "",
    unused: document.querySelectorAll("[data-template-unused-member]").length,
  }));
  assert.equal(empty.cards, 0, "空态不应渲染卡片");
  assert.ok(empty.text.length > 0, "空态应有文案");
  assert.ok(empty.unused >= 1, "未使用候选仍要列出来");
  await shot(page.locator("[data-template-topology-card]"), "empty-1440-dark.png");
  report.assertions["empty"] = empty;
  assert.deepEqual(errors, []);
  await context.close();
}

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
    options: { detailStatus: 404 },
  });
  await openList(page);
  // 旧主控没有详情接口：弹窗只到「需要新版本主控」，不会有 detail 区块。
  await page.locator("[data-chain-template-row]").first().click();
  await page.locator("[data-template-dialog]").waitFor();
  await page.waitForTimeout(800);
  const text = (await page.locator("[data-template-dialog]").textContent()) ?? "";
  assert.ok(text.includes("需要新版本主控"), "旧主控应降级成「需要新版本主控」");
  assert.equal(await page.locator("[data-template-flow-canvas]").count(), 0);
  await shot(page.locator("[data-template-dialog]"), "old-master-1440-dark.png");
  report.assertions["oldMaster"] = { text: text.slice(0, 40) };
  // 404 是这一屏的预期结果（旧主控没有详情接口），只允许这一条网络噪音。
  assert.deepEqual(
    errors.filter((error) => !error.includes("404")),
    [],
  );
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 6) reduced-motion：脉冲静止可见                                     */
/* ------------------------------------------------------------------ */

{
  const { context, page, errors } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
    reducedMotion: true,
  });
  await openList(page);
  await openDetail(page, 0);
  await waitFlow(page);
  const pulse = await page.evaluate(() => {
    const first = document.querySelector(".template-flow-pulse");
    if (!first) return null;
    const style = getComputedStyle(first);
    return {
      animationName: style.animationName,
      strokeOpacity: Number(style.strokeOpacity),
      count: document.querySelectorAll(".template-flow-pulse").length,
    };
  });
  assert.ok(pulse !== null, "reduced-motion 下仍应渲染脉冲 path");
  assert.equal(pulse.animationName, "none", "reduced-motion 下不播动画");
  assert.ok(pulse.strokeOpacity > 0.2, "脉冲应静态可见");
  assert.ok(pulse.count <= 10);
  await shot(page.locator("[data-template-topology-card]"), "reduced-motion-1440-dark.png");
  report.assertions["reducedMotion"] = pulse;
  assert.deepEqual(errors, []);
  await context.close();
}

/* ------------------------------------------------------------------ */
/* 7) 性能：chunk 大小 / 主 chunk 不含 React Flow                      */
/* ------------------------------------------------------------------ */

{
  const assets = path.join(WEB, "dist", "assets");
  const files = readdirSync(assets);
  const sizeOf = (file) => statSync(path.join(assets, file)).size;
  const flowChunk = files.find((file) => file.startsWith("ChainTemplateFlow-") && file.endsWith(".js"));
  const mainChunk = files.find((file) => file.startsWith("index-") && file.endsWith(".js"));
  const latencyChunk = files.find((file) => file.startsWith("ChainLatencyView-") && file.endsWith(".js"));
  assert.ok(flowChunk, "应有独立的 ChainTemplateFlow chunk");
  assert.ok(mainChunk, "应有入口 chunk");
  assert.ok(latencyChunk, "应有链路时延 chunk");
  const mainSource = readFileSync(path.join(assets, mainChunk), "utf8");
  const latencySource = readFileSync(path.join(assets, latencyChunk), "utf8");
  assert.equal(mainSource.includes("react-flow__"), false, "主 chunk 不应含 React Flow");
  assert.equal(
    latencySource.includes("react-flow__"),
    false,
    "「链路时延」chunk 不应含 React Flow",
  );
  report.assertions["chunks"] = {
    flowChunk: { file: flowChunk, bytes: sizeOf(flowChunk) },
    mainChunk: { file: mainChunk, bytes: sizeOf(mainChunk) },
    latencyChunk: { file: latencyChunk, bytes: sizeOf(latencyChunk) },
  };
}

await browser.close();
report.build = {
  generatedAt: new Date().toISOString(),
};
const reportPath = path.join(OUT, "report.json");
const fs = await import("node:fs");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.assertions, null, 2));
console.log(`report: ${reportPath}`);
