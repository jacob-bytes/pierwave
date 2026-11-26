/**
 * 概览视图 tab 行吸顶的源码级回归。
 *
 * 运行时几何（滚动后 top 恒定、分隔线只在吸顶时出现、切视图 scrollTop
 * 回到内容顶部）由 `web/screenshots/overview-sticky-tabs/shots.mjs`
 * 用 Playwright 断言；这里锁住不依赖浏览器的结构契约：
 *
 * - sticky 只在 `md`（48rem）及以上生效，窄屏保持原样；
 * - 分隔线 / 背景由 `data-stuck` 驱动，未吸顶时不出现；
 * - 层级别压过下拉弹层，且不引入 overflow 裁剪；
 * - 切视图滚动的是内容容器 `#main-content`，不是文档。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../${relative}`, import.meta.url)),
    "utf8",
  );
}

const insight = read("components/overview/OverviewInsight.tsx");
const css = read("index.css");

/** 取出某个 @media 的完整块，避免把媒体查询外的规则误当成吸顶规则。 */
function mediaBlock(source, query) {
  const start = source.indexOf(`@media ${query} {`);
  assert.ok(start >= 0, `index.css missing @media ${query}`);
  let depth = 0;
  for (
    let cursor = source.indexOf("{", start);
    cursor < source.length;
    cursor += 1
  ) {
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, cursor + 1);
    }
  }
  assert.fail(`index.css has an unterminated @media ${query}`);
}

const DESKTOP_QUERY = "(min-width: 48rem)";
const desktop = mediaBlock(css, DESKTOP_QUERY);

test("md+ 才吸顶：tab 行 position sticky / top 0，窄屏没有这条规则", () => {
  // 所有 toolbar 规则都必须落在媒体查询里；窄屏因此回到 static。
  const selectorAt = css.indexOf("[data-overview-view-toolbar]");
  const mediaAt = css.indexOf(`@media ${DESKTOP_QUERY} {`);
  assert.ok(selectorAt > mediaAt, "toolbar rules must live inside md+ media query");
  assert.ok(
    !css.slice(0, mediaAt).includes("[data-overview-view-toolbar]"),
    "toolbar must not be styled outside the md+ media query",
  );

  const rule = desktop.slice(
    desktop.indexOf("[data-overview-view-toolbar]"),
  );
  assert.match(rule, /position:\s*sticky;/, "sticky is required on md+");
  // main 的 p-6 会把 top:0 解释成内容盒顶部，吸顶后低 24px、露出上方
  // 滚过的内容；用 -1.5rem 抵消，正好贴在滚动容器顶部。
  assert.match(rule, /top:\s*-1\.5rem;/, "tab row sticks to the content top");
  assert.match(rule, /z-index:\s*20;/, "sticky row must stay below overlays");
  // 下拉 / 弹窗走 z-50 / z-60；吸顶行不能盖住它们。
  assert.doesNotMatch(rule, /z-index:\s*(?:[6-9]\d|[1-9]\d{2,});/);
  // 负外边距 + 同值内边距铺满内容区，但不越过 main 的 padding box。
  assert.match(rule, /margin-inline:\s*-1\.5rem;/);
  assert.match(rule, /padding-inline:\s*1\.5rem;/);
  // 不新增 overflow，避免裁掉焦点环、锚点定位或制造横向滚动。
  assert.doesNotMatch(rule, /overflow(?:-[xy])?\s*:/);
});

test("背景与 1px 分隔线只在 data-stuck=true 时出现", () => {
  assert.match(
    desktop,
    /\[data-overview-view-toolbar\]\[data-stuck="true"\]\s*\{[^}]*background-color:\s*color-mix\([^;]*var\(--background\)/,
    "stuck background must be a faint --background tint",
  );
  assert.match(
    desktop,
    /\[data-overview-view-toolbar\]::after\s*\{[^}]*height:\s*1px;[^}]*z-index:\s*-1;[^}]*\}/,
    "separator must be a 1px pseudo-element below the row content",
  );
  assert.match(
    desktop,
    /\[data-overview-view-toolbar\]::after\s*\{[^}]*opacity:\s*0;[^}]*\}/,
    "separator is hidden when the row is not stuck",
  );
  assert.match(
    desktop,
    /\[data-overview-view-toolbar\]\[data-stuck="true"\]::after\s*\{[^}]*opacity:\s*1;[^}]*\}/,
    "separator appears only when the row is stuck",
  );
  // 颜色全部走 token，不写死色值。
  assert.doesNotMatch(
    desktop,
    /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\boklch\(/,
    "sticky styles must use CSS variables, not hard-coded colours",
  );
});

test("吸顶状态只在 md+ 且真正贴顶时开启", () => {
  assert.match(insight, /const DESKTOP_QUERY = "\(min-width: 48rem\)"/);
  assert.match(insight, /window\.matchMedia\(DESKTOP_QUERY\)/);
  assert.match(insight, /getElementById\("main-content"\)/);
  assert.match(
    insight,
    /setToolbarStuck\(desktop\.matches && offset <= 0\.5\)/,
    "narrow screens must never enter the stuck state",
  );
  // 滚动 / 尺寸变化都要重新量，且用 rAF 合帧。
  assert.match(insight, /requestAnimationFrame\(measure\)/);
  assert.match(insight, /addEventListener\("scroll"/);
  assert.match(insight, /addEventListener\("resize"/);
});

test("工具栏携带 ref 与 data 钩子，包住 tab + 筛选 + 子页", () => {
  assert.match(insight, /ref=\{toolbarRef\}/);
  assert.match(insight, /data-overview-view-toolbar/);
  assert.match(insight, /data-stuck=\{toolbarStuck \? "true" : "false"\}/);

  // 钩子必须挂在包含 ServerFilter / ChainSectionTabs 的那一行上，而不是
  // 只包住四个主 tab。
  const markerAt = insight.indexOf("data-overview-view-toolbar");
  const filterAt = insight.indexOf("<ServerFilter");
  const sectionTabsAt = insight.indexOf("<ChainSectionTabs");
  assert.ok(filterAt > markerAt, "server filter must live in the sticky row");
  assert.ok(
    sectionTabsAt > filterAt,
    "chain sub-tabs must stay inside the sticky row",
  );
});

test("切主视图把内容区滚回顶部，不动文档", () => {
  const handlerAt = insight.indexOf("function handleViewChange");
  assert.ok(handlerAt >= 0, "OverviewInsight must keep handleViewChange");
  const handlerEnd = insight.indexOf("\n  return (", handlerAt);
  assert.ok(handlerEnd > handlerAt, "handleViewChange body not found");
  const handler = insight.slice(handlerAt, handlerEnd);
  assert.match(
    handler,
    /scrollContentToTop\(\)/,
    "switching views must call the content-scroll helper",
  );

  assert.match(
    insight,
    /function scrollContentToTop\(\)[\s\S]*?scrollTop = 0/,
    "helper must reset #main-content scrollTop",
  );
  assert.doesNotMatch(
    insight,
    /window\.scrollTo|document\.documentElement\.scrollTop/,
    "the document itself must never be scrolled",
  );
});
