import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const list = read("../components/overview/ChainTemplateInsightList.tsx");
const dialog = read("../components/overview/ChainTemplateInsightDialog.tsx");
const topology = read("../components/overview/ChainTemplateTopology.tsx");
const usage = read("../components/overview/ChainTemplateUsageChart.tsx");
const strategies = read(
  "../components/overview/ChainTemplateStrategies.tsx",
);
const view = read("../components/overview/ChainLatencyView.tsx");
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

test("链路时延 tab 底部挂载转发链模板区块", () => {
  assertIncludes(
    view,
    [
      'import { ChainTemplateInsightList } from "@/components/overview/ChainTemplateInsightList"',
      "<ChainTemplateInsightList />",
    ],
    "ChainLatencyView",
  );
  // 无链时模板列表仍要出现：否则「模板无链」边界直接消失。
  assertIncludes(view, ["parsed.status === \"empty\"", "<NoChainsCard scoped={scoped} />"], "empty branch");
});

test("列表五列与可点击行：模板名 / 跳数 / 链数 / 用户数 / 状态", () => {
  assertIncludes(
    list,
    [
      't("overview.chainTemplateInsight.colName")',
      't("overview.chainTemplateInsight.colHops")',
      't("overview.chainTemplateInsight.colChains")',
      't("overview.chainTemplateInsight.colUsers")',
      't("overview.chainTemplateInsight.colStatus")',
      "data-chain-template-row",
      "onClick={onOpen}",
      "<ChainTemplateInsightDialog",
      't("overview.chainTemplateInsight.emptyTitle")',
      't("overview.chainTemplateInsight.unsupportedTitle")',
    ],
    "ChainTemplateInsightList",
  );
  assertIncludes(
    list,
    [
      "bg-primary",
      "bg-warning",
      "bg-destructive",
      "title={statusTitle(status)}",
      "statusCause(status.cause)",
    ],
    "status cell",
  );
});

test("详情弹窗由选中列表项驱动，四块内容都在", () => {
  assertIncludes(
    dialog,
    [
      "<ChainTemplateTopology detail={detail} />",
      "<ChainTemplateUsageChart",
      "<ChainTemplateStrategies detail={detail} />",
      "data-template-dialog",
      "data-template-dialog-meta",
      "metaHops",
      "metaChains",
      "metaUsers",
      "useChainTemplateInsight(item?.id ?? null, hours)",
      'const hours = range === "24h" ? 24 : 168',
    ],
    "ChainTemplateInsightDialog",
  );
});

test("拓扑：边宽绑定 chains、离线不可用、脉冲与静态高亮并存", () => {
  assertIncludes(
    topology,
    [
      "data-width={edge.width}",
      "data-chains={edge.chains}",
      "data-unavailable={edge.unavailable ? \"true\" : \"false\"}",
      "data-template-pulse",
      "data-template-pulse-static",
      "pathLength={100}",
      "data-template-member",
      "data-heat={member.heat}",
      "data-template-target-node",
      "data-template-target-detail",
      "data-template-hotspots",
      "data-template-node-count",
    ],
    "ChainTemplateTopology",
  );
  assertIncludes(
    css,
    [
      "@keyframes template-pulse-flow",
      ".template-pulse",
      ".template-pulse-static",
      "@media (prefers-reduced-motion: reduce)",
      "animation: none !important",
    ],
    "pulse css",
  );
});

test("使用量 tooltip 列出当前用户，策略只画真实种类", () => {
  assertIncludes(
    usage,
    [
      "data-template-usage-tooltip",
      "data-template-usage-tooltip-users",
      "data-template-usage-user",
      "chainTemplateUsageHasData(data)",
    ],
    "ChainTemplateUsageChart",
  );
  // 确认传的是自定义 tooltip 而不是默认的。
  assertIncludes(usage, ["<UsageTooltip", "active?: boolean"], "usage tooltip");
  assertIncludes(
    strategies,
    ["data-template-strategy-bar", "strategyShares(detail.strategies)", "%"],
    "ChainTemplateStrategies",
  );
});

test("接口路径与 404/403 降级集中在查询层", () => {
  assertIncludes(
    api,
    [
      '"/api/v1/overview/chain-templates"',
      "/api/v1/overview/chain-templates/${encodeURIComponent(id)}?hours=",
      "OverviewChainTemplateListResponse",
      "OverviewChainTemplateDetailResponse",
    ],
    "api",
  );
  assertIncludes(
    queries,
    [
      "useChainTemplateInsights",
      "useChainTemplateInsight",
      "queryKeys.chainTemplateInsight(templateId, hours)",
      "isChainTemplateInsightUnsupported",
      "normalizeChainTemplateList",
      "normalizeChainTemplateDetail",
      "query.state.data === null ? false : 60_000",
    ],
    "queries",
  );
});

test("中英双语键同时存在，不靠英文兜底中文", () => {
  const keys = [
    "sectionTitle",
    "colName",
    "colHops",
    "colChains",
    "colUsers",
    "colStatus",
    "statusOk",
    "statusDegraded",
    "statusBlocked",
    "emptyTitle",
    "unsupportedTitle",
    "usageTitle",
    "usageCurrentUsers",
    "strategiesTitle",
    "hotspotsTitle",
    "causeMemberOffline",
    "causeDisabled",
    "heatLegend",
  ];
  for (const key of keys) {
    assert.ok(zh.includes(`${key}:`), `zh missing ${key}`);
    assert.ok(en.includes(`${key}:`), `en missing ${key}`);
  }
  assertIncludes(zh, ['sectionTitle: "转发链模板"'], "zh title");
  assertIncludes(en, ['sectionTitle: "Chain templates"'], "en title");
});
