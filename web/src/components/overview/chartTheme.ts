/**
 * 图表视觉常量的唯一来源：网格线、tooltip 外壳。
 *
 * 这个文件不 import recharts，供自绘 SVG（如链路迷你图）直接复用，
 * 避免每个图表各写一套 `strokeDasharray` / 透明度。
 */

/** 网格线用 `--border`，不写死颜色。 */
export const CHART_GRID_STROKE = "var(--border)";

/** 点线样式：2px 实 + 4px 空。 */
export const CHART_GRID_DASH = "2 4";

/** 网格线透明度：能定位数值，又不和数据线抢注意力。 */
export const CHART_GRID_OPACITY = 0.6;

/** 悬停参考线（竖向 1px）：与网格线区分开，但不遮挡数据。 */
export const CHART_CURSOR_STROKE = "var(--muted-foreground)";
export const CHART_CURSOR_OPACITY = 0.35;

/** recharts `<Tooltip cursor>` 的统一取值。 */
export const CHART_CURSOR = {
  stroke: CHART_CURSOR_STROKE,
  strokeOpacity: CHART_CURSOR_OPACITY,
} as const;
