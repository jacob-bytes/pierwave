import { Suspense, useCallback, useMemo, useState } from "react";
import { WaypointsIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common";
import {
  type ChainTemplateDetail,
  type ChainTemplateMemberStatus,
} from "@/lib/chainTemplateInsight";
import {
  TEMPLATE_MAX_ZOOM,
  TEMPLATE_MIN_ZOOM,
  buildTemplateGraph,
  showsFitHint,
  type TemplateGraphUnusedMember,
} from "@/lib/chainTemplateGraph";
import { ChainTemplateFlowLazy } from "@/components/overview/chain-template-flow";
import type { TemplateFlowApi } from "@/components/overview/chain-template-flow/context";
import { useI18n, type TFunction } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * 成员状态文案。四档与链路详情一致：online / offline / degraded（后端
 * abnormal、no_data）/ unknown；`degraded` 用 warning 色，不当 unknown。
 */
function statusText(status: ChainTemplateMemberStatus, translate: TFunction): string {
  if (status === "offline") return translate("overview.chainTemplateInsight.offline");
  if (status === "online") return translate("overview.chainTemplateInsight.online");
  if (status === "degraded") return translate("overview.chainTemplateInsight.degraded");
  return translate("overview.chainTemplateInsight.unknownStatus");
}

function UnusedMembers({ rows }: { rows: readonly TemplateGraphUnusedMember[] }) {
  const { t: translate } = useI18n();
  if (rows.length === 0) return null;
  return (
    <div
      data-template-unused
      className="mt-3 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2"
    >
      <p className="text-[11px] text-muted-foreground">
        {translate("overview.chainTemplateInsight.unusedTitle", {
          n: rows.length,
        })}
      </p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {rows.map((row) => (
          <li
            key={`${row.seq}-${row.key}`}
            data-template-unused-member
            data-status={row.status}
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded-full border border-border px-1.5 py-0.5 font-mono text-[11px] leading-tight",
              row.status === "offline"
                ? "border-destructive/40 text-destructive"
                : row.status === "degraded"
                  ? "border-warning/40 text-warning"
                  : "text-muted-foreground",
            )}
            title={`${row.name} · ${statusText(row.status, translate)}`}
          >
            {/* 状态除颜色外的文字标记：离线 / 降级都有 sr-only 文案。 */}
            {row.status === "offline" || row.status === "degraded" ? (
              <span className="sr-only">{statusText(row.status, translate)}</span>
            ) : null}
            <span className="truncate">{row.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ZOOM_BUTTON =
  "inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border px-1.5 text-[11px] leading-none text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40";

/**
 * 转发链模板拓扑：React Flow 卡片画布（入口列 → 各跳列 → 目标列）。
 *
 * 每列最多 4 张成员卡 + 1 张 `+N 台` 折叠卡；目标列每个上游至少留 1 张，
 * 其余折成目标卡上的 `+N 个目标` 小标签 —— 折叠不再是独立节点。折叠卡 /
 * 目标标签只展开自己那一组，卡片头部在有展开时给「恢复默认」。
 *
 * 缩放栏在卡片头部右侧（`− 100% + 适应窗口`），不用 React Flow 官方控件；
 * 画布本身懒加载，不在「链路时延」主 chunk 里。
 */
export function ChainTemplateTopology({
  detail,
}: {
  detail: ChainTemplateDetail;
}) {
  const { t: translate } = useI18n();
  const [expandedColumns, setExpandedColumns] = useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );
  const [expandedTargets, setExpandedTargets] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [flowApi, setFlowApi] = useState<TemplateFlowApi | null>(null);
  const [zoom, setZoom] = useState(1);

  const graph = useMemo(() => buildTemplateGraph(detail), [detail]);

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

  const hasExpanded =
    expandedColumns.size > 0 || expandedTargets.size > 0;
  const zoomPercent = Math.round(zoom * 100);

  // 空模板没有画布：缩放栏不出现，只留状态图例解释未使用成员的圆点。
  const zoomBar = graph.empty ? null : (
    <div data-template-flow-zoom className="hidden items-center gap-1 sm:flex">
      {/*
       * 自适应缩放低于 90% 时，百分比是唯一能说明「字为什么变小」的信息；
       * 提示紧挨缩放栏，不新开一行，避免把卡片头部撑高。
       */}
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
    <Card className="min-w-0 gap-0" data-template-topology-card>
      <CardHeader className="border-b border-border pb-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <CardTitle className="text-sm font-medium">
            {translate("overview.chainTemplateInsight.topologyTitle")}
          </CardTitle>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <span className="inline-flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full border border-primary"
                />
                {translate("overview.chainTemplateInsight.online")}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full border border-warning"
                />
                {translate("overview.chainTemplateInsight.degraded")}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full border border-destructive"
                />
                {translate("overview.chainTemplateInsight.offline")}
              </span>
            </span>
            {hasExpanded ? (
              <button
                type="button"
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
      <CardContent className="min-w-0 p-2 sm:p-4">
        <div data-template-topology>
          {graph.empty ? (
            <EmptyState
              icon={WaypointsIcon}
              title={translate("overview.chainTemplateInsight.emptyTopologyTitle")}
              description={translate(
                "overview.chainTemplateInsight.emptyTopologyDesc",
              )}
              className="py-10"
            />
          ) : (
            <Suspense
              fallback={
                <Skeleton
                  data-template-flow-loading
                  className="h-[320px] w-full rounded-xl"
                />
              }
            >
              <ChainTemplateFlowLazy
                graph={graph}
                templateName={detail.template.name}
                expandedColumns={expandedColumns}
                expandedTargets={expandedTargets}
                onExpandColumn={expandColumn}
                onExpandTargets={expandTargets}
                onZoomChange={setZoom}
                onReady={setFlowApi}
              />
            </Suspense>
          )}
        </div>
        <UnusedMembers rows={graph.unused} />
      </CardContent>
    </Card>
  );
}
