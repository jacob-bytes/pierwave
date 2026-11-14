/**
 * 用户端概览卡的状态色判定（纯逻辑，便于单测）。
 *
 * 阈值只表达「额度快用完了 / 快到期了」，与站内 `Meter` 的
 * 「占用越高越显眼」是同一套语义，不引入新色相：
 * - 剩余流量为 0（已用尽）→ `destructive`；
 * - 剩余流量低于总量的 20% → `warning`；
 * - 剩余天数 ≤ 7 天 → `warning`；
 * - 不限量 / 无到期 / 其余情况 → 默认前景色。
 */
export type OverviewTone = "default" | "warning" | "destructive";

/** 剩余额度的警示线：严格低于总量的 20%。 */
export const LOW_TRAFFIC_RATIO = 0.2;

/** 剩余天数的警示线：7 天（含边界）。 */
export const LOW_DAYS_LEFT = 7;

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 剩余流量的着色档位。
 *
 * `remainingBytes === null` 是后端的「不限量」，没有「用完」的概念，
 * 永远不染色；分母缺失或非正数（错误的套餐配置）时也只回默认色，
 * 不把脏数据画成告警。已用尽先于比例判断，保证 0 额度一定是 destructive。
 */
export function trafficTone(
  remainingBytes: number | null | undefined,
  limitBytes: number | null | undefined,
): OverviewTone {
  if (!isNumber(remainingBytes)) return "default";
  if (remainingBytes <= 0) return "destructive";
  if (!isNumber(limitBytes) || limitBytes <= 0) return "default";
  return remainingBytes / limitBytes < LOW_TRAFFIC_RATIO
    ? "warning"
    : "default";
}

/**
 * 剩余天数的着色档位：`null` 表示永不过期（后端口径），不染色；
 * 已过期时后端返回 0，仍按「≤ 7 天」的 warning 处理。
 */
export function daysTone(
  daysLeft: number | null | undefined,
): OverviewTone {
  if (!isNumber(daysLeft)) return "default";
  return daysLeft <= LOW_DAYS_LEFT ? "warning" : "default";
}

/** 数字本身的颜色类；默认留空，沿用卡片的前景色。 */
export const OVERVIEW_TEXT_CLASS: Record<OverviewTone, string> = {
  default: "",
  warning: "text-warning",
  destructive: "text-destructive",
};

/** 进度条填充色：与数字同一档，复用站内已有的 warning / destructive。 */
export const OVERVIEW_BAR_TONE: Record<
  OverviewTone,
  "primary" | "warning" | "destructive"
> = {
  default: "primary",
  warning: "warning",
  destructive: "destructive",
};
