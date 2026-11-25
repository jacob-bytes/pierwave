/**
 * 横向树图的纯布局逻辑（无 React / DOM）。
 *
 * 目标视觉与 shadcn TreeChart 对齐：根在最左、层级向右展开、节点是圆点
 * （中间节点空心环、叶子实心点）、标签在圆点右侧、父到子用平滑贝塞尔曲线。
 *
 * 布局 O(n)：一次先序确定叶子的行号，父节点取首尾子节点的中点；列宽按
 * 该层最长标签估算，避免标签压到下一列。折叠只影响可见子节点，隐藏数量
 * 记在节点上（`+N`）。
 *
 * 标签方向：根节点标签在圆点**左侧**（右对齐，否则「入口」会压住根圆点），
 * 叶子与中间层标签在圆点右侧。传入 `availableWidth` 时出图宽度取
 * `max(内容宽度, 容器宽度)`，内容在容器内水平居中；内容更宽时保持原宽度，
 * 由渲染层的横向滚动兜底。
 *
 * 行高 44 与节点命中区同档：再密下去 44×44 的触摸目标会上下重叠，点一个
 * 节点会命中另一个。长标签截断到 24 字符 + `…`（完整名留给 aria / tooltip），
 * 边透明度下限 0.7、最细 1.5px，保证亮暗主题下都 ≥3:1。
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
  /** 路径降级：链路还在，但成员异常 / 无数据；标黄、不脉冲。 */
  degraded?: boolean;
  /** 边不可用时的最近一次 P50；只用于「最近已知」，不当当前值展示。 */
  lastP50Ms?: number | null;
  /** 路径上的用户数（aria 附带信息）。 */
  users?: number;
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
  /**
   * 容器可用宽度。给了就按 `max(内容所需宽度, availableWidth)` 出图，并把
   * 内容在可用宽度内水平居中；内容更宽时宽度不缩，仍由渲染层横向滚动。
   * 不给时只按内容宽度出图（纯布局 / 嵌入式使用）。
   */
  availableWidth?: number;
}

/** 标签在圆点的哪一侧：根节点 `end`（左侧、右对齐），其余 `start`（右侧）。 */
export type TreeLabelAnchor = "start" | "end";

export interface TreeChartLayoutNode {
  id: string;
  node: TreeNode;
  /** 画在圆点侧面的文本：长标签已截断，完整名仍在 `node.name`。 */
  displayName: string;
  depth: number;
  parentId: string | null;
  childIds: string[];
  /** 圆点中心。 */
  x: number;
  y: number;
  /** 圆点半径（根节点 6.5，其余用 `dotRadius` 选项，默认 5）。 */
  dotRadius: number;
  /** 标签盒子相对锚点的总宽（显示名 + 折叠的 `+N`）。 */
  labelExtent: number;
  /** 标签锚点 x：根节点在圆点左侧，其余在圆点右侧。 */
  labelX: number;
  /** 标签对齐方向。 */
  labelAnchor: TreeLabelAnchor;
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
  /** 成员异常 / 无数据：标黄、不脉冲，也不显示成「最近已知」。 */
  degraded: boolean;
  /** 同源扇出过密：P50 只在 hover / focus 时显示。 */
  dense: boolean;
  /** 不可用边的最近一次 P50；`unavailable` 为 false 时恒为 null。 */
  lastP50Ms: number | null;
  users: number;
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
  // 44 = 节点最小命中区；行距小于 44 时命中矩形会上下重叠，触点会点错节点。
  rowHeight: 44,
  minColumnWidth: 148,
  paddingX: 14,
  paddingY: 12,
  fontSize: 11,
  labelGap: 10,
  dotRadius: 5,
} as const;

/** 节点圆点的最小命中区（触摸目标）。 */
export const TREE_NODE_HIT_SIZE = 44;

/** 根节点圆点半径：比中间层 / 叶子大一圈，作为入口的视觉锚点。 */
export const TREE_ROOT_DOT_RADIUS = 6.5;

/**
 * 默认主题下标签相对圆点中心的水平偏移（圆点半径 5 + 间距 10）。
 * 实际坐标以布局里的 `labelX` 为准；这里只给命中区兜底用。
 */
export const TREE_LABEL_OFFSET = 15;

/** 标签超过这个字符数就截断，完整名留给 tooltip / aria。 */
export const TREE_LABEL_MAX_CHARS = 24;

/** 同源边超过这个数量就算密集扇出：P50 只在 hover / focus 时显示。 */
export const TREE_DENSE_FANOUT = 6;

/** 同时跑脉冲动画的边数上限；其余边保持静态，避免上百条 SVG 动画。 */
export const TREE_PULSE_LIMIT = 10;

/**
 * 标签截断：按字符（code point）计数，CJK / emoji 不会被切成半个。
 * 布局宽度与渲染共用同一份文本，避免「算宽度用全名、画出来是截断名」。
 */
export function truncateTreeLabel(
  name: string,
  max = TREE_LABEL_MAX_CHARS,
): string {
  const limit = Math.max(1, Math.floor(max));
  const chars = [...name];
  if (chars.length <= limit) return name;
  return `${chars.slice(0, limit).join("")}…`;
}

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

/**
 * 粗略的标签宽度：CJK 按 1em，数字按 0.56em，`.` / `:` 等窄标点按 0.25em，
 * `-` / `/` 等按 0.34em，其余拉丁按 0.58em，留出 `+N` 的空间。
 *
 * 这组比例按 Geist 的实际字形拟合（host:port 里的标点比字母窄得多）：
 * 全部按 0.58em 会把 `1.2.3.4:443` 高估约 30%，居中时肉眼可见偏左。
 */
export function treeLabelWidth(name: string, fontSize = 11): number {
  let units = 0;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x2e80) units += 1;
    else if (char === " ") units += 0.28;
    else if (char === "." || char === "," || char === ":") units += 0.25;
    else if (char === "-" || char === "_" || char === "/" || char === "|") {
      units += 0.34;
    } else if (code >= 0x30 && code <= 0x39) units += 0.56;
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
  if (!Number.isFinite(value) || !Number.isFinite(maxValue)) return 1.5;
  if (value <= 0 || maxValue <= 0) return 1.5;
  const ratio = Math.min(1, value / maxValue);
  // 最细 1.5px：0.7 透明度配 1px 在亮色下仍低于 3:1，细线会直接消失。
  return Math.round((1.5 + 4.5 * ratio) * 100) / 100;
}

export function treeEdgeOpacity(value: number, maxValue: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(maxValue)) return 0.7;
  if (value <= 0 || maxValue <= 0) return 0.7;
  const ratio = Math.min(1, value / maxValue);
  // 下限 0.7：亮 / 暗主题下与卡片背景都保持 ≥3:1，弱化不等于看不见。
  return Math.round((0.7 + 0.3 * ratio) * 100) / 100;
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
  const displayName = truncateTreeLabel(node.name);
  const labelWidth = treeLabelWidth(displayName, context.options.fontSize);
  const descendantCount = countDescendants(node, context.descendants);
  const hiddenCount = collapsed ? descendantCount : 0;
  // `+N` 是同一行的 tspan（dx=4），按同一套字宽算进标签包围盒，避免折叠
  // 后标签盒忽大忽小、把居中带偏。
  const hiddenWidth =
    hiddenCount > 0
      ? 4 + treeLabelWidth(`+${hiddenCount}`, context.options.fontSize)
      : 0;
  const layout: TreeChartLayoutNode = {
    id,
    node,
    displayName,
    depth,
    parentId,
    childIds: [],
    x: 0,
    y: 0,
    dotRadius: depth === 0 ? TREE_ROOT_DOT_RADIUS : context.options.dotRadius,
    labelExtent: labelWidth + hiddenWidth,
    labelX: 0,
    labelAnchor: depth === 0 ? "end" : "start",
    labelWidth,
    totalChildren: children.length,
    descendantCount,
    hiddenCount,
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
): { xForDepth: number[] } {
  const maxDepth = nodes.reduce((max, node) => Math.max(max, node.depth), 0);
  const contentWidth: number[] = Array.from(
    { length: maxDepth + 1 },
    () => 0,
  );
  for (const node of nodes) {
    contentWidth[node.depth] = Math.max(
      contentWidth[node.depth],
      node.labelExtent,
    );
  }
  const columnWidth = contentWidth.map(
    (width) => options.dotRadius * 2 + options.labelGap + width + 24,
  );
  // 根节点的标签在圆点左侧：首列 x 要把根标签的宽度让出来，否则根标签会
  // 被左 padding 裁掉，或者被挤到圆点上。
  let cursor =
    options.paddingX +
    TREE_ROOT_DOT_RADIUS +
    options.labelGap +
    contentWidth[0];
  const xForDepth: number[] = [];
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    xForDepth.push(cursor);
    cursor += Math.max(options.minColumnWidth, columnWidth[depth]);
  }
  return { xForDepth };
}

/** 内容（圆点 + 标签）的水平包围盒，不含左右 padding。 */
function contentHorizontalBounds(nodes: readonly TreeChartLayoutNode[]): {
  left: number;
  right: number;
} {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const labelLeft =
      node.labelAnchor === "end"
        ? node.labelX - node.labelExtent
        : node.labelX;
    const labelRight =
      node.labelAnchor === "end"
        ? node.labelX
        : node.labelX + node.labelExtent;
    left = Math.min(left, node.x - node.dotRadius, labelLeft);
    right = Math.max(right, node.x + node.dotRadius, labelRight);
  }
  return { left, right };
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
  const unavailable = link?.unavailable === true;
  const degraded = link?.degraded === true;
  return {
    id: link?.id ?? fallbackId,
    source: source.id,
    target: target.id,
    depth: target.depth,
    value,
    width: treeEdgeWidth(value, maxValue),
    opacity: treeEdgeOpacity(value, maxValue),
    tree,
    // 降级 / 不可用路径不再脉冲：脉冲只解释「活着的流量」。
    pulse:
      link?.pulse ?? (tree && value > 0 && !unavailable && !degraded),
    unavailable,
    degraded,
    dense: false,
    lastP50Ms:
      unavailable && typeof link?.lastP50Ms === "number"
        ? link.lastP50Ms
        : null,
    users: typeof link?.users === "number" ? link.users : 0,
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

  const { xForDepth } = assignColumns(nodes, resolved);
  const rowCount = Math.max(1, context.nextLeafRow);
  const offsetY = resolved.paddingY + resolved.rowHeight / 2;
  for (const node of nodes) {
    node.x = xForDepth[node.depth];
    node.y += offsetY;
    node.labelX =
      node.labelAnchor === "end"
        ? node.x - node.dotRadius - resolved.labelGap
        : node.x + node.dotRadius + resolved.labelGap;
  }
  // 宽度 = max(内容所需, 容器可用)；多出来的空间平均分到左右，内容居中。
  // 内容比容器宽时保持自然宽度，由渲染层横向滚动，不压缩列距。
  const bounds = contentHorizontalBounds(nodes);
  const naturalWidth = bounds.right - bounds.left + resolved.paddingX * 2;
  const availableWidth =
    typeof options.availableWidth === "number" &&
    Number.isFinite(options.availableWidth) &&
    options.availableWidth > 0
      ? options.availableWidth
      : 0;
  const width = Math.max(naturalWidth, availableWidth);
  const dx = (width - naturalWidth) / 2 + resolved.paddingX - bounds.left;
  if (dx !== 0) {
    for (const node of nodes) {
      node.x += dx;
      node.labelX += dx;
    }
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
  // 密集扇出：同一个源出去的边太多时，P50 标签会互相压住；标记出来由
  // 渲染层改成「只在 hover / focus 时显示」。
  const fanout = new Map<string, number>();
  for (const edge of edges) {
    fanout.set(edge.source, (fanout.get(edge.source) ?? 0) + 1);
  }
  for (const edge of edges) {
    edge.dense = (fanout.get(edge.source) ?? 0) > TREE_DENSE_FANOUT;
  }
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

/* ------------------------------------------------------------------ */
/* 几何包围盒：标签不压圆点、内容居中的确定性断言                        */
/* ------------------------------------------------------------------ */

export interface TreeChartBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 圆点的视觉包围盒（根节点半径更大）。 */
export function treeNodeDotBounds(node: TreeChartLayoutNode): TreeChartBounds {
  return {
    left: node.x - node.dotRadius,
    right: node.x + node.dotRadius,
    top: node.y - node.dotRadius,
    bottom: node.y + node.dotRadius,
  };
}

/** 节点标签的包围盒：按锚点方向展开，高度按字号上下各半。 */
export function treeNodeLabelBounds(
  node: TreeChartLayoutNode,
  fontSize = DEFAULT_OPTIONS.fontSize,
): TreeChartBounds {
  const halfHeight = fontSize / 2;
  const labelLeft =
    node.labelAnchor === "end" ? node.labelX - node.labelExtent : node.labelX;
  const labelRight =
    node.labelAnchor === "end" ? node.labelX : node.labelX + node.labelExtent;
  return {
    left: labelLeft,
    right: labelRight,
    top: node.y - halfHeight,
    bottom: node.y + halfHeight,
  };
}

/** 整张图内容（圆点 + 标签）的包围盒，不含左右 padding。 */
export function treeChartContentBounds(
  layout: TreeChartLayout,
): TreeChartBounds {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const node of layout.nodes) {
    for (const box of [treeNodeDotBounds(node), treeNodeLabelBounds(node)]) {
      left = Math.min(left, box.left);
      right = Math.max(right, box.right);
      top = Math.min(top, box.top);
      bottom = Math.max(bottom, box.bottom);
    }
  }
  return { left, right, top, bottom };
}

/** 两个包围盒是否相交（碰边不算）。 */
export function treeBoundsOverlap(
  a: TreeChartBounds,
  b: TreeChartBounds,
): boolean {
  return (
    a.left < b.right &&
    b.left < a.right &&
    a.top < b.bottom &&
    b.top < a.bottom
  );
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
  if (target.nodeId !== undefined) {
    addNodePath(target.nodeId);
    // 汇入该节点的交叉边也要亮：否则 hover 一个汇合点，看不到另一条
    // 来源还在往这里送流量。source 同样补一条到根的路径；`addNodePath`
    // 自带 visited 守卫，交叉边反向指回来也不会死循环。
    for (const edge of layout.edges) {
      if (edge.tree || edge.target !== target.nodeId) continue;
      edgeIds.add(edge.id);
      addNodePath(edge.source);
    }
  }
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

/* ------------------------------------------------------------------ */
/* F3 tooltip 定位：实测尺寸 + 可见区夹紧                               */
/* ------------------------------------------------------------------ */

export interface TreeTooltipPlacementInput {
  /** 锚点在图表内容坐标系里的位置（与 tooltip 同一坐标系）。 */
  anchorX: number;
  anchorY: number;
  /** 锚点元素的高度：节点 44（命中区），边 0。翻到下方时要从锚点下沿再让开。 */
  anchorHeight?: number;
  /** tooltip 的实测尺寸（`getBoundingClientRect` / `offsetWidth/Height`）。 */
  width: number;
  height: number;
  /** 滚动容器的可见窗口，同样是内容坐标系（= scrollLeft / clientWidth）。 */
  visibleLeft: number;
  visibleWidth: number;
  visibleTop: number;
  visibleHeight: number;
  gap?: number;
  margin?: number;
}

export interface TreeTooltipPlacement {
  x: number;
  y: number;
  /** true = 翻到锚点下方（上方放不下）。 */
  below: boolean;
  clampedX: boolean;
  clampedY: boolean;
}

export const TREE_TOOLTIP_GAP = 8;
export const TREE_TOOLTIP_MARGIN = 8;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampAxis(
  value: number,
  min: number,
  max: number,
): { value: number; clamped: boolean } {
  if (max < min) return { value: min, clamped: true };
  if (value < min) return { value: min, clamped: true };
  if (value > max) return { value: max, clamped: true };
  return { value, clamped: false };
}

/**
 * tooltip 定位（纯函数，便于用真实尺寸回归 1440 / 390 两个极端）。
 *
 * 竖直方向优先放锚点上方；上方放不下（首行节点）就翻到下方，再用实测
 * 高度夹紧到可见区。水平方向按可见窗口夹紧，而不是按整张图的宽度——
 * 390 滚到末端时 iframe 的可见窗口比内容窄，按内容宽度夹紧会被裁掉。
 */
export function placeTreeTooltip(
  input: TreeTooltipPlacementInput,
): TreeTooltipPlacement {
  const gap = input.gap ?? TREE_TOOLTIP_GAP;
  const margin = input.margin ?? TREE_TOOLTIP_MARGIN;
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height);

  const horizontal = clampAxis(
    input.anchorX - width / 2,
    input.visibleLeft + margin,
    input.visibleLeft + input.visibleWidth - width - margin,
  );

  const anchorHeight = Math.max(0, input.anchorHeight ?? 0);
  const above = input.anchorY - anchorHeight / 2 - gap - height;
  const below = above < input.visibleTop + margin;
  const vertical = clampAxis(
    below ? input.anchorY + anchorHeight / 2 + gap : above,
    input.visibleTop + margin,
    input.visibleTop + input.visibleHeight - height - margin,
  );

  return {
    x: round2(horizontal.value),
    y: round2(vertical.value),
    below,
    clampedX: horizontal.clamped,
    clampedY: vertical.clamped,
  };
}

/* ------------------------------------------------------------------ */
/* F4 脉冲并发上限                                                     */
/* ------------------------------------------------------------------ */

/**
 * 只有 Top N 条（默认 10）可用路径跑 CSS 脉冲，其余边保持静态。
 *
 * 选择依据：链数降序（流量最大的路径最值得动），同链数时层级浅的优先，
 * 让脉冲在靠近入口的地方更集中；不可用 / 降级路径本来就不参与。
 */
export function selectPulseEdgeIds(
  edges: readonly {
    id: string;
    value: number;
    pulse: boolean;
    unavailable: boolean;
    degraded: boolean;
    depth?: number;
  }[],
  limit: number = TREE_PULSE_LIMIT,
): Set<string> {
  const candidates = edges.filter(
    (edge) => edge.pulse && !edge.unavailable && !edge.degraded,
  );
  candidates.sort(
    (a, b) =>
      b.value - a.value ||
      (a.depth ?? 0) - (b.depth ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const take = Math.max(0, Math.floor(limit));
  return new Set(candidates.slice(0, take).map((edge) => edge.id));
}

/* ------------------------------------------------------------------ */
/* F5 触点首点只选中                                                   */
/* ------------------------------------------------------------------ */

export type TreeChartActivation = "reveal" | "toggle";

/**
 * 点击节点要做什么：
 * - 鼠标（hover 可用）：直接折叠 / 展开；
 * - 触点：第一下只选中并显示 tooltip（否则一点就把子树收起来，用户
 *   还没看到内容），再点同一个节点才折叠。
 */
export function treeNodeActivation(input: {
  hoverCapable: boolean;
  armedId: string | null;
  nodeId: string;
}): TreeChartActivation {
  if (input.hoverCapable) return "toggle";
  return input.armedId === input.nodeId ? "toggle" : "reveal";
}
