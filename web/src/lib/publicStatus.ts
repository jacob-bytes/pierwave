/**
 * 探针公开页的纯逻辑：状态点、百分比与可用率色阶。
 *
 * 这里不依赖 React / DOM / i18n，方便用 `node --test` 直接覆盖边界；
 * 页面只负责把返回值映射成 token 与文案。
 */

import { normalizeGroupName } from "./serverGroups.ts";

/** 卡片右上角的状态：离线优先于「异常」，因为离线时 Xray 字段本就不可信。 */
export type ServerState = "online" | "offline" | "abnormal";

/** 工具栏的状态标签；`all` 是未筛选。 */
export type StatusFilter = "all" | "online" | "offline" | "abnormal";

/**
 * 分组筛选：`null` = 全部节点；[`UNGROUPED_GROUP_KEY`] = 未分组；
 * 其它值是已经归一化过的分组名（非空、去首尾空白）。
 */
export type StatusGroupFilter = string | null;

/** 「未分组」在筛选状态里的键；分组名归一化后不可能为空，所以不冲突。 */
export const UNGROUPED_GROUP_KEY = "";

/** 分组标签行里的一项；`name = null` 是未分组，永远排在最后。 */
export interface StatusGroupTab {
  name: string | null;
  count: number;
}

/** 公开页的两种版式。 */
export type StatusView = "grid" | "list";

/** 视图选择存这个键；与主题、语言一样只属于本页。 */
export const STATUS_VIEW_STORAGE_KEY = "pierwave.status.view";

/** 没有存过、或存的值不认识时的默认版式。 */
export const DEFAULT_STATUS_VIEW: StatusView = "grid";

/**
 * 页头「更新于」的新鲜窗口：2 分钟内算实时，之后数据点转 muted。
 *
 * 轮询本身是 30 秒一次；连续失败时页面仍挂着最后一次数据，时间戳超过
 * 两分钟就不该再被当成「刚刚」——参考实现同样只把新鲜数据画成实心点。
 */
export const STATUS_STALE_SECONDS = 2 * 60;

/**
 * 公开页数据是否已过期。
 *
 * `nowMs` 是浏览器时钟（毫秒），`generatedAtSeconds` 是主控下发的时间戳。
 * `nowMs <= 0` 是首帧还没读到时钟，未来时间戳是时钟偏差：两者都不能
 * 判定为过期，否则页面会在首帧或偏差下误报。
 */
export function isStatusStale(
  nowMs: number,
  generatedAtSeconds: number,
): boolean {
  if (nowMs <= 0 || !Number.isFinite(generatedAtSeconds)) return false;
  return nowMs / 1_000 - generatedAtSeconds >= STATUS_STALE_SECONDS;
}

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
 * 卡片副行：`{os_name} {os_version} · {virt} · {arch}`。
 *
 * 缺哪项就跳过哪项（空串、null、`virt = none` 都不占位），全缺返回 null，
 * 由调用方决定不渲染这一行 —— 绝不让 `undefined` / `null` 漏进界面。
 */
/**
 * 卡片副行：`发行版 版本 · 虚拟化`。
 *
 * **刻意不含架构**：架构 + Xray 状态 + 延迟放在同一行时会让 1440 下换行，
 * 而 arch 对看探针页的人价值很低（运维细节，不是"这台好不好"的信号）。
 */
export function serverSpecLine(server: {
  os_name?: string | null;
  os_version?: string | null;
  virt?: string | null;
}): string | null {
  const clean = (value: string | null | undefined) =>
    typeof value === "string" ? value.trim() : "";
  const os = [clean(server.os_name), clean(server.os_version)]
    .filter((part) => part.length > 0)
    .join(" ");
  const virt = clean(server.virt);
  const parts = [os, virt.toLowerCase() === "none" ? "" : virt].filter(
    (part) => part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
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

/**
 * 心跳上报的 RTT（毫秒）。null / undefined / 非有限值 / 负数都视为「没有数据」，
 * 页面据此整项隐藏；0 不特殊处理——后端已保证探测成功至少是 1。
 */
export function reportedLatency(
  latency_ms: number | null | undefined,
): number | null {
  if (
    latency_ms === null ||
    latency_ms === undefined ||
    !Number.isFinite(latency_ms) ||
    latency_ms < 0
  ) {
    return null;
  }
  return Math.round(latency_ms);
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

/**
 * 运行时长拆成天 / 时 / 分，供卡片的状态 pill 显示「141 天 1 小时」。
 *
 * 不足一分钟按 0 分钟算：向上取整会让刚启动的机器写成「1 分钟」，
 * 与下一次刷新前的真实值对不上。负数、NaN 与无穷大都是没有数据。
 */
export type UptimeParts = { days: number; hours: number; minutes: number };

export function uptimeParts(
  seconds: number | null | undefined,
): UptimeParts | null {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return null;
  }
  const totalMinutes = Math.floor(seconds / 60);
  return {
    days: Math.floor(totalMinutes / (60 * 24)),
    hours: Math.floor((totalMinutes % (60 * 24)) / 60),
    minutes: totalMinutes % 60,
  };
}

/**
 * 运行时长该用哪条文案：只显示到有意义的最高一级，但保留次一级。
 * 「141 天 1 小时」不会写成「141 天 0 小时」，「5 小时 0 分钟」也不会。
 */
export function uptimeLabelKey(parts: UptimeParts): string {
  if (parts.days > 0) {
    return parts.hours > 0
      ? "publicStatus.server.uptimeDaysHours"
      : "publicStatus.server.uptimeDays";
  }
  if (parts.hours > 0) {
    return parts.minutes > 0
      ? "publicStatus.server.uptimeHoursMinutes"
      : "publicStatus.server.uptimeHours";
  }
  if (parts.minutes > 0) return "publicStatus.server.uptimeMinutes";
  return "publicStatus.server.uptimeJustNow";
}

/**
 * 汇总卡里的「最忙节点」：在线且上报过 `load1` 的服务器里取最大的一台。
 *
 * 离线机器的负载是掉线前的残留，不参与评选；`load1` 为 null 或非有限值时
 * 同理。并列时保留列表里先出现的一台，避免刷新时名字来回跳。
 */
export function busiestServer<
  T extends { online: boolean; load1: number | null },
>(servers: readonly T[]): T | null {
  let top: T | null = null;
  let topLoad = Number.NEGATIVE_INFINITY;

  for (const server of servers) {
    if (!server.online) continue;
    const load = server.load1;
    if (load === null || !Number.isFinite(load)) continue;
    if (top === null || load > topLoad) {
      top = server;
      topLoad = load;
    }
  }

  return top;
}

/**
 * 所有服务器 24 小时可用率的均值；没有一台有采样时返回 null。
 *
 * 没有采样的服务器不进分母 —— 把「没数据」当成 0% 会把均值拉垮；
 * 越界的比例先夹到 0..1，脏数据不会让汇总出现 120%。
 */
export function averageUptime24h(
  servers: readonly { uptime_24h: number | null }[],
): number | null {
  let total = 0;
  let sampled = 0;

  for (const server of servers) {
    const ratio = server.uptime_24h;
    if (ratio === null || !Number.isFinite(ratio)) continue;
    total += Math.min(1, Math.max(0, ratio));
    sampled += 1;
  }

  return sampled === 0 ? null : total / sampled;
}

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

/**
 * 从服务器列表派生分组标签。
 *
 * - 只有至少一个**具名分组**时才返回标签；全部未分组返回空数组，
 *   页面据此不渲染整行（一个「全部节点 / 未分组」的切换没有意义）。
 * - 具名分组按名称升序，未分组固定最后，与 `groupServers` 一致。
 * - 计数是该组服务器数，不是在线数；同一列表里的空白差异会合并。
 */
export function statusGroupTabs(
  servers: readonly { group_name?: string | null }[],
): StatusGroupTab[] {
  const named = new Map<string, number>();
  let ungrouped = 0;

  for (const server of servers) {
    const name = normalizeGroupName(server.group_name);
    if (name === null) {
      ungrouped += 1;
    } else {
      named.set(name, (named.get(name) ?? 0) + 1);
    }
  }

  if (named.size === 0) return [];

  const tabs: StatusGroupTab[] = [...named.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, count]) => ({ name, count }));
  if (ungrouped > 0) tabs.push({ name: null, count: ungrouped });
  return tabs;
}

/** 一台服务器是否落在选中的分组里；`null`（全部）永远匹配。 */
export function matchesGroupFilter(
  server: { group_name?: string | null },
  group: StatusGroupFilter,
): boolean {
  if (group === null) return true;
  const name = normalizeGroupName(server.group_name) ?? UNGROUPED_GROUP_KEY;
  return name === group;
}

/** 先按搜索、再按状态标签过滤；两个条件互不知道对方。 */
export function filterPublicServers<
  T extends StatusFields & { name: string; group_name?: string | null },
>(
  servers: readonly T[],
  filter: StatusFilter,
  query: string,
  group: StatusGroupFilter = null,
): T[] {
  return servers.filter(
    (server) =>
      matchesServerQuery(server, query) &&
      matchesStatusFilter(server, filter) &&
      matchesGroupFilter(server, group),
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
