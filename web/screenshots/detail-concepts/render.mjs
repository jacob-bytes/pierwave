#!/usr/bin/env node
/**
 * 详情页概念 A / B 的截图与断言。
 * Screenshots and assertions for the two server-detail concepts.
 *
 * 用法 / Usage:
 *   node web/screenshots/detail-concepts/render.mjs
 *
 * 直接读本地 file://，不启动服务、不发网络请求、不写产品代码。
 * 需要 Playwright 与本机 Chrome；可用 PLAYWRIGHT_MODULE / CHROME_PATH 覆盖。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const THEMES = ["dark", "light"];
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];
const VARIANTS = [
  { id: "a", file: "a.html", label: "方案 A · 状态报告" },
  { id: "b", file: "b.html", label: "方案 B · 仪表盘" },
];

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

function jobs() {
  const list = [];
  for (const variant of VARIANTS) {
    for (const theme of THEMES) {
      for (const { width, height } of WIDTHS) {
        list.push({
          variant,
          theme,
          width,
          height,
          out: path.join(HERE, `${variant.id}-${theme}-${width}.png`),
          label: `${variant.id} ${theme} ${width}`,
        });
      }
    }
    for (const { width, height } of WIDTHS) {
      list.push({
        variant,
        theme: "dark",
        width,
        height,
        query: "&variant=incident",
        incident: true,
        out: path.join(HERE, `${variant.id}-incident-dark-${width}.png`),
        label: `${variant.id} incident dark ${width}`,
      });
    }
  }
  list.push({
    variant: VARIANTS[0],
    theme: "dark",
    width: 1440,
    height: 1000,
    hover: { kind: "ribbon", index: 5 },
    out: path.join(HERE, "a-hover-dark-1440.png"),
    label: "a hover dark 1440",
  });
  list.push({
    variant: VARIANTS[1],
    theme: "dark",
    width: 1440,
    height: 1000,
    query: "&variant=incident",
    incident: true,
    hover: { kind: "chart", frac: 0.45 },
    out: path.join(HERE, "b-hover-incident-dark-1440.png"),
    label: "b hover incident dark 1440",
  });
  return list;
}

const chromium = await loadPlaywright();
const browser = await chromium.launch({
  headless: true,
  ...(chromePath() ? { executablePath: chromePath() } : {}),
});

const results = [];
const failures = [];

for (const job of jobs()) {
  const page = await browser.newPage({
    viewport: { width: job.width, height: job.height },
    deviceScaleFactor: 1,
    timezoneId: "Asia/Shanghai",
    locale: "zh-CN",
  });
  page.on("pageerror", (e) => failures.push(`${job.label}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") failures.push(`${job.label}: console ${m.text()}`);
  });

  const url =
    pathToFileURL(path.join(HERE, job.variant.file)).href +
    `?theme=${job.theme}${job.query ?? ""}`;

  try {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(
      () => document.documentElement.dataset.ready === "1",
      undefined,
      { timeout: 10_000 },
    );
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    await page.mouse.move(1, 1);

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      server: document.documentElement.dataset.server,
      variant: document.documentElement.dataset.variant,
      text: document.body.innerText.replace(/\s+/g, " ").trim(),
    }));
    assert.ok(
      metrics.scrollWidth <= metrics.clientWidth + 1,
      `横向溢出 ${metrics.scrollWidth} > ${metrics.clientWidth}`,
    );

    const incident = job.incident === true;
    assert.equal(metrics.variant, incident ? "incident" : "normal", "fixture variant");
    assert.equal(
      metrics.server,
      incident
        ? "c0ffee00-0000-4000-8000-000000000003"
        : "c0ffee00-0000-4000-8000-000000000001",
      "目标服务器",
    );

    if (job.variant.id === "a") {
      assert.equal(await page.locator(".seg").count(), 24, "24 小时应有 24 格");
      assert.equal(await page.locator(".seg.unknown").count(), 2, "真实数据应有 2 个无采样小时");
      const labels = await page.locator(".seg").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
      assert.ok(labels.every(Boolean), "每格都要有 aria-label");
      assert.ok(labels.some((l) => /无采样|没有采样/.test(l)), "空格应说明无采样");
      for (const needle of ["7 天可用率", "Debian GNU/Linux 12", "kvm", "x86_64", "近 7 天概览"]) {
        assert.ok(metrics.text.includes(needle), `方案 A 缺少「${needle}」`);
      }
      if (!incident) {
        for (const needle of ["运行正常", "香港-01", "28", "1.8", "512", "170 GB", "52.9 GB", "¥268.00"]) {
          assert.ok(metrics.text.includes(needle), `方案 A 缺少「${needle}」`);
        }
      } else {
        assert.ok(metrics.text.includes("离线"), "事故态应显示离线");
        assert.ok(metrics.text.includes("24.77%"), "事故态应显示 24h 可用率");
        assert.ok(metrics.text.includes("16 小时中断"), "事故态应显示中断小时数");
        assert.ok(metrics.text.includes("88.02"), "事故态应显示 7 天可用率");
        assert.ok(metrics.text.includes("离线前在线"), "离线态应保留最后在线时长");
        assert.ok(metrics.text.includes("71.3 GB"), "事故态累计下行流量");
        assert.ok(metrics.text.includes("21.8 GB"), "事故态累计上行流量");
      }
    } else {
      assert.equal(await page.locator("#chart").count(), 1, "图表应存在");
      assert.ok((await page.locator("#chart rect").count()) >= 2, "缺失小时应画斜线柱");
      assert.ok((await page.locator("#chart circle").count()) >= 1, "曲线应有点");
      for (const needle of [
        "服务状态", "在线时长", "延迟", "当前速率", "7 天可用率",
        "Debian GNU/Linux 12", "kvm", "x86_64",
      ]) {
        assert.ok(metrics.text.includes(needle), `方案 B 缺少「${needle}」`);
      }
      if (!incident) {
        for (const needle of ["223 GB", "170 GB", "52.9 GB", "¥268.00"]) {
          assert.ok(metrics.text.includes(needle), `方案 B 缺少「${needle}」`);
        }
      }
      if (incident) {
        assert.ok(metrics.text.includes("离线"), "事故态应显示离线");
        assert.ok(metrics.text.includes("24.77%"), "事故态应显示 24h 可用率");
        assert.ok(metrics.text.includes("88.02"), "事故态应显示 7 天可用率");
        assert.equal(await page.locator("#bill-card").count(), 0, "无套餐时不应渲染费用卡");
        assert.ok(metrics.text.includes("93.1 GB"), "事故态累计流量合计");
        assert.ok(metrics.text.includes("71.3 GB"), "事故态累计下行流量");
        assert.ok(metrics.text.includes("21.8 GB"), "事故态累计上行流量");
      }
    }

    if (job.hover) {
      if (job.hover.kind === "ribbon") {
        await page.locator(".seg").nth(job.hover.index).hover();
        await page.waitForTimeout(180);
        const tip = page.locator("#ribbon-tip");
        await tip.waitFor({ state: "visible", timeout: 2_000 });
        const text = await tip.innerText();
        assert.match(text, /%/, "悬停应显示百分比");
        assert.match(text, /\d{2}:\d{2}–\d{2}:\d{2}/, "悬停应显示时段");
      } else {
        const box = await page.locator("#plot").boundingBox();
        await page.mouse.move(box.x + box.width * job.hover.frac, box.y + box.height * 0.5);
        await page.waitForTimeout(180);
        const tip = page.locator("#chart-tip");
        await tip.waitFor({ state: "visible", timeout: 2_000 });
        const text = await tip.innerText();
        assert.match(text, /%/, "悬停应显示百分比");
        assert.match(text, /中断|正常|无采样|可用性下降/, "悬停应显示状态");
      }
    }

    await page.screenshot({ path: job.out, fullPage: true, animations: "disabled" });
    const bytes = statSync(job.out).size;
    results.push({
      file: path.relative(HERE, job.out),
      label: job.label,
      width: metrics.scrollWidth,
      height: metrics.scrollHeight,
      kb: Math.round(bytes / 1024),
    });
    console.log(
      `ok  ${path.relative(HERE, job.out).padEnd(34)} ${metrics.scrollWidth}×${metrics.scrollHeight}  ${Math.round(bytes / 1024)} KB`,
    );
  } catch (error) {
    failures.push(`${job.label}: ${error.message}`);
    console.error(`FAIL ${job.label}: ${error.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();

writeFileSync(
  path.join(HERE, "report.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      fixture: "fixture.json (real /api/v1/public/status snapshot, timestamps normalised)",
      results,
    },
    null,
    2,
  ) + "\n",
);

console.log(`\n${results.length} 张截图 → ${path.relative(process.cwd(), HERE) || "."}`);
if (failures.length) {
  console.error(`\n${failures.length} 个任务失败：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
