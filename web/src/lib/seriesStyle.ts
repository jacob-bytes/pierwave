/**
 * 多序列折线的视觉映射（链级趋势 / 逐段趋势共用）。
 *
 * 约定：
 * - 前 4 条固定用 `--series-1..4`，**第 2 条起始终带线型**；
 * - 超过 4 条时颜色与线型按 4 循环，再用一档不透明度阶梯区分，
 *   最低不低于 [`MIN_SERIES_OPACITY`]（0.55）；
 * - 颜色全部来自 CSS 变量，亮色 / 深色主题各自维护对比度。
 *
 * 纯函数，方便 `node:test` 直接覆盖。
 */

/** 颜色 token 数：`--series-1` … `--series-4`。 */
export const SERIES_TOKEN_COUNT = 4;

/** 第 2 条起的线型；第 5 条起继续轮换后两种，避免回到实线。 */
export const SERIES_DASH_PATTERNS = [
  "7 4",
  "2 3",
  "10 3 2 3",
  "5 3 1 3",
  "1 3",
  "12 4",
] as const;

/** 超过 4 条时的最低不透明度。 */
export const MIN_SERIES_OPACITY = 0.55;

export interface SeriesVisual {
  color: string;
  opacity: number;
  dash?: string;
}

/**
 * `index` 是序列在**完整序列列表**里的稳定下标（不是当前可见序列的下标），
 * 这样图例勾选 / 取消勾选不会让线的颜色跳动。
 */
export function seriesVisual(index: number): SeriesVisual {
  const safe = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  const slot = safe % SERIES_TOKEN_COUNT;
  const tier = Math.floor(safe / SERIES_TOKEN_COUNT);
  const opacity = Math.max(MIN_SERIES_OPACITY, 1 - tier * 0.15);
  const dash =
    safe === 0
      ? undefined
      : SERIES_DASH_PATTERNS[(safe - 1) % SERIES_DASH_PATTERNS.length];
  return {
    color: `var(--series-${slot + 1})`,
    opacity,
    dash,
  };
}
