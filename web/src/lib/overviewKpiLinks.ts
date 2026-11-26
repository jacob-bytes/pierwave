/**
 * 概览页顶部四张 KPI 卡的跳转目标与状态色。
 *
 * 跳转分两类：
 * - `?view=...` 是**相对搜索串**：留在概览页，只切换下方视图 / 筛选；
 * - `/...` 是**绝对路径**：离开概览页（异常服务器列表、用户列表）。
 *
 * 状态色只服务于卡里的异常计数和右上角图标块：没有异常时保持中性 muted，
 * 有异常时才用 destructive / warning（与 `docs/DESIGN.md` 的状态色约定一致）。
 * 这里不碰 React / DOM / i18n，方便 `node:test` 直接覆盖边界。
 */

/** KPI 卡的异常语义色；`neutral` 对应全站 muted。 */
export type KpiTone = "neutral" | "warning" | "destructive";

const KPI_TONE_TEXT_CLASS: Record<KpiTone, string> = {
  neutral: "text-muted-foreground",
  warning: "text-warning",
  destructive: "text-destructive",
};

const KPI_TONE_ICON_CLASS: Record<KpiTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

/** 异常数字的语义色；0 值走 neutral，保持灰色。 */
export function kpiToneTextClass(tone: KpiTone): string {
  return KPI_TONE_TEXT_CLASS[tone];
}

/** 图标块的语义色；无异常时是中性 muted 背景。 */
export function kpiToneIconClass(tone: KpiTone): string {
  return KPI_TONE_ICON_CLASS[tone];
}

/**
 * 「在线服务器」卡：
 * - 有离线 → 去服务器列表并只看异常；
 * - 全部在线 → 留在概览的服务器状态视图。
 */
export function onlineServersKpiLink(offline: number): string {
  return offline > 0 ? "/servers?only=abnormal" : "?view=server";
}

/** 「在线服务器」卡的状态色：只有离线数 > 0 才是错误色。 */
export function onlineServersKpiTone(offline: number): KpiTone {
  return offline > 0 ? "destructive" : "neutral";
}

/**
 * 「转发链」卡：阻断优先于降级，两者都为 0 时只打开转发链列表。
 * 用 `section=chains` 明确落在「转发链」子页，避免默认子页变化后跳到别处。
 */
export function forwardChainsKpiLink(blocked: number, degraded: number): string {
  if (blocked > 0) return "?view=chain&section=chains&status=blocked";
  if (degraded > 0) return "?view=chain&section=chains&status=degraded";
  return "?view=chain&section=chains";
}

/** 「转发链」卡的状态色：阻断 destructive，仅降级 warning，都为 0 中性。 */
export function forwardChainsKpiTone(
  blocked: number,
  degraded: number,
): KpiTone {
  if (blocked > 0) return "destructive";
  if (degraded > 0) return "warning";
  return "neutral";
}

/** 「今日流量」卡：切到概览的流量视图。 */
export function todayTrafficKpiLink(): string {
  return "?view=traffic";
}

/** 「用户与套餐」卡：这是全局口径，直接去用户列表。 */
export function usersKpiLink(): string {
  return "/users";
}

/**
 * 把成功刷新的时间戳格式化成 24 小时制 `HH:MM`。
 *
 * - `updatedAt` 为 0 / 非法值（还没有成功刷新）时返回 `—`；
 * - `timeZone` 只给测试用，页面始终用浏览器本地时区；
 * - 固定 `hourCycle: "h23"`，不跟着语言在 12 / 24 小时制之间跳。
 */
export function formatUpdatedClock(
  updatedAt: number,
  locale = "en-GB",
  timeZone?: string,
): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return "—";
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(updatedAt));
}
