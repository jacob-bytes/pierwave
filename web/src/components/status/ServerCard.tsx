import { ClockIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Meter } from "@/components/status/Meter";
import { AvailabilityStrip, AvailabilityValue } from "@/components/status/Availability";
import { useI18n } from "@/i18n";
import type { PublicStatusServer } from "@/lib/api";
import { formatBytePair } from "@/lib/format";
import {
  resourcePercent,
  serverState,
  statusLabelKey,
  type ServerState,
} from "@/lib/publicStatus";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * 三种状态各自的圆点与 chip 表面。状态不只靠颜色：在线是实心带光晕，
 * 离线是空心灰环，异常是实心红色 —— 即使分不清红绿，形状也不同。
 */
const STATE_META: Record<ServerState, { dot: string; chip: string }> = {
  online: {
    dot: "bg-primary ring-2 ring-primary/25",
    chip: "border-border bg-card text-foreground",
  },
  offline: {
    dot: "border-2 border-muted-foreground/70 bg-transparent",
    chip: "border-border bg-card text-muted-foreground",
  },
  abnormal: {
    dot: "bg-destructive ring-2 ring-destructive/25",
    chip: "border-border bg-card text-foreground",
  },
};

/** 状态点单独给列表视图用；卡片里再和文字焊成一个 chip。 */
export function StatusDot({
  state,
  className,
}: {
  state: ServerState;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        STATE_META[state].dot,
        className,
      )}
    />
  );
}

export function StatusChip({
  state,
  className,
}: {
  state: ServerState;
  className?: string;
}) {
  const { t } = useI18n();
  const meta = STATE_META[state];

  return (
    <Badge
      variant="outline"
      title={
        state === "abnormal"
          ? t("publicStatus.server.abnormalTitle")
          : undefined
      }
      className={cn(
        "tnum shrink-0 gap-1.5 overflow-visible font-normal",
        meta.chip,
        className,
      )}
    >
      <StatusDot state={state} />
      {t(statusLabelKey(state))}
    </Badge>
  );
}

export function ServerCard({ server }: { server: PublicStatusServer }) {
  const { t } = useI18n();
  const state = serverState(server);
  const hasHeartbeat = server.last_seen !== null;
  const heartbeat = hasHeartbeat
    ? t("publicStatus.server.lastHeartbeat", {
        time: formatRelativeTime(server.last_seen),
      })
    : t("publicStatus.server.neverSeen");
  const heartbeatTitle = hasHeartbeat
    ? t("publicStatus.server.lastHeartbeat", {
        time: formatAbsoluteTime(server.last_seen),
      })
    : t("publicStatus.server.neverSeen");

  const load =
    server.load1 !== null && Number.isFinite(server.load1)
      ? server.load1
      : null;
  const memPercent = resourcePercent(server.mem_used, server.mem_total);
  const diskPercent = resourcePercent(server.disk_used, server.disk_total);
  const memPair = formatBytePair(server.mem_used, server.mem_total);
  const diskPair = formatBytePair(server.disk_used, server.disk_total);

  return (
    <Card
      className={cn(
        "h-[282px] min-w-0 gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)]",
        state !== "online" && "bg-muted/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <h3 className="truncate font-semibold" title={server.name}>
          {server.name}
        </h3>
        <StatusChip state={state} className="ml-auto" />
      </div>

      <p
        className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
        title={heartbeatTitle}
      >
        <ClockIcon className="size-3 shrink-0" aria-hidden="true" />
        <span className="truncate">{heartbeat}</span>
      </p>

      {/* 负载没有可归一化的分母（API 不公开核数），所以这里给原始值，
          不画一条没有依据的百分比进度条。内存与硬盘有真实总量，才画条。 */}
      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t("publicStatus.server.load")}
          </span>
          <span
            className={cn(
              "tnum text-sm font-medium",
              load === null && "text-muted-foreground",
            )}
          >
            {load === null ? "—" : load.toFixed(2)}
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {load === null
            ? t("publicStatus.server.notReported")
            : t("publicStatus.server.loadHint")}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4">
        <Meter
          label={t("publicStatus.server.memory")}
          percent={memPercent}
          foot={memPair ?? t("publicStatus.server.notReported")}
          footTitle={memPair ?? undefined}
          emptyLabel={t("publicStatus.server.notReported")}
        />
        <Meter
          label={t("publicStatus.server.disk")}
          percent={diskPercent}
          foot={diskPair ?? t("publicStatus.server.notReported")}
          footTitle={diskPair ?? undefined}
          emptyLabel={t("publicStatus.server.notReported")}
        />
      </div>

      <div className="mt-auto border-t border-border pt-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t("publicStatus.server.availability24h")}
          </span>
          <AvailabilityValue ratio={server.uptime_24h} />
        </div>
        <AvailabilityStrip server={server} />
        <div className="mt-2 flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t("publicStatus.server.availability7d")}
          </span>
          <AvailabilityValue ratio={server.uptime_7d} />
        </div>
      </div>
    </Card>
  );
}
