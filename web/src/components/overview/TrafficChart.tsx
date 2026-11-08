import { useId, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartColumnIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TrafficDay } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { t } from "@/i18n";

interface TooltipItem {
  payload?: TrafficDay;
}

interface TrafficTooltipProps {
  active?: boolean;
  payload?: TooltipItem[];
}

function formatDayTick(value: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${Number(match[1])}/${Number(match[2])}` : value;
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
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {color ? (
          <span
            aria-hidden="true"
            className="size-2 rounded-full"
            style={{ backgroundColor: color }}
          />
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
      </div>
    </div>
  );
}

/**
 * 流量趋势图。recharts 体积较大，这个文件只被概览页与「我的」页
 * 用 `lazy()` 动态加载，不会进入主 chunk。
 */
export default function TrafficChart({ days }: { days: TrafficDay[] }) {
  // 每个图表实例的 pattern id 唯一，避免同页多图时互相引用。
  const patternId = `pw-traffic-uplink-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const dataTableId = `pw-traffic-data-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [dataOpen, setDataOpen] = useState(false);
  const hasTraffic = days.some(
    (day) => day.downlink > 0 || day.uplink > 0,
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
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <LegendDot color="var(--primary)" label={t("trafficChart.downlink")} />
        <LegendDot
          color="var(--muted-foreground)"
          label={t("trafficChart.uplink")}
          pattern
        />
      </div>

      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={days}
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
              tickFormatter={(value: number) => formatBytes(value)}
              axisLine={false}
              tickLine={false}
              tickCount={4}
              width={64}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            <Tooltip
              cursor={<TrafficCursor />}
              content={<TrafficTooltip />}
            />
            <Bar
              dataKey="downlink"
              name={t("trafficChart.downlink")}
              stackId="traffic"
              fill="var(--primary)"
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
            <Bar
              dataKey="uplink"
              name={t("trafficChart.uplink")}
              stackId="traffic"
              fill={`url(#${patternId})`}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/*
        图表不是唯一的取数方式：键盘 / 读屏用户可以展开逐日数据表。
        默认折叠，按钮带 aria-expanded / aria-controls，表格本身可聚焦。
      */}
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          aria-expanded={dataOpen}
          aria-controls={dataTableId}
          onClick={() => setDataOpen((open) => !open)}
        >
          <ChartColumnIcon className="icon-md" aria-hidden="true" />
          {dataOpen
            ? t("trafficChart.hideData")
            : t("trafficChart.viewData")}
          <ChevronDownIcon
            className={cn(
              "icon-md transition-transform duration-150",
              dataOpen && "rotate-180",
            )}
            aria-hidden="true"
          />
        </Button>
        {dataOpen ? (
          <div className="overflow-x-auto rounded-md border border-border">
            <table
              id={dataTableId}
              tabIndex={0}
              data-slot="traffic-data-table"
              className="w-full text-xs"
            >
              <caption className="border-b border-border bg-muted/30 px-3 py-2 text-left text-muted-foreground">
                {t("trafficChart.dataTableCaption")}
              </caption>
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">
                    {t("trafficChart.date")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t("trafficChart.downlink")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t("trafficChart.uplink")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {days.map((day) => (
                  <tr
                    key={day.date}
                    className="border-b border-border last:border-0"
                  >
                    <th
                      scope="row"
                      className="px-3 py-1.5 text-left font-mono font-normal text-muted-foreground"
                    >
                      {day.date}
                    </th>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {formatBytes(day.downlink)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                      {formatBytes(day.uplink)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}
