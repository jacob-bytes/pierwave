import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChainKpiSkeletonGrid } from "@/components/overview/ChainKpi";
import { ChainSectionTabs } from "@/components/overview/ChainSectionTabs";
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

/** 与 index.css 的吸顶断点保持一致（Tailwind `md` = 48rem）。 */
const DESKTOP_QUERY = "(min-width: 48rem)";

/**
 * 切换主视图时把内容区滚回顶部。
 *
 * 整个后台只有 `#main-content` 一个滚动容器（见 AppShell），文档本身不可
 * 滚动；改 `documentElement.scrollTop` 不会有任何效果。
 */
function scrollContentToTop() {
  const scroller = document.getElementById("main-content");
  if (scroller !== null) scroller.scrollTop = 0;
}

/** tab 内部的 loading 骨架：只占当前 tab 的内容区，不重复 KPI。 */
function InsightFallback() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <ChainKpiSkeletonGrid />
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
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarFrame = useRef(0);
  const [toolbarStuck, setToolbarStuck] = useState(false);

  /*
   * `sticky` 本身由 index.css 在 md+ 提供；这里只量「是否已经贴住内容区
   * 顶部」，用来开关分隔线与极淡背景。窄屏不吸顶，也就不该出现这两样，
   * 所以 matchMedia 必须参与判断，而不是只看偏移。
   */
  useEffect(() => {
    const toolbar = toolbarRef.current;
    const scroller = document.getElementById("main-content");
    if (toolbar === null || scroller === null) return;

    const desktop = window.matchMedia(DESKTOP_QUERY);
    const measure = () => {
      toolbarFrame.current = 0;
      // sticky 生效时 toolbar 的 top 正好等于滚动容器顶部。
      const offset =
        toolbar.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top;
      setToolbarStuck(desktop.matches && offset <= 0.5);
    };
    const schedule = () => {
      if (toolbarFrame.current !== 0) return;
      toolbarFrame.current = window.requestAnimationFrame(measure);
    };

    measure();
    // 滚动是主路径；resize / 断点变化会让 sticky 失效或生效，也要重算。
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    desktop.addEventListener("change", schedule);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      desktop.removeEventListener("change", schedule);
      if (toolbarFrame.current !== 0) {
        window.cancelAnimationFrame(toolbarFrame.current);
        toolbarFrame.current = 0;
      }
    };
  }, []);

  function handleViewChange(value: string) {
    // 切视图从内容顶部重新开始看；滚动的是内容容器，不是文档。
    if (resolveOverviewView(value) !== view) scrollContentToTop();
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
        <div
          ref={toolbarRef}
          data-overview-view-toolbar
          data-stuck={toolbarStuck ? "true" : "false"}
          className="flex min-w-0 flex-wrap items-center gap-2"
        >
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

          <div className="flex w-full flex-wrap items-center justify-end gap-2 md:w-auto md:justify-start">
            <span
              aria-hidden="true"
              className="hidden h-5 shrink-0 border-l border-border md:block"
            />
            <ServerFilter
              servers={scope.servers}
              selectedIds={scope.selectedIds}
              onChange={scope.setSelectedIds}
            />
            {/* 子页只属于「链路时延」；其它 tab 连竖线一起不渲染。 */}
            {view === "chain" ? (
              <div className="flex shrink-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-5 shrink-0 border-l border-border"
                />
                <ChainSectionTabs />
              </div>
            ) : null}
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
