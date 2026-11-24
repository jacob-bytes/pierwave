/**
 * 横向树图的纯布局逻辑（无 React / DOM）。
 *
 * 目标视觉与 shadcn TreeChart 对齐：根在最左、层级向右展开、节点是圆点
 * （中间节点空心环、叶子实心点）、标签在圆点右侧、父到子用平滑贝塞尔曲线。
 *
 * 布局 O(n)：一次先序确定叶子的行号，父节点取首尾子节点的中点；列宽按
 * 该层最长标签估算，避免标签压到下一列。折叠只影响可见子节点，隐藏数量
 * 记在节点上（`+N`）。
 */

export interface TreeNode {
  /** 稳定 id；缺失时由树中的路径生成。 */
  id?: string;
  name: string;
  value?: number;
  children?: TreeNode[];
  meta?: Record<string, unknown>;
}

/** 非树边（DAG 里的汇合 / 分流交叉路径）。 */
export interface TreeChartLink {
  id: string;
  source: string;
  target: string;
  value: number;
  label?: string;
  unavailable?: boolean;
  pulse?: boolean;
}

export interface TreeChartLayoutOptions {
  links?: readonly TreeChartLink[];
  collapsedIds?: ReadonlySet<string>;
  rowHeight?: number;
  minColumnWidth?: number;
  paddingX?: number;
  paddingY?: number;
  fontSize?: number;
  labelGap?: number;
  dotRadius?: number;
}

export interface TreeChartLayoutNode {
  id: string;
  node: TreeNode;
  depth: number;
  parentId: string | null;
  childIds: string[];
  /** 圆点中心。 */
  x: number;
  y: number;
  labelWidth: number;
  totalChildren: number;
  /** 全部后代数量（不论是否折叠）。 */
  descendantCount: number;
  /** 因为自身折叠而隐藏的后代数量。 */
  hiddenCount: number;
  collapsed: boolean;
  hasChildren: boolean;
  /** 有任一出边（含交叉边）：用于空心环判定，不参与折叠。 */
  hasOutgoing: boolean;
  leaf: boolean;
}

export interface TreeChartLayoutEdge {
  id: string;
  source: string;
  target: string;
  /** 目标节点所在层；用于脉冲级联。 */
  depth: number;
  value: number;
  width: number;
  opacity: number;
  /** 由树的父子关系生成（相对 `links` 里的交叉边）。 */
  tree: boolean;
  pulse: boolean;
  unavailable: boolean;
  label: string | null;
  path: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  labelX: number;
  labelY: number;
}

export interface TreeChartLayout {
  nodes: TreeChartLayoutNode[];
  edges: TreeChartLayoutEdge[];
  byId: Map<string, TreeChartLayoutNode>;
  edgeByPair: Map<string, TreeChartLayoutEdge>;
  width: number;
  height: number;
  maxDepth: number;
  maxValue: number;
}

export interface TreeChartHighlight {
  nodeIds: ReadonlySet<string>;
  edgeIds: ReadonlySet<string>;
}

const DEFAULT_OPTIONS = {
  rowHeight: 30,
  minColumnWidth: 148,
  paddingX: 14,
  paddingY: 12,
  fontSize: 11,
  labelGap: 10,
  dotRadius: 5,
} as const;

export type ResolvedTreeChartLayoutOptions = {
  -readonly [K in keyof typeof DEFAULT_OPTIONS]: number;
};

function resolveOptions(
  options: TreeChartLayoutOptions,
): ResolvedTreeChartLayoutOptions {
  return {
    rowHeight: options.rowHeight ?? DEFAULT_OPTIONS.rowHeight,
    minColumnWidth: options.minColumnWidth ?? DEFAULT_OPTIONS.minColumnWidth,
    paddingX: options.paddingX ?? DEFAULT_OPTIONS.paddingX,
    paddingY: options.paddingY ?? DEFAULT_OPTIONS.paddingY,
    fontSize: options.fontSize ?? DEFAULT_OPTIONS.fontSize,
    labelGap: options.labelGap ?? DEFAULT_OPTIONS.labelGap,
    dotRadius: options.dotRadius ?? DEFAULT_OPTIONS.dotRadius,
  };
}

/** 粗略的标签宽度：CJK 按 1em、拉丁按 0.58em，留出 `+N` 的空间。 */
export function treeLabelWidth(name: string, fontSize = 11): number {
  let units = 0;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x2e80) units += 1;
    else if (char === " ") units += 0.32;
    else units += 0.58;
  }
  return Math.ceil(units * fontSize);
}

/** 三次贝塞尔；`C` 是验收断言里的关键字，不要换成二次曲线。 */
export function treeCurvePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  const dx = Math.max(24, Math.abs(x2 - x1) * 0.5);
  const round = (value: number): number => Math.round(value * 100) / 100;
  return `M ${round(x1)} ${round(y1)} C ${round(x1 + dx)} ${round(y1)}, ${round(x2 - dx)} ${round(y2)}, ${round(x2)} ${round(y2)}`;
}

export function treeEdgeWidth(value: number, maxValue: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(maxValue)) return 1;
  if (value <= 0 || maxValue <= 0) return 1;
  const ratio = Math.min(1, value / maxValue);
  return Math.round((1 + 5 * ratio) * 100) / 100;
}

export function treeEdgeOpacity(value: number, maxValue: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(maxValue)) return 0.45;
  if (value <= 0 || maxValue <= 0) return 0.45;
  const ratio = Math.min(1, value / maxValue);
  return Math.round((0.45 + 0.55 * ratio) * 100) / 100;
}

function countDescendants(
  node: TreeNode,
  memo: Map<TreeNode, number>,
): number {
  const cached = memo.get(node);
  if (cached !== undefined) return cached;
  let total = 0;
  for (const child of node.children ?? []) {
    total += 1 + countDescendants(child, memo);
  }
  memo.set(node, total);
  return total;
}

interface VisitContext {
  options: ResolvedTreeChartLayoutOptions;
  collapsedIds: ReadonlySet<string>;
  descendants: Map<TreeNode, number>;
  nextLeafRow: number;
  byId: Map<string, TreeChartLayoutNode>;
}

function visit(
  context: VisitContext,
  node: TreeNode,
  depth: number,
  parentId: string | null,
  fallbackId: string,
): TreeChartLayoutNode {
  const id =
    typeof node.id === "string" && node.id !== "" ? node.id : fallbackId;
  const children = node.children ?? [];
  const collapsed = children.length > 0 && context.collapsedIds.has(id);
  const layout: TreeChartLayoutNode = {
    id,
    node,
    depth,
    parentId,
    childIds: [],
    x: 0,
    y: 0,
    labelWidth: treeLabelWidth(node.name, context.options.fontSize),
    totalChildren: children.length,
    descendantCount: countDescendants(node, context.descendants),
    hiddenCount: collapsed ? countDescendants(node, context.descendants) : 0,
    collapsed,
    hasChildren: children.length > 0,
    hasOutgoing: false,
    leaf: children.length === 0,
  };
  context.byId.set(id, layout);

  if (!collapsed) {
    const kids: TreeChartLayoutNode[] = [];
    for (let index = 0; index < children.length; index += 1) {
      kids.push(
        visit(context, children[index], depth + 1, id, `${id}/${index}`),
      );
    }
    layout.childIds = kids.map((kid) => kid.id);
    if (kids.length > 0) {
      layout.y = (kids[0].y + kids[kids.length - 1].y) / 2;
    }
  }
  if (layout.childIds.length === 0) {
    layout.y = context.nextLeafRow * context.options.rowHeight;
    context.nextLeafRow += 1;
  }
  return layout;
}

function assignColumns(
  nodes: readonly TreeChartLayoutNode[],
  options: ResolvedTreeChartLayoutOptions,
): { xForDepth: number[]; width: number } {
  const maxDepth = nodes.reduce((max, node) => Math.max(max, node.depth), 0);
  const contentWidth: number[] = Array.from(
    { length: maxDepth + 1 },
    () => 0,
  );
  for (const node of nodes) {
    const extra = node.hiddenCount > 0 ? 26 : 0;
    contentWidth[node.depth] = Math.max(
      contentWidth[node.depth],
      node.labelWidth + extra,
    );
  }
  const columnWidth = contentWidth.map(
    (width) => options.dotRadius * 2 + options.labelGap + width + 24,
  );
  const xForDepth: number[] = [];
  let cursor = options.paddingX;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    xForDepth.push(cursor);
    cursor += Math.max(options.minColumnWidth, columnWidth[depth]);
  }
  return { xForDepth, width: cursor + options.paddingX };
}

function createEdge(
  source: TreeChartLayoutNode,
  target: TreeChartLayoutNode,
  link: TreeChartLink | undefined,
  tree: boolean,
  options: ResolvedTreeChartLayoutOptions,
  maxValue: number,
  fallbackId: string,
): TreeChartLayoutEdge {
  const value = link?.value ?? (tree ? target.node.value ?? 0 : 0);
  const x1 = source.x + options.dotRadius;
  const y1 = source.y;
  const x2 = Math.max(x1 + 24, target.x - options.dotRadius);
  const y2 = target.y;
  return {
    id: link?.id ?? fallbackId,
    source: source.id,
    target: target.id,
    depth: target.depth,
    value,
    width: treeEdgeWidth(value, maxValue),
    opacity: treeEdgeOpacity(value, maxValue),
    tree,
    pulse: link?.pulse ?? (tree && value > 0 && link?.unavailable !== true),
    unavailable: link?.unavailable === true,
    label: link?.label ?? null,
    path: treeCurvePath(x1, y1, x2, y2),
    x1,
    y1,
    x2,
    y2,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2 - 6,
  };
}

/** 三次贝塞尔上 t 处的点；标签跟着曲线走，而不是取两端的中点。 */
function cubicPoint(
  t: number,
  x0: number,
  x1: number,
  x2: number,
  x3: number,
  y0: number,
  y1: number,
  y2: number,
  y3: number,
): { x: number; y: number } {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * x0 + b * x1 + c * x2 + d * x3,
    y: a * y0 + b * y1 + c * y2 + d * y3,
  };
}

/** 同一列的多条边标签横向/纵向摊开，避免数字叠成一行。 */
function spreadEdgeLabels(edges: readonly TreeChartLayoutEdge[]): void {
  const groups = new Map<string, TreeChartLayoutEdge[]>();
  for (const edge of edges) {
    const group = groups.get(edge.source);
    if (group === undefined) groups.set(edge.source, [edge]);
    else group.push(edge);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.y2 - b.y2 || a.target.localeCompare(b.target));
    const count = group.length;
    for (let index = 0; index < count; index += 1) {
      const edge = group[index];
      // 标签沿曲线靠近目标侧：源节点右边就是它自己的标签，落在中点会
      // 叠上去；扇出很多条时曲线末端已经铺开，标签才不会挤成一坨。
      const t =
        count === 1
          ? 0.66
          : 0.66 +
            (index / (count - 1) - 0.5) * Math.min(0.26, 0.08 * (count - 1));
      const dx = Math.max(24, Math.abs(edge.x2 - edge.x1) * 0.5);
      const point = cubicPoint(
        t,
        edge.x1,
        edge.x1 + dx,
        edge.x2 - dx,
        edge.x2,
        edge.y1,
        edge.y1,
        edge.y2,
        edge.y2,
      );
      edge.labelX = point.x;
      edge.labelY = point.y - 5;
    }
  }
}

/** 计算整棵树的可见节点、列坐标、行坐标和曲线路径。 */
export function buildTreeChartLayout(
  data: TreeNode,
  options: TreeChartLayoutOptions = {},
): TreeChartLayout {
  const resolved = resolveOptions(options);
  const context: VisitContext = {
    options: resolved,
    collapsedIds: options.collapsedIds ?? new Set<string>(),
    descendants: new Map<TreeNode, number>(),
    nextLeafRow: 0,
    byId: new Map<string, TreeChartLayoutNode>(),
  };
  const root = visit(context, data, 0, null, "tree-root");

  const nodes: TreeChartLayoutNode[] = [];
  const stack: TreeChartLayoutNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as TreeChartLayoutNode;
    nodes.push(node);
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) {
      const child = context.byId.get(node.childIds[index]);
      if (child !== undefined) stack.push(child);
    }
  }

  const { xForDepth, width } = assignColumns(nodes, resolved);
  const rowCount = Math.max(1, context.nextLeafRow);
  const offsetY = resolved.paddingY + resolved.rowHeight / 2;
  for (const node of nodes) {
    node.x = xForDepth[node.depth];
    node.y += offsetY;
  }
  const height =
    resolved.paddingY * 2 +
    Math.max(resolved.rowHeight, rowCount * resolved.rowHeight);

  const links = options.links ?? [];
  const linkByPair = new Map<string, TreeChartLink>();
  for (const link of links) {
    const pair = `${link.source}->${link.target}`;
    if (!linkByPair.has(pair)) linkByPair.set(pair, link);
  }
  // 边宽用真实边的最大链数归一化；没有 links 时才退回节点值。
  const maxValue = Math.max(
    1,
    ...links.map((link) => link.value),
    ...nodes
      .filter(
        (node) =>
          node.parentId !== null &&
          !linkByPair.has(`${node.parentId}->${node.id}`),
      )
      .map((node) => node.node.value ?? 0),
  );
  const consumed = new Set<string>();
  const edges: TreeChartLayoutEdge[] = [];
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const parent = context.byId.get(node.parentId);
    if (parent === undefined) continue;
    const pair = `${parent.id}->${node.id}`;
    const link = linkByPair.get(pair);
    if (link !== undefined) consumed.add(pair);
    edges.push(
      createEdge(
        parent,
        node,
        link,
        true,
        resolved,
        maxValue,
        `edge-${pair}`,
      ),
    );
  }
  for (const link of links) {
    const pair = `${link.source}->${link.target}`;
    if (consumed.has(pair)) continue;
    const source = context.byId.get(link.source);
    const target = context.byId.get(link.target);
    if (source === undefined || target === undefined) continue;
    edges.push(
      createEdge(source, target, link, false, resolved, maxValue, `edge-${pair}`),
    );
  }
  spreadEdgeLabels(edges);
  const outgoing = new Set(edges.map((edge) => edge.source));
  for (const node of nodes) node.hasOutgoing = outgoing.has(node.id);

  const edgeByPair = new Map<string, TreeChartLayoutEdge>();
  for (const edge of edges) {
    if (edge.tree) edgeByPair.set(`${edge.source}->${edge.target}`, edge);
  }

  return {
    nodes,
    edges,
    byId: context.byId,
    edgeByPair,
    width,
    height,
    maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
    maxValue,
  };
}

/** 节点到根的主路径（含自身与根）。 */
export function treeNodePathToRoot(
  layout: TreeChartLayout,
  nodeId: string,
): string[] {
  const path: string[] = [];
  let current = layout.byId.get(nodeId);
  const guard = new Set<string>();
  while (current !== undefined && !guard.has(current.id)) {
    guard.add(current.id);
    path.push(current.id);
    current =
      current.parentId === null
        ? undefined
        : layout.byId.get(current.parentId);
  }
  return path;
}

/** hover / focus 高亮：节点走主路径，边把两端到根的路径都点亮。 */
export function treeHighlightPath(
  layout: TreeChartLayout,
  target: { nodeId?: string; edgeId?: string },
): TreeChartHighlight {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const addNodePath = (nodeId: string): void => {
    let current = layout.byId.get(nodeId);
    const guard = new Set<string>();
    while (current !== undefined && !guard.has(current.id)) {
      guard.add(current.id);
      nodeIds.add(current.id);
      if (current.parentId === null) break;
      const edge = layout.edgeByPair.get(
        `${current.parentId}->${current.id}`,
      );
      if (edge !== undefined) edgeIds.add(edge.id);
      current = layout.byId.get(current.parentId);
    }
  };
  if (target.nodeId !== undefined) addNodePath(target.nodeId);
  if (target.edgeId !== undefined) {
    const edge = layout.edges.find((item) => item.id === target.edgeId);
    if (edge !== undefined) {
      edgeIds.add(edge.id);
      addNodePath(edge.source);
      addNodePath(edge.target);
    }
  }
  return { nodeIds, edgeIds };
}
