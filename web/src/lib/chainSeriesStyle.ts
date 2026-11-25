import { seriesVisual } from "./seriesStyle.ts";

export interface LineVisual {
  color: string;
  opacity: number;
  dash?: string;
}

/**
 * 正常序列用 `--series-1..4` + 线型；样本不足的图例项灰显。
 * 变慢不再换色相：颜色只负责区分序列，状态由「变慢」徽章与 tooltip 文案表达。
 *
 * 纯函数单独放 lib：图表与图例下拉共用同一套线型，组件文件只导出组件。
 */
export function lineVisual(index: number, muted = false): LineVisual {
  if (muted) {
    return { color: "var(--muted-foreground)", opacity: 0.55 };
  }
  return seriesVisual(index);
}
