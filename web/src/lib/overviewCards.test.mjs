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
const chainSectionTabs = read(
  "../components/overview/ChainSectionTabs.tsx",
);
const uptimeTrend = read(
  "../components/overview/ServerUptimeTrendChart.tsx",
);
const chainList = read("../components/overview/ChainLatencyList.tsx");
const chainDetail = read("../components/overview/ChainLatencyDetail.tsx");
const chainDialog = read("../components/overview/ChainLatencyDetailDialog.tsx");
const chainTrend = read("../components/overview/ChainLatencyTrendChart.tsx");
const chainSegmentChart = read(
  "../components/overview/ChainSegmentTrendChart.tsx",
);
const line = read("../components/overview/ResourceLineChart.tsx");
const fxPopover = read("../components/overview/FxDetailsPopover.tsx");
const scopeHook = read("../components/overview/useOverviewScope.ts");
const api = read("../lib/api.ts");
const queries = read("../lib/queries.ts");
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

test("热力图只保留在线率，不再有资源指标切换", () => {
  const heatmap = server.slice(
    server.indexOf("function HeatmapCard"),
    server.indexOf("function CurrentResourcesCard"),
  );
  assert.ok(
    !heatmap.includes("resolveHeatmapMetric"),
    "heatmap should not resolve a metric",
  );
  // 头部新增的是「呈现方式」（热力图 / 趋势），不是负载 / 内存 / 硬盘切换。
  assert.ok(
    !heatmap.includes("RESOURCE_METRICS"),
    "heatmap should not render resource metric tabs",
  );
  assertIncludes(
    heatmap,
    [
      "data-uptime-mode-tabs",
      "overview.serverHealth.uptimeModeHeatmap",
      "overview.serverHealth.uptimeModeTrend",
    ],
    "HeatmapCard mode switch",
  );
  assertIncludes(css, ["@utility heatmap-step-0", "@utility heatmap-step-4"], "heatmap scale");
});

test("服务器 × 时间：趋势视图由 URL 的 mode 驱动，默认是趋势", () => {
  assertIncludes(
    server,
    [
      'searchParams.get("mode")',
      "resolveServerHealthMode",
      "applyServerHealthMode",
      "buildUptimeTrend",
      "<ServerUptimeTrendChart",
      "approximate={snapshot.approximateUptime}",
    ],
    "ServerHealthView",
  );
  // 旧主控缺桶内 online_ratio 时，趋势和热力图用同一个「近似」标记。
  assertIncludes(
    uptimeTrend,
    [
      "overview.serverHealth.legendApproximate",
      "overview.serverHealth.legendApproximateHint",
      "data-uptime-approx",
      "formatOnlineCount",
      "connectNulls={false}",
    ],
    "ServerUptimeTrendChart",
  );
});

test("资源图是折线图，不是面积图", () => {
  assertIncludes(line, ["<Line", "LineChart", "defaultVisibleIds"], "ResourceLineChart");
  assertExcludes(line, ["<Area", "AreaChart"], "ResourceLineChart");
});

test("成本汇率明细收在 popover，正常汇率并入图表卡头的 CNY 标签", () => {
  assertIncludes(
    cost,
    [
      "FxWarning",
      "data-cost-fx",
      "costFxMode",
      "fxMode === \"warning\"",
      "triggerLabel",
    ],
    "CostView",
  );
  assertExcludes(
    cost,
    ["FxSummary", "fxShort", "fxAllCny", "fxRatesInline", "UnknownCurrencyWarning"],
    "CostView",
  );
  assertIncludes(
    fxPopover,
    [
      "buildFxDetails",
      "data-fx-row",
      "data-fx-unknown",
      "max-h-64",
      "triggerLabel",
      "onPointerEnter",
    ],
    "FxDetailsPopover",
  );
});

test("F4：无汇率时仍可打开明细，并说明缺哪些币种与去哪里配置", () => {
  assertIncludes(
    cost,
    ["overview.cost.fxMissing", "<FxDetailsPopover"],
    "CostView",
  );
  // 不能像旧实现那样在 !fx.provided 时直接 return 掉 popover。
  const fxWarning = cost.slice(
    cost.indexOf("function FxWarning"),
    cost.indexOf("function MonthExpenseCard"),
  );
  assert.ok(
    !fxWarning.includes("if (!fx.provided) {"),
    "FxWarning must not early-return without the popover",
  );
  assertIncludes(
    fxPopover,
    [
      "data-fx-missing",
      "data-fx-missing-hint",
      "overview.cost.fxNotConfigured",
      "overview.cost.fxHowToConfigure",
      "overview.cost.unknownCurrencies",
    ],
    "FxDetailsPopover",
  );
});

test("成本金额统一为「代码 + 空格 + 数字」，占比 <1%，纵轴整齐步长", () => {
  assertExcludes(cost, ["¥", "toFixed(0)", "formatCnyCompact"], "CostView");
  assertIncludes(
    cost,
    [
      "formatSharePercent",
      "buildCostAxisTicks",
      "formatCnyAxisTick",
      "data-cost-axis",
      "data-cost-axis-tick",
      "data-cost-share",
    ],
    "CostView",
  );
  // 一次性费用只在底部说明一次，卡头不再挂「不计入本年度」徽章。
  assertExcludes(cost, ["overview.cost.oneTimeBadge"], "CostView");
  assert.equal(
    cost.split('t("overview.cost.oneTimeHint")').length - 1,
    1,
    "one-time hint must appear exactly once",
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

test("成本 tab：三数字 / 12 个月开销柱状图 / Top 3 / 币种构成 / 一次性，不含流量与链卡", () => {
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
      "RenewalDayDialog",
      "data-renewal-dialog",
      "data-currency-pie",
      "topViewAll",
      "data-cost-top-dialog",
      "data-mix-summary",
      "data-renewal-month-select",
      "data-renewal-year-select",
      "oneTimeEmpty",
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
      "data-renewal-tooltip",
    ],
    "CostView",
  );
});

test("链路 tab：子页（转发链 / 转发模板）由 URL 的 section 驱动", () => {
  assertIncludes(
    chain,
    [
      "resolveChainSection(searchParams.get(\"section\"))",
      'section === "templates"',
      "<ChainTemplateInsightList />",
    ],
    "ChainLatencyView",
  );
  // 子 tab 在主 tab 行、服务器筛选右侧，且只在链路时延 tab 渲染。
  assertIncludes(
    shell,
    ["<ChainSectionTabs", 'view === "chain"'],
    "OverviewInsight",
  );
  assertIncludes(
    chainSectionTabs,
    [
      "applyChainSection",
      "resolveChainSection",
      "data-chain-section-tabs",
      "overview.chainLatency.sections.chains",
      "overview.chainLatency.sections.templates",
      "shrink-0",
    ],
    "ChainSectionTabs",
  );
});

test("链路 tab：详情改弹窗，列表只剩 KPI / 趋势 / 表格", () => {
  assertIncludes(
    chain,
    [
      "useChainHealth",
      "useChainLatency",
      "data-chain-list-page",
      "<ChainLatencyList",
      "<ChainLatencyDetailDialog",
      "chains={scopedChains}",
      "onClose={closeChain}",
      "searchParams.get(\"chain\")",
      "next.set(\"chain\"",
      "next.delete(\"chain\"",
    ],
    "ChainLatencyView",
  );
  // 不再整页切换 detail，也不再另起「转发链健康」卡。
  assertExcludes(
    chain,
    [
      "overview.chainLatency.soon",
      "ChainPlaceholderCard",
      "data-chain-detail-page",
      "ChainHealthCard",
      "data-chain-health-card",
      "chainHealthRows",
      "overview.trendTitle",
      "overview.distributionTitle",
      "overview.leaderboardTitle",
      "overview.cost.total",
      "<TrendCard",
      "DistributionCard",
      "LeaderboardCard",
      "PaymentCalendarCard",
    ],
    "ChainLatencyView",
  );

  assertIncludes(
    chainDialog,
    [
      "DialogContent",
      "data-chain-dialog",
      "data-chain-dialog-scroll",
      "ChainLatencyDetail",
      "onOpenChange",
      "onClose",
      "overview.chainLatency.dialogDesc",
    ],
    "ChainLatencyDetailDialog",
  );

  assertIncludes(
    chainList,
    [
      "overview.chainLatency.hopP50",
      "overview.chainLatency.slowChains",
      "overview.chainLatency.worstHop",
      "CHAIN_HEALTH_STATE_META",
      "chainHealthState",
      "overview.chainLatency.windowLoss",
      "overview.chainLatency.colEndpoint",
      "overview.chainLatency.colRoute",
      "overview.chainLatency.colHops",
      "overview.chainLatency.colStatus",
      "ChainLatencyTrendChart",
      "data-chain-trend-card",
      "data-chain-list",
      "data-chain-list-head",
      "data-chain-list-row",
      "data-chain-loss",
      "data-chain-endpoints",
      "data-chain-hops",
      "data-chain-row-lead",
      "data-chain-row-route",
      "data-chain-row-metrics",
      "chainRoutePreview",
      "data-chain-status",
      "chainEndpointAddress",
      "overview.chainLatency.listTitle",
    ],
    "ChainLatencyList",
  );
  // 列表行不再放迷你图；列表页也不能出现逐段明细 / 诊断 / 拓扑。
  assertExcludes(
    chainList,
    [
      "ChainLatencySparkline",
      "data-chain-sparkline",
      "data-chain-segment",
      "data-chain-topology",
      "SegmentRow",
      "chainDiagnosis",
      "diagnosisSingle",
      "chain.segments",
    ],
    "ChainLatencyList",
  );

  assertIncludes(
    chainTrend,
    [
      "buildChainTrendData",
      "LineChart",
      "<Line",
      "data-chain-trend-chart",
      "data-series-count",
      "data-visible-count",
      "data-chain-legend-item",
      "overview.chainLatency.legendAria",
      "overview.chainLatency.highest",
      "overview.chainLatency.allHidden",
      "overview.chainLatency.lossAtTime",
      "overview.chainLatency.hoverLossHint",
      "chainLossAt",
      "data-chain-tooltip-loss",
      "data-chain-trend-hint",
    ],
    "ChainLatencyTrendChart",
  );

  assertIncludes(
    chainDetail,
    [
      "data-chain-topology",
      "data-chain-topology-scroll",
      "data-chain-overall-stats",
      "data-chain-loss-summary",
      "data-chain-loss-partial",
      "data-chain-loss-nodata",
      "data-chain-segments",
      "data-chain-segment-contributions",
      "data-chain-segment",
      "data-segment-loss",
      "data-segment-contribution",
      "data-segment-current",
      "ChainSegmentTrendChart",
      "chainTopology",
      "chainDiagnosis",
      "overview.chainLatency.diagnosisSingle",
      "overview.chainLatency.missingLastHop",
      "overview.chainLatency.overallTitle",
      "overview.chainLatency.topologyScroll",
      "overview.chainLatency.lossPartial",
      "overview.chainLatency.lossNoData",
      "overview.chainLatency.currentWindowLoss",
      "overview.chainLatency.windowLossProbes",
    ],
    "ChainLatencyDetail",
  );
  // 逐段不再是表格行：每段一张卡片 + 折线图，详情里不能出现 table 语义。
  assertExcludes(
    chainDetail,
    ["<table", "<thead", "<tbody", "<tr", "<td"],
    "ChainLatencyDetail",
  );
  assertIncludes(
    chainSegmentChart,
    [
      "LineChart",
      "<Line",
      "data-chain-segment-chart",
      "data-segment-legend",
      "data-segment-legend-item",
      "data-segment-tooltip",
      "data-segment-tooltip-p50",
      "data-segment-tooltip-loss",
      "formatLossPct",
      "lossAtTime",
      "segmentSeries",
      "allSegmentsHidden",
      "lowest",
    ],
    "ChainSegmentTrendChart",
  );
});

test("链路时延接口带 hours/bucket/server_ids，404 降级为需要新版本主控", () => {
  assertIncludes(
    api,
    [
      "chainHealth: (",
      "/api/v1/overview/chain-health",
      "server_ids",
      "OverviewChainHealthResponse",
    ],
    "api",
  );
  assertIncludes(
    queries,
    [
      "queryKeys.chainHealth",
      "useChainHealth",
      "isChainHealthUnsupported",
      "CHAIN_HEALTH_POLL_MS",
      "query.state.data === null",
    ],
    "queries",
  );
  assertIncludes(
    chain,
    [
      "query.data === null",
      "status === \"unsupported\"",
      "overview.chainLatency.unsupportedTitle",
      "segmentTrends",
      "latency.data",
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
      "selectedIds={scope.selectedIds}",
      "filtered={scope.filtered}",
      "<TrafficView",
      "<CostView selectedIds={scope.selectedIds} />",
      "<ChainLatencyView",
      "filtered={scope.filtered}",
    ],
    "OverviewInsight",
  );
  // 筛选器从资源状态 KPI 区移除，不再有独立的筛选行。
  assertExcludes(server, ["<ServerFilter", "data-server-filter-row"], "ServerHealthView");
});

test("四个视图都按选中集合过滤，空选时走空态", () => {
  assertIncludes(
    server,
    ["filtered", "useServerHealth", "overview.scope.emptyTitle"],
    "ServerHealthView",
  );
  // F2：筛选后的 KPI 直接用后端 summary，不再前端丢 summary 重算。
  assertExcludes(server, ["scopeServerHealthSnapshot"], "ServerHealthView");
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
    [
      "filterChainsByScope",
      "ChainScopeEmpty",
      "useChainHealth",
      "selectedIds",
    ],
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
  // F1/F9：全选删除参数，空选保留空串。
  assertIncludes(
    scopeHook,
    ["serverIdsSelectionParam", 'next.delete("servers")', 'next.set("servers", value)'],
    "useOverviewScope",
  );
  assertIncludes(
    zh,
    ['trigger: "已选 {selected}/{total}"', 'emptyTitle: "未选择服务器"'],
    "zh-CN",
  );
  assertIncludes(
    en,
    ['trigger: "Selected {selected}/{total}"', 'emptyTitle: "No servers selected"'],
    "en",
  );
});

test("F2：server-health 走后端筛选与后端 summary", () => {
  assertIncludes(
    api,
    ["serverIds: readonly string[] = []", 'params.set("server_ids"'],
    "api.ts",
  );
  assertIncludes(
    queries,
    ["queryKeys.serverHealth(hours, bucket, serverIds)"],
    "queries.ts",
  );
  assertIncludes(
    server,
    [
      "scoped ? selectedIds : []",
      "snapshot.approximateUptime",
      "overview.serverHealth.legendApproximate",
      "overview.serverHealth.legendApproximateHint",
    ],
    "ServerHealthView",
  );
  // F9：全选时四个视图都不传 server_ids。
  assertIncludes(traffic, ["filtered ? selectedIds : []"], "TrafficView");
  assertIncludes(overview, ["scope.filtered ? scope.selectedIds : []"], "Overview page");
});

test("F5：scope 未 ready 显示骨架，失败显示错误 + 重试", () => {
  assertIncludes(
    overview,
    ["scope.isError", "scope.refetch", "!scope.ready", "servers.loadFailed"],
    "Overview page",
  );
});

test("F6：全站口径标注与未知 id 提示只消费一次", () => {
  assertIncludes(
    traffic,
    [
      "aggregateGlobal",
      "overview.scope.sitewide",
      "data-alert-sitewide",
      "data-alert-card-sitewide",
    ],
    "TrafficView",
  );
  assertIncludes(
    overview,
    ["warnings?.unknown_ids", "data-overview-unknown-ids", "overview.scope.unknownIds"],
    "Overview page",
  );
});

test("热力图浮层无延迟：悬停 / 聚焦 / 触摸都走受控浮层", () => {
  const heatmap = server.slice(
    server.indexOf("function HeatmapCard"),
    server.indexOf("function CurrentResourcesCard"),
  );
  assertIncludes(
    heatmap,
    [
      "data-heatmap-tooltip",
      "onMouseEnter",
      "onPointerDown",
      "pointerType",
      "onFocus",
      "tipRef",
    ],
    "HeatmapCard",
  );
  // 原生 title 有 1–3 秒延迟，不能再挂在格子上。
  assert.ok(
    !heatmap.includes("title={label}"),
    "heatmap cells must not use the native title delay",
  );
});

test("续费日历单元格居中、日期 14px、徽标 11px", () => {
  const renewal = cost.slice(
    cost.indexOf("function RenewalCalendarCard"),
    cost.indexOf("function RenewalDayDialog"),
  );
  assertIncludes(
    renewal,
    [
      "min-h-11",
      "items-center justify-center",
      "text-center text-sm",
      "text-[11px]",
    ],
    "RenewalCalendarCard",
  );
  assert.ok(
    !renewal.includes("flex-col items-start"),
    "renewal cells must not align to the top-left",
  );
});

test("币种构成环形图 ≥260px，图例字号调大且 390 上下堆叠", () => {
  assertIncludes(
    cost,
    [
      "h-[280px]",
      "max-w-[300px]",
      'outerRadius="92%"',
      "sm:grid-cols-[minmax(0,45fr)_minmax(0,55fr)]",
      "data-pie-legend-code",
      "text-sm",
      "text-[13px]",
      "data-pie-center-amount",
      "text-lg",
    ],
    "CostView",
  );
});

test("成本页两行共用同一套三列网格，底部注释统一 12px", () => {
  assertIncludes(
    cost,
    [
      "xl:grid-cols-3",
      'className="xl:col-span-2"',
      'className="h-full xl:col-span-2"',
      'data-cost-note="excluded"',
      'data-cost-note="once"',
      'data-cost-note="mix"',
      'data-cost-note="renewal"',
      "text-xs leading-normal text-muted-foreground",
    ],
    "CostView",
  );
  // 两行不能再各自定义不同列宽。
  assert.ok(
    !cost.includes("xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"),
    "cost rows must share the same 3-column grid",
  );
});

test("F7：续费日历卡头可换行，不裁掉最后一个箭头", () => {
  const renewal = cost.slice(
    cost.indexOf("function RenewalCalendarCard"),
    cost.indexOf("function RenewalDayDialog"),
  );
  assertIncludes(
    renewal,
    ["data-renewal-controls", "flex-wrap", "data-renewal-next"],
    "RenewalCalendarCard",
  );
  assert.ok(
    !renewal.includes('className="flex min-w-0 items-center justify-between gap-2"'),
    "renewal header must wrap instead of overflow",
  );
});
