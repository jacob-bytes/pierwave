import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const list = read("../components/overview/ChainTemplateInsightList.tsx");
const dialog = read("../components/overview/ChainTemplateInsightDialog.tsx");
const staleNotice = read(
  "../components/overview/ChainTemplateStaleNotice.tsx",
);
const topology = read("../components/overview/ChainTemplateTopology.tsx");
const graphLib = read("../lib/chainTemplateGraph.ts");
const flowIndex = read(
  "../components/overview/chain-template-flow/index.tsx",
);
const flowCanvas = read(
  "../components/overview/chain-template-flow/ChainTemplateFlow.tsx",
);
const flowCard = read(
  "../components/overview/chain-template-flow/FlowCard.tsx",
);
const flowEdge = read(
  "../components/overview/chain-template-flow/FlowEdge.tsx",
);
const flowColumnHeader = read(
  "../components/overview/chain-template-flow/FlowColumnHeader.tsx",
);
const flowContext = read(
  "../components/overview/chain-template-flow/context.ts",
);
const reducedMotionHook = read("../lib/usePrefersReducedMotion.ts");
const packageJson = read("../../package.json");
const usage = read("../components/overview/ChainTemplateUsageChart.tsx");
const strategies = read(
  "../components/overview/ChainTemplateStrategies.tsx",
);
const nodeHeat = read(
  "../components/overview/ChainTemplateNodeHeat.tsx",
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

function assertExcludes(source, patterns, label) {
  for (const pattern of patterns) {
    assert.ok(!source.includes(pattern), `${label} still has: ${pattern}`);
  }
}

/** 只取 `chainTemplateInsight` 这一块，别的区块同名键不算。 */
function i18nBlock(source) {
  const start = source.indexOf("    chainTemplateInsight: {");
  assert.ok(start >= 0, "chainTemplateInsight block");
  const end = source.indexOf("    serverHealth: {", start);
  assert.ok(end > start, "chainTemplateInsight block end");
  return source.slice(start, end);
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
      "title={muted ? t(\"chainTemplates.disabled\") : statusTitle(status)}",
      "statusCause(status.cause)",
    ],
    "status cell",
  );
});

test("停用模板：状态整格降到 muted，不跟着 blocked 变红", () => {
  assertIncludes(
    list,
    [
      "muted = false",
      "/** 停用的模板：整个状态降为 muted，不跟着 blocked 变红。 */",
      'const meta = muted',
      'dot: "bg-muted-foreground/40"',
      'text: "text-muted-foreground"',
      'data-muted={muted ? "true" : undefined}',
      "muted={!item.enabled}",
    ],
    "disabled template status",
  );
  // 停用行仍然保留「已停用」徽章，状态列只负责降噪。
  assertIncludes(list, ['t("chainTemplates.disabled")'], "disabled badge");
});

test("详情弹窗由选中列表项驱动，四块内容都在", () => {
  assertIncludes(
    dialog,
    [
      "<ChainTemplateTopology key={detail.template.id} detail={detail} />",
      "<ChainTemplateUsageChart",
      "<ChainTemplateStrategies detail={detail} />",
      "<ChainTemplateNodeHeat detail={detail} />",
      "data-template-detail-grid",
      "items-start",
      "md:grid-cols-2",
      "md:col-span-2",
      "data-template-dialog",
      "data-template-dialog-meta",
      "metaHops",
      "metaChains",
      'templateFlowCountKey("metaChains", totals.chains)',
      "metaUsers",
      'templateFlowCountKey("metaUsers", totals.users)',
      "useChainTemplateInsight(item?.id ?? null, hours)",
      'const hours = range === "24h" ? 24 : 168',
    ],
    "ChainTemplateInsightDialog",
  );
});

test("拓扑：React Flow 卡片画布，懒加载 + 自定义缩放栏", () => {
  assertIncludes(
    flowIndex,
    [
      'import("./ChainTemplateFlow")',
      "lazy(",
      "export const ChainTemplateFlowLazy",
    ],
    "lazy flow chunk",
  );
  // 拓扑壳里不能静态 import React Flow：否则会进「链路时延」主 chunk。
  assert.equal(
    topology.includes('from "@xyflow/react"'),
    false,
    "ChainTemplateTopology 不能静态 import React Flow",
  );
  assertIncludes(
    topology,
    [
      'from "@/components/overview/chain-template-flow"',
      "<Suspense",
      "<ChainTemplateFlowLazy",
      "buildTemplateGraph(detail)",
      "data-template-unused",
      "data-template-flow-zoom",
      "data-flow-zoom-out",
      "data-flow-zoom-in",
      "data-flow-zoom-value",
      "data-flow-zoom-fit",
      "data-template-fit-hint",
      "showsFitHint(zoom)",
      'translate("overview.chainTemplateInsight.flowFitHint"',
      'translate("overview.chainTemplateInsight.flowFit")',
      'translate("overview.chainTemplateInsight.flowZoomIn")',
      'translate("overview.chainTemplateInsight.flowZoomOut")',
    ],
    "ChainTemplateTopology",
  );
  assertIncludes(
    flowCanvas,
    [
      'from "@xyflow/react"',
      "<ReactFlow",
      "nodeTypes",
      "edgeTypes",
      "<Background",
      "variant={BackgroundVariant.Dots}",
      "attributionPosition",
      "onInit={handleInit}",
      "onMove={handleMove}",
    ],
    "flow canvas",
  );
  // 官方控件（Controls / MiniMap / 缩放按钮）一律不用。
  assert.equal(flowCanvas.includes("<Controls"), false, "不用官方 Controls");
  assert.equal(flowCanvas.includes("<MiniMap"), false, "不用官方 MiniMap");
  assertIncludes(
    graphLib,
    [
      "export function buildTemplateGraph(",
      "export function foldTemplateGraph(",
      "export function layoutTemplateGraph(",
      "export function initialViewport(",
      "export function fitViewport(",
    ],
    "graph lib",
  );
  // 依赖锁 exact，且不引入 13。
  assert.ok(packageJson.includes('"@xyflow/react": "12.12.1"'));
});

test("折叠：+N 只展开本列，目标 +N 挂在目标卡上，恢复默认只在此后出现", () => {
  assertIncludes(
    topology,
    [
      "const [expandedColumns, setExpandedColumns]",
      "const [expandedTargets, setExpandedTargets]",
      "const hasExpanded =",
      "restoreDefaults",
      "data-template-flow-reset",
      'translate("overview.chainTemplateInsight.flowReset")',
    ],
    "expand state",
  );
  assertIncludes(
    flowCard,
    [
      'card.kind === "fold"',
      "aria-expanded={false}",
      "onExpandColumn(card.seq)",
      "onExpandTargets(card.upstreamId)",
      "data-template-flow-target-fold",
      'templateFlowCountKey("foldMembers", card.hidden)',
      'templateFlowCountKey("foldTargets", card.hidden)',
      't("overview.chainTemplateInsight.flowFoldOffline"',
    ],
    "fold card",
  );
  // 折叠规则是纯逻辑：每列 4 张 + 折叠卡；目标每个上游至少 1 张。
  assertIncludes(
    graphLib,
    [
      "export const TEMPLATE_FOLD_LIMIT = 4",
      "if (!expanded && cards.length > columnLimit)",
      "expandedTargets.has(key)",
      "visibleTargets.set(key, [members[0]])",
    ],
    "fold rules",
  );
});

test("连线：直角折线 + 圆角 8 + 两端小圆点 + 合并虚线 + 时延药丸", () => {
  assertIncludes(
    graphLib,
    [
      "export function templateEdgePath(",
      "export const TEMPLATE_EDGE_RADIUS = 8",
      'const merged = sourceCard.kind === "fold" || targetCard.kind === "fold";',
      "export function spreadPills(",
      "export const TEMPLATE_PILL_WIDTH",
      "const onVertical = dy >= TEMPLATE_PILL_HEIGHT + 16",
    ],
    "edge layout",
  );
  assertIncludes(
    flowEdge,
    [
      "data-template-flow-edge",
      "data-chains={edge.chains}",
      "data-width={edge.width}",
      'data-unavailable={edge.unavailable ? "true" : "false"}',
      'data-merged={edge.merged ? "true" : "false"}',
      'data-dashed={edge.dashed ? "true" : "false"}',
      "data-template-flow-dot",
      "data-template-flow-pill",
      "<EdgeLabelRenderer>",
    ],
    "edge render",
  );
  assertIncludes(
    css,
    [
      '.template-flow-edge[data-dashed="true"]',
      '.template-flow-edge[data-status="offline"]',
      ".template-flow-pill {",
    ],
    "edge css",
  );
});

test("列头：每列一个不可交互节点，随缩放平移、不参与高亮", () => {
  // 纯逻辑：列头高度 / 顶边 / 类型 / 布局字段。
  assertIncludes(
    graphLib,
    [
      "export const TEMPLATE_COLUMN_HEADER_HEIGHT = 32",
      "export const TEMPLATE_COLUMN_TOP =",
      "TEMPLATE_PADDING + TEMPLATE_COLUMN_HEADER_HEIGHT",
      "export interface TemplateLayoutHeader {",
      "shown: number;",
      "total: number;",
      "headers: TemplateLayoutHeader[];",
      "let cursor = TEMPLATE_COLUMN_TOP;",
      "TEMPLATE_COLUMN_TOP - minY",
    ],
    "column header layout",
  );
  // 列头节点：注册类型、来自 layout.headers、四个交互标志全 false。
  assertIncludes(
    flowCanvas,
    [
      "FlowColumnHeader",
      "templateColumnHeader:",
      "layout.headers",
      'type: "templateColumnHeader"',
    ],
    "column header nodes",
  );
  const headerNodeStart = flowCanvas.indexOf(
    "layout.headers.map((header) => ({",
  );
  assert.ok(headerNodeStart >= 0, "列头节点必须由 layout.headers 生成");
  const headerNode = flowCanvas.slice(
    headerNodeStart,
    flowCanvas.indexOf("})),", headerNodeStart),
  );
  for (const flag of [
    "draggable: false",
    "selectable: false",
    "focusable: false",
    "connectable: false",
  ]) {
    assert.ok(headerNode.includes(flag), `列头节点缺少 ${flag}`);
  }
  // 列头 DOM：aria-hidden、四个 data 属性、三段文字，不带头像高亮 / 卡片标记。
  assertIncludes(
    flowColumnHeader,
    [
      "data-template-flow-column-header",
      "data-column={header.seq}",
      "data-role={header.role}",
      "data-shown={header.shown}",
      "data-total={header.total}",
      'aria-hidden="true"',
      "data-template-flow-column-label",
      "data-template-flow-column-count",
      "data-strategy={header.strategy ?? undefined}",
      "data-template-flow-column-rule",
      'translate("overview.chainTemplateInsight.flowColumnNodes"',
      'translate("overview.chainTemplateInsight.flowColumnNodesOne"',
      'translate("overview.chainTemplateInsight.flowColumnNodesFolded"',
      'translate("overview.chainTemplateInsight.flowColumnTargets"',
      'translate("overview.chainTemplateInsight.flowColumnTargetsOne"',
      'translate("overview.chainTemplateInsight.flowColumnTargetsFolded"',
      // 列名 / 计数同色，只靠字重区分；细线在列头内上移 6px 离开卡片。
      'className="min-w-0 truncate font-medium"',
      'className="shrink-0 text-muted-foreground tabular-nums"',
      "style={{ paddingBottom: TEMPLATE_COLUMN_LABEL_PADDING }}",
      "style={{ bottom: TEMPLATE_COLUMN_RULE_GAP }}",
    ],
    "column header dom",
  );
  assertExcludes(
    flowColumnHeader,
    [
      "data-template-flow-card",
      "data-hot",
      "tabIndex",
      // 旧的淡色计数与贴底细线都是这次要修掉的状态。
      "text-muted-foreground/50",
      "pb-1",
      "bottom-0",
    ],
    "column header interaction",
  );
  // 列头只读、不可点：CSS 明确 pointer-events: none。
  assertIncludes(
    css,
    ["[data-template-flow-column-header] {", "pointer-events: none;"],
    "column header css",
  );
  // 卡片副标题不再重复列名；aria-label 与折叠卡 tooltip 仍保留列名。
  assertExcludes(
    flowCard,
    ["`${role} · ${chains} · ${users}`", "`${role} · ${chains}`"],
    "card subtitle role prefix",
  );
  assertIncludes(
    flowCard,
    [
      "subtitle: `${chains} · ${users}${offline}`",
      "subtitle:\n      card.kind === \"target\" && card.hidden > 0",
      ": `${chains} · ${users}`,",
      'templateFlowCountKey("chains", card.chains)',
      'templateFlowCountKey("users", card.users)',
      'templateFlowCountKey("foldMembers", card.hidden)',
      'templateFlowCountKey("foldTargets", card.hidden)',
      'templateFlowCountKey("targetFoldAria", card.hidden)',
      "role: roleLabel(card, t),",
      "{roleLabel(card, t)}",
    ],
    "card subtitle without role",
  );
});

test("手势：滚轮滚弹窗、Ctrl/⌘ 缩放、双击不缩放、平移有限范围", () => {
  assertIncludes(
    flowCanvas,
    [
      "zoomOnScroll={false}",
      "preventScrolling={false}",
      "zoomOnDoubleClick={false}",
      "zoomOnPinch={false}",
      "panOnDrag={!compact}",
      "translateExtent={compact ? undefined : translateExtent}",
      "minZoom={compact ? 1 : TEMPLATE_MIN_ZOOM}",
      "maxZoom={compact ? 1 : TEMPLATE_MAX_ZOOM}",
      "event.ctrlKey",
      "event.metaKey",
      "clampTemplateZoom(",
      "stepTemplateZoom(viewport.zoom, 1)",
    ],
    "gestures",
  );
  assertIncludes(
    graphLib,
    [
      "export const TEMPLATE_MIN_ZOOM = 0.4",
      "export const TEMPLATE_MAX_ZOOM = 1.6",
      "export const TEMPLATE_FIT_HINT_ZOOM = 0.9",
      "export function templateContentBounds(",
      "export function templateFitZoom(",
      "clamp(fit, TEMPLATE_MIN_ZOOM, TEMPLATE_FIT_MAX_ZOOM)",
      "return fitViewport(layout, size);",
    ],
    "zoom bounds",
  );
  assertIncludes(
    css,
    [".react-flow__pane {", "touch-action: pan-y"],
    "touch action",
  );
  // 390：1 倍 + 横向滚动，画布不缩放。
  assertIncludes(
    flowCanvas,
    ['"(max-width: 639px)"', "overflow-x-auto", "height: layout.height"],
    "compact scroll",
  );
});

test("可访问性：Tab 可达、aria 带状态、tooltip 用现有组件", () => {
  assertIncludes(
    flowCard,
    [
      "tabIndex={0}",
      "aria-label={aria}",
      "<TooltipTrigger asChild>",
      'side="top"',
      "useI18n()",
      't("overview.chainTemplateInsight.flowCardAria"',
    ],
    "card a11y",
  );
  assertIncludes(flowEdge, ['role="img"', "aria-label={aria}"], "edge a11y");
  assertIncludes(
    flowCanvas,
    ['role="group"', "aria-label={translate(", "<TooltipProvider"],
    "canvas a11y",
  );
  assertIncludes(
    topology,
    ["focus-visible:ring-2", "disabled={flowApi === null"],
    "keyboard controls",
  );
});

test("性能：动画边 ≤10、脉冲一条 path、reduced-motion 静止可见", () => {
  assertIncludes(
    graphLib,
    [
      "export const TEMPLATE_PULSE_LIMIT = 10",
      ".slice(0, TEMPLATE_PULSE_LIMIT)",
    ],
    "pulse cap",
  );
  assertIncludes(
    flowEdge,
    ["data-template-flow-pulse", "pathLength={100}"],
    "pulse path",
  );
  assertIncludes(
    css,
    [
      "@keyframes template-flow-pulse-flow",
      "stroke-opacity: 0.42",
      "animation: none !important",
    ],
    "reduced motion",
  );
  // 高亮只重渲染读 context 的卡片 / 连线，nodes / edges 引用保持稳定。
  assertIncludes(
    flowCanvas,
    ["useMemo<Node[]>(", "useMemo<Edge[]>("],
    "memo nodes",
  );
  assertIncludes(flowContext, ["createContext"], "interaction context");
});

test("React Flow 署名保留，12px muted，不隐藏", () => {
  assertIncludes(
    css,
    [
      ".react-flow__attribution {",
      "font-size: 12px",
      "color: var(--muted-foreground)",
    ],
    "attribution",
  );
  assert.equal(
    flowCanvas.includes("hideAttribution: true"),
    false,
    "不能隐藏 React Flow 署名",
  );
});

test("F2 离线边：不给当前 P50，lastP50Ms 只做「最近已知」", () => {
  assertIncludes(
    graphLib,
    [
      "p50Ms: unavailable ? null : p50,",
      "lastP50Ms: unavailable ? p50 : null,",
    ],
    "unavailable edge",
  );
  assertIncludes(
    flowEdge,
    ['if (edge.unavailable || edge.p50Ms === null) return "—";'],
    "pill value",
  );
  assertIncludes(
    css,
    ['.template-flow-pill[data-status="offline"]', "color: var(--destructive)"],
    "unavailable pill",
  );
});

test("F7 状态四档：degraded 标黄、不 pulse、有文字", () => {
  assertIncludes(
    flowCard,
    [
      'if (status === "degraded") return "bg-warning";',
      'if (status === "degraded") return "text-warning";',
      'translate("overview.chainTemplateInsight.degraded")',
      'translate("overview.chainTemplateInsight.online")',
      'translate("overview.chainTemplateInsight.offline")',
    ],
    "status",
  );
  assertIncludes(
    css,
    [
      '.template-flow-edge[data-status="degraded"]',
      '.template-flow-pill[data-status="degraded"]',
    ],
    "degraded color",
  );
  // 降级 / 不可用路径不脉冲：脉冲候选过滤掉它们。
  assertIncludes(
    graphLib,
    ["!edge.merged && !edge.unavailable && !edge.degraded && edge.chains > 0"],
    "pulse filter",
  );
});

test("F9 0 链拓扑显示空态，不渲染画布", () => {
  assertIncludes(
    topology,
    [
      "graph.empty",
      "<EmptyState",
      'translate("overview.chainTemplateInsight.emptyTopologyTitle")',
      "WaypointsIcon",
    ],
    "empty topology",
  );
  assertIncludes(
    graphLib,
    ["const empty = columns.every((column) => column.members.length === 0);"],
    "empty graph",
  );
});

test("F9 403 不当作旧主控，只 404 降级", () => {
  const insight = read("../lib/chainTemplateInsight.ts");
  assertIncludes(
    insight,
    ["return error instanceof ApiError && error.status === 404;"],
    "404 only",
  );
  assertExcludes(insight, ["error.status === 404 || error.status === 403"], "403 degrade");
  assertIncludes(queries, ["403 是权限问题，照常报错。"], "queries comment");
});

test("F9 死代码与未使用 i18n 清掉", () => {
  const insight = read("../lib/chainTemplateInsight.ts");
  assertExcludes(
    insight,
    ["nodeHeatTier", "edgeStrokeWidth", "edgeStrokeOpacity", "MAX_TEMPLATE_HEAT_TIERS", "templateTargetLabels"],
    "dead insight helpers",
  );
  assertExcludes(graphLib, ["maxEdgeChains"], "dead tree field");
  const zhBlock = i18nBlock(zh);
  const enBlock = i18nBlock(en);
  for (const key of [
    "heatLegend",
    "topologyHeatHint",
    "topologyHintWidth",
    "topologyHintP50",
    "topologyHintPulse",
    "usageCurrentNote",
    "hotspotsExpand",
    "hotspotsCollapse",
    "hotspotsTitle",
    "hotspotNode",
    "hotspotChains",
    "hotspotUsers",
    "targetMore",
    "targetNone",
    "hopLabel",
    "sourceLabel",
    "targetLabel",
    "detailLoading",
    "memberCount",
    "chainsValue",
    "topologyScroll",
  ]) {
    assert.ok(!zhBlock.includes(`${key}:`), `zh still has ${key}`);
    assert.ok(!enBlock.includes(`${key}:`), `en still has ${key}`);
  }
});

test("F9 成员去重键用 serverId ?? name", () => {
  assertIncludes(
    graphLib,
    [
      "function memberIdentity(member: ChainTemplateMember): string {",
      'const serverId = member.serverId ?? "";',
      'return serverId !== "" ? serverId : member.name;',
      "const identity = memberIdentity(member);",
    ],
    "member identity",
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

test("策略摘要：最常用策略 + 链数（+ 种类数），数据只来自 strategies", () => {
  assertIncludes(
    strategies,
    [
      "chainTemplateStrategySummary(detail.strategies)",
      "data-template-strategies-summary",
      "strategiesSummary",
      "strategiesSummaryKinds",
      "summary.kinds > 1",
      "chainTemplateStrategyLabelKey(summary.top.strategy)",
      "summary.top.chains",
      't("overview.chainTemplateInsight.strategiesSummary"',
    ],
    "strategies summary",
  );
  // 摘要不能新增接口字段；只用现有 strategies。
  assertExcludes(
    strategies,
    ["useQuery(", "fetch(", "detail.summary"],
    "strategies summary data source",
  );
  const insight = read("../lib/chainTemplateInsight.ts");
  assertIncludes(
    insight,
    [
      "export function chainTemplateStrategySummary(",
      "kinds: shares.length",
      "item.chains > best.chains ? item : best",
    ],
    "summary logic",
  );
});

test("节点热度：横向条形图而非表格 / 饼图，Top5 + 条宽 + 状态 + 空态", () => {
  assertIncludes(
    nodeHeat,
    [
      "data-template-node-heat-card",
      "data-template-node-heat",
      "data-template-heat-row",
      "data-template-heat-bar",
      "data-width={Math.round(barPct * 100) / 100}",
      "style={{ width: `${barPct}%` }}",
      "chainTemplateNodeHeat(detail)",
      "data-template-node-heat-tooltip",
      'translate("overview.chainTemplateInsight.nodeHeatShare")',
      "data-template-node-heat-empty",
      "data-template-heat-status",
      "tabular-nums",
      "bg-primary",
      "bg-muted-foreground/40",
      "formatPercentValue(sharePct)",
    ],
    "ChainTemplateNodeHeat",
  );
  // 不画饼图：同一节点会被多条链重复计入，扇区之和没有业务含义。
  assertExcludes(nodeHeat, ["<table", "<thead", "<tbody", "PieChart", "recharts"], "node heat markup");
  // Top 5 / 条宽 / 占比 / 状态合并都在纯逻辑层，组件不重复实现。
  assertIncludes(
    read("../lib/chainTemplateInsight.ts"),
    [
      "export function chainTemplateNodeHeat(",
      "MEMBER_STATUS_PRIORITY",
      "barPct:",
      "sharePct:",
      'offline: member.status === "offline"',
    ],
    "node heat logic",
  );
});

test("节点热度浮层：绝对定位、不进文档流、翻转夹紧、键盘与 Esc", () => {
  assertIncludes(
    nodeHeat,
    [
      'from "@/lib/nodeHeatTooltip"',
      "placeNodeHeatTooltip({",
      'className="relative',
      "absolute",
      "pointer-events-none",
      'role="tooltip"',
      "aria-describedby={",
      "activeKey === row.key ? tooltipId : undefined",
      'const tooltipId = useId()',
      'visibility: placement === null ? "hidden" : "visible"',
      "offsetWidth",
      "offsetHeight",
      "useLayoutEffect",
      "ResizeObserver",
      'window.addEventListener("resize", measure)',
      "onFocus={",
      "onMouseEnter={",
      "onMouseLeave={",
      '"Escape"',
      "onKeyDownCapture",
      'window.addEventListener("keydown", onKeyDownCapture, true)',
      "event.preventDefault()",
      "event.stopPropagation()",
      "setActiveKey(null)",
      "tabIndex={0}",
    ],
    "node heat overlay",
  );
  // 旧实现用 `hidden` / `group-hover:block` 在文档流里展开，会拉高整张卡片。
  assertExcludes(
    nodeHeat,
    ["group-hover:block", "group-focus:block", "hidden rounded-md border"],
    "in-flow tooltip",
  );
  // 浮层必须挂在 `<ul>` 之外，否则多出一个非 `<li>` 子节点，也更容易被行高带走。
  const ulStart = nodeHeat.indexOf("data-template-node-heat\n");
  const ulEnd = nodeHeat.indexOf("</ul>", ulStart);
  const tooltipAt = nodeHeat.lastIndexOf("data-template-node-heat-tooltip");
  assert.ok(ulStart >= 0 && ulEnd > ulStart, "node heat list");
  assert.ok(tooltipAt > ulEnd, "tooltip must render outside the list");
});

test("布局：使用量独占一行，策略分布 | 节点热度同排自然高度，390 单列", () => {
  assertIncludes(
    dialog,
    [
      'className="grid grid-cols-1 items-start gap-4 md:grid-cols-2"',
      'className="md:col-span-2"',
    ],
    "two-row grid",
  );
  // 不再为了对齐底边把策略卡拉到与节点热度等高：多出来的只能是大片空白。
  assertExcludes(dialog, ["items-stretch"], "stretch alignment");
  assertExcludes(dialog, ["lg:grid-cols-3", "md:grid-cols-3"], "three-column grid");
  // 顺序必须是使用量 → 策略分布 → 节点热度，390 才可以只靠单列堆叠。
  const usageAt = dialog.indexOf("<ChainTemplateUsageChart");
  const strategiesAt = dialog.indexOf("<ChainTemplateStrategies");
  const heatAt = dialog.indexOf("<ChainTemplateNodeHeat");
  assert.ok(
    usageAt >= 0 && usageAt < strategiesAt && strategiesAt < heatAt,
    "card order must be usage → strategies → node heat",
  );
  // 折线需要横向空间：图高 260–300，不再用 220/240。
  assertIncludes(
    usage,
    ['className="h-[260px] w-full sm:h-[280px]"', "h-[260px]", "sm:h-[280px]"],
    "usage chart height",
  );
  assertExcludes(usage, ["h-[220px]", "h-[240px]"], "old usage height");
});

test("接口路径与 404 降级集中在查询层", () => {
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
    "strategiesSummary",
    "strategiesSummaryKinds",
    "nodeHeatTitle",
    "nodeHeatEmpty",
    "nodeHeatShare",
    "nodeHeatAria",
    "nodeHeatListAria",
    "causeMemberOffline",
    "causeDisabled",
    "online",
    "offline",
    "degraded",
    "unknownStatus",
    "flowEntry",
    "flowTarget",
    "flowHop",
    "flowFoldMembers",
    "flowFoldMembersOne",
    "flowFoldTargets",
    "flowFoldTargetsOne",
    "flowFoldOffline",
    "flowFoldListTitle",
    "flowTargetListTitle",
    "flowCardAria",
    "flowEdgeAria",
    "flowTargetFoldAria",
    "flowTargetFoldAriaOne",
    "flowChains",
    "flowChainsOne",
    "metaChains",
    "metaChainsOne",
    "metaUsers",
    "metaUsersOne",
    "usersValue",
    "usersValueOne",
    "flowMoreColumns",
    "flowMoreColumnsAria",
    "flowMoreBelow",
    "flowMoreBelowAria",
    "flowColumnNodes",
    "flowColumnNodesOne",
    "flowColumnNodesFolded",
    "flowColumnTargets",
    "flowColumnTargetsOne",
    "flowColumnTargetsFolded",
    "flowZoomIn",
    "flowZoomOut",
    "flowFit",
    "flowFitHint",
    "flowReset",
    "topologyAria",
    "unusedTitle",
    "tooltipStatus",
    "tooltipChains",
    "tooltipUsers",
    "chainsUnit",
    "edgeUnavailable",
    "edgeLastKnown",
    "edgeDegradedHint",
    "emptyTopologyTitle",
    "emptyTopologyDesc",
    "staleNotice",
    "usageExistingChainsBasis",
  ];
  for (const key of keys) {
    assert.ok(zh.includes(`${key}:`), `zh missing ${key}`);
    assert.ok(en.includes(`${key}:`), `en missing ${key}`);
  }
  assertIncludes(zh, ['sectionTitle: "转发链模板"'], "zh title");
  assertIncludes(en, ['sectionTitle: "Chain templates"'], "en title");
  // 新增的降级 / 缩放 / 空态文案也要中英成对。
  assertIncludes(
    zh,
    [
      'degraded: "降级"',
      'flowFit: "适应窗口"',
      'flowFitHint: "已缩小到 {percent}%，可点击 + 放大"',
      'flowReset: "恢复默认"',
      'emptyTopologyTitle: "暂无流量"',
      'flowColumnNodes: "{n} 台"',
      'flowColumnNodesOne: "1 台"',
      'flowColumnNodesFolded: "{shown} / {total} 台"',
      'flowColumnTargets: "{n} 个"',
      'flowColumnTargetsOne: "1 个"',
      'flowColumnTargetsFolded: "{shown} / {total} 个"',
      'flowChains: "{n} 条链"',
      'flowChainsOne: "{n} 条链"',
      'metaChains: "{n} 条链"',
      'metaChainsOne: "{n} 条链"',
      'metaUsers: "{n} 个用户"',
      'metaUsersOne: "{n} 个用户"',
      'usersValue: "{n} 用户"',
      'usersValueOne: "{n} 用户"',
      'flowFoldMembers: "+{n} 台"',
      'flowFoldMembersOne: "+{n} 台"',
      'flowFoldTargets: "+{n} 个目标"',
      'flowFoldTargetsOne: "+{n} 个目标"',
    ],
    "zh new keys",
  );
  assertIncludes(
    en,
    [
      'degraded: "Degraded"',
      'flowFit: "Fit to view"',
      'flowFitHint: "Zoomed to {percent}%; use + to zoom in"',
      'flowReset: "Reset view"',
      'emptyTopologyTitle: "No traffic yet"',
      'flowColumnNodes: "{n} nodes"',
      'flowColumnNodesOne: "1 node"',
      'flowColumnNodesFolded: "{shown} / {total} nodes"',
      'flowColumnTargets: "{n} targets"',
      'flowColumnTargetsOne: "1 target"',
      'flowColumnTargetsFolded: "{shown} / {total} targets"',
      'flowChains: "{n} chains"',
      'flowChainsOne: "{n} chain"',
      'metaChains: "{n} chains"',
      'metaChainsOne: "{n} chain"',
      'metaUsers: "{n} users"',
      'metaUsersOne: "{n} user"',
      'usersValue: "{n} users"',
      'usersValueOne: "{n} user"',
      'flowFoldMembers: "+{n} nodes"',
      'flowFoldMembersOne: "+{n} node"',
      'flowFoldTargets: "+{n} targets"',
      'flowFoldTargetsOne: "+{n} target"',
    ],
    "en new keys",
  );
});

test("模板 stale 提示与使用量口径图注：读新字段，缺失时不出", () => {
  // stale=true 才出现；stale_reason 放 title，不占版面。
  assertIncludes(
    dialog,
    ["<ChainTemplateStaleNotice detail={detail} />"],
    "stale notice wired",
  );
  assertIncludes(
    staleNotice,
    [
      "data-template-stale",
      "detail.template.stale",
      "detail.template.staleReason ?? undefined",
      't("overview.chainTemplateInsight.staleNotice")',
    ],
    "stale notice",
  );
  // 图注只在 series_basis = existing_chains 时出现。
  assertIncludes(
    usage,
    [
      "data-template-usage-basis",
      'detail.seriesBasis === "existing_chains"',
      't("overview.chainTemplateInsight.usageExistingChainsBasis")',
    ],
    "usage basis",
  );
  assertIncludes(
    zh,
    [
      'staleNotice: "模板已修改，以下按现有链的实际路径展示"',
      'usageExistingChainsBasis: "按当前存在的链回填，删除链后历史会下降"',
    ],
    "zh new contract copy",
  );
  assertIncludes(
    en,
    [
      "The template has changed; the view below follows the actual paths of existing chains",
      "Backfilled from the chains that exist now; deleting a chain lowers the history",
    ],
    "en new contract copy",
  );
  // 未使用候选只来自契约字段，不再从 nodes 反推。
  assertIncludes(graphLib, ["detail.unusedCandidates.map"], "unused candidates");
  assertExcludes(
    graphLib,
    ["const usedSourceIdentities = new Set(", "drafts.has(`${node.seq}::${identity}`)"],
    "unused candidates derived from nodes",
  );
});

test("画布收尾：底部提示 / 减弱动效平移 / 折叠卡跳数 / 连线高亮", () => {
  // 右缘 / 下缘提示都用纯函数判断（缩放、平移后重算）。
  assertIncludes(
    flowCanvas,
    [
      "hiddenRightColumns(layout, size, viewport)",
      "hasHiddenContentBelow(layout, size, viewport)",
      "data-template-flow-more-below",
      "data-template-flow-fade-below",
      "data-pan-duration={panDuration}",
      "const panBelow = useCallback(",
      "TEMPLATE_PAN_RATIO",
    ],
    "overflow hints",
  );
  assertIncludes(
    graphLib,
    [
      "export function hiddenRightColumns(",
      "export function hasHiddenContentBelow(",
      "export function templatePanDuration(",
      "export const TEMPLATE_PAN_DURATION_MS = 220",
    ],
    "viewport hint logic",
  );
  // 减弱动效：JS 驱动的平移动画要单独读媒体查询（CSS 规则管不到）。
  assertIncludes(
    reducedMotionHook,
    [
      '"(prefers-reduced-motion: reduce)"',
      "useSyncExternalStore",
      "export function usePrefersReducedMotion(",
    ],
    "reduced motion hook",
  );
  assertIncludes(
    flowCanvas,
    ["usePrefersReducedMotion()", "templatePanDuration(prefersReducedMotion)"],
    "reduced motion wiring",
  );
  // 折叠卡 tooltip 标题补回跳数；卡片副标题仍是「X 条链 · Y 用户 · 含 N 台离线」。
  assertIncludes(
    flowCard,
    [
      "data-template-flow-fold-title",
      "{roleLabel(card, t)}",
      't("overview.chainTemplateInsight.flowFoldListTitle"',
      'translate("overview.chainTemplateInsight.flowFoldOffline"',
    ],
    "fold tooltip hop",
  );
  // 连线 hover / focus 点亮到入口：与卡片同一个 highlight 集合。
  assertIncludes(
    flowContext,
    ["activeEdgeId", "activateEdge", "deactivateEdge", "id?: string"],
    "edge interaction context",
  );
  assertIncludes(
    flowEdge,
    [
      "activateEdge(edge.id)",
      "deactivateEdge(edge.id)",
      "onPointerEnter={activateHighlight}",
      "onFocus={activateHighlight}",
      "onOpenChange={onTooltipOpenChange}",
      'matches(":hover")',
      "data-hot={hotAttribute}",
      "data-edge-id={edge.id}",
    ],
    "edge highlight wiring",
  );
  // 药丸跟着路径一起压暗：与连线共用 data-hot，隐藏的密集药丸不被提前显示。
  assertIncludes(
    css,
    [
      '[data-template-flow-pill][data-hot="false"]:not([data-pill-hidden="true"])',
      '[data-template-flow-pill][data-hot="true"]',
    ],
    "pill dim styling",
  );
  // 渐隐层必须留在 React Flow 根节点内（与署名同一个 stacking context），
  // 署名再抬到 z-6，才能既盖内容又不压暗署名。
  assert.ok(
    flowCanvas.indexOf("data-template-flow-fade-below") <
      flowCanvas.indexOf("</ReactFlow>"),
    "fade layers must live inside the React Flow root",
  );
  assertIncludes(flowCanvas, ["z-[5]"], "fade z-index inside the flow root");
  assertIncludes(
    css,
    [".react-flow__attribution {", "z-index: 6 !important;"],
    "attribution stacking",
  );
  assertIncludes(
    graphLib,
    [
      "export function highlightTemplateEdgePath(",
      "walkUpstream(",
    ],
    "edge highlight logic",
  );
});
