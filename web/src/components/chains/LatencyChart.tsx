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
import type { ChainLatencyPoint } from "@/lib/api";
import { bucketLabel, groupLatencyBySeq } from "@/lib/chainTopology";
import { useI18n } from "@/i18n";

/** 只用主色，靠透明度区分不同的跳；不引入新的色相。 */
const LINE_OPACITIES = [1, 0.72, 0.5, 0.34, 0.22];

function lineOpacity(index: number): number {
  return LINE_OPACITIES[Math.min(index, LINE_OPACITIES.length - 1)];
}

interface LatencyRow {
  ts: number;
  [key: string]: number;
}

/** 把按 seq 分组后的序列摊平成 recharts 需要的「一行一个时间点」。 */
function chartRows(points: readonly ChainLatencyPoint[]): {
  seqs: number[];
  rows: LatencyRow[];
} {
  const grouped = groupLatencyBySeq(points);
  const seqs = [...grouped.keys()].sort((a, b) => a - b);
  const byTs = new Map<number, LatencyRow>();

  for (const seq of seqs) {
    for (const point of grouped.get(seq) ?? []) {
      const row = byTs.get(point.ts) ?? { ts: point.ts };
      row[`hop${seq}`] = point.latency_ms;
      byTs.set(point.ts, row);
    }
  }

  return {
    seqs,
    rows: [...byTs.values()].sort((a, b) => a.ts - b.ts),
  };
}

interface TooltipEntry {
  name?: string;
  value?: number | string;
  dataKey?: string | number;
}

function LatencyTooltip({
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
  if (!active || !payload?.length) return null;

  return (
    <div className="min-w-36 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg/40">
      <p className="mb-2 font-medium text-foreground tabular-nums">
        {bucketLabel(Number(label), hours)}
      </p>
      <div className="flex flex-col gap-1">
        {payload.map((entry) => {
          if (typeof entry.value !== "number") return null;
          return (
            <div
              key={String(entry.dataKey ?? entry.name)}
              className="flex items-center justify-between gap-6"
            >
              <span className="text-muted-foreground">{entry.name}</span>
              <span className="font-mono text-foreground tabular-nums">
                {Math.round(entry.value)} ms
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 悬停参考线：只留 1px 竖线，不盖住折线本身（与概览页流量图一致）。 */
function LatencyCursor({
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
 * 延迟趋势折线图：每一跳一条线，颜色只用主色不同透明度。
 *
 * 数据量按 5 分钟桶：24h 最多 288 点、7d 最多 2016 点，所以不画散点，
 * 只保留折线和悬停点。空数据由调用方之外的这里兜底为空态。
 */
export default function LatencyChart({
  points,
  hours,
}: {
  points: readonly ChainLatencyPoint[];
  hours: number;
}) {
  const { t } = useI18n();
  const { seqs, rows } = chartRows(points);

  if (seqs.length === 0) {
    return (
      <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border text-center">
        <ActivityIcon className="icon-lg text-muted-foreground" />
        <p className="text-sm font-medium">{t("chains.detail.latencyEmpty")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {seqs.map((seq, index) => (
          <span
            key={seq}
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span
              aria-hidden="true"
              className="h-0.5 w-4 rounded-full"
              style={{
                backgroundColor: "var(--primary)",
                opacity: lineOpacity(index),
              }}
            />
            {t("chains.detail.hop", { seq: seq + 1 })}
          </span>
        ))}
      </div>

      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={rows}
            margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
            // 保留有名称的 role=img；键盘左右键可在时间点之间移动并显示 tooltip。
            {...({
              role: "img",
              "aria-label": t("chains.detail.latencyAria"),
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
              tickFormatter={(value: number) => `${Math.round(value)} ms`}
              axisLine={false}
              tickLine={false}
              tickCount={4}
              width={62}
              tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
            />
            <Tooltip
              cursor={<LatencyCursor />}
              content={<LatencyTooltip hours={hours} />}
            />
            {seqs.map((seq, index) => (
              <Line
                key={seq}
                type="monotone"
                dataKey={`hop${seq}`}
                name={t("chains.detail.hop", { seq: seq + 1 })}
                stroke="var(--primary)"
                strokeOpacity={lineOpacity(index)}
                strokeWidth={1.5}
                dot={false}
                activeDot={{
                  r: 3,
                  fill: "var(--primary)",
                  fillOpacity: lineOpacity(index),
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
    </div>
  );
}
