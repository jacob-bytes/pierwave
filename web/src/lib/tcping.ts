import type { TcpingResult } from "./api";

/**
 * 节点 TCPing 的行内状态机。
 *
 * 结果不落库、不轮询：`loading → success/failure` 只在用户点击时走一次，
 * 由页面把状态保留到下次刷新。重复点击在 loading 阶段被忽略，和后端
 * 「同一节点并发探测限 1」保持一致。
 */
export type TcpingStatus = "idle" | "loading" | "success" | "failure";

export interface TcpingState {
  status: TcpingStatus;
  latencyMs?: number;
  error?: string;
  address?: string;
  checkedAt?: number;
}

export const IDLE_TCPING: TcpingState = { status: "idle" };

export function isTcpingLoading(state: TcpingState): boolean {
  return state.status === "loading";
}

/** 开始探测：已在 loading 时保持原状态（重复点击/并发请求不再发一次）。 */
export function beginTcping(state: TcpingState): TcpingState {
  if (state.status === "loading") return state;
  return { status: "loading" };
}

/** 请求失败（网络/401/500）：这是请求错误，不是「不可达」。 */
export function failTcping(errorText: string): TcpingState {
  return { status: "failure", error: normalizeError(errorText) };
}

/** 收到后端结果：不可达是正常结果，同样进入 failure 展示。 */
export function settleTcping(result: TcpingResult): TcpingState {
  const address = typeof result.address === "string" ? result.address : undefined;
  const checkedAt =
    typeof result.checked_at === "number" && Number.isFinite(result.checked_at)
      ? result.checked_at
      : undefined;

  if (result.reachable) {
    return {
      status: "success",
      latencyMs: normalizeLatency(result.latency_ms),
      address,
      checkedAt,
    };
  }
  return {
    status: "failure",
    error: normalizeError(result.error),
    address,
    checkedAt,
  };
}

/** 延迟：负数/NaN/Infinity 一律归零，展示层不做四舍五入之外的猜测。 */
export function normalizeLatency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.round(value);
}

/** 成功文案：`42 ms`（两种语言一致，只有数字与单位）。 */
export function formatLatency(value: unknown): string {
  return `${normalizeLatency(value)} ms`;
}

function normalizeError(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

/**
 * 行内结果文案：成功 `42 ms`，失败 `不可达`；idle/loading 不占位。
 *
 * `unreachable` 由调用方从 i18n 传入，纯函数不依赖全局语言状态。
 */
export function tcpingLabel(
  state: TcpingState,
  unreachable: string,
): string | null {
  if (state.status === "success") return formatLatency(state.latencyMs);
  if (state.status === "failure") return unreachable;
  return null;
}

/** 悬停提示：成功显示实际探测的 `host:port`，失败显示原因（后端双语）。 */
export function tcpingHint(
  state: TcpingState,
  fallback: string,
): string | null {
  if (state.status === "success") return state.address ?? null;
  if (state.status === "failure") return state.error ?? fallback;
  return null;
}
