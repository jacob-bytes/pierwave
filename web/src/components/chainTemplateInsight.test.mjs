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
const treeChart = read("../components/ui/charts/tree-chart.tsx");
const treeLib = read("../lib/treeChart.ts");
const templateTreeLib = read("../lib/chainTemplateTree.ts");
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

test("拓扑：本地 TreeChart 横向树、贝塞尔曲线、折叠与离线路经", () => {
  assertIncludes(
    topology,
    [
      'from "@/components/ui/charts/tree-chart"',
      "<TreeChart",
      "links={model.links}",
      "collapsedIds={collapsed}",
      "onNodeToggle={toggleNode}",
      "pulse",
      "renderTooltip",
      "chainTemplateTree(detail",
      "data-template-unused",
      "data-template-hotspots",
      "data-template-tree-tooltip",
      "tooltipStatus",
      "tooltipChains",
      "tooltipUsers",
      'translate("overview.chainTemplateInsight.treeTargetsFold"',
    ],
    "ChainTemplateTopology",
  );
  assertIncludes(
    treeChart,
    [
      'data-tree-node',
      'data-tree-edge',
      'data-tree-edge-label',
      'data-tree-hidden-count',
      'data-tree-pulse',
      "data-collapsed=",
      "data-value={edge.value}",
      "data-width={edge.width}",
      'aria-label={ariaLabel}',
      "data-chart-tooltip",
      "renderTooltip",
      "treeHighlightPath",
      "+{layoutNode.hiddenCount}",
    ],
    "TreeChart",
  );
  // 曲线与层级 x 在纯布局层生成；这里守住 C（三次贝塞尔）和 O(n) 行/列。
  assertIncludes(
    treeLib,
    [
      " C ",
      "hiddenCount",
      "treeHighlightPath",
      "treeNodePathToRoot",
      "Math.max(options.minColumnWidth",
    ],
    "tree layout",
  );
  assertIncludes(
    css,
    [
      "@keyframes template-pulse-flow",
      ".template-pulse",
      "@media (prefers-reduced-motion: reduce)",
      "animation: none !important",
    ],
    "pulse css",
  );
});

/* ------------------------------------------------------------------ */
/* F1 目标按父节点分组折叠：拓扑点 +N 只展开这一组，并可收起            */
/* ------------------------------------------------------------------ */

test("F1 折叠按父节点分组可分别展开，卡片头部有「收起目标」", () => {
  assertIncludes(
    topology,
    [
      "chainTemplateTreeNodeMeta(node)",
      'meta?.kind === "fold"',
      "const parentId = meta.foldParent",
      "expandedParents",
      "expandedParents,",
      "data-template-targets-collapse",
      "collapseTargets",
      'translate("overview.chainTemplateInsight.collapseTargets")',
    ],
    "per-parent fold",
  );
});

/* ------------------------------------------------------------------ */
/* F2 离线边不显示当前 P50                                             */
/* ------------------------------------------------------------------ */

test("F2 离线边：标签 —、tooltip 用「最近已知」，aria 同步", () => {
  assertIncludes(
    topology,
    [
      'const unavailable = edge.unavailable || link?.unavailable === true;',
      'const value = unavailable ? "—" : (edge.label ?? "—");',
      "edge.lastP50Ms",
      'translate("overview.chainTemplateInsight.edgeLastKnown"',
      '"overview.chainTemplateInsight.edgeUnavailable"',
      "edgeAriaExtra(edge, link, translate)",
    ],
    "unavailable edge",
  );
  // 边标签本身由模型决定：不可用边固定 —，不再把历史 P50 当当前值。
  assertIncludes(
    read("../lib/chainTemplateTree.ts"),
    [
      "CHAIN_TEMPLATE_UNAVAILABLE_LABEL",
      "lastP50Ms: item.unavailable ? p50 : null",
    ],
    "unavailable label",
  );
  // 渲染层拿不到 label 时也不把数值贴上去。
  assertIncludes(
    treeChart,
    [
      "function edgeValueText(edge: TreeChartLayoutEdge): string {",
      'if (edge.unavailable) return "—";',
    ],
    "edge aria value",
  );
});

/* ------------------------------------------------------------------ */
/* F7 四档状态：degraded 标黄不脉冲，文案可读                          */
/* ------------------------------------------------------------------ */

test("F7 状态四档：degraded 标黄 / 不 pulse / tooltip 有文字", () => {
  assertIncludes(
    topology,
    [
      'if (status === "degraded") return translate("overview.chainTemplateInsight.degraded");',
      'if (status === "degraded") return "text-warning";',
      "edgeDegradedHint",
      'data-template-tree-tooltip-status={meta.status}',
      'className="inline-flex items-center gap-1"',
      "border-warning",
    ],
    "degraded status",
  );
  assertIncludes(
    treeChart,
    [
      "function isDegraded(node: TreeNode): boolean",
      'statusOf(node) === "degraded"',
      '"var(--warning)"',
      "data-degraded={degraded ? \"true\" : \"false\"}",
    ],
    "degraded accent",
  );
  // 图例除颜色外带文字，离线 / 降级不是只靠颜色区分。
  assertIncludes(topology, ['translate("overview.chainTemplateInsight.online")', 'translate("overview.chainTemplateInsight.offline")'], "legend text");
});

/* ------------------------------------------------------------------ */
/* F3 tooltip 被滚动容器裁切                                           */
/* ------------------------------------------------------------------ */

test("F3 tooltip：实测尺寸 + 可见窗口夹紧，首行翻下方、390 夹回窗口", () => {
  assertIncludes(
    treeChart,
    [
      "useLayoutEffect",
      "element.offsetWidth",
      "element.offsetHeight",
      "placeTreeTooltip({",
      "visibleLeft: scroll?.scrollLeft ?? 0",
      "visibleTop: scroll?.scrollTop ?? 0",
      "visibleWidth: scroll?.clientWidth ?? element.offsetWidth + 16",
      "visibleHeight: scroll?.clientHeight ?? element.offsetHeight + 16",
      'scroll?.addEventListener("scroll", update, { passive: true })',
      'window.addEventListener("resize", update)',
      "visibility: placement === null ? \"hidden\" : \"visible\"",
    ],
    "measured tooltip",
  );
  assertIncludes(
    treeLib,
    [
      "export function placeTreeTooltip(",
      "const below = above < input.visibleTop + margin;",
      "input.anchorX - width / 2",
    ],
    "tooltip placement",
  );
  // 键盘 focus 与 hover 走同一套定位：focus handler 直接 setActive。
  assertIncludes(
    treeChart,
    [
      "const focusNodeAt = useCallback(",
      "const focusEdgeAt = useCallback(",
      "onFocus={focusNodeAt}",
      "onFocus={focusEdgeAt}",
      "tabIndex={0}",
    ],
    "keyboard focus",
  );
});

/* ------------------------------------------------------------------ */
/* F4 脉冲：单条 path + Top N + reduced-motion 同一条 path 静态可见     */
/* ------------------------------------------------------------------ */

test("F4 脉冲：不再渲染静态副本，只保留一条 path；reduced-motion 原路复用", () => {
  // 每条脉冲边只有一条 path：源码里 pulse 的 pathLength 只出现一次。
  assert.equal(
    (treeChart.match(/pathLength=\{100\}/g) ?? []).length,
    1,
    "每条脉冲边只渲染一条 path",
  );
  assertExcludes(treeChart, ["data-tree-pulse-static"], "TreeChart");
  assertExcludes(css, [".template-pulse-static"], "index.css");
  assertIncludes(
    treeChart,
    [
      "selectPulseEdgeIds(layout.edges)",
      'className="template-pulse"',
      'data-tree-pulse',
    ],
    "pulse path",
  );
  assertIncludes(
    css,
    [
      ".template-pulse {",
      "stroke-dasharray: none;",
      "stroke-opacity: 0.42;",
      "animation: none !important;",
    ],
    "reduced motion static path",
  );
  assertIncludes(treeLib, ["export const TREE_PULSE_LIMIT = 10", "export function selectPulseEdgeIds("], "pulse cap");
});

/* ------------------------------------------------------------------ */
/* F5 可访问性                                                         */
/* ------------------------------------------------------------------ */

test("F5 可访问性：aria 带状态 / 用户数，tooltip aria-live 且与触发元素关联", () => {
  assertIncludes(
    treeChart,
    [
      'aria-describedby={tooltipId}',
      'aria-live="polite"',
      'aria-atomic="true"',
      'role="tooltip"',
      "describeNode?: (node: TreeNode, layoutNode: TreeChartLayoutNode) => string;",
      "describeEdge?: (",
    ],
    "aria wiring",
  );
  assertIncludes(
    topology,
    [
      'translate("overview.chainTemplateInsight.usersValue", { n: meta.users })',
      "edge.users > 0",
      "describeNode={describeNode}",
      "describeEdge={describeEdge}",
    ],
    "aria content",
  );
  // 命中区 ≥44×44：使用共享常量，行高与命中区同档。
  assertIncludes(
    treeChart,
    [
      "TREE_NODE_HIT_SIZE",
      "data-tree-hit",
      "width={hitWidth}",
      "height={TREE_NODE_HIT_SIZE}",
      "x={layoutNode.x - TREE_NODE_HIT_SIZE / 2}",
      "const hitWidth = Math.max(",
      "TREE_LABEL_OFFSET +",
    ],
    "hit area",
  );
  assertIncludes(treeLib, ["export const TREE_NODE_HIT_SIZE = 44", "rowHeight: 44"], "hit size");
  // 触点：首点只选中，再点才折叠。
  assertIncludes(
    treeChart,
    [
      "treeNodeActivation({",
      'if (action === "reveal") {',
      "const [armedId, setArmedId] = useState<string | null>(null);",
    ],
    "tap to reveal",
  );
  assertIncludes(treeLib, ["export function treeNodeActivation(", 'hoverCapable: boolean;'], "activation helper");
  // 离线 / 降级除颜色外有文字：tooltip 状态行 + sr-only 标记。
  assertIncludes(topology, ["sr-only", "statusText(row.status, translate)"], "sr-only status");
});

/* ------------------------------------------------------------------ */
/* F6 hover 性能：根属性 + 生成式 CSS，不逐节点重写                      */
/* ------------------------------------------------------------------ */

test("F6 hover：高亮收敛成根 data-tree-dim + 一条生成式 CSS", () => {
  assertIncludes(
    treeChart,
    [
      "function buildHighlightCss(",
      '<style data-tree-highlight>{highlightCss}</style>',
      'data-tree-dim={activeHighlight === null ? undefined : "true"}',
      'data-tree-scope={scope}',
      'data-tree-index={index}',
      'data-tree-edge-index={index}',
      "hot?.nodes.has(index)",
      "const NodeShape = memo(",
      "const EdgeLayer = memo(",
    ],
    "highlight css",
  );
  // 渲染层不再按节点写 fillOpacity / dimmed 之类的属性。
  assertExcludes(treeChart, ["dimmed", "highlighted ?"], "per-node highlight props");
  assertIncludes(css, ["[data-tree-chart][data-tree-dim] [data-tree-node]"], "dim css");
  // 交叉边：hover 节点时把汇入它的交叉边和 source 路径一起点亮。
  assertIncludes(
    treeLib,
    [
      "if (edge.tree || edge.target !== target.nodeId) continue;",
      "addNodePath(edge.source);",
      "const guard = new Set<string>();",
    ],
    "cross-edge highlight",
  );
});

/* ------------------------------------------------------------------ */
/* F8 对比度与标签                                                     */
/* ------------------------------------------------------------------ */

test("F8 对比度 / 标签：透明度 ≥0.7、1.5px、24 字截断、10px、密集扇出只 hover 显示", () => {
  assertIncludes(
    treeLib,
    [
      "return Math.round((0.7 + 0.3 * ratio) * 100) / 100;",
      "return Math.round((1.5 + 4.5 * ratio) * 100) / 100;",
      "export const TREE_LABEL_MAX_CHARS = 24;",
      "export const TREE_DENSE_FANOUT = 6;",
      "export function truncateTreeLabel(",
    ],
    "contrast + labels",
  );
  assertIncludes(treeChart, ['displayName', "fontSize={10}", 'data-tree-dense={edge.dense ? "true" : undefined}'], "label render");
  assertIncludes(css, ['[data-tree-edge-label][data-tree-dense="true"]'], "dense label css");
  // 拓扑下方的三行解释文案已经删掉。
  assertExcludes(topology, ["topologyHintWidth", "topologyHintP50", "topologyHintPulse"], "topology hints");
  assertExcludes(treeChart, ["topologyHint"], "TreeChart hints");
});

/* ------------------------------------------------------------------ */
/* F9 其它小项                                                         */
/* ------------------------------------------------------------------ */

test("F9 0 链拓扑显示空态，不画孤立 root", () => {
  assertIncludes(
    topology,
    [
      "model.isEmpty",
      "<EmptyState",
      'translate("overview.chainTemplateInsight.emptyTopologyTitle")',
      "WaypointsIcon",
    ],
    "empty topology",
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
  const tree = read("../lib/chainTemplateTree.ts");
  assertExcludes(tree, ["maxEdgeChains"], "dead tree field");
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
  const tree = read("../lib/chainTemplateTree.ts");
  assertIncludes(
    tree,
    [
      "function memberIdentity(member: ChainTemplateMember): string {",
      'const serverId = member.serverId ?? "";',
      "return serverId !== \"\" ? serverId : member.name;",
      "key: `${seq}::${member === null ? name : memberIdentity(member)}`,",
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
    "hotspotsTitle",
    "causeMemberOffline",
    "causeDisabled",
    "online",
    "offline",
    "degraded",
    "unknownStatus",
    "treeRoot",
    "treeTargetsFold",
    "topologyAria",
    "unusedTitle",
    "tooltipStatus",
    "tooltipChains",
    "tooltipUsers",
    "usersValue",
    "chainsUnit",
    "edgeUnavailable",
    "edgeLastKnown",
    "edgeDegradedHint",
    "collapseTargets",
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
  // 新增的降级 / 收起目标 / 空态文案也要中英成对。
  assertIncludes(zh, ['degraded: "降级"', 'collapseTargets: "收起目标"', 'emptyTopologyTitle: "暂无流量"'], "zh new keys");
  assertIncludes(en, ['degraded: "Degraded"', 'collapseTargets: "Collapse targets"', 'emptyTopologyTitle: "No traffic yet"'], "en new keys");
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
  assertIncludes(templateTreeLib, ["detail.unusedCandidates.map"], "unused candidates");
  assertExcludes(
    templateTreeLib,
    ["const usedSourceIdentities = new Set(", "drafts.has(`${node.seq}::${identity}`)"],
    "unused candidates derived from nodes",
  );
});
