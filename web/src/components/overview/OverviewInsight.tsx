import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
 * URL 是视图的唯一来源（`?view=server|traffic|cost|chain`，默认不写参数）；
 * 切换用 `replace`。每个 tab 只渲染自己的卡片，不用 `hidden` 同时挂载四套
 * 内容，因此也不会同时请求四个视图的数据。
 */
export default function OverviewInsight({ stats }: { stats: OverviewStats }) {
  useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = resolveOverviewView(searchParams.get("view"));

  function handleViewChange(value: string) {
    const next = applyOverviewView(searchParams, resolveOverviewView(value));
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
  }

  return (
    <div className="min-w-0" data-overview-insight>
      <Tabs value={view} onValueChange={handleViewChange} className="min-w-0 gap-4">
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

        <TabsContent value="server" className="min-w-0">
          <Suspense fallback={<InsightFallback />}>
            <ServerHealthView />
          </Suspense>
        </TabsContent>
        <TabsContent value="traffic" className="min-w-0">
          <Suspense fallback={<InsightFallback />}>
            <TrafficView stats={stats} />
          </Suspense>
        </TabsContent>
        <TabsContent value="cost" className="min-w-0">
          <Suspense fallback={<InsightFallback />}>
            <CostView />
          </Suspense>
        </TabsContent>
        <TabsContent value="chain" className="min-w-0">
          <Suspense fallback={<InsightFallback />}>
            <ChainLatencyView />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
