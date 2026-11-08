import type { TrafficDay } from "./api";

/**
 * 今日相对昨日的计费流量变化（百分比）。
 *
 * 只使用后端真实返回的日趋势：最后一天是今天，倒数第二天是昨天。
 * 任意一天缺失、昨天为 0（无法算比例）或数据不是有限数时返回 null，
 * 调用方因此整项省略，而不是编一个 0%。
 */
export function trafficDayOverDay(
  days: TrafficDay[] | undefined,
): number | null {
  if (!days || days.length < 2) return null;

  const today = days[days.length - 1];
  const yesterday = days[days.length - 2];
  if (!today || !yesterday) return null;

  if (
    !Number.isFinite(today.weighted) ||
    !Number.isFinite(yesterday.weighted) ||
    yesterday.weighted <= 0
  ) {
    return null;
  }

  return ((today.weighted - yesterday.weighted) / yesterday.weighted) * 100;
}
