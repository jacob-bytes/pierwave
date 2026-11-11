/**
 * 概览页聚合接口的纯逻辑：图表数据、协议占比、告警可见性与 Top 5。
 *
 * 这里不碰 React / 网络，组件只负责把结果画出来；边界值（空数组、0、
 * NaN）都在这里归一化，避免分母为零或把 NaN 传进 recharts。
 */
import type {
  OverviewChains,
  OverviewProtocol,
  OverviewTopItem,
} from "./api";

const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

/** 累计曲线的坐标单位：不足 1 TiB 用 GB，否则用 TB。 */
export type CumulativeUnit = "GB" | "TB";

interface TrafficPoint {
  uplink: number;
  downlink: number;
}

function bytes(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * 把逐日上下行流量换算成前缀和，返回新数组（不改调用方数据）。
 *
 * 只有 1 个点时仍会算出累计值，但图表会自行跳过曲线：单点画不出趋势。
 */
export function cumulativeSeries<T extends TrafficPoint>(
  series: readonly T[],
): (T & { cumulative: number })[] {
  let running = 0;
  return series.map((point) => {
    running += bytes(point.downlink) + bytes(point.uplink);
    return { ...point, cumulative: running };
  });
}

/**
 * 占比百分比（0–100）。
 *
 * 总数非正、流量非正或任一值非有限数时返回 0：协议卡把 0% 画成空条，
 * 不显示 NaN / Infinity。超过总数时按 100% 封顶，防止异常数据撑破卡片。
 */
export function formatShare(traffic: number, total: number): number {
  if (
    !Number.isFinite(traffic) ||
    !Number.isFinite(total) ||
    traffic <= 0 ||
    total <= 0
  ) {
    return 0;
  }
  return Math.min(100, (traffic / total) * 100);
}

function protocolTraffic(protocol: OverviewProtocol): number {
  return Number.isFinite(protocol.traffic_7d) ? protocol.traffic_7d : 0;
}

/**
 * 协议分布排序（后端契约已按 7 天流量降序，这里是防御性重排）：
 * - 按 `traffic_7d` 降序；`unknown`（已删除的节点）与真实协议一样参与排序；
 * - 0 流量的协议自然落到后面，但保留，UI 显示 0 B；
 * - 同流量保持后端返回顺序（稳定排序），输入数组不被修改。
 */
export function sortProtocols(
  protocols: readonly OverviewProtocol[],
): OverviewProtocol[] {
  return protocols
    .map((protocol, index) => ({ protocol, index }))
    .sort((a, b) => {
      const trafficA = protocolTraffic(a.protocol);
      const trafficB = protocolTraffic(b.protocol);
      const zeroA = trafficA <= 0 ? 1 : 0;
      const zeroB = trafficB <= 0 ? 1 : 0;
      if (zeroA !== zeroB) return zeroA - zeroB;

      return trafficB - trafficA || a.index - b.index;
    })
    .map(({ protocol }) => protocol);
}

export type ChainAlertKind = "degraded" | "handshake_failures";

export interface ChainAlert {
  kind: ChainAlertKind;
  count: number;
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * 告警卡追加的两行：计数为 0 时整行不渲染（与既有告警行一致）。
 * `blocked` / `forwards_failing` 不在本轮范围内，这里刻意不返回。
 */
export function visibleAlerts(
  chains: Partial<OverviewChains> | null | undefined,
): ChainAlert[] {
  if (!chains) return [];

  const alerts: ChainAlert[] = [];
  const degraded = count(chains.degraded);
  const handshakeFailures = count(chains.handshake_failures);

  if (degraded > 0) alerts.push({ kind: "degraded", count: degraded });
  if (handshakeFailures > 0) {
    alerts.push({ kind: "handshake_failures", count: handshakeFailures });
  }
  return alerts;
}

/**
 * Top 5：后端已按流量降序且最多 5 条，这里再防御一次——
 * 只留 `kind === "server"`、按 7 天流量降序、截断到 5 条。
 */
export function topServers(
  items: readonly OverviewTopItem[] | null | undefined,
  limit = 5,
): OverviewTopItem[] {
  if (!items?.length || limit <= 0) return [];

  return items
    .filter((item) => item.kind === "server")
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const trafficA = Number.isFinite(a.item.traffic_7d)
        ? a.item.traffic_7d
        : 0;
      const trafficB = Number.isFinite(b.item.traffic_7d)
        ? b.item.traffic_7d
        : 0;
      return trafficB - trafficA || a.index - b.index;
    })
    .slice(0, limit)
    .map(({ item }) => item);
}

/** 累计轴单位：只按累计总量选 GB / TB，不随每日波动跳单位。 */
export function cumulativeAxisUnit(maxBytes: number): CumulativeUnit {
  return Number.isFinite(maxBytes) && maxBytes >= TIB ? "TB" : "GB";
}

/**
 * 右轴刻度：数值按 GB / TB 缩放后去掉多余的 0。
 * 轴标签负责写单位，刻度本身只留数字，避免每个 tick 都重复单位。
 */
export function formatCumulativeTick(
  value: number,
  unit: CumulativeUnit,
): string {
  if (!Number.isFinite(value)) return "—";

  const scaled = value / (unit === "TB" ? TIB : GIB);
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return scaled.toFixed(digits).replace(/\.?0+$/, "") || "0";
}
