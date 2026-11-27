import { useMemo } from "react";
import {
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ActivityIcon, TriangleAlertIcon } from "lucide-react";
import { EmptyState } from "@/components/common";
import {
  formatMonthDayHour,
  formatOnlineCount,
  offlineServerNamePreview,
  type UptimeTrend,
  type UptimeTrendPoint,
} from "@/lib/serverHealth";
import { timeAxisTicks } from "@/lib/chartAxis";
import { ChartGrid } from "./ChartGrid";
import {
  ChartTooltipHeading,
  ChartTooltipRow,
  ChartTooltipShell,
} from "./ChartTooltipShell";
import { CHART_CURSOR } from "./chartTheme";
import { t, useI18n } from "@/i18n";
import { useChartEnterAnimation } from "@/lib/useChartEnterAnimation";

interface TooltipPayload {
  payload?: UptimeTrendPoint;
}

/**
 * 在线率趋势的 tooltip：该小时聚合在线率、在线台数 / 有采样的台数，
 * 以及多数采样离线的服务器名（最多 3 个，其余折成 +N）。
 */
function UptimeTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point || point.pct === null) return null;
  const { names, extra } = offlineServerNamePreview(point.offlineServers);
  const offlineText =
    point.offlineServers.length === 0
      ? null
      : [
          names.join(" · "),
          extra > 0
            ? t("overview.serverHealth.trendOfflineMore", { n: extra })
            : null,
        ]
          .filter(Boolean)
          .join(" ");

  return (
    <ChartTooltipShell
      data-uptime-tooltip
      role="tooltip"
      className="max-w-64"
    >
      <ChartTooltipHeading>{formatMonthDayHour(point.ts)}</ChartTooltipHeading>
      <ChartTooltipRow
        label={t("overview.serverHealth.metricUptime")}
        value={`${point.pct.toFixed(1)}%`}
      />
      <div className="mt-1 flex items-center justify-between gap-6">
        <span className="text-muted-foreground">
          {t("overview.serverHealth.trendServers", {
            online: formatOnlineCount(point.onlineServers),
            total: point.totalServers,
          })}
        </span>
      </div>
      {offlineText === null ? null : (
        <p
          className="mt-1 truncate text-[11px] text-muted-foreground"
          title={point.offlineServers.join(" · ")}
        >
          {t("overview.serverHealth.trendOffline", { names: offlineText })}
        </p>
      )}
    </ChartTooltipShell>
  );
}

/**
 * 「服务器 × 时间」的趋势视图：所选服务器按小时聚合的在线率折线。
 *
 * - x 轴与热力图同一窗口（168 个 1 小时桶），y 轴固定 0–100%；
 * - 空桶 `pct = null` 且 `connectNulls={false}`，折线断开，不画成 0；
 * - 异常时段用 primary 低透明度阴影标出，语义沿用「异常窗口」里的离线窗口。
 */
export function ServerUptimeTrendChart({
  trend,
  approximate = false,
}: {
  trend: UptimeTrend;
  /** 旧主控缺桶内 online_ratio：与热力图用同一个「近似」标记。 */
  approximate?: boolean;
}) {
  useI18n();
  const chartEnter = useChartEnterAnimation();
  const { points } = trend;
  const first = points[0]?.ts;
  const last = points.at(-1)?.ts;
  const step =
    points.length > 1 && points[1].ts > points[0].ts
      ? points[1].ts - points[0].ts
      : 3600;
  /**
   * x 轴每天一个刻度（窗口 ≤24h 时退到每 6 小时的时刻刻度），
   * 标签不再靠 `MM/DD HH:00` 截前 5 位，避免同一天出现两个「11/18」。
   */
  const axisTicks = useMemo(
    () => (first === undefined || last === undefined ? [] : timeAxisTicks(first, last)),
    [first, last],
  );
  const axisLabels = useMemo(
    () => new Map(axisTicks.map((tick) => [tick.ts, tick.label])),
    [axisTicks],
  );

  if (!trend.hasData) {
    return (
      <EmptyState
        size="sm"
        icon={ActivityIcon}
        title={t("overview.serverHealth.trendEmpty")}
        className="py-12"
      />
    );
  }

  return (
    <div data-uptime-trend>
      <div
        role="img"
        aria-label={t("overview.serverHealth.trendAria")}
        className="h-[220px] w-full sm:h-[260px]"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={points}
            margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
          >
            <ChartGrid />
            {/* 阴影先画，折线压在上面；区间末尾补满最后一个桶的宽度。 */}
            {trend.anomalyRanges.map((range) => (
              <ReferenceArea
                key={`${range.startTs}-${range.endTs}`}
                x1={range.startTs}
                x2={range.endTs + step}
                fill="var(--primary)"
                fillOpacity={0.14}
                stroke="none"
                data-uptime-anomaly
              />
            ))}
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              ticks={axisTicks.map((tick) => tick.ts)}
              interval={0}
              tickFormatter={(value: number) => axisLabels.get(value) ?? ""}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tickFormatter={(value: number) => `${value}%`}
              width={34}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              content={<UptimeTooltip />}
              cursor={CHART_CURSOR}
            />
            <Line
              type="monotone"
              dataKey="pct"
              name={t("overview.serverHealth.metricUptime")}
              stroke="var(--primary)"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3 }}
              connectNulls={false}
              isAnimationActive={chartEnter.isAnimationActive}
              animationDuration={chartEnter.animationDuration}
              animationEasing={chartEnter.animationEasing}
              onAnimationEnd={chartEnter.onAnimationEnd}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span
            aria-hidden="true"
            data-uptime-anomaly-legend
            className="size-2.5 rounded-[2px] bg-primary/15 ring-1 ring-primary/30"
          />
          {t("overview.serverHealth.trendAnomaly")}
        </span>
        <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
          {approximate ? (
            <span
              data-uptime-approx
              className="inline-flex items-center gap-1 whitespace-nowrap text-warning"
              title={t("overview.serverHealth.legendApproximateHint")}
            >
              <TriangleAlertIcon className="size-3" aria-hidden="true" />
              {t("overview.serverHealth.legendApproximate")}
            </span>
          ) : null}
          <span>
            {first === undefined || last === undefined
              ? t("overview.serverHealth.heatmapNoSamples")
              : t("overview.serverHealth.heatmapRange", {
                  start: formatMonthDayHour(first),
                  end: formatMonthDayHour(last),
                })}
          </span>
        </span>
      </div>
    </div>
  );
}
