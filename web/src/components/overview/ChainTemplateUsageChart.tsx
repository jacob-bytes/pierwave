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
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChainLatencyRangeTabs } from "@/components/overview/ChainLatencyControls";
import {
  chainTemplateUsageHasData,
  chainTemplateUsageSeries,
  chainTemplateUsageUsers,
  type ChainTemplateDetail,
  type ChainTemplateSeriesPoint,
  type ChainTemplateUsageRange,
} from "@/lib/chainTemplateInsight";
import { formatChainTime } from "@/lib/chainHealth";
import { seriesVisual } from "@/lib/seriesStyle";
import { t, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { useChartEnterAnimation } from "@/lib/useChartEnterAnimation";

interface UsageRow {
  ts: number;
  chains: number;
  users: number;
}

interface TooltipRow {
  payload?: UsageRow;
}

function chipColor(index: number): string {
  return seriesVisual(index).color;
}

function LineKey({ index, label }: { index: number; label: string }) {
  const visual = seriesVisual(index);
  return (
    <span className="inline-flex items-center gap-1.5">
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
      {label}
    </span>
  );
}

/**
 * tooltip 除了该时刻的链数 / 用户数，还要列出「当时在用」的用户名。
 *
 * 契约只给最终用户列表（`users[]`）与聚合序列，没有逐用户时间线；因此这里
 * 显示当前用户并明确标注「当前」，不伪造历史归属。
 */
function UsageTooltip({
  active,
  payload,
  bucket,
  users,
}: {
  active?: boolean;
  payload?: TooltipRow[];
  bucket: number;
  users: ReturnType<typeof chainTemplateUsageUsers>;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div
      data-template-usage-tooltip
      role="tooltip"
      aria-live="polite"
      className="min-w-52 max-w-72 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg/40"
    >
      <p className="mb-2 font-mono text-[11px] text-muted-foreground">
        {formatChainTime(row.ts, bucket)}
      </p>
      <div className="flex flex-col gap-1">
        <div
          data-template-usage-tooltip-row
          data-series="chains"
          className="flex items-center justify-between gap-4"
        >
          <LineKey
            index={0}
            label={t("overview.chainTemplateInsight.usageChains")}
          />
          <span className="font-mono font-medium tabular-nums">{row.chains}</span>
        </div>
        <div
          data-template-usage-tooltip-row
          data-series="users"
          className="flex items-center justify-between gap-4"
        >
          <LineKey
            index={1}
            label={t("overview.chainTemplateInsight.usageUsers")}
          />
          <span className="font-mono font-medium tabular-nums">{row.users}</span>
        </div>
      </div>
      <div
        data-template-usage-tooltip-users
        className="mt-2 border-t border-border/60 pt-2"
      >
        <p className="text-[11px] text-muted-foreground">
          {t("overview.chainTemplateInsight.usageCurrentUsers")}
        </p>
        {users.users.length === 0 ? (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("overview.chainTemplateInsight.usageNoUsers")}
          </p>
        ) : (
          <ul className="mt-1 flex max-h-28 flex-wrap gap-x-2 gap-y-1 overflow-y-auto">
            {users.users.map((user) => (
              <li
                key={user.id}
                data-template-usage-user
                className="inline-flex min-w-0 max-w-full items-baseline gap-1 rounded-sm bg-muted/50 px-1.5 py-0.5"
                title={t("overview.chainTemplateInsight.memberChains", {
                  n: user.chains,
                })}
              >
                <span className="truncate text-[11px]">{user.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                  {user.chains}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function axisTick(
  ts: number,
  range: ChainTemplateUsageRange,
): string {
  const text = formatChainTime(ts, 900);
  // 24h 内看时分，7 天看日期——否则跨天的刻度会重复成同一个时刻。
  return range === "24h" ? text.slice(6) : text.slice(0, 5);
}

/**
 * 模板使用量：链数 / 用户数两条线，跟随 24h / 7d。
 *
 * x = 时间；y = 计数；tooltip 同时给出该时刻两个值 + 当前用户名单。
 * 空序列显示「暂无使用记录」，不画一条贴底的假 0 线。
 */
export function ChainTemplateUsageChart({
  detail,
  range,
  onRangeChange,
  className,
}: {
  detail: ChainTemplateDetail;
  range: ChainTemplateUsageRange;
  onRangeChange: (range: ChainTemplateUsageRange) => void;
  className?: string;
}) {
  useI18n();
  const chartEnter = useChartEnterAnimation();
  // 后端两种窗口都用 15 分钟桶（168h = 672 点），x 轴格式化保持一致。
  const bucket = 900;
  // 窗口锚点只在挂载时取一次，避免每次渲染都重算时窗（也避免渲染期读时钟）。
  const [nowTs] = useState(() => Math.floor(Date.now() / 1000));
  const usage = useMemo(
    () => chainTemplateUsageSeries(detail.series, range, nowTs),
    [detail.series, range, nowTs],
  );
  const users = useMemo(() => chainTemplateUsageUsers(detail), [detail]);
  const data = useMemo<ChainTemplateSeriesPoint[]>(
    () =>
      usage.points.map((point) => ({
        ts: point.ts,
        chains: point.chains,
        users: point.users,
      })),
    [usage.points],
  );
  const hasData = data.length > 0 && chainTemplateUsageHasData(data);
  // 7 天只给每天一个刻度，避免同一天出现两个「11/23」。
  const xTicks = useMemo(() => {
    if (range === "24h" || data.length === 0) return undefined;
    const byDay = new Map<string, number>();
    for (const point of data) {
      const text = formatChainTime(point.ts, 900);
      const day = text.slice(0, 5);
      // 只取每天 00:00 的桶：起始半天会把「11/17 22:15」和「11/18」挤在一起。
      if (text.slice(6) === "00:00" && !byDay.has(day)) {
        byDay.set(day, point.ts);
      }
    }
    return byDay.size > 0 ? [...byDay.values()] : [data[0].ts];
  }, [data, range]);

  return (
    <Card className={cn("min-w-0 gap-0", className)} data-template-usage-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="text-sm font-medium">
              {t("overview.chainTemplateInsight.usageTitle")}
            </CardTitle>
            <Badge
              variant="outline"
              className="font-normal text-muted-foreground"
              title={t("overview.chainTemplateInsight.usageCumulativeHint")}
            >
              {t("overview.chainTemplateInsight.usageCumulative")}
            </Badge>
          </div>
          <ChainLatencyRangeTabs range={range} onRangeChange={onRangeChange} />
        </div>
        {hasData ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <LineKey
              index={0}
              label={t("overview.chainTemplateInsight.usageChains")}
            />
            <LineKey
              index={1}
              label={t("overview.chainTemplateInsight.usageUsers")}
            />
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="min-w-0 p-2 sm:p-4">
        {hasData ? (
          <div className="h-[260px] w-full sm:h-[280px]">
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
                  tickFormatter={(value: number) => axisTick(value, range)}
                  minTickGap={xTicks ? 8 : 32}
                  tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, "auto"]}
                  allowDecimals={false}
                  width={36}
                  tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  content={
                    <UsageTooltip bucket={bucket} users={users} />
                  }
                  cursor={{
                    stroke: "var(--muted-foreground)",
                    strokeOpacity: 0.35,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="chains"
                  name={t("overview.chainTemplateInsight.usageChains")}
                  stroke={chipColor(0)}
                  strokeOpacity={seriesVisual(0).opacity}
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3 }}
                  isAnimationActive={chartEnter.isAnimationActive}
                  animationDuration={chartEnter.animationDuration}
                  animationEasing={chartEnter.animationEasing}
                  onAnimationEnd={chartEnter.onAnimationEnd}
                />
                <Line
                  type="monotone"
                  dataKey="users"
                  name={t("overview.chainTemplateInsight.usageUsers")}
                  stroke={chipColor(1)}
                  strokeOpacity={seriesVisual(1).opacity}
                  strokeDasharray={seriesVisual(1).dash}
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3 }}
                  isAnimationActive={chartEnter.isAnimationActive}
                  animationDuration={chartEnter.animationDuration}
                  animationEasing={chartEnter.animationEasing}
                  onAnimationEnd={chartEnter.onAnimationEnd}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div
            data-template-usage-empty
            className={cn(
              "flex h-[260px] items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground sm:h-[280px]",
            )}
          >
            {t("overview.chainTemplateInsight.usageEmpty")}
          </div>
        )}
        {detail.seriesBasis === "existing_chains" ? (
          <p
            data-template-usage-basis
            className="mt-1.5 text-[11px] leading-normal text-muted-foreground"
          >
            {t("overview.chainTemplateInsight.usageExistingChainsBasis")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
