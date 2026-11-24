import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ActivityIcon } from "lucide-react";
import { EmptyState } from "@/components/common";
import type {
  ResourceChartData,
  ResourceMetric,
} from "@/lib/serverHealth";
import { formatMonthDayHour } from "@/lib/serverHealth";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** 多序列折线图的固定色板；全部走 shadcn chart token，不写死色值。 */
const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

interface TooltipItem {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
}

function ResourceTooltip({
  active,
  payload,
  label,
  metric,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: number | string;
  metric?: ResourceMetric;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter(
    (item) => typeof item.value === "number" && Number.isFinite(item.value),
  );
  if (rows.length === 0) return null;

  return (
    <div className="min-w-44 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg/40">
      <p className="mb-2 font-mono text-[11px] text-muted-foreground">
        {formatMonthDayHour(Number(label))}
      </p>
      <div className="flex flex-col gap-1">
        {rows.map((item) => (
          <div
            key={String(item.dataKey)}
            className="flex items-center justify-between gap-6"
          >
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              <span className="truncate">{String(item.name ?? "")}</span>
            </span>
            <span className="shrink-0 font-mono text-foreground tabular-nums">
              {(item.value as number).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
      {metric === "load" ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t("overview.serverHealth.loadApproxTooltip")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 「当前资源」多序列折线图。
 *
 * 共用服务器筛选器的选中集合；默认只显示当前值最高的 5 台，
 * 其余选中项在图例里置灰，点一下即可显示。y 轴固定 0–100%。
 * 负载按 `load1 / 8` 近似（没有 CPU 核数），tooltip 与脚注会说明。
 */
export function ResourceLineChart({
  data,
  metric,
  defaultVisibleIds,
}: {
  data: ResourceChartData;
  metric: ResourceMetric;
  defaultVisibleIds: readonly string[];
}) {
  useI18n();
  const [hidden, setHidden] = useState<Set<string>>(
    () =>
      new Set(
        data.series
          .filter((series) => !defaultVisibleIds.includes(series.id))
          .map((series) => series.id),
      ),
  );
  const visible = data.series.filter((series) => !hidden.has(series.id));

  function toggle(id: string) {
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!data.hasData) {
    return (
      <EmptyState
        size="sm"
        icon={ActivityIcon}
        title={t("overview.serverHealth.resourceEmpty")}
        className="py-12"
      />
    );
  }

  return (
    <div data-resource-chart>
      <div
        className="flex max-h-24 flex-wrap items-center gap-x-3 gap-y-1 overflow-y-auto pb-2"
        data-resource-legend
      >
        {data.series.map((series, index) => {
          const hiddenHere = hidden.has(series.id);
          return (
            <button
              key={series.id}
              type="button"
              onClick={() => toggle(series.id)}
              aria-pressed={!hiddenHere}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] transition-opacity duration-150",
                hiddenHere ? "opacity-35" : "opacity-100",
              )}
              title={series.name}
              data-resource-legend-item
            >
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{
                  backgroundColor:
                    CHART_COLORS[index % CHART_COLORS.length],
                }}
              />
              <span className="max-w-32 truncate">{series.name}</span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          size="sm"
          icon={ActivityIcon}
          title={t("overview.serverHealth.resourceAllHidden")}
          className="py-12"
        />
      ) : (
        <div className="h-[220px] w-full sm:h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data.points}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
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
                tickFormatter={(value: number) =>
                  formatMonthDayHour(value).slice(0, 5)
                }
                minTickGap={44}
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
                content={<ResourceTooltip metric={metric} />}
                cursor={{
                  stroke: "var(--muted-foreground)",
                  strokeOpacity: 0.35,
                }}
              />
              {visible.map((series) => {
                const index = data.series.findIndex(
                  (item) => item.id === series.id,
                );
                const color =
                  CHART_COLORS[
                    (index < 0 ? 0 : index) % CHART_COLORS.length
                  ];
                return (
                  <Line
                    key={series.id}
                    type="monotone"
                    dataKey={series.id}
                    name={series.name}
                    stroke={color}
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
