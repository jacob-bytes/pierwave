/**
 * 概览级「服务器筛选」的纯逻辑：URL 参数、默认选择、分组与作用范围。
 *
 * 四个 tab（资源状态 / 流量趋势 / 成本开支 / 链路时延）共用同一份选中集合，
 * 选中集合只有一个来源：`?servers=id1,id2`。
 * - 参数缺失 → 默认选择（≤10 台全选；更多时取「有问题优先」的 8 台）；
 * - 参数为空串 → 明确的全选空集（用于空态，不能回落到默认值）；
 * - 参数里的服务器已被删除 → 只保留仍存在的；全部失效时回落到默认选择。
 *
 * 这里不碰 React / i18n / DOM，方便 `node:test` 直接覆盖边界。
 */
import type { Chain } from "./api.ts";

/** 默认全选的上限：不超过 10 台时没有理由只选一部分。 */
export const SCOPE_ALL_LIMIT = 10;

/** 超过上限时默认展示的服务器数量（有问题的优先）。 */
export const SCOPE_DEFAULT_LIMIT = 8;

/** 与服务器状态视图一致的「资源有问题」阈值，避免两处口径漂移。 */
export const SCOPE_LOAD_BAD = 4;
export const SCOPE_MEM_BAD = 0.9;
export const SCOPE_DISK_BAD = 0.9;

/** 只依赖筛选需要的字段，便于测试与旧后端缺字段时降级。 */
export interface ScopeServer {
  id: string;
  name: string;
  status?: "online" | "offline" | string;
  group_name?: string | null;
  load1?: number | null;
  mem_used?: number | null;
  mem_total?: number | null;
  disk_used?: number | null;
  disk_total?: number | null;
}

export type OverviewScopeMode = "all" | "group" | "custom";

/**
 * 解析 `?servers=`。
 *
 * - `null` = 参数不存在（用默认选择）；
 * - `[]` = 参数存在但为空（用户明确清空了选择）；
 * - 否则按逗号切分、trim、去重、丢弃空项，保留用户顺序。
 */
export function parseServerIdsParam(raw: string | null): string[] | null {
  if (raw === null) return null;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** 写回 URL 的参数值；空集合保留空串，以便和「参数缺失」区分。 */
export function serializeServerIds(ids: readonly string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    parts.push(id);
  }
  return parts.join(",");
}

function ratio(
  used: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (
    typeof used !== "number" ||
    typeof total !== "number" ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return used / total;
}

/**
 * 默认选择的排序键：离线 → 资源告警 → 其余。
 * 同组按名称排序，保证多次打开页面看到的是同一批服务器。
 */
function issueRank(server: ScopeServer): number {
  if (server.status === "offline") return 0;
  const load = typeof server.load1 === "number" ? server.load1 : null;
  const mem = ratio(server.mem_used, server.mem_total);
  const disk = ratio(server.disk_used, server.disk_total);
  if (
    (load !== null && load >= SCOPE_LOAD_BAD) ||
    (mem !== null && mem >= SCOPE_MEM_BAD) ||
    (disk !== null && disk >= SCOPE_DISK_BAD)
  ) {
    return 1;
  }
  return 2;
}

/**
 * 默认选择：≤10 台全选；更多时取「有问题优先」的 8 台。
 * 服务器顺序沿用列表顺序（服务端通常按名称 / 创建时间返回）。
 */
export function defaultOverviewSelection(
  servers: readonly ScopeServer[],
  limit = SCOPE_DEFAULT_LIMIT,
): string[] {
  if (servers.length === 0) return [];
  if (servers.length <= SCOPE_ALL_LIMIT) return servers.map((server) => server.id);

  const max = Math.max(0, Math.floor(limit));
  if (max === 0) return [];
  return servers
    .map((server, index) => ({ server, index, rank: issueRank(server) }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.server.name.localeCompare(b.server.name) ||
        a.index - b.index,
    )
    .slice(0, max)
    .map((entry) => entry.server.id);
}

/**
 * 把 URL 参数解析成当前有效的选中集合。
 * 非空参数里所有 id 都失效（服务器被删 / 换了环境）时回落到默认选择，
 * 避免分享链接打开后是一片空态；明确传空串则保持空选择。
 */
export function resolveOverviewSelection(
  servers: readonly ScopeServer[],
  raw: string | null,
): string[] {
  const parsed = parseServerIdsParam(raw);
  if (parsed === null) return defaultOverviewSelection(servers);

  const available = new Set(servers.map((server) => server.id));
  const valid = parsed.filter((id) => available.has(id));
  if (parsed.length > 0 && valid.length === 0) {
    return defaultOverviewSelection(servers);
  }
  return valid;
}

/** 按服务器列表顺序过滤选中项，保证列表 / 图表顺序稳定。 */
export function filterServersByIds<T extends { id: string }>(
  servers: readonly T[],
  ids: readonly string[],
): T[] {
  const selected = new Set(ids);
  return servers.filter((server) => selected.has(server.id));
}

/** 选中集合是否真的缩小了范围（与「全选」等价时不算筛选）。 */
export function isOverviewScopeFiltered(
  servers: readonly ScopeServer[],
  ids: readonly string[],
): boolean {
  if (servers.length !== ids.length) return true;
  const selected = new Set(ids);
  return servers.some((server) => !selected.has(server.id));
}

export interface ScopeGroupRow {
  /** 稳定 key：`group:<name>` 或 `ungrouped`。 */
  key: string;
  /** 原始分组名；未分组为 null。 */
  name: string | null;
  ids: string[];
  count: number;
  ungrouped: boolean;
}

function groupKeyOf(server: ScopeServer): string {
  const name = (server.group_name ?? "").trim();
  return name === "" ? "" : name;
}

/**
 * 分组行：按分组名排序，未分组固定最后。
 * 旧后端不返回 `group_name` 时，所有服务器落在「未分组」一组。
 */
export function scopeGroupRows(
  servers: readonly ScopeServer[],
): ScopeGroupRow[] {
  const groups = new Map<string, string[]>();
  for (const server of servers) {
    const key = groupKeyOf(server);
    const ids = groups.get(key);
    if (ids) ids.push(server.id);
    else groups.set(key, [server.id]);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b);
    })
    .map(([name, ids]) => ({
      key: name === "" ? "ungrouped" : `group:${name}`,
      name: name === "" ? null : name,
      ids,
      count: ids.length,
      ungrouped: name === "",
    }));
}

/** 选中集合恰好等于某一组时返回该组的 key；用于把弹层切到「按分组」。 */
export function selectedScopeGroupKey(
  servers: readonly ScopeServer[],
  ids: readonly string[],
): string | null {
  if (ids.length === 0 || ids.length === servers.length) return null;
  const selected = new Set(ids);
  for (const group of scopeGroupRows(servers)) {
    if (group.count !== ids.length) continue;
    if (group.ids.every((id) => selected.has(id))) return group.key;
  }
  return null;
}

/** 从选中集合反推弹层的范围模式。 */
export function overviewSelectionMode(
  servers: readonly ScopeServer[],
  ids: readonly string[],
): OverviewScopeMode {
  if (servers.length > 0 && !isOverviewScopeFiltered(servers, ids)) {
    return "all";
  }
  if (selectedScopeGroupKey(servers, ids) !== null) return "group";
  return "custom";
}

/** 选中服务器里的在线台数。 */
export function selectedOnlineCount(
  servers: readonly ScopeServer[],
  ids: readonly string[],
): number {
  return filterServersByIds(servers, ids).filter(
    (server) => server.status === "online",
  ).length;
}

/**
 * 一条转发链是否「至少有一跳落在选中服务器」。
 * 只读 `groups[].members[].server_id`；旧后端缺字段按「不匹配」处理。
 */
export function chainMatchesScope(
  chain: Partial<Chain>,
  ids: readonly string[],
): boolean {
  if (ids.length === 0) return false;
  const selected = new Set(ids);
  for (const group of chain.groups ?? []) {
    for (const member of group.members ?? []) {
      if (selected.has(member.server_id)) return true;
    }
  }
  return false;
}

export function filterChainsByScope<T extends Partial<Chain>>(
  chains: readonly T[],
  ids: readonly string[],
): T[] {
  return chains.filter((chain) => chainMatchesScope(chain, ids));
}
