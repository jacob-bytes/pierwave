import { useId } from "react";
import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartColumnIcon } from "lucide-react";
import type { TrafficDay } from "@/lib/api";
import { byteAxisScale, formatByteAxisTick } from "@/lib/chartAxis";
import { formatBytes } from "@/lib/format";
import { cumulativeSeries } from "@/lib/overview";
import { ChartGrid } from "./ChartGrid";
import {
  ChartTooltipDivider,
  ChartTooltipHeading,
  ChartTooltipRow,
  ChartTooltipShell,
} from "./ChartTooltipShell";
import { CHART_CURSOR_OPACITY, CHART_CURSOR_STROKE } from "./chartTheme";
import { t } from "@/i18n";
import { useChartEnterAnimation } from "@/lib/useChartEnterAnimation";

interface ChartDay extends TrafficDay {
  /** 只有画累计线时才写入；单点时保持 undefined，tooltip 也不显示累计。 */
  cumulative?: number;
}

interface TooltipItem {
  payload?: ChartDay;
}

interface TrafficTooltipProps {
  active?: boolean;
  payload?: TooltipItem[];
}

function formatDayTick(value: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${Number(match[1])}/${Number(match[2])}` : value;
}

/**
 * 图例：默认画在图表上方，也可以由调用方提到卡片头部（与总量徽标同一行）。
 *
 * 累计只保留一个 chip：显示窗口内最后一天的累计值。不再画累计线，也就
 * 不需要第二根 Y 轴；逐日累计在 tooltip 里给。
 */
export function TrafficLegend({ days }: { days?: readonly TrafficDay[] }) {
  const cumulative =
    days && days.length > 1
      ? cumulativeSeries(days)[days.length - 1]?.cumulative
      : undefined;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <LegendDot color="var(--primary)" label={t("trafficChart.downlink")} />
      <LegendDot
        color="var(--muted-foreground)"
        label={t("trafficChart.uplink")}
        pattern
      />
      {/*
        累计 0 不是「有数据」：无采样时隐藏 chip，避免图例里出现「累计 0 B」，
        与卡片上的 — / 「暂无采样」保持一致。
      */}
      {typeof cumulative === "number" && cumulative > 0 ? (
        <CumulativeChip value={cumulative} />
      ) : null}
    </div>
  );
}

/** 图例里的累计 chip：读末值不需要再对照右轴。 */
function CumulativeChip({ value }: { value: number }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 type-micro font-normal text-muted-foreground tabular-nums"
      title={t("trafficChart.cumulativeChipTitle")}
    >
      <svg
        aria-hidden="true"
        width="14"
        height="8"
        viewBox="0 0 14 8"
        className="shrink-0"
      >
        <line
          x1="0"
          y1="4"
          x2="14"
          y2="4"
          stroke="var(--foreground)"
          strokeWidth="1.5"
        />
        <circle
          cx="7"
          cy="4"
          r="2.25"
          fill="var(--card)"
          stroke="var(--foreground)"
          strokeWidth="1.5"
        />
      </svg>
      <span>{t("trafficChart.cumulative")}</span>
      <span className="font-mono text-foreground">{formatBytes(value)}</span>
    </span>
  );
}

function LegendDot({
  color,
  label,
  pattern,
}: {
  color: string;
  label: string;
  /** true 时用斜纹方块代替实心圆点，色盲用户不依赖颜色也能区分上下行。 */
  pattern?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className={pattern ? "size-2 rounded-[2px]" : "size-2 rounded-full"}
        style={
          pattern
            ? {
                backgroundImage: `repeating-linear-gradient(45deg, ${color} 0 1px, var(--card) 1px 3px)`,
              }
            : { backgroundColor: color }
        }
      />
      {label}
    </span>
  );
}

function TooltipValue({
  label,
  value,
  color,
  marker = "dot",
}: {
  label: string;
  value: number;
  color?: string;
  /** 累计线用「线 + 空心点」，不只靠颜色区分。 */
  marker?: "dot" | "line";
}) {
  return (
    <ChartTooltipRow
      label={label}
      value={formatBytes(value)}
      marker={
        color ? (
          marker === "line" ? (
            <svg
              aria-hidden="true"
              width="14"
              height="8"
              viewBox="0 0 14 8"
              className="shrink-0"
            >
              <line
                x1="0"
                y1="4"
                x2="14"
                y2="4"
                stroke={color}
                strokeWidth="1.5"
              />
              <circle
                cx="7"
                cy="4"
                r="2.25"
                fill="var(--card)"
                stroke={color}
                strokeWidth="1.5"
              />
            </svg>
          ) : (
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
            />
          )
        ) : null
      }
    />
  );
}

/**
 * 悬停 / 键盘聚焦时的竖向参考线。
 *
 * Recharts 的 BarChart cursor 默认画整条分类色块；这里只留中间 1px 竖线，
 * 不遮住柱子本身的颜色。坐标由 Recharts 传入（分类带 left/top/width/height）。
 */
function TrafficCursor({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}) {
  const center = x + width / 2;
  return (
    <line
      x1={center}
      x2={center}
      y1={y}
      y2={y + height}
      stroke={CHART_CURSOR_STROKE}
      strokeOpacity={CHART_CURSOR_OPACITY}
      strokeWidth={1}
      pointerEvents="none"
    />
  );
}

function TrafficTooltip({ active, payload }: TrafficTooltipProps) {
  if (!active || !payload?.length) return null;
  const day = payload[0]?.payload;
  if (!day) return null;

  return (
    <ChartTooltipShell data-traffic-tooltip role="tooltip" className="max-w-64">
      <ChartTooltipHeading>{day.date}</ChartTooltipHeading>
      <div className="flex flex-col gap-1">
        <TooltipValue
          label={t("trafficChart.downlink")}
          value={day.downlink}
          color="var(--primary)"
        />
        <TooltipValue
          label={t("trafficChart.uplink")}
          value={day.uplink}
          color="var(--muted-foreground)"
        />
        <ChartTooltipDivider />
        <TooltipValue label={t("trafficChart.weighted")} value={day.weighted} />
        {typeof day.cumulative === "number" ? (
          <>
            <ChartTooltipDivider />
            <TooltipValue
              label={t("trafficChart.cumulativeToDate")}
              value={day.cumulative}
              color="var(--foreground)"
              marker="line"
            />
          </>
        ) : null}
      </div>
    </ChartTooltipShell>
  );
}

/**
 * 流量趋势图。recharts 体积较大，这个文件只被概览页与「我的」页
 * 用 `lazy()` 动态加载，不会进入主 chunk。
 */
export default function TrafficChart({
  days,
  showLegend = true,
}: {
  days: TrafficDay[];
  /** false 时由调用方自行渲染图例（例如放到卡片头部与总量徽标同一行）。 */
  showLegend?: boolean;
}) {
  // 每个图表实例的 pattern id 唯一，避免同页多图时互相引用。
  const chartEnter = useChartEnterAnimation();
  const patternId = `pw-traffic-uplink-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const dataTableId = `pw-traffic-data-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hasTraffic = days.some(
    (day) => day.downlink > 0 || day.uplink > 0,
  );
  // 单点没有趋势可言：不写 cumulative，tooltip 累计行与图例 chip 都不渲染。
  const showCumulative = days.length > 1;
  const chartDays: ChartDay[] = showCumulative
    ? cumulativeSeries(days)
    : days;
  // 堆叠柱的总高度决定 y 轴上界；步长按 1024 单位取整齐值。
  const scale = byteAxisScale(
    chartDays.reduce((max, day) => Math.max(max, day.downlink + day.uplink), 0),
  );

  if (!days.length || !hasTraffic) {
    return (
      <div className="flex h-[248px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 text-center">
        <ChartColumnIcon className="icon-lg text-muted-foreground" />
        <p className="text-sm font-medium">{t("trafficChart.emptyTitle")}</p>
        <p className="text-xs text-muted-foreground">
          {t("trafficChart.emptyDesc")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-traffic-chart>
      {showLegend ? <TrafficLegend days={days} /> : null}

      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartDays}
            margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
            barCategoryGap="28%"
            // 保留有名称的 role=img（默认会是空名的 role=application）；
            // 同时打开 accessibilityLayer，键盘左右键可以在日期间移动并显示 tooltip。
            // 逐日数据表仍是读屏 / 键盘用户的完整取数入口。
            {...({
              role: "img",
              "aria-label": t("trafficChart.aria"),
              accessibilityLayer: true,
            } as Record<string, unknown>)}
          >
            <defs>
              <pattern
                id={patternId}
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="6" height="6" fill="var(--muted-foreground)" />
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="6"
                  stroke="var(--card)"
                  strokeWidth="2"
                />
              </pattern>
            </defs>
            <ChartGrid />
            <XAxis
              dataKey="date"
              tickFormatter={formatDayTick}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              dy={6}
            />
            <YAxis
              yAxisId="traffic"
              domain={[0, scale.max]}
              ticks={scale.ticks}
              tickFormatter={formatByteAxisTick}
              axisLine={false}
              tickLine={false}
              width={64}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            <Tooltip
              cursor={<TrafficCursor />}
              content={<TrafficTooltip />}
            />
            <Bar
              yAxisId="traffic"
              dataKey="downlink"
              name={t("trafficChart.downlink")}
              stackId="traffic"
              fill="var(--primary)"
              radius={[2, 2, 0, 0]}
              isAnimationActive={chartEnter.isAnimationActive}
              animationDuration={chartEnter.animationDuration}
              animationEasing={chartEnter.animationEasing}
              onAnimationEnd={chartEnter.onAnimationEnd}
            />
            <Bar
              yAxisId="traffic"
              dataKey="uplink"
              name={t("trafficChart.uplink")}
              stackId="traffic"
              fill={`url(#${patternId})`}
              radius={[2, 2, 0, 0]}
              isAnimationActive={chartEnter.isAnimationActive}
              animationDuration={chartEnter.animationDuration}
              animationEasing={chartEnter.animationEasing}
              onAnimationEnd={chartEnter.onAnimationEnd}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/*
        图表不是唯一的取数方式：逐日数据表始终渲染，用 sr-only 视觉隐藏，
        读屏与键盘用户仍可逐行取数；视觉上不再出现按钮。
      */}
      <div className="sr-only">
        <table id={dataTableId} data-slot="traffic-data-table" className="w-full text-xs">
          <caption>
            {t("trafficChart.dataTableCaption")}
          </caption>
          <thead>
            <tr>
              <th scope="col">{t("trafficChart.date")}</th>
              <th scope="col">{t("trafficChart.downlink")}</th>
              <th scope="col">{t("trafficChart.uplink")}</th>
              {showCumulative ? (
                <th scope="col">{t("trafficChart.cumulative")}</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {chartDays.map((day) => (
              <tr key={day.date}>
                <th scope="row">{day.date}</th>
                <td>{formatBytes(day.downlink)}</td>
                <td>{formatBytes(day.uplink)}</td>
                {showCumulative ? (
                  <td>{formatBytes(day.cumulative ?? 0)}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
