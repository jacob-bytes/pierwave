import {
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import {
  buildTreeChartLayout,
  treeHighlightPath,
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
 * 与官方 TreeChart 的 API 保持同形（`data` / `ariaLabel` / `valueLabel` /
 * `formatValue` / `width` / `height` / `className` / `children`），额外提供
 * `links`（DAG 交叉边）、`collapsedIds`、`pulse` 等拓扑需要的能力。
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
  ariaLabel: string;
  valueLabel?: string;
  formatValue?: (value: number) => string;
  /** 视口宽度；不给时铺满容器，内容更宽时横向滚动。 */
  width?: number;
  /** 视口最小高度；树更高时以树为准。 */
  height?: number;
  className?: string;
  /** 覆盖在图表上的自定义内容（例如额外的 ChartTooltip）。 */
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

function isOffline(node: TreeNode): boolean {
  return node.meta?.offline === true;
}

/** 中间节点按层取 `--series-1..4`，叶子与根固定 primary；离线一律 destructive。 */
function nodeAccent(node: TreeNode, layoutNode: TreeChartLayoutNode): string {
  if (isOffline(node)) return "var(--destructive)";
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

function pointInViewport(value: number, width: number): number {
  return Math.min(Math.max(72, value), Math.max(72, width - 72));
}

/** 图表的 tooltip 容器；绝对定位在图表坐标系里，随横向滚动一起移动。 */
export function ChartTooltip({
  x,
  y,
  className,
  children,
}: {
  x: number;
  y: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-chart-tooltip
      role="tooltip"
      className={cn(
        "pointer-events-none absolute z-50 min-w-36 max-w-64 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover px-2.5 py-2 text-[11px] text-popover-foreground shadow-lg",
        className,
      )}
      style={{ left: x, top: y }}
    >
      {children}
    </div>
  );
}

export interface TreeLabelsProps {
  nodes: readonly TreeChartLayoutNode[];
  highlight?: TreeChartHighlight | null;
  className?: string;
  onNodeActivate?: (node: TreeNode) => void;
  onNodeHover?: (nodeId: string | null) => void;
}

/**
 * 节点标签层。TreeChart 内部使用；也可以单独拿来叠自定义布局。
 * 标签永远画在圆点右侧、字号固定，不随容器缩放（390 下横向滚动）。
 */
export function TreeLabels({
  nodes,
  highlight,
  className,
  onNodeActivate,
  onNodeHover,
}: TreeLabelsProps) {
  return (
    <g data-tree-labels className={className}>
      {nodes.map((layoutNode) => {
        const node = layoutNode.node;
        const highlighted = highlight?.nodeIds.has(layoutNode.id) === true;
        const dimmed = highlight !== null && highlight !== undefined && !highlighted;
        const offline = isOffline(node);
        const fold = kindOf(node) === "fold";
        const actionable = layoutNode.hasChildren || fold;
        return (
          <text
            key={`label-${layoutNode.id}`}
            data-tree-label
            data-node-id={layoutNode.id}
            x={layoutNode.x + 11}
            y={layoutNode.y + 0.5}
            dominantBaseline="middle"
            fontSize={11}
            className={cn(
              "select-none",
              actionable && "cursor-pointer",
            )}
            fill={
              offline
                ? "var(--destructive)"
                : highlighted || fold
                  ? "var(--foreground)"
                  : "var(--muted-foreground)"
            }
            fillOpacity={dimmed ? 0.4 : 1}
            paintOrder="stroke"
            stroke="var(--card)"
            strokeWidth={3}
            strokeLinejoin="round"
            onClick={
              actionable
                ? () => onNodeActivate?.(node)
                : undefined
            }
            onMouseEnter={() => onNodeHover?.(layoutNode.id)}
            onMouseLeave={() => onNodeHover?.(null)}
          >
            {node.name}
            {layoutNode.hiddenCount > 0 ? (
              <tspan
                data-tree-hidden-count
                dx={4}
                fill="var(--primary)"
                fillOpacity={dimmed ? 0.5 : 1}
              >
                +{layoutNode.hiddenCount}
              </tspan>
            ) : null}
          </text>
        );
      })}
    </g>
  );
}

function NodeDot({
  layoutNode,
  highlighted,
  dimmed,
  onActivate,
  onHover,
  onFocus,
  onBlur,
  ariaLabel,
}: {
  layoutNode: TreeChartLayoutNode;
  highlighted: boolean;
  dimmed: boolean;
  onActivate: () => void;
  onHover: (next: boolean) => void;
  onFocus: () => void;
  onBlur: () => void;
  ariaLabel: string;
}) {
  const node = layoutNode.node;
  const offline = isOffline(node);
  const fold = kindOf(node) === "fold";
  const accent = nodeAccent(node, layoutNode);
  const actionable = layoutNode.hasChildren || fold;
  const fill =
    fold ||
    (layoutNode.depth !== 0 && isIntermediate(layoutNode) && !offline)
      ? "var(--card)"
      : accent;
  const opacity = dimmed ? 0.4 : 1;
  return (
    <g
      data-tree-node
      data-node-id={layoutNode.id}
      data-depth={layoutNode.depth}
      data-kind={kindOf(node)}
      data-offline={offline ? "true" : "false"}
      data-collapsed={layoutNode.collapsed ? "true" : "false"}
      data-hidden-count={layoutNode.hiddenCount}
      role={actionable ? "button" : "img"}
      tabIndex={0}
      aria-label={ariaLabel}
      aria-expanded={
        layoutNode.hasChildren
          ? !layoutNode.collapsed
          : fold
            ? false
            : undefined
      }
      className="outline-none focus-visible:opacity-100"
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={actionable ? onActivate : undefined}
      onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
        if (!actionable) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      }}
    >
      <rect
        x={layoutNode.x - 8}
        y={layoutNode.y - 12}
        width={16}
        height={24}
        fill="transparent"
        className={actionable ? "cursor-pointer" : undefined}
      />
      {highlighted ? (
        <circle
          data-tree-node-halo
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
        cx={layoutNode.x}
        cy={layoutNode.y}
        r={layoutNode.depth === 0 ? 6.5 : 5}
        fill={fill}
        fillOpacity={opacity}
        stroke={offline ? "var(--destructive)" : accent}
        strokeWidth={isIntermediate(layoutNode) ? 1.6 : 1}
        strokeOpacity={opacity}
        strokeDasharray={fold ? "2.5 2" : undefined}
      />
      {offline ? (
        <circle
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
    </g>
  );
}

function EdgeLayer({
  layout,
  edge,
  highlighted,
  dimmed,
  showPulse,
  formatValue,
  valueLabel,
  unavailableLabel,
  onHover,
  onFocus,
  onBlur,
}: {
  layout: TreeChartLayout;
  edge: TreeChartLayoutEdge;
  highlighted: boolean;
  dimmed: boolean;
  showPulse: boolean;
  formatValue: (value: number) => string;
  valueLabel?: string;
  unavailableLabel?: string;
  onHover: (next: boolean) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const source = layout.byId.get(edge.source);
  const target = layout.byId.get(edge.target);
  const stroke = edge.unavailable ? "var(--destructive)" : "var(--primary)";
  const opacity = highlighted ? 1 : dimmed ? edge.opacity * 0.32 : edge.opacity;
  const width = highlighted ? edge.width + 0.9 : edge.width;
  const label =
    edge.label ??
    (valueLabel === undefined
      ? formatValue(edge.value)
      : `${formatValue(edge.value)} ${valueLabel}`);
  const ariaLabel = [
    source?.node.name,
    "→",
    target?.node.name,
    label,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
  return (
    <g
      data-tree-edge-group
      data-edge-id={edge.id}
      data-tree-edge={edge.tree ? "true" : "false"}
      data-value={edge.value}
      data-width={edge.width}
      data-unavailable={edge.unavailable ? "true" : "false"}
      data-pulse={edge.pulse ? "true" : "false"}
      role="img"
      tabIndex={0}
      aria-label={ariaLabel}
      className="outline-none"
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <title>{ariaLabel}</title>
      <path
        d={edge.path}
        fill="none"
        stroke="transparent"
        strokeWidth={Math.max(14, edge.width + 10)}
      />
      <path
        data-tree-edge
        d={edge.path}
        fill="none"
        stroke={stroke}
        strokeOpacity={opacity}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={edge.unavailable ? "4 4" : undefined}
      />
      {showPulse && edge.pulse && !edge.unavailable ? (
        <>
          <path
            data-tree-pulse
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
          <path
            data-tree-pulse-static
            className="template-pulse-static"
            d={edge.path}
            fill="none"
            pathLength={100}
            stroke="var(--series-4)"
            strokeWidth={Math.max(2, edge.width * 0.75)}
            strokeLinecap="round"
          />
        </>
      ) : null}
      <text
        data-tree-edge-label
        x={edge.labelX}
        y={edge.labelY}
        textAnchor="middle"
        dominantBaseline="auto"
        fill="var(--muted-foreground)"
        fillOpacity={dimmed ? 0.45 : 1}
        fontSize={9}
        fontFamily="var(--font-mono, ui-monospace, monospace)"
        paintOrder="stroke"
        stroke="var(--card)"
        strokeWidth={3}
        strokeLinejoin="round"
      >
        {label}
        {edge.unavailable && unavailableLabel !== undefined ? (
          <tspan
            x={edge.labelX}
            dy={10}
            fill="var(--destructive)"
            fontSize={8}
            fontFamily="var(--font-sans, ui-sans-serif, system-ui, sans-serif)"
            strokeWidth={2.5}
          >
            {unavailableLabel}
          </tspan>
        ) : null}
      </text>
    </g>
  );
}

type ActiveTarget =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | null;

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

  const contentWidth = Math.max(width ?? 0, layout.width);
  const contentHeight = Math.max(height ?? 0, layout.height);

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
        x: pointInViewport(layoutNode.x + 14, contentWidth),
        y: Math.max(28, layoutNode.y - 8),
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
      x: pointInViewport(edge.labelX, contentWidth),
      y: Math.max(28, edge.labelY - 4),
      content:
        renderTooltip?.(target) ?? (
          <div className="flex items-center gap-3">
            <span className="truncate">
              {source} → {destination}
            </span>
            <span className="ml-auto shrink-0 font-mono tabular-nums text-muted-foreground">
              {edge.label ??
                nodeValueText(
                  { name: "", value: edge.value },
                  formatValue,
                  valueLabel,
                )}
            </span>
          </div>
        ),
    };
  }, [
    active,
    contentWidth,
    formatValue,
    layout,
    linkById,
    renderTooltip,
    valueLabel,
  ]);

  const activate = (node: TreeNode): void => {
    onNodeToggle?.(node);
  };

  return (
    <div
      data-tree-chart
      data-node-count={layout.nodes.length}
      data-edge-count={layout.edges.length}
      className={cn("relative min-w-0", className)}
    >
      <div
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
            aria-label={ariaLabel}
            width={contentWidth}
            height={contentHeight}
            className="block max-w-none overflow-visible"
            onMouseLeave={() => setActive(null)}
          >
            <g data-tree-edges>
              {layout.edges.map((edge) => (
                <EdgeLayer
                  key={edge.id}
                  layout={layout}
                  edge={edge}
                  highlighted={
                    activeHighlight?.edgeIds.has(edge.id) === true
                  }
                  dimmed={
                    activeHighlight !== null &&
                    activeHighlight !== undefined &&
                    !activeHighlight.edgeIds.has(edge.id)
                  }
                  showPulse={pulse}
                  formatValue={formatValue}
                  valueLabel={valueLabel}
                  unavailableLabel={unavailableLabel}
                  onHover={(next) =>
                    setActive(next ? { kind: "edge", id: edge.id } : null)
                  }
                  onFocus={() => setActive({ kind: "edge", id: edge.id })}
                  onBlur={() => setActive(null)}
                />
              ))}
            </g>
            <g data-tree-nodes>
              {layout.nodes.map((layoutNode) => (
                <NodeDot
                  key={layoutNode.id}
                  layoutNode={layoutNode}
                  highlighted={
                    activeHighlight?.nodeIds.has(layoutNode.id) === true
                  }
                  dimmed={
                    activeHighlight !== null &&
                    activeHighlight !== undefined &&
                    !activeHighlight.nodeIds.has(layoutNode.id)
                  }
                  onActivate={() => activate(layoutNode.node)}
                  onHover={(next) =>
                    setActive(
                      next ? { kind: "node", id: layoutNode.id } : null,
                    )
                  }
                  onFocus={() =>
                    setActive({ kind: "node", id: layoutNode.id })
                  }
                  onBlur={() => setActive(null)}
                  ariaLabel={`${layoutNode.node.name}, ${nodeValueText(
                    layoutNode.node,
                    formatValue,
                    valueLabel,
                  )}${
                    layoutNode.hiddenCount > 0
                      ? `, +${layoutNode.hiddenCount}`
                      : ""
                  }`}
                />
              ))}
            </g>
            <TreeLabels
              nodes={layout.nodes}
              highlight={activeHighlight}
              onNodeActivate={activate}
              onNodeHover={(nodeId) =>
                setActive(
                  nodeId === null ? null : { kind: "node", id: nodeId },
                )
              }
            />
          </svg>
          {children}
          {tooltip !== null ? (
            <ChartTooltip x={tooltip.x} y={tooltip.y}>
              {tooltip.content}
            </ChartTooltip>
          ) : null}
        </div>
      </div>
    </div>
  );
}

