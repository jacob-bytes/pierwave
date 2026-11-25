#!/usr/bin/env node
/**
 * 服务器列表名称列收口 / sticky 分隔线验收：截图 + DOM 断言
 * Server list name-column containment / sticky divider screenshots + assertions.
 *
 * 前置 / Prerequisite:
 *   PIERWAVE_DB='sqlite://data/preview.db' PIERWAVE_ADMIN_PASSWORD=devpass \
 *   PIERWAVE_ADDR=127.0.0.1:8787 ./target/debug/pierwave-master
 *   （web/dist 必须是当前构建 / web/dist must be the current build）
 *
 * 用法 / Usage:
 *   node web/screenshots/sticky-name-overflow/shots.mjs
 *
 * 说明 / Note:
 *   macOS headless Chrome 使用 overlay 滚动条，原生滚动条在截图中不可见，
 *   也无法用指针拖拽（自动化限制）。脚本因此验证 native scroller 的
 *   水平滚轮 / Shift+滚轮 / scrollLeft，并把拖拽记为不可自动化。
 *   macOS headless Chrome uses overlay scrollbars: the native bar is not
 *   hit-testable, so pointer-dragging it cannot be automated. The script
 *   verifies horizontal wheel / Shift+wheel / scrollLeft instead and records
 *   the drag attempt as not automatable.
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

/** 读取名称 / 地址 / 分隔线 / 提示的几何与计算样式。 */
function collect(page) {
  return page.evaluate(() => {
    const container = document.querySelector('[data-slot="table-container"]');
    const row = container.querySelector('tbody [data-slot="table-row"]');
    const cells = [...row.children];
    const nameCell = row.querySelector("td.pw-sticky-name");
    const nameIndex = cells.indexOf(nameCell);
    const addrCell = cells[nameIndex + 1];
    const nameSpan = nameCell.querySelector('[data-slot="server-name"]');
    const meta = nameCell.querySelector('[data-slot="server-meta"]');
    const metaRow = meta?.parentElement ?? null;
    const after = getComputedStyle(nameCell, "::after");
    const cellStyle = getComputedStyle(nameCell);

    // 用探针把 var(--border) 解析成实际颜色，避免手写 token 值。
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--border)";
    document.body.appendChild(probe);
    const borderColor = getComputedStyle(probe).backgroundColor;
    probe.remove();

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

    return {
      viewport: { width: innerWidth, height: innerHeight },
      container: {
        ...rect(container),
        clientWidth: container.clientWidth,
        scrollWidth: container.scrollWidth,
        scrollLeft: container.scrollLeft,
        maxScrollLeft: container.scrollWidth - container.clientWidth,
      },
      row: rect(row),
      select: rect(cells[nameIndex - 1]),
      name: {
        ...rect(nameCell),
        position: cellStyle.position,
        stickyLeft: cellStyle.left,
        cssWidth: cellStyle.width,
        cssMaxWidth: cellStyle.maxWidth,
        backgroundColor: cellStyle.backgroundColor,
        zIndex: cellStyle.zIndex,
        ...metrics(nameCell),
      },
      nameSpan: {
        ...rect(nameSpan),
        ...metrics(nameSpan),
        overflow: nameSpan ? getComputedStyle(nameSpan).overflow : null,
        textOverflow: nameSpan ? getComputedStyle(nameSpan).textOverflow : null,
        whiteSpace: nameSpan ? getComputedStyle(nameSpan).whiteSpace : null,
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
      metaRow: metaRow
        ? {
            ...rect(metaRow),
            ...metrics(metaRow),
          }
        : null,
      address: {
        ...rect(addrCell),
        ...metrics(addrCell),
        text: addrCell?.textContent?.trim() ?? null,
      },
      separator: {
        width: after.width,
        right: after.right,
        backgroundColor: after.backgroundColor,
        backgroundImage: after.backgroundImage,
        borderColor,
      },
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

/** 断言名称单元格内没有横向溢出。 */
function assertNameContained(g, label) {
  assert.ok(
    g.name.scrollWidth <= g.name.clientWidth + 1,
    `${label}: name cell overflows (${g.name.scrollWidth} > ${g.name.clientWidth})`,
  );
  assert.ok(g.metaRow, `${label}: meta row missing`);
  assert.ok(
    g.metaRow.scrollWidth <= g.metaRow.clientWidth + 1,
    `${label}: meta row overflows (${g.metaRow.scrollWidth} > ${g.metaRow.clientWidth})`,
  );
  // 内容比列宽长时只能被截断，不能画到下一列。
  assert.equal(g.meta.overflow, "hidden", `${label}: meta must clip`);
  assert.equal(g.meta.textOverflow, "ellipsis", `${label}: meta ellipsis`);
  assert.ok(g.meta.title, `${label}: meta full text must be in title`);
  assert.notEqual(g.meta.title, "", `${label}: empty meta title`);
  pass(
    `${label}: 名称/元信息不溢出`,
    `cell ${g.name.scrollWidth}/${g.name.clientWidth}px, meta row ${g.metaRow.scrollWidth}/${g.metaRow.clientWidth}px, meta ${g.meta.scrollWidth}/${g.meta.clientWidth}px`,
  );
}

/** sticky 名称列必须保持可见，且右侧内容是「从它下面」滑过。 */
function assertStickyAfterScroll(g, label) {
  const container = g.container;
  assert.equal(g.name.position, "sticky", `${label}: name must be sticky`);
  assert.equal(g.name.stickyLeft, "40px", `${label}: name must stick at left-10`);
  assert.ok(g.name.width !== "auto", `${label}: name width must be fixed`);
  assert.ok(
    Math.abs(g.name.left - (container.left + 40)) <= 1,
    `${label}: sticky name must stay pinned 40px into the viewport (${g.name.left} vs ${container.left + 40})`,
  );
  assert.ok(
    g.name.left + g.name.width <= container.right + 1,
    `${label}: sticky name must stay inside the viewport`,
  );
  assert.ok(g.address.left < g.name.right, `${label}: address should slide under`);
  pass(
    `${label}: 滚动后名称列仍固定`,
    `name ${g.name.left}–${g.name.right}px, address left=${g.address.left}px, scrollLeft=${container.scrollLeft}`,
  );
}

for (const theme of ["dark", "light"]) {
  const entry = (report.themes[theme] = {});

  for (const { width, height } of [
    { width: 1440, height: 1000 },
    { width: 1024, height: 900 },
  ]) {
    const label = `${theme} ${width}`;
    const context = await newContext({ width, height, theme });
    const page = await context.newPage();
    await page.goto(`${BASE}/servers`, { waitUntil: "networkidle" });
    await waitForTable(page);

    const initial = await collect(page);
    entry[width] = { initial };

    // 1) 表格确实可横向滚动（不是假溢出）。
    assert.ok(
      initial.container.scrollWidth > initial.container.clientWidth + 1,
      `${label}: table must overflow horizontally`,
    );
    assert.ok(
      initial.container.maxScrollLeft >= 24,
      `${label}: horizontal overflow must be usable (${initial.container.maxScrollLeft}px)`,
    );

    // 2) 名称列固定 208px、复选框列真的 40px，地址列从 512px 开始。
    assert.equal(initial.name.cssWidth, "208px", `${label}: name width`);
    assert.equal(initial.name.cssMaxWidth, "208px", `${label}: name max-width`);
    assert.equal(initial.select.width, 40, `${label}: select column must be 40px`);
    assert.ok(
      initial.name.left >= initial.container.left + 39 &&
        initial.name.left <= initial.container.left + 41,
      `${label}: name must start 40px into the table`,
    );
    assert.ok(
      initial.address.left >= initial.name.right - 1,
      `${label}: address must not be covered at scrollLeft=0 (${initial.address.left} < ${initial.name.right})`,
    );

    // 3) 地址完整可读：列宽 ≥160，文本没有被裁。
    assert.ok(
      initial.address.width >= 160,
      `${label}: address column too narrow (${initial.address.width}px)`,
    );
    assert.ok(
      initial.address.scrollWidth <= initial.address.clientWidth + 1,
      `${label}: address text clipped (${initial.address.scrollWidth} > ${initial.address.clientWidth})`,
    );
    assert.ok(initial.address.text && initial.address.text.length > 0);
    pass(
      `${label}: 地址列完整`,
      `${initial.address.text} @ ${initial.address.width}px`,
    );

    // 4) 元信息与名称待在单元格里。
    assertNameContained(initial, label);

    // 5) 右侧分隔线 ≤1px（或 ≤6px 的极淡渐变），颜色就是 var(--border)。
    const sepWidth = Number.parseFloat(initial.separator.width);
    if (initial.separator.backgroundImage === "none") {
      assert.ok(sepWidth <= 1, `${label}: separator too thick (${sepWidth}px)`);
      assert.equal(
        initial.separator.backgroundColor,
        initial.separator.borderColor,
        `${label}: separator must use var(--border)`,
      );
    } else {
      assert.ok(
        sepWidth <= 6,
        `${label}: gradient separator too wide (${sepWidth}px)`,
      );
    }
    pass(
      `${label}: 分隔线 1px`,
      `${initial.separator.width} ${initial.separator.backgroundColor}`,
    );

    // 6) 提示条在可见区且没有被 sticky 列盖住。
    assert.ok(initial.hint.exists, `${label}: scroll hint missing`);
    assert.ok(initial.hint.hit, `${label}: scroll hint covered`);
    assert.ok(initial.hint.rect.x >= 0);
    assert.ok(initial.hint.rect.y >= 0);
    assert.ok(initial.hint.rect.x + initial.hint.rect.width <= width);
    assert.ok(initial.hint.rect.y + initial.hint.rect.height <= height);
    pass(`${label}: 滑动提示可见`, JSON.stringify(initial.hint.rect));

    await page.screenshot({
      path: path.join(
        HERE,
        `servers-${width}-${theme}-${width === 1024 ? "overflow" : "initial"}.png`,
      ),
    });

    // 7) 水平滚轮 / Shift+滚轮都能移动表格（Shift 由 Table 的 wheel 兜底）。
    const box = await page.locator('[data-slot="table-container"]').first().boundingBox();
    const hoverX = box.x + Math.min(360, box.width / 2);
    const hoverY = box.y + 120;

    await page.locator('[data-slot="table-container"]').first().evaluate((el) => {
      el.scrollLeft = 0;
    });
    await page.mouse.move(hoverX, hoverY);
    await page.mouse.wheel(120, 0);
    await page.waitForTimeout(200);
    const wheelLeft = await page
      .locator('[data-slot="table-container"]')
      .first()
      .evaluate((el) => el.scrollLeft);
    assert.ok(wheelLeft > 0, `${label}: horizontal wheel did not scroll`);

    await page.locator('[data-slot="table-container"]').first().evaluate((el) => {
      el.scrollLeft = 0;
    });
    const mainTopBefore = await page.evaluate(
      () => document.querySelector("main").scrollTop,
    );
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: hoverX,
      y: hoverY,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: hoverX,
      y: hoverY,
      deltaX: 0,
      deltaY: 180,
      modifiers: 8, // Shift
    });
    await page.waitForTimeout(250);
    const shiftLeft = await page
      .locator('[data-slot="table-container"]')
      .first()
      .evaluate((el) => el.scrollLeft);
    const mainTopAfter = await page.evaluate(
      () => document.querySelector("main").scrollTop,
    );
    assert.ok(shiftLeft > 0, `${label}: Shift+wheel did not scroll the table`);
    assert.equal(
      mainTopAfter,
      mainTopBefore,
      `${label}: Shift+wheel must not scroll the page vertically`,
    );
    pass(
      `${label}: 滚轮 / Shift+滚轮横向滚动`,
      `wheel=${wheelLeft}px, shift+wheel=${shiftLeft}px`,
    );

    // 8) 拖滚动条：native scroller 位置由 scrollLeft 驱动；headless 的
    //    macOS overlay 滚动条不可命中，记录尝试结果而不判红。
    await page.evaluate(() => {
      const el = document.querySelector('[data-slot="table-container"]');
      el.scrollLeft = 0;
      const main = document.querySelector("main");
      main.scrollTop = main.scrollHeight;
    });
    await page.waitForTimeout(200);
    const bottomBox = await page
      .locator('[data-slot="table-container"]')
      .first()
      .boundingBox();
    const barY = bottomBox.y + bottomBox.height - 4;
    let dragLeft = null;
    let dragNote = "overlay-scrollbar-not-hit-testable-in-headless";
    if (barY > 0 && barY < height - 1) {
      await page.mouse.move(bottomBox.x + 30, barY);
      await page.mouse.down();
      for (let step = 1; step <= 8; step += 1) {
        await page.mouse.move(bottomBox.x + 30 + step * 16, barY, {
          steps: 2,
        });
      }
      await page.mouse.up();
      await page.waitForTimeout(150);
      dragLeft = await page
        .locator('[data-slot="table-container"]')
        .first()
        .evaluate((el) => el.scrollLeft);
      if (dragLeft > 0) dragNote = "dragged";
    }
    await page.evaluate(() => {
      document.querySelector("main").scrollTop = 0;
    });
    entry[width].scrollInteraction = {
      wheelLeft,
      shiftLeft,
      dragLeft,
      dragNote,
    };

    // 9) 滚到最右：sticky 名称列仍在，地址从它下面滑过。
    await page.locator('[data-slot="table-container"]').first().evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForTimeout(250);
    const scrolled = await collect(page);
    entry[width].scrolled = scrolled;
    assert.ok(
      scrolled.container.scrollLeft >= scrolled.container.maxScrollLeft - 1,
      `${label}: must reach max scroll`,
    );
    assertStickyAfterScroll(scrolled, label);

    // sticky 单元格必须不透明并盖住滑过的内容（命中测试）。
    const hit = await page.evaluate(() => {
      const nameCell = document.querySelector(
        'tbody [data-slot="table-row"] td.pw-sticky-name',
      );
      const box = nameCell.getBoundingClientRect();
      const el = document.elementFromPoint(box.right - 6, box.top + box.height / 2);
      return {
        insideName: el?.closest("td.pw-sticky-name") !== null,
        tag: el?.tagName ?? null,
      };
    });
    assert.ok(hit.insideName, `${label}: sliding content paints over the sticky name`);
    const alpha = /\/\s*([\d.]+)\)/.exec(scrolled.name.backgroundColor);
    assert.ok(
      alpha === null || Number(alpha[1]) >= 0.99,
      `${label}: sticky name background must be opaque (${scrolled.name.backgroundColor})`,
    );
    pass(
      `${label}: 内容从 sticky 列下滑过`,
      `hit=${hit.tag}, bg=${scrolled.name.backgroundColor}, z=${scrolled.name.zIndex}`,
    );

    await page.screenshot({
      path: path.join(HERE, `servers-${width}-${theme}-scrolled.png`),
    });

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
      await page.locator('[data-slot="table-scroll-hint"]').count(),
      0,
      `${theme} 390: scroll hint must not render`,
    );
    const cards = await page.locator('[data-slot="mobile-data-card"]').count();
    assert.equal(cards, servers.length, `${theme} 390: card count`);
    entry.mobile390 = { tables: 0, cards };
    await page.screenshot({
      path: path.join(HERE, `servers-390-${theme}-cards.png`),
    });
    pass(`${theme} 390: 卡片视图`, `${cards} cards, 0 tables`);
    await context.close();
  }
}

await browser.close();
report.ok = true;
writeFileSync(path.join(HERE, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
