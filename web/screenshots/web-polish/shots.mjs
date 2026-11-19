// 六项 UI 整改的改前 / 改后实测。
//
// 用法 / Usage:
//   node web/screenshots/web-polish/shots.mjs before
//   node web/screenshots/web-polish/shots.mjs after
//
// 前置：master 在 127.0.0.1:8787（data/web-polish.db，admin/devpass），
// vite dev 在 127.0.0.1:5173。数据由 seed.mjs 写入。
//
// Prerequisites: master on 127.0.0.1:8787 (data/web-polish.db, admin/devpass)
// and vite dev on 127.0.0.1:5173. Seed data comes from seed.mjs.
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const PHASE = process.argv[2] ?? "after";
const BASE = process.env.PREVIEW_BASE ?? "http://127.0.0.1:5173";
const OUT = `web/screenshots/web-polish/${PHASE}`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const METRICS = {};

mkdirSync(OUT, { recursive: true });

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`ok - ${message}`);
}

function fakeTrafficDays() {
  const start = new Date(`${new Date(NOW * 1_000).toISOString().slice(0, 10)}T00:00:00Z`);
  const days = [];
  for (let index = 6; index >= 0; index -= 1) {
    const date = new Date(start.getTime() - index * DAY * 1_000);
    const downlink = (46 + index * 7) * 1024 ** 3;
    const uplink = (9 + index * 2.4) * 1024 ** 3;
    days.push({
      date: date.toISOString().slice(0, 10),
      downlink: Math.round(downlink),
      uplink: Math.round(uplink),
      weighted: Math.round((downlink + uplink) * 1.1),
    });
  }
  return days;
}

const TRAFFIC = { days: fakeTrafficDays() };

async function cookieFor(username, password) {
  const res = await fetch(
    `${process.env.PREVIEW_API ?? "http://127.0.0.1:8787"}/api/v1/auth/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
  );
  if (!res.ok) throw new Error(`login ${username} failed: ${res.status}`);
  const cookie = res.headers
    .getSetCookie()
    .map((item) => item.split(";")[0])
    .find((item) => item.startsWith("pierwave_session="));
  if (!cookie) throw new Error("no session cookie");
  const [name, value] = cookie.split("=");
  return { name, value };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const cookie = await cookieFor("admin", "devpass");

async function newContext({ theme = "light", width = 1440, height = 900, auth = true, routes = [] } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  if (auth) {
    await context.addCookies([
      {
        name: cookie.name,
        value: cookie.value,
        url: BASE,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  }
  await context.addInitScript(
    ({ theme }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", "zh-CN");
    },
    { theme },
  );
  for (const route of routes) {
    await context.route(route.match, route.handler);
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`pageerror: ${error}`));
  return { context, page };
}

async function shoot(page, name, { fullPage = true } = {}) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path, fullPage });
  console.log(`saved ${path}`);
}

async function shootLogin(theme, width, height) {
  const { context, page } = await newContext({ theme, width, height, auth: false });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.locator("#login-username").waitFor();
  await page.waitForTimeout(350);
  await shoot(page, `login-${theme}-${width}`);
  if (PHASE === "after") {
    const probe = await page.evaluate(() => {
      const glow = document.querySelector(".auth-glow");
      const glowStyle = glow ? getComputedStyle(glow) : null;
      const glowRect = glow?.getBoundingClientRect() ?? null;
      const parentStyle = glow?.parentElement
        ? getComputedStyle(glow.parentElement)
        : null;
      const body = getComputedStyle(document.body);
      return {
        glowPresent: Boolean(glow),
        brandGlowPresent: Boolean(document.querySelector(".auth-brand-glow")),
        glowWidth: glowRect ? Math.round(glowRect.width) : null,
        glowHeight: glowRect ? Math.round(glowRect.height) : null,
        glowTop: glowRect ? Math.round(glowRect.top) : null,
        glowLeft: glowRect ? Math.round(glowRect.left) : null,
        glowCoversViewport:
          Boolean(glowRect) &&
          glowRect.width >= window.innerWidth &&
          glowRect.height >= window.innerHeight &&
          glowRect.top <= 0 &&
          glowRect.left <= 0,
        glowBackground: glowStyle?.backgroundImage ?? null,
        // 页面容器 = 覆盖整屏的 `.auth-glow` 层：它的 background-image 必须是
        // radial-gradient，而不是上一轮「只剩品牌小圆」时的 none。
        pageBackground: glowStyle?.backgroundImage ?? null,
        parentBackground: parentStyle?.backgroundImage ?? null,
        bodyBackground: body.backgroundImage,
        pointerEvents: glowStyle?.pointerEvents ?? null,
        ariaHidden: glow?.getAttribute("aria-hidden") ?? null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    });
    METRICS.login = METRICS.login ?? {};
    METRICS.login[`${theme}-${width}`] = probe;
    if (theme === "light" && width === 1440) {
      assert(probe.glowPresent, "登录页存在整屏光晕 .auth-glow");
      assert(!probe.brandGlowPresent, "只保留一层整屏光晕，无品牌小光晕");
      assert(
        probe.glowCoversViewport,
        `整屏光晕覆盖视口（${probe.glowWidth}×${probe.glowHeight} vs ${probe.viewport.width}×${probe.viewport.height}）`,
      );
      assert(
        (probe.glowBackground ?? "").includes("radial-gradient"),
        "整屏光晕使用 radial-gradient",
      );
      assert(probe.pageBackground !== "none", "页面容器 background-image 非 none");
      assert(probe.pointerEvents === "none", "光晕不拦截交互");
      assert(probe.ariaHidden === "true", "光晕对读屏隐藏");
      assert(probe.bodyBackground === "none", "body 无渐变");
    }
  }
  await context.close();
}

function emptyRoutes() {
  const json = (body) => async (route) => {
    if (route.request().method() !== "GET") {
      return route.continue();
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  };
  return [
    { match: "**/api/v1/servers", handler: json({ items: [] }) },
    { match: "**/api/v1/packages", handler: json({ items: [] }) },
    {
      match: "**/api/v1/chains",
      handler: json({ availability_threshold_percent: 99, items: [] }),
    },
    { match: "**/api/v1/chain-templates", handler: json({ items: [] }) },
    { match: "**/api/v1/subscription-templates", handler: json({ items: [] }) },
  ];
}

async function shootEmptyStates(theme, width) {
  const { context, page } = await newContext({ theme, width, routes: emptyRoutes() });
  const pages = [
    ["servers", "/servers", "还没有服务器", "添加服务器", "添加服务器"],
    ["packages", "/packages", "还没有套餐模板", "新建套餐", "新建套餐"],
    ["chains", "/chains", "还没有转发链", "新建第一条转发链", "新建转发链"],
    ["chain-templates", "/chain-templates", "还没有链模板", "新建第一个模板", "新建模板"],
    [
      "subscription-templates",
      "/settings?tab=subscription-templates",
      "还没有订阅模板",
      "新建订阅模板",
      "新建订阅模板",
    ],
  ];

  const results = {};
  for (const [slug, path, emptyTitle, emptyAction, headerAction] of pages) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.getByText(emptyTitle, { exact: true }).first().waitFor();
    await page.waitForTimeout(300);
    await shoot(page, `empty-${slug}-${theme}-${width}`);
    const buttons = [
      ...(await page.getByRole("button", { name: emptyAction, exact: true }).all()),
      ...(headerAction === emptyAction
        ? []
        : await page.getByRole("button", { name: headerAction, exact: true }).all()),
    ];
    const visible = [];
    for (const button of buttons) {
      if (await button.isVisible()) visible.push(await button.getAttribute("class"));
    }
    results[slug] = {
      visibleActionButtons: visible.length,
      hasPrimary: visible.some((className) => (className ?? "").includes("bg-primary")),
    };
  }
  METRICS.empty = results;
  if (PHASE === "after" && theme === "light" && width === 1440) {
    for (const [slug, value] of Object.entries(results)) {
      assert(value.visibleActionButtons === 1, `${slug} 空库只剩一个主操作`);
      assert(value.hasPrimary, `${slug} 空态主操作是 primary`);
    }
  }
  await context.close();
}

async function shootDataStates(theme, width) {
  const { context, page } = await newContext({ theme, width });
  await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
  await page.getByText("hk-1", { exact: true }).first().waitFor();
  await page.waitForTimeout(300);
  await shoot(page, `data-servers-${theme}-${width}`);
  await page.goto(`${BASE}/packages`, { waitUntil: "networkidle" });
  await page.getByText("标准版", { exact: true }).first().waitFor();
  await page.waitForTimeout(300);
  await shoot(page, `data-packages-${theme}-${width}`);
  await context.close();
}

async function shootServersSkeleton(theme, width) {
  const delay = async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    return route.continue();
  };
  const { context, page } = await newContext({
    theme,
    width,
    routes: [{ match: "**/api/v1/servers", handler: delay }],
  });
  await page.goto(`${BASE}/servers`, { waitUntil: "domcontentloaded" });
  if (width > 1024) {
    await page.locator("table").first().waitFor();
  } else {
    await page.getByText("服务器列表", { exact: true }).waitFor();
  }
  await page.waitForTimeout(600);
  await shoot(page, `skeleton-servers-${theme}-${width}`);

  const measure = () =>
    page.evaluate(() => {
      const tables = [...document.querySelectorAll("table")];
      const table =
        tables.find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }) ?? tables[0];
      const row = table?.querySelector("thead tr");
      const cells = row ? [...row.children] : [];
      const visible = cells.filter((cell) => {
        const rect = cell.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return {
        columns: cells.length,
        visible: visible.length,
        widths: visible.map((cell) => Math.round(cell.getBoundingClientRect().width)),
        filter: document.querySelector('[aria-label="按分组筛选服务器"]')?.disabled ?? null,
        filterPresent: Boolean(document.querySelector('[aria-label="按分组筛选服务器"]')),
      };
    });
  const loading = await measure();

  await page.getByText("hk-1", { exact: true }).first().waitFor();
  await page.waitForTimeout(300);
  await shoot(page, `real-servers-${theme}-${width}`);
  const real = await measure();

  const key = `${theme}-${width}`;
  METRICS.serversSkeleton = METRICS.serversSkeleton ?? {};
  METRICS.serversSkeleton[key] = { loading, real };
  if (PHASE === "after" && theme === "light" && width === 1440) {
    assert(loading.columns === real.columns, `骨架列数 ${loading.columns} == 真实列数 ${real.columns}`);
    assert(loading.visible === real.visible, `骨架可见列数 ${loading.visible} == 真实可见列数 ${real.visible}`);
    assert(loading.filterPresent, "骨架阶段已渲染分组筛选");
    assert(loading.filter === true, "骨架阶段分组筛选为禁用态");
  }
  await context.close();
}

async function shootOverview(theme, width) {
  const routes = [
    {
      match: "**/api/v1/stats/traffic**",
      handler: (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(TRAFFIC),
        }),
    },
  ];
  const { context, page } = await newContext({ theme, width, routes });
  await page.goto(`${BASE}/overview`, { waitUntil: "networkidle" });
  await page.getByText("近 7 天趋势", { exact: true }).waitFor();
  await page.waitForTimeout(800);
  await shoot(page, `overview-${theme}-${width}`);

  const chartCard = page
    .getByText("近 7 天趋势", { exact: true })
    .locator("xpath=ancestor::*[@data-slot='card'][1]");
  const box = await chartCard.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width * 0.64, box.y + box.height * 0.62);
    await page.waitForTimeout(450);
    await chartCard.screenshot({ path: `${OUT}/overview-tooltip-${theme}-${width}.png` });
    console.log(`saved ${OUT}/overview-tooltip-${theme}-${width}.png`);
  }

  const probe = await page.evaluate(() => {
    const axes = [...document.querySelectorAll(".recharts-yAxis")];
    const text = document.body.innerText;
    return {
      yAxes: axes.length,
      rightAxisTicks: [...document.querySelectorAll(".recharts-yAxis")].filter(
        (axis) => axis.getAttribute("orientation") === "right",
      ).length,
      hasVerticalCumulativeLabel: text.includes("累计（GB）") || text.includes("累计（TB）"),
      hasLegendChip:
        [...document.querySelectorAll("span")].some(
          (node) =>
            node.textContent?.includes("累计") &&
            /(?:B|KB|MB|GB|TB)/.test(node.textContent ?? "") &&
            !node.textContent.includes("计费"),
        ),
    };
  });
  METRICS.overview = METRICS.overview ?? {};
  METRICS.overview[`${theme}-${width}`] = probe;
  if (PHASE === "after" && theme === "light" && width === 1440) {
    assert(probe.yAxes === 1, "只剩一个 Y 轴");
    assert(probe.rightAxisTicks === 0, "右 Y 轴已移除");
    assert(!probe.hasVerticalCumulativeLabel, "竖排累计标签已移除");
    assert(probe.hasLegendChip, "图例 chip 显示累计末值");
  }
  await context.close();
}

async function shootUsers(theme, width) {
  const { context, page } = await newContext({ theme, width });
  await page.goto(`${BASE}/users`, { waitUntil: "networkidle" });
  await page.getByText("alice", { exact: true }).first().waitFor();
  await page.waitForTimeout(300);
  await shoot(page, `users-${theme}-${width}`);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("tbody tr")].map((row) => {
      const cells = [...row.querySelectorAll("td")];
      const created = cells[5];
      return {
        username:
          cells[0]?.querySelector(".font-medium")?.textContent?.trim() ??
          cells[0]?.innerText.split("\n")[0]?.trim(),
        text: created?.innerText.trim(),
        title: created?.querySelector("[title]")?.getAttribute("title") ?? null,
      };
    }),
  );
  METRICS.users = METRICS.users ?? {};
  METRICS.users[`${theme}-${width}`] = rows;
  if (PHASE === "after" && theme === "light" && width === 1440) {
    const byName = Object.fromEntries(rows.map((row) => [row.username, row]));
    assert(byName.alice?.text.includes("个月前"), "45 天前显示相对月份");
    assert(byName.bob?.text.includes("小时前"), "2 小时前显示相对小时");
    assert(byName.dave?.text.includes("分钟前"), "5 分钟前显示相对分钟");
    assert(!/^\d{4}-\d{2}-\d{2}$/.test(byName.alice?.text ?? ""), "不再直接显示日期");
    assert(byName.alice?.title?.includes("2026-"), "title 保留绝对时间");
  }
  await context.close();
}

async function shootSettingsSecretError(theme, width) {
  const brokenKeys = ["telegram_bot_token", "backup_webdav_password"];
  const routes = [
    {
      match: "**/api/v1/settings",
      handler: async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        // 新后端始终 200：先取真实 items，再把坏掉的秘密字段置空并加上顶层
        // secret_errors，模拟「主密钥不匹配但仍能读出其它设置」。
        const response = await route.fetch();
        const payload = await response.json();
        const items = { ...(payload.items ?? {}) };
        items.telegram_bot_token = "";
        items.telegram_bot_has_token = false;
        items.webhook_url = "";
        items.backup_webdav_password = "";
        items.backup_webdav_has_password = false;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            items,
            secret_errors: { keys: brokenKeys },
          }),
        });
      },
    },
  ];
  const { context, page } = await newContext({ theme, width, routes });
  await page.goto(`${BASE}/settings?tab=general`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await shoot(page, `settings-secret-error-${theme}-${width}`);

  const probe = await page.evaluate(() => ({
    text: document.body.innerText,
    hasReenter: [...document.querySelectorAll("button")].some((button) =>
      button.textContent?.includes("重新填写"),
    ),
  }));
  METRICS.settingsSecret = METRICS.settingsSecret ?? {};
  METRICS.settingsSecret[`${theme}-${width}`] = probe;
  if (PHASE === "after" && theme === "light" && width === 1440) {
    assert(probe.text.includes("无法解密"), "页面显示专用秘密解密提示");
    assert(probe.text.includes("Telegram Bot Token"), "列出无法解密的秘密");
    assert(probe.text.includes("WebDAV 密码"), "列出第二个无法解密的秘密");
    assert(probe.hasReenter, "提供「重新填写」入口");
    assert(probe.text.includes("重新填写"), "入口文案可读");
    const reenter = page.getByRole("button", { name: "重新填写", exact: true });
    await reenter.click();
    await page.waitForTimeout(250);
    await shoot(page, `settings-secret-error-form-${theme}-${width}`);
    const form = await page.evaluate(() => ({
      token: Boolean(document.querySelector('input[type="password"], #secret-telegram_bot_token')),
      password: Boolean(document.querySelector("#secret-backup_webdav_password")),
      saveDisabled: [...document.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("保存新值"),
      )?.disabled,
    }));
    METRICS.settingsSecretForm = form;
    assert(form.token, "重新填写表单包含 Telegram Token");
    assert(form.password, "重新填写表单包含 WebDAV 密码");
    assert(form.saveDisabled === true, "未填写时保存新值按钮禁用");

    // 填一个字段后主操作可用：表单是真正可覆盖的，不是只读展示。
    await page.locator("#secret-telegram_bot_token").fill("123456789:AA-new-token");
    const enabled = await page.evaluate(
      () =>
        [...document.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("保存新值"),
        )?.disabled,
    );
    assert(enabled === false, "填写新值后保存新值按钮可用");
    await page.locator("#secret-backup_webdav_password").fill("new-webdav-password");
    await shoot(page, `settings-secret-error-filled-${theme}-${width}`);
    METRICS.settingsSecretForm.filledSaveDisabled = enabled;
  }
  await context.close();
}

async function assertHealthySettingsHasNoRecoveryCard() {
  const { context, page } = await newContext({ theme: "light", width: 1440 });
  await page.goto(`${BASE}/settings?tab=general`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const cards = await page
    .locator('[data-slot="settings-secret-recovery"]')
    .count();
  const text = await page.locator("body").innerText();
  METRICS.healthySettings = {
    recoveryCards: cards,
    hasGenericLoadError: text.includes("设置加载失败"),
  };
  assert(cards === 0, "正常设置响应不显示恢复卡");
  assert(!text.includes("设置加载失败"), "正常设置响应不显示通用错误");
  await shoot(page, "settings-healthy-no-card-light-1440");
  await context.close();
}

// 1) 登录页：亮/暗 × 1440/390
for (const theme of ["light", "dark"]) {
  for (const width of [1440, 390]) {
    await shootLogin(theme, width, width === 390 ? 844 : 900);
  }
}

// 2) 概览双轴：亮 1440/390（暗色补 1440）
for (const [theme, width] of [
  ["light", 1440],
  ["light", 390],
  ["dark", 1440],
]) {
  await shootOverview(theme, width);
}

// 3) 空态 / 有数据：亮 1440，另补 390 与暗色
await shootEmptyStates("light", 1440);
await shootEmptyStates("dark", 1440);
await shootEmptyStates("light", 390);
await shootDataStates("light", 1440);
await shootDataStates("dark", 1440);
await shootDataStates("light", 390);

// 4) 表格骨架：亮 1440/390，暗色 1440
for (const [theme, width] of [
  ["light", 1440],
  ["light", 390],
  ["dark", 1440],
]) {
  await shootServersSkeleton(theme, width);
}

// 5) 时间展示：亮 1440/390，暗色 1440
for (const [theme, width] of [
  ["light", 1440],
  ["light", 390],
  ["dark", 1440],
]) {
  await shootUsers(theme, width);
}

// 6) 秘密损坏：亮 1440/390，暗色 1440
for (const [theme, width] of [
  ["light", 1440],
  ["light", 390],
  ["dark", 1440],
]) {
  await shootSettingsSecretError(theme, width);
}
await assertHealthySettingsHasNoRecoveryCard();

writeFileSync(`${OUT}/metrics.json`, `${JSON.stringify(METRICS, null, 2)}\n`);
console.log(`saved ${OUT}/metrics.json`);

await browser.close();
