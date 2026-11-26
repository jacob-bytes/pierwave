import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { TriangleAlertIcon, WaypointsIcon } from "lucide-react";
import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ChainKpiSkeletonGrid } from "@/components/overview/ChainKpi";
import { ChainLatencyDetailDialog } from "@/components/overview/ChainLatencyDetailDialog";
import { ChainTemplateInsightList } from "@/components/overview/ChainTemplateInsightList";
import { ChainUsageView } from "@/components/overview/ChainUsageView";
import { ChainLatencyList } from "@/components/overview/ChainLatencyList";
import { PanelError } from "@/components/overview/PanelError";
import { resolveChainSection } from "@/lib/chainSections";
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
 * 内容再分三个子页（转发链 / 转发模板 / 转发用量），子 tab 由
 * `ChainSectionTabs` 渲染在主 tab 行、服务器筛选器右侧；URL 是子页的唯一来源：
 * `?view=chain&section=chains|templates|usage`，默认「转发链」不写参数。离开
 * 本 tab 时 `applyOverviewView` 会清掉 `section`，刷新 / 分享仍保持当前子页。
 *
 * 详情不再替换整页，而是列表之上的一层居中弹窗；`?chain=<id>` 只作为
 * 深链接兼容保留（刷新 / 分享时直接打开弹窗），关闭弹窗即清理该参数，
 * 不改变 `view=chain` 与 `section`，列表始终留在身后。
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
  const section = resolveChainSection(searchParams.get("section"));
  const chainParam = (searchParams.get("chain") ?? "").trim() || null;
  const { hours, bucket } = chainLatencyWindow(range);
  const scoped = filtered && selectedIds.length > 0;
  // 模板子页是独立接口，不需要 chain-health；切到模板时停掉链路轮询，
  // 切回转发链仍会先命中缓存，不会重新铺骨架。
  const query = useChainHealth(
    hours,
    bucket,
    scoped ? selectedIds : [],
    selectedIds.length > 0 && section === "chains",
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
    section === "chains" && chainParam && snapshot
      ? (snapshot.chains.find((chain) => chain.id === chainParam) ?? null)
      : null;
  // 详情徽章要和列表状态列说同一句话：把配置里的停用 / 旧 blocked 一并带进去。
  const detailConfig = detailChain
    ? (chains.data?.find((chain) => chain.id === detailChain.id) ?? null)
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

  // 模板子页不接受 `chain` 深链：直接访问 `?section=templates&chain=x` 时
  // 也要清掉它，否则切回转发链会重新弹出详情。
  useEffect(() => {
    if (section === "chains" || !chainParam) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete("chain");
        return next;
      },
      { replace: true },
    );
  }, [section, chainParam, setSearchParams]);

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

  // 三个子页互不占位：转发链子页只拼自己的四态，模板 / 用量子页整块交给
  // 各自的列表。
  let chainsContent: ReactNode;
  if (selectedIds.length === 0) {
    chainsContent = (
      <ChainScopeEmpty
        title={t("overview.scope.emptyTitle")}
        description={t("overview.scope.emptyDesc")}
      />
    );
  } else if (query.isPending && query.data === undefined) {
    // 只有第一次请求（还没有任何 payload）才铺骨架；切时窗时 placeholderData
    // 会先顶上旧快照，整棵视图（含详情弹窗）保持挂载。
    chainsContent = <ChainLatencySkeleton />;
  } else if (query.isError) {
    chainsContent = (
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
    );
  } else if (parsed === null || parsed.status === "unsupported") {
    chainsContent = <UnsupportedChainLatency />;
  } else if (parsed.status === "empty") {
    chainsContent = <NoChainsCard scoped={scoped} />;
  } else {
    const scopeUnsupported =
      scoped && query.data !== null && query.data?.scope?.filtered !== true;
    chainsContent = (
      <div className="space-y-4" data-chain-list-page>
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
          config={detailConfig}
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

  if (section === "templates") {
    return (
      <div data-chain-sections>
        <ChainTemplateInsightList />
      </div>
    );
  }

  // 用量子页不接服务器筛选：`/api/v1/forward-traffic` 尚无 server_ids，
  // 这里不传 selectedIds，也不显示筛选生效提示。
  if (section === "usage") {
    return (
      <div data-chain-sections>
        <ChainUsageView />
      </div>
    );
  }

  return (
    <div className="space-y-4" data-chain-view data-chain-sections>
      {chainsContent}
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
      <ChainKpiSkeletonGrid />
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
