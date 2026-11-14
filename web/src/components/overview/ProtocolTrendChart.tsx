import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartLineIcon } from "lucide-react";
import type { OverviewProtocolSeries } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import {
  protocolTrend,
  type ProtocolTrendLine,
  type ProtocolTrendPoint,
} from "@/lib/overview";
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
        stroke="var(--primary)"
        strokeOpacity={line?.opacity ?? 1}
        strokeWidth={1.5}
        strokeDasharray={line?.dash}
      />
    </svg>
  );
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
    <div className="min-w-44 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg/40">
      <p className="mb-2 font-medium text-foreground tabular-nums">{label}</p>
      <div className="flex flex-col gap-1">
        {payload.map((entry) => {
          const key = String(entry.dataKey ?? "");
          const line = lines.find((item) => item.key === key);
          const value = Number(entry.value);
          return (
            <div
              key={key}
              className="flex items-center justify-between gap-6"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <LineMark line={line} />
                <span className="truncate">{entry.name}</span>
              </span>
              <span className="font-mono text-foreground tabular-nums">
                {formatBytes(Number.isFinite(value) ? value : 0)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
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
      stroke="var(--muted-foreground)"
      strokeOpacity={0.45}
      strokeWidth={1}
      pointerEvents="none"
    />
  );
}

/**
 * 协议趋势折线图：每种协议每天的下行流量。
 *
 * 区分方式以**线型**为主（实线 / 虚线 / 点线 / 点划线…），颜色统一用主色，
 * 透明度只做次级区分——与 `LatencyChart` 共用 `lineDashArray` / `lineOpacity`，
 * 色盲和黑白截图里也能看出是哪条线。
 *
 * 最多 5 条线（4 个协议 + other），由 `protocolTrend()` 兜底合并。
 */
export default function ProtocolTrendChart({
  series,
}: {
  series: readonly OverviewProtocolSeries[];
}) {
  const { t } = useI18n();
  const trend = protocolTrend(series);

  if (trend.lines.length === 0) {
    return (
      <div className="flex h-[220px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 text-center">
        <ChartLineIcon className="icon-lg text-muted-foreground" />
        <p className="text-sm font-medium">{t("overview.protocolTrendEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {trend.lines.map((line) => (
          <span
            key={line.key}
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
            <CartesianGrid
              vertical={false}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <XAxis
              dataKey="day"
              tickFormatter={formatDayTick}
              axisLine={false}
              tickLine={false}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              dy={6}
            />
            <YAxis
              tickFormatter={(value: number) => formatBytes(value)}
              axisLine={false}
              tickLine={false}
              tickCount={4}
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
                stroke="var(--primary)"
                strokeOpacity={line.opacity}
                strokeWidth={1.5}
                strokeDasharray={line.dash}
                dot={
                  trend.rows.length === 1
                    ? {
                        r: 2.5,
                        fill: "var(--card)",
                        stroke: "var(--primary)",
                        strokeWidth: 1.5,
                      }
                    : false
                }
                activeDot={{
                  r: 3,
                  fill: "var(--primary)",
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
