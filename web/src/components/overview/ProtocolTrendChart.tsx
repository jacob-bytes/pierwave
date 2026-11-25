import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartLineIcon } from "lucide-react";
import type { OverviewProtocolSeries } from "@/lib/api";
import { byteAxisScale, formatByteAxisTick } from "@/lib/chartAxis";
import { formatBytes } from "@/lib/format";
import {
  protocolTrend,
  type ProtocolTrendLine,
  type ProtocolTrendPoint,
} from "@/lib/overview";
import { ChartGrid } from "./ChartGrid";
import {
  ChartTooltipHeading,
  ChartTooltipRow,
  ChartTooltipShell,
} from "./ChartTooltipShell";
import { CHART_CURSOR_OPACITY, CHART_CURSOR_STROKE } from "./chartTheme";
import { useI18n } from "@/i18n";

/** X 轴刻度：`2026-11-05` → `11/5`；与流量趋势图保持一致。 */
function formatDayTick(value: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${Number(match[1])}/${Number(match[2])}` : value;
}

function protocolLabel(protocol: string): string {
  if (protocol === "other") return "overview.protocolOther";
  if (protocol === "unknown") return "overview.protocolUnknown";
  return protocol;
}

/** 图例与 tooltip 共用：一条带线型的短线段，不只靠颜色区分。 */
function LineMark({ line }: { line: ProtocolTrendLine | undefined }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="6"
      viewBox="0 0 16 6"
      className="shrink-0"
    >
      <line
        x1="0"
        y1="3"
        x2="16"
        y2="3"
        stroke={seriesColor(line?.tone ?? 0)}
        strokeWidth={1.5}
        strokeDasharray={line?.dash}
      />
    </svg>
  );
}

/**
 * 四档同色明度的 stroke。
 *
 * 只引用 CSS 变量，不写死颜色：暗色四档都 ≥5.9:1，亮色四档都 ≥4.5:1；
 * 线型仍由 `lineDashArray()` 提供，黑白截图 / 色盲下也能区分。
 */
function seriesColor(tone: number): string {
  const index = Math.min(3, Math.max(0, Math.floor(tone)));
  return `var(--series-${index + 1})`;
}

interface TooltipEntry {
  dataKey?: string | number;
  name?: string;
  value?: number | string;
}

function ProtocolTrendTooltip({
  active,
  payload,
  label,
  lines,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: number | string;
  lines: readonly ProtocolTrendLine[];
}) {
  if (!active || !payload?.length) return null;

  return (
    <ChartTooltipShell
      data-protocol-tooltip
      role="tooltip"
      className="max-w-64"
    >
      <ChartTooltipHeading>{label}</ChartTooltipHeading>
      <div className="flex flex-col gap-1">
        {payload.map((entry) => {
          const key = String(entry.dataKey ?? "");
          const line = lines.find((item) => item.key === key);
          const value = Number(entry.value);
          return (
            <ChartTooltipRow
              key={key}
              label={entry.name}
              value={formatBytes(Number.isFinite(value) ? value : 0)}
              marker={<LineMark line={line} />}
            />
          );
        })}
      </div>
    </ChartTooltipShell>
  );
}

/** 悬停参考线：只留 1px 竖线，不盖住折线本身（与延迟趋势图一致）。 */
function TrendCursor({
  x = 0,
  y = 0,
  height = 0,
}: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}) {
  return (
    <line
      x1={x}
      x2={x}
      y1={y}
      y2={y + height}
      stroke={CHART_CURSOR_STROKE}
      strokeOpacity={CHART_CURSOR_OPACITY}
      strokeWidth={1}
      pointerEvents="none"
    />
  );
}

/**
 * 协议趋势折线图：每种协议每天的下行流量。
 *
 * 区分方式同时用**明度**和**线型**：颜色是 primary 的四档明度
 * （`--series-1` … `--series-4`），线型是实线 / 虚线 / 点线 / 点划线。
 * 不再靠透明度：低透明度会把最次要的一条压到 3:1 以下，深色底上几乎看不见。
 * 色盲和黑白截图里也能靠线型分辨。
 *
 * 最多 4 条线（含 other），由 `protocolTrend()` 兜底合并。
 */
export default function ProtocolTrendChart({
  series,
}: {
  series: readonly OverviewProtocolSeries[];
}) {
  const { t } = useI18n();
  const trend = protocolTrend(series);
  // 纵轴上界取所有协议里的最大日流量，步长按 1024 单位取整齐值。
  let dataMax = 0;
  for (const row of trend.rows) {
    for (const line of trend.lines) {
      const value = Number(row[line.key] ?? 0);
      if (Number.isFinite(value)) dataMax = Math.max(dataMax, value);
    }
  }
  const scale = byteAxisScale(dataMax);

  if (trend.lines.length === 0) {
    return (
      <div className="flex h-[220px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 text-center">
        <ChartLineIcon className="icon-lg text-muted-foreground" />
        <p className="text-sm font-medium">{t("overview.protocolTrendEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-protocol-trend-chart>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {trend.lines.map((line) => (
          <span
            key={line.key}
            data-series={line.key}
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          >
            <LineMark line={line} />
            <span className="max-w-28 truncate">
              {t(protocolLabel(line.protocol))}
            </span>
          </span>
        ))}
      </div>

      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={trend.rows}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            // 保留有名称的 role=img；键盘左右键可在日期间移动并显示 tooltip。
            {...({
              role: "img",
              "aria-label": t("overview.protocolTrendAria"),
              accessibilityLayer: true,
            } as Record<string, unknown>)}
          >
            <ChartGrid />
            <XAxis
              dataKey="day"
              tickFormatter={formatDayTick}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              dy={6}
            />
            <YAxis
              domain={[0, scale.max]}
              ticks={scale.ticks}
              tickFormatter={formatByteAxisTick}
              axisLine={false}
              tickLine={false}
              width={64}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            <Tooltip
              cursor={<TrendCursor />}
              content={<ProtocolTrendTooltip lines={trend.lines} />}
            />
            {trend.lines.map((line) => (
              <Line
                key={line.key}
                type="monotone"
                dataKey={line.key}
                name={t(protocolLabel(line.protocol))}
                stroke={seriesColor(line.tone)}
                strokeWidth={1.5}
                strokeDasharray={line.dash}
                dot={
                  trend.rows.length === 1
                    ? {
                        r: 2.5,
                        fill: "var(--card)",
                        stroke: seriesColor(line.tone),
                        strokeWidth: 1.5,
                      }
                    : false
                }
                activeDot={{
                  r: 3,
                  fill: seriesColor(line.tone),
                  stroke: "var(--card)",
                  strokeWidth: 1.5,
                }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* 读屏 / 键盘用户的完整取数入口：图表不是唯一方式。 */}
      <div className="sr-only">
        <table className="w-full text-xs">
          <caption>{t("overview.protocolTrendDataCaption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("overview.protocolTrendDay")}</th>
              {trend.lines.map((line) => (
                <th key={line.key} scope="col">
                  {t(protocolLabel(line.protocol))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trend.rows.map((row: ProtocolTrendPoint) => (
              <tr key={String(row.day)}>
                <th scope="row">{row.day}</th>
                {trend.lines.map((line) => (
                  <td key={line.key}>
                    {formatBytes(Number(row[line.key] ?? 0))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
