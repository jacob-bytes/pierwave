import { ApiError } from "./apiError.ts";

/**
 * 「转发链模板」洞察区块的纯逻辑。
 *
 * 契约（新主控）：
 * `GET /api/v1/overview/chain-templates`
 * `GET /api/v1/overview/chain-templates/{id}?hours=24|168`
 *
 * 这里只负责把 snake_case 响应归一化、算拓扑布局、色阶 / 边宽、策略占比、
 * 使用量序列与热点排序；不依赖 React / DOM / i18n，便于 `node:test` 覆盖。
 * 旧主控 404 / 403 在查询层转成 `null`，页面显示「需要新版本主控」。
 */

export const TEMPLATE_STATUS_KINDS = ["ok", "degraded", "blocked", "unknown"] as const;
export type ChainTemplateStatusKind = (typeof TEMPLATE_STATUS_KINDS)[number];

export interface ChainTemplateStatus {
  kind: ChainTemplateStatusKind;
  cause: string | null;
}

export const TEMPLATE_MEMBER_STATUSES = ["online", "offline", "unknown"] as const;
export type ChainTemplateMemberStatus =
  (typeof TEMPLATE_MEMBER_STATUSES)[number];

export interface ChainTemplateStrategyShare {
  strategy: string;
  chains: number;
  users: number;
}

export interface ChainTemplateUser {
  id: string;
  name: string;
  chains: number;
}

export interface ChainTemplateTarget {
  host: string;
  port: number | null;
  chains: number;
  users: ChainTemplateUser[];
}

export interface ChainTemplateMember {
  serverId: string | null;
  name: string;
  status: ChainTemplateMemberStatus;
  chains: number;
  users: number;
}

export type ChainTemplateNodeRole = "source" | "hop" | "target";

export interface ChainTemplateNode {
  seq: number;
  role: ChainTemplateNodeRole;
  name: string;
  members: ChainTemplateMember[];
}

export interface ChainTemplateEdge {
  seq: number;
  fromSeq: number;
  fromMember: string;
  toSeq: number;
  toMember: string;
  chains: number;
  users: number;
  p50Ms: number | null;
  lossPct: number | null;
}

export interface ChainTemplateSeriesPoint {
  ts: number;
  chains: number;
  users: number;
}

export interface ChainTemplateListItem {
  id: string;
  name: string;
  hops: number;
  enabled: boolean;
  chains: number;
  users: number;
  status: ChainTemplateStatus;
  strategies: ChainTemplateStrategyShare[];
  targets: ChainTemplateTarget[];
}

export interface ChainTemplateListSnapshot {
  generatedAt: number | null;
  items: ChainTemplateListItem[];
}

export interface ChainTemplateDetail {
  template: {
    id: string;
    name: string;
    hops: number;
    createdAt: number | null;
  };
  nodes: ChainTemplateNode[];
  edges: ChainTemplateEdge[];
  targets: ChainTemplateTarget[];
  users: ChainTemplateUser[];
  series: ChainTemplateSeriesPoint[];
  strategies: ChainTemplateStrategyShare[];
}

/** 热力色阶最多 4 档；0 链保持透明，不占档。 */
export const MAX_TEMPLATE_HEAT_TIERS = 4;

/** 策略分布的固定展示顺序：与后端 `chain_groups.strategy` 的枚举一致。 */
export const TEMPLATE_STRATEGY_ORDER = [
  "round_robin",
  "failover",
  "lowest_latency",
  "ip_hashed",
  "weighted",
  "least_conn",
] as const;

/** 旧契约 / 早期草案里的 `ip_hash` 归一到真实枚举，未知值不动。 */
const TEMPLATE_STRATEGY_ALIASES: Record<string, string> = {
  ip_hash: "ip_hashed",
};

export function canonicalStrategy(strategy: string): string {
  const trimmed = strategy.trim();
  return TEMPLATE_STRATEGY_ALIASES[trimmed] ?? trimmed;
}

/** 已知策略返回 `chains.strategy.*.label` 文案键；未知值返回 null 原样展示。 */
export function chainTemplateStrategyLabelKey(
  strategy: string,
): string | null {
  const canonical = canonicalStrategy(strategy);
  return (TEMPLATE_STRATEGY_ORDER as readonly string[]).includes(canonical)
    ? `chains.strategy.${canonical}.label`
    : null;
}

export const TEMPLATE_USAGE_RANGES = ["24h", "7d"] as const;
export type ChainTemplateUsageRange = (typeof TEMPLATE_USAGE_RANGES)[number];

const HOUR_SECS = 3_600;
const USAGE_WINDOW_SECS: Record<ChainTemplateUsageRange, number> = {
  "24h": 24 * HOUR_SECS,
  "7d": 7 * 24 * HOUR_SECS,
};
/** 允许 1 小时的时钟漂移，避免刚刚写入的桶被「未来」过滤掉。 */
const CLOCK_SKEW_SECS = HOUR_SECS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** 计数类字段：非负整数，缺失不造数。 */
function count(value: unknown): number {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function timestamp(value: unknown): number | null {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed <= 0) return null;
  // 契约沿用秒；兼容毫秒（> 1e11 视为毫秒）。
  return parsed > 1e11 ? Math.floor(parsed / 1000) : parsed;
}

export function chainTemplateStatusKind(
  value: unknown,
): ChainTemplateStatusKind {
  return typeof value === "string" &&
    (TEMPLATE_STATUS_KINDS as readonly string[]).includes(value)
    ? (value as ChainTemplateStatusKind)
    : "unknown";
}

export function chainTemplateStatus(value: unknown): ChainTemplateStatus {
  if (!isRecord(value)) return { kind: "unknown", cause: null };
  const cause = text(value.cause);
  return {
    kind: chainTemplateStatusKind(value.kind),
    cause: cause === "" ? null : cause,
  };
}

function memberStatus(value: unknown): ChainTemplateMemberStatus {
  return typeof value === "string" &&
    (TEMPLATE_MEMBER_STATUSES as readonly string[]).includes(value)
    ? (value as ChainTemplateMemberStatus)
    : "unknown";
}

function normalizeStrategy(value: unknown): ChainTemplateStrategyShare | null {
  if (!isRecord(value)) return null;
  const strategy = text(value.strategy);
  if (strategy === "") return null;
  return {
    strategy,
    chains: count(value.chains),
    users: count(value.users),
  };
}

function normalizeUser(value: unknown): ChainTemplateUser | null {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  const id = text(value.id);
  if (name === "" && id === "") return null;
  return {
    id: id || name,
    name: name || id,
    chains: count(value.chains),
  };
}

function normalizeUsers(value: unknown): ChainTemplateUser[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, ChainTemplateUser>();
  for (const item of value) {
    const user = normalizeUser(item);
    if (user === null) continue;
    const existing = byKey.get(user.id);
    if (existing === undefined) {
      byKey.set(user.id, user);
    } else {
      existing.chains = Math.max(existing.chains, user.chains);
    }
  }
  return [...byKey.values()];
}

function normalizeTarget(value: unknown): ChainTemplateTarget | null {
  if (!isRecord(value)) return null;
  const host = text(value.host);
  if (host === "") return null;
  const port = finiteNumber(value.port);
  return {
    host,
    port: port !== null && port > 0 && port <= 65_535 ? Math.floor(port) : null,
    chains: count(value.chains),
    users: normalizeUsers(value.users),
  };
}

function normalizeTargets(value: unknown): ChainTemplateTarget[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeTarget)
    .filter((target): target is ChainTemplateTarget => target !== null);
}

function normalizeStrategies(value: unknown): ChainTemplateStrategyShare[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeStrategy)
    .filter((share): share is ChainTemplateStrategyShare => share !== null);
}

function normalizeListItem(value: unknown): ChainTemplateListItem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const name = text(value.name);
  if (id === "" && name === "") return null;
  return {
    id: id || name,
    name: name || id,
    hops: count(value.hops),
    enabled: bool(value.enabled, true),
    chains: count(value.chains),
    users: count(value.users),
    status: chainTemplateStatus(value.status),
    strategies: normalizeStrategies(value.strategies),
    targets: normalizeTargets(value.targets),
  };
}

export function normalizeChainTemplateList(
  payload: unknown,
): ChainTemplateListSnapshot {
  const rawItems = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.items)
      ? payload.items
      : [];
  const byId = new Map<string, ChainTemplateListItem>();
  for (const raw of rawItems) {
    const item = normalizeListItem(raw);
    if (item === null) continue;
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return {
    generatedAt:
      isRecord(payload) && payload.generated_at !== undefined
        ? timestamp(payload.generated_at)
        : null,
    items: [...byId.values()],
  };
}

function normalizeNode(value: unknown, fallbackHops: number): ChainTemplateNode | null {
  if (!isRecord(value)) return null;
  const seqNumber = finiteNumber(value.seq);
  if (seqNumber === null) return null;
  const seq = Math.max(0, Math.floor(seqNumber));
  const rawRole = text(value.role);
  const role: ChainTemplateNodeRole =
    rawRole === "source" || rawRole === "hop" || rawRole === "target"
      ? rawRole
      : seq === 0
        ? "source"
        : seq === fallbackHops
          ? "target"
          : "hop";
  const members = Array.isArray(value.members)
    ? value.members
        .map((member, index): ChainTemplateMember | null => {
          if (!isRecord(member)) return null;
          const serverId = text(member.server_id);
          const name = text(member.name) || serverId || `#${index + 1}`;
          return {
            serverId: serverId === "" ? null : serverId,
            name,
            status: memberStatus(member.status),
            chains: count(member.chains),
            users: count(member.users),
          };
        })
        .filter((member): member is ChainTemplateMember => member !== null)
    : [];
  return {
    seq,
    role,
    name: text(value.name),
    members,
  };
}

function normalizeEdge(value: unknown): ChainTemplateEdge | null {
  if (!isRecord(value)) return null;
  const from = isRecord(value.from) ? value.from : null;
  const to = isRecord(value.to) ? value.to : null;
  if (from === null || to === null) return null;
  const fromSeq = finiteNumber(from.seq);
  const toSeq = finiteNumber(to.seq);
  if (fromSeq === null || toSeq === null) return null;
  const p50 = finiteNumber(value.p50_ms);
  const loss = finiteNumber(value.loss_pct);
  return {
    seq: Math.floor(finiteNumber(value.seq) ?? toSeq),
    fromSeq: Math.max(0, Math.floor(fromSeq)),
    fromMember: text(from.member),
    toSeq: Math.max(0, Math.floor(toSeq)),
    toMember: text(to.member),
    chains: count(value.chains),
    users: count(value.users),
    p50Ms: p50 !== null && p50 >= 0 ? p50 : null,
    lossPct: loss !== null && loss >= 0 ? loss : null,
  };
}

function normalizeSeries(value: unknown): ChainTemplateSeriesPoint[] {
  if (!Array.isArray(value)) return [];
  const byTs = new Map<number, ChainTemplateSeriesPoint>();
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const ts = timestamp(raw.ts);
    if (ts === null) continue;
    byTs.set(ts, {
      ts,
      chains: count(raw.chains),
      users: count(raw.users),
    });
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * 同一对成员之间的重复边合并成一条真实路径：链数求和、用户取最大、
 * P50 / 丢包按链数加权。O(E)，前端不再为重复边画重叠线。
 */
export function aggregateChainTemplateEdges(
  edges: readonly ChainTemplateEdge[],
): ChainTemplateEdge[] {
  interface Accumulated {
    edge: ChainTemplateEdge;
    p50Sum: number;
    p50Weight: number;
    lossSum: number;
    lossWeight: number;
  }
  const byPath = new Map<string, Accumulated>();
  for (const edge of edges) {
    const key = `${edge.fromSeq}|${edge.fromMember}|${edge.toSeq}|${edge.toMember}`;
    const weight = Math.max(1, edge.chains);
    const existing = byPath.get(key);
    if (existing === undefined) {
      byPath.set(key, {
        edge: { ...edge },
        p50Sum: edge.p50Ms === null ? 0 : edge.p50Ms * weight,
        p50Weight: edge.p50Ms === null ? 0 : weight,
        lossSum: edge.lossPct === null ? 0 : edge.lossPct * weight,
        lossWeight: edge.lossPct === null ? 0 : weight,
      });
      continue;
    }
    existing.edge.chains += edge.chains;
    existing.edge.users = Math.max(existing.edge.users, edge.users);
    if (edge.p50Ms !== null) {
      existing.p50Sum += edge.p50Ms * weight;
      existing.p50Weight += weight;
    }
    if (edge.lossPct !== null) {
      existing.lossSum += edge.lossPct * weight;
      existing.lossWeight += weight;
    }
  }
  return [...byPath.values()].map((item) => ({
    ...item.edge,
    p50Ms:
      item.p50Weight > 0
        ? Math.round((item.p50Sum / item.p50Weight) * 10) / 10
        : null,
    lossPct:
      item.lossWeight > 0
        ? Math.round((item.lossSum / item.lossWeight) * 100) / 100
        : null,
  }));
}

/**
 * 详情归一化。节点缺失时从边反推 seq → 成员名，目标节点缺失时补一个
 * 聚合 TARGET 列，保证拓扑始终有头有尾。
 */
export function normalizeChainTemplateDetail(
  payload: unknown,
): ChainTemplateDetail {
  const root = isRecord(payload) ? payload : {};
  const rawTemplate = isRecord(root.template) ? root.template : {};
  const rawEdges = Array.isArray(root.edges) ? root.edges : [];
  const edges = aggregateChainTemplateEdges(
    rawEdges
      .map(normalizeEdge)
      .filter((edge): edge is ChainTemplateEdge => edge !== null),
  );
  const rawNodes = Array.isArray(root.nodes) ? root.nodes : [];
  const templateHops =
    count(rawTemplate.hops) ||
    Math.max(0, ...edges.map((edge) => Math.max(edge.fromSeq, edge.toSeq)));

  const bySeq = new Map<number, ChainTemplateNode>();
  for (const raw of rawNodes) {
    const node = normalizeNode(raw, templateHops);
    if (node === null) continue;
    const existing = bySeq.get(node.seq);
    if (existing === undefined) {
      bySeq.set(node.seq, node);
      continue;
    }
    // 同 seq 的重复节点合并成员，不覆盖已有名字。
    if (existing.name === "" && node.name !== "") existing.name = node.name;
    if (node.role !== "hop") existing.role = node.role;
    existing.members.push(...node.members);
  }

  if (bySeq.size === 0 && edges.length > 0) {
    for (const edge of edges) {
      for (const [seq, member] of [
        [edge.fromSeq, edge.fromMember],
        [edge.toSeq, edge.toMember],
      ] as const) {
        let node = bySeq.get(seq);
        if (node === undefined) {
          node = {
            seq,
            role: seq === 0 ? "source" : seq === templateHops ? "target" : "hop",
            name: "",
            members: [],
          };
          bySeq.set(seq, node);
        }
        if (member !== "" && !node.members.some((item) => item.name === member)) {
          node.members.push({
            serverId: null,
            name: member,
            status: "unknown",
            chains: 0,
            users: 0,
          });
        }
      }
    }
  }

  const targets = normalizeTargets(root.targets);
  const maxSeq = Math.max(
    templateHops,
    ...edges.map((edge) => Math.max(edge.fromSeq, edge.toSeq)),
    ...bySeq.keys(),
  );
  const hasTarget = [...bySeq.values()].some((node) => node.role === "target");
  if (!hasTarget) {
    bySeq.set(maxSeq, {
      seq: maxSeq,
      role: "target",
      name: "",
      members: targets.map((target) => ({
        serverId: null,
        name: targetLabel(target),
        status: "unknown",
        chains: target.chains,
        users: target.users.length,
      })),
    });
  }

  const nodes = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const users = normalizeUsers(root.users);
  const series = normalizeSeries(root.series);
  const strategies = normalizeStrategies(root.strategies);
  const hops = Math.max(
    count(rawTemplate.hops),
    ...nodes.map((node) => node.seq),
    templateHops,
  );

  return {
    template: {
      id: text(rawTemplate.id),
      name: text(rawTemplate.name),
      hops,
      createdAt: timestamp(rawTemplate.created_at),
    },
    nodes,
    edges,
    targets,
    users,
    series,
    strategies,
  };
}

export function isChainTemplateInsightUnsupported(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 404 || error.status === 403)
  );
}

export function nodeHeatTier(chains: number, maxChains: number): number {
  if (!Number.isFinite(chains) || !Number.isFinite(maxChains)) return 0;
  if (chains <= 0 || maxChains <= 0) return 0;
  const ratio = Math.min(1, chains / maxChains);
  return Math.max(
    1,
    Math.min(MAX_TEMPLATE_HEAT_TIERS, Math.ceil(ratio * MAX_TEMPLATE_HEAT_TIERS)),
  );
}

export function edgeStrokeWidth(chains: number, maxChains: number): number {
  if (!Number.isFinite(chains) || !Number.isFinite(maxChains)) return 1;
  if (chains <= 0 || maxChains <= 0) return 1;
  const ratio = Math.min(1, chains / maxChains);
  return Math.round((1 + 5 * ratio) * 100) / 100;
}

export function edgeStrokeOpacity(chains: number, maxChains: number): number {
  if (!Number.isFinite(chains) || !Number.isFinite(maxChains)) return 0.1;
  if (chains <= 0 || maxChains <= 0) return 0.1;
  const ratio = Math.min(1, chains / maxChains);
  return Math.round((0.1 + 0.28 * ratio) * 100) / 100;
}

export interface StrategyShareView extends ChainTemplateStrategyShare {
  /** 占全部策略链数的百分比（未四舍五入，展示时再格式化）。 */
  pct: number;
}

export function strategyShares(
  raw: readonly ChainTemplateStrategyShare[],
): StrategyShareView[] {
  const byStrategy = new Map<string, ChainTemplateStrategyShare>();
  for (const item of raw) {
    const strategy = canonicalStrategy(item.strategy);
    if (strategy === "") continue;
    const existing = byStrategy.get(strategy);
    if (existing === undefined) {
      byStrategy.set(strategy, {
        strategy,
        chains: Math.max(0, item.chains),
        users: Math.max(0, item.users),
      });
    } else {
      existing.chains += Math.max(0, item.chains);
      existing.users += Math.max(0, item.users);
    }
  }
  const present = [...byStrategy.values()].filter((item) => item.chains > 0);
  const total = present.reduce((sum, item) => sum + item.chains, 0);
  const order = (strategy: string): number => {
    const index = (TEMPLATE_STRATEGY_ORDER as readonly string[]).indexOf(strategy);
    return index === -1 ? TEMPLATE_STRATEGY_ORDER.length : index;
  };
  return present
    .sort(
      (a, b) =>
        order(a.strategy) - order(b.strategy) ||
        a.strategy.localeCompare(b.strategy),
    )
    .map((item) => ({
      ...item,
      pct: total > 0 ? (item.chains / total) * 100 : 0,
    }));
}

export interface ChainTemplateUsageView {
  points: ChainTemplateSeriesPoint[];
  maxChains: number;
  maxUsers: number;
}

/** 后端无创建时返回全 0 的补齐序列；全 0 视作「暂无使用记录」。 */
export function chainTemplateUsageHasData(
  points: readonly ChainTemplateSeriesPoint[],
): boolean {
  return points.some((point) => point.chains > 0 || point.users > 0);
}

export function chainTemplateUsageSeries(
  series: readonly ChainTemplateSeriesPoint[],
  range: ChainTemplateUsageRange,
  nowTs: number = Math.floor(Date.now() / 1000),
): ChainTemplateUsageView {
  const windowSecs = USAGE_WINDOW_SECS[range];
  const from = nowTs - windowSecs;
  const points = series
    .filter(
      (point) =>
        Number.isFinite(point.ts) &&
        point.ts >= from &&
        point.ts <= nowTs + CLOCK_SKEW_SECS,
    )
    .sort((a, b) => a.ts - b.ts);
  return {
    points,
    maxChains: points.reduce((max, point) => Math.max(max, point.chains), 0),
    maxUsers: points.reduce((max, point) => Math.max(max, point.users), 0),
  };
}

export interface ChainTemplateUsageUsersView {
  users: ChainTemplateUser[];
  /** 契约只给最终用户列表：tooltip 里必须注明这是「当前」用户。 */
  current: true;
}

export function chainTemplateUsageUsers(
  detail: ChainTemplateDetail,
): ChainTemplateUsageUsersView {
  if (detail.users.length > 0) {
    return { users: detail.users, current: true };
  }
  const byKey = new Map<string, ChainTemplateUser>();
  for (const target of detail.targets) {
    for (const user of target.users) {
      const existing = byKey.get(user.id);
      if (existing === undefined) {
        byKey.set(user.id, { ...user });
      } else {
        existing.chains = Math.max(existing.chains, user.chains);
      }
    }
  }
  return { users: [...byKey.values()], current: true };
}

export interface ChainTemplateHotspot {
  key: string;
  name: string;
  chains: number;
  users: number;
  offline: boolean;
}

export function chainTemplateHotspots(
  nodes: readonly ChainTemplateNode[],
  limit = 5,
): ChainTemplateHotspot[] {
  const byKey = new Map<string, ChainTemplateHotspot>();
  for (const node of nodes) {
    if (node.role === "target") continue;
    for (const member of node.members) {
      const key = member.serverId ?? member.name;
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          key,
          name: member.name,
          chains: member.chains,
          users: member.users,
          offline: member.status === "offline",
        });
      } else {
        existing.chains = Math.max(existing.chains, member.chains);
        existing.users = Math.max(existing.users, member.users);
        existing.offline = existing.offline || member.status === "offline";
      }
    }
  }
  return [...byKey.values()]
    .sort(
      (a, b) =>
        b.chains - a.chains ||
        b.users - a.users ||
        a.name.localeCompare(b.name),
    )
    .slice(0, Math.max(0, Math.floor(limit)));
}

export interface ChainTemplateDetailTotals {
  hops: number;
  chains: number;
  users: number;
}

/** 详情标题的跳数 / 链数 / 用户数；列表项缺失时的兜底。 */
export function chainTemplateDetailTotals(
  detail: ChainTemplateDetail,
): ChainTemplateDetailTotals {
  const source = detail.nodes.find((node) => node.role === "source");
  const visible = detail.nodes.filter((node) => node.role !== "target");
  const chains = source
    ? source.members.reduce((sum, member) => sum + member.chains, 0)
    : visible.reduce(
        (max, node) =>
          Math.max(max, ...node.members.map((member) => member.chains), 0),
        0,
      );
  const users = source
    ? source.members.reduce((sum, member) => sum + member.users, 0)
    : visible.reduce(
        (max, node) =>
          Math.max(max, ...node.members.map((member) => member.users), 0),
        0,
      );
  return {
    hops: detail.template.hops,
    chains,
    users,
  };
}

export function targetLabel(target: ChainTemplateTarget): string {
  if (target.port === null) return target.host;
  return target.host.includes(":")
    ? `[${target.host}]:${target.port}`
    : `${target.host}:${target.port}`;
}

export function templateTargetLabels(detail: ChainTemplateDetail): string[] {
  return detail.targets.map(targetLabel);
}
