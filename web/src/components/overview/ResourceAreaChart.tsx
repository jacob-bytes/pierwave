import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
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

/** 多序列面积图的固定色板；全部走 shadcn chart token，不写死色值。 */
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
      <p className="mb-2 font-mono text-[10px] text-muted-foreground">
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
        <p className="mt-1 text-[9px] text-muted-foreground">
          {t("overview.serverHealth.loadApproxTooltip")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 「当前资源」的多序列面积图。
 *
 * y 轴统一为百分比：内存 / 硬盘直接用占用比；负载按 `load1 / 8` 近似
 * （没有 CPU 核数），tooltip 与卡片脚注会说明。无采样的点保持 null，
 * Recharts 会断开而不是画一条 0 线。
 */
export function ResourceAreaChart({
  data,
  metric,
}: {
  data: ResourceChartData;
  metric: ResourceMetric;
}) {
  useI18n();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-2">
        {data.series.map((series, index) => {
          const hiddenHere = hidden.has(series.id);
          return (
            <button
              key={series.id}
              type="button"
              onClick={() => toggle(series.id)}
              aria-pressed={!hiddenHere}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-[10px] transition-opacity duration-150",
                hiddenHere ? "opacity-35" : "opacity-100",
              )}
              title={series.name}
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
            <AreaChart
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
                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[
                  0,
                  (dataMax: number) =>
                    Math.min(
                      100,
                      Math.max(10, Math.ceil(dataMax / 10) * 10),
                    ),
                ]}
                tickFormatter={(value: number) => `${value}%`}
                width={34}
                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
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
                  <Area
                    key={series.id}
                    type="monotone"
                    dataKey={series.id}
                    name={series.name}
                    stroke={color}
                    fill={color}
                    fillOpacity={metric === "load" ? 0.1 : 0.14}
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={{ r: 3 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                );
              })}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
