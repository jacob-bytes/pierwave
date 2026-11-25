import { ApiError } from "./apiError.ts";

/**
 * 「转发链模板」洞察区块的纯逻辑。
 *
 * 契约（新主控）：
 * `GET /api/v1/overview/chain-templates`
 * `GET /api/v1/overview/chain-templates/{id}?hours=24|168`
 *
 * 这里只负责把 snake_case 响应归一化、算拓扑布局、策略占比、使用量序列与
 * 热点排序；不依赖 React / DOM / i18n，便于 `node:test` 覆盖。
 * 旧主控 404 在查询层转成 `null`，页面显示「需要新版本主控」；403 是权限
 * 问题，照常走错误态，不能当成「旧主控」降级。
 */

export const TEMPLATE_STATUS_KINDS = ["ok", "degraded", "blocked", "unknown"] as const;
export type ChainTemplateStatusKind = (typeof TEMPLATE_STATUS_KINDS)[number];

export interface ChainTemplateStatus {
  kind: ChainTemplateStatusKind;
  cause: string | null;
}

/**
 * 成员状态四档：`online` / `offline` / `degraded` / `unknown`。
 *
 * 后端 `servers.status` 是原样透传的库内值（online / offline / abnormal /
 * no_data …），这里只做归一：`abnormal`、`no_data` 都是「还活着但数据不可信」
 * → `degraded`，和链路详情的红点口径一致（非 online 即异常，但异常里区分
 * 离线与降级）。
 */
export const TEMPLATE_MEMBER_STATUSES = [
  "online",
  "offline",
  "degraded",
  "unknown",
] as const;
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

/**
 * 模板候选里没有被任何链用到的成员（新契约的 `unused_candidates`）。
 *
 * 旧主控没有该数组 → 空数组；不再从 `nodes` 反推（新契约的 `nodes` 只含
 * 真实链成员，反推只会得到空列表，还会把「没数据」与「没用到」混在一起）。
 */
export interface ChainTemplateUnusedCandidate {
  /** 成员在**模板**里的组号。 */
  seq: number;
  serverId: string | null;
  name: string;
  status: ChainTemplateMemberStatus;
}

export interface ChainTemplateDetail {
  template: {
    id: string;
    name: string;
    hops: number;
    createdAt: number | null;
    /** 链的跳数 / 成员是否仍与模板当前定义一致；旧契约缺失时为 false。 */
    stale: boolean;
    /** 双语不一致说明；stale = false 或旧契约时为 null。 */
    staleReason: string | null;
  };
  nodes: ChainTemplateNode[];
  edges: ChainTemplateEdge[];
  targets: ChainTemplateTarget[];
  users: ChainTemplateUser[];
  series: ChainTemplateSeriesPoint[];
  /** `series` 的口径；旧契约 / 未知值时为 null。 */
  seriesBasis: "existing_chains" | null;
  unusedCandidates: ChainTemplateUnusedCandidate[];
  strategies: ChainTemplateStrategyShare[];
}

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

/** 后端 `servers.status` → 四档展示状态；未知值不造状态。 */
export function chainTemplateMemberStatus(
  value: unknown,
): ChainTemplateMemberStatus {
  if (typeof value !== "string") return "unknown";
  switch (value.trim().toLowerCase()) {
    case "online":
      return "online";
    case "offline":
      return "offline";
    // 库里 abnormal / no_data 都是「机器还在、数据不可信」。
    case "degraded":
    case "abnormal":
    case "no_data":
    case "nodata":
      return "degraded";
    default:
      return "unknown";
  }
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

function normalizeUnusedCandidate(
  value: unknown,
): ChainTemplateUnusedCandidate | null {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  const serverId = text(value.server_id);
  // 名字是唯一可展示文本；只有 server_id 的脏数据没有意义。
  if (name === "") return null;
  return {
    seq: Math.max(0, Math.floor(finiteNumber(value.seq) ?? 0)),
    serverId: serverId === "" ? null : serverId,
    name,
    status: chainTemplateMemberStatus(value.status),
  };
}

function normalizeUnusedCandidates(
  value: unknown,
): ChainTemplateUnusedCandidate[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rows: ChainTemplateUnusedCandidate[] = [];
  for (const item of value) {
    const candidate = normalizeUnusedCandidate(item);
    if (candidate === null) continue;
    const key = `${candidate.seq}::${candidate.serverId ?? candidate.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(candidate);
  }
  return rows.sort((a, b) => a.seq - b.seq || a.name.localeCompare(b.name));
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

/**
 * 模板子页顶部的四格 KPI：只从列表响应聚合，不新增接口。
 *
 * 口径：
 * - `total` / `enabled` / `disabled`：模板总数与启停数；
 * - `inUse`：有链在用（`chains > 0`）的模板数，停用模板也算在用；
 * - `chains`：所有模板的链数之和；
 * - `users`：各模板去重用户数之和。列表契约只给每个模板的 owner 去重数，
 *   没有用户 id，跨模板重复用户无法在这里再去重（管理员链本身已被后端
 *   排除，见 `/api/v1/overview/chain-templates` 的 `users` 口径）；
 * - `abnormal`：**启用中**的模板里 blocked / degraded 的数量；停用是主动
 *   降噪，不算异常，否则「异常模板」会把故意关掉的模板也算进去。
 */
export interface ChainTemplateKpisView {
  total: number;
  enabled: number;
  disabled: number;
  inUse: number;
  chains: number;
  users: number;
  blocked: number;
  degraded: number;
  abnormal: number;
}

export function chainTemplateKpis(
  items: readonly ChainTemplateListItem[],
): ChainTemplateKpisView {
  let enabled = 0;
  let inUse = 0;
  let chains = 0;
  let users = 0;
  let blocked = 0;
  let degraded = 0;
  for (const item of items) {
    if (item.enabled) enabled += 1;
    if (item.chains > 0) inUse += 1;
    chains += Math.max(0, item.chains);
    users += Math.max(0, item.users);
    if (!item.enabled) continue;
    if (item.status.kind === "blocked") blocked += 1;
    else if (item.status.kind === "degraded") degraded += 1;
  }
  return {
    total: items.length,
    enabled,
    disabled: items.length - enabled,
    inUse,
    chains,
    users,
    blocked,
    degraded,
    abnormal: blocked + degraded,
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
            status: chainTemplateMemberStatus(member.status),
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
    // 插到 maxSeq + 1：直接写 maxSeq 会把最后一跳（最后一个 hop 成员）
    // 覆盖成目标列，整条链少一跳、拓扑里目标跟最后一跳叠在一起。
    bySeq.set(maxSeq + 1, {
      seq: maxSeq + 1,
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
  const staleReason = text(rawTemplate.stale_reason);
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
      // 旧主控没有 `stale`：一律 false，提示条不出现，不能猜「模板改过」。
      stale: bool(rawTemplate.stale, false),
      staleReason: staleReason === "" ? null : staleReason,
    },
    nodes,
    edges,
    targets,
    users,
    series,
    // 只有契约显式声明 existing_chains 才加「按现有链回填」的图注。
    seriesBasis:
      text(root.series_basis) === "existing_chains" ? "existing_chains" : null,
    unusedCandidates: normalizeUnusedCandidates(root.unused_candidates),
    strategies,
  };
}

export function isChainTemplateInsightUnsupported(error: unknown): boolean {
  // 只有 404 代表「旧主控没有这条路由」。403 是权限问题，必须暴露成错误。
  return error instanceof ApiError && error.status === 404;
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

export interface ChainTemplateStrategySummary {
  /** 链数最多的策略；同链数按策略枚举顺序取靠前者。 */
  top: StrategyShareView;
  /** 实际出现的策略种类数（零链不算）。 */
  kinds: number;
  /** 各策略链数之和。 */
  chains: number;
  /** 各策略用户数之和；同一用户可能出现在多种策略里，只作规模参考。 */
  users: number;
}

/**
 * 策略摘要：给「策略分布」卡补一行有信息量的注脚。
 *
 * 策略种类少时卡片会被旁边的节点热度卡衬托得很短，摘要用现有
 * `strategies` 字段说明「最常用的是哪种、覆盖多少链、一共几种」，
 * 不新增接口，也不用空白把卡片撑高。
 */
export function chainTemplateStrategySummary(
  raw: readonly ChainTemplateStrategyShare[],
): ChainTemplateStrategySummary | null {
  const shares = strategyShares(raw);
  if (shares.length === 0) return null;
  // 严格大于：并列第一时保留枚举顺序靠前的那个，结果稳定可测。
  const top = shares.reduce((best, item) =>
    item.chains > best.chains ? item : best,
  );
  return {
    top,
    kinds: shares.length,
    chains: shares.reduce((sum, item) => sum + item.chains, 0),
    users: shares.reduce((sum, item) => sum + item.users, 0),
  };
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
  status: ChainTemplateMemberStatus;
}

/** 同一服务器在不同跳重复出现时合并状态：离线 > 降级 > 在线 > 未知。 */
const MEMBER_STATUS_PRIORITY: Record<ChainTemplateMemberStatus, number> = {
  unknown: 0,
  online: 1,
  degraded: 2,
  offline: 3,
};

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
          status: member.status,
        });
      } else {
        existing.chains = Math.max(existing.chains, member.chains);
        existing.users = Math.max(existing.users, member.users);
        existing.offline = existing.offline || member.status === "offline";
        if (
          MEMBER_STATUS_PRIORITY[member.status] >
          MEMBER_STATUS_PRIORITY[existing.status]
        ) {
          existing.status = member.status;
        }
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

export interface ChainTemplateNodeHeatRow extends ChainTemplateHotspot {
  /** 横条宽度：chains / 本卡最大链数 × 100。 */
  barPct: number;
  /** 占该模板总链数的百分比，夹紧到 0–100。 */
  sharePct: number;
}

export interface ChainTemplateNodeHeatView {
  rows: ChainTemplateNodeHeatRow[];
  maxChains: number;
  totalChains: number;
}

/**
 * 「节点热度」视图：按使用链数取 Top 5，再算条宽与占比。
 *
 * 只保留有链使用的节点（chains > 0）；没有这类节点时 rows 为空，卡片给空态。
 * 条宽以本卡最大链数为基准（首行必满格），占比以模板总链数为分母——两者
 * 分母不同，别为了「看起来一致」把占比也按最大链数算。
 *
 * 注意：这里**必须是横向条形图，不能换饼图**。同一节点会在链的每一跳被
 * 重复计入（此处按 serverId 取最大值合并），各节点链数之和远大于模板链数，
 * 画成饼图后各扇区之和没有业务含义，只能做相对长短比较。
 */
export function chainTemplateNodeHeat(
  detail: ChainTemplateDetail,
  limit = 5,
): ChainTemplateNodeHeatView {
  const rows = chainTemplateHotspots(detail.nodes, limit).filter(
    (row) => row.chains > 0,
  );
  const maxChains = rows[0]?.chains ?? 0;
  const totalChains = chainTemplateDetailTotals(detail).chains;
  return {
    rows: rows.map((row) => ({
      ...row,
      barPct: maxChains > 0 ? (row.chains / maxChains) * 100 : 0,
      sharePct:
        totalChains > 0
          ? Math.max(0, Math.min(100, (row.chains / totalChains) * 100))
          : 0,
    })),
    maxChains,
    totalChains,
  };
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
