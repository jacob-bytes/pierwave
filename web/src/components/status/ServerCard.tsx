import { ClockIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Meter } from "@/components/status/Meter";
import { AvailabilityStrip, AvailabilityValue } from "@/components/status/Availability";
import { useI18n } from "@/i18n";
import type { PublicStatusServer } from "@/lib/api";
import { formatBytePair } from "@/lib/format";
import {
  availabilityPercent,
  availabilityTone,
  reportedLatency,
  resourcePercent,
  serverState,
  statusLabelKey,
  uptimeLabelKey,
  uptimeParts,
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
        // 只有在线（活着）的状态点呼吸；离线空心环与异常红点保持静止。
        state === "online" && "status-breathe",
        className,
      )}
    />
  );
}

/**
 * 标题行右侧的状态 pill：小圆点 + 状态 + 已在线时长，和参考项目一样焊在
 * 一个 chip 里。离线时不给时长 —— `uptime_secs` 是掉线前最后一次心跳的值，
 * 写在「离线」旁边会被读成「已经离线了这么久」。
 */
export function StatusChip({
  state,
  uptime,
  className,
}: {
  state: ServerState;
  /** 已经格式化好的「141 天 1 小时」；没有数据时为 null。 */
  uptime?: string | null;
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
        "tnum h-5 shrink-0 gap-1 overflow-visible rounded-full px-1.5 text-[11px] font-normal whitespace-nowrap",
        meta.chip,
        className,
      )}
    >
      <StatusDot state={state} />
      {t(statusLabelKey(state))}
      {uptime ? <span className="text-muted-foreground">{uptime}</span> : null}
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

  // 在线（含异常）才有可展示的运行时长；离线时 pill 只留状态。
  const uptimeDuration = (() => {
    if (state === "offline") return null;
    const parts = uptimeParts(server.uptime_secs);
    return parts ? t(uptimeLabelKey(parts), parts) : null;
  })();

  // 离线时 Xray 字段是掉线前的残留，不写进副行。
  const xray =
    state !== "offline" && server.xray_running !== null
      ? t(
          server.xray_running
            ? "publicStatus.server.xrayRunning"
            : "publicStatus.server.xrayStopped",
        )
      : null;

  // 延迟同理：null / 探测失败整项不显示，绝不用 0 ms 占位；
  // 离线时保留的是掉线前最后一次心跳的旧值，也不当作实时质量展示。
  const latency =
    state === "offline" ? null : reportedLatency(server.latency_ms);

  const load =
    server.load1 !== null && Number.isFinite(server.load1)
      ? server.load1
      : null;
  const memPercent = resourcePercent(server.mem_used, server.mem_total);
  const diskPercent = resourcePercent(server.disk_used, server.disk_total);
  const memPair = formatBytePair(server.mem_used, server.mem_total);
  const diskPair = formatBytePair(server.disk_used, server.disk_total);
  const uptime24h = availabilityPercent(server.uptime_24h);

  return (
    <Card
      className={cn(
        "h-full min-w-0 gap-0 rounded-xl p-4 [--card-spacing:--spacing(4)]",
        state !== "online" && "bg-muted/40",
      )}
    >
      {/* 标题行：名称在左，状态 pill 在右。名称让位、pill 不换行，
          长主机名在省略号处截断，而不是把状态挤出卡片。 */}
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="truncate text-sm font-semibold" title={server.name}>
          {server.name}
        </h3>
        <StatusChip state={state} uptime={uptimeDuration} className="ml-auto" />
      </div>

      {/* 副行：一行灰色小字，对应参考项目的发行版 / 虚拟化 / 架构。
          我们只有最后心跳、Xray 状态与探测延迟，缺哪项就不写（延迟为 null
          时整项隐藏，不用 0 占位）。 */}
      <p
        className="mt-1 flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
        title={heartbeatTitle}
      >
        <ClockIcon className="icon-sm shrink-0" aria-hidden="true" />
        <span className="truncate">{heartbeat}</span>
        {xray ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{xray}</span>
          </>
        ) : null}
        {latency !== null ? (
          <>
            <span aria-hidden="true">·</span>
            <span
              className="tnum shrink-0"
              title={t("publicStatus.server.latencyHint")}
            >
              {t("publicStatus.server.latency", { ms: latency })}
            </span>
          </>
        ) : null}
      </p>

      {/* 2×2 指标。内存与硬盘有真实总量，画百分比条；24h 可用率用图例的
          色阶；负载没有可归一化的分母（API 不公开核数），只给原始值。 */}
      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
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
        <Meter
          label={t("publicStatus.server.availability24h")}
          percent={uptime24h}
          tone={availabilityTone(server.uptime_24h)}
          foot={t("publicStatus.server.availability24hHint")}
          footTitle={
            uptime24h === null
              ? t("publicStatus.server.noSample")
              : undefined
          }
          emptyLabel={t("publicStatus.server.noSample")}
        />
        <Meter
          label={t("publicStatus.server.load")}
          value={load === null ? "—" : load.toFixed(2)}
          muted={load === null}
          foot={
            load === null
              ? t("publicStatus.server.notReported")
              : t("publicStatus.server.loadHint")
          }
          emptyLabel={t("publicStatus.server.notReported")}
        />
      </div>

      {/* 底部：左边 7 天可用率，右边最后心跳（相对时间，hover 看绝对时间）；
          下面贴着卡片底边的 24 格条，细、无边框，颜色与图例一致。 */}
      <div className="mt-auto pt-4">
        <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
          <span className="inline-flex min-w-0 items-baseline gap-1.5 text-muted-foreground">
            <span className="truncate">
              {t("publicStatus.server.availability7d")}
            </span>
            <AvailabilityValue ratio={server.uptime_7d} />
          </span>
          {/* 最后心跳已经在副行出现过，这里不再重复；右侧留给可用率区间说明 */}
          <span className="shrink-0 text-muted-foreground">
            {t("publicStatus.server.availability24hHint")}
          </span>
        </div>
        <AvailabilityStrip server={server} className="mt-3" />
      </div>
    </Card>
  );
}
