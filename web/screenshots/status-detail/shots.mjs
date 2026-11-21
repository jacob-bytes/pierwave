#!/usr/bin/env node
/**
 * `/status/:id` 服务器详情的截图与断言。
 *
 * 覆盖 normal / offline / nodata / notfound / error / disabled 六态 × 1440/390
 * × 亮/暗，另加英文、加载骨架、列表点击/键盘/返回与深链接路径。
 *
 * 用法 / Usage:
 *   (cd web && npm run build && npx vite preview --port 4173 --strictPort)
 *   BASE_URL=http://localhost:4173 node web/screenshots/status-detail/shots.mjs
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
const STATES = ["normal", "offline", "nodata", "notfound", "error", "disabled"];
const THEMES = ["dark", "light"];
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];
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
    state: "normal",
    theme: "dark",
    width: 1440,
    height: 1000,
    locale: "en",
    out: path.join(HERE, "normal-dark-1440-en.png"),
    label: "normal dark 1440 en",
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
  return list;
}

function fixtureFor(state) {
  if (state === "offline") return detailFixture("offline");
  if (state === "nodata") return detailFixture("nodata");
  return detailFixture("normal");
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
    // error / disabled 两种状态刻意让接口返回 500 / 404，浏览器控制台会记录
    // 资源加载失败；这是被测状态本身，不是页面报错。
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
        statSkeletons: document.querySelectorAll('[data-slot="skeleton"]').length,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      assert.equal(loading.busy, true, "加载中要有详情骨架");
      assert.ok(
        loading.scrollWidth <= loading.clientWidth + 1,
        `横向溢出 ${loading.scrollWidth} > ${loading.clientWidth}`,
      );
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
        loading,
        kb: Math.round(statSync(job.out).size / 1024),
      });
      console.log(`ok  ${path.basename(job.out).padEnd(30)} loading skeleton`);
      continue;
    }

    if (job.state === "error") {
      await page.getByText(
        job.locale === "zh-CN"
          ? "暂时无法获取服务状态"
          : "Service status is temporarily unavailable",
        { exact: false },
      ).waitFor({ timeout: 15_000 });
    } else if (job.state === "disabled") {
      await page.getByText(
        job.locale === "zh-CN" ? "状态页未开放" : "This status page is not public",
        { exact: false },
      ).waitFor({ timeout: 15_000 });
    } else if (job.state === "notfound") {
      await page.getByText(
        job.locale === "zh-CN"
          ? "该服务器不存在或已下线"
          : "This server does not exist or is offline",
        { exact: false },
      ).waitFor({ timeout: 15_000 });
    } else {
      await page.waitForSelector('[data-slot="detail-header"]', {
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
      const rect = (element) => {
        const box = element.getBoundingClientRect();
        return {
          x: round(box.x),
          y: round(box.y),
          width: round(box.width),
          height: round(box.height),
        };
      };
      const main = document.querySelector("main");
      const header = main.querySelector('[data-slot="detail-header"]');
      const stats = [...main.querySelectorAll('[data-slot="detail-stat"]')];
      const byStat = {};
      for (const stat of stats) {
        byStat[stat.dataset.stat] = {
          text: stat.innerText.replace(/\s+/g, " ").trim(),
          ...rect(stat),
        };
      }
      const bars = [...main.querySelectorAll('[data-slot="detail-bar"]')].map(
        (bar) => ({
          ratio: bar.dataset.ratio,
          height: round(bar.getBoundingClientRect().height),
          color: getComputedStyle(bar).backgroundColor,
        }),
      );
      const lowest = main.querySelector('[data-slot="detail-lowest"]');
      const billing = main.querySelector('[data-slot="detail-billing"]');
      const system = main.querySelector('[data-slot="detail-system"]');
      const footer = main.querySelector('[data-slot="detail-footer"]');
      const back =
        main.querySelector('[data-slot="detail-back"]') ??
        main.querySelector('a[href="/status"]');
      const badge = header?.querySelector('[data-slot="badge"]');
      const sectionOrder = [
        '[data-slot="detail-header"]',
        '[data-slot="detail-key-numbers"]',
        '[data-slot="detail-availability"]',
        '[data-slot="detail-resources"]',
        '[data-slot="detail-billing"]',
        '[data-slot="detail-system"]',
        '[data-slot="detail-footer"]',
      ]
        .map((selector) => main.querySelector(selector))
        .filter(Boolean)
        .map((element) => element.dataset.slot);

      return {
        text: main.innerText.replace(/\s+/g, " ").trim(),
        h1: main.querySelector("h1")?.textContent?.trim() ?? null,
        header: header ? rect(header) : null,
        badge: badge?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        stats: byStat,
        bars,
        lowest: lowest?.innerText.replace(/\s+/g, " ").trim() ?? null,
        billing: billing?.innerText.replace(/\s+/g, " ").trim() ?? null,
        system: system?.innerText.replace(/\s+/g, " ").trim() ?? null,
        footer: footer?.innerText.replace(/\s+/g, " ").trim() ?? null,
        back: back
          ? { href: back.getAttribute("href"), height: round(back.getBoundingClientRect().height) }
          : null,
        sectionOrder,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
      };
    });

    assert.ok(
      metrics.scrollWidth <= metrics.clientWidth + 1,
      `横向溢出 ${metrics.scrollWidth} > ${metrics.clientWidth}`,
    );

    if (job.state === "normal") {
      assert.equal(metrics.h1, "香港-亚太边缘入口");
      assert.match(
        metrics.badge ?? "",
        job.locale === "zh-CN" ? /在线/ : /Online/,
      );
      assert.match(metrics.text, /亚太/);
      assert.match(metrics.stats.latency?.text ?? "", /18\s*ms/);
      assert.match(metrics.stats.uptime?.text ?? "", /9[78](\.\d+)?\s*%/);
      assert.match(metrics.stats.rate?.text ?? "", /17\.5\s*MB\/s/);
      assert.match(metrics.stats.rate?.text ?? "", /2\.19\s*MB\/s/);
      assert.equal(metrics.bars.length, 24, "24 格竖条");
      assert.match(metrics.lowest ?? "", /03:00–04:00/);
      assert.match(metrics.lowest ?? "", /91%/);
      if (job.locale === "zh-CN") {
        assert.match(metrics.billing ?? "", /27 天后到期/);
        assert.match(metrics.billing ?? "", /¥268\.00\s*\/\s*月/);
      } else {
        assert.match(metrics.billing ?? "", /27 days left/);
        assert.match(metrics.billing ?? "", /¥268\.00\s*\/\s*mo/);
      }
      assert.match(metrics.system ?? "", /Debian GNU\/Linux 12/);
      assert.match(metrics.system ?? "", /kvm/);
      assert.match(metrics.system ?? "", /x86_64/);
      if (job.locale === "zh-CN") {
        assert.match(metrics.footer ?? "", /数据每 20 秒刷新/);
        assert.match(metrics.footer ?? "", /最后上报/);
      } else {
        assert.match(metrics.footer ?? "", /Refreshes every 20 seconds/);
        assert.match(metrics.footer ?? "", /Last reported/);
      }
      assert.ok((metrics.back?.height ?? 0) >= 40, "返回列表触控目标 ≥40px");
      assert.deepEqual(metrics.sectionOrder, [
        "detail-header",
        "detail-key-numbers",
        "detail-availability",
        "detail-resources",
        "detail-billing",
        "detail-system",
        "detail-footer",
      ]);
    }

    if (job.state === "offline") {
      assert.match(metrics.badge ?? "", /离线/);
      assert.doesNotMatch(metrics.badge ?? "", /在线/);
      // 离线前的最后已知值仍展示。
      assert.match(metrics.stats.latency?.text ?? "", /18\s*ms/);
      assert.match(metrics.stats.uptime?.text ?? "", /9[78](\.\d+)?\s*%/);
      assert.match(metrics.stats.rate?.text ?? "", /17\.5\s*MB\/s/);
      assert.match(metrics.footer ?? "", /最后上报/);
    }

    if (job.state === "nodata") {
      assert.match(metrics.badge ?? "", /在线/);
      for (const stat of ["latency", "uptime", "rate"]) {
        assert.match(
          metrics.stats[stat]?.text ?? "",
          /—/,
          `${stat} 无数据应为 —`,
        );
      }
      assert.equal(metrics.bars.length, 24);
      assert.ok(metrics.bars.every((bar) => bar.ratio === "null"));
      assert.equal(metrics.lowest, null, "无采样时不显示最低时段");
      assert.equal(metrics.billing, null, "没有账期时不渲染费用卡");
      assert.match(metrics.text, /未上报/);
      assert.match(metrics.footer ?? "", /从未上报/);
    }

    if (job.state === "notfound") {
      assert.match(metrics.text, /该服务器不存在或已下线/);
      assert.ok(metrics.back, "未找到也要有返回列表");
      assert.match(metrics.back?.href ?? "", /\/status$/);
    }

    if (job.state === "error") {
      assert.match(metrics.text, /暂时无法获取服务状态/);
      assert.match(metrics.text, /重试/);
      assert.ok(metrics.back, "错误态也要有返回列表");
    }

    if (job.state === "disabled") {
      assert.match(metrics.text, /状态页未开放/);
    }

    if (job.width === 390 && ["normal", "offline", "nodata"].includes(job.state)) {
      const ys = ["latency", "uptime", "rate"].map(
        (stat) => metrics.stats[stat]?.y,
      );
      assert.ok(
        ys[0] < ys[1] && ys[1] < ys[2],
        `390 下三个数字应单列堆叠：${ys.join(" / ")}`,
      );
      assert.ok((metrics.back?.height ?? 0) >= 40);
    }

    if (job.locale === "en" && job.state === "normal") {
      assert.match(metrics.text, /Back to list/);
      assert.match(metrics.text, /Lowest hour/);
      assert.match(metrics.text, /Refreshes every 20 seconds/);
      assert.match(metrics.text, /Debian GNU\/Linux 12/);
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
      stats: metrics.stats,
      bars: metrics.bars.length,
      lowest: metrics.lowest,
      billing: metrics.billing,
      system: metrics.system,
      footer: metrics.footer,
      back: metrics.back,
      scrollWidth: metrics.scrollWidth,
      scrollHeight: metrics.scrollHeight,
      kb: Math.round(statSync(job.out).size / 1024),
    });
    console.log(
      `ok  ${path.basename(job.out).padEnd(30)} ${metrics.h1 ?? "state"}  ${metrics.scrollWidth}×${metrics.scrollHeight}`,
    );
  } catch (error) {
    failures.push(`${job.label}: ${error.message}`);
    console.error(`FAIL ${job.label}: ${error.message}`);
  } finally {
    await page.close();
  }
}

// ---- 交互路径：列表点击 / 键盘 Enter / 深链接 / 返回列表 ----------------------
const interactions = {};
{
  let failNext = false;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    localStorage.setItem("pierwave.theme", "dark");
    localStorage.setItem("pierwave.locale", "zh-CN");
  });
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/v1/public/status")) {
      if (failNext) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: "{}",
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(detailFixture("normal")),
      });
      return;
    }
    await route.fulfill({ status: 404, body: "{}" });
  });
  try {
    await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
    await page.waitForFunction(
      () => document.querySelectorAll("main h3").length === 8,
      undefined,
      { timeout: 15_000 },
    );
    const cardLink = page.locator(`a[href="/status/${TARGET_ID}"]`).first();
    assert.equal(await cardLink.count(), 1, "卡片要有详情链接");
    await cardLink.click();
    await page.waitForURL(`**/status/${TARGET_ID}`, { timeout: 10_000 });
    await page.waitForSelector('[data-slot="detail-header"]');
    interactions.fromList = { url: page.url(), h1: await page.locator("main h1").innerText() };

    await page.locator('[data-slot="detail-back"]').click();
    await page.waitForURL("**/status", { timeout: 10_000 });
    await page.waitForFunction(
      () => document.querySelectorAll("main h3").length === 8,
      undefined,
      { timeout: 15_000 },
    );
    interactions.backToList = { url: page.url(), cards: await page.locator("main h3").count() };

    // 键盘 Enter：卡片是真实链接，不需要自造 role=link 的键盘处理。
    await cardLink.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(`**/status/${TARGET_ID}`, { timeout: 10_000 });
    await page.waitForSelector('[data-slot="detail-header"]');
    interactions.keyboard = { url: page.url() };

    // 深链接：直接打开详情 URL。
    await page.goto(`${BASE_URL}/status/${TARGET_ID}`, { waitUntil: "load" });
    await page.waitForSelector('[data-slot="detail-header"]', { timeout: 15_000 });
    interactions.deepLink = { url: page.url(), h1: await page.locator("main h1").innerText() };

    // 列表入口截图：保留卡片的 chevron 提示。
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

    // 先成功、后失败：错误面板要带「上次成功」时间。
    await page.goto(`${BASE_URL}/status/${TARGET_ID}`, { waitUntil: "load" });
    await page.waitForSelector('[data-slot="detail-header"]', { timeout: 15_000 });
    failNext = true;
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.getByText("暂时无法获取服务状态").waitFor({ timeout: 10_000 });
    const lastSuccessText = await page
      .getByText(/上次成功/)
      .innerText();
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
}

await browser.close();

writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify({ baseUrl: BASE_URL, results, interactions, failures }, null, 2)}\n`,
);

console.log(
  `\n${results.length + 2} 张截图 → ${path.relative(process.cwd(), HERE) || "."}`,
);
if (failures.length > 0) {
  console.error(`\n${failures.length} 个任务失败：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
