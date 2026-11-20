// 修复证据采集：U1 四组合 / U2 英文 390 几何 / U3 无采样 vs 真实 0 /
// U4 焦点环对比度 / U5 触控尺寸。
//   MEFIX_TOKEN=... MEFIX_BASE=http://127.0.0.1:8795 \
//     node web/screenshots/me-fix/measure.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "/Users/jlthzy/Documents/mmrust/.npm-cache/_npx/e78b33305587cb7c/node_modules/playwright/index.mjs";

const BASE = process.env.MEFIX_BASE ?? "http://127.0.0.1:8795";
const TOKEN = process.env.MEFIX_TOKEN;
if (!TOKEN) throw new Error("missing MEFIX_TOKEN");
const OUT = "web/screenshots/me-fix";
mkdirSync(OUT, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const results = { base: BASE, captured_at: new Date().toISOString() };

async function open(
  path,
  { width = 1440, height = 1000, theme = "dark", locale = "zh-CN", routes = [] } = {},
) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  await context.addInitScript(
    ({ theme, locale }) => {
      localStorage.setItem("pierwave.theme", theme);
      localStorage.setItem("pierwave.locale", locale);
    },
    { theme, locale },
  );
  await context.addCookies([
    {
      name: "pierwave_session",
      value: TOKEN,
      url: BASE,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  for (const route of routes) await route(page);
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
  return { context, page };
}

/** 只拦截某个精确路径，保留后端响应，允许改 JSON。 */
async function patchJson(page, pathName, mutate) {
  await page.route(
    (url) => url.origin === BASE && url.pathname === pathName,
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      mutate(json);
      await route.fulfill({ response, json });
    },
  );
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: "disabled" });
  return `${OUT}/${name}.png`;
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

// ---------------------------------------------------------------------------
// U1：四种组合
// ---------------------------------------------------------------------------
async function u1() {
  const u1 = {};

  // A. limit = 0 且有存量：保留列表，只禁用新建，徽章改写。
  {
    const { context, page } = await open("/me/forwards", {
      width: 1440,
      theme: "dark",
      routes: [
        (p) =>
          patchJson(p, "/api/v1/me/forwards", (json) => {
            // 与审计同一形态：2 条真实存量 + limit = 0，展示「存量 2 条」。
            json.items = json.items.slice(0, 2);
            json.quota = { used: json.items.length, limit: 0 };
          }),
      ],
    });
    const card = page.locator('[data-slot="card"]').first();
    await card.waitFor();
    const text = await card.innerText();
    const add = card.getByRole("button", { name: "新建转发", exact: true });
    const disabled = await add.isDisabled();
    const rows = await card.locator("ul > li").count();
    await add.click({ force: true }).catch(() => {});
    const dialogCount = await page.locator('[role="dialog"]').count();
    const data = {
      visible_text: text.slice(0, 260),
      quota_badge: text.includes("存量 2 条"),
      has_bad_zero: /2\s*\/\s*0|0\s*\/\s*0/.test(text),
      add_disabled: disabled,
      rows,
      dialog_opened: dialogCount > 0,
      screenshot: await shot(page, "u1-a-stock-limit0-with-items"),
    };
    assert(data.quota_badge, "stock badge 存量 2 条");
    assert(!data.has_bad_zero, "no N / 0");
    assert(data.add_disabled, "stock add disabled");
    assert(data.rows === 2, "stock list keeps 2 rows");
    assert(!data.dialog_opened, "stock click must not open form");
    u1.stock = data;
    await context.close();
  }

  // B. limit = 0 且没有存量：不支持空态，隐藏新建，不能出现 0 / 0。
  {
    const { context, page } = await open("/me/forwards", {
      width: 390,
      theme: "light",
      routes: [
        (p) =>
          patchJson(p, "/api/v1/me/forwards", (json) => {
            json.items = [];
            json.quota = { used: 0, limit: 0 };
            json.servers = [];
            json.available_servers = [];
          }),
      ],
    });
    const card = page.locator('[data-slot="card"]').first();
    await card.waitFor();
    const text = await card.innerText();
    const addCount = await card
      .getByRole("button", { name: "新建转发", exact: true })
      .count();
    const data = {
      visible_text: text.slice(0, 260),
      unsupported: text.includes("当前套餐不支持自助转发"),
      has_bad_zero: /0\s*\/\s*0/.test(text),
      add_button_count: addCount,
      screenshot: await shot(page, "u1-b-unsupported-limit0-empty"),
    };
    assert(data.unsupported, "unsupported empty state");
    assert(!data.has_bad_zero, "no 0 / 0");
    assert(addCount === 0, "no create button when unsupported");
    u1.unsupported = data;
    await context.close();
  }

  // C. limit > 0 但没有授权服务器（预览库真实状态）：禁用 + 内联原因。
  {
    const { context, page } = await open("/me/forwards", {
      width: 1440,
      theme: "dark",
    });
    const card = page.locator('[data-slot="card"]').first();
    await card.waitFor();
    const text = await card.innerText();
    const add = card.getByRole("button", { name: "新建转发", exact: true });
    const disabled = await add.isDisabled();
    const describedBy = await add.getAttribute("aria-describedby");
    await add.click({ force: true }).catch(() => {});
    const dialogCount = await page.locator('[role="dialog"]').count();
    const data = {
      visible_text: text.slice(0, 260),
      inline_reason: text.includes("管理员尚未授权任何服务器"),
      add_disabled: disabled,
      aria_describedby: describedBy,
      reason_element: await page.locator("#my-forwards-create-reason").count(),
      dialog_opened: dialogCount > 0,
      screenshot: await shot(page, "u1-c-no-servers"),
    };
    assert(data.inline_reason, "inline no-server reason");
    assert(disabled, "no-server add disabled");
    assert(describedBy === "my-forwards-create-reason", "aria-describedby");
    assert(data.reason_element === 1, "reason element exists");
    assert(!data.dialog_opened, "no-server click must not open form");
    u1.noServers = data;
    await context.close();
  }

  // D. limit > 0 且授权了服务器：按钮可用，能打开表单。
  {
    const { context, page } = await open("/me/forwards", {
      width: 1440,
      theme: "dark",
      routes: [
        (p) =>
          patchJson(p, "/api/v1/me/summary", (json) => {
            json.forward_servers = [
              { id: "srv-hk-01", name: "香港-01" },
              { id: "srv-jp-01", name: "日本-01" },
            ];
          }),
        (p) =>
          patchJson(p, "/api/v1/me/forwards", (json) => {
            json.quota = { used: json.items.length, limit: 5 };
          }),
      ],
    });
    const card = page.locator('[data-slot="card"]').first();
    await card.waitFor();
    const text = await card.innerText();
    const add = card.getByRole("button", { name: "新建转发", exact: true });
    const enabled = await add.isEnabled();
    await add.click();
    await page.waitForTimeout(300);
    const dialog = page.locator('[role="dialog"]');
    const dialogVisible = await dialog.isVisible();
    const dialogText = dialogVisible ? (await dialog.innerText()).slice(0, 220) : "";
    const data = {
      visible_text: text.slice(0, 260),
      quota_with_unit: text.includes("3 / 5 条"),
      add_enabled: enabled,
      dialog_opened: dialogVisible,
      dialog_text: dialogText,
      screenshot: await shot(page, "u1-d-available-with-servers"),
    };
    assert(data.quota_with_unit, "3 / 5 条");
    assert(enabled, "add enabled");
    assert(dialogVisible, "form opens");
    assert(dialogText.includes("香港-01"), "server option rendered");
    u1.available = data;
    await context.close();
  }

  // E. MyChainsCard 复用同一个状态机：limit = 0 + 2 条存量同样保留列表。
  {
    const chain = (id, name) => ({
      id,
      name,
      template_id: null,
      template_name: "港日两跳",
      target_host: "10.0.0.8",
      target_port: 443,
      engine: "native",
      security: "tls",
      transport: "tcp",
      protocol: "tcp",
      enabled: true,
      entry_address: `203.0.113.7:${20000 + id}`,
      entry_server_id: null,
      entry_server_name: null,
      groups: [{ seq: 0, servers: [{ server_name: "香港-01" }] }],
      created_at: 1700000000,
      updated_at: 1700000000,
    });
    const { context, page } = await open("/me/forwards", {
      width: 1440,
      theme: "dark",
      routes: [
        (p) =>
          patchJson(p, "/api/v1/me/chains", (json) => {
            json.items = [chain(1, "香港 → 东京"), chain(2, "香港 → 大阪")];
            json.quota = { used: 2, limit: 0 };
          }),
      ],
    });
    const card = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "我的转发链" })
      .first();
    await card.waitFor();
    const text = await card.innerText();
    const add = card.getByRole("button", {
      name: "新建转发链",
      exact: true,
    });
    const disabled = await add.isDisabled();
    const rows = await card.locator("ul > li").count();
    await add.click({ force: true }).catch(() => {});
    const dialogCount = await page.locator('[role="dialog"]').count();
    const data = {
      visible_text: text.slice(0, 260),
      quota_badge: text.includes("存量 2 条"),
      has_bad_zero: /2\s*\/\s*0|0\s*\/\s*0/.test(text),
      add_disabled: disabled,
      rows,
      dialog_opened: dialogCount > 0,
      screenshot: await shot(page, "u1-e-chains-stock-limit0-with-items"),
    };
    assert(data.quota_badge, "chain stock badge 存量 2 条");
    assert(!data.has_bad_zero, "chain has no N / 0");
    assert(disabled, "chain add disabled");
    assert(rows === 2, "chain stock keeps 2 rows");
    assert(!data.dialog_opened, "chain click must not open form");
    u1.chainStock = data;
    await context.close();
  }

  return u1;
}

// ---------------------------------------------------------------------------
// U2：英文 390 几何
// ---------------------------------------------------------------------------
async function u2() {
  const { context, page } = await open("/me/forwards", {
    width: 390,
    height: 844,
    theme: "light",
    locale: "en",
  });
  await page.locator('[data-slot="card"]').first().waitFor();

  const geometry = await page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: +r.x.toFixed(1),
        y: +r.y.toFixed(1),
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
        right: +r.right.toFixed(1),
      };
    };
    const card = document.querySelector('[data-slot="card"]');
    const header = card?.querySelector('[data-slot="card-header"]');
    const title = card?.querySelector('[data-slot="card-title"]');
    const desc = card?.querySelector('[data-slot="card-description"]');
    const action = card?.querySelector('[data-slot="card-action"]');
    const refresh = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Refresh"),
    );
    const fade = document.querySelector('[data-slot="scroll-fade"]');
    const main = document.querySelector("main");
    const refreshRect = rect(refresh);
    return {
      refresh: refreshRect,
      refresh_right_gap: refreshRect
        ? +(main.getBoundingClientRect().right - 24 - refreshRect.right).toFixed(1)
        : null,
      title: rect(title),
      desc: rect(desc),
      action: rect(action),
      header: rect(header),
      action_below_title:
        !!(title && action) &&
        action.getBoundingClientRect().top >=
          title.getBoundingClientRect().bottom,
      title_full_width: title ? title.getBoundingClientRect().width : null,
      tabs: fade
        ? {
            scroll_width: fade.scrollWidth,
            client_width: fade.clientWidth,
            clipped_px: +(fade.scrollWidth - fade.clientWidth).toFixed(1),
            overflowing: fade.getAttribute("data-overflowing"),
            fade_right: fade.getAttribute("data-fade-right"),
            mask: getComputedStyle(fade).maskImage,
          }
        : null,
      screenshot: null,
    };
  });
  geometry.screenshot = await shot(page, "u2-en-390-forwards");

  assert(geometry.refresh_right_gap !== null, "refresh button found");
  assert(Math.abs(geometry.refresh_right_gap) <= 1.5, "refresh right aligned");
  assert(geometry.action_below_title, "action below title on <sm");
  assert(geometry.title_full_width > 300, "title keeps full width");
  assert(geometry.tabs?.overflowing === "true", "tabs overflow flagged");
  assert(geometry.tabs?.fade_right === "true", "right fade visible");
  assert(geometry.tabs?.mask?.includes("linear-gradient"), "mask applied");

  await context.close();
  return geometry;
}

// ---------------------------------------------------------------------------
// U3：无采样 vs 真实 0
// ---------------------------------------------------------------------------
async function u3() {
  const readKpis = async (page) =>
    page.evaluate(() => {
      const text = document.body.innerText;
      const valueByLabel = (label) => {
        const nodes = [...document.querySelectorAll("p")];
        const labelNode = nodes.find((p) => p.textContent?.trim() === label);
        return labelNode?.nextElementSibling?.textContent?.trim() ?? null;
      };
      const trafficCard = [...document.querySelectorAll('[data-slot="card"]')].find(
        (card) => card.textContent?.includes("近 7 天用量"),
      );
      const badge = trafficCard
        ? [...trafficCard.querySelectorAll("span")].find((s) =>
            /^7 天|^—$/.test(s.textContent?.trim() ?? ""),
          )?.textContent?.trim() ?? null
        : null;
      return {
        today: valueByLabel("今日用量"),
        daily_average: valueByLabel("近 7 天日均"),
        traffic_badge: badge,
        cumulative_zero: text.includes("累计 0 B"),
        chart_no_samples: text.includes("暂无采样"),
        has_zero_b: /\b0 B\b/.test(text),
        visible_text: text.slice(0, 420),
      };
    });

  // 无采样（预览库真实数据：7 天全 0）
  const noSamplesRun = await open("/me/overview", {
    width: 1440,
    theme: "dark",
  });
  await noSamplesRun.page.locator('[data-slot="card"]').first().waitFor();
  await noSamplesRun.page.waitForTimeout(400);
  const noSamples = await readKpis(noSamplesRun.page);
  noSamples.screenshot = await shot(
    noSamplesRun.page,
    "u3-a-no-samples-overview-1440-dark",
  );
  assert(noSamples.today === "—", `today should be —, got ${noSamples.today}`);
  assert(
    noSamples.daily_average === "—",
    `daily average should be —, got ${noSamples.daily_average}`,
  );
  assert(noSamples.traffic_badge === "—", "traffic total badge —");
  assert(!noSamples.cumulative_zero, "no 累计 0 B");
  assert(noSamples.chart_no_samples, "chart says 暂无采样");
  await noSamplesRun.context.close();

  // 有采样、今日真实 0：今日显示 0 B，总量 > 0，图表正常渲染
  const GB = 1024 ** 3;
  const realZeroRun = await open("/me/overview", {
    width: 1440,
    theme: "dark",
    routes: [
      (p) =>
        patchJson(p, "/api/v1/me/traffic", (json) => {
          const days = json.days;
          // 前 6 天各 1 GB，今天真实 0。
          days.forEach((day, index) => {
            const value = index === days.length - 1 ? 0 : GB;
            day.downlink = value;
            day.uplink = 0;
            day.weighted = value;
          });
        }),
    ],
  });
  await realZeroRun.page.locator('[data-slot="card"]').first().waitFor();
  await realZeroRun.page.waitForTimeout(500);
  const realZero = await readKpis(realZeroRun.page);
  realZero.screenshot = await shot(
    realZeroRun.page,
    "u3-b-real-zero-overview-1440-dark",
  );
  assert(realZero.today === "0 B", `today should be 0 B, got ${realZero.today}`);
  assert(
    realZero.traffic_badge && realZero.traffic_badge.includes("6 GB"),
    `total should be 6 GB, got ${realZero.traffic_badge}`,
  );
  await realZeroRun.context.close();

  return { noSamples, realZero };
}

// ---------------------------------------------------------------------------
// U4：焦点环实测对比度
// ---------------------------------------------------------------------------
async function measureFocus(theme) {
  const { context, page } = await open("/me/overview", {
    width: 1440,
    theme,
    locale: "zh-CN",
  });
  await page.locator('[data-slot="card"]').first().waitFor();
  // 用键盘走一遍：跳过链接 → 侧栏 → 页头刷新；找到刷新后测它的焦点环。
  let found = false;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      return (el.textContent ?? "").trim().slice(0, 20);
    });
    if (label === "刷新") {
      found = true;
      break;
    }
  }
  // 焦点环有 transition-all，等它稳定后再读，避免读到过渡中的 3px / 半透明值。
  await page.waitForTimeout(700);
  const measured = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const cs = getComputedStyle(el);
    // computed color 可能是 oklch/oklab/color-mix；用 canvas 统一转成 sRGB + alpha。
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const parse = (value) => {
      if (!value || value === "transparent") return [0, 0, 0, 0];
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    // 轮廓画在按钮外面（offset 2px），取它背后最近的不透明背景。
    const layers = [];
    let node = el.parentElement;
    while (node) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg[3] > 0) {
        layers.push(bg);
        if (bg[3] >= 1) break;
      }
      node = node.parentElement;
    }
    let base = [20, 20, 20, 1];
    for (let i = layers.length - 1; i >= 0; i--) {
      const [r, g, b, a] = layers[i];
      base = [
        r * a + base[0] * (1 - a),
        g * a + base[1] * (1 - a),
        b * a + base[2] * (1 - a),
        1,
      ];
    }
    const lum = ([r, g, b]) => {
      const f = (c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const outline = parse(cs.outlineColor);
    const l1 = lum(outline);
    const l2 = lum(base);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return {
      focus_visible: el.matches(":focus-visible"),
      outline_color: cs.outlineColor,
      outline_style: cs.outlineStyle,
      outline_width: cs.outlineWidth,
      outline_offset: cs.outlineOffset,
      background_rgb: base.map((v) => Math.round(v)).slice(0, 3),
      contrast_ratio: +ratio.toFixed(2),
    };
  });
  await context.close();
  return { found, ...measured };
}

async function u4() {
  const dark = await measureFocus("dark");
  const light = await measureFocus("light");
  assert(dark.found && light.found, "refresh button reachable with Tab");
  assert(dark.outline_style === "solid", "dark focus outline solid");
  assert(light.outline_style === "solid", "light focus outline solid");
  assert(dark.contrast_ratio >= 3, "dark focus contrast >= 3:1");
  assert(light.contrast_ratio >= 3, "light focus contrast >= 3:1");
  return { dark, light };
}

// ---------------------------------------------------------------------------
// U4b：skip link / 标题层级 / 侧栏 nav 标签
// ---------------------------------------------------------------------------
async function a11y() {
  const { context, page } = await open("/me/overview", {
    width: 1440,
    theme: "dark",
  });
  await page.locator('[data-slot="card"]').first().waitFor();

  await page.keyboard.press("Tab");
  const skip = await page.evaluate(() => {
    const el = document.activeElement;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      text: (el.textContent ?? "").trim(),
      href: el.getAttribute("href"),
      visible: r.width > 1 && r.height > 1,
      rect: {
        x: +r.x.toFixed(1),
        y: +r.y.toFixed(1),
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
      },
    };
  });
  await shot(page, "u4-skip-link-focused");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  const afterEnter = await page.evaluate(() => ({
    hash: location.hash,
    active: document.activeElement?.tagName,
    main_id: document.querySelector("main")?.id,
  }));
  const headings = await page.evaluate(() => ({
    h1: [...document.querySelectorAll("h1")].map((el) =>
      (el.textContent ?? "").trim(),
    ),
    h2: [...document.querySelectorAll("h2")].map((el) =>
      (el.textContent ?? "").trim().slice(0, 30),
    ),
  }));
  const navLabels = await page.evaluate(() =>
    [...document.querySelectorAll("nav")].map((nav) =>
      nav.getAttribute("aria-label"),
    ),
  );

  assert(skip.href === "#main-content", "skip link target");
  assert(skip.visible, "skip link visible when focused");
  assert(skip.text.length > 0, "skip link text");
  assert(afterEnter.hash === "#main-content", "skip link moves focus target");
  assert(headings.h1.length === 1, "exactly one h1");
  assert(headings.h2.length >= 1, "card titles are h2");
  assert(navLabels.includes("主导航"), "sidebar nav aria-label");

  await context.close();
  return { skip, afterEnter, headings, navLabels };
}

// ---------------------------------------------------------------------------
// U6：空态前提 / 套餐合并空态 / 英文数量单位 / 转发链模板措辞
// ---------------------------------------------------------------------------
async function u6() {
  const u6 = {};

  // active 套餐但 0 个可用节点：不能再说「套餐生效后节点会自动出现」。
  {
    const { context, page } = await open("/me/subscription", {
      width: 390,
      height: 1000,
      theme: "dark",
      routes: [
        (p) =>
          patchJson(p, "/api/v1/me/summary", (json) => {
            json.nodes = [];
            json.nodes_unavailable = 3;
          }),
      ],
    });
    const card = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "我的节点" })
      .first();
    await card.waitFor();
    const text = await card.innerText();
    const data = {
      visible_text: text.slice(0, 320),
      active_empty: text.includes("当前套餐没有可用节点"),
      wrong_premise: text.includes("套餐生效后节点会自动出现"),
      scope_hint: text.includes("请联系管理员检查套餐范围"),
      unavailable_count: text.includes("另有 3 个节点暂无法生成配置"),
      screenshot: await shot(page, "u6-nodes-active-zero"),
    };
    assert(data.active_empty, "active package empty copy");
    assert(!data.wrong_premise, "no wrong package premise");
    assert(data.scope_hint, "scope hint");
    assert(data.unavailable_count, "nodes_unavailable note");
    u6.nodesActiveZero = data;
    await context.close();
  }

  // 从未开通过套餐：只剩一张页面级空态，没有「暂无历史套餐」第二张空卡。
  {
    const { context, page } = await open("/me/packages", {
      width: 390,
      height: 1000,
      theme: "light",
      routes: [
        (p) =>
          patchJson(p, "/api/v1/me/summary", (json) => {
            json.packages = [];
          }),
      ],
    });
    await page.locator('[data-slot="card"]').first().waitFor();
    const text = await page.locator("main").innerText();
    const data = {
      visible_text: text.slice(0, 380),
      one_empty_state: (text.match(/还没有套餐/g) ?? []).length === 1,
      no_history_card: !text.includes("历史套餐"),
      cards: await page.locator('[data-slot="card"]').count(),
      screenshot: await shot(page, "u6-packages-page-empty"),
    };
    assert(data.one_empty_state, "single page-level empty state");
    assert(data.no_history_card, "history card hidden when never subscribed");
    u6.packagesEmpty = data;
    await context.close();
  }

  // 英文数量单位：1 package，不是 1 packages。
  {
    const { context, page } = await open("/me/packages", {
      width: 1440,
      theme: "light",
      locale: "en",
    });
    const card = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "Active packages" })
      .first();
    await card.waitFor();
    const text = await card.innerText();
    const data = {
      visible_text: text.slice(0, 220),
      singular: text.includes("1 package") && !text.includes("1 packages"),
      screenshot: await shot(page, "u6-en-packages-singular"),
    };
    assert(data.singular, "English package singular");
    u6.enPlural = data;
    await context.close();
  }

  // 链空态统一叫「转发链模板」。
  {
    const { context, page } = await open("/me/forwards", {
      width: 1440,
      theme: "dark",
      routes: [
        (p) =>
          patchJson(p, "/api/v1/me/chain-templates", (json) => {
            json.items = [];
            json.quota = { used: 0, limit: 1 };
          }),
      ],
    });
    const card = page
      .locator('[data-slot="card"]')
      .filter({ hasText: "我的转发链" })
      .first();
    await card.waitFor();
    const text = await card.innerText();
    const data = {
      visible_text: text.slice(0, 300),
      template_wording: text.includes("转发链模板"),
      no_template_empty: text.includes("当前套餐没有可用转发链模板"),
      screenshot: await shot(page, "u6-chain-template-wording"),
    };
    assert(data.template_wording, "转发链模板 wording");
    assert(data.no_template_empty, "chain no-template empty copy");
    u6.chainWording = data;
    await context.close();
  }

  return u6;
}

// ---------------------------------------------------------------------------
// U5：触控尺寸
// ---------------------------------------------------------------------------
async function u5() {
  const { context, page } = await open("/me/forwards", {
    width: 1440,
    theme: "dark",
  });
  await page.locator('[role="switch"]').first().waitFor();
  const hit = await page.evaluate(() => {
    const el = document.querySelector('[role="switch"]');
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hits = (dx, dy) => {
      const node = document.elementFromPoint(cx + dx, cy + dy);
      return !!node && (node === el || el.contains(node) || node.closest('[role="switch"]') === el);
    };
    // 以视觉中心为原点向两侧扫描，找到伪元素扩展后的真实命中矩形。
    let minX = 0;
    let maxX = 0;
    for (let d = -60; d <= 60; d += 1) {
      if (hits(d, 0)) {
        minX = Math.min(minX, d);
        maxX = Math.max(maxX, d);
      }
    }
    let minY = 0;
    let maxY = 0;
    for (let d = -60; d <= 60; d += 1) {
      if (hits(0, d)) {
        minY = Math.min(minY, d);
        maxY = Math.max(maxY, d);
      }
    }
    const pseudo = getComputedStyle(el, "::after");
    return {
      visual: { w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      hit: {
        w: +(maxX - minX + 1).toFixed(1),
        h: +(maxY - minY + 1).toFixed(1),
        extension_x: +(-minX - r.width / 2).toFixed(1),
        extension_y: +(-minY - r.height / 2).toFixed(1),
      },
      pseudo_inset: pseudo.inset,
    };
  });
  await shot(page, "u5-switch-hit-area");
  await context.close();

  const sub = await open("/me/subscription", { width: 1440, theme: "dark" });
  const select = await sub.page.evaluate(() => {
    const el = document.querySelector('[data-slot="select-trigger"]');
    const r = el.getBoundingClientRect();
    return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  });
  await shot(sub.page, "u5-subscription-format-40");
  await sub.context.close();

  assert(hit.hit.w >= 40, `switch hit width ${hit.hit.w}`);
  assert(hit.hit.h >= 40, `switch hit height ${hit.hit.h}`);
  assert(select.h >= 40, `format select height ${select.h}`);
  return { switch: hit, formatSelect: select };
}

// ---------------------------------------------------------------------------
try {
  results.u1 = await u1();
  results.u2 = await u2();
  results.u3 = await u3();
  results.u4 = await u4();
  results.a11y = await a11y();
  results.u6 = await u6();
  results.u5 = await u5();
  results.ok = true;
} catch (error) {
  results.ok = false;
  results.error = String(error?.stack ?? error);
} finally {
  writeFileSync(`${OUT}/after.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
if (!results.ok) process.exitCode = 1;
