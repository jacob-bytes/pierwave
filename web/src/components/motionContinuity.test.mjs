/**
 * 选中指示器 / KPI 数值淡入 / 图表入场的源码级回归。
 *
 * 运行时的几何与读数由 `web/screenshots/motion-continuity/shots.mjs`
 * 用 Playwright 断言；这里锁住结构契约，防止下一次改版把动效又散回
 * 每个触发器自己的背景类里。
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

function includes(source, patterns, label) {
  for (const pattern of patterns) {
    assert.ok(source.includes(pattern), `${label} missing: ${pattern}`);
  }
}

function excludes(source, patterns, label) {
  for (const pattern of patterns) {
    assert.ok(
      !source.includes(pattern),
      `${label} should not include: ${pattern}`,
    );
  }
}

const tabs = read("components/ui/tabs.tsx");
const indicator = read("components/ui/sliding-indicator.tsx");
const indicatorLib = read("lib/indicatorRect.ts");
const shell = read("components/AppShell.tsx");
const chainKpi = read("components/overview/ChainKpi.tsx");
const overview = read("pages/Overview.tsx");
const chartHook = read("lib/useChartEnterAnimation.ts");
const css = read("index.css");

const CHART_FILES = [
  "components/overview/TrafficChart.tsx",
  "components/overview/ProtocolTrendChart.tsx",
  "components/overview/ResourceLineChart.tsx",
  "components/overview/ServerUptimeTrendChart.tsx",
  "components/overview/CostView.tsx",
  "components/overview/ChainLatencyTrendChart.tsx",
  "components/overview/ChainSegmentTrendChart.tsx",
  "components/overview/ChainTemplateUsageChart.tsx",
  "components/chains/LatencyChart.tsx",
  "components/chains/ProbeChart.tsx",
];

test("TabsList 是定位容器，选中指示器是第一个子元素", () => {
  const list = tabs.slice(
    tabs.indexOf("function TabsList"),
    tabs.indexOf("function TabsTrigger"),
  );
  includes(
    list,
    [
      "<SlidingIndicator",
      "containerRef={listRef}",
      `activeSelector='[data-slot="tabs-trigger"][data-state="active"]'`,
      'placement={variant === "line" ? "underline" : "pill"}',
    ],
    "TabsList",
  );
  assert.match(tabs, /group\/tabs-list relative /, "TabsList must be relative");
  // 指示器必须排在 triggers 之前，才能被触发器文字盖住。
  const indicatorAt = list.indexOf("<SlidingIndicator");
  const childrenAt = list.indexOf("{children}");
  assert.ok(indicatorAt >= 0, "TabsList must render the indicator");
  assert.ok(childrenAt >= 0, "TabsList must render its children");
  assert.ok(
    indicatorAt < childrenAt,
    "indicator must render before the triggers",
  );
  // line 用 2px 下划线，其余用实心胶囊。
  includes(
    list,
    [
      'variant === "line"',
      '"rounded-none bg-primary"',
      "rounded-md border border-transparent bg-primary shadow-sm dark:border-input dark:bg-input/30",
    ],
    "TabsList indicator classes",
  );
});

test("TabsTrigger 删掉选中底色 / 边框 / 阴影 / 下划线，只留文字与焦点", () => {
  excludes(
    tabs,
    [
      "data-[state=active]:bg-primary",
      "data-[state=active]:shadow-sm",
      "hover:data-[state=active]:bg-primary/90",
      "group-data-[variant=default]/tabs-list:data-active:shadow-sm",
      "group-data-[variant=line]/tabs-list:data-active:shadow-none",
      "data-active:bg-background",
      "dark:data-active:border-input",
      "dark:data-active:bg-input/30",
      "group-data-[variant=line]/tabs-list:bg-transparent",
      "group-data-[variant=line]/tabs-list:data-active:bg-transparent",
      "dark:group-data-[variant=line]/tabs-list:data-active:border-transparent",
      "dark:group-data-[variant=line]/tabs-list:data-active:bg-transparent",
      "after:absolute",
      "after:bg-foreground",
      "group-data-horizontal/tabs:after:inset-x-0",
      "group-data-[variant=line]/tabs-list:data-active:after:opacity-100",
    ],
    "TabsTrigger",
  );
  includes(
    tabs,
    [
      "text-muted-foreground",
      "data-[state=active]:text-primary-foreground",
      "data-active:text-foreground",
      "dark:data-active:text-foreground",
      "hover:text-foreground",
      "focus-visible:ring-[3px]",
      "focus-visible:ring-ring/50",
      "focus-visible:outline-1",
      "focus-visible:outline-ring",
    ],
    "TabsTrigger",
  );
  // 注释说明底色由指示器承担，避免下一个人又加回去。
  assert.match(tabs, /指示器|indicator/);
});

test("TabsTrigger 的焦点提示只用 ring / outline，不再画边框", () => {
  // 指针模态下 `html[data-input="pointer"] :focus-visible` 只清 outline 与
  // ring；`focus-visible:border-ring` 会在鼠标点击（Radix 脚本聚焦）后留下
  // 1px 蓝框。选中底色 / 边框已归 SlidingIndicator，触发器只保留 ring 与
  // outline 两种焦点提示。
  excludes(tabs, ["focus-visible:border-ring"], "TabsTrigger");
  includes(
    tabs,
    ["focus-visible:ring-[3px]", "focus-visible:outline-1"],
    "TabsTrigger focus ring",
  );
});

test("`.chain-section-tabs` 不再自己画 ::after 下划线", () => {
  const start = css.indexOf(".chain-section-tabs {");
  assert.ok(start >= 0, "index.css missing .chain-section-tabs");
  const nextSection = css.indexOf("\n/*", start);
  const block = css.slice(start, nextSection === -1 ? css.length : nextSection);
  assert.doesNotMatch(block, /::after/);
  assert.doesNotMatch(block, /display:\s*none/);
  // 其余排版不变：仍是有高度的 inline-flex。
  includes(block, ["display: inline-flex", "height: 2rem"], "chain section tabs");
});

test("侧栏选中态由指示器承担，NavEntry 不再自己涂底色", () => {
  includes(
    shell,
    [
      "<SlidingIndicator",
      'activeSelector=\'a[aria-current="page"]\'',
      'className="rounded-md bg-sidebar-accent"',
      "relative",
    ],
    "AppShell",
  );
  // 选中分支只保留字重与文字色；hover 的 /60 仍是另一回事。
  assert.match(
    shell,
    /active\s*\?\s*"font-medium text-foreground"/,
    "active NavEntry should only keep weight and text colour",
  );
  assert.doesNotMatch(
    shell,
    /active\s*\?\s*"bg-sidebar-accent/,
    "active NavEntry must not paint its own background",
  );
  // 每个导航分组各有独立的定位容器。
  assert.match(shell, /navGroups\.map\(/);
});

test("SlidingIndicator：测量、观察与首帧不滑的契约", () => {
  includes(
    indicator,
    [
      'data-slot="sliding-indicator"',
      'data-ready={ready ? "ready" : "hidden"}',
      "pointer-events-none",
      "absolute",
      "getBoundingClientRect",
      "useLayoutEffect",
      "indicatorRect(",
      "sameBox(",
      "ResizeObserver",
      "MutationObserver",
      "document.fonts.ready",
      '"animationend"',
      '"transitionend"',
      "capture: true",
      "300",
      'duration-200 ease-out-soft',
      "motion-reduce:transition-none",
      "requestAnimationFrame",
    ],
    "SlidingIndicator",
  );
  // 不允许用 offsetLeft 测量：滚动容器里它会丢掉滚动量。
  assert.doesNotMatch(indicator, /offsetLeft|offsetTop/);
  // 只在 ready 时启用 left/top/width/height 过渡。
  assert.match(
    indicator,
    /ready\s*\?\s*"transition-\[left,top,width,height\] duration-200 ease-out-soft motion-reduce:transition-none"\s*:\s*""/,
    "transitions must only run when data-ready is ready",
  );
});

test("indicatorRect 导出纯函数契约", () => {
  includes(
    indicatorLib,
    [
      "export interface Box",
      "export type IndicatorPlacement",
      "export const UNDERLINE_HEIGHT = 2",
      "export function indicatorRect(",
      "export function sameBox(",
    ],
    "indicatorRect",
  );
});

test("KPI 数字：值变化才重挂载并播放 value-settle", () => {
  const cellAt = chainKpi.indexOf("data-chain-kpi-value");
  assert.ok(cellAt >= 0, "ChainKpiCell missing data-chain-kpi-value");
  const cell = chainKpi.slice(cellAt - 200, cellAt + 500);
  includes(cell, ["key={value}", "value-settle"], "ChainKpi value");

  includes(
    overview,
    [
      "settleKey",
      "key={settleKey}",
      "value-settle",
      "settleKey={`${scopedOnline}/${scopedTotal}`}",
      "settleKey={`${stats.users.total}/${stats.packages.instances}`}",
      'settleKey={`${chains?.total ?? "—"}`}',
      'settleKey={`${todayBytes ?? "—"}`}',
    ],
    "Overview KpiCard",
  );
  // 外层 Link 不重挂载：key 只在内层数值节点上。
  assert.doesNotMatch(overview, /<Link[\s\S]{0,80}key=/);
});

test("十个图表文件都改走 useChartEnterAnimation", () => {
  for (const file of CHART_FILES) {
    const source = read(file);
    assert.ok(
      !source.includes("isAnimationActive={false}"),
      `${file} still disables animation`,
    );
    includes(
      source,
      ["useChartEnterAnimation", "chartEnter"],
      file,
    );
    includes(
      source,
      [
        "isAnimationActive={chartEnter.isAnimationActive}",
        "animationDuration={chartEnter.animationDuration}",
        "animationEasing={chartEnter.animationEasing}",
        "onAnimationEnd={chartEnter.onAnimationEnd}",
      ],
      file,
    );
  }
});

test("图表入场 hook：220ms、ease-out、620ms 兜底、尊重 reduced-motion", () => {
  includes(
    chartHook,
    [
      "export const CHART_ENTER_MS = 220",
      "usePrefersReducedMotion",
      "animationEasing: \"ease-out\"",
      "620",
      "setTimeout",
      "setEntered(true)",
      "isAnimationActive: !reduced && !entered",
    ],
    "useChartEnterAnimation",
  );
});
