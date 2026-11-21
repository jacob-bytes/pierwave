#!/usr/bin/env node
/**
 * 现状审计：对当前构建的 `/status/:id` 与 `/status` 截图并量几何。
 *
 * 用法 / Usage:
 *   (cd web && npm run build && npx vite preview --port 4180 --strictPort)
 *   BASE_URL=http://localhost:4180 node web/screenshots/detail-concepts/audit.mjs
 *
 * 只读：拦截 `/api/v1/public/status` 返回 `fixture.json`，不启动后端、不登录、
 * 不写数据库。产物在 `audit/`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUT = path.join(HERE, "audit");
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4180";
const FIXTURE = JSON.parse(readFileSync(path.join(HERE, "fixture.json"), "utf8"));
const TARGET = "c0ffee00-0000-4000-8000-000000000001"; // 香港-01
const OFFLINE = "c0ffee00-0000-4000-8000-000000000003"; // 香港-03
const THEMES = ["dark", "light"];
const WIDTHS = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }];

mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const npx = path.join(ROOT, ".npm-cache", "_npx");
  if (existsSync(npx)) {
    for (const entry of readdirSync(npx)) {
      candidates.push(path.join(npx, entry, "node_modules", "playwright", "index.mjs"));
    }
  }
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (mod.chromium) return mod.chromium;
    } catch { /* next */ }
  }
  try {
    const mod = await import("playwright");
    if (mod.chromium) return mod.chromium;
  } catch { /* below */ }
  throw new Error("找不到 playwright。设置 PLAYWRIGHT_MODULE 或安装 playwright。");
}

function chromePath() {
  return [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean).find((c) => existsSync(c));
}

const chromium = await loadPlaywright();
const browser = await chromium.launch({
  headless: true,
  ...(chromePath() ? { executablePath: chromePath() } : {}),
});

await pageSetup();
async function pageSetup() {
  const jobs = [];
  for (const theme of THEMES) for (const w of WIDTHS) {
    jobs.push({ kind: "normal", theme, ...w });
  }
  jobs.push({ kind: "offline", theme: "dark", width: 1440, height: 1000 });
  jobs.push({ kind: "offline", theme: "dark", width: 390, height: 844 });
  jobs.push({ kind: "list", theme: "dark", width: 1440, height: 1000 });
  jobs.push({ kind: "list", theme: "light", width: 1440, height: 1000 });

  const results = [];
  for (const job of jobs) {
    const page = await browser.newPage({
      viewport: { width: job.width, height: job.height },
      deviceScaleFactor: 1,
    });
    page.on("pageerror", (e) => console.error("pageerror", job.kind, e.message));
    await page.addInitScript(({ theme }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", "zh-CN");
    }, { theme: job.theme });
    await page.route("**/api/**", async (route) => {
      if (!route.request().url().includes("/api/v1/public/status")) {
        return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FIXTURE) });
    });

    const url = job.kind === "list"
      ? `${BASE_URL}/status`
      : `${BASE_URL}/status/${job.kind === "offline" ? OFFLINE : TARGET}`;
    await page.goto(url, { waitUntil: "load" });
    await page.waitForSelector(job.kind === "list" ? 'a[href^="/status/"]' : '[data-slot="detail-header"]', { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    const file = `current-${job.kind}-${job.theme}-${job.width}.png`;
    await page.screenshot({ path: path.join(OUT, file), fullPage: true, animations: "disabled" });

    let metrics = null;
    if (job.kind !== "list") metrics = await measure(page, job);
    else metrics = await measureList(page, job);
    results.push({ ...job, file, ...metrics });
    console.log("ok", file);
    await page.close();
  }

  writeFileSync(path.join(OUT, "report.json"), JSON.stringify({
    baseUrl: BASE_URL,
    fixture: "fixture.json",
    capturedAt: new Date().toISOString(),
    results,
  }, null, 2) + "\n");
  console.log(`\n${results.length} shots → ${path.relative(process.cwd(), OUT)}/report.json`);
  await browser.close();
}

async function measure(page, job) {
  return page.evaluate(({ kind, width }) => {
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), width: +b.width.toFixed(2), height: +b.height.toFixed(2) };
    };
    const s = (el) => {
      if (!el) return null;
      const c = getComputedStyle(el);
      return {
        fontSize: c.fontSize,
        lineHeight: c.lineHeight,
        color: c.color,
        background: c.backgroundColor,
        borderRadius: c.borderRadius,
        padding: c.padding,
      };
    };
    const slots = [...document.querySelectorAll("[data-slot^='detail-']")];
    const sections = slots.filter((el) => !["detail-bar", "detail-bars", "detail-stat", "detail-footer", "detail-back"].includes(el.dataset.slot));
    const sectionInfo = sections.map((el) => ({
      slot: el.dataset.slot,
      rect: r(el),
      style: s(el),
      heading: el.querySelector("h2")?.textContent?.trim() ?? null,
      headingStyle: s(el.querySelector("h2")),
    }));
    const gaps = [];
    for (let i = 1; i < sectionInfo.length; i++) {
      const prev = sectionInfo[i - 1].rect;
      const cur = sectionInfo[i].rect;
      gaps.push({ between: `${sectionInfo[i - 1].slot} → ${sectionInfo[i].slot}`, gap: +(cur.y - (prev.y + prev.height)).toFixed(2) });
    }
    const wrapper = document.querySelector("main .max-w-4xl");
    const barsWrap = document.querySelector('[data-slot="detail-bars"]');
    const bars = [...document.querySelectorAll('[data-slot="detail-bar"]')].map((el) => ({
      rect: r(el),
      bg: getComputedStyle(el).backgroundColor,
      title: el.getAttribute("title"),
      ratio: el.dataset.ratio,
    }));
    const barGaps = [];
    for (let i = 1; i < bars.length; i++) barGaps.push(+(bars[i].rect.x - (bars[i - 1].rect.x + bars[i - 1].rect.width)).toFixed(2));
    const stats = [...document.querySelectorAll('[data-slot="detail-stat"]')].map((el) => ({
      name: el.dataset.stat,
      rect: r(el),
      label: el.querySelector("div")?.textContent?.trim(),
      labelStyle: s(el.querySelector("div")),
      valueStyle: s(el.querySelector("div:nth-child(2) span")),
      valueText: el.querySelector("div:nth-child(2)")?.textContent?.replace(/\s+/g, " ").trim(),
    }));
    const h1s = [...document.querySelectorAll("h1")].map((el) => ({ text: el.textContent.trim(), rect: r(el), style: s(el) }));
    const text = document.body.innerText;
    const occurrences = {};
    for (const needle of ["在线", "更新于", "最后上报", "20 秒", "24 小时", "24h", "资源", "可用率", "系统信息", "费用与到期", "刚刚", "返回列表"]) {
      occurrences[needle] = text.split(needle).length - 1;
    }
    const footer = document.querySelector('[data-slot="detail-footer"]');
    return {
      kind,
      viewport: width,
      doc: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
        overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      },
      wrapper: r(wrapper),
      sectionInfo,
      gaps,
      stats,
      barsWrap: r(barsWrap),
      bars: {
        count: bars.length,
        width: bars[0]?.rect.width,
        height: bars[0]?.rect.height,
        gap: barGaps[0],
        radius: getComputedStyle(document.querySelector('[data-slot="detail-bar"]')).borderRadius,
        backgroundCounts: bars.reduce((acc, b) => ((acc[b.bg] = (acc[b.bg] ?? 0) + 1), acc), {}),
        heights: [...new Set(bars.map((b) => b.rect.height))],
        first: bars.slice(0, 3),
        sampleTitles: bars.filter((b) => b.ratio === "null").map((b) => b.title).slice(0, 2),
      },
      h1s,
      footer: { rect: r(footer), text: footer?.innerText?.replace(/\s+/g, " ").trim() },
      occurrences,
      textSample: text.replace(/\s+/g, " ").slice(0, 900),
    };
  }, { kind: job.kind, width: job.width });
}

async function measureList(page, job) {
  return page.evaluate(({ width }) => {
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), width: +b.width.toFixed(2), height: +b.height.toFixed(2) };
    };
    const cards = [...document.querySelectorAll('a[href^="/status/"]')].filter((a) => a.querySelector("[data-slot='card']"));
    return {
      kind: "list",
      viewport: width,
      doc: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, scrollHeight: document.documentElement.scrollHeight },
      cards: cards.length,
      cardRects: cards.slice(0, 4).map(r),
      firstCardText: cards[0]?.innerText.replace(/\s+/g, " ").trim().slice(0, 700),
    };
  }, { width: job.width });
}
