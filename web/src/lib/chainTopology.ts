/**
 * 链路拓扑的纯展示逻辑：不依赖 React / DOM，方便直接跑单元测试。
 *
 * 与后端 `crates/domain/src/chains.rs::path_mode` / `crates/master/src/routes/chains.rs`
 * 的链视图对齐：
 * - `latency_ms` 表示「上一跳 → 这台成员」，首组没有上一跳，恒为 null；
 * - `target_latency_ms` 只在最后一跳有值，表示「这台成员 → 链目标」；
 * - `last_seen_at` 是服务器最近一次心跳（ISO8601），不是成员转发状态；
 * - `target_error` 是最后一跳 TLS 探测的稳定短串，明文规则为 null；
 * - `null` 一律是「没有测到 / 未上报」，绝不能当成 0 ms 或「正常」；
 * - `path_mode = single` 时整条链只有一条路径，各段延迟才能相加；
 *   `multi` / `hash` 下没有唯一路径，不冒充一个确定的总延迟。
 */

import { formatByteValue } from "./bytes.ts";
import { TLS_ERROR_CODES } from "./chainTls.ts";

/** 延迟三档 + 无数据。`muted` 只用于 null，不参与阈值判定。 */
export type HopLatencyTone = "default" | "warning" | "destructive" | "muted";

/** `< 200 ms` 默认；`200–500 ms` warning；`> 500 ms` destructive。 */
export const LATENCY_WARNING_MS = 200;
export const LATENCY_DESTRUCTIVE_MS = 500;

/** 协议标记的三种合法值；未知值按后端读路径回落 `tcp`。 */
export const CHAIN_PROTOCOLS = ["tcp", "udp", "both"] as const;

export type ChainProtocol = (typeof CHAIN_PROTOCOLS)[number];

const PROTOCOL_LABELS: Record<ChainProtocol, string> = {
  tcp: "TCP",
  udp: "UDP",
  both: "TCP + UDP",
};

/** 后端可能返回 null / 旧字段 / 脏值；只接受有限非负数。 */
function finiteLatency(ms: number | null | undefined): number | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/**
 * 把实测延迟映射成展示色调。
 *
 * 边界按产品约定：199 默认、200–500 warning、501 起 destructive；
 * null / 非数字 / 负数都是「无数据」，用 muted 渲染 `—`。
 */
export function hopLatencyTone(
  ms: number | null | undefined,
): HopLatencyTone {
  const value = finiteLatency(ms);
  if (value === null) return "muted";
  if (value < LATENCY_WARNING_MS) return "default";
  if (value <= LATENCY_DESTRUCTIVE_MS) return "warning";
  return "destructive";
}

/**
 * 单段延迟的展示文本：`18 ms` / `—`。
 *
 * 箭头上的延迟即使缺失也必须占位，否则上下两行的箭头会塌。
 */
export function hopLatencyLabel(ms: number | null | undefined): string {
  const value = finiteLatency(ms);
  return value === null ? "—" : `${Math.round(value)} ms`;
}

/** 累计字节只接受有限非负数；null / 旧后端缺字段 / 脏值一律当作未知。 */
function knownBytes(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * 一跳卡片的流量文案：`↑ 120 MB ↓ 640 MB`；两侧都未知时返回 null。
 *
 * `null` 是「没有数据源」（realm / 旧 Agent），整项不渲染；`0` 是
 * 「确实累计了 0 字节」，仍要显示 `0 B`。两者不能混为一谈。
 */
export function formatHopTraffic(
  inB: number | null | undefined,
  outB: number | null | undefined,
): string | null {
  const parts: string[] = [];
  const inbound = knownBytes(inB);
  const outbound = knownBytes(outB);
  if (inbound !== null) parts.push(`↑ ${formatByteValue(inbound)}`);
  if (outbound !== null) parts.push(`↓ ${formatByteValue(outbound)}`);
  return parts.length === 0 ? null : parts.join(" ");
}

/** 一跳卡片上的双向累计流量；未知方向保持 null。 */
export interface HopTrafficTotals {
  inB: number | null;
  outB: number | null;
}

/**
 * 把组内成员的上行 / 下行累计字节相加。
 *
 * 某一方向只要有成员没上报，就返回 null：部分和会被读成「整跳只有这么多」，
 * 比不显示更糟。空组同样没有数据。
 */
export function sumHopTraffic(
  members: readonly {
    traffic_in?: number | null;
    traffic_out?: number | null;
  }[],
): HopTrafficTotals {
  function total(key: "traffic_in" | "traffic_out"): number | null {
    if (members.length === 0) return null;
    let sum = 0;
    for (const member of members) {
      const value = knownBytes(member[key]);
      if (value === null) return null;
      sum += value;
    }
    return sum;
  }

  return { inB: total("traffic_in"), outB: total("traffic_out") };
}

/** 后端延迟历史的一条样本；`seq` 是被探测的那一跳（入口组恒为 0 且无点）。 */
export interface LatencyHistoryPoint {
  ts: number;
  seq: number;
  server_id: string;
  latency_ms: number;
}

/** 图表只需要时间和延迟；`server_id` 只用于排障，不进入序列。 */
export interface LatencySeriesPoint {
  ts: number;
  latency_ms: number;
}

/**
 * 按 `seq` 分组延迟历史，每组按 `ts` 升序。
 *
 * 容忍脏值：时间 / 跳号不是有限数、延迟不是有限非负数的样本直接丢弃，
 * 避免把 NaN 或负延迟喂给 recharts。输入数组不被修改。
 */
export function groupLatencyBySeq(
  points: readonly LatencyHistoryPoint[],
): Map<number, LatencySeriesPoint[]> {
  const grouped = new Map<number, LatencySeriesPoint[]>();
  for (const point of points) {
    if (
      !Number.isFinite(point.ts) ||
      !Number.isFinite(point.seq) ||
      !Number.isFinite(point.latency_ms) ||
      point.latency_ms < 0
    ) {
      continue;
    }
    const series = grouped.get(point.seq) ?? [];
    series.push({ ts: point.ts, latency_ms: point.latency_ms });
    grouped.set(point.seq, series);
  }
  for (const series of grouped.values()) {
    series.sort((a, b) => a.ts - b.ts);
  }
  return grouped;
}

/** UTC+8 业务时区，与 `lib/time.ts` 的展示口径一致。 */
const UTC8_OFFSET_SECONDS = 8 * 60 * 60;

/**
 * 延迟图的时间轴标签。
 *
 * 6h / 24h 窗口显示 `HH:mm`，7 天窗口显示 `MM-DD`；与页面其它时间一样
 * 按 UTC+8 计算，不随浏览器时区变化。非法时间返回 `—`。
 */
export function bucketLabel(ts: number, hours: number): string {
  if (!Number.isFinite(ts)) return "—";
  const date = new Date((ts + UTC8_OFFSET_SECONDS) * 1_000);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours >= 24 * 7) {
    return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  }
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/**
 * 协议标记文案：`tcp → TCP`、`udp → UDP`、`both → TCP + UDP`。
 *
 * 未知 / 缺失按 `tcp` 展示，与 `lib/protocolMode.ts::normalizeProtocol`
 * 及后端读路径的回落一致，避免列表与拓扑出现两种说法。
 */
export function protocolBadge(protocol: unknown): string {
  const value =
    typeof protocol === "string" ? protocol.trim().toLowerCase() : "";
  if (value === "udp" || value === "both") return PROTOCOL_LABELS[value];
  return PROTOCOL_LABELS.tcp;
}

export type PathMode = "single" | "multi" | "hash";

/** 拓扑区 / 链名旁的路径徽标；multi 与未知值不显示徽标。 */
export type Translate = (key: string) => string;

/**
 * 路径形态徽标：single → 「当前路径」，hash → 「按来源分流」。
 *
 * multi 表示存在按策略选路的多成员组，没有唯一路径，返回 null；
 * 未知值同样返回 null，不猜测。
 */
export function pathModeBadge(
  pathMode: unknown,
  t: Translate,
): string | null {
  switch (pathMode) {
    case "single":
      return t("chains.detail.currentPath");
    case "hash":
      return t("chains.detail.sourceHashed");
    default:
      return null;
  }
}

/**
 * 拓扑区右上角的总延迟：`73 ms`；null / 无效值返回 null，调用方不渲染这一项。
 *
 * 只有后端在 `path_mode = single` 时才给出 `total_latency_ms`；
 * 前端不再自己求和，避免把多路径下的某一次探测冒充整条链。
 */
export function totalLatencyLabel(
  ms: number | null | undefined,
): string | null {
  const value = finiteLatency(ms);
  return value === null ? null : `${Math.round(value)} ms`;
}

/**
 * 成员行尾是否标「在用」。
 *
 * 只有 `multi` 且这个组确实有多台候选时才标：single 靠整条链高亮表达，
 * hash 由「按来源分流」徽标表达，single 组内的唯一成员也不需要再标一次。
 */
export function memberInUse(pathMode: unknown, groupSize: number): boolean {
  return (
    pathMode === "multi" &&
    Number.isFinite(groupSize) &&
    groupSize > 1
  );
}

/** 最后上报超过这个时长就不该再当作「实时」：5 分钟。 */
export const MEMBER_SEEN_STALE_MS = 5 * 60 * 1_000;

/** 最后上报的展示色调：新鲜 / 超过 5 分钟 / 无数据。 */
export type MemberSeenTone = "default" | "warning" | "muted";

/**
 * ISO8601 → Unix 秒；缺失、空白、非法日期都返回 null。
 *
 * `formatRelativeTime` 只接受 Unix 秒，而心跳字段是 ISO8601；
 * 这里只做格式转换，不参与任何「多久算旧」的判断。
 */
export function isoToUnixSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1_000);
}

/**
 * 成员最后上报的色调。
 *
 * `null` / 非法时间 = 未上报，用 muted；超过 5 分钟用 warning；
 * 其余（含时钟偏差导致的未来时间）都按新鲜处理。边界严格按「超过」：
 * 恰好 5 分钟仍是 default。
 */
export function memberSeenTone(
  lastSeenAt: string | null | undefined,
  now = Date.now(),
): MemberSeenTone {
  const seen = isoToUnixSeconds(lastSeenAt);
  if (seen === null) return "muted";
  return now - seen * 1_000 > MEMBER_SEEN_STALE_MS ? "warning" : "default";
}

/** 箭头加粗的两个阈值：`< 50 ms` 细、`50–200 ms` 中、`> 200 ms` 粗。 */
export const ARROW_THICK_MS = 50;
export const ARROW_WARNING_MS = 200;

/**
 * 箭头线宽（px）：`< 50 ms` 1、`50–200 ms` 1.5、`> 200 ms` 2。
 *
 * `null` / 非法值保持 1px，不把「没测到」画成一条粗线。
 */
export function arrowWidth(ms: number | null | undefined): number {
  const value = finiteLatency(ms);
  if (value === null || value < ARROW_THICK_MS) return 1;
  if (value <= ARROW_WARNING_MS) return 1.5;
  return 2;
}

/** `> 200 ms` 时箭头用 warning 色；null / 边界内仍是普通色。 */
export function arrowWarning(ms: number | null | undefined): boolean {
  const value = finiteLatency(ms);
  return value !== null && value > ARROW_WARNING_MS;
}

/**
 * 成员 `target_error` → `chains.tlsError.*`；未知 / 空值返回 null，界面不渲染。
 *
 * 六个短串的唯一定义仍在 `chainTls.ts`，这里只负责拓扑里的取键，
 * 避免同一份后端契约出现两份白名单。
 */
export function targetErrorKey(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const value = code.trim();
  return (TLS_ERROR_CODES as readonly string[]).includes(value)
    ? `chains.tlsError.${value}`
    : null;
}

/**
 * 延迟趋势的线型：按跳序循环取，最多 6 种。
 *
 * 为什么不用颜色：主题只有单一强调色，同色不同透明度在深色底上几乎分不出来，
 * 跳数一多就全靠猜；线型在黑白色盲下同样可辨。
 */
const LINE_DASHES = [
  undefined, // 实线
  "6 3",
  "2 3",
  "8 3 2 3",
  "12 4",
  "3 3",
] as const;

export function lineDashArray(index: number): string | undefined {
  if (!Number.isFinite(index) || index < 0) return undefined;
  return LINE_DASHES[Math.floor(index) % LINE_DASHES.length];
}
