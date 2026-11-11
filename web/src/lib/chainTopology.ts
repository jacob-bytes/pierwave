/**
 * 链路拓扑的纯展示逻辑：不依赖 React / DOM，方便直接跑单元测试。
 *
 * 与后端 `crates/domain/src/chains.rs::path_mode` / `crates/master/src/routes/chains.rs`
 * 的链视图对齐：
 * - `latency_ms` 表示「上一跳 → 这台成员」，首组没有上一跳，恒为 null；
 * - `target_latency_ms` 只在最后一跳有值，表示「这台成员 → 链目标」；
 * - `null` 一律是「没有测到」，绝不能当成 0 ms；
 * - `path_mode = single` 时整条链只有一条路径，各段延迟才能相加；
 *   `multi` / `hash` 下没有唯一路径，不冒充一个确定的总延迟。
 */

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
