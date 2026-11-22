import { ChevronRightIcon, WaypointsIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChainLatencyRangeTabs,
  ChainLatencyUpdatedBadge,
} from "@/components/overview/ChainLatencyControls";
import { ChainLatencyTrendChart } from "@/components/overview/ChainLatencyTrendChart";
import {
  chainStatus,
  formatMs,
  formatSignedMs,
  type ChainHealthChain,
  type ChainHealthSnapshot,
  type ChainHealthSummary,
  type ChainLatencyRange,
  type ChainLatencyStatus,
} from "@/lib/chainHealth";
import { t, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

const STATUS_META: Record<
  ChainLatencyStatus,
  { labelKey: string; dot: string; text: string }
> = {
  normal: {
    labelKey: "overview.chainLatency.statusNormal",
    dot: "bg-primary",
    text: "text-primary",
  },
  slow: {
    labelKey: "overview.chainLatency.statusSlow",
    dot: "bg-warning",
    text: "text-warning",
  },
  insufficient: {
    labelKey: "overview.chainLatency.statusInsufficient",
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
  },
};

function KpiCell({
  label,
  value,
  hint,
  tone = "muted",
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

/** 列表页 KPI：跳间 P50 / 变化 / 变慢链 / 最慢段。 */
export function ChainLatencyKpis({
  summary,
}: {
  summary: ChainHealthSummary;
}) {
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

function NoSamplesBanner() {
  return (
    <div
      data-chain-no-samples
      className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs leading-normal text-muted-foreground"
    >
      <WaypointsIcon
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0"
      />
      <span>{t("overview.chainLatency.noSamplesTitle")}</span>
    </div>
  );
}

function ChainStatusText({ chain }: { chain: ChainHealthChain }) {
  const meta = STATUS_META[chainStatus(chain)];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[10px]",
        meta.text,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", meta.dot)} />
      {t(meta.labelKey)}
    </span>
  );
}

function ChainListRow({
  chain,
  onOpen,
}: {
  chain: ChainHealthChain;
  onOpen: () => void;
}) {
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
  const statusLabel = t(STATUS_META[chainStatus(chain)].labelKey);
  const label = t("overview.chainLatency.openChainAria", {
    name: chain.name,
    status: statusLabel,
    p50: formatMs(chain.latestP50),
    delta: formatSignedMs(chain.deltaMs),
  });
  return (
    <li>
      <button
        type="button"
        data-chain-list-row
        data-chain-id={chain.id}
        onClick={onOpen}
        aria-label={label}
        className="group flex w-full items-center gap-2 rounded-lg border border-transparent px-2.5 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span
              className="min-w-0 max-w-full truncate text-sm"
              title={chain.name}
            >
              {chain.name}
            </span>
            <ChainStatusText chain={chain} />
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {hopsLabel}
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span
            className="block text-[9px] text-muted-foreground"
            title={t("overview.chainLatency.currentP50")}
          >
            P50
          </span>
          <span className="block font-mono text-sm tabular-nums">
            {formatMs(chain.latestP50)}
          </span>
          <span
            className={cn(
              "block font-mono text-[10px] tabular-nums",
              deltaTone,
            )}
            title={t("overview.chainLatency.deltaVsBaseline")}
          >
            {formatSignedMs(chain.deltaMs)}
          </span>
        </span>

        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5" />
      </button>
    </li>
  );
}

/**
 * 链路时延列表：只展示每条链的整体 P50 与整体曲线。
 *
 * 这里刻意不渲染任何 `segments` / 诊断句：分段信息只在进入某条链的详情后
 * 出现，避免列表把「链」和「段」混在一起。
 */
export function ChainLatencyList({
  snapshot,
  range,
  onRangeChange,
  onOpenChain,
}: {
  snapshot: ChainHealthSnapshot;
  range: ChainLatencyRange;
  onRangeChange: (range: ChainLatencyRange) => void;
  onOpenChain: (id: string) => void;
}) {
  useI18n();
  return (
    <div className="space-y-4" data-chain-list>
      <ChainLatencyKpis summary={snapshot.summary} />
      {snapshot.hasSamples ? null : <NoSamplesBanner />}

      <Card className="gap-0" data-chain-trend-card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <CardTitle className="text-sm font-medium">
              {t("overview.chainLatency.trendTitle")}
            </CardTitle>
            <div className="flex min-w-0 items-center gap-2">
              <ChainLatencyUpdatedBadge generatedAt={snapshot.generatedAt} />
              <ChainLatencyRangeTabs
                range={range}
                onRangeChange={onRangeChange}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="min-w-0 p-2 sm:p-4">
          <ChainLatencyTrendChart
            chains={snapshot.chains}
            bucket={snapshot.bucket}
          />
        </CardContent>
      </Card>

      <Card className="gap-0" data-chain-list-card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium">
              {t("overview.chainLatency.listTitle")}
            </CardTitle>
            <Badge
              variant="outline"
              className="shrink-0 font-mono font-normal text-muted-foreground"
            >
              {t("overview.chainLatency.listCount", {
                n: snapshot.chains.length,
              })}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-2">
          <ul className="flex flex-col gap-0.5">
            {snapshot.chains.map((chain) => (
              <ChainListRow
                key={chain.id}
                chain={chain}
                onOpen={() => onOpenChain(chain.id)}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
