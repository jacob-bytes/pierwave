import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartColumnIcon } from "lucide-react";
import type { TrafficDay } from "@/lib/api";
import { formatBytes } from "@/lib/format";

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

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden="true"
        className="size-2 rounded-full"
        style={{ backgroundColor: color }}
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

function TrafficTooltip({ active, payload }: TrafficTooltipProps) {
  if (!active || !payload?.length) return null;
  const day = payload[0]?.payload;
  if (!day) return null;

  return (
    <div className="min-w-44 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg/40">
      <p className="mb-2 font-medium text-foreground">{day.date}</p>
      <div className="flex flex-col gap-1">
        <TooltipValue
          label="下行"
          value={day.downlink}
          color="var(--primary)"
        />
        <TooltipValue
          label="上行"
          value={day.uplink}
          color="var(--muted-foreground)"
        />
        <div className="my-1 h-px bg-border" />
        <TooltipValue label="计费流量" value={day.weighted} />
      </div>
    </div>
  );
}

/**
 * 流量趋势图。recharts 体积较大，这个文件只被概览页与「我的」页
 * 用 `lazy()` 动态加载，不会进入主 chunk。
 */
export default function TrafficChart({ days }: { days: TrafficDay[] }) {
  const hasTraffic = days.some(
    (day) => day.downlink > 0 || day.uplink > 0,
  );
  if (!days.length || !hasTraffic) {
    return (
      <div className="flex h-[248px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 text-center">
        <ChartColumnIcon className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">近 7 天还没有流量记录</p>
        <p className="text-xs text-muted-foreground">
          节点产生流量后，这里会自动出现趋势。
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <LegendDot color="var(--primary)" label="下行" />
        <LegendDot color="var(--muted-foreground)" label="上行" />
      </div>

      <div
        className="h-[220px] w-full"
        role="img"
        aria-label="近 7 天上下行流量柱状图"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={days}
            margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
            barCategoryGap="28%"
          >
            <CartesianGrid
              vertical={false}
              stroke="var(--border)"
              strokeDasharray="3 3"
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
              width={64}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            <Tooltip
              cursor={{ fill: "var(--muted)", fillOpacity: 0.35 }}
              content={<TrafficTooltip />}
            />
            <Bar
              dataKey="downlink"
              name="下行"
              stackId="traffic"
              fill="var(--primary)"
              isAnimationActive={false}
            />
            <Bar
              dataKey="uplink"
              name="上行"
              stackId="traffic"
              fill="var(--muted-foreground)"
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
