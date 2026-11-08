/**
 * 探针公开页的纯逻辑：状态点、百分比与可用率色阶。
 *
 * 这里不依赖 React / DOM / i18n，方便用 `node --test` 直接覆盖边界；
 * 页面只负责把返回值映射成 token 与文案。
 */

/** 卡片右上角的状态：离线优先于「异常」，因为离线时 Xray 字段本就不可信。 */
export type ServerState = "online" | "offline" | "abnormal";

/** 工具栏的状态标签；`all` 是未筛选。 */
export type StatusFilter = "all" | "online" | "offline" | "abnormal";

/** 公开页的两种版式。 */
export type StatusView = "grid" | "list";

/** 视图选择存这个键；与主题、语言一样只属于本页。 */
export const STATUS_VIEW_STORAGE_KEY = "pierwave.status.view";

/** 没有存过、或存的值不认识时的默认版式。 */
export const DEFAULT_STATUS_VIEW: StatusView = "grid";

/** 可用率迷你条的色阶；`unknown` 表示该小时没有采样。 */
export type AvailabilityTone = "ok" | "warn" | "down" | "unknown";

export function serverState(server: {
  online: boolean;
  xray_running: boolean | null;
}): ServerState {
  if (!server.online) return "offline";
  return server.xray_running === false ? "abnormal" : "online";
}

/** 状态对应的 i18n key；卡片、列表和汇总共用一份映射。 */
export function statusLabelKey(state: ServerState): string {
  switch (state) {
    case "online":
      return "publicStatus.server.online";
    case "offline":
      return "publicStatus.server.offline";
    case "abnormal":
      return "publicStatus.server.abnormal";
  }
}

/**
 * `null` / 非有限值都是「没有数据」。
 * 99% 以上算正常；一半以上算部分离线；其余算离线。
 */
export function availabilityTone(
  ratio: number | null | undefined,
): AvailabilityTone {
  if (
    ratio === null ||
    ratio === undefined ||
    !Number.isFinite(ratio)
  ) {
    return "unknown";
  }
  if (ratio >= 0.99) return "ok";
  if (ratio >= 0.5) return "warn";
  return "down";
}

/** 0..1 → 0..100 的整数百分比；没有数据返回 null。 */
export function availabilityPercent(
  ratio: number | null | undefined,
): number | null {
  if (
    ratio === null ||
    ratio === undefined ||
    !Number.isFinite(ratio)
  ) {
    return null;
  }
  return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
}

/** 24 个桶里至少有一个采样，才画迷你条；全是 null 时整条显示空态。 */
export function hasSamples(
  buckets: readonly (unknown | null | undefined)[],
): boolean {
  return buckets.some((bucket) => bucket !== null && bucket !== undefined);
}

/**
 * 已用 / 总量 → 0..100；任一为 null、总量非正数或非有限值时返回 null。
 * 结果夹在 0..100，避免脏数据把进度条画到卡片外。
 */
export function resourcePercent(
  used: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (
    used === null ||
    used === undefined ||
    total === null ||
    total === undefined ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/** 一段服务器数据里够用来判断状态的字段。 */
type StatusFields = { online: boolean; xray_running: boolean | null };

/** 状态标签与一台服务器是否匹配；`all` 永远匹配。 */
export function matchesStatusFilter(
  server: StatusFields,
  filter: StatusFilter,
): boolean {
  return filter === "all" || serverState(server) === filter;
}

/**
 * 搜索只按名称做子串匹配，大小写与首尾空格都不敏感。
 * 空查询（或只有空格）匹配全部，避免搜索框里一个空格就把整页清空。
 */
export function matchesServerQuery(
  server: { name: string },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || server.name.toLowerCase().includes(needle);
}

/** 先按搜索、再按状态标签过滤；两个条件互不知道对方。 */
export function filterPublicServers<
  T extends StatusFields & { name: string },
>(
  servers: readonly T[],
  filter: StatusFilter,
  query: string,
): T[] {
  return servers.filter(
    (server) =>
      matchesServerQuery(server, query) &&
      matchesStatusFilter(server, filter),
  );
}

/**
 * 每个状态标签下的数量。搜索时由调用方传入已经按关键字筛过的列表，
 * 让标签上的数字与点下去看到的结果一致。
 */
export function publicServerCounts(
  servers: readonly StatusFields[],
): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = {
    all: servers.length,
    online: 0,
    offline: 0,
    abnormal: 0,
  };
  for (const server of servers) counts[serverState(server)] += 1;
  return counts;
}

/** 只认 grid / list；其它任何值（含 null）都不是合法选择。 */
export function parseStatusView(
  value: string | null | undefined,
): StatusView | null {
  return value === "grid" || value === "list" ? value : null;
}

/**
 * 从 localStorage 读视图。隐私模式或存储被禁用时读取会抛错，
 * 这里静默回落到默认值，页面永远能画出来。
 */
export function loadStatusView(
  storage: { getItem(key: string): string | null } | null | undefined,
): StatusView {
  try {
    return (
      parseStatusView(storage?.getItem(STATUS_VIEW_STORAGE_KEY)) ??
      DEFAULT_STATUS_VIEW
    );
  } catch {
    return DEFAULT_STATUS_VIEW;
  }
}

/** 写入视图选择；写失败不阻断切换（只是下次打开回到默认）。 */
export function persistStatusView(
  storage: { setItem(key: string, value: string): void } | null | undefined,
  view: StatusView,
): void {
  try {
    storage?.setItem(STATUS_VIEW_STORAGE_KEY, view);
  } catch {
    // ignore storage access errors
  }
}

/**
 * `/status` 与 `/status/` 是公开路由，必须在 `useMe` 之前放行；
 * `/status/xxx` 不在白名单里，仍走登录守卫。
 */
export function isPublicStatusPath(pathname: string): boolean {
  return pathname === "/status" || pathname === "/status/";
}
