import { lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  CircleDollarSignIcon,
  ServerIcon,
  WaypointsIcon,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  applyOverviewView,
  resolveOverviewView,
  type OverviewView,
} from "@/lib/overviewViews";
import { t, useI18n } from "@/i18n";

/** 三个视图都按需加载；首次切到某个 tab 才请求并挂载它。 */
const ServerHealthView = lazy(
  () => import("@/components/overview/ServerHealthView"),
);
const CostView = lazy(() => import("@/components/overview/CostView"));
const ChainLatencyView = lazy(
  () => import("@/components/overview/ChainLatencyView"),
);

const VIEW_META: readonly {
  value: OverviewView;
  labelKey: string;
  icon: LucideIcon;
}[] = [
  {
    value: "server",
    labelKey: "overview.views.server",
    icon: ServerIcon,
  },
  {
    value: "cost",
    labelKey: "overview.views.cost",
    icon: CircleDollarSignIcon,
  },
  {
    value: "chain",
    labelKey: "overview.views.chain",
    icon: WaypointsIcon,
  },
];

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
 * KPI 卡片下方的「态势」区：服务器状态 / 成本开销 / 链路时延。
 *
 * URL 是视图的唯一来源（`?view=server|cost|chain`，默认不写参数）；
 * 切换用 `replace`，不整页刷新、也不新增历史记录。原有的趋势 / 分布 /
 * 链路健康 / 告警 / 榜单卡片保持不动，新区域只插在它们上方。
 */
export default function OverviewInsight() {
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
          className="grid w-full grid-cols-3 self-start sm:inline-flex sm:w-auto"
        >
          {VIEW_META.map((option) => {
            const Icon = option.icon;
            return (
              <TabsTrigger key={option.value} value={option.value}>
                <Icon className="size-3.5" aria-hidden="true" />
                {t(option.labelKey)}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value="server" className="min-w-0">
          <Suspense fallback={<InsightFallback />}>
            <ServerHealthView />
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
