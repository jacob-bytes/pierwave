import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const detail = read("../components/overview/ChainLatencyDetail.tsx");
const card = read("../components/overview/ChainFlowCard.tsx");
const flow = read(
  "../components/overview/chain-template-flow/ChainTemplateFlow.tsx",
);
const flowCard = read(
  "../components/overview/chain-template-flow/FlowCard.tsx",
);
const flowEdge = read(
  "../components/overview/chain-template-flow/FlowEdge.tsx",
);
const flowContext = read(
  "../components/overview/chain-template-flow/context.ts",
);
const flowHeader = read(
  "../components/overview/chain-template-flow/FlowColumnHeader.tsx",
);
const css = read("../index.css");
const graphLib = read("../lib/chainTemplateGraph.ts");
const detailLib = read("../lib/chainFlowGraph.ts");
const healthLib = read("../lib/chainHealth.ts");
const zh = read("../i18n/zh-CN.ts");
const en = read("../i18n/en.ts");
const packageJson = JSON.parse(read("../../package.json"));

function includes(source, patterns, label) {
  for (const pattern of patterns) {
    assert.ok(source.includes(pattern), `${label} missing: ${pattern}`);
  }
}

test("链路详情改用 ChainFlowCard，旧条带标记与旧拓扑函数全部消失", () => {
  includes(detail, ["<ChainFlowCard", "data-chain-detail"], "detail");
  for (const marker of [
    "data-chain-topology",
    "ChainTopologyCard",
    "ChainOverallStats",
    "TopologyNode",
    "TopologyEdge",
    "MemberDot",
    "topologyNodeLabel",
    "chainTopologyNodeTone",
    "chainTopologyMemberRows",
    "chainTopologyNodeTier",
  ]) {
    assert.ok(!detail.includes(marker), `ChainLatencyDetail still has ${marker}`);
  }
  for (const symbol of [
    "CHAIN_TOPOLOGY_MEMBER_ROWS",
    "ChainTopologyMemberRows",
    "chainTopologyMemberRows",
    "ChainTopologyNodeTier",
    "CHAIN_TOPOLOGY_NODE_HEIGHT_PX",
    "chainTopologyNodeTier",
    "chainTopologyNodeTone",
    "chainWorstNodeTone",
    "chainNodeStatusTone",
    "ChainNodeStatusTone",
  ]) {
    assert.ok(!healthLib.includes(symbol), `chainHealth still exports ${symbol}`);
  }
  // 组节点保留 server_id，多成员列才有「首选」可判。
  includes(healthLib, ["serverId: trimmedString(raw.server_id)"], "chainHealth");
});

test("ChainFlowCard：整链统计 / 恢复默认 / 缩放栏 / 空态 / 目标缺失提示 / kind=chain", () => {
  includes(
    card,
    [
      "data-chain-flow",
      "data-chain-overall-stats",
      "data-chain-loss-summary",
      "data-chain-flow-reset",
      "data-template-flow-reset",
      "data-template-flow-zoom",
      "data-flow-zoom-out",
      "data-flow-zoom-in",
      "data-flow-zoom-value",
      "data-flow-zoom-fit",
      "showsFitHint(zoom)",
      'translate("overview.chainTemplateInsight.flowFitHint"',
      'translate("overview.chainTemplateInsight.flowReset"',
      "overview.chainLatency.noSamplesShort",
      "topology.targetMissing && !lastHopUnmeasurable",
      "overview.chainLatency.missingLastHop",
      'kind="chain"',
      "<Suspense",
      "<ChainTemplateFlowLazy",
      "ariaLabel={translate(",
      "overview.chainLatency.flowTopologyAria",
      "buildChainFlowGraph(chain",
    ],
    "ChainFlowCard",
  );
});

test("画布 kind：默认 template，链路档用紧凑 metrics / 无 pulse / 不隐藏密集药丸", () => {
  includes(
    flow,
    [
      'kind = "template"',
      'const chain = kind === "chain"',
      "CHAIN_FLOW_METRICS",
      "TEMPLATE_METRICS",
      "pulse: !chain",
      "densePillLimit: chain ? null : TEMPLATE_PILL_DENSE_LIMIT",
      "defaultTemplatePath(folded)",
      "carrierTemplateEdges(folded)",
      "data-template-flow-kind={kind}",
      '"--template-pill-width"',
      "templateCanvasHeight(",
      "metrics.rowGap * 2",
      "metrics.padding",
    ],
    "ChainTemplateFlow",
  );
  includes(
    flowContext,
    ['kind: "template" | "chain"', "carrierEdges: ReadonlySet<string> | null"],
    "context",
  );
  includes(
    flowHeader,
    [
      "header.title !== undefined && header.title.trim() !== \"\"",
      "? header.title",
      ": headerLabel(header, t)",
      "chainColumnPlan(",
      "overview.chainLatency.flowBalanced",
      "overview.chainLatency.flowStrategyChoose",
    ],
    "column header title",
  );
});

test("链路卡片：首选 / 候选、目标不画点、空名显示链目标、虚线目标卡", () => {
  includes(
    flowCard,
    [
      "const chain = interaction?.kind === \"chain\"",
      "overview.chainLatency.flowPreferred",
      "overview.chainLatency.flowCandidate",
      "overview.chainLatency.flowActive",
      "overview.chainLatency.flowPathTag",
      "data-chain-tag-text",
      'data-flow-target": chain && isTarget ? "" : undefined',
      "data-chain-tag",
      "const showChainDot = chain && !isTarget && card.status !== \"unknown\"",
      "overview.chainLatency.chainTarget",
      "overview.chainLatency.flowChainCardAria",
      "data-chain-flow-card-tooltip",
    ],
    "FlowCard chain branch",
  );
  includes(css, ["[data-template-flow-card][data-flow-target]"], "target card css");
  // 模板卡片仍渲染状态文字，链路卡片没有。
  assert.ok(flowCard.includes("data-template-flow-status-text"));
});

test("链路连线：药丸只在点亮 / 载体边，点亮线宽 3，1s march 只在可用点亮线", () => {
  includes(
    flowEdge,
    [
      "const chain = interaction?.kind === \"chain\"",
      "chainPillVisible",
      "interaction?.highlight == null && carrier",
      "tabIndex={chain ? (pillVisible ? 0 : -1) : 0}",
      "strokeWidth={chain && hot ? 3 : edge.width}",
      "chain && hot && !edge.unavailable",
      "data-template-flow-march",
      "template-flow-march",
      "edge.estimated ? `≈${value}` : value",
      "overview.chainLatency.flowSegmentLoss",
      "overview.chainLatency.flowSegmentAria",
      "overview.chainLatency.flowChainMergedTooltip",
      "data-chain-flow-edge-note",
    ],
    "FlowEdge chain branch",
  );
  includes(
    css,
    [
      ".template-flow-pill {",
      "width: var(--template-pill-width, 44px)",
      "@keyframes template-flow-march-flow",
      "animation: template-flow-march-flow 1s linear infinite",
      ".template-flow-march {",
    ],
    "css",
  );
  // reduced-motion 下 march 静止（整段必须出现 animation: none）。
  const marchStart = css.indexOf(".template-flow-march {");
  const reduced = css.indexOf("@media (prefers-reduced-motion: reduce)", marchStart);
  assert.ok(marchStart >= 0 && reduced > marchStart, "march reduced-motion block");
  const block = css.slice(reduced, reduced + 220);
  assert.match(block, /animation: none !important/);
});

test("纯逻辑：首选路径 / 载体边 / 每段一个药丸都由 lib 提供", () => {
  includes(
    graphLib,
    [
      "export function preferredTemplatePath(",
      "export function activeTemplatePath(",
      "export function defaultTemplatePath(",
      "export function carrierTemplateEdges(",
      "export const TEMPLATE_METRICS",
      "export const CHAIN_FLOW_METRICS",
      "metrics?: TemplateMetrics",
      "pulse?: boolean",
      "densePillLimit?: number | null",
    ],
    "chainTemplateGraph",
  );
  includes(
    detailLib,
    [
      "export function buildChainFlowGraph(",
      "cf:${node.seq}:__node",
      "cf:${node.seq}:__target",
      "cfe:${topologyEdge?.seq",
      "chainTemplateMemberStatus",
      "chainTopologyEdgeEstimated",
      "chainLastHopUnmeasurable",
      "isChainBalancedStrategy",
      "activeServerId",
    ],
    "chainFlowGraph",
  );
});

test("没有新增依赖：@xyflow/react 仍锁 exact，dependencies 原样", () => {
  assert.equal(packageJson.dependencies["@xyflow/react"], "12.12.1");
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
    "@fontsource-variable/geist",
    "@hookform/resolvers",
    "@tanstack/react-query",
    "@xyflow/react",
    "class-variance-authority",
    "cn",
    "lucide-react",
    "qrcode.react",
    "radix-ui",
    "react",
    "react-dom",
    "react-hook-form",
    "react-router-dom",
    "recharts",
    "shadcn",
    "sonner",
    "tw-animate-css",
    "zod",
  ]);
  for (const source of [card, flow, flowCard, flowEdge, detailLib]) {
    assert.ok(!source.includes("import("), "no dynamic third-party dependency");
  }
});

test("文案键增删：7 个新键中英成对，4 个旧键两边都删掉", () => {
  const added = [
    "flowTopologyAria",
    "flowPreferred",
    "flowCandidate",
    "flowSegmentLoss",
    "flowSegmentAria",
    "flowChainCardAria",
    "flowChainMergedTooltip",
  ];
  const removed = [
    "topologyScroll",
    "memberMore",
    "memberGroupTitle",
    "memberCountLabel",
  ];
  for (const key of added) {
    assert.ok(zh.includes(`      ${key}:`), `zh missing ${key}`);
    assert.ok(en.includes(`      ${key}:`), `en missing ${key}`);
  }
  for (const key of removed) {
    assert.ok(!zh.includes(`      ${key}:`), `zh still has ${key}`);
    assert.ok(!en.includes(`      ${key}:`), `en still has ${key}`);
  }
});
