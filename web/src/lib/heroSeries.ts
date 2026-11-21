/**
 * hero 三张迷你图的数据整理（纯逻辑，不依赖 React / DOM / i18n）。
 *
 * 数据来源分两类：
 * 1. **速率 / 延迟**：后端新字段 `series`（最近一小时的聚合序列）。旧后端没有
 *    这个字段，返回 `null`，页面显示「数据收集中」，不画 0 的平线；
 * 2. **24h 可用率**：不需要后端 —— 把每台服务器 `buckets_24h` 的 24 个 0–1
 *    比例按小时求平均，得到 24 个点。某小时所有机器都没有采样时，该点是
 *    `null`（断线），不是 0%。
 *
 * 数组对齐是一个容易写错的边界：契约保证 `t` / `rate_rx_bps` / `rate_tx_bps`
 * 等长，但旧后端或半截数据可能长短不一。这里以**最长的一条**为准，缺的位置
 * 补 `null` —— 既不丢时间轴，也不把缺位读成 0。
 */

import type { PublicStatusSeries } from "./api.ts";

/** `buckets_24h` 固定 24 格（与主控 `BUCKETS_24H` 一致）。 */
export const HERO_UPTIME_BUCKETS = 24;

/** 一个方向 / 一条线的数组，长度已经对齐；null = 该采样点没有数据。 */
export type NullableSeries = (number | null)[];

export interface HeroRateSeries {
  /** Unix 秒；时间戳缺失的位置为 null（tooltip 只显示数值）。 */
  ts: NullableSeries;
  rx: NullableSeries;
  tx: NullableSeries;
}

export interface HeroLineSeries {
  ts: NullableSeries;
  values: NullableSeries;
}

/** 非数组一律当成空；避免旧后端把字段写成 null 时整页崩掉。 */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 非负有限数才是有效读数；0 有效，负数和 NaN 是脏数据。 */
function reading(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** Unix 秒：非正数 / 非有限值都没有意义，是「没有时间戳」。 */
function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function hasReading(values: readonly (number | null)[]): boolean {
  return values.some((value) => value !== null);
}

/**
 * 速率序列：上下行两条线，共用同一个 y 轴。
 *
 * 整组缺失、或两个方向都没有一个有效读数时返回 `null` —— 调用方据此显示
 * 「数据收集中」。只有一侧有数据时仍返回，另一侧保持全 null（不画线）。
 */
export function heroRateSeries(
  series: PublicStatusSeries | null | undefined,
): HeroRateSeries | null {
  if (!series) return null;

  const rxIn = asArray(series.rate_rx_bps);
  const txIn = asArray(series.rate_tx_bps);
  if (rxIn.length === 0 && txIn.length === 0) return null;

  const tIn = asArray(series.t);
  const length = Math.max(rxIn.length, txIn.length, tIn.length);
  if (length === 0) return null;

  const rx = Array.from({ length }, (_, index) => reading(rxIn[index]));
  const tx = Array.from({ length }, (_, index) => reading(txIn[index]));
  if (!hasReading(rx) && !hasReading(tx)) return null;

  return {
    ts: Array.from({ length }, (_, index) => timestamp(tIn[index])),
    rx,
    tx,
  };
}

/**
 * 延迟序列：只取 `latency_ms` 一条线。
 *
 * 全为 null 时返回 `null`：没有采样不等于 0 ms，页面进空态。
 */
export function heroLatencySeries(
  series: PublicStatusSeries | null | undefined,
): HeroLineSeries | null {
  if (!series) return null;

  const latencyIn = asArray(series.latency_ms);
  if (latencyIn.length === 0) return null;

  const tIn = asArray(series.t);
  const length = Math.max(latencyIn.length, tIn.length);
  const values = Array.from({ length }, (_, index) =>
    reading(latencyIn[index]),
  );
  if (!hasReading(values)) return null;

  return {
    ts: Array.from({ length }, (_, index) => timestamp(tIn[index])),
    values,
  };
}

/** 24h 可用率图接受的服务器形状；`buckets_24h` 缺省时整台跳过。 */
export interface UptimeSeriesServer {
  buckets_24h?: readonly ({ ts: number; online_ratio: number } | null)[] | null;
}

/**
 * 24h 可用率的变化：逐小时对**有采样的服务器**求平均。
 *
 * - 某台机器该小时没有桶（null / 字段缺失 / 比例非数）→ 不进分母，
 *   不能当成 0% 把整体拉低；
 * - 所有机器该小时都没有采样 → 该点 null，折线断开；
 * - 比例先夹到 0..1，脏数据不会让图冲出画布；
 * - 时间戳取该小时第一台有采样的服务器（各机器的桶起点应当一致）。
 *
 * 返回值永远 24 个点，长度不随服务器数量变化。
 */
export function heroUptimeSeries(
  servers: readonly UptimeSeriesServer[],
): HeroLineSeries {
  const values: NullableSeries = Array.from(
    { length: HERO_UPTIME_BUCKETS },
    () => null,
  );
  const ts: NullableSeries = Array.from(
    { length: HERO_UPTIME_BUCKETS },
    () => null,
  );

  for (let index = 0; index < HERO_UPTIME_BUCKETS; index += 1) {
    let total = 0;
    let sampled = 0;
    let firstTs: number | null = null;

    for (const server of servers) {
      const buckets = asArray(server?.buckets_24h);
      const bucket = buckets[index];
      if (!bucket || typeof bucket !== "object") continue;

      const ratio = (bucket as { online_ratio?: unknown }).online_ratio;
      if (
        typeof ratio !== "number" ||
        !Number.isFinite(ratio)
      ) {
        continue;
      }

      total += Math.min(1, Math.max(0, ratio));
      sampled += 1;
      if (firstTs === null) {
        firstTs = timestamp((bucket as { ts?: unknown }).ts);
      }
    }

    if (sampled > 0) {
      values[index] = total / sampled;
      ts[index] = firstTs;
    }
  }

  return { ts, values };
}
