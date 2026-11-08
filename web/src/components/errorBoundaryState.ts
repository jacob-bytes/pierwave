/**
 * ErrorBoundary 的状态推导（纯函数）。
 *
 * 单独放在 `.ts` 里是为了让 `node --test` 能直接 import：
 * React 的 class 组件无法在 node:test 里挂载，但「把任意抛出的值
 * 归一化成可展示的消息」这段逻辑可以独立测试。
 */
export type DerivedErrorState = {
  /** 归一化后的 Error；render 与 details 都从这里取信息。 */
  error: Error;
  /** 面向用户的错误消息（不包含堆栈）。 */
  message: string;
};

function describeUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Unknown error";
  }
  if (typeof error === "string") {
    return error || "Unknown error";
  }
  if (error === null || error === undefined) {
    return "Unknown error";
  }
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    // 循环引用等无法序列化的值，退回 String()。
  }
  return String(error);
}

/**
 * `getDerivedStateFromError(error)` 的唯一状态计算入口。
 * 无论子组件抛出 Error、字符串还是普通对象，都保证得到 `Error` 实例，
 * 这样兜底 UI 与测试都不用再做类型判断。
 */
export function deriveErrorState(error: unknown): DerivedErrorState {
  const message = describeUnknown(error);
  const normalized =
    error instanceof Error ? error : new Error(message);
  return { error: normalized, message };
}
