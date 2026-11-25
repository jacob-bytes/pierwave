#!/usr/bin/env node
/**
 * 服务器列表 sticky 列滚动阴影验收：截图 + DOM 断言
 * Sticky-column scroll shadow screenshots + assertions.
 *
 * 验收三态 / Three states:
 *   initial   未横向滚动：名称列右侧没有分隔线 / 阴影；
 *   scrolling 横向滚动中：名称列右缘、操作列左缘浮现柔和 box-shadow；
 *   back      滚回最左端：阴影淡出，恢复普通表格。
 *
 * 前置 / Prerequisite:
 *   PIERWAVE_DB='sqlite://data/preview.db' PIERWAVE_ADMIN_PASSWORD=devpass \
 *   PIERWAVE_ADDR=127.0.0.1:8787 ./target/debug/pierwave-master
 *   （web/dist 必须是当前构建 / web/dist must be the current build）
 *
 * 用法 / Usage:
 *   node web/screenshots/sticky-name-overflow/shots.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const ADMIN = process.env.ADMIN_PASSWORD ?? "devpass";
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function loadPlaywright() {
  const npxRoot = path.join(ROOT, ".npm-cache", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      const candidate = path.join(
        npxRoot,
        entry,
        "node_modules",
        "playwright",
        "index.mjs",
      );
      if (!existsSync(candidate)) continue;
      const mod = await import(pathToFileURL(candidate).href);
      if (mod.chromium) return mod.chromium;
    }
  }
  const mod = await import("playwright");
  return mod.chromium;
}

const chromium = await loadPlaywright();
mkdirSync(HERE, { recursive: true });

// ---- 登录 + 真实数据（不写死预览库内容） -------------------------------
const login = await fetch(`${BASE}/api/v1/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password: ADMIN }),
});
assert.equal(login.status, 200, `login failed: ${login.status}`);
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .find((value) => value.startsWith("pierwave_session="));
assert.ok(cookie, "no session cookie");
const [cookieName, cookieValue] = cookie.split("=");

const serverResponse = await fetch(`${BASE}/api/v1/servers`, {
  headers: { Cookie: cookie },
});
assert.equal(serverResponse.status, 200);
const serverPayload = await serverResponse.json();
const servers = Array.isArray(serverPayload)
  ? serverPayload
  : (serverPayload.items ?? []);
assert.ok(servers.length > 0, "preview data needs servers");

const report = {
  base: BASE,
  servers: servers.length,
  themes: {},
  assertions: [],
};
function pass(name, detail) {
  report.assertions.push({ name, ok: true, detail });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function newContext({ width, height, theme }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: theme,
    locale: "zh-CN",
    // 截图需要可对比：呼吸 / 入场动画在 reduced-motion 下静止。
    // 阴影的 opacity 过渡也走全局 0.01ms，但最终状态与真实交互一致。
    reducedMotion: "reduce",
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
  return context;
}

async function waitForTable(page) {
  await page
    .locator('tbody [data-slot="table-row"] td.pw-sticky-name')
    .first()
    .waitFor();
  await page.waitForTimeout(250);
}

/** 读取名称 / 地址 / sticky 投影 / 提示的几何与计算样式。 */
function collect(page) {
  return page.evaluate(() => {
    const container = document.querySelector('[data-slot="table-container"]');
    const row = container.querySelector('tbody [data-slot="table-row"]');
    const cells = [...row.children];
    const nameCell = row.querySelector("td.pw-sticky-name");
    const actionCell = row.querySelector('td[data-sticky="right"]');
    const nameIndex = cells.indexOf(nameCell);
    const addrCell = cells[nameIndex + 1];
    const nameSpan = nameCell.querySelector('[data-slot="server-name"]');
    const meta = nameCell.querySelector('[data-slot="server-meta"]');
    const metaRow = meta?.parentElement ?? null;

    const rect = (el) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return {
        left: Math.round(box.left * 10) / 10,
        right: Math.round(box.right * 10) / 10,
        top: Math.round(box.top * 10) / 10,
        bottom: Math.round(box.bottom * 10) / 10,
        width: Math.round(box.width * 10) / 10,
        height: Math.round(box.height * 10) / 10,
      };
    };
    const metrics = (el) =>
      el ? { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth } : null;

    const hint = document.querySelector('[data-slot="table-scroll-hint"]');
    const hintRect = hint?.getBoundingClientRect() ?? null;
    const hintHit =
      hintRect === null
        ? false
        : document
            .elementFromPoint(
              hintRect.x + hintRect.width / 2,
              hintRect.y + hintRect.height / 2,
            )
            ?.closest('[data-slot="table-scroll-hint"]') !== null;

    // shadowInfo 在 page.evaluate 里不能用外层的函数，这里内联一份。
    const shadowInfo = (cell) => {
      const shadow = cell?.querySelector('[data-slot="sticky-scroll-shadow"]');
      const style = shadow ? getComputedStyle(shadow) : null;
      const cellStyle = getComputedStyle(cell);
      const after = getComputedStyle(cell, "::after");
      const box = shadow?.getBoundingClientRect() ?? null;
      return {
        exists: shadow !== null,
        side: shadow?.getAttribute("data-side") ?? null,
        opacity: style?.opacity ?? null,
        boxShadow: style?.boxShadow ?? null,
        backgroundImage: style?.backgroundImage ?? null,
        backgroundColor: style?.backgroundColor ?? null,
        pointerEvents: style?.pointerEvents ?? null,
        rect: box
          ? {
              left: Math.round(box.left * 10) / 10,
              right: Math.round(box.right * 10) / 10,
              top: Math.round(box.top * 10) / 10,
              bottom: Math.round(box.bottom * 10) / 10,
            }
          : null,
        cellBoxShadow: cellStyle.boxShadow,
        borderRightWidth: cellStyle.borderRightWidth,
        after: {
          content: after.content,
          width: after.width,
          backgroundImage: after.backgroundImage,
        },
      };
    };

    return {
      viewport: { width: innerWidth, height: innerHeight },
      container: {
        ...rect(container),
        clientWidth: container.clientWidth,
        scrollWidth: container.scrollWidth,
        scrollLeft: container.scrollLeft,
        maxScrollLeft: container.scrollWidth - container.clientWidth,
        scrolled: container.getAttribute("data-scrolled-x"),
      },
      select: rect(cells[nameIndex - 1]),
      name: {
        ...rect(nameCell),
        position: getComputedStyle(nameCell).position,
        stickyLeft: getComputedStyle(nameCell).left,
        cssWidth: getComputedStyle(nameCell).width,
        ...metrics(nameCell),
      },
      nameSpan: {
        ...rect(nameSpan),
        ...metrics(nameSpan),
        overflow: nameSpan ? getComputedStyle(nameSpan).overflow : null,
        textOverflow: nameSpan ? getComputedStyle(nameSpan).textOverflow : null,
        text: nameSpan?.textContent ?? null,
        title: nameSpan?.getAttribute("title") ?? null,
      },
      meta: {
        ...rect(meta),
        ...metrics(meta),
        overflow: meta ? getComputedStyle(meta).overflow : null,
        textOverflow: meta ? getComputedStyle(meta).textOverflow : null,
        text: meta?.textContent ?? null,
        title: meta?.getAttribute("title") ?? null,
      },
      metaRow: metaRow ? { ...rect(metaRow), ...metrics(metaRow) } : null,
      address: {
        ...rect(addrCell),
        ...metrics(addrCell),
        text: addrCell?.textContent?.trim() ?? null,
      },
      shadowName: shadowInfo(nameCell),
      shadowAction: shadowInfo(actionCell),
      hint: {
        exists: hint !== null,
        rect: hintRect
          ? {
              x: Math.round(hintRect.x),
              y: Math.round(hintRect.y),
              width: Math.round(hintRect.width),
              height: Math.round(hintRect.height),
            }
          : null,
        hit: hintHit,
      },
    };
  });
}

/** 默认 / 回滚态：没有实线、没有可见阴影。 */
function assertNoShadow(g, label) {
  assert.equal(g.container.scrolled, null, `${label}: data-scrolled-x must be absent`);
  for (const [key, shadow] of [
    ["name", g.shadowName],
    ["action", g.shadowAction],
  ]) {
    assert.ok(shadow.exists, `${label}: ${key} shadow element missing`);
    assert.equal(shadow.opacity, "0", `${label}: ${key} shadow must be invisible`);
    assert.equal(
      shadow.cellBoxShadow,
      "none",
      `${label}: td itself must not carry box-shadow`,
    );
    // 没有 1px 实线，也没有伪元素渐变。
    assert.equal(shadow.borderRightWidth, "0px", `${label}: no 1px border`);
    assert.equal(shadow.after.content, "none", `${label}: no ::after line`);
    assert.notEqual(shadow.after.width, "1px", `${label}: no 1px pseudo line`);
    assert.equal(
      shadow.backgroundImage,
      "none",
      `${label}: shadow must not be a gradient`,
    );
  }
  pass(`${label}: 未滚动无阴影 / 无实线`, "opacity=0, td box-shadow=none, ::after=none");
}

/** 滚动中：两侧阴影都出现，方向正确，且仍是 box-shadow 不是实线。 */
function assertShadowVisible(g, label) {
  assert.equal(g.container.scrolled, "true", `${label}: data-scrolled-x missing`);
  assert.ok(g.container.scrollLeft > 1, `${label}: table must be scrolled`);
  for (const [key, shadow, offset] of [
    ["name", g.shadowName, "6px 0px"],
    ["action", g.shadowAction, "-6px 0px"],
  ]) {
    assert.ok(shadow.exists, `${label}: ${key} shadow element missing`);
    assert.equal(shadow.opacity, "1", `${label}: ${key} shadow must be visible`);
    assert.match(
      shadow.boxShadow,
      new RegExp(`${offset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 10px -6px`),
      `${label}: ${key} box-shadow geometry`,
    );
    assert.equal(
      shadow.backgroundImage,
      "none",
      `${label}: ${key} shadow is a box-shadow, not a gradient`,
    );
    assert.equal(shadow.pointerEvents, "none", `${label}: ${key} must not eat clicks`);
    assert.equal(
      shadow.cellBoxShadow,
      "none",
      `${label}: td itself must stay box-shadow: none`,
    );
    assert.equal(shadow.after.content, "none", `${label}: no ::after line`);
  }
  assert.equal(g.shadowName.side, "left", `${label}: name shadow side`);
  assert.equal(g.shadowAction.side, "right", `${label}: action shadow side`);
  pass(
    `${label}: 滚动时两侧柔和阴影`,
    `name ${g.shadowName.boxShadow}; action ${g.shadowAction.boxShadow}`,
  );
}

for (const theme of ["dark", "light"]) {
  const entry = (report.themes[theme] = {});
  const themeToken =
    theme === "dark" ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.16)";

  for (const { width, height } of [
    { width: 1440, height: 1000 },
    { width: 1024, height: 900 },
  ]) {
    const label = `${theme} ${width}`;
    const widthEntry = (entry[width] = {});
    const context = await newContext({ width, height, theme });
    const page = await context.newPage();
    await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
    await waitForTable(page);

    const container = page.locator('[data-slot="table-container"]').first();
    const setScroll = async (left) => {
      await container.evaluate((el, value) => {
        el.scrollLeft = value;
      }, left);
      await page.waitForTimeout(320);
    };

    // ---- 1) 未滚动 ------------------------------------------------------
    const initial = await collect(page);
    widthEntry.initial = initial;
    assert.ok(
      initial.container.scrollWidth > initial.container.clientWidth + 1,
      `${label}: table must overflow horizontally`,
    );
    assert.ok(initial.container.maxScrollLeft >= 24);
    assert.equal(initial.name.cssWidth, "208px", `${label}: name width`);
    assert.equal(initial.select.width, 40, `${label}: select column must be 40px`);
    assert.ok(
      initial.address.left >= initial.name.right - 1,
      `${label}: address must not be covered at rest`,
    );
    assert.ok(initial.address.width >= 160, `${label}: address too narrow`);
    assert.ok(
      initial.address.scrollWidth <= initial.address.clientWidth + 1,
      `${label}: address text clipped`,
    );
    // 名称列收口（上一轮修复）不回归：单元格 / 元信息行都不横向溢出。
    assert.ok(
      initial.name.scrollWidth <= initial.name.clientWidth + 1,
      `${label}: name cell overflows`,
    );
    assert.ok(
      initial.metaRow.scrollWidth <= initial.metaRow.clientWidth + 1,
      `${label}: meta row overflows`,
    );
    assert.ok(initial.hint.exists && initial.hint.hit, `${label}: scroll hint`);
    assertNoShadow(initial, label);
    await page.screenshot({
      path: path.join(HERE, `servers-${width}-${theme}-initial.png`),
    });

    // ---- 2) 横向滚动中：阴影浮现 ---------------------------------------
    const mid = Math.max(12, Math.round(initial.container.maxScrollLeft / 2));
    await setScroll(mid);
    const scrolling = await collect(page);
    widthEntry.scrolling = scrolling;
    assertShadowVisible(scrolling, label);
    // 名称列仍固定，内容从它下面滑过。
    assert.ok(
      Math.abs(scrolling.name.left - (scrolling.container.left + 40)) <= 1,
      `${label}: name must stay pinned`,
    );
    assert.ok(
      scrolling.address.left < scrolling.name.right,
      `${label}: address should slide under the name column`,
    );
    // 投影颜色按亮暗主题取不同不透明度。
    assert.ok(
      scrolling.shadowName.boxShadow.includes(themeToken),
      `${label}: shadow colour ${scrolling.shadowName.boxShadow} != ${themeToken}`,
    );
    await page.screenshot({
      path: path.join(HERE, `servers-${width}-${theme}-scrolling.png`),
    });

    // ---- 3) 滚回最左：阴影淡出 -----------------------------------------
    await setScroll(0);
    const back = await collect(page);
    widthEntry.back = back;
    assert.equal(back.container.scrollLeft, 0);
    assertNoShadow(back, label);
    await page.screenshot({
      path: path.join(HERE, `servers-${width}-${theme}-back.png`),
    });

    // 回滚后的截图与初始截图应当没有可见的 sticky 投影差异（忽略「滑动提示」）。
    widthEntry.shadowState = {
      initialOpacity: initial.shadowName.opacity,
      scrollingOpacity: scrolling.shadowName.opacity,
      backOpacity: back.shadowName.opacity,
      colour: scrolling.shadowName.boxShadow.match(/rgba?\([^)]*\)/)?.[0],
    };
    await context.close();
  }

  // ---- 390：卡片视图，不渲染表格 ----------------------------------------
  {
    const context = await newContext({ width: 390, height: 844, theme });
    const page = await context.newPage();
    await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
    await page.locator('[data-slot="mobile-data-card"]').first().waitFor();
    await page.waitForTimeout(250);
    assert.equal(
      await page.locator('[data-slot="table-container"]').count(),
      0,
      `${theme} 390: table must not render`,
    );
    assert.equal(
      await page.locator('[data-slot="sticky-scroll-shadow"]').count(),
      0,
      `${theme} 390: shadow must not render`,
    );
    const cards = await page.locator('[data-slot="mobile-data-card"]').count();
    assert.equal(cards, servers.length, `${theme} 390: card count`);
    entry.mobile390 = { tables: 0, shadows: 0, cards };
    await page.screenshot({
      path: path.join(HERE, `servers-390-${theme}-cards.png`),
    });
    pass(`${theme} 390: 卡片视图`, `${cards} cards, 0 tables / 0 shadows`);
    await context.close();
  }
}

await browser.close();
report.ok = true;
writeFileSync(path.join(HERE, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
