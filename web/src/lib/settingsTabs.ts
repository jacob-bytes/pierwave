/**
 * 设置页的分组 tab：纯逻辑放在这里，方便单测（设置页是懒加载入口，
 * 不便在 node:test 里挂载 React）。
 *
 * URL 约定：`/settings?tab=security`；默认的「常规」不写参数，
 * 非法值（手改、旧链接、拼错）统一回落到第一个 tab。
 */

export const SETTINGS_TAB_IDS = [
  "general",
  "security",
  "alerts",
  "backup",
] as const;

export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number];

/** 非法值回落的目标：第一个 tab。 */
export const DEFAULT_SETTINGS_TAB: SettingsTabId = "general";

/** 是否为合法的 tab id（大小写敏感，不做 trim）。 */
export function isSettingsTabId(
  value: string | null | undefined,
): value is SettingsTabId {
  return (
    typeof value === "string" &&
    (SETTINGS_TAB_IDS as readonly string[]).includes(value)
  );
}

/** 解析 URL 里的 `?tab=`；空值或非法值都回落到第一个 tab。 */
export function resolveSettingsTab(
  value: string | null | undefined,
): SettingsTabId {
  return isSettingsTabId(value) ? value : DEFAULT_SETTINGS_TAB;
}

/** 写回 URL 的参数值；默认 tab 返回 null，表示应当删除该参数。 */
export function settingsTabParam(tab: SettingsTabId): string | null {
  return tab === DEFAULT_SETTINGS_TAB ? null : tab;
}
