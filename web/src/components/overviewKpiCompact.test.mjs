/**
 * 概览 KPI 收紧 + 顶部全局 KPI 合并的源码级回归。
 *
 * 这些是跨组件的视觉 / 数据契约（同一高度、同一文案、同一个数据来源），
 * 纯函数测不到，运行时几何在 `web/screenshots/overview-kpi-compact/shots.mjs`
 * 里用 Playwright 断言；这里锁住源码里的阈值与接线。
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

const kpi = read("components/overview/ChainKpi.tsx");
const overview = read("pages/Overview.tsx");
const insight = read("components/overview/OverviewInsight.tsx");
const server = read("components/overview/ServerHealthView.tsx");
const cost = read("components/overview/CostView.tsx");
const templates = read("components/overview/ChainTemplateKpis.tsx");
const chainView = read("components/overview/ChainLatencyView.tsx");
const zh = read("i18n/zh-CN.ts");
const en = read("i18n/en.ts");

function includes(source, patterns, label) {
  for (const pattern of patterns) {
    assert.ok(source.includes(pattern), `${label} missing: ${pattern}`);
  }
}

test("区块 KPI：去掉 min-h，高度 = 内容 + 固定 padding，副行单行", () => {
  // 不允许再用 min-h 凑高度：同一行由 grid 自动等高，底部只留 padding。
  assert.ok(!kpi.includes("min-h-["), "KPI cell must not set min-h");
  includes(
    kpi,
    [
      "px-3 py-3.5 sm:px-5",
      // 标签 → 数字、数字 → 副行都保持 4px。
      "mt-1 text-[28px]",
      "mt-auto pt-1 line-clamp-1 text-[13px]",
      // 统计口径与字阶：28 / 13 / 12，标签仍是 text-xs。
      "text-[28px]",
      "text-[13px]",
      "truncate text-xs leading-tight text-muted-foreground",
      // 副行单行省略，悬停仍可看到完整文案。
      "title={hint}",
      // 栅格与分隔线不变；长金额换行不设固定高度。
      "grid-cols-2",
      "sm:grid-cols-4",
      "gap-px",
      "break-words",
      "min-w-0",
    ],
    "ChainKpi",
  );
  assert.ok(!kpi.includes("line-clamp-2"), "hint must be single-line");
  assert.ok(!kpi.includes("min-h-[164px]"), "old 164px height must be gone");
  assert.ok(!kpi.includes("xl:min-h-[136px]"), "old 136px height must be gone");
  assert.ok(!kpi.includes("mt-2 text-[28px]"), "old value gap must be gone");
  // 数字 / 副行不得被裁：数值只允许换行，不允许 line-clamp / truncate。
  const valueBlock = kpi.slice(
    kpi.indexOf("data-chain-kpi-value"),
    kpi.indexOf("data-chain-kpi-hint"),
  );
  assert.ok(!valueBlock.includes("line-clamp"), "value must not be clamped");
  assert.ok(!valueBlock.includes("truncate"), "value must not be truncated");
});

test("KPI 骨架与真卡同 padding / 同行高，加载完成不变矮", () => {
  // 共享骨架：三段占位高度 = 16 + 28 + 21，配合 mt-1 ×2 与 py-3.5 ×2
  // 正好 101px，与真实单行 KPI 单元格同高。
  includes(
    kpi,
    [
      "export function ChainKpiSkeletonGrid",
      "data-chain-kpi-skeleton",
      "h-4 w-16",
      "mt-1 h-7 w-14",
      "mt-1 h-[21px] w-24",
      '"min-w-0 bg-card px-3 py-3.5 sm:px-5"',
    ],
    "ChainKpiSkeletonGrid",
  );
  for (const [label, source, expected] of [
    ["OverviewInsight", insight, "<ChainKpiSkeletonGrid />"],
    ["ServerHealthView", server, "<ChainKpiSkeletonGrid cells={3} />"],
    ["CostView", cost, "<ChainKpiSkeletonGrid cells={4} />"],
    ["ChainLatencyView", chainView, "<ChainKpiSkeletonGrid />"],
  ]) {
    assert.ok(source.includes(expected), `${label} skeleton out of sync`);
  }
  // 模板子页保留自己的 data 标记，但 padding / 占位行必须保持一致。
  includes(
    templates,
    [
      "data-chain-template-kpi-skeleton",
      '"min-w-0 bg-card px-3 py-3.5 sm:px-5"',
      "h-4 w-16",
      "mt-1 h-7 w-14",
      "mt-1 h-[21px] w-24",
    ],
    "ChainTemplateKpis skeleton",
  );
  for (const [label, source] of [
    ["OverviewInsight", insight],
    ["ServerHealthView", server],
    ["CostView", cost],
    ["ChainLatencyView", chainView],
    ["ChainTemplateKpis", templates],
  ]) {
    assert.ok(
      !source.includes("h-[281px]") && !source.includes("xl:h-[112px]"),
      `${label} still has a hard-coded KPI skeleton height`,
    );
  }
});

test("顶部四卡：在线服务器 / 用户与套餐 / 转发链 / 今日流量", () => {
  const order = [
    'label={t("overview.onlineServers")}',
    'label={t("overview.usersAndPackages")}',
    'label={t("overview.forwardChains")}',
    'label={t("overview.todayTraffic")}',
  ];
  let cursor = -1;
  for (const pattern of order) {
    const at = overview.indexOf(pattern);
    assert.ok(at > cursor, `top KPI order is wrong at ${pattern}`);
    cursor = at;
  }
  // 合并卡：用户数 / 套餐实例都来自 stats，且带可抓取的数据标记。
  includes(
    overview,
    [
      "data-kpi-users-total>{stats.users.total}",
      "data-kpi-package-instances",
      "stats.packages.instances",
      "overview.usersAndPackagesHint",
      "users: stats.users.total",
      "packages: stats.packages.total",
      "overview.usersUnit",
      "overview.instancesUnit",
    ],
    "merged users & packages card",
  );
  // 空的第四格换成转发链：total / blocked / degraded 全部来自 overview.chains。
  includes(
    overview,
    [
      "chainsOverview.data?.chains",
      "chains?.total",
      "chains?.blocked",
      "chains?.degraded",
      "overview.forwardChains",
      "overview.chainBlocked",
      "overview.chainDegraded",
      "data-kpi-chains-total",
    ],
    "forward chain card",
  );
  assert.ok(
    overview.includes("useOverview(OVERVIEW_TRAFFIC_DAYS)"),
    "chains must come from the existing overview aggregate",
  );
  // 旧的两张卡与 users.active 不应再参与顶部 KPI。
  assert.ok(!overview.includes('label={t("overview.users")}'));
  assert.ok(!overview.includes('label={t("overview.packageInstances")}'));
  assert.ok(!overview.includes("stats.users.active"));
  // 「全局」出现在合并卡与转发链卡上（转发链同样不受服务器筛选影响）。
  const globals = overview.match(/\n\s+global\n\s+\/>/g) ?? [];
  assert.equal(globals.length, 2, "users and chains both carry the global tag");
});

test("新增 KPI 文案中英成对", () => {
  includes(
    zh,
    [
      'usersAndPackages: "用户与套餐"',
      'usersUnit: "用户"',
      'instancesUnit: "实例"',
      'usersAndPackagesHint: "{users} 个用户 · {packages} 个套餐模板"',
      'forwardChains: "转发链"',
      'forwardChainsHint: "阻断 {blocked} · 降级 {degraded}"',
    ],
    "zh-CN",
  );
  includes(
    en,
    [
      'usersAndPackages: "Users & packages"',
      'usersUnit: "users"',
      'instancesUnit: "instances"',
      'usersAndPackagesHint: "{users} users · {packages} package templates"',
      'forwardChains: "Forward chains"',
      'forwardChainsHint: "Blocked {blocked} · degraded {degraded}"',
    ],
    "en",
  );
});
