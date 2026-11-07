/**
 * 探针公开页的纯逻辑：状态点、百分比与可用率色阶。
 *
 * 这里不依赖 React / DOM / i18n，方便用 `node --test` 直接覆盖边界；
 * 页面只负责把返回值映射成 token 与文案。
 */

/** 卡片右上角的状态：离线优先于「异常」，因为离线时 Xray 字段本就不可信。 */
export type ServerState = "online" | "offline" | "abnormal";

/** 可用率迷你条的色阶；`unknown` 表示该小时没有采样。 */
export type AvailabilityTone = "ok" | "warn" | "down" | "unknown";

export function serverState(server: {
  online: boolean;
  xray_running: boolean | null;
}): ServerState {
  if (!server.online) return "offline";
  return server.xray_running === false ? "abnormal" : "online";
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

/**
 * `/status` 与 `/status/` 是公开路由，必须在 `useMe` 之前放行；
 * `/status/xxx` 不在白名单里，仍走登录守卫。
 */
export function isPublicStatusPath(pathname: string): boolean {
  return pathname === "/status" || pathname === "/status/";
}
