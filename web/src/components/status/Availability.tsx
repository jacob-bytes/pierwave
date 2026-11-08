import type { PublicStatusServer } from "@/lib/api";
import {
  availabilityPercent,
  availabilityTone,
  hasSamples,
  type AvailabilityTone,
} from "@/lib/publicStatus";
import { useI18n } from "@/i18n";
import { formatAbsoluteTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/** 四种色阶共用一份 token 映射，图例、卡片和表格不会各写一套。 */
export const AVAILABILITY_BAR_CLASS: Record<AvailabilityTone, string> = {
  ok: "bg-primary",
  warn: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground/20",
};

export const AVAILABILITY_TEXT_CLASS: Record<AvailabilityTone, string> = {
  ok: "text-foreground",
  warn: "text-warning",
  down: "text-destructive",
  unknown: "text-muted-foreground",
};

/** 可用率的百分比；没有采样时只画一个破折号，不把「没有数据」写成 0%。 */
export function AvailabilityValue({ ratio }: { ratio: number | null }) {
  const { t } = useI18n();
  const percent = availabilityPercent(ratio);
  if (percent === null) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title={t("publicStatus.server.noSample")}
      >
        —
      </span>
    );
  }
  return (
    <span
      className={cn(
        "tnum text-xs font-medium",
        AVAILABILITY_TEXT_CLASS[availabilityTone(ratio)],
      )}
    >
      {percent}%
    </span>
  );
}

/**
 * 24 个小时桶的迷你条，放在卡片最底部：细、无边框，颜色与图例一一对应。
 *
 * 没有采样的桶画成图例里的「无数据」灰格，而不是另起一个带虚线边框的空态 ——
 * 网格本身就是数据，缺的那几小时理应显示为空格。24 个桶全空时整条都是灰的，
 * 与图例里的「无数据」读法一致。
 */
export function AvailabilityStrip({
  server,
  className,
}: {
  server: PublicStatusServer;
  className?: string;
}) {
  const { t } = useI18n();
  const samples = hasSamples(server.buckets_24h);

  return (
    <div
      role="group"
      aria-label={
        samples
          ? t("publicStatus.server.availabilityAria", { name: server.name })
          : t("publicStatus.availability.noSamples")
      }
      className={cn(
        "grid grid-cols-[repeat(24,minmax(0,1fr))] gap-0.5",
        className,
      )}
    >
      {server.buckets_24h.map((bucket, index) => {
        const ratio = bucket?.online_ratio ?? null;
        const percent = availabilityPercent(ratio);
        return (
          <span
            // 固定 24 格，用下标做 key 是稳定的；桶本身可能为 null。
            key={index}
            aria-hidden="true"
            title={
              bucket && percent !== null
                ? t("publicStatus.server.bucketTitle", {
                    time: formatAbsoluteTime(bucket.ts),
                    percent,
                  })
                : t("publicStatus.availability.unknown")
            }
            className={cn(
              "h-1.5 rounded-[2px]",
              AVAILABILITY_BAR_CLASS[availabilityTone(ratio)],
            )}
          />
        );
      })}
    </div>
  );
}

/** 页面顶部的一份图例；所有卡片共用，不重复占用每张卡的高度。 */
export function AvailabilityLegend({ className }: { className?: string }) {
  const { t } = useI18n();
  const tones: AvailabilityTone[] = ["ok", "warn", "down", "unknown"];

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
    >
      {tones.map((tone) => (
        <span key={tone} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 rounded-[2px]",
              AVAILABILITY_BAR_CLASS[tone],
            )}
          />
          {t(`publicStatus.availability.${tone}`)}
        </span>
      ))}
      <span>{t("publicStatus.availability.legend")}</span>
    </div>
  );
}
