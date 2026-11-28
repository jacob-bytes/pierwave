#!/usr/bin/env node
/**
 * 公开状态页：详情页顶部「最后上报 / 刷新节奏」+ 列表「环境」列与整行跳转的验收。
 *
 * Detail header meta + list environment column & row-link acceptance.
 *
 * 覆盖 / Covers:
 * - 详情页 1440 / 390 × 亮暗：返回列表与「最后上报 · 数据每 20 秒刷新」同一行右对齐；
 *   390 放不下时换行仍右对齐，返回按钮宽度不被压缩；页面底部不再有重复行。
 * - 列表 1440 亮暗：环境列（发行版 / `虚拟化 · 架构`）、缺字段 `—`、
 *   数值列左对齐 + tabular-nums、行 hover 背景、整行点击与键盘 Enter 跳详情。
 * - 390 卡片：环境信息仍在卡片副行，无横向溢出。
 *
 * 数据由 Playwright 拦截 `/api/v1/public/status` 提供，不启动后端、不写库。
 *
 * 用法 / Usage:
 *   cd web && npm run build && npx vite preview --port 4173
 *   node web/screenshots/status-header-env/shots.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detailFixture } from "../status-detail/fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4173";
const TARGET_ID = "srv-hk";

mkdirSync(HERE, { recursive: true });

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) {
    candidates.push(process.env.PLAYWRIGHT_MODULE);
  }
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

/**
 * 列表 fixture：在 healthy 的 8 台机器上显式覆盖环境字段，覆盖四种情况：
 * 完整 / 缺发行版 / 裸机（virt = none）/ 全缺 / 只有架构。
 */
function listFixture() {
  const base = detailFixture("healthy");
  const overrides = [
    {},
    { os_name: null, os_version: null },
    { virt: "none", arch: "aarch64" },
    { os_name: null, os_version: null, virt: null, arch: "" },
    { os_name: "Ubuntu", os_version: "24.04", virt: null, arch: "arm64" },
  ];
  return {
    ...base,
    servers: base.servers.map((server, index) => ({
      ...server,
      ...(overrides[index] ?? {}),
    })),
  };
}

const EXPECTED_ENV = [
  { os: "Debian GNU/Linux 12", platform: "kvm · x86_64" },
  { os: "—", platform: "kvm · x86_64" },
  { os: "Debian GNU/Linux 12", platform: "aarch64" },
  { os: "—", platform: "—" },
  { os: "Ubuntu 24.04", platform: "arm64" },
];

const FIXTURE = listFixture();
const chromium = await loadPlaywright();
const executablePath = chromePath();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const report = {};
const failures = [];

/** 每个页面都拦截公开接口，并记录实际发出的请求（用于 N+1 断言）。 */
async function newPage({ width, height, theme, locale = "zh-CN", view = "grid" }) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  const requests = [];
  page.on("pageerror", (error) =>
    failures.push(`pageerror ${width}/${theme}: ${error.message}`),
  );
  page.on("console", (message) => {
    if (message.type() === "error") {
      failures.push(`console ${width}/${theme}: ${message.text()}`);
    }
  });
  await page.addInitScript(
    ({ theme, locale, view }) => {
      window.localStorage.setItem("pierwave.theme", theme);
      window.localStorage.setItem("pierwave.locale", locale);
      window.localStorage.setItem("pierwave.status.view", view);
    },
    { theme, locale, view },
  );
  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/v1/public/status")) {
      requests.push(url);
      const isDetail = /\/api\/v1\/public\/status\/[^/?]+/.test(url);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        // 详情接口要 { server, series_24h }；这里故意只回列表形状，
        // 页面按既有回落逻辑用列表数据渲染（与旧后端一致）。
        body: JSON.stringify(isDetail ? { server: FIXTURE.servers[0] } : FIXTURE),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  return { page, requests };
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

const rectOf = (element) => {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  const round = (value) => Math.round(value * 100) / 100;
  return {
    x: round(box.x),
    y: round(box.y),
    right: round(box.right),
    bottom: round(box.bottom),
    width: round(box.width),
    height: round(box.height),
  };
};

/** ---- 1. 详情页顶部 ---------------------------------------------------------- */
const detailMetrics = {};

for (const theme of ["dark", "light"]) {
  for (const { width, height } of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
  ]) {
    const { page, requests } = await newPage({ width, height, theme });
    try {
      await page.goto(`${BASE_URL}/status/${TARGET_ID}`, { waitUntil: "load" });
      await page.waitForSelector('[data-slot="detail-overview"]', { timeout: 15_000 });
      await settle(page);

      const metrics = await page.evaluate(() => {
        const main = document.querySelector("main");
        const top = main.querySelector('[data-slot="detail-top"]');
        const back = main.querySelector('[data-slot="detail-back"]');
        const meta = main.querySelector('[data-slot="detail-meta"]');
        const grid = main.querySelector('[data-slot="detail-grid"]');
        const footer = main.querySelector('[data-slot="detail-footer"]');
        const metaText = meta?.innerText.replace(/\s+/g, " ").trim() ?? "";
        return {
          top: top ? top.getBoundingClientRect().toJSON() : null,
          back: back ? back.getBoundingClientRect().toJSON() : null,
          meta: meta ? meta.getBoundingClientRect().toJSON() : null,
          grid: grid ? grid.getBoundingClientRect().toJSON() : null,
          footer: footer ? footer.getBoundingClientRect().toJSON() : null,
          metaText,
          mainText: main.innerText.replace(/\s+/g, " ").trim(),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        };
      });

      const key = `${theme}-${width}`;
      detailMetrics[key] = {
        top: metrics.top,
        back: metrics.back,
        meta: metrics.meta,
        metaText: metrics.metaText,
        footer: metrics.footer,
        scrollWidth: metrics.scrollWidth,
        clientWidth: metrics.clientWidth,
        requests: requests.length,
      };

      assert.ok(metrics.top, "顶部行存在");
      assert.ok(metrics.back, "返回列表存在");
      assert.ok(metrics.meta, "顶部右对齐区存在");
      assert.equal(metrics.footer, null, "底部的最后上报行必须删除");
      assert.match(metrics.metaText, /最后上报/);
      assert.match(metrics.metaText, /数据每 20 秒刷新/, "刷新节奏说明不能删");
      assert.match(metrics.metaText, /刚刚|分钟|小时|天/, "显示相对时间");
      assert.ok(
        Math.abs(metrics.meta.right - metrics.top.right) <= 2,
        `顶部右对齐：meta.right=${metrics.meta.right} top.right=${metrics.top.right}`,
      );
      assert.ok(
        metrics.meta.bottom <= metrics.grid.top,
        "最后上报在卡片网格上方",
      );
      assert.ok(
        metrics.scrollWidth <= metrics.clientWidth + 1,
        `无横向溢出：${metrics.scrollWidth} > ${metrics.clientWidth}`,
      );

      if (width === 1440) {
        // 1440 必须与返回按钮同一行：垂直中心差 ≤2px。
        assert.ok(
          Math.abs(metrics.back.y + metrics.back.height / 2 -
            (metrics.meta.y + metrics.meta.height / 2)) <= 2,
          "1440 与返回列表同一行",
        );
      } else {
        // 390 可以换行，但必须整体在返回按钮右侧或下一行，不能重叠。
        const backCenter = metrics.back.y + metrics.back.height / 2;
        const metaCenter = metrics.meta.y + metrics.meta.height / 2;
        const sameRow = Math.abs(backCenter - metaCenter) <= 2;
        const nextRow = metrics.meta.y >= metrics.back.bottom - 1;
        assert.ok(sameRow || nextRow, "390 不挤压返回按钮");
        if (sameRow) {
          assert.ok(
            metrics.meta.x >= metrics.back.right - 1,
            "390 同行时右侧信息在返回按钮右边",
          );
        }
      }

      await page.screenshot({
        path: path.join(HERE, `detail-${theme}-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
      console.log(
        `ok  detail ${key.padEnd(16)} meta="${metrics.metaText}" ` +
          `meta.right=${Math.round(metrics.meta.right)} top.right=${Math.round(metrics.top.right)}`,
      );
    } catch (error) {
      failures.push(`detail ${width}/${theme}: ${error.message}`);
      console.error(`FAIL detail ${width}/${theme}: ${error.message}`);
    } finally {
      await page.close();
    }
  }
}

/** ---- 1b. 390 英文：太长时换行且仍右对齐 ------------------------------------- */
{
  const { page } = await newPage({
    width: 390,
    height: 844,
    theme: "dark",
    locale: "en",
  });
  try {
    await page.goto(`${BASE_URL}/status/${TARGET_ID}`, { waitUntil: "load" });
    await page.waitForSelector('[data-slot="detail-overview"]', { timeout: 15_000 });
    await settle(page);
    const metrics = await page.evaluate(() => {
      const main = document.querySelector("main");
      const top = main.querySelector('[data-slot="detail-top"]');
      const back = main.querySelector('[data-slot="detail-back"]');
      const meta = main.querySelector('[data-slot="detail-meta"]');
      return {
        top: top.getBoundingClientRect().toJSON(),
        back: back.getBoundingClientRect().toJSON(),
        meta: meta.getBoundingClientRect().toJSON(),
        metaText: meta.innerText.replace(/\s+/g, " ").trim(),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    assert.match(metrics.metaText, /Last reported/);
    assert.match(metrics.metaText, /Refreshes every 20 seconds/);
    assert.ok(
      metrics.meta.y >= metrics.back.bottom - 1 ||
        metrics.meta.x >= metrics.back.right - 1,
      "英文 390 换行或同行都不挤压返回按钮",
    );
    assert.ok(
      Math.abs(metrics.meta.right - metrics.top.right) <= 2,
      "英文 390 换行后仍右对齐",
    );
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1);
    await page.screenshot({
      path: path.join(HERE, "detail-dark-390-en.png"),
      fullPage: true,
      animations: "disabled",
    });
    report.detailEn390 = metrics;
    console.log(`ok  detail en 390       meta="${metrics.metaText}"`);
  } catch (error) {
    failures.push(`detail en 390: ${error.message}`);
    console.error(`FAIL detail en 390: ${error.message}`);
  } finally {
    await page.close();
  }
}

/** ---- 2. 列表 1440：环境列 / hover / 整行点击 / 键盘 Enter ---------------------- */
{
  const { page, requests } = await newPage({ width: 1440, height: 1000, theme: "dark", view: "list" });
  try {
    await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
    await page.waitForSelector("tbody tr", { timeout: 15_000 });
    await settle(page);

    const tableMetrics = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("tbody tr")];
      const header = [...document.querySelectorAll("thead th")].map((th) =>
        th.textContent.trim(),
      );
      const env = rows.map((row) => {
        const spans = [...row.querySelectorAll("td")[1].querySelectorAll("span")];
        return spans.map((span) => span.textContent.trim());
      });
      const headAlign = [...document.querySelectorAll("thead th")].map(
        (th) => getComputedStyle(th).textAlign,
      );
      const load = rows[0].querySelectorAll("td")[2].querySelector("span");
      return {
        header,
        env,
        headAlign,
        rowCount: rows.length,
        loadFontVariant: load ? getComputedStyle(load).fontVariantNumeric : null,
        tableWidth: document.querySelector("table").getBoundingClientRect().width,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        firstHref: rows[0].getAttribute("aria-label"),
        role: rows[0].getAttribute("role"),
        tabIndex: rows[0].getAttribute("tabindex"),
      };
    });

    assert.deepEqual(tableMetrics.header, [
      "节点",
      "环境",
      "负载",
      "内存",
      "硬盘",
      "24h 可用率",
      "最后心跳",
    ]);
    assert.equal(tableMetrics.rowCount, 8);
    assert.equal(tableMetrics.role, "link", "整行是链接");
    assert.equal(tableMetrics.tabIndex, "0", "行可聚焦");
    assert.ok(tableMetrics.headAlign.every((align) => align === "left"), "数值列表头左对齐");
    assert.match(
      tableMetrics.loadFontVariant ?? "",
      /tabular-nums/,
      "负载列使用等宽数字",
    );
    assert.ok(
      tableMetrics.scrollWidth <= tableMetrics.clientWidth + 1,
      `列表页无横向溢出：${tableMetrics.scrollWidth} > ${tableMetrics.clientWidth}`,
    );
    // 环境列：第一行发行版、第二行 虚拟化 · 架构；缺字段写 —，不拼空段。
    for (let index = 0; index < EXPECTED_ENV.length; index += 1) {
      assert.deepEqual(
        tableMetrics.env[index],
        [EXPECTED_ENV[index].os, EXPECTED_ENV[index].platform],
        `第 ${index + 1} 行环境`,
      );
    }
    for (const lines of tableMetrics.env) {
      assert.ok(!lines.some((line) => line.startsWith("·") || line.includes("· —")), "不拼空段");
    }
    // 列表页只打一次列表接口，没有为环境列逐台请求详情。
    // 在发生任何行点击 / 跳转之前读，之后的详情页请求不应算进来。
    const initialRequests = requests.length;
    assert.equal(initialRequests, 1, `列表请求 N+1：${initialRequests}`);

    await page.screenshot({
      path: path.join(HERE, "list-dark-1440.png"),
      fullPage: true,
      animations: "disabled",
    });

    // hover 背景反馈 + hover 截图。
    const row = page.locator("tbody tr").nth(1);
    const before = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    await row.hover();
    await page.waitForTimeout(150);
    const hovered = await row.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.notEqual(hovered, before, "hover 有背景反馈");
    assert.notEqual(hovered, "rgba(0, 0, 0, 0)");
    await page.screenshot({
      path: path.join(HERE, "list-hover-dark-1440.png"),
      fullPage: true,
      animations: "disabled",
    });

    // 点击非首行：URL 跳到对应详情（id 已 encode）。
    await row.click();
    await page.waitForURL(`**/status/srv-kpi-2`, { timeout: 10_000 });
    await page.waitForSelector('[data-slot="detail-overview"]', { timeout: 15_000 });
    await page.screenshot({
      path: path.join(HERE, "list-clicked-detail-dark-1440.png"),
      fullPage: true,
      animations: "disabled",
    });
    report.listClick = page.url();

    // 键盘 Enter：回到列表，聚焦第 3 行后按 Enter。
    await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
    await page.waitForSelector("tbody tr", { timeout: 15_000 });
    await page.locator("tbody tr").nth(2).focus();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/status/srv-kpi-3", { timeout: 10_000 });
    report.listKeyboard = page.url();

    report.list = {
      header: tableMetrics.header,
      env: tableMetrics.env,
      headAlign: tableMetrics.headAlign,
      loadFontVariant: tableMetrics.loadFontVariant,
      tableWidth: tableMetrics.tableWidth,
      requests: initialRequests,
      hoverBackground: { before, hovered },
      click: report.listClick,
      keyboard: report.listKeyboard,
    };
    console.log(
      `ok  list dark 1440     env=${JSON.stringify(tableMetrics.env.slice(0, 5))} ` +
        `click=${report.listClick} keyboard=${report.listKeyboard}`,
    );
  } catch (error) {
    failures.push(`list: ${error.message}`);
    console.error(`FAIL list: ${error.message}`);
  } finally {
    await page.close();
  }
}

/** ---- 2b. 行内可点元素：自己的按钮不触发行跳转 ------------------------------- */
{
  const { page } = await newPage({
    width: 1440,
    height: 1000,
    theme: "dark",
    view: "list",
  });
  try {
    await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
    await page.waitForSelector("tbody tr", { timeout: 15_000 });
    await settle(page);

    // 现实里列表行还没有按钮；运行时注入一个「复制」按钮，验证整行守卫真的让路。
    await page.evaluate(() => {
      const row = document.querySelector("tbody tr");
      const cell = row.querySelectorAll("td")[1];
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "copy";
      button.dataset.testCopy = "1";
      button.addEventListener("click", () => {
        window.__copyClicks = (window.__copyClicks ?? 0) + 1;
      });
      cell.appendChild(button);
    });

    await page.locator('[data-test-copy]').click();
    await page.waitForTimeout(250);
    const afterButton = page.url();
    const copyClicks = await page.evaluate(() => window.__copyClicks ?? 0);
    assert.ok(
      /\/status\/?$/.test(new URL(afterButton).pathname),
      `点行内按钮不应跳详情：${afterButton}`,
    );
    assert.equal(copyClicks, 1, "按钮自己的点击处理器仍要执行");

    // 同一行的普通单元格仍然整行跳转。
    await page.locator("tbody tr").first().locator("td").nth(2).click();
    await page.waitForURL(`**/status/${TARGET_ID}`, { timeout: 10_000 });
    const afterCell = page.url();
    assert.ok(afterCell.endsWith(`/status/${TARGET_ID}`));

    report.rowGuard = {
      afterButton,
      copyClicks,
      afterPlainCell: afterCell,
    };
    console.log(
      `ok  row guard        button stays at ${new URL(afterButton).pathname}, ` +
        `copy=${copyClicks}, plain cell → ${new URL(afterCell).pathname}`,
    );
  } catch (error) {
    failures.push(`row guard: ${error.message}`);
    console.error(`FAIL row guard: ${error.message}`);
  } finally {
    await page.close();
  }
}

/** ---- 3. 列表 1440 亮色截图 --------------------------------------------------- */
{
  const { page } = await newPage({ width: 1440, height: 1000, theme: "light", view: "list" });
  try {
    await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
    await page.waitForSelector("tbody tr", { timeout: 15_000 });
    await settle(page);
    await page.screenshot({
      path: path.join(HERE, "list-light-1440.png"),
      fullPage: true,
      animations: "disabled",
    });
    console.log("ok  list light 1440");
  } catch (error) {
    failures.push(`list light: ${error.message}`);
    console.error(`FAIL list light: ${error.message}`);
  } finally {
    await page.close();
  }
}

/** ---- 4. 390 卡片：环境信息仍在卡片副行 ---------------------------------------- */
for (const theme of ["dark", "light"]) {
  const { page } = await newPage({
    width: 390,
    height: 844,
    theme,
    view: "grid",
  });
  try {
    await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
    await page.waitForSelector('main a[href="/status/' + TARGET_ID + '"]', {
      timeout: 15_000,
    });
    await settle(page);

    const card = await page.evaluate((targetId) => {
      const link = document.querySelector(`main a[href="/status/${targetId}"]`);
      const spec = link?.querySelector("p")?.innerText.replace(/\s+/g, " ").trim();
      return {
        spec,
        href: link?.getAttribute("href"),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    }, TARGET_ID);

    assert.equal(card.href, `/status/${TARGET_ID}`);
    assert.match(
      card.spec ?? "",
      /Debian GNU\/Linux 12 · kvm · x86_64/,
      "390 卡片副行保留发行版 / 虚拟化 / 架构",
    );
    assert.ok(
      card.scrollWidth <= card.clientWidth + 1,
      `390 卡片无横向溢出：${card.scrollWidth} > ${card.clientWidth}`,
    );

    await page.screenshot({
      path: path.join(HERE, `cards-${theme}-390.png`),
      fullPage: true,
      animations: "disabled",
    });
    report[`cards-${theme}`] = card;
    console.log(`ok  cards ${theme} 390    spec="${card.spec}"`);
  } catch (error) {
    failures.push(`cards ${theme}: ${error.message}`);
    console.error(`FAIL cards ${theme}: ${error.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();

const summary = {
  baseUrl: BASE_URL,
  detail: detailMetrics,
  detailEn390: report.detailEn390 ?? null,
  list: report.list ?? null,
  rowGuard: report.rowGuard ?? null,
  cards: {
    dark: report["cards-dark"] ?? null,
    light: report["cards-light"] ?? null,
  },
  files: readdirSync(HERE)
    .filter((file) => file.endsWith(".png"))
    .sort()
    .map((file) => ({
      file,
      kb: Math.round(statSync(path.join(HERE, file)).size / 1024),
    })),
  failures,
};
writeFileSync(path.join(HERE, "report.json"), JSON.stringify(summary, null, 2));

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("\nall status header / environment checks passed");
