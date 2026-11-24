/**
 * 转发链的纯展示逻辑：不依赖 React / DOM，方便直接跑单元测试。
 *
 * 语义（与后端 `crates/master/src/routes/chains.rs` 对齐）：
 * - 一条链由 1–4 个「组」组成，每组 1–8 台成员服务器；
 * - 上一跳按**下一组**的 `strategy` 从候选成员里选一台；
 * - 链状态按「停用 → 降级 → 正常」判定；任一组成员 degraded 即整链降级；
 * - 每个成员的 `listening` 与 `target_ok` 是两件独立的事：
 *   端口绑上了（listening=true）不代表目标地址可达（target_ok）；
 * - `degraded` 由后端按「连续 2 次 target_ok=false」计算，前端不重复推导。
 *
 * 旧字段 `hops` 只是为了兼容尚未升级的调用方；列表、详情、表单都只读
 * `groups`，不再自己把多成员组压平成一条 hop。
 */

export type ChainStatus = "disabled" | "degraded" | "ok";

/** 与后端 `pierwave_domain::chains::STRATEGY_NAMES` 保持一致。 */
export const CHAIN_STRATEGIES = [
  "round_robin",
  "failover",
  "lowest_latency",
  "ip_hashed",
  "weighted",
  "least_conn",
] as const;

export type ChainStrategy = (typeof CHAIN_STRATEGIES)[number];

export const DEFAULT_CHAIN_STRATEGY: ChainStrategy = "round_robin";

/**
 * nftables 多目标能实现的策略（与后端 `chains::nftables_strategy_supported` 一致）。
 *
 * 内核 DNAT 只有 `numgen`（轮询/加权随机）与 `jhash`（源地址哈希）两类原语；
 * 主备 / 最低延迟 / 最少连接需要用户态健康探测或连接计数，必须明确拒绝。
 */
export const NFTABLES_MULTI_TARGET_STRATEGIES = [
  "round_robin",
  "weighted",
  "ip_hashed",
] as const satisfies readonly ChainStrategy[];

export function nftablesStrategySupported(
  strategy: string | null | undefined,
): boolean {
  return (NFTABLES_MULTI_TARGET_STRATEGIES as readonly string[]).includes(
    normalizeStrategy(strategy),
  );
}

/** 与后端 `chains::WEIGHT_MIN` / `WEIGHT_MAX` / 迁移默认值保持一致。 */
export const CHAIN_WEIGHT_MIN = 1;
export const CHAIN_WEIGHT_MAX = 100;
export const DEFAULT_CHAIN_WEIGHT = 1;

/** 只有加权策略读取成员权重。 */
export function strategyUsesWeight(strategy: string | null | undefined): boolean {
  return normalizeStrategy(strategy) === "weighted";
}

/**
 * 成员权重输入是否可见：只在「加权 + 多成员组」时出现。
 *
 * 单成员组没有可分配的对象，权重没有意义；隐藏输入也不提交，后端保持缺省 1。
 */
export function weightFieldVisible(
  strategy: string | null | undefined,
  memberCount: number,
): boolean {
  return strategyUsesWeight(strategy) && memberCount > 1;
}

/** 严格解析权重：必须是 1–100 的整数；非法 / 空串返回 null（不猜一个值）。 */
export function parseWeight(
  raw: string | number | null | undefined,
): number | null {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const weight = Number(text);
  return Number.isInteger(weight) &&
    weight >= CHAIN_WEIGHT_MIN &&
    weight <= CHAIN_WEIGHT_MAX
    ? weight
    : null;
}

/** 提交前的权重归一化：非法值回落 1（与后端列默认值一致）。 */
export function normalizeWeight(
  raw: string | number | null | undefined,
): number {
  return parseWeight(raw) ?? DEFAULT_CHAIN_WEIGHT;
}

/** 与后端 `chains::MIN_HOPS` / `MAX_HOPS` 保持一致。 */
export const CHAIN_MIN_GROUPS = 1;
export const CHAIN_MAX_GROUPS = 6;

/** 与后端 `chains::MIN_GROUP_MEMBERS` / `MAX_GROUP_MEMBERS` 保持一致。 */
export const GROUP_MIN_MEMBERS = 1;
export const GROUP_MAX_MEMBERS = 8;
/** UI 约定：显式的「分组」至少 2 台；只有 1 台请用「单节点」。 */
export const GROUP_MIN_GROUP_MEMBERS = 2;

/** 旧命名保留，语义已经是「组数」。 */
export const CHAIN_MIN_HOPS = CHAIN_MIN_GROUPS;
export const CHAIN_MAX_HOPS = CHAIN_MAX_GROUPS;

/** 列表与展开区共用的成员快照；字段是 `ChainGroupMember` 的结构子集。 */
export interface ChainMemberSnapshot {
  server_id?: string;
  server_name: string;
  listen_port: number;
  priority?: number;
  listening: boolean | null;
  target_ok: boolean | null;
  degraded?: boolean;
  error?: string;
  updated_at?: number | null;
}

/** 旧字段 `hops` 的形状；仅保留给兼容逻辑与旧测试，不再被页面读取。 */
export interface ChainHopSnapshot {
  seq: number;
  server_name: string;
  listen_port: number;
  listening: boolean | null;
  target_ok: boolean | null;
  degraded?: boolean;
  error?: string;
  updated_at?: number | null;
}

/**
 * 整链状态。停用优先于降级：停用后 Agent 不再监听，
 * 旧心跳里的失败计数不能继续把一条停用链标成「降级」。
 */
export function chainStatus(
  enabled: boolean | number | undefined,
  degraded: boolean | number | undefined,
): ChainStatus {
  if (!enabled) return "disabled";
  return degraded ? "degraded" : "ok";
}

export type HopListeningState = "listening" | "failed" | "unreported";

/** `null` = Agent 未上报，并不等于监听失败。 */
export function hopListeningState(
  listening: boolean | null | undefined,
): HopListeningState {
  if (listening === null || listening === undefined) return "unreported";
  return listening ? "listening" : "failed";
}

export type HopTargetState = "reachable" | "unreachable" | "unprobed";

/** `null` = 尚未探测，不能当成「目标可达」。 */
export function hopTargetState(
  targetOk: boolean | null | undefined,
): HopTargetState {
  if (targetOk === null || targetOk === undefined) return "unprobed";
  return targetOk ? "reachable" : "unreachable";
}

/** 后端只接受六个 snake_case 策略值；未知值按轮询展示（与领域层回落一致）。 */
export function isChainStrategy(value: unknown): value is ChainStrategy {
  return (
    typeof value === "string" &&
    (CHAIN_STRATEGIES as readonly string[]).includes(value)
  );
}

export function normalizeStrategy(
  raw: string | null | undefined,
): ChainStrategy {
  return isChainStrategy(raw) ? raw : DEFAULT_CHAIN_STRATEGY;
}

/** 一跳的展示类型：单节点（1 台、无组名、默认策略）或分组。 */
export type ChainHopKind = "single" | "group";

/**
 * 按后端数据结构推导一跳的类型。
 *
 * 单节点就是「1 台成员 + 没有组名 + 默认策略」；只要出现组名或非默认策略，
 * 即使只有 1 台也按分组展示，避免编辑时把用户显式配置的组信息藏掉。
 * 0 台成员的组仍按分组处理（还需要补成员）。
 */
export function groupKind(group: {
  name?: string | null;
  strategy?: string | null;
  members: readonly unknown[];
}): ChainHopKind {
  if (group.members.length !== 1) return "group";
  if ((group.name ?? "").trim()) return "group";
  return normalizeStrategy(group.strategy) === DEFAULT_CHAIN_STRATEGY
    ? "single"
    : "group";
}

/** 按 seq 升序复制：后端已排序，但前端不依赖响应顺序。 */
export function orderGroups<T extends { seq: number }>(
  groups: readonly T[],
): T[] {
  return [...groups].sort((a, b) => a.seq - b.seq);
}

/**
 * 组内成员按 priority 升序复制；`Array#sort` 是稳定排序，
 * 所以同优先级会保持后端返回的配置顺序（轮询依赖这个顺序）。
 */
export function orderMembers<T extends { priority: number }>(
  members: readonly T[],
): T[] {
  return [...members].sort((a, b) => a.priority - b.priority);
}

/** 按 seq 升序复制：兼容旧 `hops` 调用方。 */
export function orderHops<T extends { seq: number }>(hops: readonly T[]): T[] {
  return [...hops].sort((a, b) => a.seq - b.seq);
}

/**
 * 入口 = 第一组的第一台成员；空链返回 null。
 * 成员同优先级时以后端返回顺序为准，因此不会因为权重相同而抖动。
 */
export function entryMember<M extends { priority: number }>(
  groups: readonly { seq: number; members: readonly M[] }[],
): M | null {
  const first = orderGroups(groups)[0];
  if (!first) return null;
  return orderMembers(first.members)[0] ?? null;
}

/** 入口 = 第一跳；空链返回 null（旧 `hops` 兼容逻辑）。 */
export function entryHop<T extends { seq: number }>(
  hops: readonly T[],
): T | null {
  return orderHops(hops)[0] ?? null;
}

/** 列表「路径」列的两端：入口服务器名 → 出口服务器名 / 链目标。 */
export interface ChainPathNames {
  from: string | null;
  to: string | null;
}

interface PathGroup<M> {
  seq: number;
  members: readonly M[];
}

/**
 * 路径展示：入口 = 第一组的第一台成员，出口 = 最后一组的第一台成员。
 *
 * 单组链没有「最后一组 → 下一组」可看，出口直接用链目标（`host:port`），
 * 否则会出现「香港-01 → 香港-01」这种没有信息量的路径。空链两端都是 null。
 */
export function chainPathNames<
  M extends { priority: number; server_name: string },
>(
  groups: readonly PathGroup<M>[],
  target?: { host: string; port: number } | null,
): ChainPathNames {
  const ordered = orderGroups(groups);
  if (ordered.length === 0) return { from: null, to: null };

  const entry = orderMembers(ordered[0].members)[0] ?? null;
  const from = entry?.server_name.trim() || null;
  if (!from) return { from: null, to: null };

  if (ordered.length > 1) {
    const exit =
      orderMembers(ordered[ordered.length - 1].members)[0] ?? null;
    return { from, to: exit?.server_name.trim() || null };
  }

  const host = (target?.host ?? "").trim();
  if (!host) return { from, to: null };
  const port = target?.port;
  return {
    from,
    to: typeof port === "number" && Number.isFinite(port) && port > 0
      ? `${host}:${port}`
      : host,
  };
}

/** 列表里的「N 组 · M 台」。 */
export function chainGroupSummary(
  groups: readonly { members: readonly unknown[] }[],
): { groups: number; members: number } {
  return {
    groups: groups.length,
    members: groups.reduce((total, group) => total + group.members.length, 0),
  };
}

/** 组本身降级，或组内任一成员降级。 */
export function groupIsDegraded(group: {
  degraded?: boolean;
  members: readonly { degraded?: boolean }[];
}): boolean {
  return (
    Boolean(group.degraded) ||
    group.members.some((member) => Boolean(member.degraded))
  );
}

/** 已判定降级的组；展开行与状态列共用，按 seq 排序。 */
export function degradedGroups<
  T extends {
    seq: number;
    degraded?: boolean;
    members: readonly { degraded?: boolean }[];
  },
>(groups: readonly T[]): T[] {
  return orderGroups(groups).filter(groupIsDegraded);
}

/** 组内已判定降级的成员，按 priority 排序。 */
export function degradedMembers<
  T extends { priority: number; degraded?: boolean },
>(group: { members: readonly T[] }): T[] {
  return orderMembers(group.members).filter((member) =>
    Boolean(member.degraded),
  );
}

/**
 * 组/成员校验问题。纯函数产出「问题 + 路径参数」，由表单 schema 映射成
 * 对应语言的文案并挂到正确的字段层级；这样边界规则可以直接单测。
 */
export type ChainGroupIssue =
  | {
      kind: "group_count";
      count: number;
      min: number;
      max: number;
    }
  | {
      kind: "member_count";
      groupIndex: number;
      count: number;
      min: number;
      max: number;
    }
  | {
      kind: "member_duplicate";
      groupIndex: number;
      memberIndex: number;
    }
  | {
      kind: "server_duplicate";
      groupIndex: number;
      memberIndex: number;
      firstGroupIndex: number;
    };

export interface ChainGroupLike {
  members: readonly { server_id: string }[];
}

/**
 * 前端能独立判断的组规则：组数 1–4、每组 1–8 台、同组不重复、跨组不重复。
 * 与后端 `chains::validate_group_count` / `validate_group_member_count` /
 * `ensure_group_member_servers_unique` / `ensure_chain_servers_unique` 对齐。
 *
 * 组数越界时只报组数，不再逐组报成员问题（避免表单里根错误与嵌套错误
 * 互相覆盖）；成员数越界时同理只报成员数。
 */
export function collectGroupIssues(
  groups: readonly ChainGroupLike[],
): ChainGroupIssue[] {
  const issues: ChainGroupIssue[] = [];

  if (groups.length < CHAIN_MIN_GROUPS || groups.length > CHAIN_MAX_GROUPS) {
    issues.push({
      kind: "group_count",
      count: groups.length,
      min: CHAIN_MIN_GROUPS,
      max: CHAIN_MAX_GROUPS,
    });
    return issues;
  }

  // 跨组重复要在整条链范围内查：同一台服务器只能出现一次。
  const seenInChain = new Map<string, number>();

  groups.forEach((group, groupIndex) => {
    if (
      group.members.length < GROUP_MIN_MEMBERS ||
      group.members.length > GROUP_MAX_MEMBERS
    ) {
      issues.push({
        kind: "member_count",
        groupIndex,
        count: group.members.length,
        min: GROUP_MIN_MEMBERS,
        max: GROUP_MAX_MEMBERS,
      });
      return;
    }

    const seenInGroup = new Set<string>();
    group.members.forEach((member, memberIndex) => {
      // 空 server_id 由字段级「请选择服务器」处理，这里只查重复。
      if (!member.server_id) return;

      if (seenInGroup.has(member.server_id)) {
        issues.push({
          kind: "member_duplicate",
          groupIndex,
          memberIndex,
        });
        // 同组重复只报「同组」这一条，不再叠加跨组重复。
        return;
      }
      seenInGroup.add(member.server_id);

      const firstGroupIndex = seenInChain.get(member.server_id);
      if (firstGroupIndex !== undefined) {
        issues.push({
          kind: "server_duplicate",
          groupIndex,
          memberIndex,
          firstGroupIndex,
        });
      } else {
        seenInChain.set(member.server_id, groupIndex);
      }
    });
  });

  return issues;
}

export interface ChainServerUsage {
  /** 占用它的那一跳（0 起）。 */
  groupIndex: number;
  /** 占用它的那台成员（0 起）；跨跳时用于说明「第 N 跳」。 */
  memberIndex: number;
}

/**
 * 某一台成员的服务器下拉里，哪些服务器已被别处占用。
 *
 * - 其它跳占用 → 后端 `chain.duplicate_server`；
 * - 同一跳的其它成员占用 → 后端 `chain.duplicate_group_member`；
 * - 当前成员自己选中的那台**不算**占用（否则下拉里看不到当前值）；
 * - 空 `server_id`（还没选）不参与计算。
 *
 * 返回 `server_id → 占用位置`，同一台服务器以靠前的跳为准（原因更准确）。
 * 调用方只把这些项渲染成 `disabled`，不从列表里删除，避免布局跳动。
 */
export function serverUsagesElsewhere(
  groups: readonly ChainGroupLike[],
  groupIndex: number,
  memberIndex: number,
): Map<string, ChainServerUsage> {
  const usages = new Map<string, ChainServerUsage>();

  // 先扫其它跳：同一台服务器同时出现在前跳和同跳成员里时，
  // 「已在第 N 跳」比「已在第 N 跳第 M 台」更能解释冲突来源。
  groups.forEach((group, index) => {
    if (index === groupIndex) return;
    group.members.forEach((member, position) => {
      const id = member.server_id;
      if (!id || usages.has(id)) return;
      usages.set(id, { groupIndex: index, memberIndex: position });
    });
  });

  // 再扫同一跳的其它成员：后端同样拒绝同组重复。
  groups[groupIndex]?.members.forEach((member, position) => {
    if (position === memberIndex) return;
    const id = member.server_id;
    if (!id || usages.has(id)) return;
    usages.set(id, { groupIndex, memberIndex: position });
  });

  return usages;
}

export interface ChainTemplateGroupLike {
  server_ids: readonly string[];
}

/**
 * 链模板某一跳的服务器多选里，哪些服务器已被其它跳占用。
 * 返回 `server_id → 最早占用它的跳下标`；本跳自己已选的不算占用，
 * 否则用户无法取消勾选。
 */
export function templateServerUsagesElsewhere(
  groups: readonly ChainTemplateGroupLike[],
  groupIndex: number,
): Map<string, number> {
  const usages = new Map<string, number>();
  groups.forEach((group, index) => {
    if (index === groupIndex) return;
    for (const raw of group.server_ids) {
      const id = raw.trim();
      if (!id || usages.has(id)) continue;
      usages.set(id, index);
    }
  });
  return usages;
}

export type ChainTemplateGroupIssue =
  | {
      kind: "member_duplicate";
      groupIndex: number;
    }
  | {
      kind: "server_duplicate";
      groupIndex: number;
      firstGroupIndex: number;
    };

/**
 * 链模板的重复服务器规则：同一跳内不重复（`chain.duplicate_group_member`）、
 * 跨跳不重复（`chain.duplicate_server`）。纯函数，提交前做防御性校验，
 * 模板多选已经置灰的服务器正常不会走进来。
 */
export function collectTemplateGroupIssues(
  groups: readonly ChainTemplateGroupLike[],
): ChainTemplateGroupIssue[] {
  const issues: ChainTemplateGroupIssue[] = [];
  const seenInTemplate = new Map<string, number>();
  // 文案只点名「哪一跳」，同一跳的重复只报一次。
  const reportedMemberDuplicate = new Set<number>();
  const reportedServerDuplicate = new Set<number>();

  groups.forEach((group, groupIndex) => {
    const seenInGroup = new Set<string>();
    for (const raw of group.server_ids) {
      const id = raw.trim();
      if (!id) continue;

      if (seenInGroup.has(id)) {
        if (!reportedMemberDuplicate.has(groupIndex)) {
          reportedMemberDuplicate.add(groupIndex);
          issues.push({ kind: "member_duplicate", groupIndex });
        }
        continue;
      }
      seenInGroup.add(id);

      const firstGroupIndex = seenInTemplate.get(id);
      if (firstGroupIndex !== undefined) {
        if (!reportedServerDuplicate.has(groupIndex)) {
          reportedServerDuplicate.add(groupIndex);
          issues.push({
            kind: "server_duplicate",
            groupIndex,
            firstGroupIndex,
          });
        }
      } else {
        seenInTemplate.set(id, groupIndex);
      }
    }
  });

  return issues;
}

/** 旧逻辑：已判定降级的跳；列表用它标注坏在哪一跳。 */
export function degradedHops<T extends ChainHopSnapshot>(
  hops: readonly T[],
): T[] {
  return orderHops(hops).filter((hop) => Boolean(hop.degraded));
}

/** 成员的展示地址：服务器名:监听端口。 */
export function formatMemberEndpoint(member: {
  server_name: string;
  listen_port: number;
}): string {
  return `${member.server_name.trim()}:${member.listen_port}`;
}

/** 每跳的展示地址：服务器名:监听端口（旧 `hops` 兼容逻辑）。 */
export function formatHopEndpoint(hop: {
  server_name: string;
  listen_port: number;
}): string {
  return formatMemberEndpoint(hop);
}
