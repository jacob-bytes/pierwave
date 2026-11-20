#!/usr/bin/env node
/**
 * 探针页 W1–W3 的截图与实测 / Screenshots and measurements for W1–W3.
 *
 * 覆盖 / Covers:
 *   W1  20 秒轮询、页签隐藏暂停、恢复可见立即补拉、总速率拆成 ↓/↑；
 *   W2  速率与累计前的小图标；
 *   W3  三列版式、到期与价格、三种到期状态、三种周期、字段缺失降级。
 *
 * 用法 / Usage:
 *   (cd web && npm run build && npx vite preview --port 4173 --strictPort)
 *   node web/screenshots/status-rates-billing/shots.mjs
 *
 * 输出 / Output:
 *   hero-rates-{theme}-{width}.png          W1 总速率上下行
 *   card-columns-{theme}-{width}.png        W2/W3 图标与三列
 *   card-{name}-{theme}-1440.png            单卡特写
 *   billing-missing-{theme}-{width}.png     字段缺失降级
 *   report.json                             断言、几何与轮询实测
 *
 * 数据由 Playwright 拦截 `GET /api/v1/public/status` 返回，不启动后端、不写库。
 * 环境变量：BASE_URL、PLAYWRIGHT_MODULE、CHROME_PATH。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:4173";
const THEMES = ["dark", "light"];
const WIDTHS = [
  { width: 1440, height: 1100 },
  { width: 390, height: 844 },
];
const HERO_LABEL = { "zh-CN": "服务概况", en: "Service overview" };
const TRAFFIC_GROUP = {
  "zh-CN": "速率、累计流量与到期价格",
  en: "Rate, total traffic, expiry and price",
};
const BILLING_GROUP = { "zh-CN": "到期与价格", en: "Expiry and price" };

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const TB = 1024 * GB;
const DAY_MS = 24 * 60 * 60 * 1_000;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1_000;

mkdirSync(HERE, { recursive: true });

/** 今天（UTC+8）+ N 天的 YYYY-MM-DD；到期口径与后端一致。 */
function utc8DateAfterDays(days) {
  const date = new Date(Date.now() + UTC8_OFFSET_MS + days * DAY_MS);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function hourlyBuckets(seed) {
  const now = Math.floor(Date.now() / 1_000);
  return Array.from({ length: 24 }, (_, index) => ({
    ts: now - (23 - index) * 3_600,
    online_ratio: (index + seed) % 11 === 0 ? 0.5 : 1,
  }));
}

/** 一台完整的公开状态页服务器；billing 传 null / 删字段即测降级。 */
function server({
  id,
  name,
  country = "HK",
  group = "亚太",
  seed = 1,
  rx = 17.5 * MB,
  tx = 2.19 * MB,
  rxTotal = 1.24 * TB,
  txTotal = 186 * GB,
  billing = {},
  online = true,
  load1 = 0.44,
}) {
  return {
    id,
    name,
    online,
    xray_running: true,
    load1,
    mem_used: 3.2 * GB,
    mem_total: 8 * GB,
    disk_used: 42.6 * GB,
    disk_total: 80 * GB,
    uptime_secs: 14 * 86_400,
    last_seen: Math.floor(Date.now() / 1_000) - 12,
    net_rx_bps: rx,
    net_tx_bps: tx,
    net_rx_bytes: rxTotal,
    net_tx_bytes: txTotal,
    latency_ms: 18,
    country_code: country,
    os_name: "Debian GNU/Linux",
    os_version: "12",
    virt: "kvm",
    arch: "x86_64",
    uptime_24h: 1,
    uptime_7d: 1,
    buckets_24h: hourlyBuckets(seed),
    group_name: group,
    ...billing,
  };
}

/** 主场景：三种到期状态 × 三种周期，四台都在线（总速率上下行都有值）。 */
function fullServers() {
  return [
    server({
      id: "srv-hk",
      name: "香港-亚太边缘入口",
      rx: 17.5 * MB,
      tx: 2.19 * MB,
      seed: 1,
      billing: {
        paid_until: utc8DateAfterDays(27),
        price_cents: 26800,
        currency: "CNY",
        billing_cycle: "monthly",
      },
    }),
    server({
      id: "srv-tokyo",
      name: "东京-中转备用入口",
      country: "JP",
      rx: 9.35 * MB,
      tx: 1.05 * MB,
      rxTotal: 684 * GB,
      txTotal: 92 * GB,
      seed: 2,
      billing: {
        paid_until: utc8DateAfterDays(120),
        price_cents: 99900,
        currency: "CNY",
        billing_cycle: "yearly",
      },
    }),
    server({
      id: "srv-sg",
      name: "新加坡-专线节点",
      country: "SG",
      rx: 5.91 * MB,
      tx: 980 * KB,
      rxTotal: 412 * GB,
      txTotal: 74 * GB,
      seed: 3,
      billing: {
        // 今天到期 → 「今天到期」，不写「0 天后」。
        paid_until: utc8DateAfterDays(0),
        price_cents: 19900,
        currency: "USD",
        billing_cycle: "once",
      },
    }),
    server({
      id: "srv-la",
      name: "洛杉矶-美洲测试节点",
      country: "US",
      group: "美洲",
      rx: 3.24 * MB,
      tx: 410 * KB,
      rxTotal: 96 * GB,
      txTotal: 12 * GB,
      seed: 4,
      // 未知币种 → 显示代码而不是猜符号。
      billing: {
        paid_until: utc8DateAfterDays(-3),
        price_cents: 128000,
        currency: "JPY",
        billing_cycle: "monthly",
      },
    }),
  ];
}

/** 降级场景：一张完整对照 + 四个「各缺一个字段」的卡片。 */
function missingServers() {
  const base = {
    paid_until: utc8DateAfterDays(27),
    price_cents: 26800,
    currency: "CNY",
    billing_cycle: "monthly",
  };
  const complete = (overrides) => ({ ...base, ...overrides });

  const cards = [
    ["srv-full", "完整字段（对照）", complete({})],
    ["srv-no-date", "缺 paid_until", complete({ paid_until: undefined })],
    ["srv-no-price", "缺 price_cents", complete({ price_cents: undefined })],
    ["srv-no-currency", "缺 currency", complete({ currency: undefined })],
    ["srv-no-cycle", "缺 billing_cycle", complete({ billing_cycle: undefined })],
    ["srv-null-cycle", "cycle 为 null", complete({ billing_cycle: null })],
  ];

  return cards.map(([id, name, billing], index) =>
    server({
      id,
      name,
      country: "US",
      group: "测试",
      seed: index + 1,
      rx: (10 + index) * MB,
      tx: (1 + index) * MB,
      billing,
    }),
  );
}

function statusFixture(servers) {
  return {
    panel_name: "PierWave · 亚太边缘",
    generated_at: Math.floor(Date.now() / 1_000),
    summary: {
      servers_total: servers.length,
      servers_online: servers.filter((s) => s.online).length,
      nodes_total: 32,
      traffic_today: 472 * GB,
      traffic_month: 2.92 * TB,
    },
    servers,
  };
}

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

const chromium = await loadPlaywright();
const executablePath = chromePath();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const results = [];
const failures = [];

/** 每次新建页面：固定主题 / 语言，拦截公开状态接口。 */
async function openPage({ theme, width, height, locale, fixture }) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  page.on("pageerror", (error) => failures.push(`${width}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      failures.push(`${width}: console ${message.text()}`);
    }
  });

  await page.addInitScript(
    ({ theme, locale }) => {
      window.localStorage.setItem("pierwave.theme", theme);
      window.localStorage.setItem("pierwave.locale", locale);
      // 可控的页签可见性：让 Playwright 能真正触发「隐藏 / 恢复可见」。
      let visibility = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => visibility === "hidden",
      });
      window.__setPageVisibility = (next) => {
        visibility = next;
        document.dispatchEvent(new Event("visibilitychange"));
      };
    },
    { theme, locale },
  );

  const requests = [];
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("/api/v1/public/status")) {
      requests.push(Date.now());
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixture()),
      });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: "{}",
    });
  });

  await page.goto(`${BASE_URL}/status`, { waitUntil: "load" });
  await page
    .locator(`[role="group"][aria-label="${HERO_LABEL[locale]}"]`)
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(
    () => document.querySelectorAll("main h3").length > 0,
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  return { page, requests };
}

/** 与 `lib/netRate.ts` 的 `rateParts` 同口径：数字优先，1024 进制，去掉多余零。 */
function rateParts(bps) {
  if (!Number.isFinite(bps) || bps < 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  if (bps < 1024) return { value: String(Math.round(bps)), unit: "B/s" };
  const exponent = Math.min(
    Math.floor(Math.log(bps) / Math.log(1024)),
    units.length - 1,
  );
  const scaled = bps / 1024 ** exponent;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const fixed = scaled.toFixed(digits);
  const value = fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
  return { value, unit: `${units[exponent]}/s` };
}

/** 在线机器上下行合计；用于核对 hero 的两个数字。 */
function expectedRateParts(servers) {
  const online = servers.filter((s) => s.online);
  const sum = (key) => online.reduce((total, s) => total + s[key], 0);
  return [rateParts(sum("net_rx_bps")), rateParts(sum("net_tx_bps"))];
}

async function cardMetrics(page, { locale }) {
  return page.evaluate(
    ({ trafficLabel, billingLabel }) => {
      const cards = Array.from(document.querySelectorAll("main h3")).map(
        (heading) => {
          const card = heading.closest('[data-slot="card"]');
          const traffic = card.querySelector(
            `[role="group"][aria-label="${trafficLabel}"]`,
          );
          const billing = traffic
            ? traffic.querySelector(`[role="group"][aria-label="${billingLabel}"]`)
            : null;
          const columns = traffic ? Array.from(traffic.children) : [];
          const rect = (el) => {
            const box = el.getBoundingClientRect();
            return { x: Math.round(box.x), width: Math.round(box.width) };
          };
          return {
            name: heading.textContent.trim(),
            text: (card.textContent ?? "").replace(/\s+/g, " ").trim(),
            cardWidth: Math.round(card.getBoundingClientRect().width),
            trafficIcons: traffic
              ? traffic.querySelectorAll("svg").length
              : 0,
            gridColumns: traffic
              ? getComputedStyle(traffic).gridTemplateColumns
                .split(" ")
                .filter(Boolean).length
              : 0,
            columns: columns.map(rect),
            billing: billing
              ? {
                  text: billing.innerText.replace(/\s+/g, " ").trim(),
                  width: Math.round(billing.getBoundingClientRect().width),
                  expiredWarning: Boolean(
                    billing.querySelector(".text-warning"),
                  ),
                  iconCount: billing.querySelectorAll("svg").length,
                }
              : null,
          };
        },
      );
      return {
        cards,
        overflow: {
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        },
      };
    },
    {
      trafficLabel: TRAFFIC_GROUP[locale],
      billingLabel: BILLING_GROUP[locale],
    },
  );
}

// ---------------------------------------------------------------- W1 / W2 / W3
for (const theme of THEMES) {
  for (const { width, height } of WIDTHS) {
    const servers = fullServers();
    const locale = "zh-CN";
    const { page } = await openPage({
      theme,
      width,
      height,
      locale,
      fixture: () => statusFixture(servers),
    });

    try {
      const hero = page.locator(
        `[role="group"][aria-label="${HERO_LABEL[locale]}"]`,
      );
      // W1：总速率必须是两个方向，而不是一个合计数。
      const rateStat = hero.locator("div.grid > div").nth(2);
      const label = (await rateStat.innerText()).replace(/\s+/g, " ").trim();
      const rateValues = (await rateStat.locator(".value-settle").allTextContents()).map(
        (text) => text.replace(/\s+/g, ""),
      );
      const [expectedRx, expectedTx] = expectedRateParts(servers);
      assert.ok(label.includes("当前总速率"), `缺少标签：${label}`);
      assert.deepEqual(
        rateValues,
        [
          `${expectedRx.value}${expectedRx.unit}`,
          `${expectedTx.value}${expectedTx.unit}`,
        ],
        `上下行合计不符：${rateValues.join(", ")}`,
      );
      assert.equal(
        await rateStat.locator("svg").count(),
        2,
        "总速率行应有 ↓ / ↑ 两个方向图标",
      );
      const rateText = `↓ ${expectedRx.value} ${expectedRx.unit}  ↑ ${expectedTx.value} ${expectedTx.unit}`;

      // 极轻过渡：只在数值变化时播 150ms，轮询同值时元素不重挂载。
      const settle = await rateStat.evaluate((node) => {
        const el = node.querySelector(".value-settle");
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          animationName: style.animationName,
          animationDuration: style.animationDuration,
          text: el.textContent,
        };
      });
      assert.equal(settle?.animationName, "value-settle", "缺少数值过渡");
      assert.equal(settle?.animationDuration, "0.15s", "过渡应为 150ms");

      await page.screenshot({
        path: path.join(HERE, `hero-rates-${theme}-${width}.png`),
        fullPage: true,
      });

      // W2 / W3：图标 + 三列 + 到期价格。
      const metrics = await cardMetrics(page, { locale });
      assert.ok(
        metrics.overflow.scrollWidth <= metrics.overflow.clientWidth + 1,
        `${width} 横向溢出 ${metrics.overflow.scrollWidth} > ${metrics.overflow.clientWidth}`,
      );
      const expectedColumns = width >= 768 ? 3 : 2;
      for (const card of metrics.cards) {
        assert.equal(
          card.trafficIcons,
          6,
          `${card.name} 的流量区应有 6 个图标（速率 2 + 累计 2 + 到期价格 2）`,
        );
        assert.equal(
          card.gridColumns,
          expectedColumns,
          `${card.name} 在 ${width} 下应是 ${expectedColumns} 列，实际 ${card.gridColumns}`,
        );
        assert.ok(card.billing, `${card.name} 缺少到期与价格组`);
        assert.equal(card.billing.iconCount, 2, `${card.name} 账期图标数不对`);
      }

      // 三种到期状态 + 三种周期。
      const [hk, tokyo, sg, la] = metrics.cards;
      assert.ok(hk.text.includes("27 天后到期"), `未来到期：${hk.text}`);
      assert.ok(hk.text.includes("¥268.00 / 月"), `月付价格：${hk.text}`);
      assert.ok(tokyo.text.includes("120 天后到期"), `年付到期：${tokyo.text}`);
      assert.ok(tokyo.text.includes("¥999.00 / 年"), `年付价格：${tokyo.text}`);
      assert.ok(sg.text.includes("今天到期"), `今天到期：${sg.text}`);
      assert.ok(sg.text.includes("$199.00 / 一次性"), `一次性价格：${sg.text}`);
      assert.ok(la.text.includes("已过期"), `已过期文案：${la.text}`);
      assert.ok(la.text.includes("JPY 1,280.00 / 月"), `未知币种代码：${la.text}`);
      assert.equal(la.billing.expiredWarning, true, "已过期应使用 warning 色");

      // 390 下账期组整组换行，宽度等于流量区内容宽，不挤压前两列。
      if (width < 768) {
        const [rateCol, totalCol, billingCol] = la.columns;
        assert.equal(
          billingCol.width,
          rateCol.width + totalCol.width + 16,
          `390 下账期组应横跨两列：${JSON.stringify(la.columns)}`,
        );
        assert.equal(billingCol.x, rateCol.x, "390 下账期组应从第一列开始");
      }

      await page.screenshot({
        path: path.join(HERE, `card-columns-${theme}-${width}.png`),
        fullPage: true,
      });

      // 单卡特写：图标与三列看得更清楚。
      const firstCard = page
        .locator("main h3")
        .first()
        .locator("xpath=ancestor::*[@data-slot='card'][1]");
      await firstCard.screenshot({
        path: path.join(HERE, `card-hk-${theme}-${width}.png`),
      });

      results.push({
        section: "w1-w3",
        theme,
        width,
        rateText,
        settle,
        overflow: metrics.overflow,
        cards: metrics.cards.map((card) => ({
          name: card.name,
          billing: card.billing,
          gridColumns: card.gridColumns,
          trafficIcons: card.trafficIcons,
        })),
      });
    } finally {
      await page.close();
    }
  }
}

// -------------------------------------------------- 字段缺失整组不显示（降级）
for (const theme of THEMES) {
  for (const { width, height } of WIDTHS) {
    const locale = "zh-CN";
    const servers = missingServers();
    const { page } = await openPage({
      theme,
      width,
      height,
      locale,
      fixture: () => statusFixture(servers),
    });
    try {
      const metrics = await cardMetrics(page, { locale });
      assert.ok(
        metrics.overflow.scrollWidth <= metrics.overflow.clientWidth + 1,
        `${width} 横向溢出`,
      );
      assert.ok(metrics.cards[0].billing, "对照组必须有账期组");
      for (const card of metrics.cards.slice(1)) {
        assert.equal(
          card.billing,
          null,
          `${card.name} 缺字段时不应渲染账期组`,
        );
        // 整组不显示，也不能出现「— / —」占位。
        assert.ok(
          !/—\s*\/\s*—/.test(card.text),
          `${card.name} 不应出现 — / — 占位：${card.text}`,
        );
      }
      await page.screenshot({
        path: path.join(HERE, `billing-missing-${theme}-${width}.png`),
        fullPage: true,
      });
      results.push({
        section: "billing-missing",
        theme,
        width,
        cards: metrics.cards.map((card) => ({
          name: card.name,
          billing: card.billing,
        })),
      });
    } finally {
      await page.close();
    }
  }
}

// ------------------------------------------------------------------- 轮询实测
{
  const locale = "zh-CN";
  const servers = fullServers();
  const { page, requests } = await openPage({
    theme: "dark",
    width: 1440,
    height: 1000,
    locale,
    fixture: () => statusFixture(servers),
  });

  try {
    const wait = (ms) => page.waitForTimeout(ms);
    const headerText = async () =>
      (await page.locator("header").innerText()).replace(/\s+/g, " ").trim();
    const rateValues = async () =>
      (
        await page
          .locator(`[role="group"][aria-label="${HERO_LABEL[locale]}"]`)
          .locator(".value-settle")
          .allTextContents()
      ).map((text) => text.replace(/\s+/g, ""));

    // 标记当前速率节点：同值轮询不重挂载，标记应当活下来。
    await page.evaluate(() => {
      const el = document.querySelector(".value-settle");
      if (el) el.dataset.probe = "stable";
    });
    const initial = requests.length;
    assert.equal(initial, 1, "首屏只应请求一次");
    const headerBefore = await headerText();
    assert.match(headerBefore, /更新于 \d{2}:\d{2}:\d{2}/, "页头缺少「更新于」");

    // 20 秒轮询：等 21 秒，必须有第二次请求，且「更新于」跟着变。
    await wait(21_000);
    const afterFirstPoll = requests.length;
    assert.ok(afterFirstPoll >= 2, `21 秒内没有轮询：${afterFirstPoll}`);
    const headerAfter = await headerText();
    assert.notEqual(
      headerAfter,
      headerBefore,
      "「更新于 HH:MM:SS」没有随轮询更新",
    );
    assert.match(headerAfter, /更新于 \d{2}:\d{2}:\d{2}/);
    const markerStillThere = await page.evaluate(
      () => document.querySelector(".value-settle")?.dataset.probe === "stable",
    );
    assert.equal(
      markerStillThere,
      true,
      "同值轮询不应重挂载速率节点（否则每 20 秒闪一下）",
    );

    // 隐藏页签：再等 21 秒，请求数必须不再增长。
    await page.evaluate(() => window.__setPageVisibility("hidden"));
    const hiddenStart = requests.length;
    await wait(21_000);
    const hiddenEnd = requests.length;
    assert.equal(hiddenEnd, hiddenStart, `隐藏时仍在轮询：${hiddenEnd - hiddenStart}`);

    // 恢复可见：立即补拉一次，不等下一个 20 秒。
    const visibleStart = requests.length;
    const visibleAt = Date.now();
    await page.evaluate(() => window.__setPageVisibility("visible"));
    // 请求在 node 侧计数；最多等 3 秒。
    const deadline = Date.now() + 3_000;
    while (requests.length <= visibleStart && Date.now() < deadline) {
      await wait(50);
    }
    const visibleDelay = Date.now() - visibleAt;
    assert.ok(
      requests.length > visibleStart,
      "恢复可见后没有立即补拉",
    );
    assert.ok(visibleDelay < 2_000, `恢复可见补拉太慢：${visibleDelay}ms`);

    // 数值真的变化时才重挂载（并重播 150ms 过渡）。
    const before = (await rateValues()).join(" ");
    servers[0].net_rx_bps += 5 * MB;
    // 切一次可见性，强制立刻拉取新值，不等下一个 20 秒。
    await page.evaluate(() => {
      window.__setPageVisibility("hidden");
      window.__setPageVisibility("visible");
    });
    const changedDeadline = Date.now() + 5_000;
    while ((await rateValues()).join(" ") === before && Date.now() < changedDeadline) {
      await wait(100);
    }
    const after = (await rateValues()).join(" ");
    const markerAfterChange = await page.evaluate(
      () => document.querySelector(".value-settle")?.dataset.probe === "stable",
    );
    assert.notEqual(after, before, "数值变化后文本应更新");
    assert.equal(markerAfterChange, false, "数值变化应重挂载并重播过渡");

    results.push({
      section: "polling",
      pollIntervalMs: 20_000,
      initialRequests: initial,
      requestsAfter21s: afterFirstPoll,
      hiddenWindowMs: 21_000,
      requestsWhileHidden: hiddenEnd - hiddenStart,
      visibleRefetchMs: visibleDelay,
      sameValueRemount: markerStillThere,
      changedValueRemount: markerAfterChange,
      rateBefore: before,
      rateAfter: after,
    });
  } finally {
    await page.close();
  }
}

await browser.close();

const overflow = results
  .filter((item) => item.overflow)
  .filter(
    (item) => item.overflow.scrollWidth > item.overflow.clientWidth + 1,
  );
assert.equal(overflow.length, 0, "存在横向溢出");
assert.equal(failures.length, 0, `页面错误：${failures.join(" | ")}`);

const report = {
  baseUrl: BASE_URL,
  generatedAt: new Date().toISOString(),
  results,
};
writeFileSync(path.join(HERE, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

console.log(`截图与断言完成：${results.length} 组结果 → ${HERE}`);
console.log(
  `轮询：21s 内 ${results.at(-1).requestsAfter21s} 次请求，隐藏 21s 内 ${results.at(-1).requestsWhileHidden} 次，恢复可见 ${results.at(-1).visibleRefetchMs}ms 内补拉`,
);
