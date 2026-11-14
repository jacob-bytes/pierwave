/**
 * 概览页聚合接口的纯逻辑：图表数据、协议占比、告警可见性与 Top 5。
 *
 * 这里不碰 React / 网络，组件只负责把结果画出来；边界值（空数组、0、
 * NaN）都在这里归一化，避免分母为零或把 NaN 传进 recharts。
 */
import type {
  Chain,
  OverviewChains,
  OverviewProtocol,
  OverviewProtocolSeries,
  OverviewTopItem,
  OverviewTopUser,
} from "./api.ts";
import { entryMember, formatMemberEndpoint } from "./chains.ts";
import { lineDashArray, lineOpacity } from "./chainTopology.ts";

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

/** 协议趋势的保留桶：后端把第 5 个及以后的协议合并到 `other`。 */
export const OTHER_PROTOCOL = "other";

export interface ProtocolTrendLine {
  /** recharts 的 dataKey；协议名不直接当 key，避免特殊字符影响取数。 */
  key: string;
  protocol: string;
  /** 线型（实线 / 虚线 / 点线…），与延迟趋势图共用同一套。 */
  dash: string | undefined;
  opacity: number;
}

export interface ProtocolTrendPoint {
  day: string;
  [key: string]: string | number;
}

export interface ProtocolTrend {
  lines: ProtocolTrendLine[];
  rows: ProtocolTrendPoint[];
}

/**
 * 把协议趋势拍平成 recharts 需要的数据：一行一个自然日，一列一条协议。
 *
 * 后端已经按下行降序、补齐日期、最多 4 + other；这里再防御一次：
 * - 丢弃非有限值 / 非正的字节与空的协议名，避免画出全 0 的噪音线；
 * - 日期取并集升序，某条线缺某天按 0 计；
 * - 超过 `limit` 条时把尾部协议合并进 `other`，保证最多 `limit + 1` 条线。
 */
export function protocolTrend(
  series: readonly OverviewProtocolSeries[] | null | undefined,
  limit = 4,
): ProtocolTrend {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (!series?.length || max === 0) return { lines: [], rows: [] };

  const normalized = series
    .map((row) => {
      const protocol =
        typeof row.protocol === "string" ? row.protocol.trim() : "";
      const byDay = new Map<string, number>();
      for (const point of row.days ?? []) {
        const day = typeof point.day === "string" ? point.day : "";
        const bytes = Number.isFinite(point.bytes) ? point.bytes : 0;
        if (!day || bytes <= 0) continue;
        byDay.set(day, (byDay.get(day) ?? 0) + bytes);
      }
      let total = 0;
      for (const bytes of byDay.values()) total += bytes;
      return { protocol, byDay, total };
    })
    .filter((row) => row.protocol !== "" && row.total > 0)
    .sort(
      (a, b) => b.total - a.total || a.protocol.localeCompare(b.protocol),
    );
  if (normalized.length === 0) return { lines: [], rows: [] };

  const days = [
    ...new Set(normalized.flatMap((row) => [...row.byDay.keys()])),
  ].sort();
  if (days.length === 0) return { lines: [], rows: [] };

  const buckets = normalized.slice(0, max).map((row) => ({
    protocol: row.protocol,
    byDay: row.byDay,
  }));
  const overflow = normalized.slice(max);
  if (overflow.length > 0) {
    const other = new Map<string, number>();
    for (const row of overflow) {
      for (const [day, bytes] of row.byDay) {
        other.set(day, (other.get(day) ?? 0) + bytes);
      }
    }
    buckets.push({ protocol: OTHER_PROTOCOL, byDay: other });
  }

  const lines: ProtocolTrendLine[] = buckets.map((bucket, index) => ({
    key: `p${index}`,
    protocol: bucket.protocol,
    dash: lineDashArray(index),
    opacity: lineOpacity(index),
  }));

  const rows: ProtocolTrendPoint[] = days.map((day) => {
    const point: ProtocolTrendPoint = { day };
    buckets.forEach((bucket, index) => {
      point[`p${index}`] = bucket.byDay.get(day) ?? 0;
    });
    return point;
  });

  return { lines, rows };
}

/** 链路健康卡的四种状态：阻断（配置无法下发）优先于降级与停用。 */
export type ChainHealthStatus = "blocked" | "degraded" | "disabled" | "ok";

export interface ChainHealthRow {
  id: string;
  name: string;
  hops: number;
  status: ChainHealthStatus;
  /** 入口地址：`服务器名:监听端口`（与转发链列表一致）。 */
  entry: string;
  /** 阻断原因（后端原文）；只有 `blocked` 状态有值。 */
  reason: string | null;
}

const CHAIN_HEALTH_PRIORITY: Record<ChainHealthStatus, number> = {
  blocked: 0,
  degraded: 1,
  disabled: 2,
  ok: 3,
};

/**
 * 单条链的健康状态。
 *
 * 停用优先于阻断：链已停用就不会下发，此时 `blocked_reason` 只是配置备注，
 * 不能把一条没有在跑的链标成「阻断」（与转发链列表的 `chainStatus` 同顺序）。
 */
export function chainHealthStatus(
  chain: Pick<Chain, "enabled" | "degraded" | "blocked_reason">,
): ChainHealthStatus {
  if (!chain.enabled) return "disabled";
  if ((chain.blocked_reason ?? "").trim() !== "") return "blocked";
  if (chain.degraded) return "degraded";
  return "ok";
}

/**
 * 链路健康卡的行：按「有问题优先」排序（阻断 → 降级 → 停用 → 正常），
 * 同组保持后端顺序；最多 `limit` 条。入口取第一组的第一台成员。
 */
export function chainHealthRows(
  chains: readonly Chain[] | null | undefined,
  limit = 5,
): ChainHealthRow[] {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (!chains?.length || max === 0) return [];

  return chains
    .map((chain, index) => ({
      chain,
      index,
      status: chainHealthStatus(chain),
    }))
    .sort(
      (a, b) =>
        CHAIN_HEALTH_PRIORITY[a.status] - CHAIN_HEALTH_PRIORITY[b.status] ||
        a.index - b.index,
    )
    .slice(0, max)
    .map(({ chain, status }) => {
      const groups = Array.isArray(chain.groups) ? chain.groups : [];
      const entry = entryMember(groups);
      const reason = (chain.blocked_reason ?? "").trim();
      return {
        id: chain.id,
        name: (chain.name ?? "").trim() || "—",
        hops: groups.length,
        status,
        entry: entry ? formatMemberEndpoint(entry) : "—",
        reason: status === "blocked" && reason !== "" ? reason : null,
      };
    });
}

/**
 * Top 用户：后端已按 7 天下行+上行之和降序且最多 5 条；这里再防御一次
 * （丢掉没有流量 / 缺 id 的行，重排并截断）。
 */
export function topUsers(
  users: readonly OverviewTopUser[] | null | undefined,
  limit = 5,
): OverviewTopUser[] {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (!users?.length || max === 0) return [];

  return users
    .filter(
      (user) =>
        typeof user.user_id === "string" &&
        user.user_id.trim() !== "" &&
        typeof user.username === "string",
    )
    .map((user, index) => ({
      user,
      index,
      traffic: Number.isFinite(user.traffic_7d) ? user.traffic_7d : 0,
    }))
    .filter((entry) => entry.traffic > 0)
    .sort((a, b) => b.traffic - a.traffic || a.index - b.index)
    .slice(0, max)
    .map(({ user }) => user);
}
