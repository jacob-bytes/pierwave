import { Fragment } from "react";
import { ChevronRightIcon, TriangleAlertIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChainLatencySparkline } from "@/components/overview/ChainLatencyChart";
import {
  ChainLatencyRangeTabs,
  ChainLatencyUpdatedBadge,
} from "@/components/overview/ChainLatencyControls";
import { ChainLossValue } from "@/components/overview/ChainLossValue";
import {
  SLOW_CHAIN_DELTA_MS,
  chainDiagnosis,
  chainDiagnosisReason,
  chainLossTone,
  chainTopology,
  formatChainTime,
  formatLossPct,
  formatLossProbes,
  formatMs,
  formatPercentValue,
  formatSignedMs,
  segmentSeries,
  type ChainDiagnosisReason,
  type ChainDiagnosisView,
  type ChainHealthChain,
  type ChainHealthPoint,
  type ChainHealthSegment,
  type ChainHealthSnapshot,
  type ChainLatencyRange,
  type ChainTopologyEdge,
} from "@/lib/chainHealth";
import { t, useI18n } from "@/i18n";
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
      : "border-warning/30 bg-warning/5 text-warning";
  return (
    <div
      data-chain-diagnosis
      data-kind={diagnosis.kind}
      role="status"
      className={cn(
        "mt-3 rounded-md border px-3 py-2 text-xs leading-normal",
        tone,
      )}
    >
      {diagnosisText(reason, diagnosis)}
    </div>
  );
}

function TopologyNode({
  name,
  target = false,
}: {
  name: string;
  target?: boolean;
}) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-xs font-medium",
        target
          ? "border-dashed border-border text-muted-foreground"
          : "border-border bg-card text-foreground",
      )}
      title={name}
    >
      {name}
    </span>
  );
}

function TopologyEdge({ edge }: { edge: ChainTopologyEdge }) {
  const missing = edge.missing;
  return (
    <span className="flex min-w-14 shrink-0 flex-col items-center gap-0.5 px-1">
      <span
        className={cn(
          "whitespace-nowrap font-mono text-[10px] tabular-nums",
          missing ? "text-warning" : "text-muted-foreground",
        )}
      >
        {missing ? t("overview.chainLatency.missingHop") : formatMs(edge.p50)}
      </span>
      <span className="flex w-full items-center text-muted-foreground">
        <span
          aria-hidden="true"
          className={cn(
            "h-0 flex-1 border-t",
            missing ? "border-dashed border-warning/40" : "border-border",
          )}
        />
        <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
      </span>
    </span>
  );
}

/**
 * 顶部整体信息：整链 P50 与整链丢包并列。
 *
 * `loss_pct = null` 时显示 muted 的 `—` 并注明「无探测数据」，绝不画成 0%；
 * `loss_partial` 表示部分跳没有探测，丢包只是可见跳的汇总。
 */
function ChainOverallStats({ chain }: { chain: ChainHealthChain }) {
  const samples = chain.lossSamples;
  const lossTitle =
    chain.lossPct === null
      ? t("overview.chainLatency.lossNoData")
      : samples !== null && samples.attempts !== null && samples.failures !== null
        ? t("overview.chainLatency.lossProbes", {
            attempts: samples.attempts,
            failures: samples.failures,
          })
        : undefined;

  return (
    <div
      data-chain-overall-stats
      className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-3 gap-y-1 text-[10px] text-muted-foreground"
    >
      <span className="inline-flex items-baseline gap-1.5">
        <span className="text-[10px] text-muted-foreground">P50</span>
        <span className="font-mono text-xs text-foreground tabular-nums">
          {formatMs(chain.latestP50)}
        </span>
      </span>
      <span
        data-chain-loss-summary
        data-loss-tone={chainLossTone(chain.lossPct) ?? "none"}
        title={lossTitle}
        className="inline-flex items-baseline gap-1.5"
      >
        <span className="text-[10px] text-muted-foreground">
          {t("overview.chainLatency.loss")}
        </span>
        <ChainLossValue value={chain.lossPct} className="text-xs" />
      </span>
      {chain.lossPct === null ? (
        <span
          data-chain-loss-nodata
          className="text-[9px] text-muted-foreground"
        >
          {t("overview.chainLatency.lossNoData")}
        </span>
      ) : null}
      {chain.lossPartial ? (
        <span data-chain-loss-partial className="text-[9px] text-warning">
          {t("overview.chainLatency.lossPartial")}
        </span>
      ) : null}
    </div>
  );
}

function ChainTopologyCard({ chain }: { chain: ChainHealthChain }) {
  const topology = chainTopology(chain);
  return (
    <Card className="min-w-0 gap-0" data-chain-topology-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <CardTitle className="text-sm font-medium">
            {t("overview.chainLatency.topologyTitle")}
          </CardTitle>
          <ChainOverallStats chain={chain} />
        </div>
      </CardHeader>
      <CardContent className="min-w-0 p-2 sm:p-4">
        {topology.nodes.length === 0 ? (
          <p className="px-1 py-3 text-xs text-muted-foreground">
            {t("overview.chainLatency.noSamplesShort")}
          </p>
        ) : (
          <>
            <div
              className="-mx-1 overflow-x-auto px-1 pb-2"
              data-chain-topology-scroll
            >
              <div
                className="flex w-max items-center gap-0.5"
                data-chain-topology
              >
                {topology.nodes.map((node, index) => (
                  <Fragment key={`${node}-${index}`}>
                    <TopologyNode name={node} />
                    {topology.edges[index] ? (
                      <TopologyEdge edge={topology.edges[index]} />
                    ) : null}
                  </Fragment>
                ))}
                {topology.targetMissing ? (
                  <>
                    <TopologyEdge
                      edge={{ seq: chain.hops, p50: null, missing: true }}
                    />
                    <TopologyNode
                      name={t("overview.chainLatency.chainTarget")}
                      target
                    />
                  </>
                ) : null}
              </div>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground sm:hidden">
              {t("overview.chainLatency.topologyScroll")}
            </p>
          </>
        )}
        {chain.lastHopMissing ? (
          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-normal text-warning">
            <TriangleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-3 shrink-0"
            />
            <span>{t("overview.chainLatency.missingLastHop")}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
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
  const chartLabel = t("overview.chainLatency.overallChartAria", {
    name: chain.name,
    p50: formatMs(chain.latestP50),
    delta: formatSignedMs(chain.deltaMs),
  });
  const endTs = snapshot.generatedAt ?? chain.series.at(-1)?.ts ?? null;

  return (
    <Card className="min-w-0 gap-0" data-chain-overall-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.chainLatency.overallTitle")}
          </CardTitle>
          <div className="flex min-w-0 items-center gap-2">
            <ChainLatencyUpdatedBadge generatedAt={snapshot.generatedAt} />
            <ChainLatencyRangeTabs
              range={range}
              onRangeChange={onRangeChange}
            />
          </div>
        </div>
        {hasCurve ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
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
            <span className="inline-flex items-center gap-1.5 text-warning">
              <span
                aria-hidden="true"
                className="h-2 w-4 rounded-sm bg-warning/15"
              />
              {t("overview.chainLatency.anomalyWindow")}
            </span>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="min-w-0 p-3 sm:p-4">
        {hasCurve ? (
          <ChainLatencySparkline
            points={chain.series}
            bucketSecs={snapshot.bucket}
            tone={chain.slow ? "warning" : "primary"}
            label={chartLabel}
            heightClass="h-40 sm:h-56"
          />
        ) : (
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
            {t("overview.chainLatency.overallEmpty")}
          </div>
        )}
        {hasCurve && endTs !== null ? (
          <div className="mt-1 flex items-center justify-between font-mono text-[9px] text-muted-foreground tabular-nums">
            <span>
              {formatChainTime(endTs - snapshot.hours * 3600, snapshot.bucket)}
            </span>
            <span>{t("overview.chainLatency.now")}</span>
          </div>
        ) : null}
        <DiagnosisBlock chain={chain} />
      </CardContent>
    </Card>
  );
}

function SegmentRow({
  segment,
  dominant,
  bucket,
  trend,
  trendPending,
}: {
  segment: ChainHealthSegment;
  dominant: boolean;
  bucket: number;
  trend: ChainHealthSegment["series"];
  trendPending: boolean;
}) {
  // 契约允许某段没有样本（p50 = null）；这时按「无历史数据」展示，
  // 不能把它画成 0ms / 0% 的贡献。
  const noData = segment.missing || segment.p50 === null;
  const share =
    segment.contributionPct === null
      ? 0
      : Math.max(0, Math.min(100, segment.contributionPct));
  const deltaTone =
    segment.missing || segment.deltaMs === null || segment.deltaMs === 0
      ? "text-muted-foreground"
      : segment.deltaMs > 0
        ? "text-warning"
        : "text-primary";
  const route =
    segment.from && segment.to
      ? t("overview.chainLatency.segmentRoute", {
          from: segment.from,
          to: segment.to,
        })
      : t("overview.chainLatency.missingHop");
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
  const slowed =
    dominant ||
    (segment.deltaMs !== null && segment.deltaMs >= SLOW_CHAIN_DELTA_MS);
  const trendTone = slowed ? "warning" : "primary";

  return (
    <li
      data-chain-segment
      data-seq={segment.seq}
      data-missing={segment.missing ? "true" : "false"}
      aria-label={label}
      className="rounded-md px-2.5 py-2 transition-colors duration-150 hover:bg-muted/40"
    >
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {t("overview.chainLatency.segment", { seq: segment.seq })}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            noData && "text-muted-foreground",
          )}
          title={route}
        >
          {segment.missing
            ? t("overview.chainLatency.missingHop")
            : route}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums">
          {formatMs(segment.p50)}
        </span>
        <span
          data-segment-loss
          data-loss-tone={chainLossTone(segment.lossPct) ?? "none"}
          className="flex w-16 shrink-0 flex-col items-end leading-tight text-right"
        >
          <span className="inline-flex items-baseline justify-end gap-1 whitespace-nowrap">
            <span className="text-[9px] text-muted-foreground">
              {t("overview.chainLatency.loss")}
            </span>
            <ChainLossValue value={segment.lossPct} className="text-[11px]" />
          </span>
          {segment.attempts !== null && segment.failures !== null ? (
            <span
              className="font-mono text-[9px] text-muted-foreground tabular-nums"
              title={probesTitle}
            >
              {probes}
            </span>
          ) : null}
        </span>
      </div>
      {noData ? (
        segment.missing ? null : (
          <p className="mt-1 text-[10px] text-muted-foreground">
            {t("overview.chainLatency.missingHop")}
          </p>
        )
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <span className={cn("font-mono tabular-nums", deltaTone)}>
              {t("overview.chainLatency.segmentDelta", {
                value: formatSignedMs(segment.deltaMs),
              })}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {t("overview.chainLatency.contribution", {
                pct: formatPercentValue(segment.contributionPct),
              })}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div
              aria-hidden="true"
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn(
                  "h-full rounded-full",
                  slowed ? "bg-warning" : "bg-primary",
                )}
                style={{ width: `${share}%` }}
              />
            </div>
            <span className="w-8 shrink-0 text-right text-[9px] text-muted-foreground tabular-nums">
              {formatPercentValue(segment.contributionPct)}%
            </span>
          </div>
        </>
      )}
      {!noData && trend.length > 0 ? (
        <ChainLatencySparkline
          points={trend}
          bucketSecs={bucket}
          tone={trendTone}
          showBand={false}
          label={t("overview.chainLatency.segmentTrendAria", {
            seq: segment.seq,
            route,
          })}
          className="mt-1.5"
          heightClass="h-8"
        />
      ) : noData ? null : (
        <p className="mt-1 text-[9px] text-muted-foreground">
          {trendPending
            ? t("overview.chainLatency.segmentTrendLoading")
            : t("overview.chainLatency.segmentTrendEmpty")}
        </p>
      )}
    </li>
  );
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
  return (
    <Card className="min-w-0 gap-0" data-chain-segments-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.chainLatency.detailTitle")}
          </CardTitle>
          <div className="flex min-w-0 items-center gap-1.5">
            {chain.estimated ? (
              <Badge
                variant="outline"
                className="shrink-0 font-normal text-muted-foreground"
                title={t("overview.chainLatency.estimatedHint")}
              >
                {t("overview.chainLatency.estimated")}
              </Badge>
            ) : null}
            <Badge variant="outline" className="max-w-[55vw] font-normal" title={chain.name}>
              <span className="truncate">{chain.name}</span>
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 p-2 sm:p-3">
        <ul className="flex flex-col gap-0.5" data-chain-segments>
          {chain.segments.map((segment) => (
            <SegmentRow
              key={segment.seq}
              segment={segment}
              dominant={
                chain.diagnosis.kind === "single_hop" &&
                chain.diagnosis.seq === segment.seq
              }
              bucket={bucket}
              trend={segmentSeries(segment, trends)}
              trendPending={trendPending}
            />
          ))}
        </ul>
        {chain.segments.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-muted-foreground">
            {t("overview.chainLatency.noSamplesShort")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * 链路详情内容：弹窗里渲染，顺序按产品稿：
 * 完整链路（含整链 P50 / 丢包）→ 整体时延图（诊断句在图下方）→ 逐段明细。
 *
 * 标题与关闭动作由外层 Dialog 负责，这里不再画面包屑 / 返回按钮。
 */
export function ChainLatencyDetail({
  chain,
  snapshot,
  range,
  onRangeChange,
  trends,
  trendPending,
}: {
  chain: ChainHealthChain;
  snapshot: ChainHealthSnapshot;
  range: ChainLatencyRange;
  onRangeChange: (range: ChainLatencyRange) => void;
  trends: ReadonlyMap<number, ChainHealthPoint[]>;
  trendPending: boolean;
}) {
  useI18n();
  return (
    <div className="space-y-4" data-chain-detail>
      <ChainTopologyCard chain={chain} />
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
