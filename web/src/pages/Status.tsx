import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  CalendarClockIcon,
  ClockIcon,
  NetworkIcon,
  RefreshCwIcon,
  ServerIcon,
  ServerOffIcon,
  ShieldIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDocumentTitle, useI18n } from "@/i18n";
import type {
  PublicStatus,
  PublicStatusServer,
} from "@/lib/api";
import { errorText, isNotFound } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import {
  availabilityPercent,
  availabilityTone,
  hasSamples,
  resourcePercent,
  serverState,
  type AvailabilityTone,
  type ServerState,
} from "@/lib/publicStatus";
import { usePublicStatus } from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";

/**
 * 探针公开页 `/status`。
 *
 * 版式借鉴本机 miniprobe/monitor-theme-default 的 Summary / NodeCard /
 * Availability / Meter：顶部四块汇总、每台服务器一张卡、卡内是
 * 「状态 + 三个资源指标 + 24 格可用率条」。数据严格按
 * `GET /api/v1/public/status` 的白名单裁剪，不展示我们没有的延迟、丢包、
 * 运营商或事件时间线。
 *
 * 本页不套 AppShell：没有侧栏与账号菜单，未登录也能访问。
 */

const AVAILABILITY_TONE_CLASS: Record<AvailabilityTone, string> = {
  ok: "bg-primary",
  warn: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground/20",
};

const AVAILABILITY_TEXT_CLASS: Record<AvailabilityTone, string> = {
  ok: "text-foreground",
  warn: "text-warning",
  down: "text-destructive",
  unknown: "text-muted-foreground",
};

const STATE_META: Record<
  ServerState,
  { labelKey: string; dot: string; chip: string }
> = {
  online: {
    labelKey: "publicStatus.server.online",
    dot: "bg-primary motion-safe:animate-pulse",
    chip: "bg-primary/10 text-primary",
  },
  offline: {
    labelKey: "publicStatus.server.offline",
    dot: "bg-muted-foreground/40",
    chip: "bg-muted text-muted-foreground",
  },
  abnormal: {
    labelKey: "publicStatus.server.abnormal",
    dot: "bg-destructive",
    chip: "bg-destructive/10 text-destructive",
  },
};

function SummaryTile({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <Card className="gap-0 p-3 sm:p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{label}</span>
      </div>
      {children}
    </Card>
  );
}

function Summary({ data }: { data: PublicStatus }) {
  const { t } = useI18n();
  const { summary } = data;
  const offline = Math.max(
    0,
    summary.servers_total - summary.servers_online,
  );

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <SummaryTile icon={ServerIcon} label={t("publicStatus.summary.servers")}>
        <div className="mt-1 text-xl font-semibold tabular-nums">
          {summary.servers_online} / {summary.servers_total}
        </div>
        <div className="mt-auto pt-1 text-xs text-muted-foreground">
          {summary.servers_total === 0 ? (
            <span>{t("publicStatus.summary.noServers")}</span>
          ) : offline > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-destructive">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-destructive"
              />
              {t("publicStatus.summary.offlineCount", { n: offline })}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-primary"
              />
              {t("publicStatus.summary.allOnline")}
            </span>
          )}
        </div>
      </SummaryTile>

      <SummaryTile icon={NetworkIcon} label={t("publicStatus.summary.nodes")}>
        <div className="mt-1 text-xl font-semibold tabular-nums">
          {summary.nodes_total}
        </div>
        <div className="mt-auto pt-1 truncate text-xs text-muted-foreground">
          {t("publicStatus.summary.nodesHint")}
        </div>
      </SummaryTile>

      <SummaryTile
        icon={ArrowDownIcon}
        label={t("publicStatus.summary.todayTraffic")}
      >
        <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
          {formatBytes(summary.traffic_today)}
        </div>
        <div className="mt-auto pt-1 truncate text-xs text-muted-foreground">
          {t("publicStatus.summary.trafficHint")}
        </div>
      </SummaryTile>

      <SummaryTile
        icon={CalendarClockIcon}
        label={t("publicStatus.summary.monthTraffic")}
      >
        <div className="mt-1 font-mono text-xl font-semibold tabular-nums">
          {formatBytes(summary.traffic_month)}
        </div>
        <div className="mt-auto pt-1 truncate text-xs text-muted-foreground">
          {t("publicStatus.summary.trafficHint")}
        </div>
      </SummaryTile>
    </div>
  );
}

function ServerStatusBadge({ server }: { server: PublicStatusServer }) {
  const { t } = useI18n();
  const state = serverState(server);
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
        "shrink-0 gap-1.5 overflow-visible border-transparent font-normal",
        meta.chip,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", meta.dot)}
      />
      {t(meta.labelKey)}
    </Badge>
  );
}

/**
 * Meter 的公开页版本：标签 + 百分比在上，条在中间，原始数字在下。
 * 没有上限（未上报）时条不填充、百分比显示 `—`，避免谎报 0%。
 */
function MetricMeter({
  label,
  percent,
  foot,
  footTitle,
}: {
  label: string;
  percent: number | null;
  foot: string;
  footTitle?: string;
}) {
  const { t } = useI18n();
  const filled = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const severe = filled >= 90;
  const busy = filled >= 75;

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-1.5">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        <span
          className={cn(
            "shrink-0 text-xs font-medium tabular-nums",
            percent === null
              ? "text-muted-foreground"
              : severe
                ? "text-destructive"
                : busy
                  ? "text-warning"
                  : "text-foreground",
          )}
        >
          {percent === null ? "—" : `${Math.round(filled)}%`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent === null
          ? { "aria-valuetext": t("publicStatus.server.notReported") }
          : {
              "aria-valuenow": Math.round(filled),
              "aria-valuetext": `${Math.round(filled)}%`,
            })}
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/20"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200",
            severe ? "bg-destructive" : busy ? "bg-warning" : "bg-primary",
          )}
          style={{
            width: `${filled}%`,
            minWidth: filled > 0 ? 3 : undefined,
          }}
        />
      </div>
      <div
        className="mt-1 truncate text-xs text-muted-foreground"
        title={footTitle}
      >
        {foot}
      </div>
    </div>
  );
}

function AvailabilityValue({ ratio }: { ratio: number | null }) {
  const { t } = useI18n();
  const percent = availabilityPercent(ratio);
  if (percent === null) {
    return (
      <span className="text-xs text-muted-foreground">
        {t("publicStatus.server.noSample")}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "text-xs font-medium tabular-nums",
        AVAILABILITY_TEXT_CLASS[availabilityTone(ratio)],
      )}
    >
      {percent}%
    </span>
  );
}

/**
 * 24 个小时桶的迷你条。没有采样的桶画灰格，`title` 说明「无数据」；
 * 24 个桶全空时整条换成一句空态，而不是一排灰格。
 */
function AvailabilityStrip({ server }: { server: PublicStatusServer }) {
  const { t } = useI18n();

  if (!hasSamples(server.buckets_24h)) {
    return (
      <p className="mt-2 rounded-md border border-dashed border-border px-2 py-1.5 text-center text-xs text-muted-foreground">
        {t("publicStatus.availability.noSamples")}
      </p>
    );
  }

  return (
    <div
      role="group"
      aria-label={t("publicStatus.server.availabilityAria", {
        name: server.name,
      })}
      className="mt-2 grid grid-cols-[repeat(24,minmax(0,1fr))] gap-0.5"
    >
      {server.buckets_24h.map((bucket, index) => {
        const ratio = bucket?.online_ratio ?? null;
        const percent = availabilityPercent(ratio);
        return (
          <span
            key={bucket?.ts ?? index}
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
              "h-4 rounded-[2px]",
              AVAILABILITY_TONE_CLASS[availabilityTone(ratio)],
            )}
          />
        );
      })}
    </div>
  );
}

function AvailabilityLegend() {
  const { t } = useI18n();
  const tones: AvailabilityTone[] = ["ok", "warn", "down", "unknown"];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {tones.map((tone) => (
        <span key={tone} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "size-2 rounded-[2px]",
              AVAILABILITY_TONE_CLASS[tone],
            )}
          />
          {t(`publicStatus.availability.${tone}`)}
        </span>
      ))}
      <span>{t("publicStatus.availability.legend")}</span>
    </div>
  );
}

function ServerCard({ server }: { server: PublicStatusServer }) {
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

  const memPercent = resourcePercent(server.mem_used, server.mem_total);
  const diskPercent = resourcePercent(server.disk_used, server.disk_total);
  const load =
    server.load1 !== null && Number.isFinite(server.load1)
      ? server.load1
      : null;

  return (
    <Card
      className={cn(
        "min-w-0 gap-0 p-4",
        state !== "online" && "bg-muted/30",
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{server.name}</h3>
          <p
            className="mt-1 truncate text-xs text-muted-foreground"
            title={heartbeatTitle}
          >
            {heartbeat}
          </p>
        </div>
        <ServerStatusBadge server={server} />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">
            {t("publicStatus.server.load")}
          </p>
          <p className="mt-1.5 text-xs font-medium tabular-nums">
            {load !== null ? load.toFixed(2) : "—"}
          </p>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {load !== null
              ? t("publicStatus.server.loadHint")
              : t("publicStatus.server.notReported")}
          </p>
        </div>

        <MetricMeter
          label={t("publicStatus.server.memory")}
          percent={memPercent}
          foot={
            memPercent === null
              ? t("publicStatus.server.notReported")
              : `${formatBytes(server.mem_used)} / ${formatBytes(server.mem_total)}`
          }
          footTitle={
            memPercent === null
              ? t("publicStatus.server.notReported")
              : `${formatBytes(server.mem_used)} / ${formatBytes(server.mem_total)}`
          }
        />

        <MetricMeter
          label={t("publicStatus.server.disk")}
          percent={diskPercent}
          foot={
            diskPercent === null
              ? t("publicStatus.server.notReported")
              : `${formatBytes(server.disk_used)} / ${formatBytes(server.disk_total)}`
          }
          footTitle={
            diskPercent === null
              ? t("publicStatus.server.notReported")
              : `${formatBytes(server.disk_used)} / ${formatBytes(server.disk_total)}`
          }
        />
      </div>

      <div className="mt-4 border-t border-border pt-3">
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

function NoticeCard({
  icon: Icon,
  iconClassName,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  iconClassName: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Card className="mt-6">
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <div
          className={cn(
            "grid size-10 place-items-center rounded-full",
            iconClassName,
          )}
        >
          <Icon className="size-5" aria-hidden="true" />
        </div>
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            {description}
          </p>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function StatusSkeleton({ label }: { label: string }) {
  return (
    <div className="mt-6" aria-busy="true" aria-label={label}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="mt-8 flex items-center justify-between">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-3 w-10" />
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-52 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function StatusHeader({
  data,
  isFetching,
  onRefresh,
}: {
  data: PublicStatus | undefined;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const panelName =
    data?.panel_name?.trim() || t("publicStatus.headingFallback");

  return (
    <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15">
            <ActivityIcon className="size-4" aria-hidden="true" />
          </div>
          <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">
            {panelName}
          </h1>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("publicStatus.subtitle")}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {data ? (
            <>
              <span
                className="inline-flex items-center gap-1"
                title={formatAbsoluteTime(data.generated_at)}
              >
                <ClockIcon className="size-3.5" aria-hidden="true" />
                {t("publicStatus.updatedAt", {
                  time: formatRelativeTime(data.generated_at),
                })}
              </span>
              <span aria-hidden="true">·</span>
              <span>{t("publicStatus.autoRefreshHint")}</span>
            </>
          ) : (
            <span>{t("publicStatus.loading")}</span>
          )}
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={onRefresh}
        disabled={isFetching}
      >
        <RefreshCwIcon
          className={cn("size-3.5", isFetching && "animate-spin")}
          aria-hidden="true"
        />
        {isFetching ? t("publicStatus.refreshing") : t("publicStatus.refresh")}
      </Button>
    </header>
  );
}

function StatusContent({ data }: { data: PublicStatus }) {
  const { t } = useI18n();

  if (data.servers.length === 0) {
    return (
      <>
        <Summary data={data} />
        <NoticeCard
          icon={ServerOffIcon}
          iconClassName="bg-muted text-muted-foreground"
          title={t("publicStatus.servers.emptyTitle")}
          description={t("publicStatus.servers.emptyDescription")}
        />
      </>
    );
  }

  return (
    <>
      <Summary data={data} />
      <section className="mt-8" aria-labelledby="public-status-servers">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="public-status-servers"
            className="text-sm font-medium"
          >
            {t("publicStatus.servers.title")}
          </h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("publicStatus.servers.count", {
              n: data.servers.length,
            })}
          </span>
        </div>
        <div className="mt-2">
          <AvailabilityLegend />
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.servers.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </div>
      </section>
    </>
  );
}

export default function StatusPage() {
  const { t } = useI18n();
  const status = usePublicStatus();
  const panelName =
    status.data?.panel_name?.trim() || t("publicStatus.headingFallback");
  useDocumentTitle(`${t("publicStatus.pageTitle")} · ${panelName}`);

  const disabled = status.isError && isNotFound(status.error);

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-8 sm:px-6 lg:px-8">
        <StatusHeader
          data={status.data}
          isFetching={status.isFetching}
          onRefresh={() => void status.refetch()}
        />

        <main className="flex-1">
          {status.isPending ? (
            <StatusSkeleton label={t("publicStatus.loading")} />
          ) : status.isError ? (
            disabled ? (
              <NoticeCard
                icon={ShieldIcon}
                iconClassName="bg-muted text-muted-foreground"
                title={t("publicStatus.disabled.title")}
                description={t("publicStatus.disabled.description")}
              >
                <Button asChild variant="outline" size="sm">
                  <Link to="/login">
                    {t("publicStatus.footer.admin")}
                    <ArrowRightIcon className="size-3.5" aria-hidden="true" />
                  </Link>
                </Button>
              </NoticeCard>
            ) : (
              <NoticeCard
                icon={TriangleAlertIcon}
                iconClassName="bg-destructive/10 text-destructive"
                title={t("publicStatus.error.title")}
                description={errorText(
                  status.error,
                  t("publicStatus.error.description"),
                )}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void status.refetch()}
                  disabled={status.isFetching}
                >
                  <RefreshCwIcon
                    className={cn(
                      "size-3.5",
                      status.isFetching && "animate-spin",
                    )}
                    aria-hidden="true"
                  />
                  {t("publicStatus.error.retry")}
                </Button>
              </NoticeCard>
            )
          ) : status.data ? (
            <StatusContent data={status.data} />
          ) : (
            <StatusSkeleton label={t("publicStatus.loading")} />
          )}
        </main>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-6 text-xs text-muted-foreground">
          <span>{t("publicStatus.autoRefreshHint")}</span>
          <Link
            to="/login"
            className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("publicStatus.footer.admin")}
            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
          </Link>
        </footer>
      </div>
    </div>
  );
}
