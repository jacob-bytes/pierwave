#!/usr/bin/env node
/**
 * 「链路时延 → 转发模板详情」布局重排 + 节点热度浮层的验收截图与断言。
 * Acceptance screenshots and assertions for the template-detail layout and the
 * node-heat overlay.
 *
 * 验收点 / Checks:
 *   1. 使用量独占第一行，第二行「策略分布 | 节点热度」同排、各自自然高度；
 *      策略卡底部有摘要（最常用策略 + 链数），不靠空白撑高；
 *   2. 390 三卡单列（使用量 → 策略分布 → 节点热度）；
 *   3. 节点热度明细浮层是绝对定位：hover 逐行前后卡片高度差 ≤1px，
 *      栅格高度不变（浮层不占文档流），浮层不越出卡片 / 弹窗；
 *   4. 贴底翻到行上方，键盘 focus 同样出现，Esc 只收起浮层；
 *   5. 无横向溢出，弹窗滚动区底部空白 ≤24px。
 *
 * 前置 / Prerequisite:
 *   cd web && npm run build                  # 主控直接读 web/dist
 *   PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
 *     PIERWAVE_DB='sqlite://data/preview.db?mode=rwc' ./target/debug/pierwave-master
 *
 * 用法 / Usage:
 *   node web/screenshots/node-heat-overlay/shots.mjs
 *
 * 输出 / Output:
 *   1440 / 390 × 亮暗：hover 前、hover 中、末行翻转、布局分段截图，
 *   外加一张多策略种类的摘要截图（仅拦截详情响应，列表仍走真实接口）；
 *   `report.json` 记录每项断言的期望值、实测高度与浮层几何。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const ADMIN = process.env.ADMIN_PASSWORD ?? "devpass";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const VIEWPORTS = [1440, 390];
const THEMES = /** @type {const} */ (["dark", "light"]);

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

/* ------------------------------------------------------------------ *
 * 登录 + 选一个有 5 个热点节点的模板（真实接口，不注入 mock）
 * ------------------------------------------------------------------ */

const loginResponse = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: ADMIN }),
});
assert.equal(
  loginResponse.status,
  200,
  "admin login failed — set ADMIN_PASSWORD to the preview DB's admin password",
);
const sessionCookie = loginResponse.headers
  .getSetCookie()
  .map((item) => item.split(";")[0])
  .find((item) => item.startsWith("pierwave_session="));
assert.ok(sessionCookie, "session cookie must exist");
const [cookieName, cookieValue] = sessionCookie.split("=");

const listResponse = await fetch(`${BASE}/api/v1/overview/chain-templates`, {
  headers: { Cookie: sessionCookie },
});
assert.equal(listResponse.status, 200, "chain-templates list must be 200");
const listPayload = await listResponse.json();
assert.ok(listPayload.items.length > 0, "preview DB must have chain templates");

/** 热度行 = 去重后的节点数；挑行数最多的模板，Top 5 列表才是满的。 */
let target = null;
for (const item of listPayload.items) {
  const detailResponse = await fetch(
    `${BASE}/api/v1/overview/chain-templates/${encodeURIComponent(item.id)}?hours=24`,
    { headers: { Cookie: sessionCookie } },
  );
  if (detailResponse.status !== 200) continue;
  const detail = await detailResponse.json();
  const identities = new Set(
    (detail.nodes ?? []).map((node) => node.server_id ?? node.name),
  );
  if (target === null || identities.size > target.rows) {
    target = { item, rows: identities.size };
  }
}
assert.ok(target !== null, "no template detail available");
assert.ok(target.rows >= 5, `need 5 heat rows, got ${target.rows}`);
const TEMPLATE = target.item;

/* ------------------------------------------------------------------ *
 * 断言 / 截图基础设施
 * ------------------------------------------------------------------ */

const results = [];
const failures = [];
const screenshots = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    failures.push(`${name}: ${error.message}`);
  }
}

async function newPage(browser, width, theme) {
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 1000 },
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
      url: BASE,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  return { context, page };
}

async function openDetail(page) {
  await page.goto(`${BASE}/?view=chain&section=templates`, {
    waitUntil: "networkidle",
  });
  await page
    .locator(`[data-chain-template-row][data-template-id="${TEMPLATE.id}"]`)
    .click();
  await page.locator("[data-template-detail]").waitFor();
  await page.locator("[data-template-heat-row]").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
}

/** 把节点热度卡滚到可见区（列表卡在最下面一行）。 */
async function scrollToHeat(page) {
  await page.locator("[data-template-node-heat-card]").evaluate((element) => {
    element.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
}

async function scrollToGrid(page) {
  await page.locator("[data-template-detail-grid]").evaluate((element) => {
    element.scrollIntoView({ block: "start" });
    element.parentElement?.parentElement?.scrollBy?.(0, -8);
  });
  await page.waitForTimeout(200);
}

const READ = () => {
  const rect = (element) => element?.getBoundingClientRect().toJSON() ?? null;
  const heat = document.querySelector("[data-template-node-heat-card]");
  const strategies = document.querySelector("[data-template-strategies-card]");
  const usage = document.querySelector("[data-template-usage-card]");
  const grid = document.querySelector("[data-template-detail-grid]");
  const scroll = document.querySelector("[data-template-dialog-scroll]");
  const dialog = document.querySelector("[data-template-dialog]");
  const tooltip = document.querySelector("[data-template-node-heat-tooltip]");
  const plot = usage?.querySelector(".recharts-responsive-container");
  const summary = document.querySelector("[data-template-strategies-summary]");
  const rows = [...document.querySelectorAll("[data-template-heat-row]")].map(
    (row) => ({
      key: row.dataset.heatKey ?? null,
      h: rect(row)?.height ?? null,
      top: rect(row)?.top ?? null,
      bottom: rect(row)?.bottom ?? null,
    }),
  );
  const scrollRect = rect(scroll);
  const lastContent = grid?.lastElementChild
    ? rect(grid.lastElementChild)
    : null;
  return {
    widths: { viewport: window.innerWidth },
    cards: {
      usage: rect(usage),
      strategies: rect(strategies),
      heat: rect(heat),
      grid: rect(grid),
      scroll: scrollRect,
      dialog: rect(dialog),
    },
    heights: {
      usage: usage?.getBoundingClientRect().height ?? null,
      strategies: strategies?.getBoundingClientRect().height ?? null,
      heat: heat?.getBoundingClientRect().height ?? null,
      grid: grid?.getBoundingClientRect().height ?? null,
      scrollClient: scroll?.clientHeight ?? null,
      scrollContent: scroll?.scrollHeight ?? null,
    },
    plotH: plot?.getBoundingClientRect().height ?? null,
    summary: summary
      ? {
          text: summary.textContent?.trim() ?? null,
          fontSize: getComputedStyle(summary).fontSize,
          rect: rect(summary),
        }
      : null,
    strategiesTrailing: (() => {
      // 卡片底边到内容底边的距离：自然高度应只剩卡片 / 内容内边距。
      const content = strategies?.querySelector('[data-slot="card-content"]');
      if (!strategies || !content) return null;
      const card = strategies.getBoundingClientRect();
      const last =
        summary?.getBoundingClientRect().bottom ??
        content.getBoundingClientRect().bottom;
      return Math.round((card.bottom - last) * 100) / 100;
    })(),
    tooltip: tooltip
      ? {
          rect: rect(tooltip),
          visible: getComputedStyle(tooltip).visibility === "visible",
          placement: tooltip.dataset.placement ?? null,
          clampedX: tooltip.dataset.clampedX === "true",
          clampedY: tooltip.dataset.clampedY === "true",
          text: tooltip.innerText?.trim() ?? null,
          pointerEvents: getComputedStyle(tooltip).pointerEvents,
          position: getComputedStyle(tooltip).position,
          withinCard: (() => {
            const a = tooltip.getBoundingClientRect();
            const b = heat.getBoundingClientRect();
            return (
              a.left >= b.left - 0.5 &&
              a.right <= b.right + 0.5 &&
              a.top >= b.top - 0.5 &&
              a.bottom <= b.bottom + 0.5
            );
          })(),
          withinScroll: (() => {
            const a = tooltip.getBoundingClientRect();
            const b = scroll.getBoundingClientRect();
            return (
              a.left >= b.left - 0.5 &&
              a.right <= b.right + 0.5 &&
              a.top >= b.top - 0.5 &&
              a.bottom <= b.bottom + 0.5
            );
          })(),
        }
      : null,
    rows,
    scrollTrailing:
      scrollRect !== null && lastContent !== null
        ? Math.round(
            (scroll.scrollHeight -
              (lastContent.bottom - scrollRect.top + scroll.scrollTop)) *
              100,
          ) / 100
        : null,
    docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    scrollOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : null,
  };
};

async function shoot(page, name) {
  const file = path.join(HERE, name);
  await page.screenshot({ path: file, animations: "disabled" });
  screenshots.push(path.relative(HERE, file));
  return path.relative(HERE, file);
}

/** 鼠标移到弹窗标题栏，保证离开所有热度行。 */
async function clearHover(page) {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(150);
}

const round = (value) => (typeof value === "number" ? Math.round(value * 100) / 100 : value);

/* ------------------------------------------------------------------ *
 * 1440 / 390 × 亮暗
 * ------------------------------------------------------------------ */

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

for (const width of VIEWPORTS) {
  for (const theme of THEMES) {
    const label = `${width}-${theme}`;
    const { context, page } = await newPage(browser, width, theme);
    await openDetail(page);
    await scrollToHeat(page);
    await clearHover(page);
    const before = await page.evaluate(READ);
    const beforeShot = await shoot(page, `hover-before-${label}.png`);

    await check(`layout ${label}: 三卡两行（使用量整行，策略 | 热度同排）`, () => {
      const { usage, strategies, heat, grid } = before.cards;
      assert.ok(usage && strategies && heat && grid, "all three cards must exist");
      assert.equal(before.rows.length, 5, "Top 5 heat rows");
      const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
      if (width === 1440) {
        assert.ok(near(usage.top, grid.top), "usage must start the first row");
        assert.ok(near(usage.width, grid.width), "usage must span the full row");
        assert.ok(near(strategies.top, heat.top), "strategies | heat share row 2");
        assert.ok(near(strategies.width, heat.width), "row 2 cards must be equal width");
        // 自然高度：不再强制底边对齐，策略卡比热度卡短是允许的。
        assert.ok(
          strategies.bottom <= heat.bottom + 0.5,
          "strategies card must not be taller than the heat card",
        );
        assert.ok(usage.bottom < strategies.top, "row 2 must start below usage");
        assert.ok(near(strategies.left, grid.left), "strategies left aligned to grid");
        assert.ok(near(heat.right, grid.right), "heat right aligned to grid");
      } else {
        const order = [usage, strategies, heat];
        for (let index = 1; index < order.length; index += 1) {
          assert.ok(
            order[index].top >= order[index - 1].bottom - 0.5,
            `390 order must be usage → strategies → heat (${index})`,
          );
        }
        for (const card of order) {
          assert.ok(near(card.width, grid.width), "390 cards must be full width");
        }
      }
      return {
        usage: { w: round(usage.width), h: round(usage.height), top: round(usage.top) },
        strategies: { w: round(strategies.width), h: round(strategies.height), top: round(strategies.top) },
        heat: { w: round(heat.width), h: round(heat.height), top: round(heat.top) },
        rows: before.rows.length,
      };
    });

    await check(`layout ${label}: 策略卡自然高度，不被拉出大片空白`, () => {
      const heatH = before.cards.heat.height;
      const strategiesH = before.cards.strategies.height;
      assert.ok(
        before.strategiesTrailing !== null && before.strategiesTrailing <= 40,
        `strategies card trailing blank ${before.strategiesTrailing}px`,
      );
      if (width === 1440) {
        // 预览数据策略种类少：差 >120px 时允许保持自然高度，但绝不能用空白填充。
        assert.ok(
          strategiesH <= heatH + 0.5,
          `strategies ${strategiesH} taller than heat ${heatH}`,
        );
      }
      return {
        strategiesH: round(strategiesH),
        heatH: round(heatH),
        diff: round(heatH - strategiesH),
        trailing: before.strategiesTrailing,
      };
    });

    await check(`layout ${label}: 策略摘要说明最常用策略与链数`, () => {
      assert.ok(before.summary !== null, "strategies summary must render");
      assert.match(before.summary.text ?? "", /^最常用：/, "summary prefix");
      assert.match(before.summary.text ?? "", /条链/, "summary chains");
      assert.equal(before.summary.fontSize, "11px", "summary must stay on the type floor");
      // 只有一种策略时不追加「1 种策略」这种冗余尾巴。
      assert.ok(
        !(before.summary.text ?? "").includes("1 种策略"),
        "single kind must not append a kinds suffix",
      );
      return before.summary.text;
    });

    await check(`layout ${label}: 使用量图高 260–300`, () => {
      assert.ok(
        before.plotH !== null && before.plotH >= 260 && before.plotH <= 300,
        `plot height ${before.plotH} out of 260–300`,
      );
      return before.plotH;
    });

    await check(`layout ${label}: 无横向溢出`, () => {
      assert.ok(before.docOverflow <= 0, `document overflow ${before.docOverflow}`);
      assert.ok(
        before.scrollOverflow !== null && before.scrollOverflow <= 0,
        `dialog scroll overflow ${before.scrollOverflow}`,
      );
      assert.ok(
        before.cards.heat.right <= before.cards.scroll.right + 0.5,
        "heat card must stay inside the dialog",
      );
      return { docOverflow: before.docOverflow, scrollOverflow: before.scrollOverflow };
    });

    await check(`layout ${label}: 弹窗滚动区底部空白 ≤24px`, () => {
      assert.ok(
        before.scrollTrailing !== null && before.scrollTrailing <= 24,
        `scroll trailing blank ${before.scrollTrailing}`,
      );
      return before.scrollTrailing;
    });

    await check(`hover ${label}: hover 前无浮层（基线高度）`, () => {
      assert.ok(before.tooltip === null, "no tooltip before hover");
      return { before: before.heights };
    });

    // 逐行 hover：每次都比卡片 / 栅格 / 相邻卡 / 滚动内容高度。
    const perRow = [];
    for (let index = 0; index < 5; index += 1) {
      const row = page.locator("[data-template-heat-row]").nth(index);
      await row.hover();
      await page.waitForTimeout(160);
      const after = await page.evaluate(READ);
      const hovered = await page.evaluate(() =>
        [...document.querySelectorAll("[data-template-heat-row]")].findIndex(
          (row) => row.matches(":hover"),
        ),
      );
      perRow.push({ index, ...after });
      await check(`hover ${label} row ${index}: 卡片高度不变且浮层在弹窗内`, () => {
        assert.equal(hovered, index, `hovered row ${hovered}, expected ${index}`);
        for (const key of ["heat", "grid", "strategies", "usage"]) {
          assert.ok(
            Math.abs(after.heights[key] - before.heights[key]) <= 1,
            `${key} height changed: ${before.heights[key]} → ${after.heights[key]}`,
          );
        }
        assert.ok(
          Math.abs(after.heights.scrollContent - before.heights.scrollContent) <= 1,
          `scroll content changed: ${before.heights.scrollContent} → ${after.heights.scrollContent}`,
        );
        assert.ok(after.tooltip !== null, "tooltip must be mounted on hover");
        assert.equal(after.tooltip.visible, true, "tooltip must be visible");
        assert.equal(after.tooltip.position, "absolute", "tooltip must be absolute");
        assert.equal(after.tooltip.pointerEvents, "none", "tooltip must not block hover");
        assert.equal(after.tooltip.withinCard, true, "tooltip must stay inside the card");
        assert.equal(after.tooltip.withinScroll, true, "tooltip must stay inside the dialog");
        assert.ok(after.tooltip.text?.includes("链数"), "tooltip must show chains");
        assert.ok(after.tooltip.text?.includes("用户"), "tooltip must show users");
        return {
          heatH: round(after.heights.heat),
          gridH: round(after.heights.grid),
          strategiesH: round(after.heights.strategies),
          scrollContent: round(after.heights.scrollContent),
          tooltip: {
            x: round(after.tooltip.rect.x),
            y: round(after.tooltip.rect.y),
            w: round(after.tooltip.rect.width),
            h: round(after.tooltip.rect.height),
            placement: after.tooltip.placement,
            clampedX: after.tooltip.clampedX,
            clampedY: after.tooltip.clampedY,
          },
        };
      });
    }

    // 末行贴底：必须翻到行上方，且仍在卡片内。
    const lastAfter = perRow[perRow.length - 1];
    await check(`hover ${label}: 末行浮层翻到行上方`, () => {
      assert.equal(lastAfter.tooltip?.placement, "above", "last row must flip above");
      assert.ok(
        lastAfter.tooltip.rect.bottom <= lastAfter.rows[4].top + 0.5,
        "flipped tooltip must sit above the last row",
      );
      return {
        placement: lastAfter.tooltip.placement,
        tooltipBottom: round(lastAfter.tooltip.rect.bottom),
        rowTop: round(lastAfter.rows[4].top),
      };
    });

    // 第一行截图（浮层在行下方）。
    await page.locator("[data-template-heat-row]").first().hover();
    await page.waitForTimeout(160);
    const hoverShot = await shoot(page, `hover-after-${label}.png`);

    // 末行翻转截图。
    await page.locator("[data-template-heat-row]").last().hover();
    await page.waitForTimeout(160);
    const flipShot = await shoot(page, `hover-flip-${label}.png`);

    // 移开后浮层消失，高度回到基线。
    await clearHover(page);
    const after = await page.evaluate(READ);
    await check(`hover ${label}: 移开后浮层移除，高度回到基线`, () => {
      assert.equal(after.tooltip, null, "tooltip must unmount when hover ends");
      assert.ok(
        Math.abs(after.heights.heat - before.heights.heat) <= 1,
        `heat height drift ${before.heights.heat} → ${after.heights.heat}`,
      );
      return { heatH: round(after.heights.heat) };
    });

    // 键盘：focus 出现，Esc 只收起浮层。
    await page.locator("[data-template-heat-row]").nth(2).focus();
    await page.waitForTimeout(160);
    const focused = await page.evaluate(READ);
    await check(`keyboard ${label}: focus 显示浮层`, () => {
      assert.ok(focused.tooltip !== null, "focused row must show the tooltip");
      assert.equal(focused.tooltip.visible, true);
      assert.equal(focused.tooltip.withinCard, true);
      return {
        x: round(focused.tooltip.rect.x),
        y: round(focused.tooltip.rect.y),
      };
    });
    const focusShot = await shoot(page, `focus-${label}.png`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(160);
    const escaped = await page.evaluate(READ);
    await check(`keyboard ${label}: Esc 收起浮层、弹窗还在`, () => {
      assert.equal(escaped.tooltip, null, "Esc must hide the tooltip");
      assert.ok(escaped.cards.dialog !== null, "Esc must not close the dialog");
      return { dialogOpen: true, tooltip: null };
    });

    // 布局截图：第一行（使用量）与第二行（策略 | 热度，自然高度 + 摘要）。
    // 先清掉焦点环，
    // 以免把键盘验收的 focus 样式混进布局截图。
    await clearHover(page);
    await page.evaluate(() => document.activeElement?.blur());
    await scrollToGrid(page);
    const layoutRow1 = await shoot(page, `layout-row1-${label}.png`);
    await page.evaluate(() => {
      const strategies = document.querySelector(
        "[data-template-strategies-card]",
      );
      strategies?.scrollIntoView({ block: "start" });
      strategies?.parentElement?.parentElement?.scrollBy?.(0, -8);
    });
    await page.waitForTimeout(200);
    const layoutRow2 = await shoot(page, `layout-row2-${label}.png`);

    results.push({
      name: `heights ${label}`,
      ok: true,
      detail: {
        before: {
          heat: round(before.heights.heat),
          grid: round(before.heights.grid),
          strategies: round(before.heights.strategies),
          strategiesTrailing: before.strategiesTrailing,
          summary: before.summary?.text ?? null,
          usage: round(before.heights.usage),
          scrollContent: round(before.heights.scrollContent),
        },
        duringHover: perRow.map((entry) => ({
          row: entry.index,
          heat: round(entry.heights.heat),
          grid: round(entry.heights.grid),
          strategies: round(entry.heights.strategies),
          scrollContent: round(entry.heights.scrollContent),
        })),
        afterHover: {
          heat: round(after.heights.heat),
          grid: round(after.heights.grid),
          strategies: round(after.heights.strategies),
          scrollContent: round(after.heights.scrollContent),
        },
      },
    });

    results.push({
      name: `screenshots ${label}`,
      ok: true,
      detail: {
        before: beforeShot,
        hover: hoverShot,
        flip: flipShot,
        focus: focusShot,
        layoutRow1,
        layoutRow2,
      },
    });

    await context.close();
  }
}

/* ------------------------------------------------------------------ *
 * 多策略种类：摘要追加「N 种策略」（只拦截详情响应，不改列表）
 * ------------------------------------------------------------------ */

{
  const { context, page } = await newPage(browser, 1440, "dark");
  await context.route("**/api/v1/overview/chain-templates/*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.strategies = [
      { strategy: "round_robin", chains: 2, users: 2 },
      { strategy: "ip_hashed", chains: 1, users: 1 },
      { strategy: "weighted", chains: 1, users: 1 },
    ];
    await route.fulfill({ response, json: body });
  });
  await openDetail(page);
  await scrollToHeat(page);
  await clearHover(page);
  const multi = await page.evaluate(READ);
  await check("summary 1440-dark: 多种策略追加「N 种策略」", () => {
    assert.equal(
      multi.summary?.text,
      "最常用：轮询 · 2 条链 · 3 种策略",
      `summary text ${multi.summary?.text}`,
    );
    assert.equal(multi.summary?.fontSize, "11px");
    assert.equal(multi.cards.strategies.height, multi.heights.strategies);
    return multi.summary?.text;
  });
  await page.evaluate(() => {
    document
      .querySelector("[data-template-strategies-card]")
      ?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
  await shoot(page, "summary-multi-1440-dark.png");
  await context.close();
}

/* ------------------------------------------------------------------ *
 * 390 页底空白（页面级，非弹窗）
 * ------------------------------------------------------------------ */

{
  const { context, page } = await newPage(browser, 390, "dark");
  await page.goto(`${BASE}/?view=chain&section=templates`, {
    waitUntil: "networkidle",
  });
  await page.locator("[data-chain-template-row]").first().waitFor();
  const pageBottom = await page.evaluate(() => {
    const main = document.querySelector("main");
    const kids = [...main.children];
    const last = kids[kids.length - 1];
    const lastBottom =
      last.getBoundingClientRect().bottom -
      main.getBoundingClientRect().top +
      main.scrollTop;
    return {
      scrollHeight: main.scrollHeight,
      lastBottom,
      trailing: Math.round((main.scrollHeight - lastBottom) * 100) / 100,
      paddingBottom: parseFloat(getComputedStyle(main).paddingBottom),
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  await check("page 390: 页底空白 ≤24px，无横向溢出", () => {
    assert.ok(
      pageBottom.trailing <= 24.5,
      `page trailing blank ${pageBottom.trailing}`,
    );
    assert.ok(pageBottom.docOverflow <= 0, `doc overflow ${pageBottom.docOverflow}`);
    return pageBottom;
  });
  await page.evaluate(() => {
    const main = document.querySelector("main");
    main.scrollTop = main.scrollHeight;
  });
  await page.waitForTimeout(200);
  await shoot(page, "page-bottom-390-dark.png");
  await context.close();
}

await browser.close();

writeFileSync(
  path.join(HERE, "report.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      base: BASE,
      template: { id: TEMPLATE.id, name: TEMPLATE.name, heatRows: target.rows },
      viewports: VIEWPORTS,
      themes: THEMES,
      results,
      screenshots,
      failures,
    },
    null,
    2,
  )}\n`,
);

if (failures.length > 0) {
  console.error(`FAILED (${failures.length}):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(
  `OK: ${results.length} checks, ${results.length - failures.length} passed, ` +
    `${screenshots.length} screenshots`,
);
