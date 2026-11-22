import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  TriangleAlertIcon,
  WaypointsIcon,
} from "lucide-react";
import { EmptyState } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChainLatencySparkline } from "@/components/overview/ChainLatencyChart";
import { PanelError } from "@/components/overview/PanelError";
import type { Chain } from "@/lib/api";
import {
  CHAIN_HEALTH_POLL_MS,
  SLOW_CHAIN_DELTA_MS,
  chainAnomalyWindows,
  chainDiagnosis,
  chainDiagnosisReason,
  chainLatencyWindow,
  chainSeriesMax,
  formatChainTime,
  formatMs,
  formatPercentValue,
  formatSignedMs,
  normalizeChainHealth,
  segmentSeries,
  segmentTrends,
  type ChainHealthChain,
  type ChainHealthPoint,
  type ChainHealthSegment,
  type ChainHealthSnapshot,
  type ChainDiagnosisReason,
  type ChainLatencyRange,
  type ChainDiagnosisView,
} from "@/lib/chainHealth";
import { errorText } from "@/lib/errors";
import {
  chainHealthRows,
  type ChainHealthStatus,
} from "@/lib/overview";
import { filterChainsByScope } from "@/lib/overviewScope";
import { useChainHealth, useChainLatency, useChains } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** 转发链健康卡的状态样式；阻断用 destructive，降级用 warning，与链列表一致。 */
const CHAIN_HEALTH_META: Record<
  ChainHealthStatus,
  { labelKey: string; titleKey?: string; dot: string; text: string }
> = {
  blocked: {
    labelKey: "overview.chainBlocked",
    dot: "bg-destructive",
    text: "text-destructive",
  },
  degraded: {
    labelKey: "chains.status.degraded",
    titleKey: "chains.status.degradedTitle",
    dot: "bg-warning",
    text: "text-warning",
  },
  disabled: {
    labelKey: "chains.status.disabled",
    titleKey: "chains.status.disabledTitle",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
  ok: {
    labelKey: "chains.status.ok",
    titleKey: "chains.status.okTitle",
    dot: "bg-primary",
    text: "text-primary",
  },
};

function ChainHealthCard({
  chains,
  isPending,
  error,
  retrying,
  onRetry,
}: {
  chains: Chain[] | undefined;
  isPending: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const rows = chainHealthRows(chains);

  return (
    <Card className="flex flex-col gap-0" data-chain-health-card>
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-sm font-medium">
          {t("overview.chainHealth")}
        </CardTitle>
      </CardHeader>
      {isPending ? (
        <CardContent className="flex flex-col gap-3 p-4" aria-hidden="true">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="h-3 w-32" />
            </div>
          ))}
        </CardContent>
      ) : error ? (
        <PanelError
          message={errorText(error, t("chains.loadError"))}
          retrying={retrying}
          onRetry={onRetry}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={WaypointsIcon}
          title={t("overview.chainHealthEmpty")}
          className="py-10"
        />
      ) : (
        <CardContent className="p-2">
          <ul className="flex flex-col gap-0.5">
            {rows.map((row) => {
              const meta = CHAIN_HEALTH_META[row.status];
              const statusTitle =
                row.reason ?? (meta.titleKey ? t(meta.titleKey) : undefined);
              return (
                <li key={row.id}>
                  <Link
                    to="/chains"
                    className="group flex flex-col gap-1 rounded-md px-2.5 py-2.5 transition-colors duration-150 hover:bg-muted/40"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="min-w-0 flex-1 truncate text-sm"
                        title={row.name}
                      >
                        {row.name}
                      </span>
                      <span
                        className={cn(
                          "flex shrink-0 items-center gap-1.5 text-xs",
                          meta.text,
                        )}
                        title={statusTitle}
                      >
                        <span
                          aria-hidden="true"
                          className={cn("size-1.5 rounded-full", meta.dot)}
                        />
                        {t(meta.labelKey)}
                      </span>
                    </div>
                    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
                      <span className="shrink-0">
                        {t(
                          row.hops === 1
                            ? "overview.chainHopsOne"
                            : "overview.chainHops",
                          { n: row.hops },
                        )}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span
                        className="truncate font-mono"
                        title={`${t("overview.chainEntry")} ${row.entry}`}
                      >
                        {row.entry}
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

function KpiCell({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warning" | "primary" | "muted";
}) {
  return (
    <div className="min-w-0 bg-card px-3 py-4 sm:px-5">
      <p className="text-xs leading-tight text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-2 text-xl leading-none font-medium tracking-tight tabular-nums sm:text-2xl",
          tone === "warning"
            ? "text-warning"
            : tone === "primary"
              ? "text-primary"
              : "text-foreground",
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-2 line-clamp-2 text-xs leading-normal text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function LatencyKpis({ summary }: { summary: ChainHealthSnapshot["summary"] }) {
  const deltaTone =
    summary.deltaMs === null || summary.deltaMs === 0
      ? "muted"
      : summary.deltaMs > 0
        ? "warning"
        : "primary";
  const slowTone =
    summary.slowChains !== null && summary.slowChains > 0
      ? "warning"
      : "muted";
  const worst = summary.worstHop;
  const worstHint =
    worst === null
      ? t("overview.chainLatency.noSamplesShort")
      : [
          worst.chainName ?? worst.chainId ?? "—",
          worst.seq === null
            ? null
            : t("overview.chainLatency.segment", { seq: worst.seq }),
        ]
          .filter(Boolean)
          .join(" · ");
  return (
    <Card className="gap-0 overflow-hidden py-0" data-chain-kpis>
      <CardContent className="grid grid-cols-2 gap-px bg-border p-0 sm:grid-cols-4">
        <KpiCell
          label={t("overview.chainLatency.hopP50")}
          value={formatMs(summary.hopP50)}
          hint={t("overview.chainLatency.hopP50Hint")}
        />
        <KpiCell
          label={t("overview.chainLatency.delta")}
          value={formatSignedMs(summary.deltaMs)}
          hint={t("overview.chainLatency.deltaHint")}
          tone={deltaTone}
        />
        <KpiCell
          label={t("overview.chainLatency.slowChains")}
          value={
            summary.slowChains === null
              ? "—"
              : `${summary.slowChains}/${summary.totalChains}`
          }
          hint={t("overview.chainLatency.slowChainsHint")}
          tone={slowTone}
        />
        <KpiCell
          label={t("overview.chainLatency.worstHop")}
          value={formatMs(worst?.p50Ms ?? null)}
          hint={worstHint}
          tone={worst === null ? "muted" : "warning"}
        />
      </CardContent>
    </Card>
  );
}

function RangeTabs({
  range,
  onRangeChange,
}: {
  range: ChainLatencyRange;
  onRangeChange: (range: ChainLatencyRange) => void;
}) {
  return (
    <Tabs
      value={range}
      onValueChange={(value) => {
        if (value === "24h" || value === "7d") onRangeChange(value);
      }}
    >
      <TabsList
        aria-label={t("overview.chainLatency.rangeAria")}
        className="max-w-full overflow-x-auto"
      >
        <TabsTrigger value="24h">
          {t("overview.chainLatency.range24")}
        </TabsTrigger>
        <TabsTrigger value="7d">
          {t("overview.chainLatency.range7d")}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function LatencyTrendCard({
  snapshot,
  range,
  selectedId,
  onSelect,
  onRangeChange,
}: {
  snapshot: ChainHealthSnapshot;
  range: ChainLatencyRange;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRangeChange: (range: ChainLatencyRange) => void;
}) {
  const lastSeriesTs = snapshot.chains.reduce<number | null>((max, chain) => {
    const ts = chain.series.at(-1)?.ts ?? null;
    return ts !== null && (max === null || ts > max) ? ts : max;
  }, null);
  const endTs = snapshot.generatedAt ?? lastSeriesTs;

  return (
    <Card className="gap-0" data-chain-trend-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle className="text-sm font-medium">
            {t("overview.chainLatency.trendTitle")}
          </CardTitle>
          <div className="flex min-w-0 items-center gap-2">
            {snapshot.generatedAt === null ? null : (
              <Badge
                variant="outline"
                className="font-mono type-micro font-normal text-muted-foreground"
              >
                {t("overview.chainLatency.updatedAt", {
                  time: formatGeneratedAt(snapshot.generatedAt),
                })}
              </Badge>
            )}
            <RangeTabs range={range} onRangeChange={onRangeChange} />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="h-0.5 w-4 rounded-full bg-primary" />
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
      </CardHeader>
      <CardContent className="p-2">
        <ul className="flex flex-col gap-0.5">
          {snapshot.chains.map((chain) => (
            <ChainLatencyRow
              key={chain.id}
              chain={chain}
              bucket={snapshot.bucket}
              selected={chain.id === selectedId}
              onSelect={() => onSelect(chain.id)}
            />
          ))}
        </ul>
        {endTs === null ? null : (
          <div className="mt-1 flex items-center justify-between px-2.5 pb-1 font-mono text-[9px] text-muted-foreground tabular-nums">
            <span>
              {formatChainTime(
                endTs - snapshot.hours * 3600,
                snapshot.bucket,
              )}
            </span>
            <span>{t("overview.chainLatency.now")}</span>
          </div>
        )}
        {snapshot.chains.some((chain) => chain.lastHopMissing) ? (
          <p className="px-2.5 pt-1 text-[10px] leading-normal text-muted-foreground">
            {t("overview.chainLatency.missingLastHop")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ChainLatencyRow({
  chain,
  bucket,
  selected,
  onSelect,
}: {
  chain: ChainHealthChain;
  bucket: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const anomalies = useMemo(
    () => chainAnomalyWindows(chain.series, bucket),
    [chain.series, bucket],
  );
  const hasCurve = chain.series.some(
    (point) => point.p50 !== null && point.samples > 0,
  );
  const tone = chain.slow || anomalies.length > 0 ? "warning" : "primary";
  const deltaTone =
    chain.deltaMs === null || chain.deltaMs === 0
      ? "text-muted-foreground"
      : chain.deltaMs > 0
        ? "text-warning"
        : "text-primary";
  const hopsLabel = t(
    chain.hops === 1 ? "overview.chainHopsOne" : "overview.chainHops",
    { n: chain.hops },
  );
  const aria = t("overview.chainLatency.rowAria", {
    name: chain.name,
    p50: formatMs(chain.latestP50),
    delta: formatSignedMs(chain.deltaMs),
  });

  return (
    <li
      data-chain-latency-row
      data-selected={selected ? "true" : "false"}
      className={cn(
        "rounded-lg border transition-colors duration-150",
        selected
          ? "border-primary/50 bg-primary/5"
          : "border-transparent hover:bg-muted/40",
      )}
    >
      <div className="flex items-start gap-2 px-2.5 pt-2.5">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          aria-label={aria}
          className="flex min-w-0 flex-1 flex-col text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="min-w-0 max-w-full truncate text-sm" title={chain.name}>
              {chain.name}
            </span>
            {chain.estimated ? (
              <Badge
                variant="outline"
                className="shrink-0 font-normal text-muted-foreground"
                title={t("overview.chainLatency.estimatedHint")}
              >
                {t("overview.chainLatency.estimated")}
              </Badge>
            ) : null}
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
            <span>{hopsLabel}</span>
            {anomalies.length > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-warning">
                  {t("overview.chainLatency.anomalyCount", {
                    n: anomalies.length,
                  })}
                </span>
              </>
            ) : null}
          </span>
        </button>
        <div className="shrink-0 text-right">
          <div
            className={cn(
              "font-mono text-sm tabular-nums",
              tone === "warning" ? "text-warning" : "text-foreground",
            )}
          >
            {formatMs(chain.latestP50)}
          </div>
          <div className={cn("font-mono text-[10px] tabular-nums", deltaTone)}>
            {formatSignedMs(chain.deltaMs)}
          </div>
        </div>
      </div>
      <div className="flex items-end gap-2 px-2.5 pb-2">
        {hasCurve ? (
          <ChainLatencySparkline
            points={chain.series}
            bucketSecs={bucket}
            tone={tone}
            label={aria}
            onActivate={onSelect}
            className="min-w-0 flex-1"
          />
        ) : (
          <div className="flex h-10 flex-1 items-center text-[10px] text-muted-foreground">
            {t("overview.chainLatency.noSamplesShort")}
          </div>
        )}
        {hasCurve ? (
          <span
            className="shrink-0 pb-0.5 font-mono text-[9px] text-muted-foreground tabular-nums"
            title={t("overview.chainLatency.independentAxis")}
          >
            {t("overview.chainLatency.axisRange", {
              max: formatMs(chainSeriesMax(chain.series)),
            })}
          </span>
        ) : null}
      </div>
    </li>
  );
}

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

function SelectedChainCard({
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
  const diagnosis = chainDiagnosis(chain);
  const reason = chainDiagnosisReason(diagnosis, chain.hasSamples);
  const sentence = diagnosisText(reason, diagnosis);
  const diagnosisTone =
    reason === "unknown" || reason === "stable"
      ? "border-border bg-muted/30 text-muted-foreground"
      : "border-warning/30 bg-warning/5 text-warning";

  return (
    <Card className="gap-0" data-chain-detail data-chain-id={chain.id}>
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
            <Badge
              variant="outline"
              className="max-w-[55vw] shrink-0 font-normal"
              title={chain.name}
            >
              <span className="truncate">{chain.name}</span>
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-2 sm:p-3">
        {chain.lastHopMissing ? (
          <div
            data-chain-last-hop-warning
            className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-normal text-warning"
          >
            <TriangleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span>{t("overview.chainLatency.missingLastHop")}</span>
          </div>
        ) : null}
        <div
          data-chain-diagnosis
          data-kind={diagnosis.kind}
          role="status"
          className={cn(
            "rounded-md border px-3 py-2 text-xs leading-normal",
            diagnosisTone,
          )}
        >
          {sentence}
        </div>
        <ul className="flex flex-col gap-0.5">
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
  const label = t("overview.chainLatency.segmentAria", {
    seq: segment.seq,
    route,
    p50: formatMs(segment.p50),
    delta: formatSignedMs(segment.deltaMs),
    pct: formatPercentValue(segment.contributionPct),
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
            segment.missing && "text-muted-foreground",
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

function formatGeneratedAt(ts: number): string {
  const date = new Date((ts + 8 * 3600) * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/**
 * 「链路时延」tab：跳间 P50 / 变化 / 变慢链 / 最慢段，小多图与选中链逐段。
 *
 * 只有这个 tab 挂载时才请求 `/api/v1/chains` 与
 * `/api/v1/overview/chain-health`。服务器筛选通过 `server_ids` 交给后端；
 * 全选时传空数组，避免 200+ 台的超长 URL。
 *
 * 旧主控没有 chain-health 接口：查询层把 404 转成 null，这里显示
 * 「该功能需要新版本主控」，不抛错误；转发链健康卡仍可独立工作。
 */
export default function ChainLatencyView({
  selectedIds,
  filtered = true,
}: {
  selectedIds: readonly string[];
  /** 选中集合是否真的缩小了范围；全选时不传 `server_ids`。 */
  filtered?: boolean;
}) {
  useI18n();
  const [range, setRange] = useState<ChainLatencyRange>("24h");
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null);
  const { hours, bucket } = chainLatencyWindow(range);
  const scoped = filtered && selectedIds.length > 0;
  const query = useChainHealth(
    hours,
    bucket,
    scoped ? selectedIds : [],
    selectedIds.length > 0,
  );
  const chains = useChains();
  const scopedChains = useMemo(
    () => filterChainsByScope(chains.data ?? [], selectedIds),
    [chains.data, selectedIds],
  );
  const parsed = useMemo(() => {
    if (query.data === undefined) return null;
    if (query.data === null) return { status: "unsupported" as const };
    return normalizeChainHealth(query.data);
  }, [query.data]);
  const snapshot = parsed !== null && parsed.status !== "unsupported" ? parsed.snapshot : null;
  const selected =
    snapshot?.chains.find((chain) => chain.id === selectedChainId) ??
    snapshot?.chains[0] ??
    null;

  const latency = useChainLatency(
    selected?.id ?? "",
    hours,
    Boolean(selected),
    CHAIN_HEALTH_POLL_MS,
  );
  const trends = useMemo(
    () => segmentTrends(latency.data ?? [], bucket),
    [latency.data, bucket],
  );

  const healthCard = (
    <ChainHealthCard
      chains={scopedChains}
      isPending={chains.isPending}
      error={chains.isError ? chains.error : null}
      retrying={chains.isFetching}
      onRetry={() => void chains.refetch()}
    />
  );

  if (selectedIds.length === 0) {
    return (
      <div className="space-y-4" data-chain-view>
        <ChainScopeEmpty
          title={t("overview.scope.emptyTitle")}
          description={t("overview.scope.emptyDesc")}
        />
      </div>
    );
  }

  if (query.isPending) return <ChainLatencySkeleton />;

  if (query.isError) {
    return (
      <div className="space-y-4" data-chain-view>
        <Card>
          <CardContent>
            <PanelError
              message={errorText(
                query.error,
                t("overview.chainLatency.loadFailed"),
              )}
              retrying={query.isFetching}
              onRetry={() => void query.refetch()}
            />
          </CardContent>
        </Card>
        {healthCard}
      </div>
    );
  }

  if (parsed === null || parsed.status === "unsupported") {
    return (
      <div className="space-y-4" data-chain-view>
        <UnsupportedChainLatency />
        {healthCard}
      </div>
    );
  }

  if (parsed.status === "empty") {
    return (
      <div className="space-y-4" data-chain-view>
        <NoChainsCard scoped={scoped} />
      </div>
    );
  }

  if (!parsed.snapshot.hasSamples) {
    return (
      <div className="space-y-4" data-chain-view>
        <NoSamplesCard />
        {healthCard}
      </div>
    );
  }

  const scopeUnsupported =
    scoped &&
    query.data !== null &&
    query.data?.scope?.filtered !== true;

  return (
    <div className="space-y-4" data-chain-view data-chain-latency>
      {scopeUnsupported ? (
        <div
          data-chain-scope-warning
          className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-normal text-warning"
        >
          <TriangleAlertIcon
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span>{t("overview.chainLatency.scopeUnsupported")}</span>
        </div>
      ) : null}
      <LatencyKpis summary={parsed.snapshot.summary} />
      <LatencyTrendCard
        snapshot={parsed.snapshot}
        range={range}
        selectedId={selected?.id ?? null}
        onSelect={setSelectedChainId}
        onRangeChange={setRange}
      />
      {selected ? (
        <SelectedChainCard
          chain={selected}
          bucket={bucket}
          trends={trends}
          trendPending={latency.isPending}
        />
      ) : null}
      {healthCard}
    </div>
  );
}

function ChainScopeEmpty({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <Card>
      <CardContent>
        <EmptyState
          size="sm"
          icon={WaypointsIcon}
          title={title}
          description={description}
          className="py-16"
        />
      </CardContent>
    </Card>
  );
}

function UnsupportedChainLatency() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          icon={WaypointsIcon}
          title={t("overview.chainLatency.unsupportedTitle")}
          description={t("overview.chainLatency.unsupportedDesc")}
          className="py-16"
        />
      </CardContent>
    </Card>
  );
}

function NoChainsCard({ scoped }: { scoped: boolean }) {
  return (
    <Card>
      <CardContent>
        <EmptyState
          icon={WaypointsIcon}
          title={t(
            scoped
              ? "overview.chainLatency.emptyScopeTitle"
              : "overview.chainHealthEmpty",
          )}
          description={t(
            scoped
              ? "overview.chainLatency.emptyScopeDesc"
              : "overview.chainLatency.emptyDesc",
          )}
          className="py-16"
          action={
            <Button asChild>
              <Link to="/chains">{t("overview.chainLatency.emptyAction")}</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}

function NoSamplesCard() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          icon={WaypointsIcon}
          title={t("overview.chainLatency.noSamplesTitle")}
          description={t("overview.chainLatency.noSamplesDesc")}
          className="py-16"
        />
      </CardContent>
    </Card>
  );
}

function ChainLatencySkeleton() {
  return (
    <div className="space-y-4" data-chain-latency-skeleton aria-hidden="true">
      <Skeleton className="h-[104px] w-full rounded-xl" />
      <Card className="gap-0">
        <CardHeader className="border-b border-border pb-4">
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3 p-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-14" />
              </div>
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </CardContent>
      </Card>
      <Skeleton className="h-[280px] w-full rounded-xl" />
    </div>
  );
}
