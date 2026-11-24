import {
  Fragment,
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import {
  TREE_LABEL_OFFSET,
  TREE_NODE_HIT_SIZE,
  buildTreeChartLayout,
  placeTreeTooltip,
  selectPulseEdgeIds,
  treeHighlightPath,
  treeNodeActivation,
  type TreeChartHighlight,
  type TreeChartLayout,
  type TreeChartLayoutEdge,
  type TreeChartLayoutNode,
  type TreeChartLink,
  type TreeNode,
} from "@/lib/treeChart";

/**
 * 本地实现的 shadcn 风格横向 TreeChart。
 *
 * 根在最左、层级向右展开；父到子是三次贝塞尔曲线。中间节点是空心环、
 * 叶子是实心点。hover / focus 节点或边时点亮该节点到根的整条路径；点击
 * 有子节点的节点交给 `onNodeToggle`，折叠状态由调用方通过 `collapsedIds`
 * 回传（`+N` 由布局算出）。
 *
 * 四条约定（性能 / 可访问性）：
 * 1. 高亮不逐节点改属性：根上挂 `data-tree-dim`，高亮集合编译成一条
 *    `<style>` 规则（按 `data-tree-index` / `data-tree-edge-index` 命中），
 *    一次 hover 只写根属性和一段 CSS 文本。
 * 2. 脉冲路径只有 Top N 条（`selectPulseEdgeIds`），其余边保持静态；
 *    `prefers-reduced-motion` 下同一条路径停止动画并保持可见。
 * 3. tooltip 用实测宽高 + 可见窗口夹紧（`placeTreeTooltip`），首行节点
 *    翻到下方，390 滚到末端也不会被滚动容器裁掉。
 * 4. DOM 预算：节点 = 命中矩形 + 圆点 + 标签（3 个元素），边 = 命中路径 +
 *    可见路径 + 标签（3 个元素）；不额外套 `<g>`、不重复 `<title>`。
 *    110 节点 / 109 边约 680 个元素，不是 1200+。
 *
 * `TreeNode.meta` 里可选 `kind` / `status` / `offline`：`kind === "fold"`
 * 视为可折叠的 `+N`，`status` 用于着色与 aria 描述（具体文案由调用方通过
 * `describeNode` / `describeEdge` 决定）。
 */

export type {
  TreeNode,
  TreeChartLink,
  TreeChartHighlight,
  TreeChartLayout,
  TreeChartLayoutEdge,
  TreeChartLayoutNode,
};

export interface TreeChartTooltipNode {
  kind: "node";
  node: TreeNode;
  layoutNode: TreeChartLayoutNode;
}

export interface TreeChartTooltipEdge {
  kind: "edge";
  edge: TreeChartLayoutEdge;
  link: TreeChartLink | undefined;
  sourceName: string;
  targetName: string;
}

export type TreeChartTooltipTarget =
  | TreeChartTooltipNode
  | TreeChartTooltipEdge;

export interface TreeChartProps {
  data: TreeNode;
  /**
   * 图表 aria-label。传函数时用**实际可见**节点 / 边数：折叠之后计数要变小，
   * 不能一直念布局前的总数。
   */
  ariaLabel:
    | string
    | ((counts: { nodes: number; edges: number }) => string);
  valueLabel?: string;
  formatValue?: (value: number) => string;
  /** 视口宽度；不给时铺满容器，内容更宽时横向滚动。 */
  width?: number;
  /** 视口最小高度；树更高时以树为准。 */
  height?: number;
  className?: string;
  /** 覆盖在图表上的自定义内容（例如额外的 chart tooltip）。 */
  children?: ReactNode;

  /** DAG 里的非树边；同 source/target 的树边会自动复用其数值。 */
  links?: readonly TreeChartLink[];
  /** 折叠节点集合；有子节点且命中时隐藏其子树。 */
  collapsedIds?: ReadonlySet<string>;
  /** 点击节点；是否折叠 / 展开由调用方决定。 */
  onNodeToggle?: (node: TreeNode) => void;
  /** 受控高亮；不传时组件自己按 hover / focus 算到根的主路径。 */
  highlight?: TreeChartHighlight | null;
  /** 自定义 tooltip 内容；不传时用内置的名 + 值。 */
  renderTooltip?: (target: TreeChartTooltipTarget) => ReactNode;
  /** 边缘不可用时的第二行标记（如「不可用 / Unavailable」）。 */
  unavailableLabel?: string;
  /** 沿树边画脉冲（CSS 动画，`prefers-reduced-motion` 下退化为静态高亮）。 */
  pulse?: boolean;
  /** 节点 aria-label 的额外描述（状态、用户数…）。 */
  describeNode?: (node: TreeNode, layoutNode: TreeChartLayoutNode) => string;
  /** 边 aria-label 的额外描述（状态 / 用户数 / 不可用 / 最近已知）。 */
  describeEdge?: (
    edge: TreeChartLayoutEdge,
    link: TreeChartLink | undefined,
  ) => string;
}

const PULSE_PERIOD_SEC = 3.6;
const PULSE_STEP_SEC = 0.18;

function pulseDelay(depth: number): number {
  return -PULSE_PERIOD_SEC + Math.max(0, depth) * PULSE_STEP_SEC;
}

function defaultFormatValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

function kindOf(node: TreeNode): string {
  const kind = node.meta?.kind;
  return typeof kind === "string" ? kind : "";
}

function statusOf(node: TreeNode): string {
  const status = node.meta?.status;
  return typeof status === "string" ? status : "";
}

function isOffline(node: TreeNode): boolean {
  return node.meta?.offline === true || statusOf(node) === "offline";
}

function isDegraded(node: TreeNode): boolean {
  return statusOf(node) === "degraded";
}

/** 中间节点按层取 `--series-1..4`，叶子与根固定 primary；离线 destructive、降级 warning。 */
function nodeAccent(node: TreeNode, layoutNode: TreeChartLayoutNode): string {
  if (isOffline(node)) return "var(--destructive)";
  if (isDegraded(node)) return "var(--warning)";
  if (layoutNode.depth === 0 || !isIntermediate(layoutNode)) {
    return "var(--primary)";
  }
  return `var(--series-${((layoutNode.depth - 1) % 4) + 1})`;
}

function isIntermediate(layoutNode: TreeChartLayoutNode): boolean {
  return layoutNode.hasChildren || layoutNode.hasOutgoing;
}

function nodeValueText(
  node: TreeNode,
  formatValue: (value: number) => string,
  valueLabel?: string,
): string {
  const value = formatValue(node.value ?? 0);
  return valueLabel === undefined ? value : `${value} ${valueLabel}`;
}

/** aria 里的边数值：不可用边只能是 `—`，历史 P50 由调用方单独说明。 */
function edgeValueText(edge: TreeChartLayoutEdge): string {
  if (edge.unavailable) return "—";
  return edge.label ?? String(Math.round(edge.value));
}

/** 高亮 CSS：一次 hover 只更新这一段文本，不逐节点改属性。 */
function buildHighlightCss(
  scope: string,
  hot: { nodes: Set<number>; edges: Set<number> } | null,
): string {
  if (hot === null || (hot.nodes.size === 0 && hot.edges.size === 0)) return "";
  const base = `[data-tree-scope="${scope}"][data-tree-dim]`;
  const nodeSelectors: string[] = [];
  const labelSelectors: string[] = [];
  for (const index of hot.nodes) {
    nodeSelectors.push(
      `[data-tree-node][data-tree-index="${index}"]`,
      `[data-tree-node-dot][data-tree-index="${index}"]`,
      `[data-tree-label][data-tree-index="${index}"]`,
    );
    labelSelectors.push(`[data-tree-label][data-tree-index="${index}"]`);
  }
  const edgeSelectors: string[] = [];
  for (const index of hot.edges) {
    edgeSelectors.push(
      `[data-tree-edge-group][data-tree-edge-index="${index}"]`,
      `[data-tree-edge][data-tree-edge-index="${index}"]`,
      `[data-tree-pulse][data-tree-edge-index="${index}"]`,
    );
  }
  const labelReveal = [...hot.edges].map(
    (index) => `[data-tree-edge-label][data-tree-edge-index="${index}"]`,
  );
  const rules: string[] = [];
  const visible = [...nodeSelectors, ...edgeSelectors];
  if (visible.length > 0) {
    rules.push(`${base} :is(${visible.join(",")}){opacity:1}`);
  }
  if (labelSelectors.length > 0) {
    rules.push(`${base} :is(${labelSelectors.join(",")}){fill:var(--foreground)}`);
  }
  if (labelReveal.length > 0) {
    // 密集扇出的 P50 默认隐藏，hover 到具体路径时再显出来。
    rules.push(`${base} :is(${labelReveal.join(",")}){opacity:1}`);
  }
  return rules.join("");
}

export interface TreeLabelsProps {
  nodes: readonly TreeChartLayoutNode[];
  className?: string;
}

/**
 * 节点标签层。TreeChart 内部使用；也可以单独拿来叠自定义布局。
 * 标签永远画在圆点右侧、字号固定，不随容器缩放（390 下横向滚动）。
 * 纯展示：`pointer-events: none`，命中与 aria 都在节点的命中矩形上，
 * 这样「点标签」和「点圆点」是同一个 44px 高的大目标。
 */
export function TreeLabels({ nodes, className }: TreeLabelsProps) {
  return (
    <g data-tree-labels className={className}>
      {nodes.map((layoutNode, index) => {
        const node = layoutNode.node;
        const offline = isOffline(node);
        const degraded = isDegraded(node);
        const fold = kindOf(node) === "fold";
        return (
          <text
            key={`label-${layoutNode.id}`}
            data-tree-label
            data-tree-index={index}
            data-node-id={layoutNode.id}
            x={layoutNode.x + TREE_LABEL_OFFSET}
            y={layoutNode.y + 0.5}
            dominantBaseline="middle"
            fontSize={11}
            className="pointer-events-none select-none"
            fill={
              offline
                ? "var(--destructive)"
                : degraded
                  ? "var(--warning)"
                  : fold
                    ? "var(--foreground)"
                    : "var(--muted-foreground)"
            }
            paintOrder="stroke"
            stroke="var(--card)"
            strokeWidth={3}
            strokeLinejoin="round"
          >
            {layoutNode.displayName}
            {layoutNode.hiddenCount > 0 ? (
              <tspan data-tree-hidden-count dx={4} fill="var(--primary)">
                +{layoutNode.hiddenCount}
              </tspan>
            ) : null}
          </text>
        );
      })}
    </g>
  );
}

interface NodeShapeProps {
  layoutNode: TreeChartLayoutNode;
  index: number;
  /** 当前高亮路径上的节点：只有它渲染 halo，其余节点不重挂。 */
  hot: boolean;
  tooltipId: string;
  ariaLabel: string;
  onActivate: (node: TreeNode) => void;
  onHover: (index: number, next: boolean) => void;
  onFocus: (index: number) => void;
  onBlur: () => void;
}

/**
 * 一个可见节点 = 命中矩形 + 圆点 + 标签层里的文本（3 个元素）。
 * 没有外层 `<g>`、没有重复的 `<title>`：aria-label 已经是完整描述。
 */
const NodeShape = memo(function NodeShape({
  layoutNode,
  index,
  hot,
  tooltipId,
  ariaLabel,
  onActivate,
  onHover,
  onFocus,
  onBlur,
}: NodeShapeProps) {
  const node = layoutNode.node;
  const offline = isOffline(node);
  const degraded = isDegraded(node);
  const fold = kindOf(node) === "fold";
  const accent = nodeAccent(node, layoutNode);
  const actionable = layoutNode.hasChildren || fold;
  const fill =
    fold ||
    (layoutNode.depth !== 0 && isIntermediate(layoutNode) && !offline)
      ? "var(--card)"
      : accent;
  // 命中区盖住圆点 + 标签（≥44 高，行距 44 所以上下不重叠）。
  const hitWidth = Math.max(
    TREE_NODE_HIT_SIZE,
    TREE_NODE_HIT_SIZE / 2 +
      TREE_LABEL_OFFSET +
      layoutNode.labelWidth +
      (layoutNode.hiddenCount > 0 ? 26 : 0),
  );
  return (
    <Fragment>
      <rect
        data-tree-node
        data-tree-hit
        data-node-id={layoutNode.id}
        data-tree-index={index}
        data-depth={layoutNode.depth}
        data-kind={kindOf(node)}
        data-status={statusOf(node)}
        data-offline={offline ? "true" : "false"}
        data-degraded={degraded ? "true" : "false"}
        data-collapsed={layoutNode.collapsed ? "true" : "false"}
        data-hidden-count={layoutNode.hiddenCount}
        x={layoutNode.x - TREE_NODE_HIT_SIZE / 2}
        y={layoutNode.y - TREE_NODE_HIT_SIZE / 2}
        width={hitWidth}
        height={TREE_NODE_HIT_SIZE}
        rx={6}
        fill="transparent"
        role={actionable ? "button" : "img"}
        tabIndex={0}
        aria-label={ariaLabel}
        aria-describedby={tooltipId}
        aria-expanded={
          layoutNode.hasChildren
            ? !layoutNode.collapsed
            : fold
              ? false
              : undefined
        }
        className={actionable ? "cursor-pointer" : undefined}
        onMouseEnter={() => onHover(index, true)}
        onMouseLeave={() => onHover(index, false)}
        onFocus={() => onFocus(index)}
        onBlur={onBlur}
        onClick={actionable ? () => onActivate(node) : undefined}
        onKeyDown={(event: KeyboardEvent<SVGRectElement>) => {
          if (!actionable) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onActivate(node);
          }
        }}
      />
      {hot ? (
        <circle
          data-tree-node-halo
          pointerEvents="none"
          cx={layoutNode.x}
          cy={layoutNode.y}
          r={9.5}
          fill="var(--primary)"
          fillOpacity={0.14}
          stroke="var(--primary)"
          strokeOpacity={0.55}
          strokeWidth={1}
        />
      ) : null}
      <circle
        data-tree-node-dot
        data-tree-index={index}
        pointerEvents="none"
        cx={layoutNode.x}
        cy={layoutNode.y}
        r={layoutNode.depth === 0 ? 6.5 : 5}
        fill={fill}
        stroke={offline ? "var(--destructive)" : accent}
        strokeWidth={isIntermediate(layoutNode) ? 1.6 : 1}
        strokeDasharray={fold ? "2.5 2" : undefined}
      />
      {offline ? (
        <circle
          pointerEvents="none"
          cx={layoutNode.x}
          cy={layoutNode.y}
          r={9}
          fill="none"
          stroke="var(--destructive)"
          strokeOpacity={0.4}
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      ) : null}
      {degraded ? (
        <circle
          pointerEvents="none"
          cx={layoutNode.x}
          cy={layoutNode.y}
          r={7.5}
          fill="none"
          stroke="var(--warning)"
          strokeOpacity={0.55}
          strokeWidth={1}
          strokeDasharray="1.5 2"
        />
      ) : null}
    </Fragment>
  );
});

interface EdgeLayerProps {
  edge: TreeChartLayoutEdge;
  index: number;
  pulse: boolean;
  tooltipId: string;
  label: string;
  ariaLabel: string;
  unavailableLabel?: string;
  onHover: (index: number, next: boolean) => void;
  onFocus: (index: number) => void;
  onBlur: () => void;
}

/**
 * 一条边 = 命中路径 + 可见路径 + 标签（3 个元素）。
 * 命中路径透明、加宽到 16px；可见路径与标签 `pointer-events: none`，
 * 鼠标永远落在命中路径上。
 */
const EdgeLayer = memo(function EdgeLayer({
  edge,
  index,
  pulse,
  tooltipId,
  label,
  ariaLabel,
  unavailableLabel,
  onHover,
  onFocus,
  onBlur,
}: EdgeLayerProps) {
  const stroke = edge.unavailable
    ? "var(--destructive)"
    : edge.degraded
      ? "var(--warning)"
      : "var(--primary)";
  const labelFill = edge.unavailable
    ? "var(--destructive)"
    : edge.degraded
      ? "var(--warning)"
      : "var(--muted-foreground)";
  return (
    <Fragment>
      <path
        data-tree-edge-group
        data-edge-id={edge.id}
        data-tree-edge-index={index}
        data-tree-edge={edge.tree ? "true" : "false"}
        data-value={edge.value}
        data-width={edge.width}
        data-unavailable={edge.unavailable ? "true" : "false"}
        data-degraded={edge.degraded ? "true" : "false"}
        data-pulse={edge.pulse ? "true" : "false"}
        d={edge.path}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.max(16, edge.width + 12)}
        role="img"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-describedby={tooltipId}
        onMouseEnter={() => onHover(index, true)}
        onMouseLeave={() => onHover(index, false)}
        onFocus={() => onFocus(index)}
        onBlur={onBlur}
      />
      <path
        data-tree-edge
        data-tree-edge-index={index}
        pointerEvents="none"
        d={edge.path}
        fill="none"
        stroke={stroke}
        strokeOpacity={edge.opacity}
        strokeWidth={edge.width}
        strokeLinecap="round"
        strokeDasharray={edge.unavailable ? "4 4" : undefined}
      />
      {/*
       * 脉冲只有一条 path：reduced-motion 下 CSS 把动画停掉、换成静态
       * 描边（同一条 path 仍然可见），不再为每条边额外渲染静态副本。
       */}
      {pulse ? (
        <path
          data-tree-pulse
          data-tree-edge-index={index}
          pointerEvents="none"
          className="template-pulse"
          d={edge.path}
          fill="none"
          pathLength={100}
          stroke="var(--series-4)"
          strokeWidth={Math.max(3, edge.width * 0.9)}
          strokeLinecap="round"
          strokeDasharray="16 6 4 100"
          style={{ animationDelay: `${pulseDelay(edge.depth).toFixed(3)}s` }}
        />
      ) : null}
      <text
        data-tree-edge-label
        data-tree-edge-index={index}
        data-tree-dense={edge.dense ? "true" : undefined}
        pointerEvents="none"
        x={edge.labelX}
        y={edge.labelY}
        textAnchor="middle"
        dominantBaseline="auto"
        fill={labelFill}
        fontSize={10}
        fontFamily="var(--font-mono, ui-monospace, monospace)"
        paintOrder="stroke"
        stroke="var(--card)"
        strokeWidth={3}
        strokeLinejoin="round"
      >
        {label}
        {edge.unavailable && unavailableLabel !== undefined ? (
          <tspan
            data-tree-edge-unavailable
            x={edge.labelX}
            dy={10}
            fill="var(--destructive)"
            fontSize={9}
            fontFamily="var(--font-sans, ui-sans-serif, system-ui, sans-serif)"
            strokeWidth={2.5}
          >
            {unavailableLabel}
          </tspan>
        ) : null}
      </text>
    </Fragment>
  );
});

type ActiveTarget =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | null;

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export function TreeChart({
  data,
  ariaLabel,
  valueLabel,
  formatValue = defaultFormatValue,
  width,
  height,
  className,
  children,
  links,
  collapsedIds,
  onNodeToggle,
  highlight,
  renderTooltip,
  unavailableLabel,
  pulse = false,
  describeNode,
  describeEdge,
}: TreeChartProps) {
  const layout = useMemo(
    () =>
      buildTreeChartLayout(data, {
        links,
        collapsedIds,
      }),
    [data, links, collapsedIds],
  );
  const [active, setActive] = useState<ActiveTarget>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // useId 里可能有 : / «» 之类的字符，先归一成可安全放进属性选择器的串。
  const scope = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const tooltipId = `tree-chart-tooltip-${scope}`;

  const linkById = useMemo(() => {
    const map = new Map<string, TreeChartLink>();
    for (const link of links ?? []) map.set(link.id, link);
    return map;
  }, [links]);

  const computed = useMemo(() => {
    if (active === null) return null;
    return active.kind === "node"
      ? treeHighlightPath(layout, { nodeId: active.id })
      : treeHighlightPath(layout, { edgeId: active.id });
  }, [active, layout]);
  const activeHighlight = highlight !== undefined ? highlight : computed;

  /** 高亮集合 → 索引 → 一条 CSS；hover 时只写根属性和这段文本。 */
  const hot = useMemo(() => {
    if (activeHighlight === null) return null;
    const nodeIndex = new Map<string, number>();
    layout.nodes.forEach((node, index) => nodeIndex.set(node.id, index));
    const edgeIndex = new Map<string, number>();
    layout.edges.forEach((edge, index) => edgeIndex.set(edge.id, index));
    const nodes = new Set<number>();
    for (const id of activeHighlight.nodeIds) {
      const index = nodeIndex.get(id);
      if (index !== undefined) nodes.add(index);
    }
    const edges = new Set<number>();
    for (const id of activeHighlight.edgeIds) {
      const index = edgeIndex.get(id);
      if (index !== undefined) edges.add(index);
    }
    return { nodes, edges };
  }, [activeHighlight, layout]);
  const highlightCss = useMemo(
    () => buildHighlightCss(scope, hot),
    [hot, scope],
  );

  const pulseIds = useMemo(
    () => (pulse ? selectPulseEdgeIds(layout.edges) : EMPTY_SET),
    [layout, pulse],
  );

  const contentWidth = Math.max(width ?? 0, layout.width);
  const contentHeight = Math.max(height ?? 0, layout.height);

  const nodeAria = useMemo(() => {
    const map = new Map<string, string>();
    for (const layoutNode of layout.nodes) {
      const extra = describeNode?.(layoutNode.node, layoutNode);
      map.set(
        layoutNode.id,
        [
          layoutNode.node.name,
          nodeValueText(layoutNode.node, formatValue, valueLabel),
          layoutNode.hiddenCount > 0 ? `+${layoutNode.hiddenCount}` : "",
          extra ?? "",
        ]
          .filter((part) => part !== "")
          .join(", "),
      );
    }
    return map;
  }, [describeNode, formatValue, layout, valueLabel]);

  const edgeAria = useMemo(() => {
    const map = new Map<string, string>();
    for (const edge of layout.edges) {
      const source = layout.byId.get(edge.source)?.node.name ?? "";
      const target = layout.byId.get(edge.target)?.node.name ?? "";
      const extra = describeEdge?.(edge, linkById.get(edge.id));
      map.set(
        edge.id,
        [source, "→", target, edgeValueText(edge), extra ?? ""]
          .filter((part) => part !== "")
          .join(" "),
      );
    }
    return map;
  }, [describeEdge, layout, linkById]);

  const tooltip = useMemo(() => {
    if (active === null) return null;
    if (active.kind === "node") {
      const layoutNode = layout.byId.get(active.id);
      if (layoutNode === undefined) return null;
      const target: TreeChartTooltipTarget = {
        kind: "node",
        node: layoutNode.node,
        layoutNode,
      };
      return {
        anchorX: layoutNode.x + 14,
        anchorY: layoutNode.y,
        anchorHeight: TREE_NODE_HIT_SIZE,
        content:
          renderTooltip?.(target) ?? (
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{layoutNode.node.name}</span>
              <span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">
                {nodeValueText(layoutNode.node, formatValue, valueLabel)}
              </span>
            </div>
          ),
      };
    }
    const edge = layout.edges.find((item) => item.id === active.id);
    if (edge === undefined) return null;
    const source = layout.byId.get(edge.source)?.node.name ?? "—";
    const destination = layout.byId.get(edge.target)?.node.name ?? "—";
    const target: TreeChartTooltipTarget = {
      kind: "edge",
      edge,
      link: linkById.get(edge.id),
      sourceName: source,
      targetName: destination,
    };
    return {
      anchorX: edge.labelX,
      anchorY: edge.labelY,
      anchorHeight: 0,
      content:
        renderTooltip?.(target) ?? (
          <div className="flex items-center gap-3">
            <span className="truncate">
              {source} → {destination}
            </span>
            <span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">
              {edgeValueText(edge)}
            </span>
          </div>
        ),
    };
  }, [active, formatValue, layout, linkById, renderTooltip, valueLabel]);

  /* ---------------- tooltip 定位：实测 + 夹紧 ---------------- */
  /** 实测结果连同锚点一起存：锚点变了就当没有，模板那帧先隐藏再定位。 */
  const [measured, setMeasured] = useState<{
    x: number;
    y: number;
    anchorX: number;
    anchorY: number;
  } | null>(null);
  const tooltipOpen = tooltip !== null;
  const anchorX = tooltip?.anchorX ?? 0;
  const anchorY = tooltip?.anchorY ?? 0;
  const anchorHeight = tooltip?.anchorHeight ?? 0;
  const placement =
    measured !== null &&
    measured.anchorX === anchorX &&
    measured.anchorY === anchorY
      ? measured
      : null;

  useLayoutEffect(() => {
    if (!tooltipOpen) return;
    const update = (): void => {
      const element = tooltipRef.current;
      if (element === null) return;
      const scroll = scrollRef.current;
      // 实测尺寸：不能用固定 offset，长 tooltip 会被裁掉。
      const next = placeTreeTooltip({
        anchorX,
        anchorY,
        anchorHeight,
        width: element.offsetWidth || 240,
        height: element.offsetHeight || 80,
        visibleLeft: scroll?.scrollLeft ?? 0,
        visibleTop: scroll?.scrollTop ?? 0,
        visibleWidth: scroll?.clientWidth ?? element.offsetWidth + 16,
        visibleHeight: scroll?.clientHeight ?? element.offsetHeight + 16,
      });
      setMeasured((previous) =>
        previous !== null &&
        previous.x === next.x &&
        previous.y === next.y &&
        previous.anchorX === anchorX &&
        previous.anchorY === anchorY
          ? previous
          : { x: next.x, y: next.y, anchorX, anchorY },
      );
    };
    update();
    const scroll = scrollRef.current;
    scroll?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scroll?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [anchorHeight, anchorX, anchorY, tooltipOpen]);

  const hoverCapable = useMemo(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return true;
    }
    return window.matchMedia("(hover: hover)").matches;
  }, []);

  const activate = useCallback(
    (node: TreeNode): void => {
      const id = node.id;
      if (id === undefined) {
        onNodeToggle?.(node);
        return;
      }
      const action = treeNodeActivation({
        hoverCapable,
        armedId,
        nodeId: id,
      });
      if (action === "reveal") {
        // 触点首点只选中并显示 tooltip，不立刻把子树收起来。
        setArmedId(id);
        setActive({ kind: "node", id });
        return;
      }
      setArmedId(null);
      onNodeToggle?.(node);
    },
    [armedId, hoverCapable, onNodeToggle],
  );

  const hoverNodeAt = useCallback(
    (index: number, next: boolean): void => {
      if (!next) {
        setActive(null);
        return;
      }
      const id = layout.nodes[index]?.id;
      if (id !== undefined) setActive({ kind: "node", id });
    },
    [layout],
  );

  const hoverEdgeAt = useCallback(
    (index: number, next: boolean): void => {
      if (!next) {
        setActive(null);
        return;
      }
      const id = layout.edges[index]?.id;
      if (id !== undefined) setActive({ kind: "edge", id });
    },
    [layout],
  );

  const focusNodeAt = useCallback(
    (index: number): void => {
      const id = layout.nodes[index]?.id;
      if (id !== undefined) setActive({ kind: "node", id });
    },
    [layout],
  );

  const focusEdgeAt = useCallback(
    (index: number): void => {
      const id = layout.edges[index]?.id;
      if (id !== undefined) setActive({ kind: "edge", id });
    },
    [layout],
  );

  const clearActive = useCallback((): void => setActive(null), []);

  const resolvedAriaLabel =
    typeof ariaLabel === "function"
      ? ariaLabel({ nodes: layout.nodes.length, edges: layout.edges.length })
      : ariaLabel;

  return (
    <div
      data-tree-chart
      data-tree-scope={scope}
      data-tree-dim={activeHighlight === null ? undefined : "true"}
      data-node-count={layout.nodes.length}
      data-edge-count={layout.edges.length}
      className={cn("relative min-w-0", className)}
    >
      {/* 一次 hover 只更新这一个 <style> 的文本，不重写 500+ 个属性。 */}
      <style data-tree-highlight>{highlightCss}</style>
      <div
        ref={scrollRef}
        data-tree-chart-scroll
        className="overflow-x-auto overscroll-x-contain pb-1"
        style={width === undefined ? undefined : { width }}
      >
        <div
          className="relative"
          style={{ width: contentWidth, height: contentHeight }}
        >
          <svg
            role="group"
            aria-label={resolvedAriaLabel}
            width={contentWidth}
            height={contentHeight}
            className="block max-w-none overflow-visible"
            onMouseLeave={() => setActive(null)}
          >
            <g data-tree-edges>
              {layout.edges.map((edge, index) => (
                <EdgeLayer
                  key={edge.id}
                  edge={edge}
                  index={index}
                  pulse={pulseIds.has(edge.id)}
                  tooltipId={tooltipId}
                  ariaLabel={edgeAria.get(edge.id) ?? ""}
                  label={edgeValueText(edge)}
                  unavailableLabel={unavailableLabel}
                  onHover={hoverEdgeAt}
                  onFocus={focusEdgeAt}
                  onBlur={clearActive}
                />
              ))}
            </g>
            <g data-tree-nodes>
              {layout.nodes.map((layoutNode, index) => (
                <NodeShape
                  key={layoutNode.id}
                  layoutNode={layoutNode}
                  index={index}
                  hot={hot?.nodes.has(index) === true}
                  tooltipId={tooltipId}
                  ariaLabel={nodeAria.get(layoutNode.id) ?? layoutNode.node.name}
                  onActivate={activate}
                  onHover={hoverNodeAt}
                  onFocus={focusNodeAt}
                  onBlur={clearActive}
                />
              ))}
            </g>
            <TreeLabels nodes={layout.nodes} />
          </svg>
          {children}
          <div
            ref={tooltipRef}
            id={tooltipId}
            data-chart-tooltip
            role="tooltip"
            aria-live="polite"
            aria-atomic="true"
            className={cn(
              "pointer-events-none absolute z-50 min-w-36 max-w-64 rounded-md border border-border bg-popover px-2.5 py-2 text-[11px] text-popover-foreground shadow-lg",
              tooltip === null && "hidden",
            )}
            style={
              tooltip === null
                ? undefined
                : {
                    left: placement?.x ?? tooltip.anchorX,
                    top: placement?.y ?? tooltip.anchorY,
                    visibility: placement === null ? "hidden" : "visible",
                  }
            }
          >
            {tooltip?.content}
          </div>
        </div>
      </div>
    </div>
  );
}
