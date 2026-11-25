import { CartesianGrid } from "recharts";
import {
  CHART_GRID_DASH,
  CHART_GRID_OPACITY,
  CHART_GRID_STROKE,
} from "./chartTheme";

/**
 * 全站图表网格线的唯一实现：横向点线（`--border` + 低透明度）。
 *
 * 竖向网格线只在「链路时延趋势」这种需要按时间定位的多序列折线上保留；
 * 其余图表一律 `vertical={false}`，避免两种画法混在一起。
 */
export function ChartGrid({ vertical = false }: { vertical?: boolean }) {
  return (
    <CartesianGrid
      stroke={CHART_GRID_STROKE}
      strokeOpacity={CHART_GRID_OPACITY}
      strokeDasharray={CHART_GRID_DASH}
      vertical={vertical}
    />
  );
}
