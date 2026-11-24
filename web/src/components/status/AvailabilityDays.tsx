import { AVAILABILITY_BAR_CLASS } from "@/components/status/Availability";
import { useI18n } from "@/i18n";
import type { PublicStatusDayBucket } from "@/lib/api";
import {
  availabilityPercentText,
  availabilityTone,
  weekAvailability,
} from "@/lib/publicStatus";
import { cn } from "@/lib/utils";

/**
 * ② 底部的 7 格日条：`近 7 天` + 7 个等宽色块。
 *
 * 每格一个业务日，颜色沿用 24h 曲线的三档色阶；`null` 日画斜线而不是
 * 0%（「没有采样」不能读成「全天中断」）。字段缺失时整条隐藏，不占高度。
 * 视觉块对读屏隐藏，完整日期 / 比例放在后面那条 `sr-only` 列表里。
 */

export function AvailabilityDays({
  buckets,
  className,
}: {
  buckets: readonly (PublicStatusDayBucket | null | undefined)[] | null | undefined;
  className?: string;
}) {
  const { t } = useI18n();
  const days = weekAvailability(buckets);
  if (days === null) return null;

  return (
    <div
      data-slot="detail-days"
      className={cn("flex min-w-0 items-center gap-2", className)}
    >
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {t("publicStatus.detail.last7Days")}
      </span>
      <div
        role="group"
        aria-label={t("publicStatus.detail.dayAvailabilityAria")}
        className="flex h-1.5 min-w-0 flex-1 gap-0.5"
      >
        {days.map((day, index) => {
          const percent = availabilityPercentText(day.ratio);
          return (
            <span
              key={`${day.day ?? "empty"}-${index}`}
              aria-hidden="true"
              title={
                day.day === null
                  ? t("publicStatus.detail.noSample")
                  : percent === null
                    ? t("publicStatus.detail.noSample")
                    : t("publicStatus.detail.dayTitle", {
                        day: day.day,
                        percent,
                      })
              }
              className={cn(
                "h-full min-w-0 flex-1 rounded-[2px]",
                day.ratio === null
                  ? ""
                  : AVAILABILITY_BAR_CLASS[availabilityTone(day.ratio)],
              )}
              style={
                day.ratio === null
                  ? {
                      backgroundImage:
                        "repeating-linear-gradient(45deg, color-mix(in oklab, var(--muted-foreground) 32%, transparent) 0 1px, transparent 1px 5px)",
                    }
                  : undefined
              }
            />
          );
        })}
      </div>
      <ul className="sr-only">
        {days.map((day, index) => {
          const percent = availabilityPercentText(day.ratio);
          return (
            <li key={`sr-day-${day.day ?? "empty"}-${index}`}>
              {day.day === null
                ? t("publicStatus.detail.noSample")
                : `${day.day} · ${
                    percent === null
                      ? t("publicStatus.detail.noSample")
                      : `${percent}%`
                  }`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
