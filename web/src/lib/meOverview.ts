/**
 * 用户端概览卡的纯逻辑：状态色判定与右侧日均用量（便于单测）。
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

/** 概览右侧「近 N 天日均」用到的逐日流量形状（`TrafficDay` 的结构子集）。 */
export interface DailyTraffic {
  weighted: number;
}

/**
 * 近 N 天日均计费流量：窗口内总和 / 有数据的天数。
 *
 * 后端按「缺失日补 0」返回连续序列，所以 0 也是真实数据、必须计入分母；
 * 序列为空（还没加载或查询失败）时返回 `null`，由调用方隐藏该项，
 * 而不是把「没数据」画成 0。非有限值（脏数据）跳过，避免整项变成 NaN。
 */
export function dailyAverage(
  days: readonly DailyTraffic[] | null | undefined,
): number | null {
  if (!days || days.length === 0) return null;

  let sum = 0;
  let counted = 0;
  for (const day of days) {
    const value = day?.weighted;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    sum += value;
    counted += 1;
  }

  return counted === 0 ? null : sum / counted;
}

/**
 * 趋势窗口的「有没有采样」判定。
 *
 * 后端的 `/me/traffic` 会把窗口内缺数据的日期补 0，所以「查询成功」不等于
 * 「有采样」：一个全是 0 的窗口既可能是用户真的没用流量，也可能是 Agent
 * 从未上报。审计（U3）要求这种情况按「暂无采样」处理，显示 `—` 或
 * 「暂无采样」，而不是和真实用量混在一起画成 `0 B`。
 *
 * 判定：窗口非空，且至少一天有正的上下行 / 计费流量。任一天有值后，
 * 其余天的 0 就是真实 0，照常显示 `0 B`。
 */
export interface TrafficSampleDay {
  uplink?: number;
  downlink?: number;
  weighted?: number;
}

function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function hasTrafficSamples(
  days: readonly TrafficSampleDay[] | null | undefined,
): boolean {
  if (!days || days.length === 0) return false;
  return days.some(
    (day) => positive(day?.uplink) || positive(day?.downlink) || positive(day?.weighted),
  );
}

/**
 * 趋势窗口的计费总量：无采样时为 `null`（界面显示 `—`），有采样时求和。
 * 非有限值跳过，避免一行脏数据把整块指标变成 NaN。
 */
export function trafficWindowTotal(
  days: readonly TrafficSampleDay[] | null | undefined,
): number | null {
  if (!hasTrafficSamples(days)) return null;

  let sum = 0;
  for (const day of days ?? []) {
    const value = day?.weighted;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    sum += value;
  }
  return sum;
}

/** `/me/summary.packages` 里与概览卡相关的最小字段。 */
export interface OverviewPackageInstance {
  package_name: string;
  expires_at: number | null;
  /** 1..31 = 每月重置日；null = 该实例不自动重置。旧后端可能缺失。 */
  reset_day?: number | null;
}

/**
 * 概览卡主套餐的「重置日」。
 *
 * 顶层 `package`（`MePackageSummary`）只有名称 / 额度 / 到期时间，没有实例 id
 * 或 `reset_day`；`packages` 是同一份查询的实例明细，所以按「名称 + 到期时间」
 * 找到对应实例，多个匹配时取最后一张（与后端「最新的可用实例」口径一致）。
 *
 * 返回值三态：
 * - `number`：该实例每月在这一天重置；
 * - `null`：实例存在且明确不自动重置；
 * - `undefined`：旧后端缺少 `packages` / 匹配不到实例，调用方整项隐藏，
 *   不能把「不知道」画成「不重置」。
 */
export function planResetDay(
  plan: { name: string; expires_at: number | null } | null | undefined,
  packages: readonly OverviewPackageInstance[] | null | undefined,
): number | null | undefined {
  if (!plan || !packages?.length) return undefined;

  let matched: OverviewPackageInstance | undefined;
  for (const item of packages) {
    if (
      item?.package_name === plan.name &&
      (item.expires_at ?? null) === (plan.expires_at ?? null)
    ) {
      matched = item;
    }
  }
  if (!matched) return undefined;

  const resetDay = matched.reset_day;
  return typeof resetDay === "number" && Number.isFinite(resetDay)
    ? resetDay
    : null;
}
