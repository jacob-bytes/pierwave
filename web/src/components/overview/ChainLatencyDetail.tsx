import { type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChainLatencySparkline } from "@/components/overview/ChainLatencyChart";
import {
  ChainLatencyRangeTabs,
  ChainLatencyUpdatedBadge,
} from "@/components/overview/ChainLatencyControls";
import { ChainLossValue } from "@/components/overview/ChainLossValue";
import { ChainSegmentTrendChart } from "@/components/overview/ChainSegmentTrendChart";
import { ChainStatusBadge } from "@/components/overview/ChainStatusBadge";
import { ChainFlowCard } from "@/components/overview/ChainFlowCard";
import { chainLastHopReasonText } from "@/lib/chainStatusText";
import {
  SLOW_CHAIN_DELTA_MS,
  chainDiagnosis,
  chainDiagnosisReason,
  chainHasMultiPathHop,
  chainLastHopUnmeasurable,
  chainLatestSeriesTs,
  chainLossTone,
  chainPointX,
  chainTimeTicks,
  formatChainClock,
  formatLossPct,
  formatLossProbes,
  formatMs,
  formatPercentValue,
  formatSignedMs,
  type ChainDiagnosisReason,
  type ChainDiagnosisView,
  type ChainHealthChain,
  type ChainHealthConfig,
  type ChainHealthPoint,
  type ChainHealthSegment,
  type ChainHealthSnapshot,
  type ChainLatencyRange,
  type ChainSeriesWindow,
  type ChainTimeTick,
} from "@/lib/chainHealth";
import { t, useI18n } from "@/i18n";
import { useIsDesktop } from "@/lib/useIsDesktop";
import { cn } from "@/lib/utils";

function diagnosisText(
  reason: ChainDiagnosisReason,
  view: ChainDiagnosisView,
): string {
  if (reason === "single_hop") {
    return t("overview.chainLatency.diagnosisSingle", {
      delta: formatSignedMs(view.overallDeltaMs),
      seq: view.seq ?? "—",
      segmentDelta: formatSignedMs(view.segmentDeltaMs),
      pct: formatPercentValue(view.contributionPct),
    });
  }
  if (reason === "overall") {
    if (view.overallDeltaMs === null || view.overallDeltaMs === 0) {
      return t("overview.chainLatency.diagnosisOverallFlat");
    }
    return t(
      view.overallDeltaMs > 0
        ? "overview.chainLatency.diagnosisOverallUp"
        : "overview.chainLatency.diagnosisOverallDown",
    );
  }
  if (reason === "stable") {
    return t("overview.chainLatency.diagnosisStable");
  }
  return t("overview.chainLatency.diagnosisUnknown");
}

function DiagnosisBlock({ chain }: { chain: ChainHealthChain }) {
  const diagnosis = chainDiagnosis(chain);
  const reason = chainDiagnosisReason(diagnosis, chain.hasSamples);
  const tone =
    reason === "unknown" || reason === "stable"
      ? "border-border bg-muted/30 text-muted-foreground"
      : "border-primary/30 bg-primary/10 text-foreground";
  return (
    <div
      data-chain-diagnosis
      data-kind={diagnosis.kind}
      role="status"
      className={cn(
        "mt-3 rounded-md border px-3 py-2 text-[13px] leading-normal",
        tone,
      )}
    >
      {diagnosisText(reason, diagnosis)}
    </div>
  );
}

/**
 * 整体时延图的时间轴：等距刻度 + 末位真实样本时间。
 *
 * 刻度位置与图内竖向 gridline 用同一个 `chainPointX`，所以文字不会和线错位。
 * 首尾标签分别左 / 右对齐，避免被卡片裁掉。
 */
function TimeAxis({
  ticks,
  window,
}: {
  ticks: readonly ChainTimeTick[];
  window: ChainSeriesWindow;
}) {
  const desktop = useIsDesktop();
  /*
   * 11px 的刻度比原来的 9px 宽约 22%。390 下相邻 4h 刻度的右边界会压到
   * 末位样本标签（实测 20:00 与 23:15 重叠 4px），所以窄屏隔一个显示：
   * 保留 00/08/16 与末位真实样本，桌面仍显示完整刻度。
   */
  const visibleTicks = desktop
    ? ticks
    : ticks.filter((tick, index) => {
        if (tick.kind === "last" || index === ticks.length - 1) return true;
        if (index % 2 !== 0) return false;
        return index <= ticks.length - 3;
      });
  return (
    <div
      data-chain-time-axis
      className="relative mt-1 h-3 font-mono text-[11px] text-muted-foreground tabular-nums"
    >
      {visibleTicks.map((tick) => {
        const left = chainPointX(tick.ts, window, 100);
        const transform =
          left < 4
            ? "translateX(0)"
            : left > 96
              ? "translateX(-100%)"
              : "translateX(-50%)";
        return (
          <span
            key={`${tick.kind}-${tick.ts}`}
            data-chain-time-tick
            data-kind={tick.kind}
            data-ts={tick.ts}
            className={cn(
              "absolute top-0 whitespace-nowrap",
              tick.kind === "last" ? "text-foreground" : "text-muted-foreground",
            )}
            style={{ left: `${left}%`, transform }}
          >
            {tick.label}
          </span>
        );
      })}
    </div>
  );
}

function OverallChartCard({
  chain,
  snapshot,
  range,
  onRangeChange,
}: {
  chain: ChainHealthChain;
  snapshot: ChainHealthSnapshot;
  range: ChainLatencyRange;
  onRangeChange: (range: ChainLatencyRange) => void;
}) {
  const hasCurve = chain.series.some(
    (point) => point.p50 !== null && point.samples > 0,
  );
  // 多成员跳才有的「多路径」说明：单路径链不显示，避免多一行噪音。
  const multiPath = chainHasMultiPathHop(chain);
  const chartLabel = t("overview.chainLatency.overallChartAria", {
    name: chain.name,
    p50: formatMs(chain.latestP50),
    delta: formatSignedMs(chain.deltaMs),
  });
  // 轴右端是最后一个真实样本，而不是「现在」：数据滞后时不能把旧值标成当前值。
  const lastSampleTs = chainLatestSeriesTs(chain.series);
  const axisWindow: ChainSeriesWindow | null =
    lastSampleTs === null
      ? null
      : {
          startTs: lastSampleTs - snapshot.hours * 3_600,
          endTs: lastSampleTs,
        };
  const ticks =
    axisWindow === null
      ? []
      : chainTimeTicks(
          axisWindow.startTs,
          axisWindow.endTs,
          snapshot.hours,
          snapshot.bucket,
        );
  const lagSecs =
    snapshot.generatedAt !== null && lastSampleTs !== null
      ? snapshot.generatedAt - lastSampleTs
      : null;
  // 落后超过 5 分钟才补一行「现在」，避免正常的一个桶延迟也刷出参考值。
  const showNow = lagSecs !== null && lagSecs > 300;

  return (
    <Card className="min-w-0 gap-0" data-chain-overall-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <CardTitle className="text-sm font-medium">
              {t("overview.chainLatency.overallTitle")}
            </CardTitle>
            {multiPath ? (
              // 多路径说明是事实边界（叠加值 ≠ 单连接 RTT），不是功能导语：
              // 只有存在多成员跳时才出现，避免单路径链多一行解释。
              <span
                data-chain-multipath-note
                title={t("overview.chainLatency.multiPathNoteHint")}
                className="min-w-0 text-[11px] leading-normal text-muted-foreground"
              >
                {t("overview.chainLatency.multiPathNote")}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <ChainLatencyUpdatedBadge generatedAt={snapshot.generatedAt} />
            <ChainLatencyRangeTabs
              range={range}
              onRangeChange={onRangeChange}
            />
          </div>
        </div>
        {hasCurve ? (
          <div
            data-chain-overall-legend
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
          >
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-0.5 w-4 rounded-full bg-primary"
              />
              P50
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-4 rounded-sm bg-primary/15"
              />
              P10–P90
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-4 rounded-sm bg-primary/30"
              />
              {t("overview.chainLatency.anomalyWindow")}
            </span>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="min-w-0 p-3 sm:p-4">
        {hasCurve && axisWindow !== null ? (
          <ChainLatencySparkline
            points={chain.series}
            window={axisWindow}
            bucketSecs={snapshot.bucket}
            timeTicks={ticks}
            tone="primary"
            label={chartLabel}
            heightClass="h-40 sm:h-56"
          />
        ) : (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
            {t("overview.chainLatency.overallEmpty")}
          </div>
        )}
        {hasCurve && axisWindow !== null ? (
          <>
            <TimeAxis ticks={ticks} window={axisWindow} />
            {showNow && snapshot.generatedAt !== null ? (
              <p
                data-chain-axis-now
                className="mt-0.5 text-right font-mono text-[11px] text-muted-foreground tabular-nums"
              >
                {t("overview.chainLatency.now")}{" "}
                {formatChainClock(snapshot.generatedAt, snapshot.hours)}
              </p>
            ) : null}
          </>
        ) : null}
        <DiagnosisBlock chain={chain} />
      </CardContent>
    </Card>
  );
}

function segmentRoute(segment: ChainHealthSegment): string {
  return segment.from && segment.to
    ? t("overview.chainLatency.segmentRoute", {
        from: segment.from,
        to: segment.to,
      })
    : t("overview.chainLatency.missingHop");
}

/**
 * 图表下方的贡献占比：每段一行，紧凑；不重复整张图。
 *
 * 段当前 P50 / 窗口丢包放在同一行右侧，是「窗口值」；图表 tooltip 里的
 * 丢包是「该时刻值」，两者不能混。无数据段仍保留一行，值显示 `—`。
 */
function SegmentContributions({ chain }: { chain: ChainHealthChain }) {
  const lastHopUnmeasurable = chainLastHopUnmeasurable(chain);
  const unmeasurableText = chainLastHopReasonText(chain);
  const lastSeq = chain.segments[chain.segments.length - 1]?.seq ?? null;
  return (
    <div
      data-chain-segment-contributions
      className="mt-3 flex flex-col gap-1.5 border-t border-border pt-3"
    >
      {chain.segments.map((segment) => {
        // 最后一跳「测不了」时按原因标注；旧契约 / 中间段仍走 missing。
        const unmeasurable =
          lastHopUnmeasurable && segment.seq === lastSeq;
        const share =
          segment.contributionPct === null
            ? 0
            : Math.max(0, Math.min(100, segment.contributionPct));
        const slowed =
          (chain.diagnosis.kind === "single_hop" &&
            chain.diagnosis.seq === segment.seq) ||
          (segment.deltaMs !== null &&
            segment.deltaMs >= SLOW_CHAIN_DELTA_MS);
        const route = segmentRoute(segment);
        const probes = formatLossProbes(segment.attempts, segment.failures);
        const probesTitle =
          segment.attempts !== null && segment.failures !== null
            ? t("overview.chainLatency.lossProbes", {
                attempts: segment.attempts,
                failures: segment.failures,
              })
            : undefined;
        const label = t("overview.chainLatency.segmentAria", {
          seq: segment.seq,
          route,
          p50: formatMs(segment.p50),
          delta: formatSignedMs(segment.deltaMs),
          pct: formatPercentValue(segment.contributionPct),
          loss: formatLossPct(segment.lossPct),
          probes,
        });
        return (
          <div
            key={segment.seq}
            data-chain-segment
            data-seq={segment.seq}
            data-missing={segment.missing ? "true" : "false"}
            data-unmeasurable={unmeasurable ? "true" : "false"}
            aria-label={
              unmeasurable && unmeasurableText !== null
                ? `${label} · ${unmeasurableText}`
                : label
            }
            className="flex min-w-0 items-center gap-2 text-[13px]"
          >
            <span className="w-14 shrink-0 whitespace-nowrap font-mono text-muted-foreground">
              {t("overview.chainLatency.segment", { seq: segment.seq })}
            </span>
            <span
              className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:block"
              title={route}
            >
              {route}
            </span>
            {unmeasurable ? (
              <span
                data-segment-unmeasurable
                className="min-w-0 flex-1 truncate text-right text-muted-foreground"
                title={unmeasurableText ?? undefined}
              >
                {unmeasurableText}
              </span>
            ) : (
              <>
                <span
                  data-segment-current
                  className="shrink-0 whitespace-nowrap font-mono tabular-nums"
                >
                  <span className="mr-1 text-[11px] text-muted-foreground">
                    P50
                  </span>
                  {formatMs(segment.p50)}
                </span>
                <span
                  data-segment-loss
                  data-loss-tone={chainLossTone(segment.lossPct) ?? "none"}
                  title={probesTitle}
                  className="shrink-0 whitespace-nowrap"
                >
                  <span className="mr-1 text-[11px] text-muted-foreground">
                    {t("overview.chainLatency.windowLoss")}
                  </span>
                  <ChainLossValue
                    value={segment.lossPct}
                    className="text-[13px]"
                  />
                </span>
                <span
                  data-segment-contribution
                  className="flex min-w-10 flex-1 items-center gap-1.5 sm:w-28 sm:flex-none"
                >
                  <span
                    aria-hidden="true"
                    className="h-1.5 min-w-6 flex-1 overflow-hidden rounded-full bg-muted"
                  >
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        slowed ? "bg-warning" : "bg-primary",
                      )}
                      style={{ width: `${share}%` }}
                    />
                  </span>
                  <span className="w-9 shrink-0 text-right text-[13px] text-muted-foreground tabular-nums">
                    {formatPercentValue(segment.contributionPct)}%
                  </span>
                </span>
              </>
            )}
          </div>
        );
      })}
      {noDataHint(chain)}
    </div>
  );
}

/** 全链都没有逐段样本时给一条说明；有数据时不加噪音。 */
function noDataHint(chain: ChainHealthChain): ReactNode {
  return chain.segments.length === 0 ? (
    <p className="py-2 text-xs text-muted-foreground">
      {t("overview.chainLatency.noSamplesShort")}
    </p>
  ) : null;
}

function SegmentsCard({
  chain,
  bucket,
  trends,
  trendPending,
}: {
  chain: ChainHealthChain;
  bucket: number;
  trends: ReadonlyMap<number, ChainHealthPoint[]>;
  trendPending: boolean;
}) {
  const lastHopUnmeasurable = chainLastHopUnmeasurable(chain);
  const unmeasurableText = chainLastHopReasonText(chain);
  const lastSeq = chain.segments[chain.segments.length - 1]?.seq ?? null;
  return (
    <Card className="min-w-0 gap-0" data-chain-segments-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-medium">
              {t("overview.chainLatency.detailTitle")}
            </CardTitle>
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            {chain.estimated ? (
              <Badge
                data-chain-estimated-badge
                variant="outline"
                className="shrink-0 font-normal text-muted-foreground"
                title={t("overview.chainLatency.estimatedHint")}
              >
                {t("overview.chainLatency.estimated")}
              </Badge>
            ) : null}
            <Badge
              variant="outline"
              className="max-w-[55vw] font-normal"
              title={chain.name}
            >
              <span className="truncate">{chain.name}</span>
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 p-2 sm:p-4">
        {chain.segments.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-muted-foreground">
            {t("overview.chainLatency.noSamplesShort")}
          </p>
        ) : (
          <div data-chain-segments>
            <ChainSegmentTrendChart
              segments={chain.segments}
              trends={trends}
              bucketSecs={bucket}
              nodes={chain.nodes}
              trendPending={trendPending}
              unmeasurableSeq={
                lastHopUnmeasurable ? lastSeq : null
              }
              unmeasurableLabel={
                lastHopUnmeasurable ? unmeasurableText : null
              }
            />
            <SegmentContributions chain={chain} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 链路详情内容：弹窗里渲染，顺序按产品稿：
 * 完整链路（含整链 P50 / 丢包）→ 整体时延图（诊断句在图下方）→
 * 逐段多序列折线 + 每段一行的贡献占比。
 *
 * 标题与关闭动作由外层 Dialog 负责，这里不再画面包屑 / 返回按钮。
 */
export function ChainLatencyDetail({
  chain,
  config,
  snapshot,
  range,
  onRangeChange,
  trends,
  trendPending,
}: {
  chain: ChainHealthChain;
  /** 链列表里的配置；用于保留「停用」与旧契约的配置级阻断 / 降级。 */
  config: ChainHealthConfig | null;
  snapshot: ChainHealthSnapshot;
  range: ChainLatencyRange;
  onRangeChange: (range: ChainLatencyRange) => void;
  trends: ReadonlyMap<number, ChainHealthPoint[]>;
  trendPending: boolean;
}) {
  useI18n();
  return (
    <div className="space-y-4" data-chain-detail>
      <div data-chain-detail-status className="flex min-w-0 items-center">
        <ChainStatusBadge chain={chain} config={config} />
      </div>
      <ChainFlowCard chain={chain} />
      <OverallChartCard
        chain={chain}
        snapshot={snapshot}
        range={range}
        onRangeChange={onRangeChange}
      />
      <SegmentsCard
        chain={chain}
        bucket={snapshot.bucket}
        trends={trends}
        trendPending={trendPending}
      />
    </div>
  );
}
