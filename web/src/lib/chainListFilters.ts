/**
 * 「链路时延」列表的状态筛选 / 关键词过滤 / 排序：纯逻辑，不依赖 React / DOM。
 *
 * 状态口径必须和列表状态列完全一致：一律走 `chainHealthState()`（停用 →
 * 新契约 `status.kind` → 旧配置的 blocked / degraded → 样本不足 → 正常），
 * 不在筛选器里另造一套判定，否则会出现「徽章写降级、筛正常却命中」。
 *
 * URL 是筛选的唯一来源：`?status=blocked&q=港日`。默认值（全部 / 空关键词）
 * 不写参数；离开链路时延 tab 时由 `applyOverviewView` 清掉这两个参数。
 */

import {
  chainHealthState,
  chainLatestSampleTs,
  chainRoutePreview,
  type ChainEndpoint,
  type ChainHealthChain,
  type ChainHealthConfig,
} from "./chainHealth.ts";

/** 状态筛选的全部取值；与 `ChainHealthState` 一一对应（停用单独一档）。 */
export const CHAIN_LIST_STATUS_FILTERS = [
  "all",
  "ok",
  "degraded",
  "blocked",
  "unknown",
  "insufficient",
  "disabled",
] as const;

export type ChainListStatusFilter = (typeof CHAIN_LIST_STATUS_FILTERS)[number];

/** 不带「全部」的状态值。 */
export type ChainListStatus = Exclude<ChainListStatusFilter, "all">;

export const DEFAULT_CHAIN_LIST_STATUS_FILTER: ChainListStatusFilter = "all";

/**
 * 下拉里的状态顺序：与徽章语义一致（正常 → 降级 → 阻断 → 未知 → 样本不足），
 * 停用只在真的有停用链时出现，避免默认多出第 7 档。
 */
export const CHAIN_LIST_STATUS_ORDER: readonly ChainListStatus[] = [
  "ok",
  "degraded",
  "blocked",
  "unknown",
  "insufficient",
  "disabled",
];

/** URL 参数名；`?status=` / `?q=`。 */
export const CHAIN_LIST_STATUS_PARAM = "status";
export const CHAIN_LIST_QUERY_PARAM = "q";

export function isChainListStatusFilter(
  value: unknown,
): value is ChainListStatusFilter {
  return (
    typeof value === "string" &&
    (CHAIN_LIST_STATUS_FILTERS as readonly string[]).includes(value)
  );
}

/** 解析 `?status=`；空值 / 拼错 / 旧链接都回落到「全部」。 */
export function resolveChainListStatusFilter(
  value: unknown,
): ChainListStatusFilter {
  return isChainListStatusFilter(value) ? value : DEFAULT_CHAIN_LIST_STATUS_FILTER;
}

/** 写回 URL 的值；默认「全部」返回 null，表示应删除该参数。 */
export function chainListStatusParam(
  status: ChainListStatusFilter,
): string | null {
  return status === DEFAULT_CHAIN_LIST_STATUS_FILTER ? null : status;
}

/** 关键词只 trim 首尾空白；大小写在匹配时统一处理，URL 保留用户输入。 */
export function normalizeChainListQuery(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 在现有查询参数上应用筛选，返回新的 `URLSearchParams`（不改入参）。
 * 其它参数（`view` / `section` / `servers` / `chain`）原样保留。
 */
export function applyChainListFilters(
  params: URLSearchParams,
  filters: { status: ChainListStatusFilter; q: string },
): URLSearchParams {
  const next = new URLSearchParams(params);
  const status = chainListStatusParam(filters.status);
  if (status === null) next.delete(CHAIN_LIST_STATUS_PARAM);
  else next.set(CHAIN_LIST_STATUS_PARAM, status);
  // 只有空白的关键词没有意义，按「没有搜索」处理并删掉参数。
  if (filters.q.trim() === "") next.delete(CHAIN_LIST_QUERY_PARAM);
  else next.set(CHAIN_LIST_QUERY_PARAM, filters.q);
  return next;
}

/** 单个链在筛选器里的状态；就是列表徽章的状态。 */
export function chainListStatusOf(
  chain: ChainHealthChain,
  config: ChainHealthConfig | null,
): ChainListStatus {
  return chainHealthState(chain, config);
}

/** 各状态数量；`all` 是总数，其余按徽章口径累计。 */
export type ChainListStatusCounts = Record<ChainListStatusFilter, number>;

export function chainListStatusCounts(
  chains: readonly ChainHealthChain[],
  configById: ReadonlyMap<string, ChainHealthConfig> | null = null,
): ChainListStatusCounts {
  const counts: ChainListStatusCounts = {
    all: 0,
    ok: 0,
    degraded: 0,
    blocked: 0,
    unknown: 0,
    insufficient: 0,
    disabled: 0,
  };
  for (const chain of chains) {
    counts.all += 1;
    const state = chainListStatusOf(chain, configById?.get(chain.id) ?? null);
    counts[state] += 1;
  }
  return counts;
}

/** 实际渲染的状态档位：停用只在有数量时出现。 */
export function visibleChainListStatuses(
  counts: ChainListStatusCounts,
): ChainListStatus[] {
  return CHAIN_LIST_STATUS_ORDER.filter(
    (status) => status !== "disabled" || counts.disabled > 0,
  );
}

/**
 * 关键词过滤的补充字段：契约里的链路对象（`chains[]`）才有的信息。
 * 旧主控的链路健康契约没有模板名 / 组名时，这些字段保持空。
 */
export interface ChainSearchExtra {
  templateName?: string | null;
  entryAddress?: string | null;
  groupNames?: readonly (string | null | undefined)[];
  serverNames?: readonly (string | null | undefined)[];
}

function pushText(
  parts: string[],
  ...values: readonly (string | null | undefined)[]
): void {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") parts.push(value);
  }
}

function endpointText(endpoint: ChainEndpoint | null): string[] {
  if (endpoint === null) return [];
  return [endpoint.address, endpoint.serverName, endpoint.ip].filter(
    (value): value is string => value !== null && value.trim() !== "",
  );
}

/**
 * 可搜索文本：链路名、起点 / 终点地址与服务器名、路由节点（含组成员）、
 * 逐段 from/to、契约的入口地址、模板名与链配置里的组名 / 成员名。
 *
 * 统一小写后用 `includes` 匹配；中文不受大小写影响，英文服务器名可以
 * 用任意大小写搜索。只读真实字段，不把 `—` / `…` 当数据。
 */
export function chainSearchHaystack(
  chain: ChainHealthChain,
  extra: ChainSearchExtra = {},
): string {
  const parts: string[] = [];
  pushText(parts, chain.name);
  for (const endpoint of [chain.entry, chain.exit]) {
    parts.push(...endpointText(endpoint));
  }
  for (const node of chain.nodes) {
    pushText(parts, node.name);
    for (const member of node.members) pushText(parts, member.name);
  }
  for (const segment of chain.segments) {
    pushText(parts, segment.from, segment.to);
  }
  // 路由预览会补上出口 / 省略号；省略号本身不参与匹配，由 includes 自然忽略。
  for (const label of chainRoutePreview(chain)) pushText(parts, label);
  pushText(parts, extra.templateName, extra.entryAddress);
  for (const name of extra.groupNames ?? []) pushText(parts, name);
  for (const name of extra.serverNames ?? []) pushText(parts, name);
  return parts.join("\n").toLowerCase();
}

/**
 * 关键词匹配：不区分大小写，空格分隔的多个词按 AND 叠加。
 * 空关键词匹配全部。
 */
export function chainMatchesQuery(
  chain: ChainHealthChain,
  query: string,
  extra: ChainSearchExtra = {},
): boolean {
  const needles = normalizeChainListQuery(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (needles.length === 0) return true;
  const haystack = chainSearchHaystack(chain, extra);
  return needles.every((needle) => haystack.includes(needle));
}

/** 排序维度：默认顺序 / P50 / 丢包 / 最近样本。 */
export const CHAIN_LIST_SORT_KEYS = [
  "default",
  "p50",
  "loss",
  "latest",
] as const;

export type ChainListSortKey = (typeof CHAIN_LIST_SORT_KEYS)[number];
export type ChainListSortDirection = "asc" | "desc";

export interface ChainListSort {
  key: ChainListSortKey;
  direction: ChainListSortDirection;
}

/** 默认按原有顺序（后端按创建时间返回）。 */
export const DEFAULT_CHAIN_LIST_SORT: ChainListSort = {
  key: "default",
  direction: "asc",
};

/** 点表头 / 选排序项时的初始方向：时延与丢包先看最小的，最近样本先看最新的。 */
export function chainListSortDefaultDirection(
  key: ChainListSortKey,
): ChainListSortDirection {
  return key === "latest" ? "desc" : "asc";
}

/** 点同一个维度切换升降序；切到「默认」总是回到原有顺序。 */
export function toggleChainListSort(
  current: ChainListSort,
  key: ChainListSortKey,
): ChainListSort {
  if (key === "default") return DEFAULT_CHAIN_LIST_SORT;
  if (current.key === key) {
    return {
      key,
      direction: current.direction === "asc" ? "desc" : "asc",
    };
  }
  return { key, direction: chainListSortDefaultDirection(key) };
}

/**
 * 可排序值：没有数据的一律排最后（无论升降序），不把 `—` 当成 0。
 * 相等时保持原有顺序（Array.prototype.sort 稳定）。
 */
function compareNullable(
  a: number | null,
  b: number | null,
  direction: ChainListSortDirection,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction === "asc" ? a - b : b - a;
}

function chainSortValue(
  chain: ChainHealthChain,
  key: Exclude<ChainListSortKey, "default">,
): number | null {
  if (key === "p50") return chain.latestP50;
  if (key === "loss") return chain.lossPct;
  return chainLatestSampleTs(chain);
}

export function sortChainList(
  chains: readonly ChainHealthChain[],
  sort: ChainListSort,
): ChainHealthChain[] {
  if (sort.key === "default") return [...chains];
  const key = sort.key;
  return [...chains].sort((a, b) =>
    compareNullable(chainSortValue(a, key), chainSortValue(b, key), sort.direction),
  );
}
