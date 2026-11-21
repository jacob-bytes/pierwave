#!/usr/bin/env node
/**
 * `/status/:id` 四张卡的截图与断言。
 *
 * 健康 / 有中断 / 离线 / 无数据 / 未找到 / 请求失败 / 未开放
 * × 1440/390 × 亮/暗；另加英文、加载骨架、Xray 未运行、hover、列表入口、
 * error-last-success。核心断言：4 张卡、中断次数/覆盖度与 fixture 一致、
 * 无采样显示 — 而非 0、两行卡片 top/bottom 相等、页底 ≤24px、无横向溢出。
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detailFixture } from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4173";
const STATES = [
  "healthy",
  "incident",
  "offline",
  "nodata",
  "notfound",
  "error",
  "disabled",
];
const DETAIL_STATES = ["healthy", "incident", "offline", "nodata", "xray"];
const THEMES = ["dark", "light"];
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];
const TARGET_ID = "srv-hk";

mkdirSync(HERE, { recursive: true });

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
      /* 试下一个 */
    }
  }
  try {
    const mod = await import("playwright");
    if (mod.chromium) return mod.chromium;
  } catch {
    /* 落到下面的报错 */
  }
  throw new Error("找不到 playwright。设置 PLAYWRIGHT_MODULE 或安装 playwright。");
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

function jobs() {
  const list = [];
  for (const state of STATES) {
    for (const theme of THEMES) {
      for (const { width, height } of WIDTHS) {
        list.push({
          state,
          theme,
          width,
          height,
          locale: "zh-CN",
          out: path.join(HERE, `${state}-${theme}-${width}.png`),
          label: `${state} ${theme} ${width}`,
        });
      }
    }
  }
  list.push({
    state: "healthy",
    theme: "dark",
    width: 1440,
    height: 1000,
    locale: "en",
    out: path.join(HERE, "healthy-dark-1440-en.png"),
    label: "healthy dark 1440 en",
  });
  list.push({
    state: "loading",
    theme: "dark",
    width: 1440,
    height: 1000,
    locale: "zh-CN",
    out: path.join(HERE, "loading-dark-1440.png"),
    label: "loading dark 1440",
  });
  list.push({
    state: "xray",
    theme: "dark",
    width: 1440,
    height: 1000,
    locale: "zh-CN",
    out: path.join(HERE, "xray-off-dark-1440.png"),
    label: "xray off dark 1440",
  });
  return list;
}

function fixtureFor(state) {
  if (state === "incident") return detailFixture("incident");
  if (state === "offline") return detailFixture("offline");
  if (state === "nodata") return detailFixture("nodata");
  if (state === "xray") return detailFixture("xray");
  return detailFixture("healthy");
}

const chromium = await loadPlaywright();
const executablePath = chromePath();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const results = [];
const failures = [];

for (const job of jobs()) {
  const page = await browser.newPage({
    viewport: { width: job.width, height: job.height },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (error) =>
    failures.push(`${job.label}: ${error.message}`),
  );
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const expectedHttpFailure =
      (job.state === "error" || job.state === "disabled") &&
      /Failed to load resource/.test(message.text());
    if (!expectedHttpFailure) {
      failures.push(`${job.label}: console ${message.text()}`);
    }
  });

  await page.addInitScript(
    ({ theme, locale }) => {
      window.localStorage.setItem("pierwave.theme", theme);
      window.localStorage.setItem("pierwave.locale", locale);
    },
    { theme: job.theme, locale: job.locale },
  );

  await page.route("**/api/**", async (route) => {
    if (!route.request().url().includes("/api/v1/public/status")) {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    if (job.state === "disabled") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    if (job.state === "error") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: "{}",
      });
      return;
    }
    if (job.state === "loading") {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixtureFor(job.state)),
    });
  });

  const url =
    job.state === "notfound"
      ? `${BASE_URL}/status/missing`
      : `${BASE_URL}/status/${TARGET_ID}`;

  try {
    await page.goto(url, { waitUntil: "load" });

    if (job.state === "loading") {
      await page.waitForSelector('[aria-busy="true"]', { timeout: 5_000 });
      const loading = await page.evaluate(() => ({
        busy: Boolean(document.querySelector('[aria-busy="true"]')),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      assert.equal(loading.busy, true, "加载中要有详情骨架");
      assert.ok(loading.scrollWidth <= loading.clientWidth + 1);
      await page.screenshot({
        path: job.out,
        fullPage: true,
        animations: "disabled",
      });
      results.push({
        state: job.state,
        theme: job.theme,
        width: job.width,
        file: path.relative(HERE, job.out),
        loading,
        kb: Math.round(statSync(job.out).size / 1024),
      });
      console.log(`ok  ${path.basename(job.out).padEnd(32)} loading`);
      continue;
    }

    if (job.state === "error") {
      await page.getByText("暂时无法获取服务状态").waitFor({ timeout: 15_000 });
    } else if (job.state === "disabled") {
      await page.getByText("状态页未开放").waitFor({ timeout: 15_000 });
    } else if (job.state === "notfound") {
      await page.getByText("该节点不存在或已下线").waitFor({ timeout: 15_000 });
    } else {
      await page.waitForSelector('[data-slot="detail-overview"]', {
        timeout: 15_000,
      });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );

    const metrics = await page.evaluate(() => {
      const round = (value) => Math.round(value * 100) / 100;
      const rect = (selector) => {
        const element =
          typeof selector === "string"
            ? document.querySelector(selector)
            : selector;
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return {
          x: round(box.x),
          y: round(box.y),
          width: round(box.width),
          height: round(box.height),
          bottom: round(box.bottom),
        };
      };
      const text = (element) =>
        element?.innerText.replace(/\s+/g, " ").trim() ?? null;
      const main = document.querySelector("main");
      const overview = main.querySelector('[data-slot="detail-overview"]');
      const availability = main.querySelector('[data-slot="detail-availability"]');
      const runtime = main.querySelector('[data-slot="detail-runtime"]');
      const billing = main.querySelector('[data-slot="detail-billing"]');
      const chart = main.querySelector('[data-slot="detail-chart"]');
      const stats = {};
      for (const stat of main.querySelectorAll('[data-slot="detail-stat"]')) {
        stats[stat.dataset.stat] = {
          text: text(stat),
          ...rect(stat),
        };
      }
      const details = {};
      for (const item of main.querySelectorAll(
        '[data-slot="availability-detail"]',
      )) {
        details[item.dataset.detail] = text(item);
      }
      const steps = [
        ...main.querySelectorAll('[data-slot="availability-step"]'),
      ].map((element) => ({
        index: Number(element.dataset.index),
        ratio: Number(element.dataset.ratio),
        tone: element.dataset.tone,
        y1: Number(element.getAttribute("y1")),
      }));
      const missing = [
        ...main.querySelectorAll('[data-slot="availability-missing"]'),
      ].map((element) => Number(element.dataset.index));
      const areas = [
        ...main.querySelectorAll('[data-slot="availability-area"]'),
      ].map((element) => Number(element.dataset.index));
      const transitions = [
        ...main.querySelectorAll('[data-slot="availability-transition"]'),
      ].map((element) => ({
        from: Number(element.dataset.from),
        to: Number(element.dataset.to),
      }));
      const badge = main.querySelector(
        '[data-slot="detail-overview"] [data-slot="badge"]',
      );
      const innerBlank = (card, selector) => {
        if (!card) return null;
        const nodes = [...card.querySelectorAll(selector)].filter(
          (node) => node.getBoundingClientRect().height > 0,
        );
        const last = nodes[nodes.length - 1];
        if (!last) return null;
        const cardRect = card.getBoundingClientRect();
        const lastRect = last.getBoundingClientRect();
        const padding = Number.parseFloat(
          window.getComputedStyle(card).paddingBottom,
        );
        return round(Math.max(0, cardRect.bottom - lastRect.bottom - padding));
      };
      const rings = [...main.querySelectorAll('[data-slot="detail-runtime"] [role="img"]')];
      const back =
        main.querySelector('[data-slot="detail-back"]') ??
        main.querySelector('a[href="/status"]');
      const footer = main.querySelector('[data-slot="detail-footer"]');
      const traffic = main.querySelector('[data-slot="detail-traffic"]');
      const xray = main.querySelector('[data-slot="xray-status"]');
      const header = document.querySelector("header");
      const srCount = chart
        ? chart.querySelectorAll("ul.sr-only li").length
        : 0;
      const grid = main.querySelector('[data-slot="detail-grid"]');
      const order = [
        "detail-overview",
        "detail-availability",
        "detail-runtime",
        "detail-billing",
      ]
        .map((slot) => {
          const element = main.querySelector(`[data-slot="${slot}"]`);
          return element ? { slot, ...rect(element) } : null;
        })
        .filter(Boolean);

      return {
        text: text(main),
        headerText: text(header),
        h1: main.querySelector("h1")?.textContent?.trim() ?? null,
        badge: text(badge),
        stats,
        details,
        detailsText: text(availability),
        runtimeText: text(runtime),
        billingText: text(billing),
        chartText: text(chart),
        xray: text(xray),
        xrayState: xray?.dataset.xray ?? null,
        innerBlank: {
          overview: innerBlank(overview, '[data-slot="detail-chart"]'),
          availability: innerBlank(
            availability,
            '[data-slot="availability-detail"]',
          ),
          runtime: innerBlank(runtime, '[data-slot="xray-status"]'),
          billing: innerBlank(billing, '[data-slot="detail-traffic"]'),
        },
        chart: rect(chart),
        grid: rect(grid),
        overview: rect(overview),
        availability: rect(availability),
        runtime: rect(runtime),
        billing: rect(billing),
        traffic: rect(traffic),
        footer: rect(footer),
        trafficText: text(traffic),
        back: back ? { href: back.getAttribute("href"), ...rect(back) } : null,
        steps,
        missing,
        areas,
        transitions,
        srCount,
        ringCount: rings.length,
        order,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
      };
    });

    assert.ok(
      metrics.scrollWidth <= metrics.clientWidth + 1,
      `横向溢出 ${metrics.scrollWidth} > ${metrics.clientWidth}`,
    );

    const near = (a, b, label) => {
      assert.ok(
        typeof a === "number" &&
          typeof b === "number" &&
          Math.abs(a - b) <= 1,
        `${label}: ${a} vs ${b}`,
      );
    };

    if (DETAIL_STATES.includes(job.state)) {
      assert.equal(
        [metrics.overview, metrics.availability, metrics.runtime, metrics.billing]
          .filter(Boolean).length,
        4,
        "必须正好 4 张卡",
      );
      assert.equal(metrics.ringCount, 2, "内存 / 硬盘两个环");
      assert.equal(metrics.srCount, 24, "sr-only 逐小时文本 24 条");
      for (const [card, blank] of Object.entries(metrics.innerBlank)) {
        assert.ok(
          blank === null || blank <= 16,
          `${card} 内部空白应 ≤16px：${blank}`,
        );
      }
      assert.ok(
        metrics.trafficText?.includes("自开机以来") ||
          metrics.trafficText?.includes("Since boot"),
      );
      assert.ok((metrics.back?.height ?? 0) >= 40, "返回列表 ≥40px");
      assert.ok(
        metrics.headerText?.includes("更新于") ||
          metrics.headerText?.includes("Updated"),
        "顶栏保留「更新于」",
      );
      assert.ok(
        /在线|离线|异常|Online|Offline|Degraded/.test(metrics.badge ?? ""),
        "状态 pill",
      );
      assert.ok(metrics.footer?.height, "页脚存在");
      if (job.locale === "zh-CN") {
        assert.ok(metrics.stats.latency?.text.startsWith("延迟"), "延迟不写平均");
        assert.match(metrics.stats.rate?.text ?? "", /当前速率/);
      } else {
        assert.ok(metrics.stats.latency?.text.startsWith("Latency"));
        assert.match(metrics.stats.rate?.text ?? "", /Current rate/);
      }
    }

    if (job.state === "healthy") {
      assert.equal(metrics.steps.length, 24);
      assert.equal(metrics.missing.length, 0);
      assert.ok(metrics.steps.every((step) => step.ratio === 1));
      assert.ok(metrics.steps.every((step) => step.tone === "ok"));
      assert.match(metrics.details.coverage, /24\/24/);
      assert.match(metrics.details.compare, /100%/);
      assert.match(metrics.details.compare, /0\.0 pp/);
      assert.equal(metrics.xrayState, "running");
      assert.ok(metrics.trafficText?.includes("1.42 TB"));
      if (job.locale === "zh-CN") {
        assert.match(metrics.details.outages, /0 次/);
        assert.match(metrics.details.duration, /0 小时/);
        assert.ok(metrics.xray?.includes("Xray 运行中"));
        assert.ok(metrics.billingText?.includes("费用与到期"));
        if (job.width === 1440) {
          assert.match(metrics.details.longest, /24 小时/);
          assert.match(metrics.details.periods, /无中断/);
          assert.match(metrics.billingText ?? "", /27 \/ 30 天/);
          assert.match(metrics.billingText ?? "", /按月估算/);
          assert.match(metrics.billingText ?? "", /平均每小时/);
          assert.match(metrics.billingText ?? "", /3\.75 GB\/h/);
        }
        assert.match(metrics.text ?? "", /24\/24 采样/);
      } else {
        assert.match(metrics.details.outages, /0 outages/);
        assert.match(metrics.details.duration, /0 h/);
        assert.ok(metrics.xray?.includes("Xray running"));
        assert.ok(metrics.billingText?.includes("Billing and expiry"));
        assert.match(metrics.details.longest, /24 h/);
        assert.match(metrics.details.periods, /None/);
        assert.match(metrics.billingText ?? "", /27 \/ 30 days/);
        assert.match(metrics.billingText ?? "", /Estimated monthly/);
        assert.match(metrics.billingText ?? "", /Avg\/hour/);
        assert.match(metrics.billingText ?? "", /3\.75 GB\/h/);
        assert.match(metrics.text ?? "", /24\/24 sampled/);
      }
    }

    if (job.state === "incident") {
      assert.deepEqual(metrics.missing.sort((a, b) => a - b), [2, 3, 18]);
      for (const index of metrics.missing) {
        assert.ok(
          !metrics.steps.some((step) => step.index === index),
          `缺失小时 ${index} 不画 step`,
        );
        assert.ok(
          !metrics.areas.includes(index),
          `缺失小时 ${index} 不画 area`,
        );
      }
      assert.ok(
        metrics.transitions.every(
          (transition) =>
            !metrics.missing.includes(transition.from) &&
            !metrics.missing.includes(transition.to),
        ),
        "缺口两侧不连线",
      );
      const zeros = metrics.steps.filter((step) => step.ratio === 0);
      assert.deepEqual(
        zeros.map((step) => step.index).sort((a, b) => a - b),
        [8, 9, 15],
      );
      assert.ok(zeros.every((step) => step.y1 === 96), "0% 落在基线");
      assert.ok(metrics.steps.some((step) => step.ratio === 0.91 && step.tone === "down"));
      assert.match(metrics.text ?? "", /21\/24 采样/);

      // fixture: 8-9 一段 + 15 一段 = 2 次；3 个 0 桶 ×1h = 3h；21/24 覆盖
      assert.match(metrics.details.outages, /2 次/);
      assert.match(metrics.details.duration, /3 小时/);
      assert.match(metrics.details.duration, /按小时采样/);
      assert.match(metrics.details.coverage, /21\/24/);
      assert.match(metrics.details.lowest, /08:00–09:00/);
      assert.match(metrics.details.lowest, /0%/);
      assert.match(metrics.details.highest, /00:00–01:00/);
      assert.match(metrics.details.highest, /100%/);
      assert.match(metrics.details.compare, /86%/);
      assert.match(metrics.details.compare, /98\.7%/);
      assert.match(metrics.details.compare, /−12\.7 pp/);
      if (job.width === 1440) {
        assert.match(metrics.details.longest, /5 小时/);
        assert.match(metrics.details.periods, /08:00–10:00/);
        assert.match(metrics.details.periods, /15:00–16:00/);
      }
    }

    if (job.state === "offline") {
      assert.ok(metrics.badge?.includes("离线"));
      assert.match(metrics.stats.latency?.text ?? "", /18\s*ms/);
      assert.match(metrics.stats.uptime?.text ?? "", /86\s*%/);
      assert.match(metrics.details.outages, /2 次/);
    }

    if (job.state === "nodata") {
      assert.equal(metrics.steps.length, 0);
      assert.equal(metrics.missing.length, 24);
      assert.equal(metrics.areas.length, 0);
      assert.match(metrics.detailsText ?? "", /无采样/);
      assert.match(metrics.details.outages ?? "", /—/);
      assert.match(metrics.details.duration ?? "", /—/);
      assert.match(metrics.details.coverage ?? "", /—/);
      assert.match(metrics.details.compare ?? "", /—/);
      assert.doesNotMatch(metrics.detailsText ?? "", /0 次/);
      assert.match(metrics.stats.latency?.text ?? "", /—/);
      assert.match(metrics.trafficText ?? "", /—/);
      assert.doesNotMatch(metrics.billingText ?? "", /费用与到期/);
      assert.ok(metrics.billingText?.includes("累计流量"));
    }

    if (job.state === "xray") {
      assert.match(metrics.xray ?? "", /Xray 未运行/);
      assert.equal(metrics.xrayState, "not-running");
      assert.match(metrics.badge ?? "", /异常/);
      assert.equal(metrics.steps.length, 24);
    }

    if (job.state === "notfound") {
      assert.ok(metrics.text.includes("该节点不存在或已下线"));
      assert.equal(metrics.back?.href, "/status");
    }

    if (job.state === "error") {
      assert.ok(metrics.text.includes("暂时无法获取服务状态"));
      assert.ok(metrics.text.includes("重试"));
      assert.equal(metrics.back?.href, "/status");
    }

    if (job.state === "disabled") {
      assert.ok(metrics.text.includes("状态页未开放"));
    }

    let footerGap = null;
    let bottomGap = null;

    if (job.width === 1440) {
      assert.ok(metrics.scrollHeight <= 1100, `页面高 ${metrics.scrollHeight}`);
    } else {
      assert.ok(metrics.scrollHeight <= 1500, `页面高 ${metrics.scrollHeight}`);
    }

    if (DETAIL_STATES.includes(job.state)) {
      if (job.width === 1440) {
        assert.equal(metrics.grid?.width, 1352, "1440 内容宽 1352");
        assert.equal(metrics.overview?.width, 420, "左栏 420");
        assert.equal(metrics.runtime?.width, 420, "左栏 420");
        assert.equal(metrics.availability?.width, 916, "右栏 916");
        assert.equal(metrics.billing?.width, 916, "右栏 916");
        near(metrics.overview?.y, metrics.availability?.y, "第一行顶边");
        near(
          metrics.overview?.bottom,
          metrics.availability?.bottom,
          "第一行底边",
        );
        near(metrics.runtime?.y, metrics.billing?.y, "第二行顶边");
        near(metrics.runtime?.bottom, metrics.billing?.bottom, "第二行底边");
      } else {
        const order = metrics.order;
        assert.ok(order.length === 4);
        for (let index = 1; index < order.length; index += 1) {
          assert.ok(
            order[index].y > order[index - 1].y,
            `390 顺序 ${order[index - 1].slot} → ${order[index].slot}`,
          );
        }
        for (const entry of order) {
          assert.ok(
            Math.abs((entry.width ?? 0) - (order[0].width ?? 0)) <= 1,
            `390 单列宽不一致：${entry.slot}`,
          );
        }
      }
      footerGap =
        metrics.footer && metrics.grid
          ? metrics.footer.y - metrics.grid.bottom
          : null;
      assert.ok(
        footerGap !== null && Math.abs(footerGap - 16) <= 1,
        `页脚与卡片区间距应 16px：${footerGap}`,
      );
      bottomGap =
        metrics.footer && typeof metrics.scrollHeight === "number"
          ? metrics.scrollHeight - metrics.footer.bottom
          : null;
      assert.ok(
        bottomGap !== null && bottomGap <= 24,
        `页底空白应 ≤24px：${bottomGap}`,
      );
    }

    await page.screenshot({
      path: job.out,
      fullPage: true,
      animations: "disabled",
    });

    results.push({
      state: job.state,
      theme: job.theme,
      width: job.width,
      locale: job.locale,
      file: path.relative(HERE, job.out),
      h1: metrics.h1,
      badge: metrics.badge,
      details: metrics.details,
      innerBlank: metrics.innerBlank,
      xray: metrics.xray,
      overview: metrics.overview,
      availability: metrics.availability,
      runtime: metrics.runtime,
      billing: metrics.billing,
      footer: metrics.footer,
      chart: metrics.chart,
      steps: metrics.steps.length,
      missing: metrics.missing,
      zeros: metrics.steps.filter((step) => step.ratio === 0).length,
      footerGap,
      bottomGap,
      scrollHeight: metrics.scrollHeight,
      scrollWidth: metrics.scrollWidth,
      kb: Math.round(statSync(job.out).size / 1024),
    });
    console.log(
      `ok  ${path.basename(job.out).padEnd(32)} ${metrics.h1 ?? "state"}  ` +
        `cards=4 steps=${metrics.steps.length} missing=${metrics.missing.length} ` +
        `h=${metrics.scrollHeight} bottom=${bottomGap}`,
    );
  } catch (error) {
    failures.push(`${job.label}: ${error.message}`);
    console.error(`FAIL ${job.label}: ${error.message}`);
  } finally {
    await page.close();
  }
}

// ---- 曲线 hover / 键盘 / 列表交互 -------------------------------------------
const interactions = {};
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    localStorage.setItem("pierwave.theme", "dark");
    localStorage.setItem("pierwave.locale", "zh-CN");
  });
  let failNext = false;
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/v1/public/status")) {
      if (failNext) {
        await route.fulfill({ status: 500, body: "{}" });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detailFixture("incident")),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "{}" });
  });
  try {
    await page.goto(`${BASE_URL}/status/${TARGET_ID}`, { waitUntil: "load" });
    await page.waitForSelector('[data-slot="detail-overview"]', { timeout: 15_000 });

    const plot = page.locator('[data-slot="availability-plot"]');
    const box = await plot.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width * ((8 + 0.5) / 24), box.y + box.height * 0.7);
    const tooltip = page.locator('[data-slot="availability-tooltip"]');
    await tooltip.waitFor({ timeout: 5_000 });
    const zeroTooltip = (await tooltip.innerText()).replace(/\s+/g, " ").trim();
    assert.match(zeroTooltip, /0%/);
    assert.match(zeroTooltip, /中断/);

    await page.mouse.move(box.x + box.width * ((2 + 0.5) / 24), box.y + box.height * 0.5);
    await page.waitForTimeout(30);
    const missingTooltip = (await tooltip.innerText()).replace(/\s+/g, " ").trim();
    assert.match(missingTooltip, /无采样/);

    await page.screenshot({
      path: path.join(HERE, "incident-hover-dark-1440.png"),
      fullPage: true,
      animations: "disabled",
    });

    await page.locator('[data-slot="availability-plot"]').focus();
    await page.waitForTimeout(50);
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(30);
    const keyboardTooltip = (await tooltip.innerText()).replace(/\s+/g, " ").trim();
    assert.ok(keyboardTooltip.length > 0);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(30);
    assert.equal(await tooltip.count(), 0);

    interactions.chart = {
      zeroTooltip,
      missingTooltip,
      keyboardTooltip,
      srCount: await page.locator('[data-slot="detail-chart"] ul.sr-only li').count(),
    };

    // 列表入口 / 返回 / 键盘 Enter / 深链。
    await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
    await page.waitForFunction(
      () => document.querySelectorAll("main h3").length === 8,
      undefined,
      { timeout: 15_000 },
    );
    const cardLink = page.locator(`a[href="/status/${TARGET_ID}"]`).first();
    assert.equal(await cardLink.count(), 1);
    await cardLink.click();
    await page.waitForURL(`**/status/${TARGET_ID}`, { timeout: 10_000 });
    await page.waitForSelector('[data-slot="detail-overview"]');
    interactions.fromList = { url: page.url() };
    await page.locator('[data-slot="detail-back"]').click();
    await page.waitForURL("**/status", { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelectorAll("main h3").length === 8,
      undefined,
      { timeout: 15_000 },
    );
    interactions.backToList = { url: page.url(), cards: await page.locator("main h3").count() };
    await cardLink.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(`**/status/${TARGET_ID}`, { timeout: 10_000 });
    interactions.keyboard = { url: page.url() };
    await page.goto(`${BASE_URL}/status/${TARGET_ID}`, { waitUntil: "load" });
    await page.waitForSelector('[data-slot="detail-overview"]', { timeout: 15_000 });
    interactions.deepLink = { url: page.url() };

    await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
    await page.waitForFunction(
      () => document.querySelectorAll("main h3").length === 8,
      undefined,
      { timeout: 15_000 },
    );
    await page.screenshot({
      path: path.join(HERE, "list-entry-dark-1440.png"),
      fullPage: true,
      animations: "disabled",
    });
    interactions.listScreenshot = "list-entry-dark-1440.png";

    // 先成功、再失败：错误面板要带「上次成功」。
    await page.goto(`${BASE_URL}/status/${TARGET_ID}`, { waitUntil: "load" });
    await page.waitForSelector('[data-slot="detail-overview"]', { timeout: 15_000 });
    failNext = true;
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.getByText("暂时无法获取服务状态").waitFor({ timeout: 10_000 });
    const lastSuccessText = await page.getByText(/上次成功/).innerText();
    assert.match(lastSuccessText, /上次成功/);
    await page.screenshot({
      path: path.join(HERE, "error-last-success-dark-1440.png"),
      fullPage: true,
      animations: "disabled",
    });
    interactions.errorLastSuccess = {
      text: lastSuccessText,
      file: "error-last-success-dark-1440.png",
    };
  } catch (error) {
    failures.push(`interactions: ${error.message}`);
    console.error(`FAIL interactions: ${error.message}`);
  } finally {
    await page.close();
  }

  // 触摸点按：单独用 hasTouch 上下文，验证 tooltip 不会被 focus 覆盖成最后一小时。
  const touchPage = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  await touchPage.addInitScript(() => {
    localStorage.setItem("pierwave.theme", "dark");
    localStorage.setItem("pierwave.locale", "zh-CN");
  });
  await touchPage.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/v1/public/status")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detailFixture("incident")),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "{}" });
  });
  try {
    await touchPage.goto(`${BASE_URL}/status/${TARGET_ID}`, { waitUntil: "load" });
    await touchPage.waitForSelector('[data-slot="detail-overview"]', { timeout: 15_000 });
    const touchPlot = touchPage.locator('[data-slot="availability-plot"]');
    const touchBox = await touchPlot.boundingBox();
    assert.ok(touchBox);
    await touchPage.touchscreen.tap(
      touchBox.x + touchBox.width * ((8 + 0.5) / 24),
      touchBox.y + touchBox.height * 0.7,
    );
    const touchTooltip = await touchPage
      .locator('[data-slot="availability-tooltip"]')
      .innerText();
    assert.match(touchTooltip, /0%/);
    assert.match(touchTooltip, /中断/);
    interactions.touch = {
      tooltip: touchTooltip.replace(/\s+/g, " ").trim(),
      viewport: 390,
    };
  } catch (error) {
    failures.push(`touch: ${error.message}`);
    console.error(`FAIL touch: ${error.message}`);
  } finally {
    await touchPage.close();
  }
}

await browser.close();

writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify({ baseUrl: BASE_URL, results, interactions, failures }, null, 2)}\n`,
);

console.log(
  `\n${results.length + 3} 张截图 → ${path.relative(process.cwd(), HERE) || "."}`,
);
if (failures.length > 0) {
  console.error(`\n${failures.length} 个任务失败：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
