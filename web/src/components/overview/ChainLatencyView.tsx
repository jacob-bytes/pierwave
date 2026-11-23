import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TriangleAlertIcon, WaypointsIcon } from "lucide-react";
import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChainLatencyDetailDialog } from "@/components/overview/ChainLatencyDetailDialog";
import { ChainLatencyList } from "@/components/overview/ChainLatencyList";
import { PanelError } from "@/components/overview/PanelError";
import {
  CHAIN_HEALTH_POLL_MS,
  chainLatencyWindow,
  normalizeChainHealth,
  segmentTrends,
  type ChainHealthSnapshot,
  type ChainLatencyRange,
} from "@/lib/chainHealth";
import { errorText } from "@/lib/errors";
import { filterChainsByScope } from "@/lib/overviewScope";
import { useChainHealth, useChainLatency, useChains } from "@/lib/queries";
import { t, useI18n } from "@/i18n";

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
 * 「链路时延」tab：KPI + 趋势图 + 链路表格。
 *
 * 详情不再替换整页，而是列表之上的一层居中弹窗；`?chain=<id>` 只作为
 * 深链接兼容保留（刷新 / 分享时直接打开弹窗），关闭弹窗即清理该参数，
 * 不改变 `view=chain`，列表始终留在身后。
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

  // 深链接指向已删除 / 不在筛选范围内的链：清掉参数，不弹空壳弹窗。
  useEffect(() => {
    if (!chainParam || snapshot === null) return;
    if (snapshot.chains.some((chain) => chain.id === chainParam)) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("chain");
        return next;
      },
      { replace: true },
    );
  }, [chainParam, snapshot, setSearchParams]);

  function openChain(id: string) {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("view", "chain");
        next.set("chain", id);
        return next;
      },
      // 打开详情只是覆盖当前 URL，不是一次新的历史记录；否则关闭后按后退
      // 又会回到同一个 `?chain=`，看起来像按钮失灵。
      { replace: true },
    );
  }

  function closeChain() {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("chain");
        return next;
      },
      { replace: true },
    );
  }

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

  // 只有第一次请求（还没有任何 payload）才铺骨架；切时窗时 placeholderData
  // 会先顶上旧快照，整棵视图（含详情弹窗）保持挂载。
  if (query.isPending && query.data === undefined) {
    return <ChainLatencySkeleton />;
  }

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
      </div>
    );
  }

  if (parsed === null || parsed.status === "unsupported") {
    return (
      <div className="space-y-4" data-chain-view>
        <UnsupportedChainLatency />
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

  const scopeUnsupported =
    scoped && query.data !== null && query.data?.scope?.filtered !== true;

  return (
    <div className="space-y-4" data-chain-view data-chain-list-page>
      {scopeUnsupported ? <ScopeWarning /> : null}
      <ChainLatencyList
        snapshot={parsed.snapshot}
        chains={scopedChains}
        range={range}
        onRangeChange={setRange}
        onOpenChain={openChain}
      />
      <ChainLatencyDetailDialog
        chain={detailChain}
        snapshot={parsed.snapshot}
        range={range}
        onRangeChange={setRange}
        trends={trends}
        trendPending={latency.isPending}
        onClose={closeChain}
      />
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
