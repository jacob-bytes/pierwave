/**
 * 转发链模板拓扑图的纯逻辑：卡片列 + 直角折线（无 React / DOM / i18n）。
 *
 * 数据流（三步，全部可单测）：
 *
 *   buildTemplateGraph(detail) → 入口列 / 各跳列 / 目标列 + 原始边 + 未使用候选
 *   foldTemplateGraph(graph)   → 每列 ≤4 张成员卡 + 1 张折叠卡；目标列每个上游
 *                                至少留 1 张，其余折成目标卡上的 `+N` 标签
 *   layoutTemplateGraph(folded)→ 列 x / 行 y / 直角折线路径 / 时延药丸落点
 *   initialViewport(layout, size) → 0.4–1.6 内的首屏视口（≥0.9 且 ≤1）
 *
 * 折叠语义与旧树图一致：只收 `chains > 0` 的实际路径；被折成员的连线按
 * 「同一目的地」合并成一条虚线（宽度 = 链数之和，无时延、不脉冲）。
 * 目标折叠不再产生独立节点 —— `+N 个目标` 是目标卡上的小标签，点它只展开
 * 这一组上游的目标。
 *
 * 状态口径与链路详情一致：online / offline / degraded / unknown。
 * 不可用路径不给当前 P50（`p50Ms = null`），历史值只以 `lastP50Ms` 出现。
 */

import { targetLabel } from "./chainTemplateInsight.ts";
import type {
  ChainTemplateDetail,
  ChainTemplateEdge,
  ChainTemplateMember,
  ChainTemplateMemberStatus,
} from "./chainTemplateInsight.ts";

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 每列最多几张成员卡；其余折成一张 `+N 台`。 */
export const TEMPLATE_FOLD_LIMIT = 4;
/** 折叠卡 / 目标 `+N` 的悬停名单最多列前 8 名。 */
export const TEMPLATE_FOLD_TOP = 8;
/** 同时跑脉冲动画的边数上限。 */
export const TEMPLATE_PULSE_LIMIT = 10;

export const TEMPLATE_CARD_WIDTH = 192;
export const TEMPLATE_CARD_HEIGHT = 64;
/** 列间空隙：正好放直角折线的竖线与时延药丸（80px 让 4 列在 0.9 下仍读得清）。 */
export const TEMPLATE_COLUMN_GAP = 80;
export const TEMPLATE_ROW_GAP = 16;
export const TEMPLATE_PADDING = 24;

/** 时延药丸固定盒子：落点由纯函数决定，不依赖字体测量。 */
export const TEMPLATE_PILL_WIDTH = 44;
export const TEMPLATE_PILL_HEIGHT = 18;
export const TEMPLATE_PILL_GAP = 4;
/** 同一竖线超过这个数量的药丸默认隐藏，悬停竖线或聚焦才显示。 */
export const TEMPLATE_PILL_DENSE_LIMIT = 6;

/** 画布高度：不低于 320，上限 min(640, 视口高度 × 0.52)。 */
export const TEMPLATE_CANVAS_MIN_HEIGHT = 320;
export const TEMPLATE_CANVAS_MAX_HEIGHT = 640;
export const TEMPLATE_CANVAS_VIEWPORT_RATIO = 0.52;

export const TEMPLATE_EDGE_RADIUS = 8;
/**
 * 合并虚线的竖线从列间中线右移一点：被折成员合并出的那条线要和同一列
 * 正常连线的竖脊分开，否则虚线会把一整条蓝色竖脊染成告警色。
 */
export const TEMPLATE_MERGED_RAIL_OFFSET = 14;
/**
 * 降级 / 不可用连线的竖脊也各让开一点：同一列的连线共用一条竖线时，
 * 后画的告警色会把整条蓝脊染色，看起来像所有路径都降级了。
 */
export const TEMPLATE_STATUS_RAIL_OFFSET = 10;
export const TEMPLATE_EDGE_MIN_WIDTH = 1.5;
export const TEMPLATE_EDGE_MAX_WIDTH = 6;

/** 交互缩放边界（滚轮 / 按钮 / 捏合）。 */
export const TEMPLATE_MIN_ZOOM = 0.4;
export const TEMPLATE_MAX_ZOOM = 1.6;
/** 首屏缩放下限：内容再大也不缩到 0.9 以下，改由平移 / 横向滚动看全。 */
export const TEMPLATE_INITIAL_MIN_ZOOM = 0.9;
/** 首屏缩放上限：内容很小也不放大超过 1（100% 下的 11px 才是真下限）。 */
export const TEMPLATE_INITIAL_MAX_ZOOM = 1;
/** 缩放栏的按钮步进：±25%，100 → 50 / 150 都是整步。 */
export const TEMPLATE_ZOOM_STEP = 0.25;

const TARGET_SEQ_FALLBACK = 0;
const ROOT_GROUP = "__root__";

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export type TemplateCardRole = "entry" | "hop" | "target" | "fold";

export interface TemplateGraphMember {
  /** 稳定 id：入口 `e:0:<identity>`、中间跳 `h:<seq>:<identity>`、目标 `t:<label>`。 */
  id: string;
  name: string;
  seq: number;
  role: "entry" | "hop" | "target";
  status: ChainTemplateMemberStatus;
  chains: number;
  users: number;
  offline: boolean;
  degraded: boolean;
  /** 目标：汇入它的上游卡片 id（按链数降序）。 */
  upstreamIds: string[];
}

export interface TemplateGraphColumn {
  seq: number;
  role: "entry" | "hop" | "target";
  members: TemplateGraphMember[];
}

export interface TemplateGraphEdge {
  id: string;
  source: string;
  target: string;
  sourceSeq: number;
  targetSeq: number;
  chains: number;
  users: number;
  /** 当前 P50；不可用时为 null。 */
  p50Ms: number | null;
  /** 不可用时的最近一次 P50（只做「最近已知」）。 */
  lastP50Ms: number | null;
  unavailable: boolean;
  degraded: boolean;
}

export interface TemplateGraphUnusedMember {
  key: string;
  name: string;
  seq: number;
  status: ChainTemplateMemberStatus;
}

export interface TemplateGraph {
  hops: number;
  targetSeq: number;
  columns: TemplateGraphColumn[];
  edges: TemplateGraphEdge[];
  unused: TemplateGraphUnusedMember[];
  usedMemberCount: number;
  targetCount: number;
  empty: boolean;
}

export interface TemplateFoldLimits {
  /** 每列最多几张成员卡（默认 4）。 */
  column?: number;
  /** 悬停名单长度（默认 8）。 */
  top?: number;
  /** 已展开的列（seq）；该列不折叠。 */
  expandedColumns?: ReadonlySet<number>;
  /** 已展开的目标组（上游卡片 id）；该组目标全部可见。 */
  expandedTargets?: ReadonlySet<string>;
}

export interface FoldedCard {
  id: string;
  kind: "member" | "fold" | "target";
  role: TemplateCardRole;
  /** 折叠卡没有名字：`+N 台` 由渲染层按 i18n 生成。 */
  name: string;
  seq: number;
  status: ChainTemplateMemberStatus;
  chains: number;
  users: number;
  /** 折叠卡：被折的成员数；目标卡：被折的兄弟目标数。 */
  hidden: number;
  /** 折叠卡：隐藏成员里离线几台。 */
  offlineHidden: number;
  /** 目标卡：被折目标的链数合计 / 用户数最大值（用户可能重叠，不求和）。 */
  hiddenChains: number;
  hiddenUsers: number;
  /** 目标卡：隐藏目标里最差的状态（没有隐藏时为 null）。 */
  hiddenWorst: ChainTemplateMemberStatus | null;
  /** 折叠卡 / 目标卡：悬停名单（≤ top）。 */
  topNames: string[];
  /** 目标卡：所属上游卡片 id。 */
  upstreamId: string | null;
}

export interface FoldedColumn {
  seq: number;
  role: "entry" | "hop" | "target";
  cards: FoldedCard[];
}

export interface FoldedEdge {
  id: string;
  source: string;
  target: string;
  sourceSeq: number;
  targetSeq: number;
  chains: number;
  users: number;
  p50Ms: number | null;
  lastP50Ms: number | null;
  unavailable: boolean;
  degraded: boolean;
  /** 被折成员的连线：虚线、无时延、不脉冲。 */
  merged: boolean;
  /** 这条边由几条原始路径合并而来（未合并时为 1）。 */
  paths: number;
}

export interface FoldedGraph {
  hops: number;
  targetSeq: number;
  columns: FoldedColumn[];
  edges: FoldedEdge[];
  unused: TemplateGraphUnusedMember[];
  empty: boolean;
  maxChains: number;
  hiddenMembers: number;
  hiddenTargets: number;
  /** 出现折叠卡的列 seq。 */
  foldColumns: number[];
}

export interface TemplatePill {
  id: string;
  /** 中心点（流坐标）。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TemplateLayoutCard {
  id: string;
  card: FoldedCard;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type TemplateEdgeStatus = "online" | "degraded" | "offline";

export interface TemplateLayoutEdge {
  id: string;
  source: string;
  target: string;
  sourceSeq: number;
  targetSeq: number;
  sourceName: string;
  targetName: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 竖脊 x：直角折线在中线（合并虚线略偏右）转弯。 */
  railX: number;
  path: string;
  width: number;
  dashed: boolean;
  merged: boolean;
  status: TemplateEdgeStatus;
  pulse: boolean;
  chains: number;
  users: number;
  p50Ms: number | null;
  lastP50Ms: number | null;
  unavailable: boolean;
  degraded: boolean;
  /** 合并虚线的原始路径条数；普通连线为 1。 */
  paths: number;
  pill: TemplatePill | null;
  /** 同一竖线上的药丸超过上限：组件默认隐藏，悬停该竖线或聚焦才显示。 */
  pillDense: boolean;
}

export interface TemplateLayoutColumn {
  seq: number;
  x: number;
  count: number;
}

export interface TemplateGraphLayout {
  cards: TemplateLayoutCard[];
  edges: TemplateLayoutEdge[];
  columns: TemplateLayoutColumn[];
  width: number;
  height: number;
}

export interface TemplateSize {
  width: number;
  height: number;
}

export interface TemplateViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface TemplateHighlight {
  nodes: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const STATUS_RANK: Record<ChainTemplateMemberStatus, number> = {
  unknown: 0,
  online: 1,
  degraded: 2,
  offline: 3,
};

/** 取更差的状态；offline > degraded > online > unknown。 */
export function templateWorstStatus(
  a: ChainTemplateMemberStatus,
  b: ChainTemplateMemberStatus,
): ChainTemplateMemberStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

function worstOf(
  statuses: readonly ChainTemplateMemberStatus[],
): ChainTemplateMemberStatus {
  return statuses.reduce<ChainTemplateMemberStatus>(
    (worst, status) => templateWorstStatus(worst, status),
    "unknown",
  );
}

/** 去重键：优先 server id，缺失时用名字。 */
function memberIdentity(member: ChainTemplateMember): string {
  const serverId = member.serverId ?? "";
  return serverId !== "" ? serverId : member.name;
}

/** 边的 P50：链数加权；全部缺失时 null。 */
function weightedP50(
  entries: readonly { p50Ms: number | null; chains: number }[],
): number | null {
  let sum = 0;
  let weight = 0;
  for (const entry of entries) {
    if (entry.p50Ms === null) continue;
    const w = Math.max(1, entry.chains);
    sum += entry.p50Ms * w;
    weight += w;
  }
  return weight > 0 ? Math.round((sum / weight) * 10) / 10 : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sortMembers(
  a: TemplateGraphMember,
  b: TemplateGraphMember,
): number {
  return (
    b.chains - a.chains ||
    b.users - a.users ||
    a.name.localeCompare(b.name)
  );
}

/* ------------------------------------------------------------------ */
/* 1) buildTemplateGraph                                               */
/* ------------------------------------------------------------------ */

interface MemberBucket {
  /** identity → 成员（同名旧别名只留第一次出现的那台）。 */
  canonical: Map<string, ChainTemplateMember>;
  /** 任意名字 → identity。 */
  identityByName: Map<string, string>;
}

function bucketFor(
  buckets: Map<number, MemberBucket>,
  seq: number,
): MemberBucket {
  const existing = buckets.get(seq);
  if (existing !== undefined) return existing;
  const bucket: MemberBucket = {
    canonical: new Map<string, ChainTemplateMember>(),
    identityByName: new Map<string, string>(),
  };
  buckets.set(seq, bucket);
  return bucket;
}

interface MemberStat {
  inChains: number;
  outChains: number;
  inUsers: number;
  outUsers: number;
}

function statFor(
  stats: Map<string, MemberStat>,
  seq: number,
  identity: string,
): MemberStat {
  const key = `${seq}::${identity}`;
  const existing = stats.get(key);
  if (existing !== undefined) return existing;
  const stat: MemberStat = { inChains: 0, outChains: 0, inUsers: 0, outUsers: 0 };
  stats.set(key, stat);
  return stat;
}

interface TargetAccumulator {
  label: string;
  declaredChains: number;
  declaredUsers: number;
  status: ChainTemplateMemberStatus;
  incoming: ChainTemplateEdge[];
}

function entryId(identity: string): string {
  return `e:0:${identity}`;
}

function hopId(seq: number, identity: string): string {
  return `h:${seq}:${identity}`;
}

function targetId(label: string): string {
  return `t:${label}`;
}

export function buildTemplateGraph(
  detail: ChainTemplateDetail,
): TemplateGraph {
  const targetSeq =
    detail.nodes.find((node) => node.role === "target")?.seq ??
    detail.template.hops ??
    TARGET_SEQ_FALLBACK;
  const usedEdges = detail.edges.filter((edge) => edge.chains > 0);
  const hops = Math.max(0, targetSeq);

  /* ---------------- 成员表：按 seq 建去重索引 ---------------- */
  const buckets = new Map<number, MemberBucket>();
  for (const node of detail.nodes) {
    if (node.role === "target") continue;
    const bucket = bucketFor(buckets, node.seq);
    for (const member of node.members) {
      const name = member.name.trim();
      if (name === "") continue;
      const identity = memberIdentity(member);
      if (!bucket.canonical.has(identity)) {
        bucket.canonical.set(identity, member);
      }
      if (!bucket.identityByName.has(name)) {
        bucket.identityByName.set(name, identity);
      }
    }
  }

  /** 名字 → identity；未在成员表里声明过的名字按名字本身当 identity。 */
  const identityOf = (seq: number, name: string): string => {
    const trimmed = name.trim();
    return buckets.get(seq)?.identityByName.get(trimmed) ?? trimmed;
  };
  const memberOf = (
    seq: number,
    identity: string,
  ): ChainTemplateMember | null =>
    buckets.get(seq)?.canonical.get(identity) ?? null;

  /* ---------------- 边上的成员统计 ---------------- */
  const stats = new Map<string, MemberStat>();
  for (const edge of usedEdges) {
    if (edge.fromSeq >= 0 && edge.fromSeq < targetSeq) {
      const identity = identityOf(edge.fromSeq, edge.fromMember);
      const stat = statFor(stats, edge.fromSeq, identity);
      stat.outChains += Math.max(0, edge.chains);
      stat.outUsers = Math.max(stat.outUsers, edge.users);
    }
    if (edge.toSeq > 0 && edge.toSeq < targetSeq) {
      const identity = identityOf(edge.toSeq, edge.toMember);
      const stat = statFor(stats, edge.toSeq, identity);
      stat.inChains += Math.max(0, edge.chains);
      stat.inUsers = Math.max(stat.inUsers, edge.users);
    }
  }

  const buildMember = (
    seq: number,
    identity: string,
    role: "entry" | "hop",
  ): TemplateGraphMember => {
    const member = memberOf(seq, identity);
    const stat = stats.get(`${seq}::${identity}`);
    const chains = Math.max(
      member?.chains ?? 0,
      stat?.inChains ?? 0,
      stat?.outChains ?? 0,
    );
    const users = Math.max(
      member?.users ?? 0,
      stat?.inUsers ?? 0,
      stat?.outUsers ?? 0,
    );
    const status = member?.status ?? "unknown";
    return {
      id: role === "entry" ? entryId(identity) : hopId(seq, identity),
      name: member?.name ?? identity,
      seq,
      role,
      status,
      chains,
      users,
      offline: status === "offline",
      degraded: status === "degraded",
      upstreamIds: [],
    };
  };

  const collectColumn = (
    seq: number,
    role: "entry" | "hop",
  ): TemplateGraphMember[] => {
    const identities = new Set<string>();
    const bucket = buckets.get(seq);
    if (bucket !== undefined) {
      for (const identity of bucket.canonical.keys()) identities.add(identity);
    }
    for (const key of stats.keys()) {
      const [rawSeq, identity] = key.split("::");
      if (Number(rawSeq) === seq) identities.add(identity);
    }
    const members: TemplateGraphMember[] = [];
    for (const identity of identities) {
      const member = buildMember(seq, identity, role);
      if (member.chains > 0) members.push(member);
    }
    members.sort(sortMembers);
    return members;
  };

  const entries = collectColumn(0, "entry");
  const hopColumns: TemplateGraphColumn[] = [];
  for (let seq = 1; seq < targetSeq; seq += 1) {
    hopColumns.push({ seq, role: "hop", members: collectColumn(seq, "hop") });
  }

  /* ---------------- 目标 ---------------- */
  const targets = new Map<string, TargetAccumulator>();
  const seedTarget = (
    label: string,
    chains: number,
    users: number,
    status: ChainTemplateMemberStatus,
  ): void => {
    const key = label.trim();
    if (key === "") return;
    const existing = targets.get(key);
    if (existing === undefined) {
      targets.set(key, {
        label: key,
        declaredChains: Math.max(0, chains),
        declaredUsers: Math.max(0, users),
        status,
        incoming: [],
      });
      return;
    }
    existing.declaredChains = Math.max(existing.declaredChains, chains);
    existing.declaredUsers = Math.max(existing.declaredUsers, users);
    existing.status = templateWorstStatus(existing.status, status);
  };
  for (const target of detail.targets) {
    seedTarget(targetLabel(target), target.chains, target.users.length, "unknown");
  }
  for (const node of detail.nodes) {
    if (node.role !== "target") continue;
    for (const member of node.members) {
      seedTarget(member.name, member.chains, member.users, member.status);
    }
  }

  /** 边上的 `to.member`（host:port 或只有 host）对到目标标签。 */
  const resolveTargetLabel = (raw: string): string | null => {
    const label = raw.trim();
    if (label === "") return null;
    if (targets.has(label)) return label;
    const lower = label.toLowerCase();
    for (const key of targets.keys()) {
      if (key.toLowerCase() === lower) return key;
    }
    for (const key of targets.keys()) {
      const host = key.toLowerCase();
      if (
        host.startsWith(`${lower}:`) ||
        host.startsWith(`[${lower}]:`) ||
        host === lower
      ) {
        return key;
      }
    }
    return null;
  };

  for (const edge of usedEdges) {
    if (edge.toSeq !== targetSeq) continue;
    const raw = edge.toMember.trim();
    let label = resolveTargetLabel(raw);
    if (label === null) {
      if (raw === "") {
        if (targets.size !== 1) continue;
        label = [...targets.keys()][0];
      } else {
        seedTarget(raw, edge.chains, edge.users, "unknown");
        label = raw;
      }
    }
    const accumulator = targets.get(label);
    if (accumulator !== undefined) accumulator.incoming.push(edge);
  }

  // 没有入边的目标挂到链数最多的最后跳成员（与旧树图一致）。
  const lastMembers =
    hopColumns.length > 0
      ? hopColumns[hopColumns.length - 1].members
      : entries;
  const fallbackUpstreamId = lastMembers[0]?.id ?? "";

  const targetMembers: TemplateGraphMember[] = [];
  for (const accumulator of targets.values()) {
    const incomingChains = accumulator.incoming.reduce(
      (sum, edge) => sum + Math.max(0, edge.chains),
      0,
    );
    const chains = Math.max(accumulator.declaredChains, incomingChains);
    if (chains <= 0) continue;
    const incomingUsers = accumulator.incoming.reduce(
      (max, edge) => Math.max(max, edge.users),
      0,
    );
    const users = Math.max(accumulator.declaredUsers, incomingUsers);
    const upstreamChains = new Map<string, number>();
    for (const edge of accumulator.incoming) {
      const identity = identityOf(edge.fromSeq, edge.fromMember);
      const id = edge.fromSeq === 0 ? entryId(identity) : hopId(edge.fromSeq, identity);
      upstreamChains.set(id, (upstreamChains.get(id) ?? 0) + edge.chains);
    }
    const upstreamIds = [...upstreamChains.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id]) => id);
    if (upstreamIds.length === 0 && fallbackUpstreamId !== "") {
      upstreamIds.push(fallbackUpstreamId);
    }
    const status = accumulator.status;
    targetMembers.push({
      id: targetId(accumulator.label),
      name: accumulator.label,
      seq: targetSeq,
      role: "target",
      status,
      chains,
      users,
      offline: status === "offline",
      degraded: status === "degraded",
      upstreamIds,
    });
  }
  targetMembers.sort(sortMembers);

  const entryColumn: TemplateGraphColumn = {
    seq: 0,
    role: "entry",
    members: entries,
  };
  const targetColumn: TemplateGraphColumn = {
    seq: targetSeq,
    role: "target",
    members: targetMembers,
  };
  const columns: TemplateGraphColumn[] = [
    entryColumn,
    ...hopColumns.filter((column) => column.members.length > 0),
    targetColumn,
  ].filter((column) => column.members.length > 0);

  /* ---------------- 边：按 (source,target) 聚合 ---------------- */
  const memberById = new Map<string, TemplateGraphMember>();
  for (const column of columns) {
    for (const member of column.members) memberById.set(member.id, member);
  }
  const targetByLabel = new Map(
    targetMembers.map((member) => [member.name, member]),
  );

  interface EdgeAccumulator {
    source: string;
    target: string;
    sourceSeq: number;
    targetSeq: number;
    chains: number;
    users: number;
    p50: { p50Ms: number | null; chains: number }[];
    unavailable: boolean;
    degraded: boolean;
  }
  const edgeMap = new Map<string, EdgeAccumulator>();
  const addEdge = (
    sourceId: string,
    targetMemberId: string,
    chains: number,
    users: number,
    p50Ms: number | null,
  ): void => {
    const sourceMember = memberById.get(sourceId);
    const targetMember = memberById.get(targetMemberId);
    if (sourceMember === undefined || targetMember === undefined) return;
    const unavailable =
      sourceMember.status === "offline" || targetMember.status === "offline";
    const degraded =
      !unavailable &&
      (sourceMember.status === "degraded" || targetMember.status === "degraded");
    const key = `${sourceId}->${targetMemberId}`;
    const existing = edgeMap.get(key);
    if (existing === undefined) {
      edgeMap.set(key, {
        source: sourceId,
        target: targetMemberId,
        sourceSeq: sourceMember.seq,
        targetSeq: targetMember.seq,
        chains: Math.max(0, chains),
        users: Math.max(0, users),
        p50: [{ p50Ms: p50Ms, chains }],
        unavailable,
        degraded,
      });
      return;
    }
    existing.chains += Math.max(0, chains);
    existing.users = Math.max(existing.users, users);
    existing.p50.push({ p50Ms, chains });
    existing.unavailable = existing.unavailable || unavailable;
    existing.degraded = existing.degraded || degraded;
  };

  for (const edge of usedEdges) {
    const sourceIdentity = identityOf(edge.fromSeq, edge.fromMember);
    const sourceId =
      edge.fromSeq === 0 ? entryId(sourceIdentity) : hopId(edge.fromSeq, sourceIdentity);
    let targetMemberId: string | null = null;
    if (edge.toSeq === targetSeq) {
      const label = resolveTargetLabel(edge.toMember);
      const labelKey =
        label ??
        (edge.toMember.trim() === "" && targetMembers.length === 1
          ? targetMembers[0].name
          : null);
      const member = labelKey === null ? undefined : targetByLabel.get(labelKey);
      targetMemberId = member?.id ?? null;
    } else if (edge.toSeq > 0 && edge.toSeq < targetSeq) {
      targetMemberId = hopId(edge.toSeq, identityOf(edge.toSeq, edge.toMember));
    }
    if (targetMemberId === null) continue;
    addEdge(sourceId, targetMemberId, edge.chains, edge.users, edge.p50Ms);
  }

  // 目标声明了链数但契约里没有对应边：补一条回退边，保证离线路径同样标状态。
  for (const member of targetMembers) {
    const hasEdge = [...edgeMap.values()].some(
      (item) => item.target === member.id,
    );
    if (hasEdge) continue;
    const upstream = member.upstreamIds[0];
    if (upstream === undefined || upstream === "") continue;
    addEdge(upstream, member.id, member.chains, member.users, null);
  }

  const graphEdges: TemplateGraphEdge[] = [...edgeMap.values()].map(
    (item, index) => {
      const p50 = weightedP50(item.p50);
      const unavailable = item.unavailable;
      return {
        id: `edge:${index}:${item.source}->${item.target}`,
        source: item.source,
        target: item.target,
        sourceSeq: item.sourceSeq,
        targetSeq: item.targetSeq,
        chains: item.chains,
        users: item.users,
        p50Ms: unavailable ? null : p50,
        lastP50Ms: unavailable ? p50 : null,
        unavailable,
        degraded: unavailable ? false : item.degraded,
      };
    },
  );

  const unused: TemplateGraphUnusedMember[] = detail.unusedCandidates.map(
    (candidate) => ({
      key: candidate.serverId ?? candidate.name,
      name: candidate.name,
      seq: candidate.seq,
      status: candidate.status,
    }),
  );
  unused.sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));

  const empty = columns.every((column) => column.members.length === 0);
  return {
    hops,
    targetSeq,
    columns,
    edges: graphEdges,
    unused,
    usedMemberCount: entries.length + hopColumns.reduce((sum, column) => sum + column.members.length, 0),
    targetCount: targetMembers.length,
    empty,
  };
}

/* ------------------------------------------------------------------ */
/* 2) foldTemplateGraph                                                */
/* ------------------------------------------------------------------ */

function memberToCard(member: TemplateGraphMember): FoldedCard {
  return {
    id: member.id,
    kind: member.role === "target" ? "target" : "member",
    role: member.role,
    name: member.name,
    seq: member.seq,
    status: member.status,
    chains: member.chains,
    users: member.users,
    hidden: 0,
    offlineHidden: 0,
    hiddenChains: 0,
    hiddenUsers: 0,
    hiddenWorst: null,
    topNames: [],
    upstreamId: member.role === "target" ? member.upstreamIds[0] ?? null : null,
  };
}

export function foldTemplateGraph(
  graph: TemplateGraph,
  limits: TemplateFoldLimits = {},
): FoldedGraph {
  const columnLimit = Math.max(1, Math.floor(limits.column ?? TEMPLATE_FOLD_LIMIT));
  const top = Math.max(1, Math.floor(limits.top ?? TEMPLATE_FOLD_TOP));
  const expandedColumns = limits.expandedColumns ?? new Set<number>();
  const expandedTargets = limits.expandedTargets ?? new Set<string>();

  const foldedColumns: FoldedColumn[] = [];
  const memberCardOf = new Map<string, FoldedCard>();
  const foldColumns: number[] = [];
  let hiddenMembers = 0;

  /* ---------------- 入口 / 中间跳：4 张 + 折叠卡 ---------------- */
  for (const column of graph.columns) {
    if (column.role === "target") continue;
    const cards = column.members.map(memberToCard);
    const expanded = expandedColumns.has(column.seq);
    const visible: FoldedCard[] = [];
    let hidden: FoldedCard[] = [];
    if (!expanded && cards.length > columnLimit) {
      visible.push(...cards.slice(0, columnLimit));
      hidden = cards.slice(columnLimit);
    } else {
      visible.push(...cards);
    }
    for (const card of visible) memberCardOf.set(card.id, card);
    if (hidden.length > 0) {
      const foldCard: FoldedCard = {
        id: `fold:${column.seq}`,
        kind: "fold",
        role: "fold",
        name: "",
        seq: column.seq,
        status: worstOf(hidden.map((card) => card.status)),
        chains: hidden.reduce((sum, card) => sum + card.chains, 0),
        users: hidden.reduce((max, card) => Math.max(max, card.users), 0),
        hidden: hidden.length,
        offlineHidden: hidden.filter((card) => card.status === "offline").length,
        hiddenChains: hidden.reduce((sum, card) => sum + card.chains, 0),
        hiddenUsers: hidden.reduce((max, card) => Math.max(max, card.users), 0),
        hiddenWorst: null,
        topNames: hidden.slice(0, top).map((card) => card.name),
        upstreamId: null,
      };
      foldCard.hiddenWorst = foldCard.status;
      visible.push(foldCard);
      for (const card of hidden) memberCardOf.set(card.id, foldCard);
      foldColumns.push(column.seq);
      hiddenMembers += hidden.length;
    }
    foldedColumns.push({ seq: column.seq, role: column.role, cards: visible });
  }

  /* ---------------- 目标列：每个上游至少 1 张，其余 +N ---------------- */
  const graphTargetColumn = graph.columns.find(
    (column) => column.role === "target",
  );
  const graphTargets = graphTargetColumn?.members ?? [];
  const groups = new Map<string, TemplateGraphMember[]>();
  for (const member of graphTargets) {
    const rawUpstream = member.upstreamIds[0] ?? "";
    const upstreamCard = memberCardOf.get(rawUpstream);
    const group = upstreamCard?.id ?? ROOT_GROUP;
    const bucket = groups.get(group);
    if (bucket === undefined) groups.set(group, [member]);
    else bucket.push(member);
  }
  // 上游卡片顺序 = 上一列的卡片顺序，目标卡按同样的顺序排，连线不交叉。
  const upstreamOrder = new Map<string, number>();
  const lastMemberColumn = foldedColumns[foldedColumns.length - 1];
  for (const [index, card] of (lastMemberColumn?.cards ?? []).entries()) {
    upstreamOrder.set(card.id, index);
  }
  const groupKeys = [...groups.keys()].sort((a, b) => {
    const ai = upstreamOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bi = upstreamOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi || a.localeCompare(b);
  });

  const visibleTargets = new Map<string, TemplateGraphMember[]>();
  const hiddenByGroup = new Map<string, TemplateGraphMember[]>();
  for (const key of groupKeys) {
    const members = groups.get(key) ?? [];
    if (members.length === 0) continue;
    if (expandedTargets.has(key)) {
      visibleTargets.set(key, [...members]);
      hiddenByGroup.set(key, []);
      continue;
    }
    visibleTargets.set(key, [members[0]]);
    hiddenByGroup.set(key, members.slice(1));
  }
  // 每列 ≤ columnLimit：多出来的名额优先给「隐藏最多」的组（至少每组 1 张）。
  let slack = columnLimit - groupKeys.length;
  while (slack > 0) {
    let bestKey: string | null = null;
    let bestHidden = 0;
    let bestIndex = Number.MAX_SAFE_INTEGER;
    for (const [index, key] of groupKeys.entries()) {
      const hidden = hiddenByGroup.get(key) ?? [];
      if (hidden.length > bestHidden || (hidden.length === bestHidden && hidden.length > 0 && index < bestIndex)) {
        bestKey = key;
        bestHidden = hidden.length;
        bestIndex = index;
      }
    }
    if (bestKey === null || bestHidden === 0) break;
    const hidden = hiddenByGroup.get(bestKey) ?? [];
    const next = hidden.shift();
    if (next === undefined) break;
    visibleTargets.get(bestKey)?.push(next);
    slack -= 1;
  }

  const targetCards: FoldedCard[] = [];
  const targetCardOf = new Map<string, FoldedCard>();
  let hiddenTargets = 0;
  for (const key of groupKeys) {
    const visible = visibleTargets.get(key) ?? [];
    const hidden = hiddenByGroup.get(key) ?? [];
    hiddenTargets += hidden.length;
    let first: FoldedCard | null = null;
    for (const member of visible) {
      const card = memberToCard(member);
      // 分组键可能是折叠卡 id：卡片回传的必须是分组键，展开时才能命中。
      card.upstreamId = key;
      if (first === null) {
        first = card;
        card.hidden = hidden.length;
        card.offlineHidden = hidden.filter((item) => item.status === "offline").length;
        card.hiddenChains = hidden.reduce((sum, item) => sum + item.chains, 0);
        card.hiddenUsers = hidden.reduce(
          (max, item) => Math.max(max, item.users),
          0,
        );
        card.hiddenWorst =
          hidden.length > 0 ? worstOf(hidden.map((item) => item.status)) : null;
        card.topNames = hidden.slice(0, top).map((item) => item.name);
      }
      targetCards.push(card);
      targetCardOf.set(card.id, card);
    }
    for (const member of hidden) {
      if (first === null) continue;
      targetCardOf.set(member.id, first);
    }
  }
  const visibleTargetIds = new Set(targetCards.map((card) => card.id));
  if (graphTargetColumn !== undefined) {
    foldedColumns.push({
      seq: graphTargetColumn.seq,
      role: "target",
      cards: targetCards,
    });
  }

  /* ---------------- 边 ---------------- */
  interface FoldedAccumulator {
    source: string;
    target: string;
    sourceSeq: number;
    targetSeq: number;
    chains: number;
    users: number;
    p50: { p50Ms: number | null; chains: number }[];
    p50Override: boolean;
    unavailable: boolean;
    degraded: boolean;
    merged: boolean;
    paths: number;
  }
  const edgeMap = new Map<string, FoldedAccumulator>();
  for (const edge of graph.edges) {
    const sourceCard = memberCardOf.get(edge.source);
    if (sourceCard === undefined) continue;
    let targetCard = memberCardOf.get(edge.target);
    if (targetCard === undefined) {
      // 目标：被折进 `+N` 的目标不画线，由标签与悬停名单解释。
      if (!visibleTargetIds.has(edge.target)) continue;
      targetCard = targetCardOf.get(edge.target);
    }
    if (targetCard === undefined) continue;
    const merged = sourceCard.kind === "fold" || targetCard.kind === "fold";
    const key = `${sourceCard.id}->${targetCard.id}`;
    const existing = edgeMap.get(key);
    if (existing === undefined) {
      edgeMap.set(key, {
        source: sourceCard.id,
        target: targetCard.id,
        sourceSeq: sourceCard.seq,
        targetSeq: targetCard.seq,
        chains: Math.max(0, edge.chains),
        users: Math.max(0, edge.users),
        p50: merged
          ? []
          : [{ p50Ms: edge.p50Ms ?? edge.lastP50Ms, chains: edge.chains }],
        p50Override: merged,
        unavailable: edge.unavailable,
        degraded: edge.degraded,
        merged,
        paths: 1,
      });
      continue;
    }
    existing.chains += Math.max(0, edge.chains);
    existing.users = Math.max(existing.users, edge.users);
    existing.paths += 1;
    if (!merged) {
      existing.p50.push({
        p50Ms: edge.p50Ms ?? edge.lastP50Ms,
        chains: edge.chains,
      });
    }
    existing.p50Override = existing.p50Override || merged;
    existing.unavailable = existing.unavailable || edge.unavailable;
    existing.degraded = existing.degraded || edge.degraded;
    existing.merged = existing.merged || merged;
  }

  const foldedEdges: FoldedEdge[] = [...edgeMap.values()].map(
    (item, index) => {
      const merged = item.merged;
      const p50 = merged ? null : weightedP50(item.p50);
      const unavailable = item.unavailable;
      return {
        id: `fold-edge:${index}:${item.source}->${item.target}`,
        source: item.source,
        target: item.target,
        sourceSeq: item.sourceSeq,
        targetSeq: item.targetSeq,
        chains: item.chains,
        users: item.users,
        p50Ms: merged || unavailable ? null : p50,
        lastP50Ms: merged || !unavailable ? null : p50,
        unavailable,
        degraded: unavailable ? false : item.degraded,
        merged,
        paths: item.paths,
      };
    },
  );

  const maxChains = foldedEdges.reduce(
    (max, edge) => Math.max(max, edge.chains),
    1,
  );
  return {
    hops: graph.hops,
    targetSeq: graph.targetSeq,
    columns: foldedColumns,
    edges: foldedEdges,
    unused: graph.unused,
    empty: foldedColumns.every((column) => column.cards.length === 0),
    maxChains,
    hiddenMembers,
    hiddenTargets,
    foldColumns,
  };
}

/* ------------------------------------------------------------------ */
/* 3) layoutTemplateGraph                                              */
/* ------------------------------------------------------------------ */

/** 直角折线：横 → 竖 → 横，转角 8px 圆角；同一竖线落在列间空隙中点。 */
export function templateEdgePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  railX: number = (x1 + x2) / 2,
  radius: number = TEMPLATE_EDGE_RADIUS,
): string {
  const line = (value: number): number => Math.round(value * 100) / 100;
  if (Math.abs(y2 - y1) < 0.5) {
    return `M ${line(x1)} ${line(y1)} L ${line(x2)} ${line(y2)}`;
  }
  const dir = y2 > y1 ? 1 : -1;
  const limit = Math.min(
    Math.abs(railX - x1),
    Math.abs(x2 - railX),
    Math.abs(y2 - y1) / 2,
  );
  const rad = Math.max(0, Math.min(radius, limit));
  const hDir = railX >= x1 ? 1 : -1;
  const outDir = x2 >= railX ? 1 : -1;
  return [
    `M ${line(x1)} ${line(y1)}`,
    `L ${line(railX - rad * hDir)} ${line(y1)}`,
    `Q ${line(railX)} ${line(y1)} ${line(railX)} ${line(y1 + rad * dir)}`,
    `L ${line(railX)} ${line(y2 - rad * dir)}`,
    `Q ${line(railX)} ${line(y2)} ${line(railX + rad * outDir)} ${line(y2)}`,
    `L ${line(x2)} ${line(y2)}`,
  ].join(" ");
}

export function templateEdgeWidth(chains: number, maxChains: number): number {
  if (!Number.isFinite(chains) || !Number.isFinite(maxChains)) {
    return TEMPLATE_EDGE_MIN_WIDTH;
  }
  if (chains <= 0 || maxChains <= 0) return TEMPLATE_EDGE_MIN_WIDTH;
  const ratio = Math.min(1, chains / maxChains);
  return round2(
    TEMPLATE_EDGE_MIN_WIDTH +
      (TEMPLATE_EDGE_MAX_WIDTH - TEMPLATE_EDGE_MIN_WIDTH) * ratio,
  );
}

function rectsOverlap(a: TemplatePill, b: TemplatePill): boolean {
  return (
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 + TEMPLATE_PILL_GAP / 2 &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 + TEMPLATE_PILL_GAP / 2
  );
}

/**
 * 药丸落点去重叠：同一竖线上的时延标签按 y 逐格下移，直到不再相交。
 * 纯函数，输入不被就地修改；横向已经错开的药丸保持原位。
 */
export function spreadPills(pills: readonly TemplatePill[]): TemplatePill[] {
  const result = pills.map((pill) => ({ ...pill }));
  const order = result
    .map((_, index) => index)
    .sort(
      (a, b) =>
        result[a].x - result[b].x ||
        result[a].y - result[b].y ||
        a - b,
    );
  const placed: TemplatePill[] = [];
  for (const index of order) {
    let candidate = result[index];
    let guard = 0;
    while (guard < 200) {
      guard += 1;
      const collide = placed.find((item) => rectsOverlap(item, candidate));
      if (collide === undefined) break;
      candidate = {
        id: candidate.id,
        x: candidate.x,
        y: collide.y + (collide.height + candidate.height) / 2 + TEMPLATE_PILL_GAP,
        width: candidate.width,
        height: candidate.height,
      };
    }
    placed.push(candidate);
    result[index] = candidate;
  }
  return result;
}

/**
 * 同一竖线（药丸 x 相同）上超过 `limit` 个药丸时返回这些 x。
 * 组件据此默认隐藏密集药丸，悬停竖线 / 聚焦才显示。
 */
export function densePillRails(
  pills: readonly TemplatePill[],
  limit: number = TEMPLATE_PILL_DENSE_LIMIT,
): number[] {
  const counts = new Map<number, number>();
  for (const pill of pills) {
    counts.set(pill.x, (counts.get(pill.x) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > limit)
    .map(([x]) => x)
    .sort((a, b) => a - b);
}

export function layoutTemplateGraph(
  folded: FoldedGraph,
): TemplateGraphLayout {
  const columns = folded.columns.filter((column) => column.cards.length > 0);
  const columnX = (index: number): number =>
    TEMPLATE_PADDING + index * (TEMPLATE_CARD_WIDTH + TEMPLATE_COLUMN_GAP);

  const cards: TemplateLayoutCard[] = [];
  const cardById = new Map<string, TemplateLayoutCard>();
  let maxHeight = TEMPLATE_PADDING * 2;

  for (const [index, column] of columns.entries()) {
    let cursor = TEMPLATE_PADDING;
    const x = columnX(index);
    const columnCards: TemplateLayoutCard[] = [];
    for (const card of column.cards) {
      const parents = folded.edges
        .filter((edge) => edge.target === card.id)
        .map((edge) => cardById.get(edge.source))
        .filter((parent): parent is TemplateLayoutCard => parent !== undefined);
      const desiredCenter =
        parents.length > 0
          ? parents.reduce((sum, parent) => sum + parent.y + parent.height / 2, 0) /
            parents.length
          : cursor + TEMPLATE_CARD_HEIGHT / 2;
      const y = Math.max(cursor, desiredCenter - TEMPLATE_CARD_HEIGHT / 2);
      const layoutCard: TemplateLayoutCard = {
        id: card.id,
        card,
        column: index,
        x,
        y,
        width: TEMPLATE_CARD_WIDTH,
        height: TEMPLATE_CARD_HEIGHT,
      };
      cards.push(layoutCard);
      columnCards.push(layoutCard);
      cardById.set(layoutCard.id, layoutCard);
      cursor = y + TEMPLATE_CARD_HEIGHT + TEMPLATE_ROW_GAP;
    }
    // 整列上移到统一顶边：保留列内相对行号，消除左上角空白与逐列下沉。
    // 先移动本列，下一列的父节点中心也用移动后的坐标，视觉上不会又漂下去。
    const minY = columnCards.reduce(
      (min, card) => Math.min(min, card.y),
      Number.POSITIVE_INFINITY,
    );
    const shift = Number.isFinite(minY) ? TEMPLATE_PADDING - minY : 0;
    for (const card of columnCards) {
      card.y += shift;
      maxHeight = Math.max(maxHeight, card.y + card.height + TEMPLATE_PADDING);
    }
  }

  const width =
    columns.length === 0
      ? TEMPLATE_PADDING * 2
      : TEMPLATE_PADDING * 2 +
        columns.length * TEMPLATE_CARD_WIDTH +
        (columns.length - 1) * TEMPLATE_COLUMN_GAP;
  const height = Math.max(maxHeight, TEMPLATE_PADDING * 2);

  const edges: TemplateLayoutEdge[] = [];
  const pillByEdge = new Map<string, TemplatePill>();
  const pendingPills: TemplatePill[] = [];
  for (const edge of folded.edges) {
    const source = cardById.get(edge.source);
    const target = cardById.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const x1 = source.x + source.width;
    const y1 = source.y + source.height / 2;
    const x2 = target.x;
    const y2 = target.y + target.height / 2;
    const merged = edge.merged;
    const baseRailX =
      source.column === target.column
        ? (x1 + x2) / 2
        : columnX(source.column) +
          TEMPLATE_CARD_WIDTH +
          TEMPLATE_COLUMN_GAP / 2;
    const railOffset = merged
      ? TEMPLATE_MERGED_RAIL_OFFSET
      : edge.unavailable
        ? -TEMPLATE_STATUS_RAIL_OFFSET
        : edge.degraded
          ? TEMPLATE_STATUS_RAIL_OFFSET
          : 0;
    const railX = baseRailX + railOffset;
    const path = templateEdgePath(x1, y1, x2, y2, railX);
    const status: TemplateEdgeStatus = edge.unavailable
      ? "offline"
      : edge.degraded
        ? "degraded"
        : "online";
    let pill: TemplatePill | null = null;
    if (!merged) {
      const dy = Math.abs(y2 - y1);
      const onVertical = dy >= TEMPLATE_PILL_HEIGHT + 16;
      const centerY = onVertical
        ? (y1 + y2) / 2
        : Math.min(y1, y2) - TEMPLATE_PILL_HEIGHT / 2 - 4;
      pill = {
        id: edge.id,
        x: railX,
        y: centerY,
        width: TEMPLATE_PILL_WIDTH,
        height: TEMPLATE_PILL_HEIGHT,
      };
      pendingPills.push(pill);
    }
    edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceSeq: edge.sourceSeq,
      targetSeq: edge.targetSeq,
      // 折叠卡没有名字：给 aria / merged tooltip 一个可读的 `+N` 占位。
      sourceName: source.card.name || `+${source.card.hidden}`,
      targetName: target.card.name || `+${target.card.hidden}`,
      x1,
      y1,
      x2,
      y2,
      railX,
      path,
      width: templateEdgeWidth(edge.chains, folded.maxChains),
      dashed: merged || edge.unavailable,
      merged,
      status,
      pulse: false,
      chains: edge.chains,
      users: edge.users,
      p50Ms: edge.p50Ms,
      lastP50Ms: edge.lastP50Ms,
      unavailable: edge.unavailable,
      degraded: edge.degraded,
      paths: edge.paths,
      pill,
      pillDense: false,
    });
  }

  for (const pill of spreadPills(pendingPills)) pillByEdge.set(pill.id, pill);
  for (const edge of edges) {
    edge.pill = pillByEdge.get(edge.id) ?? null;
  }
  const denseRails = new Set(densePillRails([...pillByEdge.values()]));
  for (const edge of edges) {
    edge.pillDense = edge.pill !== null && denseRails.has(edge.pill.x);
  }

  // 同时动画的边 ≤10：链数降序、同链数按 id，只让最值得看的路径动。
  const pulsing = edges
    .filter(
      (edge) =>
        !edge.merged && !edge.unavailable && !edge.degraded && edge.chains > 0,
    )
    .sort((a, b) => b.chains - a.chains || a.id.localeCompare(b.id))
    .slice(0, TEMPLATE_PULSE_LIMIT);
  const pulsingIds = new Set(pulsing.map((edge) => edge.id));
  for (const edge of edges) edge.pulse = pulsingIds.has(edge.id);

  return {
    cards,
    edges,
    columns: columns.map((column, index) => ({
      seq: column.seq,
      x: columnX(index),
      count: column.cards.length,
    })),
    width,
    height,
  };
}

/* ------------------------------------------------------------------ */
/* 4) viewport                                                         */
/* ------------------------------------------------------------------ */

/**
 * 画布像素高度：内容多高就多高，但不低于 320，也不超过
 * `min(640, 视口高度 × 0.52)` —— 大屏上画布不能把弹窗撑到看不见标题。
 * 极矮视口时上限优先（返回值可能低于 320，避免画布比视口还高）。
 */
export function templateCanvasHeight(
  contentHeight: number,
  viewportHeight: number,
): number {
  const cap = Math.min(
    TEMPLATE_CANVAS_MAX_HEIGHT,
    Math.max(0, viewportHeight) * TEMPLATE_CANVAS_VIEWPORT_RATIO,
  );
  return Math.min(Math.max(TEMPLATE_CANVAS_MIN_HEIGHT, contentHeight), cap);
}

function viewportFor(
  layout: TemplateGraphLayout,
  size: TemplateSize,
  zoom: number,
  alwaysCenter: boolean,
): TemplateViewport {
  const width = Math.max(1, layout.width);
  const height = Math.max(1, layout.height);
  const scaledWidth = width * zoom;
  const scaledHeight = height * zoom;
  const fitsX = scaledWidth <= size.width;
  const fitsY = scaledHeight <= size.height;
  return {
    x: round2(fitsX || alwaysCenter ? (size.width - scaledWidth) / 2 : 0),
    y: round2(fitsY || alwaysCenter ? (size.height - scaledHeight) / 2 : 0),
    zoom: Math.round(zoom * 1000) / 1000,
  };
}

/** 首屏视口：`max(0.9, fit)` 且不超过 1；内容过大时从左上角开始（入口列可见）。 */
export function initialViewport(
  layout: TemplateGraphLayout,
  size: TemplateSize,
): TemplateViewport {
  const width = Math.max(1, layout.width);
  const height = Math.max(1, layout.height);
  const fit = Math.min(
    Math.max(1, size.width) / width,
    Math.max(1, size.height) / height,
  );
  const zoom = clamp(fit, TEMPLATE_INITIAL_MIN_ZOOM, TEMPLATE_INITIAL_MAX_ZOOM);
  return viewportFor(layout, size, zoom, false);
}

/** 「适应窗口」：可以缩到 0.4 看全，但内容小时不放大超过 1。 */
export function fitViewport(
  layout: TemplateGraphLayout,
  size: TemplateSize,
): TemplateViewport {
  const width = Math.max(1, layout.width);
  const height = Math.max(1, layout.height);
  const fit = Math.min(
    Math.max(1, size.width) / width,
    Math.max(1, size.height) / height,
  );
  return viewportFor(
    layout,
    size,
    clamp(fit, TEMPLATE_MIN_ZOOM, TEMPLATE_INITIAL_MAX_ZOOM),
    true,
  );
}

export function clampTemplateZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return TEMPLATE_INITIAL_MAX_ZOOM;
  return round2(clamp(zoom, TEMPLATE_MIN_ZOOM, TEMPLATE_MAX_ZOOM));
}

/**
 * 缩放栏按钮：吸附到 25% 的整数档（100 → 125 → 150，100 → 75 → 50）。
 * 首屏是 fit 出来的 91% 之类的值时，一次「+」就落在 100%，用户看到的
 * 百分比始终是整档，不会出现 116% 这种读数。
 */
export function stepTemplateZoom(zoom: number, direction: 1 | -1): number {
  if (!Number.isFinite(zoom)) return TEMPLATE_INITIAL_MAX_ZOOM;
  const step = TEMPLATE_ZOOM_STEP;
  const snapped =
    direction > 0
      ? (Math.floor(zoom / step + 1e-6) + 1) * step
      : (Math.ceil(zoom / step - 1e-6) - 1) * step;
  return clampTemplateZoom(Math.round(snapped * 100) / 100);
}

/* ------------------------------------------------------------------ */
/* 5) highlight                                                        */
/* ------------------------------------------------------------------ */

/**
 * hover / focus 卡片：沿入边一路走到入口，点亮路径上的卡片与连线。
 * 折叠卡也是路径的一环；找不到该卡片时返回空集合（不误压暗整张图）。
 */
export function highlightTemplatePath(
  folded: FoldedGraph,
  cardId: string,
): TemplateHighlight {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const exists = folded.columns.some((column) =>
    column.cards.some((card) => card.id === cardId),
  );
  if (!exists) return { nodes, edges };
  const byTarget = new Map<string, FoldedEdge[]>();
  for (const edge of folded.edges) {
    const bucket = byTarget.get(edge.target);
    if (bucket === undefined) byTarget.set(edge.target, [edge]);
    else bucket.push(edge);
  }
  const stack = [cardId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (nodes.has(id)) continue;
    nodes.add(id);
    for (const edge of byTarget.get(id) ?? []) {
      edges.add(edge.id);
      stack.push(edge.source);
    }
  }
  return { nodes, edges };
}
