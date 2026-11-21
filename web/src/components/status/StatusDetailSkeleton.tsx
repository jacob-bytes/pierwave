import { SkeletonLine } from "@/components/common";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PAGE_CONTAINER } from "@/components/status/StatusSkeleton";
import { cn } from "@/lib/utils";

/** `/status/:id` 四张卡（①趋势 ②明细 ③运行环境 ④费用/流量）的骨架。 */

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
          <div className="mt-4 grid grid-cols-3 gap-3 border-t border-border pt-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index}>
                <SkeletonLine className="h-3 w-12" />
                <SkeletonLine className="mt-2 h-6 w-16 max-w-full" />
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-col border-t border-border pt-3">
            <div className="flex justify-between">
              <SkeletonLine className="h-3 w-28" />
              <SkeletonLine className="h-3 w-14" />
            </div>
            <Skeleton className="mt-2.5 h-[112px] rounded-md" />
            <SkeletonLine className="mt-2.5 h-3 w-40" />
          </div>
        </SkeletonCard>

        <SkeletonCard className="order-2 flex flex-col lg:col-start-2 lg:row-start-1">
          <div className="flex justify-between">
            <SkeletonLine className="h-3 w-24" />
            <SkeletonLine className="h-3 w-16" />
          </div>
          <div className="mt-3 grid flex-1 auto-rows-fr grid-cols-2 gap-x-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={index}
                className="flex flex-col justify-center gap-2 border-b border-border py-3 even:pl-3 odd:border-r odd:border-border"
              >
                <SkeletonLine className="h-3 w-12" />
                <SkeletonLine className="h-5 w-24 max-w-full" />
              </div>
            ))}
          </div>
        </SkeletonCard>

        <SkeletonCard className="order-3 flex flex-col lg:col-start-1 lg:row-start-2">
          <div className="flex justify-between">
            <SkeletonLine className="h-3 w-20" />
            <SkeletonLine className="h-3 w-24" />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-[56fr_44fr]">
            <Skeleton className="mx-auto size-[70px] rounded-full sm:size-[82px]" />
            <Skeleton className="mx-auto size-[70px] rounded-full sm:size-[82px]" />
          </div>
          <div className="mt-3 space-y-2 border-t border-border pt-3">
            {Array.from({ length: 3 }, (_, index) => (
              <SkeletonLine key={index} className="h-3 w-full max-w-44" />
            ))}
          </div>
          <SkeletonLine className="mt-auto h-3 w-28 border-t border-border pt-3" />
        </SkeletonCard>

        <SkeletonCard className="order-4 flex flex-col lg:col-start-2 lg:row-start-2">
          <SkeletonLine className="h-3 w-24" />
          <div className="mt-3 grid flex-1 gap-4 sm:grid-cols-[58fr_42fr]">
            <Skeleton className="min-h-20 rounded-lg" />
            <div className="flex flex-col justify-center gap-3">
              <SkeletonLine className="h-4 w-32" />
              <Skeleton className="h-2 w-full rounded-full" />
              <SkeletonLine className="h-3 w-40" />
            </div>
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
