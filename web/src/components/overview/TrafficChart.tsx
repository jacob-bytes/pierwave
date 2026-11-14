import { useId } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartColumnIcon } from "lucide-react";
import type { TrafficDay } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import {
  cumulativeAxisUnit,
  cumulativeSeries,
  formatCumulativeTick,
} from "@/lib/overview";
import { t } from "@/i18n";

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
 */
export function TrafficLegend({ showCumulative }: { showCumulative: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <LegendDot color="var(--primary)" label={t("trafficChart.downlink")} />
      <LegendDot
        color="var(--muted-foreground)"
        label={t("trafficChart.uplink")}
        pattern
      />
      {showCumulative ? (
        <LegendLine label={t("trafficChart.cumulative")} />
      ) : null}
    </div>
  );
}

function LegendLine({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <svg
        aria-hidden="true"
        width="16"
        height="8"
        viewBox="0 0 16 8"
        className="shrink-0"
      >
        <line
          x1="0"
          y1="4"
          x2="16"
          y2="4"
          stroke="var(--foreground)"
          strokeWidth="1.5"
        />
        <circle
          cx="8"
          cy="4"
          r="2.5"
          fill="var(--card)"
          stroke="var(--foreground)"
          strokeWidth="1.5"
        />
      </svg>
      {label}
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
    <div className="flex items-center justify-between gap-6">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {color ? (
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
              className="size-2 rounded-full"
              style={{ backgroundColor: color }}
            />
          )
        ) : null}
        {label}
      </span>
      <span className="font-mono text-foreground">{formatBytes(value)}</span>
    </div>
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
      stroke="var(--muted-foreground)"
      strokeOpacity={0.45}
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
    <div className="min-w-44 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg/40">
      <p className="mb-2 font-medium text-foreground">{day.date}</p>
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
        <div className="my-1 h-px bg-border" />
        <TooltipValue label={t("trafficChart.weighted")} value={day.weighted} />
        {typeof day.cumulative === "number" ? (
          <>
            <div className="my-1 h-px bg-border" />
            <TooltipValue
              label={t("trafficChart.cumulative")}
              value={day.cumulative}
              color="var(--foreground)"
              marker="line"
            />
          </>
        ) : null}
      </div>
    </div>
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
  const patternId = `pw-traffic-uplink-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const dataTableId = `pw-traffic-data-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hasTraffic = days.some(
    (day) => day.downlink > 0 || day.uplink > 0,
  );
  // 单点没有趋势可言：不写 cumulative，Line / 右轴 / tooltip 累计行都不渲染。
  const showCumulative = days.length > 1;
  const chartDays: ChartDay[] = showCumulative
    ? cumulativeSeries(days)
    : days;
  const maxCumulative = showCumulative
    ? chartDays.reduce((max, day) => Math.max(max, day.cumulative ?? 0), 0)
    : 0;
  const cumulativeUnit = cumulativeAxisUnit(maxCumulative);

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
    <div className="flex flex-col gap-3">
      {showLegend ? <TrafficLegend showCumulative={showCumulative} /> : null}

      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartDays}
            margin={{ top: 4, right: showCumulative ? 12 : 4, bottom: 0, left: 0 }}
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
            <CartesianGrid
              vertical={false}
              stroke="var(--border)"
              strokeWidth={1}
            />
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
              tickFormatter={(value: number) => formatBytes(value)}
              axisLine={false}
              tickLine={false}
              tickCount={4}
              width={64}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            {showCumulative ? (
              <YAxis
                yAxisId="cumulative"
                orientation="right"
                tickFormatter={(value: number) =>
                  formatCumulativeTick(value, cumulativeUnit)
                }
                axisLine={false}
                tickLine={false}
                tickCount={4}
                width={54}
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                label={{
                  value: t("trafficChart.cumulativeAxis", {
                    unit: cumulativeUnit,
                  }),
                  angle: 90,
                  position: "insideRight",
                  style: {
                    fill: "var(--muted-foreground)",
                    fontSize: 10,
                  },
                }}
              />
            ) : null}
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
              isAnimationActive={false}
            />
            <Bar
              yAxisId="traffic"
              dataKey="uplink"
              name={t("trafficChart.uplink")}
              stackId="traffic"
              fill={`url(#${patternId})`}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
            {showCumulative ? (
              <Line
                yAxisId="cumulative"
                type="monotone"
                dataKey="cumulative"
                name={t("trafficChart.cumulative")}
                stroke="var(--foreground)"
                strokeWidth={1.5}
                dot={{
                  r: 2.5,
                  fill: "var(--card)",
                  stroke: "var(--foreground)",
                  strokeWidth: 1.5,
                }}
                activeDot={{ r: 4, fill: "var(--foreground)" }}
                isAnimationActive={false}
              />
            ) : null}
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
