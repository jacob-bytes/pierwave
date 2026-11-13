import { LayersIcon } from "lucide-react";
import { AvailabilityValue, AVAILABILITY_BAR_CLASS } from "@/components/status/Availability";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import type { PublicStatusGroup } from "@/lib/api";
import {
  availabilityPercent,
  availabilityTone,
} from "@/lib/publicStatus";
import { groupStatusRows } from "@/lib/serverGroups";
import { cn } from "@/lib/utils";

/**
 * 公开状态页的分组聚合：分组名 + 在线/总数 + 24h 可用率。
 *
 * 旧后端没有 `groups` 或分组全为空时整块不渲染，页面仍按逐台列表工作。
 */
export function GroupOverview({
  groups,
  className,
}: {
  groups?: PublicStatusGroup[] | null;
  className?: string;
}) {
  const { t } = useI18n();
  const rows = groupStatusRows(groups);
  if (rows.length === 0) return null;

  return (
    <section
      className={cn("mt-3", className)}
      aria-label={t("publicStatus.groups.title")}
    >
      <h2 className="mb-2 flex items-center gap-1.5 px-1 text-xs font-medium tracking-wide text-muted-foreground">
        <LayersIcon className="icon-sm" aria-hidden="true" />
        {t("publicStatus.groups.title")}
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {rows.map((row) => {
          const label = row.name ?? t("publicStatus.groups.ungrouped");
          const percent = availabilityPercent(row.uptime_24h);
          const tone = availabilityTone(row.uptime_24h);

          return (
            <Card
              key={row.name ?? "__ungrouped__"}
              className="gap-0 rounded-xl px-3 py-2.5"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="truncate text-sm font-medium"
                  title={row.name ?? undefined}
                >
                  {label}
                </span>
                <span className="tnum shrink-0 text-xs text-muted-foreground">
                  {t("publicStatus.groups.onlineOf", {
                    online: row.online,
                    total: row.servers,
                  })}
                </span>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">
                  {t("publicStatus.groups.uptime24h")}
                </span>
                <AvailabilityValue ratio={row.uptime_24h} />
              </div>
              <div
                aria-hidden="true"
                className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted-foreground/20"
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-[width] duration-200",
                    percent !== null && "min-w-[3px]",
                    AVAILABILITY_BAR_CLASS[tone],
                  )}
                  style={{ width: `${percent ?? 0}%` }}
                />
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
