import { SkeletonLine } from "@/components/common";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PAGE_CONTAINER } from "@/components/status/StatusSkeleton";
import { cn } from "@/lib/utils";

/**
 * `/status/:id` 的加载骨架：与详情页同形（服务器头部、三个数字、24 格条、
 * 资源、系统信息），不是后台页面的通栏大骨架。数据到位后不会整块跳变。
 */
export function StatusDetailSkeleton({ label }: { label: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className="mx-auto w-full max-w-4xl"
    >
      <div className="space-y-4">
        <Card
          aria-hidden="true"
          className="gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <SkeletonLine className="h-5 w-48 max-w-full" />
              <SkeletonLine className="mt-2 h-3 w-24" />
            </div>
            <Skeleton className="h-10 w-24 rounded-md" />
          </div>
        </Card>

        <Card
          aria-hidden="true"
          className="gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index}>
                <SkeletonLine className="h-3 w-16" />
                <SkeletonLine className="mt-2 h-7 w-24 max-w-full" />
              </div>
            ))}
          </div>
        </Card>

        <Card
          aria-hidden="true"
          className="gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
        >
          <SkeletonLine className="h-3 w-28" />
          <div className="mt-4 flex h-14 items-end gap-1">
            {Array.from({ length: 24 }, (_, index) => (
              <Skeleton key={index} className="h-full min-w-0 flex-1 rounded-[2px]" />
            ))}
          </div>
          <SkeletonLine className="mt-3 h-3 w-44" />
        </Card>

        <Card
          aria-hidden="true"
          className="gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
        >
          <SkeletonLine className="h-3 w-16" />
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index}>
                <div className="flex items-baseline justify-between gap-2">
                  <SkeletonLine className="h-3 w-12" />
                  <SkeletonLine className="h-3 w-8" />
                </div>
                <Skeleton className="mt-2 h-1 w-full rounded-full" />
                <SkeletonLine className="mt-1.5 h-3 w-20" />
              </div>
            ))}
          </div>
        </Card>

        <Card
          aria-hidden="true"
          className="gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5"
        >
          <SkeletonLine className="h-3 w-20" />
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <SkeletonLine key={index} className="h-4 w-28 max-w-full" />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/** 路由 chunk 还没下载时的整页骨架：页头 + 详情内容。 */
export function StatusDetailRouteSkeleton({ label }: { label: string }) {
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
        <StatusDetailSkeleton label={label} />
      </main>
    </div>
  );
}
