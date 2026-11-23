import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatChainTime,
  formatLossPct,
  formatMs,
  segmentSeries,
  type ChainHealthPoint,
  type ChainHealthSegment,
} from "@/lib/chainHealth";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** 同一色相的明度阶梯：段再多也不引入新色相。 */
const SEGMENT_OPACITY = [1, 0.84, 0.7, 0.58, 0.48, 0.4, 0.34, 0.29];

/** 线型与明度同时区分，超过 1 段时仍能不看颜色分辨。 */
const SEGMENT_DASH = [
  undefined,
  "7 4",
  "2 3",
  "10 3 2 3",
  "5 3 1 3",
  "1 3",
  "12 4",
] as const;

interface SegmentTrendEntry {
  segment: ChainHealthSegment;
  points: ChainHealthPoint[];
}

interface SegmentTrendRow {
  ts: number;
  [key: string]: number | null;
}

interface TooltipRow {
  payload?: SegmentTrendRow;
}

function p50Key(seq: number): string {
  return `p50_${seq}`;
}

function lossKey(seq: number): string {
  return `loss_${seq}`;
}

function hasTrend(points: readonly ChainHealthPoint[]): boolean {
  return points.some((point) => point.p50 !== null && point.samples > 0);
}

function segmentVisual(index: number): {
  color: string;
  opacity: number;
  dash?: string;
} {
  return {
    color: "var(--primary)",
    opacity: SEGMENT_OPACITY[index % SEGMENT_OPACITY.length] ?? 0.29,
    dash: SEGMENT_DASH[index % SEGMENT_DASH.length],
  };
}

function LineSwatch({
  visual,
  muted = false,
}: {
  visual: { color: string; opacity: number; dash?: string };
  muted?: boolean;
}) {
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
        stroke={muted ? "var(--muted-foreground)" : visual.color}
        strokeOpacity={muted ? 0.45 : visual.opacity}
        strokeWidth="1.5"
        strokeDasharray={visual.dash}
        strokeLinecap="round"
      />
    </svg>
  );
}

function axisTick(ts: number, bucket: number): string {
  const text = formatChainTime(ts, bucket);
  return bucket >= 3600 ? text.slice(0, 5) : text.slice(6);
}

/**
 * 单张图里的多段 tooltip：按段序列出该时刻的时延 + 该时刻丢包。
 *
 * 丢包只进 tooltip，不画第二条线/次轴：ms 与 % 量纲不同，双轴会让读者
 * 把两条线的交叉点误读成因果。该桶没有探测时显示 `—`，不借用窗口值。
 */
function SegmentTrendTooltip({
  active,
  payload,
  entries,
  bucket,
}: {
  active?: boolean;
  payload?: TooltipRow[];
  entries: readonly SegmentTrendEntry[];
  bucket: number;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  const rows = entries
    .map((entry) => {
      const p50 = row[p50Key(entry.segment.seq)];
      const loss = row[lossKey(entry.segment.seq)];
      return {
        seq: entry.segment.seq,
        p50: typeof p50 === "number" && Number.isFinite(p50) ? p50 : null,
        loss: typeof loss === "number" && Number.isFinite(loss) ? loss : null,
      };
    })
    .sort((a, b) => a.seq - b.seq);

  const numeric = rows.filter((item) => item.p50 !== null);
  const highest = numeric.reduce<(typeof numeric)[number] | null>(
    (best, item) =>
      best === null || (item.p50 as number) > (best.p50 as number) ? item : best,
    null,
  );
  const lowest = numeric.reduce<(typeof numeric)[number] | null>(
    (best, item) =>
      best === null || (item.p50 as number) < (best.p50 as number) ? item : best,
    null,
  );
  // 所有段同值时最高/最低没有信息量，不要同时给两行贴标签。
  const distinct = new Set(numeric.map((item) => item.p50)).size > 1;

  return (
    <div
      data-segment-tooltip
      className="min-w-52 max-w-72 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg/40"
    >
      <p className="mb-2 font-mono text-[10px] text-muted-foreground">
        {formatChainTime(row.ts, bucket)}
      </p>
      <div className="flex flex-col gap-1">
        {rows.map((item) => {
          const isHighest = distinct && highest?.seq === item.seq;
          const isLowest = distinct && lowest?.seq === item.seq;
          return (
            <div
              key={item.seq}
              data-segment-tooltip-row
              data-seq={item.seq}
              data-highest={isHighest ? "true" : undefined}
              data-lowest={isLowest ? "true" : undefined}
              className={cn(
                "flex items-center justify-between gap-4 rounded-sm px-1 py-0.5",
                isHighest && "bg-primary/5",
              )}
            >
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {t("overview.chainLatency.segment", { seq: item.seq })}
              </span>
              <span className="flex shrink-0 items-baseline gap-2 font-mono tabular-nums">
                <span data-segment-tooltip-p50>
                  {formatMs(item.p50)}
                </span>
                <span
                  data-segment-tooltip-loss
                  className="text-[10px] text-muted-foreground"
                >
                  {t("overview.chainLatency.lossAtTime")}{" "}
                  {formatLossPct(item.loss)}
                </span>
                {isHighest ? (
                  <span className="font-sans text-[9px] text-primary">
                    {t("overview.chainLatency.highest")}
                  </span>
                ) : null}
                {isLowest ? (
                  <span className="font-sans text-[9px] text-muted-foreground">
                    {t("overview.chainLatency.lowest")}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SegmentLegend({
  segments,
  entries,
  hidden,
  onToggle,
}: {
  segments: readonly ChainHealthSegment[];
  entries: readonly SegmentTrendEntry[];
  hidden: ReadonlySet<number>;
  onToggle: (seq: number) => void;
}) {
  const bySeq = new Map(entries.map((entry) => [entry.segment.seq, entry]));
  return (
    <div
      data-segment-legend
      role="group"
      aria-label={t("overview.chainLatency.segmentLegendAria")}
      className="flex flex-wrap content-start gap-x-3 gap-y-1 pb-2"
    >
      {segments.map((segment, index) => {
        const entry = bySeq.get(segment.seq);
        const usable = entry !== undefined && hasTrend(entry.points);
        const hiddenHere = usable && hidden.has(segment.seq);
        const visual = segmentVisual(index);
        return (
          <button
            key={segment.seq}
            type="button"
            disabled={!usable}
            aria-pressed={usable ? !hiddenHere : undefined}
            data-segment-legend-item
            data-seq={segment.seq}
            data-has-data={usable ? "true" : "false"}
            data-hidden={hiddenHere ? "true" : "false"}
            onClick={() => {
              if (usable) onToggle(segment.seq);
            }}
            className={cn(
              "inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] transition-opacity duration-150",
              usable
                ? hiddenHere
                  ? "opacity-35 hover:opacity-60"
                  : "opacity-100 hover:bg-muted/40"
                : "cursor-default opacity-50",
            )}
          >
            <LineSwatch visual={visual} muted={!usable} />
            <span className="shrink-0">
              {t("overview.chainLatency.segment", { seq: segment.seq })}
            </span>
            {usable ? null : (
              <span className="shrink-0 text-muted-foreground">
                {t("overview.chainLatency.missingHop")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 详情里的逐段折线：**一张图、每段一条线**。
 *
 * - x = 时间（跟随 24h/7d 时窗），y = 时延 ms；
 * - 颜色只用 primary 明度阶梯 + 线型区分，变慢不换色相；
 * - 无数据段不进图例线条，图例灰显「无历史数据」；
 * - tooltip 同时给该时刻每段的时延与逐桶丢包（null → —），按段序排列。
 */
export function ChainSegmentTrendChart({
  segments,
  trends,
  bucketSecs,
  trendPending = false,
}: {
  segments: readonly ChainHealthSegment[];
  trends: ReadonlyMap<number, ChainHealthPoint[]>;
  bucketSecs: number;
  /** 逐段延迟接口仍在请求中：此时空态是「加载中」而不是「无历史数据」。 */
  trendPending?: boolean;
}) {
  useI18n();
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());

  const entries = useMemo<SegmentTrendEntry[]>(
    () =>
      segments.map((segment) => ({
        segment,
        points: segmentSeries(segment, trends),
      })),
    [segments, trends],
  );
  const usable = entries.filter((entry) => hasTrend(entry.points));
  const visible = usable.filter((entry) => !hidden.has(entry.segment.seq));

  const data = useMemo<SegmentTrendRow[]>(() => {
    const timestamps = new Set<number>();
    const bySeq = new Map<number, Map<number, ChainHealthPoint>>();
    for (const entry of usable) {
      const byTs = new Map<number, ChainHealthPoint>();
      for (const point of entry.points) {
        if (!Number.isFinite(point.ts)) continue;
        timestamps.add(point.ts);
        byTs.set(point.ts, point);
      }
      bySeq.set(entry.segment.seq, byTs);
    }
    return [...timestamps]
      .sort((a, b) => a - b)
      .map((ts) => {
        const row: SegmentTrendRow = { ts };
        for (const entry of usable) {
          const point = bySeq.get(entry.segment.seq)?.get(ts);
          row[p50Key(entry.segment.seq)] =
            point && point.samples > 0 ? point.p50 : null;
          row[lossKey(entry.segment.seq)] = point?.lossPct ?? null;
        }
        return row;
      });
  }, [usable]);

  const xTicks = useMemo(() => {
    if (bucketSecs < 3600 || data.length === 0) return undefined;
    return data
      .filter((_row, index) => index % 24 === 0)
      .map((row) => row.ts);
  }, [bucketSecs, data]);

  function toggle(seq: number) {
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }

  return (
    <div
      data-chain-segment-chart
      data-series-count={usable.length}
      data-visible-count={visible.length}
      role="group"
      aria-label={t("overview.chainLatency.segmentChartAria", {
        n: usable.length,
      })}
    >
      <SegmentLegend
        segments={segments}
        entries={entries}
        hidden={hidden}
        onToggle={toggle}
      />
      {usable.length === 0 ? (
        <div
          data-segment-empty
          className="flex h-[240px] items-center justify-center rounded-md border border-dashed border-border text-[11px] text-muted-foreground sm:h-[260px]"
        >
          {trendPending
            ? t("overview.chainLatency.segmentTrendLoading")
            : t("overview.chainLatency.missingHop")}
        </div>
      ) : visible.length === 0 ? (
        <div className="flex h-[240px] items-center justify-center text-[11px] text-muted-foreground sm:h-[260px]">
          {t("overview.chainLatency.allSegmentsHidden")}
        </div>
      ) : (
        <div className="h-[240px] w-full sm:h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                stroke="var(--border)"
                strokeDasharray="2 4"
                vertical={false}
              />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                ticks={xTicks}
                interval={xTicks ? 0 : "preserveStartEnd"}
                tickFormatter={(value: number) => axisTick(value, bucketSecs)}
                minTickGap={bucketSecs >= 3600 ? 40 : 30}
                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[0, "auto"]}
                width={48}
                tickFormatter={(value: number) => `${Math.round(value)}ms`}
                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                content={
                  <SegmentTrendTooltip entries={visible} bucket={bucketSecs} />
                }
                cursor={{
                  stroke: "var(--muted-foreground)",
                  strokeOpacity: 0.35,
                }}
              />
              {visible.map((entry) => {
                const index = segments.findIndex(
                  (segment) => segment.seq === entry.segment.seq,
                );
                const visual = segmentVisual(Math.max(0, index));
                return (
                  <Line
                    key={entry.segment.seq}
                    type="monotone"
                    dataKey={p50Key(entry.segment.seq)}
                    name={t("overview.chainLatency.segment", {
                      seq: entry.segment.seq,
                    })}
                    stroke={visual.color}
                    strokeOpacity={visual.opacity}
                    strokeDasharray={visual.dash}
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={{ r: 3 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
