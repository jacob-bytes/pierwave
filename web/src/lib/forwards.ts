/**
 * 端口转发的纯展示逻辑：不依赖 React / DOM，方便直接跑单元测试。
 *
 * 状态语义（顺序很重要）：
 * 1. 规则停用 → `disabled`：Agent 根本不会监听，不能拿旧心跳当结果；
 * 2. 没有 runtime → `unknown`：Agent 尚未上报，并不等于失败；
 * 3. `listening = true` → `listening`：只代表端口已在本机监听，
 *    **不代表目标地址可达**；
 * 4. `listening = false` → `failed`：展示 `runtime.error`。
 */

export interface ForwardRuntimeSnapshot {
  listening: boolean;
  error: string;
  updated_at: number;
}

export type ForwardStatus = "disabled" | "unknown" | "listening" | "failed";

export function forwardStatus(
  enabled: boolean | number | undefined,
  runtime: ForwardRuntimeSnapshot | null | undefined,
): ForwardStatus {
  if (!enabled) return "disabled";
  if (!runtime) return "unknown";
  return runtime.listening ? "listening" : "failed";
}

/** 失败原因：后端可能回空串，空白也按「没有原因」处理。 */
export function forwardRuntimeError(
  runtime: ForwardRuntimeSnapshot | null | undefined,
): string | null {
  const error = runtime?.error?.trim();
  return error ? error : null;
}

/**
 * 表格里的 `host:port`。
 *
 * IPv6 原样拼会得到 `::1:443` 这种有歧义的地址，所以裸 IPv6 补一层方括号；
 * 已经带方括号的保持原样。
 */
export function formatForwardTarget(host: string, port: number): string {
  const trimmed = host.trim();
  const bracketed = trimmed.startsWith("[") && trimmed.endsWith("]");
  const display = trimmed.includes(":") && !bracketed ? `[${trimmed}]` : trimmed;
  return `${display}:${port}`;
}
