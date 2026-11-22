import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TriangleAlertIcon, WaypointsIcon } from "lucide-react";
import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChainLatencyDetail } from "@/components/overview/ChainLatencyDetail";
import { ChainLatencyList } from "@/components/overview/ChainLatencyList";
import { PanelError } from "@/components/overview/PanelError";
import type { Chain } from "@/lib/api";
import {
  CHAIN_HEALTH_POLL_MS,
  chainLatencyWindow,
  normalizeChainHealth,
  segmentTrends,
  type ChainHealthSnapshot,
  type ChainLatencyRange,
} from "@/lib/chainHealth";
import { errorText } from "@/lib/errors";
import { chainHealthRows, type ChainHealthStatus } from "@/lib/overview";
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

function ScopeWarning() {
  return (
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
  );
}

/**
 * 「链路时延」tab 的路由层：
 * - 无 `?chain=` → 链路列表（只有整体 KPI / 整体迷你趋势）；
 * - 有 `?chain=<id>` → 该链详情（完整链路 + 逐段明细）。
 *
 * 链 id 写进 URL，深链接与刷新都能直接打开详情；返回列表时只删除 `chain`，
 * 保留 `view=chain` 与服务器筛选参数。
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
  const [searchParams, setSearchParams] = useSearchParams();
  const chainParam = (searchParams.get("chain") ?? "").trim() || null;
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
  const snapshot: ChainHealthSnapshot | null =
    parsed !== null && parsed.status !== "unsupported"
      ? parsed.snapshot
      : null;
  const detailChain =
    chainParam && snapshot
      ? (snapshot.chains.find((chain) => chain.id === chainParam) ?? null)
      : null;

  const latency = useChainLatency(
    detailChain?.id ?? "",
    hours,
    Boolean(detailChain),
    CHAIN_HEALTH_POLL_MS,
  );
  const trends = useMemo(
    () => segmentTrends(latency.data ?? [], bucket),
    [latency.data, bucket],
  );

  // 进入/离开详情时回到内容区顶部：从列表中部点进来时不要停在卡片中段。
  // AppShell 的可滚动容器是 #main-content，不是 window。
  useEffect(() => {
    document.getElementById("main-content")?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [chainParam]);

  function openChain(id: string) {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("view", "chain");
      next.set("chain", id);
      return next;
    });
  }

  function backToList() {
    // replace：返回列表不新增历史条目，浏览器后退不会又弹回详情。
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("view", "chain");
        next.delete("chain");
        return next;
      },
      { replace: true },
    );
  }

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

  if (chainParam) {
    if (detailChain === null) {
      return (
        <div className="space-y-4" data-chain-view>
          <ChainNotFound onBack={backToList} />
        </div>
      );
    }
    const scopeUnsupported =
      scoped && query.data !== null && query.data?.scope?.filtered !== true;
    return (
      <div className="space-y-4" data-chain-view data-chain-detail-page>
        {scopeUnsupported ? <ScopeWarning /> : null}
        <ChainLatencyDetail
          chain={detailChain}
          snapshot={parsed.snapshot}
          range={range}
          onRangeChange={setRange}
          onBack={backToList}
          trends={trends}
          trendPending={latency.isPending}
        />
      </div>
    );
  }

  const scopeUnsupported =
    scoped && query.data !== null && query.data?.scope?.filtered !== true;

  return (
    <div className="space-y-4" data-chain-view data-chain-list-page>
      {scopeUnsupported ? <ScopeWarning /> : null}
      <ChainLatencyList
        snapshot={parsed.snapshot}
        range={range}
        onRangeChange={setRange}
        onOpenChain={openChain}
      />
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

function ChainNotFound({ onBack }: { onBack: () => void }) {
  return (
    <Card>
      <CardContent>
        <EmptyState
          icon={WaypointsIcon}
          title={t("overview.chainLatency.notFoundTitle")}
          description={t("overview.chainLatency.notFoundDesc")}
          className="py-16"
          action={
            <Button type="button" variant="outline" onClick={onBack}>
              {t("overview.chainLatency.backToList")}
            </Button>
          }
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
