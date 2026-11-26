/**
 * 服务器列表的筛选纯逻辑：分组 → 地区（`?country=`）→ 只看服务异常。
 *
 * 三个条件叠加，顺序固定；`?country=` 与 `?only=abnormal` 都写进 URL，
 * 刷新 / 分享后保持。这里不碰 React / 网络，页面只负责把结果映射成行与
 * 空态，测试可以直接覆盖叠加与非法参数。
 */
import { normalizeCountryCode } from "./country.ts";
import { normalizeGroupName } from "./serverGroups.ts";

/** 分组筛选：`all` 不筛选，`__ungrouped__` 只看未分组。 */
export const GROUP_FILTER_ALL = "all";
export const GROUP_FILTER_UNGROUPED = "__ungrouped__";

export interface ServerFilterRecord {
  group_name?: string | null;
  country_code?: string | null;
  status: string;
  xray_running?: boolean | null;
}

/**
 * 「服务异常」：Agent 在线但 Xray 没跑。离线是另一种状态，不算服务异常。
 * 与地图的 `abnormal` 使用同一口径。
 */
export function isServiceDown(
  server: Pick<ServerFilterRecord, "status" | "xray_running">,
): boolean {
  return server.status === "online" && server.xray_running === false;
}

/**
 * 解析 `?country=`：合法 ISO2 归一成两位大写，非法值（`ZZ`、`XK`、空串）
 * 一律按「没有地区筛选」处理，避免做一个用户看不到也清不掉的隐形筛选。
 */
export function resolveCountryFilter(
  raw: string | null | undefined,
): string | null {
  return normalizeCountryCode(raw ?? null);
}

/** 单台服务器是否命中分组筛选；`group` 应是已校验过的有效值。 */
export function serverMatchesGroup(
  server: Pick<ServerFilterRecord, "group_name">,
  group: string,
): boolean {
  if (group === GROUP_FILTER_ALL) return true;
  const name = normalizeGroupName(server.group_name);
  if (group === GROUP_FILTER_UNGROUPED) return name === null;
  return name === group;
}

export interface ServerListFilterOptions {
  /** 已校验的分组筛选值；省略 = 全部分组。 */
  group?: string;
  /** URL 里的 `?country=` 原值；内部会归一 / 校验。 */
  country?: string | null;
  /** URL 里是否有 `only=abnormal`。 */
  onlyAbnormal?: boolean;
}

export interface ServerListFilterResult<T> {
  /** 最终用于表格 / 卡片的行。 */
  items: T[];
  /** 分组 + 地区筛选后、异常筛选前的数量（用于区分「该地区没有服务器」）。 */
  scopedCount: number;
  /** 当前分组 + 地区范围内的服务异常台数。 */
  abnormalCount: number;
  /** URL 有 `only=abnormal` 且当前范围确实有异常时才真正生效。 */
  abnormalActive: boolean;
  /** 归一后的地区代码；null = 没有地区筛选。 */
  country: string | null;
}

/**
 * 依次应用分组、地区、异常三个筛选。
 *
 * `only=abnormal` 与首页地图 / 服务器页按钮的历史行为一致：范围内没有异常
 * 时按未筛选渲染，避免出现一个看不到、也无法取消的隐形筛选。地区筛选则
 * 保留空结果，由页面显示「该地区没有服务器」并给出清除入口。
 */
export function applyServerListFilters<T extends ServerFilterRecord>(
  servers: readonly T[],
  { group = GROUP_FILTER_ALL, country, onlyAbnormal = false }: ServerListFilterOptions = {},
): ServerListFilterResult<T> {
  const countryCode = resolveCountryFilter(country);
  const scoped: T[] = [];
  for (const server of servers) {
    if (!serverMatchesGroup(server, group)) continue;
    if (
      countryCode !== null &&
      normalizeCountryCode(server.country_code) !== countryCode
    ) {
      continue;
    }
    scoped.push(server);
  }

  const abnormalCount = scoped.filter(isServiceDown).length;
  const abnormalActive = onlyAbnormal && abnormalCount > 0;
  const items = abnormalActive ? scoped.filter(isServiceDown) : scoped;

  return {
    items,
    scopedCount: scoped.length,
    abnormalCount,
    abnormalActive,
    country: countryCode,
  };
}
