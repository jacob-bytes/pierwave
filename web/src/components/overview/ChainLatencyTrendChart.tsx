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
import {
  buildChainTrendData,
  chainHasTrend,
  chainLossAt,
  formatChainTime,
  formatLossPct,
  formatMs,
  type ChainHealthChain,
  type ChainTrendRow,
} from "@/lib/chainHealth";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { seriesVisual } from "@/lib/seriesStyle";
import { t, useI18n } from "@/i18n";

interface LineVisual {
  color: string;
  opacity: number;
  dash?: string;
}

/**
 * 正常序列用 `--series-1..4` + 线型；样本不足的图例项灰显。
 * 变慢不再换色相：颜色只负责区分序列，状态由「变慢」徽章与 tooltip 文案表达。
 */
function lineVisual(index: number, muted = false): LineVisual {
  if (muted) {
    return { color: "var(--muted-foreground)", opacity: 0.55 };
  }
  return seriesVisual(index);
}

function LineSwatch({ visual }: { visual: LineVisual }) {
  return (
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
  );
}

function ChainTrendLegend({
  chains,
  hidden,
  onToggle,
}: {
  chains: readonly ChainHealthChain[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div
      data-chain-trend-legend
      role="group"
      aria-label={t("overview.chainLatency.legendAria")}
      className="flex max-h-24 flex-wrap content-start gap-x-3 gap-y-1 overflow-y-auto pb-2"
    >
      {chains.map((chain, index) => {
        const hasTrend = chainHasTrend(chain);
        const hiddenHere = hasTrend && hidden.has(chain.id);
        const visual = lineVisual(index, !hasTrend);
        return (
          <button
            key={chain.id}
            type="button"
            disabled={!hasTrend}
            aria-pressed={hasTrend ? !hiddenHere : undefined}
            data-chain-legend-item
            data-chain-id={chain.id}
            data-has-samples={hasTrend ? "true" : "false"}
            data-hidden={hiddenHere ? "true" : "false"}
            onClick={() => {
              if (hasTrend) onToggle(chain.id);
            }}
            className={cn(
              "inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] transition-opacity duration-150",
              hasTrend
                ? hiddenHere
                  ? "opacity-35 hover:opacity-60"
                  : "opacity-100 hover:bg-muted/40"
                : "cursor-default opacity-50",
            )}
          >
            <LineSwatch visual={visual} />
            <span className="max-w-40 truncate" title={chain.name}>
              {chain.name}
            </span>
            {hasTrend ? null : (
              <span className="shrink-0 text-muted-foreground">
                {t("overview.chainLatency.noSamplesShort")}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface TooltipItem {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
}

function ChainTrendTooltip({
  active,
  payload,
  label,
  chains,
  bucket,
}: {
  active?: boolean;
  payload?: TooltipItem[];
  label?: number | string;
  chains: readonly ChainHealthChain[];
  bucket: number;
}) {
  if (!active || !payload?.length) return null;

  const hoveredTs = Number(label);
  const byId = new Map(chains.map((chain, index) => [chain.id, { chain, index }]));
  const rows = payload
    .map((item) => {
      const entry = byId.get(String(item.dataKey));
      if (!entry) return null;
      const raw = item.value;
      const numeric =
        raw === null || raw === undefined || raw === ""
          ? null
          : Number(raw);
      return {
        ...entry,
        value:
          numeric !== null && Number.isFinite(numeric) ? numeric : null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => {
      if (a.value === null && b.value === null) {
        return a.chain.name.localeCompare(b.chain.name);
      }
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return b.value - a.value || a.chain.name.localeCompare(b.chain.name);
    });
  if (rows.length === 0) return null;
  const highestIndex = rows.findIndex((row) => row.value !== null);

  return (
    <div
      data-chain-trend-tooltip
      role="tooltip"
      aria-live="polite"
      className="min-w-52 max-w-64 rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-lg/40"
    >
      <p className="mb-2 font-mono text-[10px] text-muted-foreground">
        {formatChainTime(Number(label), bucket)}
      </p>
      <div className="flex flex-col gap-1">
        {rows.map((row, index) => {
          const highest = index === highestIndex;
          const visual = lineVisual(row.index);
          return (
            <div
              key={row.chain.id}
              data-chain-tooltip-row
              data-chain-id={row.chain.id}
              data-highest={highest ? "true" : undefined}
              className={cn(
                "flex items-center justify-between gap-5 rounded-sm px-1 py-0.5",
                highest && "bg-primary/5",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <LineSwatch visual={visual} />
                <span className="truncate" title={row.chain.name}>
                  {row.chain.name}
                </span>
              </span>
              <span
                className={cn(
                  "flex shrink-0 flex-col items-end font-mono tabular-nums",
                  row.chain.slow ? "text-warning" : "text-foreground",
                  highest && "font-medium",
                )}
              >
                <span className="flex items-center gap-1">
                  {formatMs(row.value)}
                  {highest ? (
                    <span
                      className={cn(
                        "font-sans text-[9px]",
                        row.chain.slow ? "text-warning" : "text-primary",
                      )}
                    >
                      {t("overview.chainLatency.highest")}
                    </span>
                  ) : null}
                </span>
                <span
                  data-chain-tooltip-loss
                  className="font-sans text-[9px] font-normal text-muted-foreground"
                >
                  {t("overview.chainLatency.lossAtTime")}{" "}
                  {formatLossPct(
                    Number.isFinite(hoveredTs)
                      ? chainLossAt(row.chain, hoveredTs)
                      : null,
                  )}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function axisTick(ts: number, bucket: number): string {
  const text = formatChainTime(ts, bucket);
  return bucket >= 3600 ? text.slice(0, 5) : text.slice(6);
}

/**
 * 折线图的纯文本替代：时间 + 每条可见序列的 P50。
 * 窄屏（390px）由外层横向滚动，不把 7 天 × 多条链挤成不可读的细线。
 */
function ChainTrendTable({
  rows,
  chains,
  bucket,
}: {
  rows: readonly ChainTrendRow[];
  chains: readonly ChainHealthChain[];
  bucket: number;
}) {
  return (
    <div
      data-chain-trend-table
      className="max-h-[280px] overflow-auto rounded-md border border-border"
    >
      <table className="w-full min-w-[560px] border-collapse text-left text-[10px] tabular-nums">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b border-border">
            <th scope="col" className="px-2 py-1.5 font-medium text-muted-foreground">
              {t("overview.chainLatency.colTime")}
            </th>
            {chains.map((chain) => (
              <th
                key={chain.id}
                scope="col"
                className="px-2 py-1.5 font-medium text-muted-foreground"
              >
                <span className="block max-w-40 truncate" title={chain.name}>
                  {chain.name}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ts} className="border-b border-border/60 last:border-0">
              <th
                scope="row"
                className="whitespace-nowrap px-2 py-1 font-mono font-normal text-muted-foreground"
              >
                {formatChainTime(row.ts, bucket)}
              </th>
              {chains.map((chain) => {
                const value = row[chain.id];
                return (
                  <td key={chain.id} className="whitespace-nowrap px-2 py-1 font-mono">
                    {formatMs(typeof value === "number" ? value : null)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 列表页的多序列整体时延折线：一条链一条线。
 *
 * 只画有整体曲线的链；空样本链保留在图例里灰显并标「样本不足」。
 * 序列用 `--series-1..4` + 第 2 条起的线型区分，超过 4 条再用不透明度阶梯。
 */
export function ChainLatencyTrendChart({
  chains,
  bucket,
}: {
  chains: readonly ChainHealthChain[];
  bucket: number;
}) {
  useI18n();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [tableView, setTableView] = useState(false);
  const data = useMemo(() => buildChainTrendData(chains), [chains]);
  const visible = data.series.filter((chain) => !hidden.has(chain.id));
  // 7d 用日界刻度：小时桶直接按默认刻度会连续出现同一个 MM/DD。
  const xTicks = useMemo(() => {
    if (bucket < 3600 || data.rows.length === 0) return undefined;
    // 只取日界，不再追加最后一个点：末尾标签会贴住右边缘被裁掉。
    return data.rows
      .filter((_row, index) => index % 24 === 0)
      .map((row) => row.ts);
  }, [bucket, data.rows]);

  function toggle(id: string) {
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div
      data-chain-trend-chart
      data-series-count={data.series.length}
      data-visible-count={visible.length}
      role="group"
      aria-label={t("overview.chainLatency.trendChartAria", {
        n: data.series.length,
      })}
    >
      <ChainTrendLegend chains={chains} hidden={hidden} onToggle={toggle} />
      <div className="flex items-center justify-between gap-2 pb-1">
        <p
          data-chain-trend-hint
          className="flex-1 truncate text-[9px] text-muted-foreground"
        >
          {t("overview.chainLatency.hoverLossHint")}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-chain-table-toggle
          aria-pressed={tableView}
          onClick={() => setTableView((value) => !value)}
          className="h-7 shrink-0 px-2 text-[10px] font-normal"
        >
          {t(
            tableView
              ? "overview.chainLatency.chartView"
              : "overview.chainLatency.tableView",
          )}
        </Button>
      </div>
      {data.series.length === 0 ? (
        <div className="flex h-[220px] items-center justify-center text-xs text-muted-foreground">
          {t("overview.chainLatency.noSamplesShort")}
        </div>
      ) : visible.length === 0 ? (
        <div className="flex h-[220px] items-center justify-center text-xs text-muted-foreground">
          {t("overview.chainLatency.allHidden")}
        </div>
      ) : tableView ? (
        <ChainTrendTable rows={data.rows} chains={visible} bucket={bucket} />
      ) : (
        <div className="h-[220px] w-full sm:h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={data.rows}
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
                tickFormatter={(value: number) => axisTick(value, bucket)}
                minTickGap={bucket >= 3600 ? 40 : 30}
                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[0, "auto"]}
                width={48}
                tickFormatter={(value: number) => `${Math.round(value)}ms`}
                tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                content={
                  <ChainTrendTooltip chains={chains} bucket={bucket} />
                }
                cursor={{
                  stroke: "var(--muted-foreground)",
                  strokeOpacity: 0.35,
                }}
              />
              {visible.map((chain) => {
                const index = chains.findIndex((item) => item.id === chain.id);
                const visual = lineVisual(Math.max(0, index));
                return (
                  <Line
                    key={chain.id}
                    type="monotone"
                    dataKey={chain.id}
                    name={chain.name}
                    stroke={visual.color}
                    strokeOpacity={visual.opacity}
                    strokeDasharray={visual.dash}
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
