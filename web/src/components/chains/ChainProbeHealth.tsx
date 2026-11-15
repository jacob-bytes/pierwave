import { lazy, Suspense, useId, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import type { Chain } from "@/lib/api";
import {
  availabilityLabel,
  availabilityTone,
  DEFAULT_AVAILABILITY_THRESHOLD_PERCENT,
  lossLabel,
  probeAttemptsLabel,
} from "@/lib/chainProbe";
import { errorText } from "@/lib/errors";
import { useChainProbe } from "@/lib/queries";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

/** recharts 只在展开趋势时按需加载，不拖大转发链页面。 */
const ProbeChart = lazy(() => import("@/components/chains/ProbeChart"));

/** 可用率颜色：只复用既有语义色，不引入新色相。 */
const TONE_CLASS = {
  default: "text-foreground",
  warning: "text-warning",
  muted: "text-muted-foreground",
} as const;

const WINDOW_HOURS = 24;

/**
 * 拓扑弹窗里的「可用率 / 丢包」摘要 + 趋势。
 *
 * 口径必须写出来：丢包 = **探测失败率近似**（见 `chains.detail.probe.note`），
 * 这是事实边界，不是功能说明。没有样本时显示 `—`，不是 0%。
 */
export function ChainProbeHealth({ chain }: { chain: Chain }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const titleId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const panelId = `chain-probe-panel-${titleId}`;
  const panelRef = useRef<HTMLDivElement>(null);
  const query = useChainProbe(chain.id, WINDOW_HOURS, open);

  const threshold =
    chain.availability_threshold_percent ??
    DEFAULT_AVAILABILITY_THRESHOLD_PERCENT;
  const availability = query.data?.summary.availability ?? chain.availability_24h;
  const loss = query.data?.summary.loss ?? chain.loss_24h;
  const attempts = query.data?.summary.attempts ?? chain.probe_attempts_24h;
  const tone = availabilityTone(availability, threshold);
  // 丢包超过（100 - 阈值）与可用率低于阈值等价；用同一档颜色。
  const lossTone = availabilityTone(
    loss === null || loss === undefined ? null : 1 - loss,
    threshold,
  );

  return (
    <section
      aria-labelledby={`chain-probe-title-${titleId}`}
      className="rounded-lg border border-border bg-card/40"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          id={`chain-probe-title-${titleId}`}
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
          <span className="truncate">{t("chains.detail.probe.trend")}</span>
        </button>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span
            className="inline-flex items-baseline gap-1.5"
            title={t("chains.detail.probe.availabilityTitle")}
          >
            <span className="type-micro text-muted-foreground">
              {t("chains.detail.probe.availability")}
            </span>
            <span
              className={cn(
                "font-mono text-sm tabular-nums",
                TONE_CLASS[tone],
              )}
            >
              {availabilityLabel(availability)}
            </span>
          </span>
          <span
            className="inline-flex items-baseline gap-1.5"
            title={t("chains.detail.probe.lossTitle")}
          >
            <span className="type-micro text-muted-foreground">
              {t("chains.detail.probe.loss")}
            </span>
            <span
              className={cn(
                "font-mono text-sm tabular-nums",
                TONE_CLASS[lossTone],
              )}
            >
              {lossLabel(loss)}
            </span>
          </span>
          {attempts !== undefined && attempts > 0 ? (
            <span
              className="type-micro text-muted-foreground tabular-nums"
              title={t("chains.detail.probe.attempts", {
                count: probeAttemptsLabel(attempts),
              })}
            >
              {t("chains.detail.probe.attempts", {
                count: probeAttemptsLabel(attempts),
              })}
            </span>
          ) : null}
        </div>
      </div>

      {open ? (
        <div
          id={panelId}
          ref={panelRef}
          className="border-t border-border/60 p-3"
        >
          {query.isPending ? (
            <Skeleton className="h-40 w-full rounded-lg" />
          ) : query.isError ? (
            <p className="py-8 text-center text-xs text-destructive">
              {errorText(query.error, t("chains.detail.probe.error"))}
            </p>
          ) : (
            <Suspense fallback={<Skeleton className="h-40 w-full rounded-lg" />}>
              <ProbeChart
                points={query.data?.points ?? []}
                hours={WINDOW_HOURS}
                thresholdPercent={threshold}
              />
            </Suspense>
          )}
          <p className="mt-2 type-micro text-muted-foreground">
            {t("chains.detail.probe.threshold", {
              threshold: Math.round(threshold * 10) / 10,
              streak: query.data?.policy.streak ?? 3,
            })}
          </p>
        </div>
      ) : null}

      <p className="border-t border-border/60 px-3 py-1.5 type-micro leading-normal text-muted-foreground">
        {t("chains.detail.probe.note")}
      </p>
    </section>
  );
}
