import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText } from "@/lib/errors";
import { useChainLatency } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

/** recharts 只在展开趋势时按需加载，不拖大转发链页面。 */
const LatencyChart = lazy(() => import("@/components/chains/LatencyChart"));

const WINDOWS = [
  { hours: 6, labelKey: "chains.detail.latencyWindow6h" },
  { hours: 24, labelKey: "chains.detail.latencyWindow24h" },
  { hours: 168, labelKey: "chains.detail.latencyWindow7d" },
] as const;

/**
 * 拓扑弹窗底部的延迟趋势折叠区。
 *
 * 默认收起，收起时不发请求；展开后按当前时间窗取 `/latency`，切换窗口
 * 会换 query key 重新请求。组件以 `key={chain.id}` 挂载，换链自动回到收起态。
 */
export function ChainLatencyTrend({ chainId }: { chainId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState<number>(24);
  const titleId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const panelId = `chain-latency-panel-${titleId}`;
  const panelRef = useRef<HTMLDivElement>(null);
  const query = useChainLatency(chainId, hours, open);

  // 展开后在弹窗自己的滚动容器内把图表露出来：移动端标题通常贴在可视区底部。
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <section
      aria-labelledby={`chain-latency-title-${titleId}`}
      className="rounded-lg border border-border bg-card/40"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          id={`chain-latency-title-${titleId}`}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-xs font-medium focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              open && "rotate-180",
            )}
          />
          <span className="truncate">{t("chains.detail.latencyTrend")}</span>
        </button>

        <div
          role="group"
          aria-label={t("chains.detail.latencyWindowAria")}
          className="inline-flex h-7 shrink-0 items-center gap-0.5 rounded-md border border-border bg-background/60 p-0.5"
        >
          {WINDOWS.map((item) => {
            const active = item.hours === hours;
            return (
              <button
                key={item.hours}
                type="button"
                aria-pressed={active}
                onClick={() => setHours(item.hours)}
                className={cn(
                  "inline-flex h-6 items-center rounded-sm px-2 type-micro whitespace-nowrap transition-colors duration-150",
                  "focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                  active
                    ? "bg-accent font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          className="border-t border-border/60 p-3"
        >
          {query.isPending ? (
            <Skeleton className="h-44 w-full rounded-lg" />
          ) : query.isError ? (
            <p className="py-8 text-center text-xs text-destructive">
              {errorText(query.error, t("chains.detail.latencyError"))}
            </p>
          ) : (
            <Suspense fallback={<Skeleton className="h-44 w-full rounded-lg" />}>
              <LatencyChart points={query.data ?? []} hours={hours} />
            </Suspense>
          )}
        </div>
      ) : null}
    </section>
  );
}
