import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ServerFilter } from "@/components/overview/ServerFilter";
import type { OverviewScopeState } from "@/components/overview/useOverviewScope";
import type { OverviewStats } from "@/lib/api";
import {
  applyOverviewView,
  resolveOverviewView,
  type OverviewView,
} from "@/lib/overviewViews";
import { t, useI18n } from "@/i18n";

/** 四个视图都按需加载；切到某个 tab 才请求并挂载它自己的卡片。 */
const ServerHealthView = lazy(
  () => import("@/components/overview/ServerHealthView"),
);
const TrafficView = lazy(() => import("@/components/overview/TrafficView"));
const CostView = lazy(() => import("@/components/overview/CostView"));
const ChainLatencyView = lazy(
  () => import("@/components/overview/ChainLatencyView"),
);

const VIEW_META: readonly {
  value: OverviewView;
  labelKey: string;
}[] = [
  { value: "server", labelKey: "overview.views.server" },
  { value: "traffic", labelKey: "overview.views.traffic" },
  { value: "cost", labelKey: "overview.views.cost" },
  { value: "chain", labelKey: "overview.views.chain" },
];

/** tab 内部的 loading 骨架：只占当前 tab 的内容区，不重复 KPI。 */
function InsightFallback() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <Skeleton className="h-[88px] w-full rounded-xl" />
      <Skeleton className="h-[320px] w-full rounded-xl" />
      <section className="grid gap-4 xl:grid-cols-3">
        <Skeleton className="h-[240px] w-full rounded-xl" />
        <Skeleton className="h-[240px] w-full rounded-xl xl:col-span-2" />
      </section>
    </div>
  );
}

/**
 * KPI 下方的四个 tab：服务器状态 / 流量 / 成本开销 / 链路时延。
 *
 * URL 是视图与服务器筛选的唯一来源：
 * - `?view=server|traffic|cost|chain`（默认不写参数）；
 * - `?servers=id1,id2`（默认选择不写，用户改动后才写）。
 *
 * 筛选控件与 tab 在同一行，用竖线隔开；窄屏时换到下一行右对齐。
 * 选中集合由 `useOverviewScope` 统一管理，四个 tab 共用，切 tab 不重置。
 */
export default function OverviewInsight({
  stats,
  scope,
}: {
  stats: OverviewStats;
  scope: OverviewScopeState;
}) {
  useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = resolveOverviewView(searchParams.get("view"));

  function handleViewChange(value: string) {
    // 函数式更新：与筛选同时发生时不会互相覆盖查询参数。
    setSearchParams(
      (previous) =>
        applyOverviewView(previous, resolveOverviewView(value)),
      { replace: true },
    );
  }

  return (
    <div className="min-w-0" data-overview-insight>
      <Tabs value={view} onValueChange={handleViewChange} className="min-w-0 gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TabsList
            aria-label={t("overview.views.aria")}
            data-overview-view-tabs
            className="grid w-full grid-cols-2 gap-1 self-start p-1 max-sm:h-auto sm:inline-flex sm:w-auto sm:gap-0 sm:p-[3px]"
          >
            {VIEW_META.map((option) => (
              <TabsTrigger key={option.value} value={option.value}>
                {t(option.labelKey)}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="flex w-full items-center justify-end gap-2 md:w-auto md:justify-start">
            <span
              aria-hidden="true"
              className="hidden h-5 shrink-0 border-l border-border md:block"
            />
            <ServerFilter
              servers={scope.servers}
              selectedIds={scope.selectedIds}
              onChange={scope.setSelectedIds}
            />
          </div>
        </div>

        <TabsContent value="server" className="min-w-0">
          <Suspense fallback={<InsightFallback />}>
            <ServerHealthView
              selectedIds={scope.selectedIds}
              filtered={scope.filtered}
            />
          </Suspense>
        </TabsContent>
        <TabsContent value="traffic" className="min-w-0">
          <Suspense fallback={<InsightFallback />}>
            <TrafficView
              stats={stats}
              selectedIds={scope.selectedIds}
              filtered={scope.filtered}
            />
          </Suspense>
        </TabsContent>
        <TabsContent value="cost" className="min-w-0">
          <Suspense fallback={<InsightFallback />}>
            <CostView selectedIds={scope.selectedIds} />
          </Suspense>
        </TabsContent>
        <TabsContent value="chain" className="min-w-0">
          <Suspense fallback={<InsightFallback />}>
            <ChainLatencyView
              selectedIds={scope.selectedIds}
              filtered={scope.filtered}
            />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
