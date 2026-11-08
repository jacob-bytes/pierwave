/**
 * 线性多跳转发链的纯展示逻辑：不依赖 React / DOM，方便直接跑单元测试。
 *
 * 语义（与后端 `crates/master/src/routes/chains.rs` 对齐）：
 * - 链状态按「停用 → 降级 → 正常」判定；任一跳 degraded 即整链降级；
 * - 每跳的 `listening` 与 `target_ok` 是两件独立的事：
 *   端口绑上了（listening=true）不代表目标地址可达（target_ok）；
 * - `degraded` 由后端按「连续 2 次 target_ok=false」计算，前端不重复推导。
 */

export type ChainStatus = "disabled" | "degraded" | "ok";

/** 与后端 `chains::MIN_HOPS` / `MAX_HOPS` 保持一致。 */
export const CHAIN_MIN_HOPS = 1;
export const CHAIN_MAX_HOPS = 4;

/** 列表与展开区共用的跳快照；字段是 `ChainHop` 的结构子集。 */
export interface ChainHopSnapshot {
  seq: number;
  server_name: string;
  listen_port: number;
  listening: boolean | null;
  target_ok: boolean | null;
  degraded?: boolean;
  error?: string;
  updated_at?: number | null;
}

/**
 * 整链状态。停用优先于降级：停用后 Agent 不再监听，
 * 旧心跳里的失败计数不能继续把一条停用链标成「降级」。
 */
export function chainStatus(
  enabled: boolean | number | undefined,
  degraded: boolean | number | undefined,
): ChainStatus {
  if (!enabled) return "disabled";
  return degraded ? "degraded" : "ok";
}

export type HopListeningState = "listening" | "failed" | "unreported";

/** `null` = Agent 未上报，并不等于监听失败。 */
export function hopListeningState(
  listening: boolean | null | undefined,
): HopListeningState {
  if (listening === null || listening === undefined) return "unreported";
  return listening ? "listening" : "failed";
}

export type HopTargetState = "reachable" | "unreachable" | "unprobed";

/** `null` = 尚未探测，不能当成「目标可达」。 */
export function hopTargetState(
  targetOk: boolean | null | undefined,
): HopTargetState {
  if (targetOk === null || targetOk === undefined) return "unprobed";
  return targetOk ? "reachable" : "unreachable";
}

/** 按 seq 升序复制：后端已排序，但前端不依赖响应顺序。 */
export function orderHops<T extends { seq: number }>(hops: readonly T[]): T[] {
  return [...hops].sort((a, b) => a.seq - b.seq);
}

/** 入口 = 第一跳；空链返回 null（后端不允许，但旧数据可能为空）。 */
export function entryHop<T extends { seq: number }>(
  hops: readonly T[],
): T | null {
  return orderHops(hops)[0] ?? null;
}

/** 已判定降级的跳；列表用它把「哪一跳坏了」直接写在状态副行里。 */
export function degradedHops<T extends ChainHopSnapshot>(
  hops: readonly T[],
): T[] {
  return orderHops(hops).filter((hop) => Boolean(hop.degraded));
}

/** 每跳的展示地址：服务器名:监听端口。 */
export function formatHopEndpoint(hop: {
  server_name: string;
  listen_port: number;
}): string {
  return `${hop.server_name.trim()}:${hop.listen_port}`;
}
