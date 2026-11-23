#!/usr/bin/env node
/**
 * 链路拓扑节点 / 整体时延时间轴 / 图例 / tooltip 的验收截图与断言。
 *
 * 数据来自真实主控（`data/preview.db` 的副本，样本已平移进当前 24h 窗口）。
 * 后端 `chains[].nodes` 与「最后一跳」样本所在的 lane 尚未合入本机二进制，
 * 这里只在浏览器层把响应补成文档里的契约：nodes / status / 最后一跳 segment。
 * 其余字段（series / 窗口丢包 / entry / exit / 链列表）都来自真实接口。
 *
 * 前置 / Prerequisite:
 *   cp data/preview.db data/chain-topology-polish.db   # 并用 seed 脚本平移样本
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
 *   PIERWAVE_DB='sqlite://data/chain-topology-polish.db?mode=rwc' \
 *     ./target/debug/pierwave-master
 *   cd web && npm run dev
 *
 * 用法 / Usage:
 *   node web/screenshots/chain-topology-polish/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

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
const health7d = await apiGet("/api/v1/overview/chain-health?hours=168&bucket=3600");
const picked =
  health24.chains.reduce((best, chain) =>
    (chain.hops ?? 0) > (best.hops ?? 0) ? chain : best,
  ) ?? health24.chains[0];
assert.ok(picked?.id, "need at least one chain in the preview DB");
const CHAIN_ID = picked.id;
const CHAIN_HOPS = picked.hops;

/* ------------------------------------------------------------------ *
 * 契约注入：只补 nodes / status / 最后一跳，不改真实数值
 * ------------------------------------------------------------------ */

function groupsFor(chain) {
  const segments = [...(chain.segments ?? [])].sort((a, b) => a.seq - b.seq);
  const missingLast = (chain.missing_hops ?? []).includes(chain.hops);
  const groups = [];
  const push = (name) => {
    const text = typeof name === "string" ? name.trim() : "";
    if (text !== "" && !groups.includes(text)) groups.push(text);
  };
  for (const segment of segments) push(segment.from);
  // 最后一跳缺失时，最后一条已有段的 to 才是最后一台服务器；否则 to 是链目标。
  if (missingLast) push(segments.at(-1)?.to);
  if (groups.length === 0) {
    push(chain.entry?.server_name);
    push(chain.exit?.server_name);
  }
  return { segments, groups, missingLast };
}

function statusFor(index, faultIndex) {
  return index === faultIndex ? "offline" : "online";
}

function enrichChain(chain, options) {
  const { segments, groups, missingLast } = groupsFor(chain);
  const nodes = groups.map((name, index) => ({
    seq: index,
    server_id: null,
    name,
    role: index === 0 ? "source" : "hop",
    status: statusFor(index, options.faultIndex ?? -1),
  }));
  nodes.push({
    seq: groups.length,
    server_id: null,
    name: "链目标",
    role: "target",
    status: null,
  });
  chain.nodes = nodes;

  if (missingLast && options.fillLastHop !== false) {
    const points = (chain.series ?? [])
      .filter((point) => point && point.p50 !== null && point.p50 !== undefined)
      .slice(-96);
    const latest = points.at(-1)?.p50 ?? 30;
    const p50 = Math.max(1, Math.round(latest * 0.2 * 10) / 10);
    const series = points.map((point, index) => ({
      ts: point.ts,
      p50: Math.max(1, Math.round(point.p50 * 0.2 * 10) / 10 + (index % 3) - 1),
      samples: Math.max(1, point.samples ?? 3),
      loss_pct: 0.2,
    }));
    chain.segments = [
      ...segments,
      {
        seq: chain.hops,
        from: groups.at(-1) ?? chain.entry?.server_name ?? "—",
        to: "链目标",
        p50,
        delta_ms: 1.4,
        contribution_pct: 5,
        loss_pct: 0.2,
        attempts: 240,
        failures: 1,
        series,
      },
    ];
    chain.missing_hops = [];
    chain.estimated = false;
  }
  return chain;
}

function enrich(payload, options) {
  for (const chain of payload.chains ?? []) enrichChain(chain, options);
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
    await route.fulfill({ response, json: enrich(body, options) });
  });
  return { context, page: await context.newPage() };
}

async function openList(page) {
  await page.goto(`${BASE}/?view=chain`, { waitUntil: "networkidle" });
  await page.locator("[data-chain-trend-card]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function openDetail(page) {
  await page.goto(`${BASE}/?view=chain&chain=${CHAIN_ID}`, {
    waitUntil: "networkidle",
  });
  await page.locator("[data-chain-dialog]").waitFor();
  await page.locator("[data-chain-overall-card]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function selectRange(page, range) {
  const label = range === "7d" ? "7 天" : "24 小时";
  await page.getByRole("tab", { name: label }).click();
  await page.waitForFunction(
    (wantDate) =>
      [...document.querySelectorAll("[data-chain-time-tick]")].some(
        (tick) =>
          tick.dataset.kind === "last" &&
          (wantDate
            ? tick.textContent.includes("/")
            : !tick.textContent.includes("/")),
      ),
    range === "7d",
    { timeout: 10_000 },
  );
  await page.waitForTimeout(500);
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

/** 读出拓扑、时间轴、图例的全部可断言状态。 */
const READ_STATE = ({ range, hops }) => {
  const readColor = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const nodes = [...document.querySelectorAll("[data-chain-topology-node]")].map(
    (node) => {
      const label = node
        .querySelector("[data-chain-topology-node-label] span")
        ?.textContent?.trim();
      const dot = node.querySelector("[data-chain-topology-node-dot]");
      return {
        label,
        role: node.dataset.role,
        status: node.dataset.status,
        border: getComputedStyle(node).borderStyle,
        dot: dot
          ? {
              background: getComputedStyle(dot).backgroundColor,
              animation: getComputedStyle(dot).animationName,
            }
          : null,
      };
    },
  );
  const edges = [...document.querySelectorAll("[data-chain-topology-edge]")].map(
    (edge) => ({
      seq: Number(edge.dataset.seq),
      missing: edge.dataset.missing === "true",
      latency: edge.querySelector("[data-chain-topology-edge-latency]")
        ?.textContent,
      loss: edge.querySelector("[data-chain-topology-edge-loss]")?.textContent,
    }),
  );
  const edgeGeometry = [...document.querySelectorAll("[data-chain-topology-edge]")].map(
    (edge) => {
      const line = edge.querySelector("[data-chain-topology-edge-line]");
      const latency = edge.querySelector("[data-chain-topology-edge-latency]");
      const loss = edge.querySelector("[data-chain-topology-edge-loss]");
      const lineRect = line.getBoundingClientRect();
      const latencyRect = latency.getBoundingClientRect();
      const lossRect = loss.getBoundingClientRect();
      const lineCenter = (lineRect.left + lineRect.right) / 2;
      return {
        seq: Number(edge.dataset.seq),
        latencyGap: Math.round((lineRect.top - latencyRect.bottom) * 10) / 10,
        lossGap: Math.round((lossRect.top - lineRect.bottom) * 10) / 10,
        latencyCenterOffset:
          Math.round(
            Math.abs((latencyRect.left + latencyRect.right) / 2 - lineCenter) * 10,
          ) / 10,
        lossCenterOffset:
          Math.round(
            Math.abs((lossRect.left + lossRect.right) / 2 - lineCenter) * 10,
          ) / 10,
      };
    },
  );
  const ticks = [...document.querySelectorAll("[data-chain-time-tick]")].map(
    (tick) => ({
      text: tick.textContent,
      kind: tick.dataset.kind,
      ts: Number(tick.dataset.ts),
      left: tick.style.left,
    }),
  );
  const legend = document.querySelector("[data-chain-overall-legend]");
  const swatches = legend
    ? [...legend.querySelectorAll('[aria-hidden="true"]')].map((swatch) => ({
        className: swatch.className,
        background: getComputedStyle(swatch).backgroundColor,
      }))
    : [];
  const anomaly = document.querySelector("[data-chain-anomaly]");
  const gridlines = document.querySelectorAll("[data-chain-time-gridline]");
  const axisNow = document.querySelector("[data-chain-axis-now]");
  const diagnosis = document.querySelector("[data-chain-diagnosis]");
  const scroll = document.querySelector("[data-chain-topology-scroll]");
  const row = document.querySelector("[data-chain-topology]");
  const content = scroll?.parentElement;
  const topologyFill = {
    scrollWidth: scroll?.scrollWidth ?? 0,
    clientWidth: scroll?.clientWidth ?? 0,
    rowRight: row ? Math.round(row.getBoundingClientRect().right) : 0,
    contentRight: content
      ? Math.round(
          content.getBoundingClientRect().right -
            Number.parseFloat(getComputedStyle(content).paddingRight || "0"),
        )
      : 0,
  };
  return {
    nodes,
    edges,
    edgeGeometry,
    ticks,
    swatches,
    anomalyFill: anomaly?.getAttribute("fill") ?? null,
    gridlineCount: gridlines.length,
    nowReference: axisNow?.textContent?.trim() ?? null,
    topologyFill,
    diagnosis: diagnosis
      ? {
          className: diagnosis.className,
          background: getComputedStyle(diagnosis).backgroundColor,
          border: getComputedStyle(diagnosis).borderColor,
          color: getComputedStyle(diagnosis).color,
        }
      : null,
    primary: readColor("--primary"),
    foreground: readColor("--foreground"),
    success: readColor("--success"),
    destructive: readColor("--destructive"),
    warning: readColor("--warning"),
    range,
    hops,
  };
};

/** 唯一断言集：每个 viewport × theme 都跑一遍。 */
async function assertDetail(page, width, theme, range, options) {
  const state = await page.evaluate(READ_STATE, { range, hops: CHAIN_HOPS });
  const tag = `${range} ${width} ${theme}`;

  await check(`${tag}: topology labels`, () => {
    const expected = [
      "SOURCE",
      ...Array.from(
        { length: Math.max(0, state.nodes.length - 2) },
        (_value, index) => `HOP ${index + 1}`,
      ),
      "TARGET",
    ];
    assert.deepEqual(
      state.nodes.map((node) => node.label),
      expected,
    );
    return expected;
  });

  await check(`${tag}: status dots`, () => {
    for (const [index, node] of state.nodes.entries()) {
      if (node.role === "target") {
        assert.equal(node.dot, null, "target must not render a status dot");
        assert.equal(node.border, "dashed", "target must be dashed");
        continue;
      }
      assert.ok(node.dot, `${node.label} needs a status dot`);
      if (node.status === "online") {
        assert.equal(node.dot.animation, "status-breathe");
        assert.equal(node.dot.background, state.success);
      } else {
        assert.equal(node.dot.animation, "none");
        assert.equal(node.dot.background, state.destructive);
      }
      assert.notEqual(index, -1);
    }
    return state.nodes.map((node) => ({
      label: node.label,
      status: node.status,
      dot: node.dot,
      border: node.border,
    }));
  });

  await check(`${tag}: final hop has real data`, () => {
    const last = state.edges.at(-1);
    assert.ok(last, "topology needs a final edge");
    assert.equal(last.seq, CHAIN_HOPS);
    assert.equal(last.missing, false);
    assert.doesNotMatch(last.latency ?? "", /无历史数据|No history/);
    return last;
  });

  await check(`${tag}: time ticks`, () => {
    assert.ok(
      state.ticks.length >= 5 && state.ticks.length <= 7,
      `tick count ${state.ticks.length}`,
    );
    const interval = state.ticks.filter((tick) => tick.kind === "interval");
    const expectedGap = range === "7d" ? 86_400 : 14_400;
    for (let index = 1; index < interval.length; index += 1) {
      assert.equal(interval[index].ts - interval[index - 1].ts, expectedGap);
    }
    const last = state.ticks.at(-1);
    assert.equal(last.kind, "last");
    const date = new Date((last.ts + 8 * 3_600) * 1_000);
    const pad = (value) => String(value).padStart(2, "0");
    const expected =
      range === "7d"
        ? `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(
            date.getUTCHours(),
          )}:00`
        : `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
    assert.equal(last.text, expected);
    assert.equal(state.gridlineCount, state.ticks.length);
    if (state.nowReference !== null) {
      assert.doesNotMatch(state.nowReference, /现在\s*$/);
    }
    return {
      count: state.ticks.length,
      intervalGap: range === "7d" ? 86_400 : 14_400,
      first: state.ticks[0].text,
      last: last.text,
      gridlines: state.gridlineCount,
      nowReference: state.nowReference,
    };
  });

  await check(`${tag}: edge labels hug the connector`, () => {
    assert.ok(state.edgeGeometry.length >= 2);
    for (const edge of state.edgeGeometry) {
      assert.ok(
        edge.latencyGap >= 0 && edge.latencyGap <= 6,
        `seg ${edge.seq} latency gap ${edge.latencyGap}`,
      );
      assert.ok(
        edge.lossGap >= 0 && edge.lossGap <= 6,
        `seg ${edge.seq} loss gap ${edge.lossGap}`,
      );
      assert.ok(
        edge.latencyCenterOffset <= 2,
        `seg ${edge.seq} latency center offset ${edge.latencyCenterOffset}`,
      );
      assert.ok(
        edge.lossCenterOffset <= 2,
        `seg ${edge.seq} loss center offset ${edge.lossCenterOffset}`,
      );
    }
    return state.edgeGeometry;
  });

  await check(`${tag}: topology fills the card`, () => {
    const gap = state.topologyFill.contentRight - state.topologyFill.rowRight;
    if (width >= 768) {
      assert.ok(
        state.topologyFill.scrollWidth - state.topologyFill.clientWidth <= 1,
        "desktop topology must not overflow",
      );
      assert.ok(gap >= 0 && gap <= 6, `right gap ${gap}`);
    }
    return {
      ...state.topologyFill,
      rightGap: gap,
      overflow:
        state.topologyFill.scrollWidth - state.topologyFill.clientWidth,
    };
  });

  await check(`${tag}: diagnosis bar uses primary`, () => {
    assert.ok(state.diagnosis, "diagnosis block must render");
    assert.match(state.diagnosis.className, /bg-primary\/10/);
    assert.match(state.diagnosis.className, /border-primary\/30/);
    assert.match(state.diagnosis.className, /text-foreground/);
    assert.doesNotMatch(state.diagnosis.className, /warning/);
    assert.equal(state.diagnosis.color, state.foreground);
    return state.diagnosis;
  });

  await check(`${tag}: legend uses primary only`, () => {
    assert.equal(state.swatches.length, 3);
    for (const swatch of state.swatches) {
      assert.match(swatch.className, /bg-primary/);
      assert.doesNotMatch(swatch.className, /warning|destructive/);
      assert.notEqual(swatch.background, state.warning);
    }
    assert.equal(state.anomalyFill, "var(--primary)");
    return state.swatches.map((swatch) => swatch.className);
  });

  await check(`${tag}: target scrollable on 390`, async () => {
    if (width !== 390) return "desktop";
    const overflow = await page
      .locator("[data-chain-topology-scroll]")
      .evaluate((element) => element.scrollWidth - element.clientWidth);
    assert.ok(overflow > 0, `expected horizontal overflow, got ${overflow}`);
    return `${overflow}px overflow`;
  });

  if (options?.faultIndex !== undefined) {
    await check(`${tag}: fault dot is red and still`, () => {
      const fault = state.nodes[options.faultIndex];
      assert.equal(fault.status, "offline");
      assert.equal(fault.dot?.animation, "none");
      assert.equal(fault.dot?.background, state.destructive);
      return fault;
    });
  }
}

async function hoverTrend(page) {
  const surface = page.locator("[data-chain-trend-chart] .recharts-surface");
  await surface.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const box = await surface.boundingBox();
  await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.55);
  await page.waitForTimeout(350);
  return page.locator("[data-chain-trend-tooltip]").innerText();
}

async function hoverSegment(page) {
  const surface = page.locator("[data-chain-segment-chart] .recharts-surface");
  await surface.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const box = await surface.boundingBox();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.45);
  await page.waitForTimeout(350);
  return page.locator("[data-segment-tooltip]").innerText();
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

const browser = await chromium.launch({ channel: "chrome", headless: true });

for (const width of VIEWPORTS) {
  for (const theme of THEMES) {
    const normal = await newPage(browser, width, theme, { fillLastHop: true });
    try {
      const page = normal.page;
      await openList(page);
      await shootCard(page, "[data-chain-trend-card]", `trend-24h-${width}-${theme}.png`);

      // 整体趋势的 tooltip：24h 密集数据，确认文案里没有「该时刻」。
      const trendTooltip = await hoverTrend(page);
      await check(`trend tooltip ${width} ${theme}`, () => {
        assert.match(trendTooltip, /丢包/);
        assert.doesNotMatch(trendTooltip, /该时刻|at that time/i);
        return trendTooltip.replace(/\s+/g, " ").trim();
      });
      await shootViewport(page, `tooltip-trend-${width}-${theme}.png`);

      await page.getByRole("tab", { name: "7 天" }).click();
      await page.waitForTimeout(900);
      await shootCard(page, "[data-chain-trend-card]", `trend-7d-${width}-${theme}.png`);

      await openDetail(page);
      await assertDetail(page, width, theme, "24h", {});
      await shootCard(
        page,
        "[data-chain-topology-card]",
        `topology-${width}-${theme}.png`,
      );
      await shootCard(
        page,
        "[data-chain-overall-card]",
        `overall-24h-${width}-${theme}.png`,
      );
      await shootCard(
        page,
        "[data-chain-diagnosis]",
        `diagnosis-${width}-${theme}.png`,
      );

      const segmentTooltip = await hoverSegment(page);
      await check(`segment tooltip ${width} ${theme}`, () => {
        assert.match(segmentTooltip, /丢包/);
        assert.doesNotMatch(segmentTooltip, /该时刻|at that time/i);
        return segmentTooltip.replace(/\s+/g, " ").trim();
      });
      await shootViewport(page, `tooltip-segment-${width}-${theme}.png`);

      if (width === 390) {
        const scroll = page.locator("[data-chain-topology-scroll]");
        await scroll.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
        await page.waitForTimeout(200);
        await shootCard(
          page,
          "[data-chain-topology-card]",
          `topology-${width}-${theme}-end.png`,
        );
      }

      await selectRange(page, "7d");
      await assertDetail(page, width, theme, "7d", {});
      await shootCard(
        page,
        "[data-chain-overall-card]",
        `overall-7d-${width}-${theme}.png`,
      );
    } finally {
      await normal.context.close();
    }

    // 故障节点：HOP 2 离线，绿点与红点同屏。
    const faulty = await newPage(browser, width, theme, {
      fillLastHop: true,
      faultIndex: 2,
    });
    try {
      const page = faulty.page;
      await openDetail(page);
      await assertDetail(page, width, theme, "24h", { faultIndex: 2 });
      if (width === 390) {
        await page
          .locator("[data-chain-topology-scroll]")
          .evaluate((element) => {
            element.scrollLeft = 170;
          });
        await page.waitForTimeout(200);
      }
      await shootCard(
        page,
        "[data-chain-topology-card]",
        `topology-fault-${width}-${theme}.png`,
      );
    } finally {
      await faulty.context.close();
    }
  }
}

// prefers-reduced-motion: 呼吸动画必须停下。
const reduced = await newPage(browser, 1440, "dark", {
  fillLastHop: true,
  reducedMotion: true,
});
try {
  const page = reduced.page;
  await openDetail(page);
  const dot = await page
    .locator('[data-chain-topology-node][data-status="online"]')
    .first()
    .locator("[data-chain-topology-node-dot]")
    .evaluate((element) => getComputedStyle(element).animationName);
  await check("reduced motion stops the breathing dot", () => {
    assert.equal(dot, "none");
    return dot;
  });
  await shootCard(
    page,
    "[data-chain-topology-card]",
    "topology-reduced-motion-1440-dark.png",
  );
} finally {
  await reduced.context.close();
}

await browser.close();

const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  chain: { id: CHAIN_ID, hops: CHAIN_HOPS },
  injections: {
    nodes: "契约 nodes / role / status（后端 lane 尚未进入本机二进制）",
    lastHop:
      "最后一跳 segment + 样本；P50 / series 由真实链级序列按比例派生，仅用于展示契约形状",
    untouched: "其余 series / loss / entry / exit / 链列表均来自真实接口",
  },
  viewports: VIEWPORTS,
  themes: THEMES,
  results,
  failures,
};
writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} checks passed`);
