#!/usr/bin/env node
/**
 * 方案 1 实现后的真实页面几何验收。
 *
 * 对 `vite preview` 的 `/status/:id` 注入带 5 个新字段的公开状态 fixture，
 * 在 1440/390 × 亮/暗 × healthy/incident/offline/nodata/未找到/请求失败
 * 下测量页面高度、卡片对齐、卡内最大间隙、390 的信息可见性与横向溢出。
 *
 * 只读产品代码；本脚本只写本目录的 PNG 与 JSON。
 *
 *   node web/screenshots/detail-polish/verify-p1.mjs
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detailFixture } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4173";
const LOCALE = process.env.LOCALE ?? "zh-CN";
const NOW = Math.floor(Date.now() / 1_000);
const HOUR = 3_600;
const DAY = 86_400;
const TARGET_ID = "srv-hk";

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
      /* next */
    }
  }
  try {
    const mod = await import("playwright");
    if (mod.chromium) return mod.chromium;
  } catch {
    /* fall through */
  }
  throw new Error("找不到 playwright / playwright not found");
}

function chromePath() {
  return [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]
    .filter(Boolean)
    .find((candidate) => existsSync(candidate));
}

function dayKey(offset) {
  const date = new Date((NOW + 8 * HOUR + offset * DAY) * 1_000);
  return date.toISOString().slice(0, 10);
}

function series24h(shape) {
  const MB = 1024 * 1024;
  const t = Array.from({ length: 24 }, (_, index) => NOW - (23 - index) * HOUR);
  const rx = Array.from({ length: 24 }, (_, index) =>
    index % 7 === 3 ? null : (14 + ((index * 3) % 9) + 0.5) * MB,
  );
  const tx = Array.from({ length: 24 }, (_, index) =>
    index % 9 === 4 ? null : (1.4 + ((index * 2) % 5) * 0.37) * MB,
  );
  const latency = Array.from({ length: 24 }, (_, index) =>
    index % 8 === 5 ? null : 12 + ((index * 5) % 13),
  );
  if (shape === "flat") {
    return {
      window_secs: 86_400,
      step_secs: HOUR,
      t,
      rate_rx_bps: rx,
      rate_tx_bps: tx,
      latency_ms: latency,
    };
  }
  if (shape === "incident") {
    for (const index of [8, 9, 15]) {
      rx[index] = 0;
      tx[index] = 0;
      latency[index] = null;
    }
    latency[14] = 46;
  }
  return {
    window_secs: 86_400,
    step_secs: HOUR,
    t,
    rate_rx_bps: rx,
    rate_tx_bps: tx,
    latency_ms: latency,
  };
}

function week(shape) {
  return Array.from({ length: 7 }, (_, index) => {
    if (shape === "nodata") return null;
    if (shape === "incident" && index === 4) return null;
    if (shape === "incident" && index === 5) {
      return { day: dayKey(index - 7), online_ratio: 0.9123, samples: 288 };
    }
    return {
      day: dayKey(index - 7),
      online_ratio: index === 6 ? 0.9973 : 1,
      samples: 288,
    };
  });
}

function withNewFields(fixture, { state, includeNew = true }) {
  const data = structuredClone(fixture);
  const target = data.servers.find((server) => server.id === TARGET_ID);
  if (!target || !includeNew) return data;

  if (state === "nodata") {
    target.outage_minutes_24h = null;
    target.first_seen_at = null;
    target.inbound_count = null;
    target.buckets_7d = week("nodata");
    target.series_24h = {
      window_secs: 86_400,
      step_secs: HOUR,
      t: Array.from({ length: 24 }, (_, index) => NOW - (23 - index) * HOUR),
      rate_rx_bps: Array.from({ length: 24 }, () => null),
      rate_tx_bps: Array.from({ length: 24 }, () => null),
      latency_ms: Array.from({ length: 24 }, () => null),
    };
    return data;
  }

  if (state === "incident") {
    target.outage_minutes_24h = 192;
    target.buckets_7d = week("incident");
    target.series_24h = series24h("incident");
  } else {
    target.outage_minutes_24h = 0;
    target.buckets_7d = week("flat");
    target.series_24h = series24h("flat");
  }
  target.first_seen_at = NOW - 45 * DAY;
  target.inbound_count = 3;
  return data;
}

function withoutNewFields(fixture) {
  return withNewFields(fixture, { state: "healthy", includeNew: false });
}

const STATES = [
  { id: "healthy", fixture: () => withNewFields(detailFixture("healthy"), { state: "healthy" }) },
  { id: "incident", fixture: () => withNewFields(detailFixture("incident"), { state: "incident" }) },
  { id: "offline", fixture: () => withNewFields(detailFixture("offline"), { state: "offline" }) },
  { id: "nodata", fixture: () => withNewFields(detailFixture("nodata"), { state: "nodata" }) },
  { id: "old-backend", fixture: () => withoutNewFields(detailFixture("healthy")) },
  { id: "notfound", fixture: () => withNewFields(detailFixture("healthy"), { state: "healthy" }), path: "/status/srv-missing" },
  { id: "error", status: 500, body: { error: "internal error" } },
  { id: "disabled", status: 404, body: { error: "not found" } },
];

const VIEWPORTS = [
  { width: 1440, height: 769, label: "1440" },
  { width: 390, height: 844, label: "390" },
];
const THEMES = ["dark", "light"];

const chromium = await loadPlaywright();
const executablePath = chromePath();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const report = [];

for (const state of STATES) {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      const label = `${state.id}-${theme}-${viewport.label}${
        LOCALE === "en" ? "-en" : ""
      }`;
      const page = await browser.newPage({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(
        ({ theme, locale }) => {
          window.localStorage.setItem("pierwave.theme", theme);
          window.localStorage.setItem("pierwave.locale", locale);
        },
        { theme, locale: LOCALE },
      );
      await page.route("**/api/**", async (route) => {
        if (!route.request().url().includes("/api/v1/public/status")) {
          await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
          return;
        }
        if (state.status) {
          await route.fulfill({
            status: state.status,
            contentType: "application/json",
            body: JSON.stringify(state.body),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(state.fixture()),
        });
      });
      await page.goto(`${BASE_URL}${state.path ?? `/status/${TARGET_ID}`}`, {
        waitUntil: "load",
      });
      await page.waitForSelector("main", { timeout: 15_000 });
      const copy =
        LOCALE === "en"
          ? {
              notfound: "This node does not exist or is offline",
              error: "Service status is temporarily unavailable",
              disabled: "This status page is not public",
            }
          : {
              notfound: "该节点不存在或已下线",
              error: "暂时无法获取服务状态",
              disabled: "状态页未开放",
            };
      const readySelector =
        state.id === "notfound"
          ? `text=${copy.notfound}`
          : state.id === "error"
            ? `text=${copy.error}`
            : state.id === "disabled"
              ? `text=${copy.disabled}`
              : '[data-slot="detail-billing"]';
      await page.waitForSelector(readySelector, { timeout: 15_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await page.waitForTimeout(250);

      const metrics = await page.evaluate(() => {
        const round = (value) => Math.round(value * 100) / 100;
        const rect = (element) => {
          if (!element) return null;
          const box = element.getBoundingClientRect();
          if (box.width === 0 && box.height === 0) return null;
          return {
            x: round(box.x),
            y: round(box.y),
            width: round(box.width),
            height: round(box.height),
            right: round(box.right),
            bottom: round(box.bottom),
          };
        };
        const visible = (element) => {
          if (!element) return false;
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            box.width > 0 &&
            box.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity) > 0
          );
        };
        const plainText = (element) =>
          element?.innerText.replace(/\s+/g, " ").trim() ?? null;

        const cardSlots = {
          overview: "detail-overview",
          availability: "detail-availability",
          runtime: "detail-runtime",
          billing: "detail-billing",
        };
        const cards = {};
        for (const [key, slot] of Object.entries(cardSlots)) {
          const card = document.querySelector(`[data-slot="${slot}"]`);
          if (!card) {
            cards[key] = null;
            continue;
          }
          const cardRect = rect(card);
          const paddingTop = parseFloat(getComputedStyle(card).paddingTop);
          const paddingBottom = parseFloat(getComputedStyle(card).paddingBottom);
          const children = [...card.children]
            .filter((child) => {
              const style = getComputedStyle(child);
              return (
                style.display !== "none" &&
                style.position !== "absolute" &&
                child.getBoundingClientRect().height > 0
              );
            })
            .map((child) => ({
              slot: child.getAttribute("data-slot"),
              ...rect(child),
            }))
            .sort((a, b) => a.y - b.y);
          let maxGap = 0;
          for (let index = 1; index < children.length; index += 1) {
            maxGap = Math.max(maxGap, children[index].y - children[index - 1].bottom);
          }
          const contentBottom =
            children.length === 0 ? cardRect.y + paddingTop : children.at(-1).bottom;
          cards[key] = {
            ...cardRect,
            paddingTop: round(paddingTop),
            paddingBottom: round(paddingBottom),
            children,
            maxChildGap: round(maxGap),
            // 卡片 stretch 后内容下方的剩余空间；方案 1 要求 ≤16。
            trailingBlank: round(cardRect.bottom - paddingBottom - contentBottom),
          };
        }

        const metricGrid = document.querySelector('[data-slot="detail-metric-grid"]');
        const metrics = [...document.querySelectorAll('[data-slot="detail-metric"]')];
        const foot = document.querySelector('[data-slot="detail-availability-foot"]');
        const days = document.querySelector('[data-slot="detail-days"]');
        const billingMeta = document.querySelector('[data-slot="billing-meta"]');
        const trafficAverage = document.querySelector('[data-slot="traffic-average"]');
        const rateTrend = document.querySelector('[data-slot="detail-rate-trend"]');
        const chart = document.querySelector('[data-slot="detail-chart"]');
        const plot = document.querySelector('[data-slot="availability-plot"]');
        const footer = document.querySelector('[data-slot="detail-footer"]');
        const yTicks = [
          ...document.querySelectorAll('[data-slot="availability-yaxis"] [data-tick]'),
        ].map((element) => element.textContent.trim());

        return {
          pageHeight: document.documentElement.scrollHeight,
          pageWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          horizontalOverflow:
            document.documentElement.scrollWidth > window.innerWidth,
          cards,
          metricGrid: rect(metricGrid),
          metrics: metrics.map((element) => ({
            name: element.getAttribute("data-metric"),
            visible: visible(element),
            text: plainText(element),
            ...rect(element),
          })),
          foot: {
            visible: visible(foot),
            text: plainText(foot),
            ...rect(foot),
          },
          days: {
            visible: visible(days),
            text: plainText(days),
            ...rect(days),
          },
          billingMeta: {
            visible: visible(billingMeta),
            text: plainText(billingMeta),
            ...rect(billingMeta),
          },
          trafficAverage: {
            visible: visible(trafficAverage),
            text: plainText(trafficAverage),
            ...rect(trafficAverage),
          },
          rateTrend: {
            visible: visible(rateTrend),
            ...rect(rateTrend),
          },
          chart: rect(chart),
          plot: rect(plot),
          yTicks,
          footer: rect(footer),
          pageBottomGap: footer
            ? round(
                document.documentElement.scrollHeight -
                  footer.getBoundingClientRect().bottom,
              )
            : null,
          heading: plainText(document.querySelector("h1")),
          mainText: plainText(document.querySelector("main"))?.slice(0, 300),
        };
      });

      const file = path.join(HERE, `p1-real-${label}.png`);
      await page.screenshot({ path: file, fullPage: true });
      report.push({
        label,
        locale: LOCALE,
        theme,
        state: state.id,
        viewport,
        errors,
        ...metrics,
      });
      console.log(
        `${label} page=${metrics.pageHeight} overflow=${metrics.horizontalOverflow} ` +
          `plot=${metrics.plot?.height} ` +
          `row1=${metrics.cards.overview?.height}/${metrics.cards.availability?.height} ` +
          `row2=${metrics.cards.runtime?.height}/${metrics.cards.billing?.height}`,
      );
      await page.close();
    }
  }
}

await browser.close();
const reportFile =
  LOCALE === "en" ? "p1-real-report-en.json" : "p1-real-report.json";
writeFileSync(path.join(HERE, reportFile), JSON.stringify(report, null, 2));
console.log(`wrote ${report.length} rows to ${reportFile}`);

/* ---------- assertions ---------- */
const failures = [];
const readyStates = new Set(["healthy", "incident", "offline", "nodata", "old-backend"]);
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

for (const row of report) {
  if (!readyStates.has(row.state)) continue;
  const width = row.viewport.width;
  const contentHeight = row.footer ? row.footer.bottom + 16 : row.pageHeight;
  if (width === 1440) {
    check(
      contentHeight >= 740 && contentHeight <= 820,
      `${row.label}: content height ${contentHeight} not near 769 (740–820)`,
    );
    check(row.plot?.height === 112, `${row.label}: plot height ${row.plot?.height} != 112`);
    check(
      row.yTicks.join(",") === "100%,50%,0%",
      `${row.label}: y ticks ${row.yTicks.join(",")}`,
    );
  } else {
    check(row.pageHeight <= 1500, `${row.label}: page height ${row.pageHeight} > 1500`);
    check(row.plot?.height === 112, `${row.label}: mobile plot ${row.plot?.height} != 112`);
    check(
      row.metrics.length === 6 && row.metrics.every((metric) => metric.visible),
      `${row.label}: availability metrics not all visible`,
    );
    check(row.foot?.visible, `${row.label}: availability foot hidden`);
    if (row.state !== "old-backend") {
      check(row.days?.visible, `${row.label}: 7d strip hidden`);
    }
    if (row.state !== "nodata") {
      check(row.billingMeta?.visible, `${row.label}: billing meta hidden`);
    }
    if (row.state === "healthy" || row.state === "incident" || row.state === "old-backend") {
      check(row.trafficAverage?.visible, `${row.label}: avg traffic hidden`);
    }
    if (row.state !== "nodata" && row.state !== "old-backend") {
      check(row.rateTrend?.visible, `${row.label}: rate trend hidden`);
    }
  }
  check(!row.horizontalOverflow, `${row.label}: horizontal overflow`);

  if (width === 1440) {
    const row1 = [row.cards.overview, row.cards.availability];
    const row2 = [row.cards.runtime, row.cards.billing];
    for (const pair of [row1, row2]) {
      if (!pair[0] || !pair[1]) continue;
      check(
        Math.abs(pair[0].y - pair[1].y) < 0.5 &&
          Math.abs(pair[0].bottom - pair[1].bottom) < 0.5,
        `${row.label}: sibling cards not aligned ${pair[0].y}/${pair[0].bottom} vs ${pair[1].y}/${pair[1].bottom}`,
      );
    }
  }
  for (const [key, card] of Object.entries(row.cards)) {
    if (!card) continue;
    check(card.maxChildGap <= 16, `${row.label}: ${key} internal gap ${card.maxChildGap} > 16`);
    check(
      card.trailingBlank <= 16,
      `${row.label}: ${key} trailing blank ${card.trailingBlank} > 16`,
    );
  }
  check(row.pageBottomGap <= 24, `${row.label}: page bottom ${row.pageBottomGap} > 24`);

  const duration = row.metrics.find((metric) => metric.name === "duration")?.text ?? "";
  const zh = row.locale !== "en";
  if (row.state === "incident") {
    check(
      zh
        ? duration.includes("3 小时 12 分钟")
        : duration.includes("3 h 12 min"),
      `${row.label}: duration "${duration}"`,
    );
  }
  if (row.state === "nodata") {
    check(
      zh
        ? duration.includes("累计中断 —") && !duration.includes("0 分钟")
        : duration.includes("Total outage —") && !duration.includes("0 min"),
      `${row.label}: null outage rendered as "${duration}"`,
    );
  }
  if (row.state === "old-backend") {
    check(
      zh
        ? duration.includes("0 小时") && duration.includes("按小时采样")
        : duration.includes("0 h") && duration.includes("Hourly samples"),
      `${row.label}: old-backend fallback "${duration}"`,
    );
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`\nall P1 assertions passed (${report.length} rows)`);
}
