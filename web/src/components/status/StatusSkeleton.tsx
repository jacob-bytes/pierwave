import { SkeletonLine } from "@/components/common";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * 公开状态页的骨架。
 *
 * 单独成模块而不是留在 `pages/Status.tsx` 里：懒加载的页面 chunk 还没下载完时，
 * 路由级 Suspense 也要能画出「公开状态页」的形状（页头 + 汇总 + 卡片网格），
 * 而不是后台数据页那套「标题条 + 两张通栏卡片」。如果这里留在懒加载 chunk 内，
 * 加载阶段就只能回落到通用骨架，视觉上会先闪一屏后台页面。
 *
 * 形态与真实页面逐块对应：四块汇总、工具栏、服务器卡片，卡片内部指标
 * 与实时速率格子同构，数据到位后不会整块跳变。
 */

/**
 * 页头与内容共用一条容器：同样的最大宽度和左右内边距，
 * 保证页头左边缘和下方卡片左边缘始终对齐。
 * 骨架也用它，避免加载阶段与完成后的横向位置错开。
 */
export const PAGE_CONTAINER = "mx-auto w-full max-w-[1400px] px-4 sm:px-6";

/** 一个指标的骨架：标签 / 数值一行、4px 进度条、底部原始值。 */
function MeterSkeleton() {
  return (
    <div className="min-w-0" aria-hidden="true">
      <div className="flex items-baseline justify-between gap-2">
        <SkeletonLine className="h-3 w-12" />
        <SkeletonLine className="h-3 w-8" />
      </div>
      <Skeleton className="mt-2 h-1 w-full rounded-full" />
      <SkeletonLine className="mt-1.5 h-3 w-20" />
    </div>
  );
}

/**
 * 与 `ServerCard` 同构的骨架：标题行 + 副行 + 2×2 指标 + 实时速率 + 底部点阵。
 * 结构一致，加载结束换成真数据时不会整块跳动。
 */
function ServerCardSkeleton() {
  return (
    <Card
      aria-hidden="true"
      className="h-full min-w-0 gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <SkeletonLine className="h-4 w-1/2" />
        <Skeleton className="ml-auto h-5 w-20 shrink-0 rounded-full" />
      </div>
      <SkeletonLine className="mt-1.5 h-3 w-3/5" />

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
        {Array.from({ length: 4 }, (_, index) => (
          <MeterSkeleton key={index} />
        ))}
      </div>

      {/* 实时速率的四个格子（两行两列），与真实卡片同一个可换行栅格。 */}
      <div className="mt-4 border-t border-border pt-2.5">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))]">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex items-center gap-2">
              {index % 2 === 0 ? (
                <Skeleton className="size-3 shrink-0" />
              ) : null}
              <SkeletonLine
                className={index % 2 === 0 ? "h-3 w-16" : "h-3 w-12"}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 border-t border-border" />
      <div className="mt-auto pt-3">
        <div className="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-0.5">
          {Array.from({ length: 24 }, (_, index) => (
            <Skeleton key={index} className="h-1.5 rounded-[2px]" />
          ))}
        </div>
        <div className="mt-2 flex items-baseline justify-between gap-2">
          <SkeletonLine className="h-3 w-16" />
          <SkeletonLine className="h-3 w-10" />
        </div>
      </div>
    </Card>
  );
}

/**
 * 首屏内容骨架：四个汇总块 + 工具栏 + 四张服务器卡片。
 *
 * 摘要块只占位高度；服务器卡片按真实卡片的结构铺骨架，
 * 手机上是一列、桌面最多四列，与真实网格一致。
 */
export function StatusSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label}>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card
            key={index}
            aria-hidden="true"
            className="h-[86px] gap-0 rounded-xl p-3 [--card-spacing:--spacing(3)]"
          >
            <SkeletonLine className="h-3 w-16" />
            <SkeletonLine className="mt-2 h-5 w-20" />
            <SkeletonLine className="mt-auto h-3 w-24" />
          </Card>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2 px-1">
        <Skeleton className="h-8 w-64 rounded-md" />
        <div className="flex-1" />
        <Skeleton className="h-8 w-40 rounded-md sm:w-52" />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <ServerCardSkeleton key={index} />
        ))}
      </div>
    </div>
  );
}

/**
 * `/status` 路由 chunk 未就绪时的整页骨架：页头 + 内容。
 *
 * 页头骨架与 `StatusHeader` 同高（logo 40px + `py-3`），内容沿用
 * `StatusSkeleton`。这样从 Suspense 回落到真实页面时，页头不会突然出现、
 * 内容也不会上下移动。纯装饰块 `aria-hidden`，由内容骨架的
 * `role="status"` 朗读 label。
 */
export function StatusRouteSkeleton({ label }: { label: string }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="border-b border-border bg-[color-mix(in_oklab,var(--card)_80%,var(--background))]">
        <div
          aria-hidden="true"
          className={cn(PAGE_CONTAINER, "flex items-center gap-2 py-3 sm:gap-3")}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <Skeleton className="size-10 shrink-0 rounded-xl" />
            <div className="flex min-w-0 flex-col justify-center gap-1.5">
              <SkeletonLine className="h-4 w-28 max-w-full" />
              <SkeletonLine className="h-3 w-36 max-w-full" />
            </div>
          </div>
          <div className="flex-1" />
          <SkeletonLine className="h-3 w-24 max-sm:hidden" />
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="size-8 rounded-md" />
        </div>
      </header>
      <main className={cn(PAGE_CONTAINER, "flex-1 py-4")}>
        <StatusSkeleton label={label} />
      </main>
    </div>
  );
}
