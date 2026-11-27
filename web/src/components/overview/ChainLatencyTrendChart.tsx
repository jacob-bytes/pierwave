import { useCallback, useMemo, useState } from "react";
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type XAxisTickContentProps,
} from "recharts";
import {
  buildChainTrendData,
  chainLegendGroups,
  chainLossAt,
  chainTimeTicks,
  formatChainTime,
  formatLossPct,
  formatMs,
  type ChainHealthChain,
  type ChainTrendRow,
} from "@/lib/chainHealth";
import {
  chainTrendTimeDomain,
  selectChainTrendChains,
} from "@/lib/chainTrendSeries";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { lineVisual } from "@/lib/chainSeriesStyle";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { ChartGrid } from "./ChartGrid";
import { ChartTooltipHeading, ChartTooltipShell } from "./ChartTooltipShell";
import { LineSwatch } from "./ChainSeriesSwatch";
import { CHART_CURSOR } from "./chartTheme";
import { t, useI18n } from "@/i18n";
import { useChartEnterAnimation } from "@/lib/useChartEnterAnimation";

/**
 * 图例只保留一行「已选链」标签：横向滚动，永不折行。
 *
 * 24 条链的完整清单与搜索 / 全选 / 清空在卡头的多选下拉里；这里再列一遍
 * 只会把图表往下压。无样本链也不在这里出现，折叠在「N 条暂无样本」里。
 */
function ChainTrendSelectedLegend({
  chains,
  selected,
}: {
  chains: readonly ChainHealthChain[];
  selected: readonly ChainHealthChain[];
}) {
  if (selected.length === 0) return null;

  return (
    <div
      data-chain-trend-legend
      role="group"
      aria-label={t("overview.chainLatency.legendAria")}
      className="flex min-h-6 items-center gap-3 overflow-x-auto pb-2 whitespace-nowrap"
    >
      {selected.map((chain) => {
        const index = chains.findIndex((item) => item.id === chain.id);
        return (
          <span
            key={chain.id}
            data-chain-legend-item
            data-chain-id={chain.id}
            data-has-samples="true"
            className="inline-flex shrink-0 items-center gap-1.5 text-[11px]"
          >
            <LineSwatch visual={lineVisual(Math.max(0, index))} />
            <span className="max-w-40 truncate" title={chain.name}>
              {chain.name}
            </span>
          </span>
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
    <ChartTooltipShell
      data-chain-trend-tooltip
      role="tooltip"
      aria-live="polite"
      className="min-w-52 max-w-64"
    >
      <ChartTooltipHeading>
        {formatChainTime(Number(label), bucket)}
      </ChartTooltipHeading>
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
                        "font-sans text-[11px]",
                        row.chain.slow ? "text-warning" : "text-primary",
                      )}
                    >
                      {t("overview.chainLatency.highest")}
                    </span>
                  ) : null}
                </span>
                <span
                  data-chain-tooltip-loss
                  className="font-sans text-[11px] font-normal text-muted-foreground"
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
    </ChartTooltipShell>
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
      <table className="w-full min-w-[560px] border-collapse text-left text-[11px] tabular-nums">
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
 * 只画有整体曲线、且在卡头下拉里被勾选的链；无样本链不进入选择。
 * x 轴范围取**实际数据**的最早 / 最晚样本，而不是整个窗口的起止，
 * 窗口两端没有样本时也不会留下大段空白。
 */
export function ChainLatencyTrendChart({
  chains,
  bucket,
  selectedIds,
}: {
  chains: readonly ChainHealthChain[];
  bucket: number;
  /** 卡头多选下拉的当前选择；空数组时显示空态，不画全空线。 */
  selectedIds: readonly string[];
}) {
  useI18n();
  const chartEnter = useChartEnterAnimation();
  const [tableView, setTableView] = useState(false);
  const desktop = useIsDesktop();
  const groups = useMemo(() => chainLegendGroups(chains), [chains]);
  const selectedChains = useMemo(
    () => selectChainTrendChains(chains, selectedIds),
    [chains, selectedIds],
  );
  const data = useMemo(
    () => buildChainTrendData(selectedChains),
    [selectedChains],
  );
  /*
   * Recharts 把 SVG 标成 `role="application"` 并放进 Tab 序，但没有
   * `aria-label` 时读屏只会念坐标刻度。标签里带窗口与可见链数，切 24h/7d
   * 或在卡头勾选链时一起更新。Recharts 的类型里没有 `aria-label` 属性，
   * 因此通过 SVG ref 落到那个真实可聚焦的节点上。
   */
  const chartLabel = `${t("overview.chainLatency.trendChartAria", {
    n: selectedChains.length,
  })} · ${t(
    bucket >= 3_600
      ? "overview.chainLatency.range7d"
      : "overview.chainLatency.range24",
  )}`;
  const applyChartLabel = useCallback(
    (node: SVGSVGElement | null) => {
      node?.setAttribute("aria-label", chartLabel);
    },
    [chartLabel],
  );

  /**
   * 时间轴跟详情里的整体时延图共用一套刻度：24h 每 4h、7d 每 1d。
   * domain 收敛到有效样本的实际范围；末位刻度仍是最后一个真实样本。
   */
  const axis = useMemo(() => {
    const domain = chainTrendTimeDomain(data.series, bucket);
    if (domain === null) return null;
    const hours = bucket >= 3_600 ? 168 : 24;
    const ticks = chainTimeTicks(
      domain.startTs,
      domain.endTs,
      hours,
      bucket,
    );
    // 390 宽时 7 个标签会互相压住：丢掉最后一小段前的等距刻度，保留
    // 末位真实样本，仍不少于 5 个刻度。桌面保持完整间隔。
    const visibleTicks = desktop
      ? ticks
      : ticks.filter(
          (tick) =>
            tick.kind === "last" ||
            (tick.ts - domain.startTs) /
              (domain.endTs - domain.startTs) <=
              0.78,
        );
    return {
      ...domain,
      ticks: visibleTicks,
      labels: new Map(visibleTicks.map((tick) => [tick.ts, tick.label])),
    };
  }, [bucket, data.series, desktop]);

  /**
   * 只把落在数据区间内的行交给 recharts。
   *
   * 定长 `series` 在窗口首尾还有 `null` 空桶；即使显式写了 domain，
   * recharts 仍会按数据的 `ts` 扩展刻度范围，左右空白会原样回来。
   * 表格视图仍用完整 `data.rows`（窗口内空桶显示 `—`）。
   */
  const chartRows = useMemo(() => {
    if (axis === null) return data.rows;
    return data.rows.filter(
      (row) => row.ts >= axis.startTs && row.ts <= axis.endTs,
    );
  }, [axis, data.rows]);

  /**
   * 首尾刻度的标签贴边对齐：margin 收到 8–12px 后，居中排列的
   * `20:30` 会被 SVG 边缘裁掉几个像素。
   */
  function timeTick(props: XAxisTickContentProps) {
    const value = Number(props.payload?.value);
    const text = Number.isFinite(value)
      ? (axis?.labels.get(value) ?? axisTick(value, bucket))
      : "";
    const anchor =
      axis === null
        ? "middle"
        : value <= axis.startTs
          ? "start"
          : value >= axis.endTs
            ? "end"
            : "middle";
    return (
      <text
        x={props.x}
        y={props.y}
        dy={12}
        textAnchor={anchor}
        fill="var(--muted-foreground)"
        fontSize={11}
      >
        {text}
      </text>
    );
  }

  // x 轴的权威范围（= 有效样本实际范围）；截图脚本据此断言不再铺满窗口。
  return (
    <div
      data-chain-trend-chart
      data-series-count={groups.sampled.length}
      data-visible-count={selectedChains.length}
      data-axis-min={axis?.startTs ?? undefined}
      data-axis-max={axis?.endTs ?? undefined}
      role="group"
      aria-label={t("overview.chainLatency.trendChartAria", {
        n: groups.sampled.length,
      })}
    >
      <div className="flex items-center justify-between gap-2 pb-1">
        <p
          data-chain-trend-hint
          className="flex-1 truncate text-[11px] text-muted-foreground"
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
          className="h-7 shrink-0 px-2 text-[11px] font-normal"
        >
          {t(
            tableView
              ? "overview.chainLatency.chartView"
              : "overview.chainLatency.tableView",
          )}
        </Button>
      </div>
      {groups.sampled.length === 0 ? (
        <div className="flex h-[220px] items-center justify-center text-xs text-muted-foreground">
          {t("overview.chainLatency.noSamplesShort")}
        </div>
      ) : selectedChains.length === 0 ? (
        <div className="flex h-[220px] items-center justify-center text-xs text-muted-foreground">
          {t("overview.chainLatency.allHidden")}
        </div>
      ) : (
        <>
          {tableView ? (
            <ChainTrendTable
              rows={data.rows}
              chains={data.series}
              bucket={bucket}
            />
          ) : (
            <div className="h-[220px] w-full min-w-0 sm:h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  ref={applyChartLabel}
                  data={chartRows}
                  margin={{ top: 8, right: 12, left: 8, bottom: 0 }}
                >
                  <ChartGrid vertical />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    scale="time"
                    domain={
                      axis
                        ? [axis.startTs, axis.endTs]
                        : ["dataMin", "dataMax"]
                    }
                    ticks={axis?.ticks.map((tick) => tick.ts)}
                    interval={0}
                    tick={timeTick}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, "auto"]}
                    width={48}
                    tickFormatter={(value: number) => `${Math.round(value)}ms`}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    content={
                      <ChainTrendTooltip chains={chains} bucket={bucket} />
                    }
                    cursor={CHART_CURSOR}
                  />
                  {data.series.map((chain) => {
                    const index = chains.findIndex(
                      (item) => item.id === chain.id,
                    );
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
                        isAnimationActive={chartEnter.isAnimationActive}
                        animationDuration={chartEnter.animationDuration}
                        animationEasing={chartEnter.animationEasing}
                        onAnimationEnd={chartEnter.onAnimationEnd}
                      />
                    );
                  })}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <ChainTrendSelectedLegend chains={chains} selected={data.series} />
        </>
      )}
    </div>
  );
}
