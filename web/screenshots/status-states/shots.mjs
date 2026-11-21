#!/usr/bin/env node
/**
 * 公开状态页五态截图 / Five states of the public status page.
 *
 * 用法 / Usage:
 *   (cd web && npm run build && npx vite preview --port 4173 --strictPort)
 *   node web/screenshots/status-states/shots.mjs
 *
 * 产物 / Output
 *   {state}-{theme}-{width}.png      中文 20 张（5 状态 × 亮/暗 × 1440/390）
 *   {state}-dark-1440-en.png         英文 5 张（每个状态一张）
 *   report.json                      尺寸、断言结果与可见文案
 *
 * 数据由 Playwright 拦截 `GET /api/v1/public/status` 返回，不启动后端、不写库。
 * 错误态用 Playwright 的假时钟快进 20 秒，先拿到一次成功数据，再让轮询失败，
 * 因此截图里能看到「上次成功 HH:MM:SS」。
 *
 * 环境变量：BASE_URL、PLAYWRIGHT_MODULE、CHROME_PATH。
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
import {
  DISABLED_BODY,
  ERROR_BODY,
  EXPECTED,
  HERO_LABEL,
  publicStatusFixture,
} from "./fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:4173";
const STATES = [
  "empty",
  "filtered",
  "all-offline",
  "ready",
  "selected",
  "disabled",
  "error",
];
const THEMES = ["light", "dark"];
const WIDTHS = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
];

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

function clean(value) {
  return value.replace(/\s+/g, " ").trim();
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
          label: `${state} ${theme} ${width} zh`,
        });
      }
    }
    list.push({
      state,
      theme: "dark",
      width: 1440,
      height: 1000,
      locale: "en",
      out: path.join(HERE, `${state}-dark-1440-en.png`),
      label: `${state} dark 1440 en`,
    });
  }
  return list;
}

async function assertCommon(page) {
  const header = page.locator("header");
  await header.locator("h1").waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(
    await header.locator('a[href="/login"]').count(),
    1,
    "页头必须保留「进入后台」",
  );
  assert.equal(
    await header.locator('button[aria-label]').count() >= 1,
    true,
    "页头必须保留主题切换",
  );

  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert.ok(
    metrics.scrollWidth <= metrics.clientWidth + 1,
    `横向溢出 ${metrics.scrollWidth} > ${metrics.clientWidth}`,
  );
}

async function readHeroStats(page, locale) {
  const hero = page.locator(
    `[role="group"][aria-label="${HERO_LABEL[locale]}"]`,
  );
  await hero.waitFor({ state: "visible", timeout: 15_000 });
  const texts = (
    await hero.locator("div.grid").first().locator(":scope > div").allInnerTexts()
  ).map(clean);
  assert.equal(texts.length, 3, "hero 必须正好三个大数字");
  return { hero, texts };
}

async function triggerFilteredEmpty(page, locale) {
  const searchbox = page.getByRole("searchbox");
  await searchbox.fill("__no_matching_node__");
  const expected = EXPECTED.filtered[locale];
  await page.getByText(expected.title, { exact: true }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  const clear = page
    .getByRole("button", { name: expected.action })
    .first();
  assert.equal(await clear.count(), 1, "筛选空态必须提供清除筛选按钮");
  return clear;
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
    locale: job.locale,
  });
  page.on("pageerror", (error) =>
    failures.push(`${job.label}: ${error.message}`),
  );
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // 关闭态与失败态会故意返回 404 / 500，浏览器会把它们记成 console error；
    // 这是截图场景本身，不算页面错误。
    if (job.state === "disabled" && text.includes("404")) return;
    if (job.state === "error" && text.includes("500")) return;
    failures.push(`${job.label}: console ${text}`);
  });

  await page.addInitScript(
    ({ theme, locale }) => {
      window.localStorage.setItem("pierwave.theme", theme);
      window.localStorage.setItem("pierwave.locale", locale);
    },
    { theme: job.theme, locale: job.locale },
  );

  // 错误态：先真实成功一次，再让下一次轮询失败，截图里才有「上次成功」。
  if (job.state === "error") {
    await page.clock.install({ time: new Date() });
  }
  let failing = false;
  let failingCalls = 0;

  await page.route("**/api/**", async (route) => {
    const url = route.request().url();
    if (!url.includes("/api/v1/public/status")) {
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
        body: JSON.stringify(DISABLED_BODY),
      });
      return;
    }

    if (job.state === "error" && failing) {
      failingCalls += 1;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify(ERROR_BODY),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        publicStatusFixture(
          job.state === "filtered"
            ? "all-online"
            : job.state === "ready" || job.state === "selected"
              ? "ready"
              : job.state,
        ),
      ),
    });
  });

  try {
    await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
    await assertCommon(page);
    const expected = EXPECTED[job.state][job.locale];
    let heroStats = null;

    if (job.state === "empty") {
      const hero = await readHeroStats(page, job.locale);
      heroStats = hero.texts;
      for (const text of hero.texts) {
        assert.ok(
          text.includes("—"),
          `空库的 hero 数字必须是 —，实际：${text}`,
        );
        assert.ok(
          !/\b0\b/.test(text.replace(/24h/g, "")),
          `空库的 hero 不能把未知渲染成 0：${text}`,
        );
      }
      const text = clean(await page.locator("main").innerText());
      assert.ok(text.includes(expected.title), `缺少空态标题：${text}`);
      assert.ok(
        text.includes(expected.description),
        `缺少空态说明：${text}`,
      );
      for (const forbidden of expected.notFailure) {
        assert.ok(
          !text.includes(forbidden),
          `空库不能用失败语气（${forbidden}）：${text}`,
        );
      }
      assert.equal(
        await page.getByRole("button", { name: /重试|Retry/i }).count(),
        0,
        "空库不应该出现重试",
      );
    } else if (job.state === "filtered") {
      const before = await readHeroStats(page, job.locale);
      const clear = await triggerFilteredEmpty(page, job.locale);
      const after = await readHeroStats(page, job.locale);
      assert.deepEqual(after.texts, before.texts, "筛选时 hero 必须保持不变");
      heroStats = before.texts;

      // 一键清除筛选确实能回到全部节点。
      await clear.click();
      await page.waitForFunction(
        () => document.querySelectorAll("main h3").length === 8,
        undefined,
        { timeout: 10_000 },
      );
      // 回到筛选态再截图。
      await triggerFilteredEmpty(page, job.locale);
      const text = clean(await page.locator("main").innerText());
      assert.ok(text.includes(`0 / 8`), `工具栏应显示 0 / 8：${text}`);
    } else if (job.state === "all-offline") {
      const hero = await readHeroStats(page, job.locale);
      heroStats = hero.texts;
      const verdict = clean(await hero.hero.locator("p").first().innerText());
      assert.ok(
        verdict.includes(expected.headline),
        `全离线结论不符：${verdict}`,
      );
      assert.ok(
        hero.texts[0].includes("—"),
        `全离线时平均延迟必须是 —：${hero.texts[0]}`,
      );

      const mainText = clean(await page.locator("main").innerText());
      assert.match(mainText, expected.note, "全离线缺少「最近一次更新」说明");
      const badges = (await page
        .locator('main [data-slot="badge"]')
        .allInnerTexts()).map(clean);
      assert.equal(
        badges.filter((text) => text.includes(expected.chip)).length,
        8,
        `全离线卡片应全部展示离线徽章：${JSON.stringify(badges)}`,
      );
      assert.equal(
        await page.locator("main .text-destructive").count(),
        0,
        "全部离线不能使用红色警报色调",
      );
      const cards = await page.locator('main [data-slot="card"] h3').count();
      assert.equal(cards, 8, "全离线仍要照常展示全部卡片");

      // 选中态不能盖住「离线」：点一下离线卡片，边框变主色，但 chip 仍是离线。
      const firstCard = page
        .locator('main [data-slot="card"]')
        .filter({ has: page.locator("h3") })
        .first();
      await firstCard.click();
      await page.waitForTimeout(50);
      assert.equal(
        await firstCard.getAttribute("aria-pressed"),
        "true",
        "离线卡片也必须可选中",
      );
      const selectedChip = clean(
        await firstCard.locator('[data-slot="badge"]').first().innerText(),
      );
      assert.ok(
        selectedChip.includes(expected.chip),
        `选中不能覆盖离线状态：${selectedChip}`,
      );
      await firstCard.click();
      await page.waitForTimeout(50);
      assert.equal(
        await firstCard.getAttribute("aria-pressed"),
        "false",
        "再次点击应取消选中",
      );
    } else if (job.state === "ready" || job.state === "selected") {
      const hero = await readHeroStats(page, job.locale);
      heroStats = hero.texts;
      // 第一个 KPI 是平均延迟，不再是重复结论句的在线率。
      assert.ok(
        hero.texts[0].includes(expected.kpi),
        `第一个 KPI 应为平均延迟：${hero.texts[0]}`,
      );
      assert.match(hero.texts[0], expected.latency, "平均延迟读数不符");
      assert.ok(
        hero.texts[1].includes(
          job.locale === "zh-CN" ? "平均 24h 可用率" : "Avg 24h uptime",
        ),
        `第二个 KPI 布局被改动：${hero.texts[1]}`,
      );
      assert.ok(
        hero.texts[2].includes(
          job.locale === "zh-CN" ? "当前总速率" : "Total rate",
        ),
        `第三个 KPI 布局被改动：${hero.texts[2]}`,
      );

      const cards = page
        .locator('main [data-slot="card"]')
        .filter({ has: page.locator("h3") });
      assert.equal(await cards.count(), 8, "正常态必须保留 8 张卡片");
      assert.equal(
        await page.locator(
          `main [data-slot="card"] [role="group"][aria-label="${job.locale === "zh-CN" ? "到期与价格" : "Expiry and price"}"]`,
        ).count(),
        8,
        "每张卡片都必须保留第三列（到期与价格）",
      );

      const cardTexts = (await cards.allInnerTexts()).map(clean);
      assert.ok(
        cardTexts[0].includes(expected.fullBilling),
        `第一张卡片的完整账期缺失：${cardTexts[0]}`,
      );
      assert.ok(
        cardTexts[1].includes(expected.notSet),
        `只有到期日的卡片应显示未配置价格：${cardTexts[1]}`,
      );
      assert.ok(
        cardTexts[2].includes(expected.yearlyBilling),
        `只有价格的卡片应正常显示价格：${cardTexts[2]}`,
      );
      assert.ok(
        cardTexts[2].includes(expected.notSet),
        `缺到期日的卡片应显示未配置：${cardTexts[2]}`,
      );
      assert.ok(
        cardTexts[3].split(expected.notSet).length - 1 >= 2,
        `四项全缺的卡片应保留两个未配置占位：${cardTexts[3]}`,
      );

      // 第三列占位不是只写在 class 里：1440 必须真是三列；390 必须两列，
      // 且账期组横跨整行。
      const layout = await page.evaluate((billingLabel) => {
        const billing = document.querySelector(
          `[role="group"][aria-label="${billingLabel}"]`,
        );
        const grid = billing?.parentElement;
        if (!billing || !grid) return null;
        return {
          columns: getComputedStyle(grid).gridTemplateColumns
            .split(" ")
            .filter(Boolean).length,
          billingWidth: billing.getBoundingClientRect().width,
          gridWidth: grid.getBoundingClientRect().width,
        };
      }, job.locale === "zh-CN" ? "到期与价格" : "Expiry and price");
      assert.ok(layout, "找不到到期与价格列");
      if (job.width >= 768) {
        assert.equal(layout.columns, 3, "桌面端必须是三列");
      } else {
        assert.equal(layout.columns, 2, "移动端必须是两列");
        assert.ok(
          Math.abs(layout.billingWidth - layout.gridWidth) <= 2,
          `移动端账期组必须独占一行：${JSON.stringify(layout)}`,
        );
      }

      if (job.state === "selected") {
        const firstCard = cards.first();
        await firstCard.click();
        assert.equal(
          await firstCard.getAttribute("aria-pressed"),
          "true",
          "点击后必须进入选中态",
        );
        const className = (await firstCard.getAttribute("class")) ?? "";
        assert.match(className, /ring-primary/, "选中态必须是主色边框");
        assert.match(className, /shadow-sm/, "选中态必须是极淡阴影");
        const chip = clean(
          await firstCard.locator('[data-slot="badge"]').first().innerText(),
        );
        assert.ok(
          chip.includes(job.locale === "zh-CN" ? "在线" : "Online"),
          `选中态不能改变状态语义：${chip}`,
        );

        // 键盘可达：focus 不报错；Enter 切换选中态，再按一次回到选中。
        await firstCard.focus();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(80);
        assert.equal(
          await firstCard.getAttribute("aria-pressed"),
          "false",
          "Enter 必须能取消选中",
        );
        await page.keyboard.press("Enter");
        await page.waitForTimeout(80);
        assert.equal(
          await firstCard.getAttribute("aria-pressed"),
          "true",
          "Enter 必须能重新选中",
        );

        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        });
      }
    } else if (job.state === "disabled") {
      const text = clean(await page.locator("main").innerText());
      assert.ok(text.includes(expected.title), `关闭态标题不符：${text}`);
      assert.ok(
        text.includes(expected.description),
        `关闭态说明不符：${text}`,
      );
      assert.equal(
        await page.getByRole("button", { name: expected.retry }).count(),
        0,
        "关闭态不能出现重试按钮",
      );
      assert.equal(
        await page.locator('[role="status"]').count() >= 1,
        true,
        "关闭态必须有 role=status",
      );
      assert.equal(
        await page.locator('[role="alert"]').count(),
        0,
        "关闭态不需要 alert",
      );
      // 页头保留品牌 / 主题 / 进入后台；状态点转中性「未开放」（移动端是 sr-only）。
      const headerText = clean(await page.locator("header").textContent());
      assert.ok(
        headerText.includes(
          job.locale === "zh-CN" ? "未开放" : "Not public",
        ),
        "关闭态的页头必须显示中性的「未开放」",
      );
    } else if (job.state === "error") {
      // 先等首屏成功数据，再让下一次轮询失败。
      await page.waitForFunction(
        () => document.querySelectorAll("main h3").length === 8,
        undefined,
        { timeout: 15_000 },
      );
      failing = true;
      await page.clock.fastForward(20_500);
      await page.locator('[role="alert"]').waitFor({
        state: "visible",
        timeout: 15_000,
      });

      const mainText = clean(await page.locator("main").innerText());
      assert.ok(mainText.includes(expected.title), `失败态标题不符：${mainText}`);
      assert.match(mainText, expected.lastSuccess, "失败态必须显示上次成功时间");
      const retry = page.getByRole("button", { name: expected.retry });
      assert.equal(await retry.count(), 1, "失败态必须有且只有一个重试按钮");
      assert.equal(
        await page.locator('[role="status"]').count(),
        0,
        "失败态用 alert，不再叠一个 status",
      );
      assert.ok(failingCalls >= 1, "失败态必须真的经历过一次 5xx");
      // 页头仍然在，内容区被替换：主内容区不再有节点卡片。
      assert.equal(
        await page.locator('main [data-slot="card"] h3').count(),
        0,
        "5xx 时内容区应替换为错误态",
      );
      heroStats = null;
    }

    // 筛选后搜索框还带着焦点环；截图里不应该出现这圈临时状态。
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );

    // 状态切换后页面高度会变（例如 8 张卡片 → 一张错误面板），
    // 在截图前重新量一次，报告里的尺寸才是最终的。
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    assert.ok(
      metrics.scrollWidth <= metrics.clientWidth + 1,
      `状态切换后横向溢出 ${metrics.scrollWidth} > ${metrics.clientWidth}`,
    );

    await page.screenshot({
      path: job.out,
      fullPage: true,
      animations: "disabled",
    });

    const bytes = statSync(job.out).size;
    results.push({
      state: job.state,
      theme: job.theme,
      width: job.width,
      locale: job.locale,
      file: path.relative(HERE, job.out),
      scrollWidth: metrics.scrollWidth,
      scrollHeight: metrics.scrollHeight,
      kb: Math.round(bytes / 1024),
      heroStats,
    });
    console.log(
      `ok  ${path.basename(job.out).padEnd(32)} ${metrics.scrollWidth}×${metrics.scrollHeight}  ${Math.round(bytes / 1024)} KB`,
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
  `${JSON.stringify({ baseUrl: BASE_URL, results, failures }, null, 2)}\n`,
);

console.log(`\n${results.length} 张截图 → ${path.relative(process.cwd(), HERE) || "."}`);
if (failures.length > 0) {
  console.error(`\n${failures.length} 个任务失败：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
