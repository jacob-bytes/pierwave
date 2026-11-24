/**
 * 「资源状态」里「服务器 × 时间」卡的呈现方式：趋势 / 热力图。
 *
 * URL 是模式的唯一来源：`?view=server&mode=trend|heatmap`。默认的「趋势」不写
 * `mode` 参数（与 `?view=` / `?section=` 的默认值约定一致）；热力图必须用
 * `?mode=heatmap` 显式选择。切换用 `replace`，刷新 / 分享后保持。
 *
 * 这里只放纯函数，方便 `node:test` 直接覆盖 URL 行为；组件只负责渲染。
 */

export const SERVER_HEALTH_MODES = ["heatmap", "trend"] as const;

export type ServerHealthMode = (typeof SERVER_HEALTH_MODES)[number];

/** 默认趋势：第一眼先看在线率怎么走，热力图是逐台排查的第二视角。 */
export const DEFAULT_SERVER_HEALTH_MODE: ServerHealthMode = "trend";

/** 是否精确命中某个模式 id（大小写敏感，不 trim）。 */
export function isServerHealthMode(
  value: unknown,
): value is ServerHealthMode {
  return (
    typeof value === "string" &&
    (SERVER_HEALTH_MODES as readonly string[]).includes(value)
  );
}

/** 解析 `?mode=`；空值、拼错、旧链接都回落到趋势。 */
export function resolveServerHealthMode(value: unknown): ServerHealthMode {
  return isServerHealthMode(value) ? value : DEFAULT_SERVER_HEALTH_MODE;
}

/** 写回 URL 的参数值；默认模式返回 `null`，表示应当删除该参数。 */
export function serverHealthModeParam(
  mode: ServerHealthMode,
): string | null {
  return mode === DEFAULT_SERVER_HEALTH_MODE ? null : mode;
}

/**
 * 在现有查询参数上应用一个模式，返回新的 `URLSearchParams`（不改入参）。
 * `view` / `servers` / `range` 等其它参数原样保留。
 */
export function applyServerHealthMode(
  params: URLSearchParams,
  mode: ServerHealthMode,
): URLSearchParams {
  const next = new URLSearchParams(params);
  const param = serverHealthModeParam(mode);
  if (param === null) next.delete("mode");
  else next.set("mode", param);
  return next;
}
