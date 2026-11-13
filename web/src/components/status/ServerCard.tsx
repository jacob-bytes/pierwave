import { GlobeIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Meter } from "@/components/status/Meter";
import { AvailabilityStrip, AvailabilityValue } from "@/components/status/Availability";
import { useI18n } from "@/i18n";
import type { PublicStatusServer } from "@/lib/api";
import {
  countryCodeToFlag,
  countryDisplayName,
  normalizeCountryCode,
} from "@/lib/country";
import { formatBytePair } from "@/lib/format";
import {
  availabilityPercent,
  availabilityTone,
  reportedLatency,
  resourcePercent,
  serverSpecLine,
  serverState,
  statusLabelKey,
  uptimeLabelKey,
  uptimeParts,
  type ServerState,
} from "@/lib/publicStatus";
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
        "tnum h-5 shrink-0 gap-1 overflow-visible rounded-full px-1.5 type-micro font-normal whitespace-nowrap",
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
  const { t, locale } = useI18n();
  const state = serverState(server);

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
  // 国旗三态：合法代码 → emoji；未设置 / 非法 → 地球图标（保持标题行对齐，
  // 也不猜测国家）。国家名用 Intl.DisplayNames 本地化，失败回落代码。
  const normalizedCountry = normalizeCountryCode(server.country_code);
  const flag = countryCodeToFlag(server.country_code);
  const countryTitle = normalizedCountry
    ? t("publicStatus.server.countryTitle", {
        name:
          countryDisplayName(normalizedCountry, locale) ?? normalizedCountry,
        code: normalizedCountry,
      })
    : t("publicStatus.server.countryUnset");
  // 发行版 · 虚拟化 · 架构；缺哪项跳哪项，全缺返回 null（整行不渲染）。
  const spec = serverSpecLine(server);

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
        <h3 className="truncate text-sm leading-tight font-medium" title={server.name}>
          {server.name}
        </h3>
        {/* 国旗永远占位：合法代码显示 emoji，否则显示中性地球。
            旗帜是装饰性的，国家名与代码在 title / aria-label 里。 */}
        <span
          role="img"
          aria-label={countryTitle}
          title={countryTitle}
          className="shrink-0"
        >
          {flag ? (
            <span
              aria-hidden="true"
              className="text-sm leading-none select-none"
            >
              {flag}
            </span>
          ) : (
            <GlobeIcon
              aria-hidden="true"
              className="icon-sm text-muted-foreground"
            />
          )}
        </span>
        <StatusChip state={state} uptime={uptimeDuration} className="ml-auto" />
      </div>

      {/* 一行元信息：发行版 · 虚拟化 · 架构 · Xray 状态 · 延迟。
          缺哪项就跳过（全缺整行不渲染），不出现空的 “· ·”。
          最后心跳不再展示：卡片右上角已有「在线 12 天」，重复且噪音。 */}
      {spec || xray || latency !== null ? (
        <p
          className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground"
          title={[spec, xray].filter(Boolean).join(" · ") || undefined}
        >
          {spec ? <span className="truncate">{spec}</span> : null}
          {xray ? (
            <>
              {spec ? <span aria-hidden="true">·</span> : null}
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
      ) : null}

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

      {/* 底部：左边是点阵本身的说明（近 24 小时、每格 1 小时），右边才是 7 天可用率。
          原来的写法把两个不同窗口的指标并排，看起来像同一件事。 */}
      <div className="mt-auto pt-4">
        <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
          <span
            className="min-w-0 truncate text-muted-foreground"
            title={t("publicStatus.availability.legend")}
          >
            {t("publicStatus.server.availability24hHint")}
          </span>
          <span className="inline-flex shrink-0 items-baseline gap-1.5 text-muted-foreground">
            <span>{t("publicStatus.server.availability7d")}</span>
            <AvailabilityValue ratio={server.uptime_7d} />
          </span>
        </div>
        <AvailabilityStrip server={server} className="mt-3" />
      </div>
    </Card>
  );
}
