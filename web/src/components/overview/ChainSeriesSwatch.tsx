import type { LineVisual } from "@/lib/chainSeriesStyle";

/** 18×6 的线型样本；颜色 / 透明度 / 虚线全部来自 `lineVisual`。 */
export function LineSwatch({ visual }: { visual: LineVisual }) {
  return (
    <svg
      aria-hidden="true"
      width="18"
      height="6"
      viewBox="0 0 18 6"
      className="shrink-0"
    >
      <line
        x1="0"
        x2="18"
        y1="3"
        y2="3"
        stroke={visual.color}
        strokeOpacity={visual.opacity}
        strokeWidth="1.5"
        strokeDasharray={visual.dash}
        strokeLinecap="round"
      />
    </svg>
  );
}
