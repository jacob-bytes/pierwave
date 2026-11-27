import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ActivityIcon } from "lucide-react";
import type { ChainProbePoint } from "@/lib/api";
import { bucketLabel } from "@/lib/chainTopology";
import { availabilityLabel, bucketLoss, lossLabel } from "@/lib/chainProbe";
import { useI18n } from "@/i18n";
import { useChartEnterAnimation } from "@/lib/useChartEnterAnimation";

interface ProbeRow {
  ts: number;
  loss: number;
  attempts: number;
  failures: number;
}

/** 只把有探测的桶画成点；丢失的桶不补 0（否则会画成「0% 丢包」）。 */
function chartRows(points: readonly ChainProbePoint[]): ProbeRow[] {
  return points
    .flatMap((point) => {
      const loss = point.loss ?? bucketLoss(point.attempts, point.failures);
      if (loss === null) return [];
      return [
        {
          ts: point.ts,
          loss: loss * 100,
          attempts: point.attempts,
          failures: point.failures,
        },
      ];
    })
    .sort((a, b) => a.ts - b.ts);
}

interface TooltipEntry {
  name?: string;
  value?: number | string;
  dataKey?: string | number;
  payload?: ProbeRow;
}

function ProbeTooltip({
  active,
  payload,
  label,
  hours,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: number | string;
  hours: number;
}) {
  const { t } = useI18n();
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  return (
    <div className="min-w-36 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg/40">
      <p className="mb-2 font-medium text-foreground tabular-nums">
        {bucketLabel(Number(label), hours)}
      </p>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-6">
          <span className="text-muted-foreground">
            {t("chains.detail.probe.loss")}
          </span>
          <span className="font-mono text-warning tabular-nums">
            {lossLabel(row.loss / 100)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-6">
          <span className="text-muted-foreground">
            {t("chains.detail.probe.attempts", { count: row.attempts })}
          </span>
          <span className="font-mono text-muted-foreground tabular-nums">
            {availabilityLabel(1 - row.failures / Math.max(row.attempts, 1))}
          </span>
        </div>
      </div>
    </div>
  );
}

function ProbeCursor({
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
 * 可用率折线图：y 轴是**探测失败率**（丢包近似）。
 *
 * 只画有探测的 5 分钟桶；阈值线用同一色系的虚线，不引入新色相。
 */
export default function ProbeChart({
  points,
  hours,
  thresholdPercent,
}: {
  points: readonly ChainProbePoint[];
  hours: number;
  thresholdPercent: number;
}) {
  const { t } = useI18n();
  const chartEnter = useChartEnterAnimation();
  const rows = chartRows(points);

  if (rows.length === 0) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
        <ActivityIcon className="icon-lg text-muted-foreground" />
        <p className="text-sm font-medium">{t("chains.detail.probe.empty")}</p>
      </div>
    );
  }

  // 丢包轴上限：取数据与阈值丢包中的较大者，保证阈值线可见。
  const thresholdLoss = Math.max(0, 100 - thresholdPercent);
  const maxLoss = Math.max(
    thresholdLoss,
    ...rows.map((row) => row.loss),
    0.5,
  );

  return (
    <div className="h-40 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={rows}
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          {...({
            role: "img",
            "aria-label": t("chains.detail.probe.aria"),
            accessibilityLayer: true,
          } as Record<string, unknown>)}
        >
          <CartesianGrid
            vertical={false}
            stroke="var(--border)"
            strokeWidth={1}
          />
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(value: number) => bucketLabel(value, hours)}
            axisLine={false}
            tickLine={false}
            tickCount={6}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            dy={6}
          />
          <YAxis
            domain={[0, Math.ceil(maxLoss * 10) / 10]}
            tickFormatter={(value: number) => lossLabel(value / 100)}
            axisLine={false}
            tickLine={false}
            tickCount={4}
            width={54}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <Tooltip
            cursor={<ProbeCursor />}
            content={<ProbeTooltip hours={hours} />}
          />
          <ReferenceLine
            y={thresholdLoss}
            stroke="var(--muted-foreground)"
            strokeDasharray="4 4"
            strokeOpacity={0.6}
          />
          <Line
            type="monotone"
            dataKey="loss"
            name={t("chains.detail.probe.loss")}
            stroke="var(--warning)"
            strokeWidth={1.5}
            dot={false}
            activeDot={{
              r: 3,
              fill: "var(--warning)",
              stroke: "var(--card)",
              strokeWidth: 1.5,
            }}
            connectNulls={false}
            isAnimationActive={chartEnter.isAnimationActive}
            animationDuration={chartEnter.animationDuration}
            animationEasing={chartEnter.animationEasing}
            onAnimationEnd={chartEnter.onAnimationEnd}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
