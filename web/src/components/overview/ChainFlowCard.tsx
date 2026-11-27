import { Suspense, useCallback, useMemo, useState } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChainLossValue } from "@/components/overview/ChainLossValue";
import { ChainTemplateFlowLazy } from "@/components/overview/chain-template-flow";
import type { TemplateFlowApi } from "@/components/overview/chain-template-flow/context";
import {
  chainLastHopUnmeasurable,
  chainLossTone,
  chainTopologyGraph,
  formatMs,
  type ChainHealthChain,
} from "@/lib/chainHealth";
import { chainLastHopReasonText } from "@/lib/chainStatusText";
import { buildChainFlowGraph } from "@/lib/chainFlowGraph";
import {
  TEMPLATE_MAX_ZOOM,
  TEMPLATE_MIN_ZOOM,
  showsFitHint,
} from "@/lib/chainTemplateGraph";
import { useI18n } from "@/i18n";

const ZOOM_BUTTON =
  "inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border px-1.5 text-[11px] leading-none text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";

/**
 * 顶部整体信息：整链 P50 与整链丢包并列。
 *
 * `loss_pct = null` 时显示 muted 的 `—` 并注明「无探测数据」，绝不画成 0%；
 * `loss_partial` 表示部分跳没有探测，丢包只是可见跳的汇总。
 */
function ChainOverallStats({ chain }: { chain: ChainHealthChain }) {
  const { t } = useI18n();
  const samples = chain.lossSamples;
  const lossTitle =
    chain.lossPct === null
      ? t("overview.chainLatency.windowLossNoData")
      : samples !== null && samples.attempts !== null && samples.failures !== null
        ? t("overview.chainLatency.windowLossProbes", {
            attempts: samples.attempts,
            failures: samples.failures,
          })
        : t("overview.chainLatency.windowLoss");

  return (
    <div
      data-chain-overall-stats
      className="flex min-w-0 flex-wrap items-baseline justify-end gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
    >
      <span className="inline-flex items-baseline gap-1.5">
        <span className="text-[11px] text-muted-foreground">P50</span>
        <span className="font-mono text-[13px] text-foreground tabular-nums">
          {formatMs(chain.latestP50)}
        </span>
      </span>
      <span
        data-chain-loss-summary
        data-loss-tone={chainLossTone(chain.lossPct) ?? "none"}
        title={lossTitle}
        className="inline-flex items-baseline gap-1.5"
      >
        <span className="text-[11px] text-muted-foreground">
          {t("overview.chainLatency.currentWindowLoss")}
        </span>
        <ChainLossValue value={chain.lossPct} className="text-[13px]" />
      </span>
      {chain.lossPct === null ? (
        <span
          data-chain-loss-nodata
          className="text-[11px] text-muted-foreground"
        >
          {t("overview.chainLatency.lossNoData")}
        </span>
      ) : null}
      {chain.lossPartial ? (
        <span data-chain-loss-partial className="text-[11px] text-warning">
          {t("overview.chainLatency.lossPartial")}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 链路详情「完整链路」：复用模板拓扑画布（紧凑档）。
 *
 * 每台成员一张卡、按跳成列、直角折线、每段一个时延药丸；默认点亮首选
 * 路径（其余 35%），点亮连线带 1s 前进虚线。折叠规则与模板一致：一列
 * 超过 4 台时折成 4 + 1 张卡，列头写 `4 / 6 台`，有展开时给「恢复默认」。
 *
 * 卡片头部沿用模板拓扑的同一套按钮类与文案键：标题 + 整链统计 + 恢复
 * 默认 + 缩放栏（`− 100% + 适应窗口`）。目标缺失提示保留；空链只留
 * 「暂无时延样本」，不渲染一张空画布。
 */
export function ChainFlowCard({ chain }: { chain: ChainHealthChain }) {
  const { t: translate } = useI18n();
  const [expandedColumns, setExpandedColumns] = useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );
  const [expandedTargets, setExpandedTargets] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [flowApi, setFlowApi] = useState<TemplateFlowApi | null>(null);
  const [zoom, setZoom] = useState(1);

  const lastHopUnmeasurable = chainLastHopUnmeasurable(chain);
  const missingText = translate("overview.chainLatency.missingHop");
  const unmeasurableText =
    chainLastHopReasonText(chain) ?? missingText;
  const graph = useMemo(
    () =>
      buildChainFlowGraph(chain, {
        unmeasurableText,
        missingText,
      }),
    [chain, missingText, unmeasurableText],
  );
  const topology = useMemo(() => chainTopologyGraph(chain), [chain]);

  const expandColumn = useCallback((seq: number) => {
    setExpandedColumns((previous) => {
      if (previous.has(seq)) return previous;
      const next = new Set(previous);
      next.add(seq);
      return next;
    });
  }, []);

  const expandTargets = useCallback((upstreamId: string) => {
    setExpandedTargets((previous) => {
      if (previous.has(upstreamId)) return previous;
      const next = new Set(previous);
      next.add(upstreamId);
      return next;
    });
  }, []);

  const restoreDefaults = useCallback(() => {
    setExpandedColumns(new Set<number>());
    setExpandedTargets(new Set<string>());
  }, []);

  const hasExpanded = expandedColumns.size > 0 || expandedTargets.size > 0;
  const zoomPercent = Math.round(zoom * 100);
  const nodeCount = graph.columns.reduce(
    (sum, column) => sum + column.members.length,
    0,
  );

  const zoomBar = graph.empty ? null : (
    <div
      data-chain-flow-zoom
      data-template-flow-zoom
      className="hidden items-center gap-1 sm:flex"
    >
      {showsFitHint(zoom) ? (
        <span
          data-template-fit-hint
          className="mr-1 inline-flex items-center text-[11px] leading-none text-muted-foreground"
        >
          {translate("overview.chainTemplateInsight.flowFitHint", {
            percent: zoomPercent,
          })}
        </span>
      ) : null}
      <button
        type="button"
        data-flow-zoom-out
        aria-label={translate("overview.chainTemplateInsight.flowZoomOut")}
        disabled={flowApi === null || zoom <= TEMPLATE_MIN_ZOOM}
        onClick={() => flowApi?.zoomOut()}
        className={ZOOM_BUTTON}
      >
        <span aria-hidden="true">−</span>
      </button>
      <span
        data-flow-zoom-value
        className="min-w-11 text-center font-mono text-[11px] tabular-nums text-muted-foreground"
      >
        {`${zoomPercent}%`}
      </span>
      <button
        type="button"
        data-flow-zoom-in
        aria-label={translate("overview.chainTemplateInsight.flowZoomIn")}
        disabled={flowApi === null || zoom >= TEMPLATE_MAX_ZOOM}
        onClick={() => flowApi?.zoomIn()}
        className={ZOOM_BUTTON}
      >
        <span aria-hidden="true">+</span>
      </button>
      <button
        type="button"
        data-flow-zoom-fit
        disabled={flowApi === null}
        onClick={() => flowApi?.fit()}
        className={ZOOM_BUTTON}
      >
        {translate("overview.chainTemplateInsight.flowFit")}
      </button>
    </div>
  );

  return (
    <Card className="min-w-0 gap-0" data-chain-flow>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle className="text-sm font-medium">
            {translate("overview.chainLatency.topologyTitle")}
          </CardTitle>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <ChainOverallStats chain={chain} />
            {hasExpanded ? (
              <button
                type="button"
                data-chain-flow-reset
                data-template-flow-reset
                onClick={restoreDefaults}
                className={ZOOM_BUTTON}
              >
                {translate("overview.chainTemplateInsight.flowReset")}
              </button>
            ) : null}
            {zoomBar}
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 p-2 sm:p-3">
        {graph.empty ? (
          <p
            data-chain-flow-empty
            className="px-1 py-3 text-xs text-muted-foreground"
          >
            {translate("overview.chainLatency.noSamplesShort")}
          </p>
        ) : (
          <Suspense
            fallback={
              <Skeleton
                data-template-flow-loading
                className="h-[160px] w-full rounded-xl"
              />
            }
          >
            <ChainTemplateFlowLazy
              kind="chain"
              graph={graph}
              templateName={chain.name}
              ariaLabel={translate(
                "overview.chainLatency.flowTopologyAria",
                {
                  name: chain.name,
                  nodes: nodeCount,
                  edges: graph.edges.length,
                },
              )}
              expandedColumns={expandedColumns}
              expandedTargets={expandedTargets}
              onExpandColumn={expandColumn}
              onExpandTargets={expandTargets}
              onZoomChange={setZoom}
              onReady={setFlowApi}
            />
          </Suspense>
        )}
        {/* 不可测不是「缺数据」：原因已经标在最后一跳的边上，不再叠旧告警。 */}
        {topology.targetMissing && !lastHopUnmeasurable ? (
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-normal text-warning">
            <TriangleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-3 shrink-0"
            />
            <span>{translate("overview.chainLatency.missingLastHop")}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
