import { SkeletonLine } from "@/components/common";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PAGE_CONTAINER } from "@/components/status/StatusSkeleton";
import { cn } from "@/lib/utils";

/**
 * `/status/:id` 方案 B 的加载骨架：与详情页同形（两栏 420 + 右栏、
 * 曲线、费用/系统、累计流量带），不是后台页面的通栏大骨架。
 */

function SkeletonCard({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      aria-hidden="true"
      className={cn(
        "h-full min-w-0 gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)] sm:p-5",
        className,
      )}
    >
      {children}
    </Card>
  );
}

export function StatusDetailSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="flex flex-1 flex-col">
      <div className="mb-4 h-10 w-28">
        <SkeletonLine className="h-4 w-20" />
      </div>

      <div className="grid flex-1 items-stretch gap-4 lg:grid-cols-[420px_minmax(0,1fr)]">
        <SkeletonCard className="order-1 flex flex-col lg:col-start-1 lg:row-start-1">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <SkeletonLine className="h-5 w-48 max-w-full" />
              <SkeletonLine className="mt-2 h-3 w-24" />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <div className="mt-auto border-t border-border pt-3">
            <SkeletonLine className="h-3 w-40" />
          </div>
        </SkeletonCard>

        <SkeletonCard className="order-2 lg:col-start-1 lg:row-start-2">
          <div className="grid grid-cols-3 gap-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index}>
                <SkeletonLine className="h-3 w-12" />
                <SkeletonLine className="mt-2 h-6 w-16 max-w-full" />
              </div>
            ))}
          </div>
        </SkeletonCard>

        <SkeletonCard className="order-3 flex flex-col lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <div className="flex items-baseline justify-between gap-3">
            <SkeletonLine className="h-3 w-28" />
            <SkeletonLine className="h-3 w-16" />
          </div>
          <div className="mt-3 flex min-h-[150px] flex-1 gap-2">
            <div className="flex w-8 shrink-0 flex-col justify-between">
              {Array.from({ length: 5 }, (_, index) => (
                <SkeletonLine key={index} className="h-2 w-6" />
              ))}
            </div>
            <Skeleton className="min-h-24 flex-1 rounded-md" />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
            <SkeletonLine className="h-3 w-40" />
            <SkeletonLine className="h-3 w-20" />
          </div>
        </SkeletonCard>

        <SkeletonCard className="order-4 flex flex-col lg:col-start-1 lg:row-start-3">
          <div className="flex items-baseline justify-between gap-3">
            <SkeletonLine className="h-3 w-12" />
            <SkeletonLine className="h-3 w-24" />
          </div>
          <div className="grid flex-1 grid-cols-2 content-center gap-3 pt-4">
            <Skeleton className="mx-auto size-24 rounded-full sm:size-28" />
            <Skeleton className="mx-auto size-24 rounded-full sm:size-28" />
          </div>
        </SkeletonCard>

        <div className="order-5 grid items-stretch gap-4 lg:col-start-2 lg:row-start-3 lg:grid-cols-2">
          <SkeletonCard className="flex flex-col">
            <SkeletonLine className="h-3 w-20" />
            <SkeletonLine className="mt-auto h-6 w-28" />
            <SkeletonLine className="mt-2 h-3 w-36" />
          </SkeletonCard>
          <SkeletonCard className="flex flex-col">
            <SkeletonLine className="h-3 w-20" />
            <div className="mt-auto space-y-3">
              {Array.from({ length: 3 }, (_, index) => (
                <SkeletonLine key={index} className="h-3 w-32 max-w-full" />
              ))}
            </div>
          </SkeletonCard>
        </div>

        <SkeletonCard className="order-6 lg:col-span-2">
          <div className="flex flex-wrap items-center gap-4">
            <SkeletonLine className="h-5 w-24" />
            <SkeletonLine className="h-6 w-20" />
            <Skeleton className="h-1.5 min-w-32 flex-1 rounded-full" />
            <SkeletonLine className="h-3 w-32" />
          </div>
        </SkeletonCard>
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
      <main className={cn(PAGE_CONTAINER, "flex flex-1 flex-col py-4")}>
        <StatusDetailSkeleton label={label} />
      </main>
    </div>
  );
}
