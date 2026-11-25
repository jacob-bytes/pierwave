import {
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type {
  ChainAnomalyWindow,
  ChainHealthPoint,
  ChainSeriesWindow,
  ChainTimeTick,
} from "@/lib/chainHealth";
import {
  chainAnomalyWindows,
  chainPointX,
  chainSeriesMax,
  chainSeriesWindow,
  formatChainTime,
  formatMs,
} from "@/lib/chainHealth";
import { cn } from "@/lib/utils";
import {
  ChartTooltipHeading,
  ChartTooltipRow,
  ChartTooltipShell,
} from "./ChartTooltipShell";
import {
  CHART_GRID_DASH,
  CHART_GRID_OPACITY,
  CHART_GRID_STROKE,
} from "./chartTheme";
import { t, useI18n } from "@/i18n";

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 100;
const TOP_PAD = 4;
const BOTTOM_PAD = 4;

type Tone = "primary" | "warning";

function toneColor(tone: Tone): string {
  return tone === "warning" ? "var(--warning)" : "var(--primary)";
}

function usable(point: ChainHealthPoint | undefined): boolean {
  return Boolean(point && point.p50 !== null && point.samples > 0);
}

function linePath(
  points: readonly ChainHealthPoint[],
  xOf: (ts: number) => number,
  yOf: (value: number) => number,
  bucketSecs: number,
): string {
  const parts: string[] = [];
  let current: string[] = [];
  let previousTs: number | null = null;

  const close = () => {
    if (current.length > 1) parts.push(`M${current.join("L")}`);
    current = [];
  };

  points.forEach((point) => {
    if (!usable(point)) {
      close();
      previousTs = point.ts;
      return;
    }
    if (
      current.length > 0 &&
      previousTs !== null &&
      point.ts - previousTs > bucketSecs * 1.5
    ) {
      close();
    }
    current.push(`${xOf(point.ts)},${yOf(point.p50 as number)}`);
    previousTs = point.ts;
  });
  close();
  return parts.join("");
}

function bandPath(
  points: readonly ChainHealthPoint[],
  xOf: (ts: number) => number,
  yOf: (value: number) => number,
  bucketSecs: number,
): string {
  const parts: string[] = [];
  let current: { x: number; top: number; bottom: number }[] = [];
  let previousTs: number | null = null;

  const close = () => {
    if (current.length > 1) {
      const top = current.map((item) => `${item.x},${item.top}`).join("L");
      const bottom = [...current]
        .reverse()
        .map((item) => `${item.x},${item.bottom}`)
        .join("L");
      parts.push(`M${top}L${bottom}Z`);
    }
    current = [];
  };

  points.forEach((point) => {
    if (
      !usable(point) ||
      point.p10 === null ||
      point.p90 === null
    ) {
      close();
      previousTs = point.ts;
      return;
    }
    if (
      current.length > 0 &&
      previousTs !== null &&
      point.ts - previousTs > bucketSecs * 1.5
    ) {
      close();
    }
    current.push({
      x: xOf(point.ts),
      top: yOf(point.p90),
      bottom: yOf(point.p10),
    });
    previousTs = point.ts;
  });
  close();
  return parts.join("");
}

/**
 * 指针 ratio → 最近的**有效**点。空槽保留在时间轴上，但悬停空槽没有可读数值，
 * 因此向左右找最近的有样本桶。
 */
function nearestIndex(
  points: readonly ChainHealthPoint[],
  window: { startTs: number; endTs: number },
  ratio: number,
): number {
  if (points.length === 0) return 0;
  const span = window.endTs - window.startTs;
  const target = window.startTs + Math.max(0, Math.min(1, ratio)) * span;
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  points.forEach((point, index) => {
    if (!usable(point)) return;
    const distance = Math.abs(point.ts - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  if (best >= 0) return best;
  return Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
}

function stepIndex(
  points: readonly ChainHealthPoint[],
  from: number,
  direction: 1 | -1,
): number {
  if (points.length === 0) return 0;
  let next = from;
  for (let step = 0; step < points.length; step += 1) {
    next += direction;
    if (next < 0 || next >= points.length) return from;
    if (usable(points[next])) return next;
  }
  return from;
}

/**
 * 小多图 / 逐段趋势共用的迷你曲线：P10–P90 带 + P50 线。
 *
 * 每行独立纵轴（0 → 本行最大值），所以 tooltip 必须带 `ms` 单位；
 * 悬停、触摸与键盘方向键都能读到具体桶的值。异常窗口用 warning 低透明度
 * 背景标出，正常曲线用 primary，不引入新色相。
 */
export function ChainLatencySparkline({
  points,
  window,
  timeTicks,
  bucketSecs,
  tone,
  showBand = true,
  showAnomalies = showBand,
  interactive = true,
  label,
  onActivate,
  className,
  heightClass = "h-10",
}: {
  points: readonly ChainHealthPoint[];
  /** 显式时间窗（整体时延图以最后一个样本为右端）；缺省用序列自身槽位。 */
  window?: ChainSeriesWindow;
  /** 时间刻度；提供时在对应 x 位置画极淡竖向 gridline。 */
  timeTicks?: readonly ChainTimeTick[];
  bucketSecs: number;
  tone: Tone;
  showBand?: boolean;
  /** 整链图默认画异常窗口；列表迷你图/逐段图可关掉。 */
  showAnomalies?: boolean;
  /** false = 仅作视觉/悬停提示，不进入 Tab 序列（列表行本身是按钮）。 */
  interactive?: boolean;
  label: string;
  onActivate?: () => void;
  className?: string;
  heightClass?: string;
}) {
  useI18n();
  const [active, setActive] = useState<number | null>(null);
  // 异常窗口只画在整链小多图上；逐段趋势是单个段的曲线，重复的探测抖动
  // 会被误标成一串竖条。
  const anomalies = useMemo(
    () => (showAnomalies ? chainAnomalyWindows(points, bucketSecs) : []),
    [points, bucketSecs, showAnomalies],
  );
  const max = chainSeriesMax(points);
  const domain = max > 0 ? max * 1.15 : 1;
  const color = toneColor(tone);
  // 时间窗默认来自序列本身的槽位（含空槽）：x 只按 ts 定位，不按有效点个数；
  // 整体时延图传入显式窗口，右端固定在最后一个真实样本。
  const seriesWindow = useMemo(
    () => window ?? chainSeriesWindow(points),
    [window, points],
  );

  const xOf = (ts: number) =>
    seriesWindow === null
      ? VIEW_WIDTH / 2
      : chainPointX(ts, seriesWindow, VIEW_WIDTH);
  const yOf = (value: number) => {
    const ratio = Math.max(0, Math.min(1, value / domain));
    return (
      VIEW_HEIGHT -
      BOTTOM_PAD -
      ratio * (VIEW_HEIGHT - TOP_PAD - BOTTOM_PAD)
    );
  };

  const line = linePath(points, xOf, yOf, bucketSecs);
  const band = showBand ? bandPath(points, xOf, yOf, bucketSecs) : "";

  const lastIndex = useMemo(() => {
    for (let index = points.length - 1; index >= 0; index -= 1) {
      if (usable(points[index])) return index;
    }
    return -1;
  }, [points]);

  if (points.length === 0 || lastIndex < 0 || seriesWindow === null) {
    return <div className={cn("w-full", heightClass)} aria-hidden="true" />;
  }

  // 切时窗后 points 长度会变；旧的 active 下标可能越界，必须先夹回有效范围。
  const activeIndex =
    active !== null && active >= 0 && active < points.length ? active : null;
  const activePoint = activeIndex === null ? null : points[activeIndex];
  const activeX = activePoint === null ? null : xOf(activePoint.ts);
  const activePct =
    activeX === null ? 50 : (activeX / VIEW_WIDTH) * 100;
  const transform =
    activePct < 12
      ? "translateX(0)"
      : activePct > 88
        ? "translateX(-100%)"
        : "translateX(-50%)";

  function showAt(event: PointerEvent<HTMLDivElement>) {
    if (seriesWindow === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    setActive(
      nearestIndex(
        points,
        seriesWindow,
        (event.clientX - rect.left) / rect.width,
      ),
    );
  }

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      if (onActivate) {
        event.preventDefault();
        onActivate();
      }
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const start = activeIndex ?? (direction === 1 ? -1 : points.length);
    const next = stepIndex(points, start, direction);
    setActive(next);
  }

  return (
    <div
      className={cn(
        "relative min-w-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      data-chain-sparkline
      onPointerMove={showAt}
      onPointerDown={showAt}
      onPointerLeave={() => setActive(null)}
      onPointerCancel={() => setActive(null)}
      onClick={interactive ? onActivate : undefined}
      onKeyDown={interactive ? moveFocus : undefined}
      onFocus={interactive ? () => setActive(lastIndex) : undefined}
      onBlur={interactive ? () => setActive(null) : undefined}
      tabIndex={interactive ? 0 : undefined}
      role="group"
      aria-label={label}
    >
      <svg
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        className={cn("block w-full", heightClass)}
        role="img"
        aria-label={label}
      >
        {(timeTicks ?? []).map((tick) => (
          <line
            key={`grid-${tick.ts}`}
            data-chain-time-gridline
            x1={xOf(tick.ts)}
            x2={xOf(tick.ts)}
            y1={0}
            y2={VIEW_HEIGHT}
            stroke={CHART_GRID_STROKE}
            strokeOpacity={CHART_GRID_OPACITY}
            strokeDasharray={CHART_GRID_DASH}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {anomalies.map((window) => (
          <AnomalyBand key={`${window.startTs}-${window.endTs}`} window={window} points={points} xOf={xOf} />
        ))}
        {band ? <path d={band} fill={color} fillOpacity={0.2} /> : null}
        {line ? (
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {activeX === null ? null : (
          <line
            x1={activeX}
            x2={activeX}
            y1={0}
            y2={VIEW_HEIGHT}
            stroke="var(--foreground)"
            strokeOpacity={0.25}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {lastIndex >= 0 ? (
        <span
          aria-hidden="true"
          data-chain-sparkline-dot
          className={cn(
            "pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
            tone === "warning" ? "bg-warning" : "bg-primary",
          )}
          style={{
            left: `${(xOf(points[lastIndex].ts) / VIEW_WIDTH) * 100}%`,
            top: `${(yOf(points[lastIndex].p50 as number) / VIEW_HEIGHT) * 100}%`,
          }}
        />
      ) : null}

      {activePoint ? (
        <ChartTooltipShell
          data-chain-sparkline-tooltip
          role="tooltip"
          aria-live="polite"
          className="pointer-events-none absolute top-0 z-20 min-w-40 max-w-64 leading-normal"
          style={{ left: `${activePct}%`, transform }}
        >
          <ChartTooltipHeading>
            {formatChainTime(activePoint.ts, bucketSecs)}
          </ChartTooltipHeading>
          <ChartTooltipRow
            label="P50"
            value={formatMs(activePoint.p50)}
          />
          {showBand && activePoint.p10 !== null && activePoint.p90 !== null ? (
            <ChartTooltipRow
              label="P10–P90"
              value={`${formatMs(activePoint.p10)} – ${formatMs(activePoint.p90)}`}
            />
          ) : null}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("overview.chainLatency.samples", { n: activePoint.samples })}
          </p>
        </ChartTooltipShell>
      ) : null}
    </div>
  );
}

function AnomalyBand({
  window,
  points,
  xOf,
}: {
  window: ChainAnomalyWindow;
  points: readonly ChainHealthPoint[];
  xOf: (ts: number) => number;
}) {
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  points.forEach((point) => {
    if (point.ts < window.startTs || point.ts > window.endTs) return;
    if (firstTs === null) firstTs = point.ts;
    lastTs = point.ts;
  });
  if (firstTs === null || lastTs === null) return null;
  const x = xOf(firstTs);
  const width = Math.max(2, xOf(lastTs) - x);
  return (
    <rect
      x={x}
      y={0}
      width={width}
      height={VIEW_HEIGHT}
      fill="var(--primary)"
      fillOpacity={0.16}
      data-chain-anomaly
    />
  );
}
