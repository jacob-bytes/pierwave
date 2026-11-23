import { useMemo } from "react";
import { ChevronRightIcon, WaypointsIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChainLatencyRangeTabs,
  ChainLatencyUpdatedBadge,
} from "@/components/overview/ChainLatencyControls";
import { ChainLatencyTrendChart } from "@/components/overview/ChainLatencyTrendChart";
import { ChainLossValue } from "@/components/overview/ChainLossValue";
import type { Chain } from "@/lib/api";
import {
  chainDeltaTone,
  chainEndpointAddress,
  chainEndpointAddressIssue,
  chainEndpointNameIssue,
  chainEndpointServerName,
  chainLatestSampleTs,
  chainStatus,
  formatLossPct,
  formatMs,
  formatSignedMs,
  summaryDeltaTone,
  worstHopTone,
  type ChainDeltaTone,
  type ChainEndpoint,
  type ChainHealthChain,
  type ChainHealthSnapshot,
  type ChainHealthSummary,
  type ChainLatencyRange,
} from "@/lib/chainHealth";
import { degradedGroups } from "@/lib/chains";
import { chainHealthStatus, type ChainHealthStatus } from "@/lib/overview";
import { formatRelativeTime } from "@/lib/time";
import { t, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/** 列表表格的列宽：链路 / 起点·终点 / 跳数 / P50 / 丢包 / 状态 / 箭头。 */
const LIST_GRID =
  "sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_3.25rem_4.5rem_4.75rem_5.5rem_1rem]";

/**
 * 端点单元格的 title：地址行和服务器名行各自说明缺失原因。
 *
 * 正常时就是完整值；缺失时区分「主控没返回这一端」与「只缺地址/名字」，
 * 两者在 UI 上都显示 `—`，但排查方向完全不同。
 */
function endpointTitle(
  endpoint: ChainEndpoint | null,
  side: string,
  kind: "address" | "name",
): string {
  const issue =
    kind === "address"
      ? chainEndpointAddressIssue(endpoint)
      : chainEndpointNameIssue(endpoint);
  if (issue === "missing") {
    return t("overview.chainLatency.endpointMissing", { side });
  }
  if (issue === "no_address") {
    return t("overview.chainLatency.endpointAddressMissing", { side });
  }
  if (issue === "no_name") {
    return t("overview.chainLatency.endpointNameMissing", { side });
  }
  return kind === "address"
    ? chainEndpointAddress(endpoint)
    : chainEndpointServerName(endpoint);
}

const HEALTH_META: Record<
  ChainHealthStatus,
  { labelKey: string; titleKey?: string; dot: string; text: string }
> = {
  ok: {
    labelKey: "overview.chainLatency.healthHealthy",
    titleKey: "chains.status.okTitle",
    dot: "bg-primary",
    text: "text-primary",
  },
  degraded: {
    labelKey: "chains.status.degraded",
    titleKey: "chains.status.degradedTitle",
    dot: "bg-warning",
    text: "text-warning",
  },
  blocked: {
    labelKey: "overview.chainBlocked",
    dot: "bg-destructive",
    text: "text-destructive",
  },
  disabled: {
    labelKey: "chains.status.disabled",
    titleKey: "chains.status.disabledTitle",
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

function deltaToneClass(tone: ChainDeltaTone): string {
  return tone === "warning"
    ? "text-warning"
    : tone === "primary"
      ? "text-primary"
      : "text-muted-foreground";
}

/** 列表页 KPI：跳间 P50 / 变化 / 变慢链 / 最慢段。 */
export function ChainLatencyKpis({
  summary,
  chains,
}: {
  summary: ChainHealthSummary;
  /** 用来解析「最慢段」自己的 delta；缺失时 KPI 保持 muted。 */
  chains?: readonly ChainHealthChain[];
}) {
  const deltaTone = summaryDeltaTone(summary.deltaMs);
  const slowTone =
    summary.slowChains !== null && summary.slowChains > 0
      ? "warning"
      : "muted";
  const worst = summary.worstHop;
  const worstTone = worstHopTone(chains ?? [], worst);
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
          tone={worstTone}
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

function ChainHealthStatusCell({
  chain,
  className,
}: {
  chain: Chain | null;
  className?: string;
}) {
  if (!chain) {
    return (
      <span
        data-chain-status="unknown"
        className={cn("text-[10px] text-muted-foreground", className)}
      >
        —
      </span>
    );
  }
  const status = chainHealthStatus(chain);
  const meta = HEALTH_META[status];
  const reason = (chain.blocked_reason ?? "").trim();
  // 降级原因可能有多跳：首跳之外的也进 title，不另起一张卡。
  const degradedTitle =
    status === "degraded"
      ? degradedGroups(chain.groups)
          .map((group) =>
            t("chains.list.degradedGroup", {
              seq: group.seq + 1,
              name: group.name?.trim() || t("chains.detail.unnamedGroup"),
            }),
          )
          .join(" · ")
      : "";
  const title =
    status === "blocked" && reason
      ? reason
      : degradedTitle || t(meta.titleKey ?? meta.labelKey);
  return (
    <span
      data-chain-status={status}
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-[10px] whitespace-nowrap",
        meta.text,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", meta.dot)} />
      {t(meta.labelKey)}
    </span>
  );
}

function ChainListRow({
  chain,
  source,
  onOpen,
}: {
  chain: ChainHealthChain;
  source: Chain | null;
  onOpen: () => void;
}) {
  const deltaTone = deltaToneClass(
    chainDeltaTone(chain.deltaMs, chain.slow),
  );
  // `chainStatus` 是列表状态的唯一来源：normal / slow / insufficient。
  // 只有 slow 才在行上挂徽章，避免把「暂无样本」也标成异常。
  const latencyStatus = chainStatus(chain);
  const hopsLabel = t(
    chain.hops === 1 ? "overview.chainHopsOne" : "overview.chainHops",
    { n: chain.hops },
  );
  const entrySide = t("overview.chainLatency.entry");
  const exitSide = t("overview.chainLatency.exit");
  const addressTitle = `${endpointTitle(chain.entry, entrySide, "address")} → ${endpointTitle(chain.exit, exitSide, "address")}`;
  const nameTitle = `${endpointTitle(chain.entry, entrySide, "name")} → ${endpointTitle(chain.exit, exitSide, "name")}`;
  const sampleTs = chainLatestSampleTs(chain);
  const sampleText =
    sampleTs === null
      ? t("overview.chainLatency.noSamplesShort")
      : t("overview.chainLatency.lastSample", {
          time: formatRelativeTime(sampleTs),
        });
  const lossSamples = chain.lossSamples;
  const lossTitle =
    chain.lossPct === null
      ? t("overview.chainLatency.windowLossNoData")
      : lossSamples !== null &&
          lossSamples.attempts !== null &&
          lossSamples.failures !== null
        ? t("overview.chainLatency.windowLossProbes", {
            attempts: lossSamples.attempts,
            failures: lossSamples.failures,
          })
        : t("overview.chainLatency.windowLoss");
  const statusLabel = source
    ? t(HEALTH_META[chainHealthStatus(source)].labelKey)
    : "—";
  const label = t("overview.chainLatency.openChainAria", {
    name: chain.name,
    status: statusLabel,
    p50: formatMs(chain.latestP50),
    delta: formatSignedMs(chain.deltaMs),
    loss: formatLossPct(chain.lossPct),
  });

  return (
    <li>
      <button
        type="button"
        data-chain-list-row
        data-chain-id={chain.id}
        onClick={onOpen}
        aria-label={label}
        className={cn(
          "group grid w-full grid-cols-1 gap-y-1 rounded-lg border border-transparent px-2.5 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 sm:items-center sm:gap-x-3 sm:gap-y-0",
          LIST_GRID,
        )}
      >
        {/* 窄屏第一行：链路 + 健康状态 + 跳数 + 箭头 */}
        <span
          data-chain-row-main
          className="flex min-w-0 items-center gap-2 sm:contents"
        >
          <span
            className="flex min-w-0 flex-1 items-center gap-1.5 sm:col-start-1 sm:row-start-1"
            title={chain.name}
          >
            <span className="min-w-0 truncate text-sm">{chain.name}</span>
            {latencyStatus === "slow" ? (
              <Badge
                variant="outline"
                data-chain-slow-badge
                className="shrink-0 border-warning/40 px-1 py-0 font-normal text-warning"
              >
                {t("overview.chainLatency.statusSlow")}
              </Badge>
            ) : null}
          </span>
          <ChainHealthStatusCell
            chain={source}
            className="sm:col-start-6 sm:row-start-1 sm:justify-self-end"
          />
          <span
            data-chain-hops
            className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums sm:col-start-3 sm:row-start-1 sm:justify-self-end"
          >
            {hopsLabel}
          </span>
          <ChevronRightIcon
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 sm:col-start-7 sm:row-start-1"
          />
        </span>

        {/* 窄屏第二行：起点 → 终点 / P50 / 丢包 */}
        <span
          data-chain-row-meta
          className="flex min-w-0 items-center gap-2 sm:contents"
        >
          <span
            data-chain-endpoints
            className="min-w-0 flex-1 sm:col-start-2 sm:row-start-1"
          >
            <span
              data-chain-endpoint-address
              className="block truncate font-mono text-[10px] tabular-nums sm:text-xs"
              title={addressTitle}
            >
              <span data-chain-entry-address>
                {chainEndpointAddress(chain.entry)}
              </span>
              <span aria-hidden="true" className="px-1 text-muted-foreground">
                →
              </span>
              <span data-chain-exit-address>
                {chainEndpointAddress(chain.exit)}
              </span>
            </span>
            <span
              data-chain-endpoint-name
              className="mt-0.5 block truncate text-[10px] text-muted-foreground"
              title={nameTitle}
            >
              {chainEndpointServerName(chain.entry)}
              <span aria-hidden="true" className="px-1">
                →
              </span>
              {chainEndpointServerName(chain.exit)}
            </span>
          </span>
          <span
            data-chain-p50
            className="shrink-0 text-right sm:col-start-4 sm:row-start-1"
            title={sampleText}
          >
            <span className="block font-mono text-[11px] tabular-nums sm:text-sm">
              {formatMs(chain.latestP50)}
            </span>
            <span
              className={cn(
                "hidden font-mono text-[10px] tabular-nums sm:block",
                deltaTone,
              )}
              title={t("overview.chainLatency.deltaVsBaseline")}
            >
              {formatSignedMs(chain.deltaMs)}
            </span>
          </span>
          <span
            data-chain-loss
            title={lossTitle}
            className="shrink-0 text-right sm:col-start-5 sm:row-start-1"
          >
            <span className="mr-1 text-[9px] text-muted-foreground sm:hidden">
              {t("overview.chainLatency.windowLoss")}
            </span>
            <ChainLossValue
              value={chain.lossPct}
              className="text-[11px] sm:text-sm"
            />
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * 链路时延列表：KPI / 整体趋势 / 链路表格。
 *
 * 表格列：链路 / 起点·终点 / 跳数 / P50 / 窗口丢包 / 状态。健康状态来自转发链配置
 * （`chainHealthStatus`），不再单起一张「转发链健康」卡；逐段信息只在
 * 点击行打开的详情弹窗里出现。
 */
export function ChainLatencyList({
  snapshot,
  chains,
  range,
  onRangeChange,
  onOpenChain,
}: {
  snapshot: ChainHealthSnapshot;
  chains: readonly Chain[];
  range: ChainLatencyRange;
  onRangeChange: (range: ChainLatencyRange) => void;
  onOpenChain: (id: string) => void;
}) {
  useI18n();
  const chainById = useMemo(
    () => new Map(chains.map((chain) => [chain.id, chain])),
    [chains],
  );

  return (
    <div className="space-y-4" data-chain-list>
      <ChainLatencyKpis summary={snapshot.summary} chains={snapshot.chains} />
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
          <div
            data-chain-list-head
            aria-hidden="true"
            className={cn(
              "hidden items-center gap-x-3 px-2.5 pb-1 text-[10px] text-muted-foreground sm:grid",
              LIST_GRID,
            )}
          >
            <span>{t("overview.chainLatency.listTitle")}</span>
            <span>{t("overview.chainLatency.colEndpoint")}</span>
            <span className="text-right">
              {t("overview.chainLatency.colHops")}
            </span>
            <span className="text-right">P50</span>
            <span className="text-right">
              {t("overview.chainLatency.windowLoss")}
            </span>
            <span className="text-right">
              {t("overview.chainLatency.colStatus")}
            </span>
            <span />
          </div>
          <ul className="flex flex-col gap-0.5">
            {snapshot.chains.map((chain) => (
              <ChainListRow
                key={chain.id}
                chain={chain}
                source={chainById.get(chain.id) ?? null}
                onOpen={() => onOpenChain(chain.id)}
              />
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
