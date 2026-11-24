import { useMemo } from "react";
import { ChevronRightIcon, WaypointsIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChainLatencyRangeTabs,
  ChainLatencyUpdatedBadge,
} from "@/components/overview/ChainLatencyControls";
import {
  CHAIN_HEALTH_STATE_META,
  chainNodeIssueText,
} from "@/components/overview/ChainStatusBadge";
import { ChainLatencyTrendChart } from "@/components/overview/ChainLatencyTrendChart";
import { ChainLossValue } from "@/components/overview/ChainLossValue";
import type { Chain } from "@/lib/api";
import {
  chainEndpointAddress,
  chainEndpointAddressIssue,
  chainEndpointNameIssue,
  chainEndpointServerName,
  chainHealthState,
  chainLatestSampleTs,
  chainNodeIssue,
  chainRoutePreview,
  chainStatus,
  formatLossPct,
  formatMs,
  formatSignedMs,
  summaryDeltaTone,
  worstHopTone,
  type ChainEndpoint,
  type ChainHealthChain,
  type ChainHealthState,
  type ChainHealthSnapshot,
  type ChainHealthSummary,
  type ChainLatencyRange,
} from "@/lib/chainHealth";
import { degradedGroups } from "@/lib/chains";
import { formatRelativeTime } from "@/lib/time";
import { t, useI18n } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * 标准表格列：链路 18% / 起点·终点 31% / 路由 25% / 跳数 56 / P50 72 /
 * 丢包 80 / 状态 80 / chevron 24。三个百分比列吃掉剩余空间。
 *
 * 路由升到 13px 后 22fr 会截断 4 跳链的「… → 新加坡-02」；把数值列缩到
 * 仍能容纳表头与 15px 数值的宽度（56/72/80/80），把空间让给地址与路由，
 * 保证 12px 地址和完整路由同时放得下。
 */
const LIST_GRID =
  "lg:grid-cols-[minmax(0,18fr)_minmax(0,31fr)_minmax(0,25fr)_56px_72px_80px_80px_24px]";

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
  state,
  title,
  className,
}: {
  /** null = 契约里没有这条链的配置，也拿不到状态。 */
  state: ChainHealthState | null;
  title?: string;
  className?: string;
}) {
  if (state === null) {
    return (
      <span
        data-chain-status="unknown"
        className={cn("text-[15px] font-medium tabular-nums text-muted-foreground", className)}
      >
        —
      </span>
    );
  }
  const meta = CHAIN_HEALTH_STATE_META[state];
  return (
    <span
      data-chain-status={state}
      title={title ?? t(meta.titleKey ?? meta.labelKey)}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 text-[15px] font-medium tabular-nums whitespace-nowrap",
        meta.text,
        className,
      )}
    >
      <span
        aria-hidden="true"
        data-chain-status-dot
        className={cn("size-2 rounded-full", meta.dot)}
      />
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
  // 状态优先取新契约的 `status.kind`（节点离线 → 阻断、异常 → 降级），
  // 缺失时回退到链配置 / 旧的 slow / 样本判定。
  const latencyStatus = chainStatus(chain);
  const state = chainHealthState(chain, source);
  const issue = chainNodeIssue(chain);
  const issueText = chainNodeIssueText(issue);
  const stateMeta = CHAIN_HEALTH_STATE_META[state];
  const statusLabel = t(stateMeta.labelKey);
  const blockedReason = (source?.blocked_reason ?? "").trim();
  // 降级原因可能有多跳：首跳之外的也进 title，不另起一张卡。
  const degradedTitle =
    state === "degraded" && source
      ? degradedGroups(source.groups)
          .map((group) =>
            t("chains.list.degradedGroup", {
              seq: group.seq + 1,
              name: group.name?.trim() || t("chains.detail.unnamedGroup"),
            }),
          )
          .join(" · ")
      : "";
  const statusTitle = issueText
    ? t("overview.chainLatency.statusWithReason", {
        status: statusLabel,
        reason: issueText,
      })
    : chain.status !== null
      ? chain.status.cause === "node_offline"
        ? t("overview.chainLatency.nodeOfflineTitle")
        : chain.status.cause === "node_unhealthy"
          ? t("overview.chainLatency.nodeUnhealthyTitle")
          : chain.status.cause === "no_samples"
            ? t("overview.chainLatency.statusInsufficientTitle")
            : chain.status.cause === "unmeasurable"
              ? t("overview.chainLatency.unmeasurableTitle")
              : chain.status.cause === "slow"
                ? t("overview.chainLatency.slowTitle")
                : t(stateMeta.titleKey ?? stateMeta.labelKey)
      : state === "blocked" && blockedReason
        ? blockedReason
        : degradedTitle || t(stateMeta.titleKey ?? stateMeta.labelKey);
  // 阻断 / 降级 / 停用时不和「变慢」并排，避免两个徽章说不同的话。
  const showSlowBadge = latencyStatus === "slow" && state === "ok";
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
  const label = t("overview.chainLatency.openChainAria", {
    name: chain.name,
    status: statusLabel,
    p50: formatMs(chain.latestP50),
    delta: formatSignedMs(chain.deltaMs),
    loss: formatLossPct(chain.lossPct),
  });
  // 路由列只显示真实节点：>3 个节点或契约缺中间跳时用 `…`。
  const routeLabels = chainRoutePreview(chain);
  const routeText = routeLabels.length > 0 ? routeLabels.join(" → ") : "—";
  const routeTitle = routeLabels.length > 0 ? routeText : nameTitle;

  return (
    <li
      data-chain-list-row-item
      className="border-b border-border/60 last:border-b-0"
    >
      <button
        type="button"
        data-chain-list-row
        data-chain-id={chain.id}
        onClick={onOpen}
        aria-label={label}
        className={cn(
          "group grid w-full grid-cols-1 gap-x-3 gap-y-1 rounded-lg border border-transparent px-3 py-2 text-left outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 lg:items-center lg:py-3",
          LIST_GRID,
        )}
      >
        {/* 链路名 + 名下小字样本时间；表头已给列名，行内不再重复标签。 */}
        <span
          data-chain-row-lead
          className="flex min-w-0 flex-col gap-0.5 lg:col-start-1 lg:row-start-1"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span
              className="min-w-0 truncate text-sm font-medium"
              title={chain.name}
            >
              {chain.name}
            </span>
            {showSlowBadge ? (
              <Badge
                variant="outline"
                data-chain-slow-badge
                className="shrink-0 border-warning/40 px-1 py-0 font-normal text-warning"
              >
                {t("overview.chainLatency.statusSlow")}
              </Badge>
            ) : null}
          </span>
          {issueText ? (
            <span
              data-chain-status-reason
              className={cn(
                "truncate text-[11px] leading-4",
                issue?.kind === "offline" ? "text-destructive" : "text-warning",
              )}
              title={issueText}
            >
              {issueText}
            </span>
          ) : null}
          <span
            data-chain-sample
            className="truncate text-[13px] leading-5 text-muted-foreground"
            title={sampleText}
          >
            {sampleText}
          </span>
        </span>

        {/* 地址：只有一个 muted 箭头，不画连接线、不拉伸。 */}
        <span
          data-chain-endpoints
          data-chain-row-address
          className="flex min-w-0 flex-col gap-0.5 lg:col-start-2 lg:row-start-1"
        >
          <span className="text-[11px] text-muted-foreground lg:hidden">
            {t("overview.chainLatency.colEndpoint")}
          </span>
          <span
            data-chain-endpoint-address
            className="flex w-full min-w-0 max-w-[520px] items-center gap-1 font-mono text-xs leading-5 tabular-nums"
            title={addressTitle}
          >
            <span
              data-chain-entry-address
              className="min-w-0 shrink-0 truncate"
            >
              {chainEndpointAddress(chain.entry)}
            </span>
            <span
              aria-hidden="true"
              className="shrink-0 text-muted-foreground"
            >
              →
            </span>
            <span data-chain-exit-address className="min-w-0 truncate">
              {chainEndpointAddress(chain.exit)}
            </span>
          </span>
        </span>

        {/* 路由独立成列：12px muted，超长截断，title 给完整序列。 */}
        <span
          data-chain-row-route
          className="flex min-w-0 flex-col gap-0.5 lg:col-start-3 lg:row-start-1"
        >
          <span className="text-[11px] text-muted-foreground lg:hidden">
            {t("overview.chainLatency.colRoute")}
          </span>
          <span
            data-chain-endpoint-name
            className="min-w-0 truncate text-[13px] leading-5 text-muted-foreground"
            title={routeTitle}
          >
            {routeText}
          </span>
        </span>

        {/* 数值列：表头已给 P50 / 窗口丢包 / 状态，行内只留值。 */}
        <span
          data-chain-row-metrics
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 lg:contents"
        >
          <span
            data-chain-hops
            className="text-[15px] font-medium text-muted-foreground tabular-nums lg:col-start-4 lg:row-start-1"
          >
            <span className="text-[11px] lg:hidden">
              {t("overview.chainLatency.colHops")}{" "}
            </span>
            {chain.hops}
          </span>
          <span
            data-chain-p50
            className="inline-flex items-baseline gap-1 lg:col-start-5 lg:row-start-1"
            title={sampleText}
          >
            <span className="text-[11px] text-muted-foreground lg:hidden">
              {t("overview.chainLatency.mobileLatency")}
            </span>
            <span className="font-mono text-[15px] leading-none font-medium tabular-nums">
              {formatMs(chain.latestP50)}
            </span>
          </span>
          <span
            data-chain-loss
            className="inline-flex items-baseline gap-1 lg:col-start-6 lg:row-start-1"
            title={lossTitle}
          >
            <span className="text-[11px] text-muted-foreground lg:hidden">
              {t("overview.chainLatency.mobileLoss")}
            </span>
            <ChainLossValue value={chain.lossPct} className="text-sm" />
          </span>
          <ChainHealthStatusCell
            state={source === null && chain.status === null ? null : state}
            title={statusTitle}
            className="lg:col-start-7 lg:row-start-1"
          />
          <ChevronRightIcon
            aria-hidden="true"
            data-chain-chevron
            className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 lg:col-start-8 lg:row-start-1"
          />
        </span>
      </button>
    </li>
  );
}

/**
 * 链路时延列表：KPI / 整体趋势 / 链路表格。
 *
 * 表格列：链路 / 起点·终点 / 跳数 / P50 / 窗口丢包 / 状态。状态优先取
 * `chains[].status` 的节点健康结论，旧主控缺失时回退到链配置与样本判定；
 * 不再单起一张「转发链健康」卡，逐段信息只在点击行打开的详情弹窗里出现。
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
              "hidden items-center gap-x-3 px-3 pb-1 text-left text-[11px] text-muted-foreground lg:grid",
              LIST_GRID,
            )}
          >
            <span>{t("overview.chainLatency.listTitle")}</span>
            <span>{t("overview.chainLatency.colEndpoint")}</span>
            <span>{t("overview.chainLatency.colRoute")}</span>
            <span>{t("overview.chainLatency.colHops")}</span>
            <span>P50</span>
            <span>{t("overview.chainLatency.windowLoss")}</span>
            <span>{t("overview.chainLatency.colStatus")}</span>
            <span />
          </div>
          <ul className="flex flex-col">
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
