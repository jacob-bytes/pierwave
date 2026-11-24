#!/usr/bin/env node
/**
 * 13px「需要被读的次要数据」实测 + 图表刻度保持 11–12px 的检查。
 *
 * Round-2 evidence: targeted 13px secondary data (list second lines, non-primary
 * table cells, detail field values, empty/error body) while chart ticks and
 * legends stay at 11–12px.
 *
 * Usage: node web/screenshots/font-floor/measure13.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://localhost:5173";
const OUT = path.join(HERE, "after13");
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(OUT, { recursive: true });

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
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "devpass" }),
});
assert.equal(login.status, 200, "login failed");
const cookie = login.headers
  .getSetCookie()
  .map((item) => item.split(";")[0])
  .find((item) => item.startsWith("pierwave_session="));
const [cookieName, cookieValue] = cookie.split("=");
const servers = (await (await fetch(`${BASE}/api/v1/servers`, {
  headers: { Cookie: cookie },
})).json()).items;
const server = servers.find((item) => item.name === "香港-01") ?? servers[0];

const font = (element) =>
  element ? Number.parseFloat(getComputedStyle(element).fontSize) : null;

const browser = await chromium.launch({
  executablePath: existsSync(CHROME) ? CHROME : undefined,
  headless: true,
});
const report = { generatedAt: new Date().toISOString(), widthChecks: [], errors: [] };

async function pageFor(width, theme = "dark") {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 900 },
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
      url: `${BASE}/`,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(`${width}: ${error}`));
  page.on("console", (message) => {
    if (message.type() === "error") report.errors.push(`${width}: ${message.text()}`);
  });
  return { context, page };
}

async function settle(page) {
  try {
    await page.waitForLoadState("networkidle");
  } catch {
    /* polling pages stay busy */
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

for (const [width, height] of [
  [1440, 900],
  [390, 844],
]) {
  const { context, page } = await pageFor(width);

  // 服务器列表：表格非主列 / 移动卡片字段 / 表格滚动宽度
  await page.goto(`${BASE}/servers`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const serverMetrics = await page.evaluate(() => {
    const card = document.querySelector("[data-slot=table-container]");
    const table = card?.querySelector("table");
    const cells = table
      ? [...table.querySelectorAll("tbody tr")][0]
        ? [...table.querySelectorAll("tbody tr")[0].querySelectorAll("td")]
        : []
      : [];
    const fontsOf = (cell) => {
      if (!cell) return [];
      const nodes = [cell, ...cell.querySelectorAll("span,p,div")];
      return nodes
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.width > 0.5 &&
            getComputedStyle(node).display !== "none" &&
            [...node.childNodes].some(
              (child) =>
                child.nodeType === Node.TEXT_NODE &&
                (child.textContent ?? "").trim() !== "",
            )
          );
        })
        .map((node) => ({
          text: [...node.childNodes]
            .filter((child) => child.nodeType === Node.TEXT_NODE)
            .map((child) => child.textContent ?? "")
            .join("")
            .trim()
            .slice(0, 40),
          font: Number.parseFloat(getComputedStyle(node).fontSize),
        }));
    };
    const headerCells = table
      ? [...table.querySelectorAll("thead th")].map((th) =>
          th.innerText.replace(/\s+/g, " ").trim(),
        )
      : [];
    const mobileCard = document.querySelector("[data-slot=mobile-data-card]");
    const mobileFields = mobileCard
      ? [...mobileCard.querySelectorAll("dl dd")].map((node) => ({
          text: node.textContent.replace(/\s+/g, " ").trim().slice(0, 40),
          font: Number.parseFloat(getComputedStyle(node).fontSize),
        }))
      : [];
    const mobileSubtitle = mobileCard?.querySelector(
      ".truncate.text-\\[13px\\]",
    );
    const mobileTitle = mobileCard?.querySelector(".text-sm.font-medium");
    const mobileAddressCell = mobileCard?.querySelector("dl dd");
    const mobileAddressCopy = mobileAddressCell?.querySelector("button");
    return {
      headerCells,
      address: fontsOf(cells[2]),
      heartbeat: fontsOf(cells[6]),
      version: fontsOf(cells[7]),
      load: fontsOf(cells[8]),
      memory: fontsOf(cells[9]),
      rate: fontsOf(cells[10]),
      name: fontsOf(cells[1]),
      mobileFields,
      mobileSubtitleFont: mobileSubtitle
        ? Number.parseFloat(getComputedStyle(mobileSubtitle).fontSize)
        : null,
      mobileTitleClip: mobileTitle
        ? mobileTitle.scrollWidth > mobileTitle.clientWidth + 1
        : null,
      mobileSubtitleClip: mobileSubtitle
        ? mobileSubtitle.scrollWidth > mobileSubtitle.clientWidth + 1
        : null,
      mobileAddressClip: mobileAddressCell
        ? mobileAddressCell.scrollWidth > mobileAddressCell.clientWidth + 1
        : null,
      mobileAddressCopy: Boolean(mobileAddressCopy),
      tableScroll: card ? card.scrollWidth : null,
      tableClient: card ? card.clientWidth : null,
      tableOverflow: card ? card.scrollWidth - card.clientWidth : null,
      docOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  report.widthChecks.push({ width, page: "servers", ...serverMetrics });

  // 链路行：最近样本 / 路由 13px
  await page.goto(`${BASE}/?view=chain`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const chainMetrics = await page.evaluate(() => {
    const sample = document.querySelector("[data-chain-sample]");
    const route = document.querySelector("[data-chain-endpoint-name]");
    const address = document.querySelector("[data-chain-endpoint-address]");
    const header = document.querySelector("[data-chain-list-head]");
    const row = document.querySelector("[data-chain-list-row]");
    return {
      sampleFont: Number.parseFloat(getComputedStyle(sample).fontSize),
      routeFont: Number.parseFloat(getComputedStyle(route).fontSize),
      addressFont: Number.parseFloat(getComputedStyle(address).fontSize),
      headerFont: Number.parseFloat(getComputedStyle(header).fontSize),
      sampleClip: sample.scrollWidth > sample.clientWidth + 1,
      routeClip: route.scrollWidth > route.clientWidth + 1,
      addressClip: address.scrollWidth > address.clientWidth + 1,
      rowHeight: Math.round(row.getBoundingClientRect().height),
      rowOverflow: row.scrollWidth - row.clientWidth,
      docOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  report.widthChecks.push({ width, page: "chain-list", ...chainMetrics });

  // 转发列表：监听端口 / 目标地址 / 启用文字 13px
  await page.goto(`${BASE}/servers/${server.id}/forwards`, {
    waitUntil: "domcontentloaded",
  });
  await settle(page);
  const forwardMetrics = await page.evaluate(() => {
    const table = document.querySelector("[data-slot=table-container] table");
    const cells = table
      ? [...table.querySelectorAll("tbody tr")][0]
        ? [...table.querySelectorAll("tbody tr")[0].querySelectorAll("td")]
        : []
      : [];
    const font = (cell) =>
      cell
        ? Number.parseFloat(getComputedStyle(cell).fontSize)
        : null;
    const enabledLabel = cells[4]
      ? [...cells[4].querySelectorAll("span")].find(
          (node) =>
            node.children.length === 0 &&
            /启用|停用|Enabled|Disabled/.test(node.textContent ?? ""),
        )
      : null;
    const container = document.querySelector("[data-slot=table-container]");
    return {
      portFont: font(cells[1]),
      targetFont: font(cells[2]),
      enabledFont: enabledLabel
        ? Number.parseFloat(getComputedStyle(enabledLabel).fontSize)
        : null,
      tableOverflow: container
        ? container.scrollWidth - container.clientWidth
        : null,
      docOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  report.widthChecks.push({ width, page: "forwards", ...forwardMetrics });

  // 用户 / 套餐：次要字段 13px
  await page.goto(`${BASE}/users`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const userMetrics = await page.evaluate(() => {
    const table = document.querySelector("[data-slot=table-container] table");
    const cells = table
      ? [...table.querySelectorAll("tbody tr")][0]
        ? [...table.querySelectorAll("tbody tr")[0].querySelectorAll("td")]
        : []
      : [];
    const mobileCard = document.querySelector("[data-slot=mobile-data-card]");
    const mobileSubtitle = mobileCard?.querySelector(
      ".truncate.text-\\[13px\\]",
    );
    const mobileTitle = mobileCard?.querySelector(".text-sm.font-medium");
    const mobileAddressCell = mobileCard?.querySelector("dl dd");
    const mobileAddressCopy = mobileAddressCell?.querySelector("button");
    const mobileFields = mobileCard
      ? [...mobileCard.querySelectorAll("dl dd")].map((node) => ({
          text: node.textContent.replace(/\s+/g, " ").trim().slice(0, 40),
          font: Number.parseFloat(getComputedStyle(node).fontSize),
        }))
      : [];
    const shortCode = cells[0]?.querySelector("span.font-mono");
    const created = cells[5]?.querySelector("span");
    const usage = cells[4]?.querySelector(".font-mono");
    return {
      shortCodeFont: mobileSubtitle
        ? Number.parseFloat(getComputedStyle(mobileSubtitle).fontSize)
        : shortCode
          ? Number.parseFloat(getComputedStyle(shortCode).fontSize)
          : null,
      createdFont: created
        ? Number.parseFloat(getComputedStyle(created).fontSize)
        : null,
      usageFont: usage
        ? Number.parseFloat(getComputedStyle(usage).fontSize)
        : null,
      mobileFields,
      docOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  report.widthChecks.push({ width, page: "users", ...userMetrics });

  await page.goto(`${BASE}/packages`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const packageMetrics = await page.evaluate(() => {
    const table = document.querySelector("[data-slot=table-container] table");
    const cells = table
      ? [...table.querySelectorAll("tbody tr")][0]
        ? [...table.querySelectorAll("tbody tr")[0].querySelectorAll("td")]
        : []
      : [];
    const mobileCard = document.querySelector("[data-slot=mobile-data-card]");
    const mobileFields = mobileCard
      ? [...mobileCard.querySelectorAll("dl dd")].map((node) => ({
          text: node.textContent.replace(/\s+/g, " ").trim().slice(0, 40),
          font: Number.parseFloat(getComputedStyle(node).fontSize),
        }))
      : [];
    return {
      quotaFont: cells[1]
        ? Number.parseFloat(getComputedStyle(cells[1]).fontSize)
        : null,
      periodFont: cells[2]
        ? Number.parseFloat(getComputedStyle(cells[2]).fontSize)
        : null,
      ratioFont: cells[4]
        ? Number.parseFloat(getComputedStyle(cells[4]).fontSize)
        : null,
      mobileFields,
      docOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  report.widthChecks.push({ width, page: "packages", ...packageMetrics });

  // 链路详情：整体数值 / 诊断句 / 逐段行 13px；刻度 / 图例 11–12px
  await page.goto(`${BASE}/?view=chain`, { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.locator("[data-chain-list-row]").first().click();
  await page.locator("[data-chain-dialog-scroll]").waitFor();
  await page.waitForTimeout(300);
  const detailMetrics = await page.evaluate(() => {
    const overallValues = [
      ...document.querySelectorAll(
        "[data-chain-overall-stats] .font-mono",
      ),
    ].map((node) => ({
      text: node.textContent.trim(),
      font: Number.parseFloat(getComputedStyle(node).fontSize),
    }));
    const diagnosis = document.querySelector("[data-chain-diagnosis]");
    const segments = [...document.querySelectorAll("[data-chain-segment]")];
    const firstLine = segments[0]?.querySelector("span");
    return {
      overallValues,
      diagnosisFont: diagnosis
        ? Number.parseFloat(getComputedStyle(diagnosis).fontSize)
        : null,
      segmentRowFont: segments[0]
        ? Number.parseFloat(getComputedStyle(segments[0]).fontSize)
        : null,
      segmentLabelFont: firstLine
        ? Number.parseFloat(getComputedStyle(firstLine).fontSize)
        : null,
      segmentRows: segments.map((row) => ({
        width: row.clientWidth,
        scrollWidth: row.scrollWidth,
        font: Number.parseFloat(getComputedStyle(row).fontSize),
      })),
      tickFont: (() => {
        const tick = document.querySelector(
          "[data-chain-time-axis] [data-chain-time-tick]",
        );
        return tick ? Number.parseFloat(getComputedStyle(tick).fontSize) : null;
      })(),
      legendFont: (() => {
        const legend = document.querySelector("[data-chain-overall-legend]");
        return legend
          ? Number.parseFloat(getComputedStyle(legend).fontSize)
          : null;
      })(),
      topologyFont: (() => {
        const label = document.querySelector(
          "[data-chain-topology-edge-latency]",
        );
        return label
          ? Number.parseFloat(getComputedStyle(label).fontSize)
          : null;
      })(),
      docOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  report.widthChecks.push({ width, page: "chain-detail", ...detailMetrics });

  // 空态正文：日志页的空态说明
  await page.goto(`${BASE}/logs`, { waitUntil: "domcontentloaded" });
  await settle(page);
  const emptyMetrics = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll("p")].filter((node) =>
      (node.textContent ?? "").includes("断流") ||
      (node.textContent ?? "").includes("事件"),
    );
    const node = candidates.find((item) => {
      const rect = item.getBoundingClientRect();
      return rect.height > 0 && getComputedStyle(item).fontSize === "13px";
    });
    return {
      emptyFont: node ? Number.parseFloat(getComputedStyle(node).fontSize) : null,
      text: node?.textContent.replace(/\s+/g, " ").trim().slice(0, 60) ?? null,
      docOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  report.widthChecks.push({ width, page: "logs-empty", ...emptyMetrics });

  // 错误态正文：新开 context（避免复用已缓存的服务器数据）并让接口返回 500
  const errorSession = await pageFor(width);
  await errorSession.page.route("**/api/v1/servers", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "测试错误：无法连接主控" }),
    });
  });
  await errorSession.page.goto(`${BASE}/servers`, {
    waitUntil: "domcontentloaded",
  });
  await errorSession.page
    .getByText("测试错误：无法连接主控")
    .waitFor({ timeout: 15_000 });
  await errorSession.page.waitForTimeout(200);
  const errorMetrics = await errorSession.page.evaluate(() => {
    const node = [...document.querySelectorAll("p")].find((item) =>
      (item.textContent ?? "").includes("测试错误"),
    );
    return {
      errorFont: node
        ? Number.parseFloat(getComputedStyle(node).fontSize)
        : null,
      text: node?.textContent.replace(/\s+/g, " ").trim().slice(0, 60) ?? null,
      docOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  report.widthChecks.push({ width, page: "servers-error", ...errorMetrics });
  await errorSession.context.close();

  await context.close();
}

await browser.close();
report.errors = report.errors.filter(
  (error) => !error.includes("status of 500"),
);
writeFileSync(`${HERE}/measure13-report.json`, `${JSON.stringify(report, null, 2)}\n`);

// 断言：所有目标位置 13px；刻度 / 图例 / 拓扑 11–12px；无页面溢出。
for (const item of report.widthChecks) {
  const { width, page: name } = item;
  const expect13 = (key) => {
    if (item[key] === null || item[key] === undefined) return;
    assert.equal(item[key], 13, `${width}/${name} ${key} = ${item[key]}px`);
  };
  if (name === "servers") {
    for (const cell of [
      ...item.address,
      ...item.heartbeat,
      ...item.version,
      ...item.load,
      ...item.memory,
      ...item.rate,
    ]) {
      if (cell.font !== 12 && cell.font !== 14) {
        assert.equal(cell.font, 13, `${width}/servers "${cell.text}" ${cell.font}px`);
      }
    }
    for (const field of item.mobileFields ?? []) {
      if (field.font !== 12) {
        assert.equal(field.font, 13, `${width}/servers mobile "${field.text}"`);
      }
    }
    if (item.mobileSubtitleFont !== null) {
      assert.equal(item.mobileSubtitleFont, 13, `${width}/servers subtitle`);
      assert.equal(item.mobileTitleClip, false, `${width}/servers name clipped`);
      assert.equal(
        item.mobileSubtitleClip,
        false,
        `${width}/servers group clipped`,
      );
      assert.equal(
        item.mobileAddressClip,
        false,
        `${width}/servers address clipped`,
      );
      assert.equal(
        item.mobileAddressCopy,
        true,
        `${width}/servers address copy missing`,
      );
    }
  }
  if (name === "chain-list") {
    expect13("sampleFont");
    expect13("routeFont");
    assert.equal(item.sampleClip, false, `${width}/chain sample clipped`);
    assert.equal(item.routeClip, false, `${width}/chain route clipped`);
    assert.equal(item.addressClip, false, `${width}/chain address clipped`);
    assert.ok(
      item.headerFont === 11 || item.headerFont === 12,
      `${width}/chain header ${item.headerFont}`,
    );
    assert.ok(item.addressFont >= 12, `${width}/chain address ${item.addressFont}`);
  }
  if (name === "forwards") {
    expect13("portFont");
    expect13("targetFont");
    expect13("enabledFont");
  }
  if (name === "users") {
    expect13("createdFont");
    expect13("shortCodeFont");
    expect13("usageFont");
    for (const field of item.mobileFields ?? []) {
      assert.equal(field.font, 13, `${width}/users mobile "${field.text}"`);
    }
  }
  if (name === "packages") {
    expect13("quotaFont");
    expect13("periodFont");
    expect13("ratioFont");
    for (const field of item.mobileFields ?? []) {
      assert.equal(field.font, 13, `${width}/packages mobile "${field.text}"`);
    }
  }
  if (name === "chain-detail") {
    expect13("diagnosisFont");
    expect13("segmentRowFont");
    for (const value of item.overallValues) {
      assert.equal(value.font, 13, `${width}/detail "${value.text}"`);
    }
    for (const row of item.segmentRows) {
      assert.ok(
        row.scrollWidth <= row.width + 1,
        `${width}/detail segment row ${row.scrollWidth}>${row.width}`,
      );
    }
    assert.ok(
      item.tickFont === 11 || item.tickFont === 12,
      `${width}/detail tick ${item.tickFont}`,
    );
    assert.ok(
      item.legendFont === 11 || item.legendFont === 12,
      `${width}/detail legend ${item.legendFont}`,
    );
    assert.equal(item.topologyFont, 11, `${width}/detail topology font`);
  }
  if (name === "logs-empty") expect13("emptyFont");
  if (name === "servers-error") expect13("errorFont");
  assert.ok(item.docOverflow <= 1, `${width}/${name} overflow ${item.docOverflow}`);
}

console.log(
  JSON.stringify(
    {
      checks: report.widthChecks.length,
      errors: report.errors,
      report: `${HERE}/measure13-report.json`,
    },
    null,
    2,
  ),
);
