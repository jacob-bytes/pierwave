/**
 * `/logs` 页的类型 tab：纯逻辑放在这里，方便单测（日志页是懒加载入口，
 * 不便在 node:test 里挂载 React）。
 *
 * URL 约定：`/logs?tab=events|audit`；缺省或非法值都回落到「系统事件」。
 * 两个 tab 都会写显式参数（不像设置页省略默认值）：旧书签 `/events`、
 * `/audit` 重定向到 `/logs?tab=events` / `/logs?tab=audit`，保持 URL 稳定。
 */

export const LOGS_TAB_IDS = ["events", "audit"] as const;

export type LogsTabId = (typeof LOGS_TAB_IDS)[number];

/** 非法值回落的目标：第一个 tab。 */
export const DEFAULT_LOGS_TAB: LogsTabId = "events";

/** 是否为合法的 tab id（大小写敏感，不做 trim）。 */
export function isLogsTabId(
  value: string | null | undefined,
): value is LogsTabId {
  return (
    typeof value === "string" &&
    (LOGS_TAB_IDS as readonly string[]).includes(value)
  );
}

/** 解析 URL 里的 `?tab=`；空值或非法值都回落到「系统事件」。 */
export function resolveLogsTab(
  value: string | null | undefined,
): LogsTabId {
  return isLogsTabId(value) ? value : DEFAULT_LOGS_TAB;
}

/** 写回 URL 的参数值；两个 tab 都保留显式 `?tab=`。 */
export function logsTabParam(tab: LogsTabId): string {
  return tab;
}
