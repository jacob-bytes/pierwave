import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const overview = read("../pages/Overview.tsx");
const shell = read("../components/overview/OverviewInsight.tsx");
const serverFilter = read("../components/overview/ServerFilter.tsx");
const server = read("../components/overview/ServerHealthView.tsx");
const traffic = read("../components/overview/TrafficView.tsx");
const cost = read("../components/overview/CostView.tsx");
const chain = read("../components/overview/ChainLatencyView.tsx");
const line = read("../components/overview/ResourceLineChart.tsx");
const fxPopover = read("../components/overview/FxDetailsPopover.tsx");
const css = read("../index.css");
const zh = read("../i18n/zh-CN.ts");
const en = read("../i18n/en.ts");

function assertIncludes(source, patterns, label) {
  for (const pattern of patterns) {
    assert.ok(source.includes(pattern), `${label} missing: ${pattern}`);
  }
}

function assertExcludes(source, patterns, label) {
  for (const pattern of patterns) {
    assert.ok(!source.includes(pattern), `${label} should not include: ${pattern}`);
  }
}

test("tab 顺序与默认值：资源状态 / 流量趋势 / 成本开支 / 链路时延", () => {
  assertIncludes(shell, ['value="server"', 'value="traffic"', 'value="cost"', 'value="chain"'], "OverviewInsight");
  // 默认 view 不写参数，由 overviewViews 的纯函数保证；这里再确认默认 tab 是 server。
  assertIncludes(shell, ["resolveOverviewView(searchParams.get(\"view\"))"], "OverviewInsight");
  assertIncludes(overview, ["data-overview-insight-section"], "Overview page");
});

test("tab 显示名：资源状态 / 流量趋势 / 成本开支 / 链路时延", () => {
  assertIncludes(zh, ['server: "资源状态"', 'traffic: "流量趋势"', 'cost: "成本开支"'], "zh-CN");
  assertIncludes(en, ['server: "Resource status"', 'traffic: "Traffic trends"', 'cost: "Cost spend"'], "en");
});

test("热力图只保留在线率，不再有指标切换", () => {
  const heatmap = server.slice(
    server.indexOf("function HeatmapCard"),
    server.indexOf("function CurrentResourcesCard"),
  );
  assert.ok(!heatmap.includes("TabsTrigger"), "heatmap should not render metric tabs");
  assert.ok(
    !heatmap.includes("resolveHeatmapMetric"),
    "heatmap should not resolve a metric",
  );
  assertIncludes(css, ["@utility heatmap-step-0", "@utility heatmap-step-4"], "heatmap scale");
});

test("资源图是折线图，不是面积图", () => {
  assertIncludes(line, ["<Line", "LineChart", "defaultVisibleIds"], "ResourceLineChart");
  assertExcludes(line, ["<Area", "AreaChart"], "ResourceLineChart");
});

test("成本汇率明细收在 popover，默认不铺完整汇率表", () => {
  assertIncludes(cost, ["FxSummary", "data-cost-fx"], "CostView");
  assertExcludes(cost, ["fxRatesInline", "UnknownCurrencyWarning"], "CostView");
  assertIncludes(
    fxPopover,
    ["buildFxDetails", "data-fx-row", "data-fx-unknown", "max-h-64"],
    "FxDetailsPopover",
  );
});

test("tab 只保留文字，移除前面的小图标", () => {
  assert.ok(!shell.includes("LucideIcon"), "tab shell should not import icon types");
  assert.ok(!shell.includes("<Icon"), "tab shell should not render an icon");
});

test("全局 KPI 在 tab 之上，Overview 页面不再直接渲染旧卡片", () => {
  assertIncludes(
    overview,
    ["<OverviewInsight stats={stats} scope={scope} />"],
    "Overview page",
  );
  assertExcludes(
    overview,
    [
      "TrendCard",
      "DistributionCard",
      "LeaderboardCard",
      "ChainHealthCard",
      "AlertRow",
    ],
    "Overview page",
  );
});

test("资源状态 tab：热力图 / 当前资源 / 异常窗口，不含趋势、分布、排行、链健康", () => {
  assertIncludes(
    server,
    [
      "overview.serverHealth.heatmapTitle",
      "overview.serverHealth.currentTitle",
      "overview.serverHealth.anomalyTitle",
    ],
    "ServerHealthView",
  );
  assertExcludes(
    server,
    [
      "overview.trendTitle",
      "overview.distributionTitle",
      "overview.leaderboardTitle",
      "overview.chainHealth",
      "overview.alerts",
      "TrendCard",
      "DistributionCard",
      "LeaderboardCard",
      "ChainHealthCard",
    ],
    "ServerHealthView",
  );
});

test("流量趋势 tab：趋势 / 分布 / 排行 / 告警，不含链健康与成本卡", () => {
  assertIncludes(
    traffic,
    [
      "overview.trendTitle",
      "overview.distributionTitle",
      "overview.leaderboardTitle",
      "overview.alerts",
      "<TrendCard",
      "<DistributionCard",
      "<LeaderboardCard",
      "<AlertRow",
    ],
    "TrafficView",
  );
  assertExcludes(
    traffic,
    ["ChainHealthCard", "PaymentCalendarCard", "overview.cost.total"],
    "TrafficView",
  );
});

test("成本 tab：三数字 / 12 个月开销柱状图 / Top 5 / 币种构成 / 一次性，不含流量与链卡", () => {
  assertIncludes(
    cost,
    [
      "overview.cost.total",
      "overview.cost.calendarTitle",
      "overview.cost.topTitle",
      "overview.cost.mixTitle",
      "overview.cost.renewalTitle",
      "overview.cost.oneTimeTitle",
      "<MonthExpenseCard",
      "<MonthBarChart",
      "data-cost-bar-chart",
      "<TopCostCard",
      "<CurrencyMixCard",
      "<RenewalCalendarCard",
      "<OneTimeCard",
    ],
    "CostView",
  );
  assertExcludes(
    cost,
    [
      "overview.trendTitle",
      "overview.distributionTitle",
      "overview.leaderboardTitle",
      "overview.chainHealth",
      "overview.alerts",
      "PaymentCalendarCard",
      "data-cost-calendar",
      "CalendarCell",
    ],
    "CostView",
  );
});

test("链路 tab：转发链健康 + 即将上线占位，不含其它 tab 的卡片", () => {
  assertIncludes(
    chain,
    [
      "overview.chainHealth",
      "overview.chainLatency.title",
      "overview.chainLatency.emptyTitle",
      "<ChainHealthCard",
      "<ChainPlaceholderCard",
    ],
    "ChainLatencyView",
  );
  assertExcludes(
    chain,
    [
      "overview.trendTitle",
      "overview.distributionTitle",
      "overview.leaderboardTitle",
      "overview.cost.total",
      "TrendCard",
      "DistributionCard",
      "LeaderboardCard",
      "PaymentCalendarCard",
    ],
    "ChainLatencyView",
  );
});


test("服务器筛选在 tab 行，四个 tab 共用同一份选中集合", () => {
  assertIncludes(
    shell,
    [
      'border-l border-border',
      "<ServerFilter",
      "selectedIds={scope.selectedIds}",
      "onChange={scope.setSelectedIds}",
      "<ServerHealthView selectedIds={scope.selectedIds} />",
      "<TrafficView",
      "<CostView selectedIds={scope.selectedIds} />",
      "<ChainLatencyView selectedIds={scope.selectedIds} />",
    ],
    "OverviewInsight",
  );
  // 筛选器从资源状态 KPI 区移除，不再有独立的筛选行。
  assertExcludes(server, ["<ServerFilter", "data-server-filter-row"], "ServerHealthView");
});

test("四个视图都按选中集合过滤，空选时走空态", () => {
  assertIncludes(
    server,
    ["scopeServerHealthSnapshot", "overview.scope.emptyTitle"],
    "ServerHealthView",
  );
  assertIncludes(
    cost,
    ["selectedIds", "buildCostOverview(scopedServers", "EmptyCostScope"],
    "CostView",
  );
  assertIncludes(
    traffic,
    ["selectedIds", "useOverview(", "TrafficEmptyScope", "trafficNeedsUpgrade"],
    "TrafficView",
  );
  assertIncludes(
    chain,
    ["filterChainsByScope", "chainHealthStatus", "InsightMetrics", "ChainScopeEmpty"],
    "ChainLatencyView",
  );
});

test("服务器筛选是统一折叠树：没有三选一模式，组支持半选", () => {
  assertExcludes(
    serverFilter,
    ["data-server-filter-mode", "overview.scope.modeAll", "overview.scope.modeGroup", "overview.scope.modeCustom"],
    "ServerFilter",
  );
  assertIncludes(
    serverFilter,
    [
      "data-server-filter-section",
      "data-server-filter-group",
      "aria-expanded",
      'groupState',
      '"indeterminate"',
      "toggleGroup",
      "visibleServers",
      "ArrowDown",
      "Escape",
    ],
    "ServerFilter",
  );
  assertIncludes(serverFilter, ["toggleExpanded", "expanded.has"], "ServerFilter");
});

test("URL 保存筛选结果，切 tab 时保留 servers 参数", () => {
  assertIncludes(
    shell,
    ['applyOverviewView(previous, resolveOverviewView(value))'],
    "OverviewInsight",
  );
  assertIncludes(
    zh,
    ['trigger: "已选 {selected}/{total}"', 'defaultHint:', 'emptyTitle: "未选择服务器"'],
    "zh-CN",
  );
  assertIncludes(
    en,
    ['trigger: "Selected {selected}/{total}"', "defaultHint:", 'emptyTitle: "No servers selected"'],
    "en",
  );
});
