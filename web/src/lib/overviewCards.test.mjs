import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const overview = read("../pages/Overview.tsx");
const shell = read("../components/overview/OverviewInsight.tsx");
const server = read("../components/overview/ServerHealthView.tsx");
const traffic = read("../components/overview/TrafficView.tsx");
const cost = read("../components/overview/CostView.tsx");
const chain = read("../components/overview/ChainLatencyView.tsx");

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

test("tab 顺序与默认值：服务器状态 / 流量 / 成本开销 / 链路时延", () => {
  assertIncludes(shell, ['value="server"', 'value="traffic"', 'value="cost"', 'value="chain"'], "OverviewInsight");
  // 默认 view 不写参数，由 overviewViews 的纯函数保证；这里再确认默认 tab 是 server。
  assertIncludes(shell, ["resolveOverviewView(searchParams.get(\"view\"))"], "OverviewInsight");
  assertIncludes(overview, ["data-overview-insight-section"], "Overview page");
});

test("tab 只保留文字，移除前面的小图标", () => {
  assert.ok(!shell.includes("LucideIcon"), "tab shell should not import icon types");
  assert.ok(!shell.includes("<Icon"), "tab shell should not render an icon");
});

test("全局 KPI 在 tab 之上，Overview 页面不再直接渲染旧卡片", () => {
  assertIncludes(overview, ["<OverviewInsight stats={stats} />"], "Overview page");
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

test("服务器状态 tab：热力图 / 当前资源 / 异常窗口，不含趋势、分布、排行、链健康", () => {
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

test("流量 tab：趋势 / 分布 / 排行 / 告警，不含链健康与成本卡", () => {
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

test("成本 tab：三数字 / 付款日历 / Top 5 / 币种构成 / 一次性，不含流量与链卡", () => {
  assertIncludes(
    cost,
    [
      "overview.cost.total",
      "overview.cost.calendarTitle",
      "overview.cost.topTitle",
      "overview.cost.mixTitle",
      "overview.cost.oneTimeTitle",
      "<PaymentCalendarCard",
      "<TopCostCard",
      "<CurrencyMixCard",
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
