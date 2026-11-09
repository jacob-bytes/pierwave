import { lazy, Suspense, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClockIcon,
  FileKeyIcon,
  GaugeIcon,
  HistoryIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ServerOffIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import {
  EmptyState,
  PageHeader,
  SkeletonCard,
} from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import {
  useEnforcementEvents,
  useOverview,
  useTraffic,
} from "@/lib/queries";
import { trafficDayOverDay } from "@/lib/trafficDelta";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** recharts 只在概览页内部按需加载，避免拖大主 chunk。 */
const TrafficChart = lazy(
  () => import("@/components/overview/TrafficChart"),
);

const TRAFFIC_DAYS = 7;

/** 后端接口可能尚未上线，404 单独给一句可理解的中文。 */
function statsErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return t("overview.statsNotReady");
  }
  return errorText(error, t("overview.statsError"));
}

/** 把 `936 MB` 拆成大号数字 + 小号单位，主次一眼可分。 */
function ByteValue({ bytes }: { bytes: number }) {
  const text = formatBytes(bytes);
  const split = text.lastIndexOf(" ");
  if (split === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, split)}
      <span className="ml-1 text-sm font-normal text-muted-foreground">
        {text.slice(split + 1)}
      </span>
    </>
  );
}

function KpiCard({
  label,
  icon: Icon,
  value,
  hint,
  delta,
}: {
  label: string;
  icon: LucideIcon;
  value: ReactNode;
  hint: string;
  /** 相对上一周期的变化百分比；没有可比数据时传 null 或省略。 */
  delta?: number | null;
}) {
  const hasDelta = typeof delta === "number" && Number.isFinite(delta);
  const deltaText = !hasDelta
    ? null
    : Math.abs(delta) < 0.05
      ? t("overview.trafficDeltaFlat")
      : delta > 0
        ? t("overview.trafficDeltaUp", {
            value: Math.abs(delta).toFixed(1),
          })
        : t("overview.trafficDeltaDown", {
            value: Math.abs(delta).toFixed(1),
          });

  return (
    <Card size="sm" className="h-full gap-3">
      <CardHeader className="grid-cols-[1fr_auto] items-center gap-2">
        <CardDescription className="text-xs">{label}</CardDescription>
        <div className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
          <Icon className="icon-sm" />
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <div className="flex items-baseline text-[28px] leading-tight font-medium tracking-tight tabular-nums">
          {value}
        </div>
        {/* 底部对齐：有变化率时不会把同一行的其它卡片撑得高低不一。 */}
        <div className="mt-auto pt-2">
          {deltaText ? (
            // 流量涨跌本身没有好坏：保持 muted，不用绿 / 红，也不加图标。
            <p className="text-xs text-muted-foreground tabular-nums">
              {deltaText}
            </p>
          ) : null}
          <p
            className={cn(
              "text-xs text-muted-foreground",
              deltaText && "mt-0.5",
            )}
          >
            {hint}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function KpiSkeletons() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, index) => (
        <SkeletonCard key={index} lines={2} />
      ))}
    </>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiSkeletons />
      </section>
      <section className="grid gap-4 xl:grid-cols-3">
        <Card className="gap-4 xl:col-span-2">
          <CardHeader>
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-56" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[248px] w-full" />
          </CardContent>
        </Card>
        <SkeletonCard lines={3} />
      </section>
    </>
  );
}

function OverviewError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
          <TriangleAlertIcon className="icon-lg" />
        </div>
        <div>
          <p className="text-sm font-medium">{t("overview.loadFailed")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{message}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
        >
          <RefreshCwIcon
            className={cn("icon-md", retrying && "animate-spin")}
          />
          {t("common.retry")}
        </Button>
      </CardContent>
    </Card>
  );
}

function EmptyOverview() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          tone="primary"
          icon={ServerIcon}
          title={t("overview.emptyTitle")}
          description={t("overview.emptyDesc")}
          className="py-16"
          action={
            <Button asChild>
              <Link to="/servers">
                <PlusIcon className="icon-md" />
                {t("overview.emptyAction")}
              </Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}

type AlertTone = "warning" | "destructive";

const alertToneClasses: Record<AlertTone, string> = {
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

function AlertRow({
  to,
  icon: Icon,
  label,
  count,
  hint,
  tone,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  count: number;
  hint: string;
  tone: AlertTone;
}) {
  const active = count > 0;

  return (
    <Link
      to={to}
      className="group flex items-center gap-3 rounded-md px-2.5 py-2.5 transition-colors duration-150 hover:bg-muted/40"
    >
      <div
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md",
          active ? alertToneClasses[tone] : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="icon-md" />
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-sm",
            !active && "text-muted-foreground",
          )}
        >
          {label}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {active ? hint : t("common.none")}
        </p>
      </div>
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {count}
      </span>
      <ChevronRightIcon className="icon-sm text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5" />
    </Link>
  );
}

export default function OverviewPage() {
  useI18n();
  const overview = useOverview();
  const traffic = useTraffic(TRAFFIC_DAYS);
  const events = useEnforcementEvents(50);
  const recentRemoved =
    events.data?.filter((event) => event.kind === "removed").length ?? 0;
  const refreshing = overview.isFetching || traffic.isFetching;

  function refreshAll() {
    void overview.refetch();
    void traffic.refetch();
  }

  const stats = overview.data;
  // 新装系统最先要做的动作是加服务器；即使已经有管理员账号也走这个空态。
  const isNewInstall = stats !== undefined && stats.servers.total === 0;
  const expiringCerts = stats?.alerts.expiring_certs ?? 0;
  const alertTotal = stats
    ? stats.alerts.expired_instances +
      stats.alerts.exhausted_instances +
      stats.alerts.offline_servers +
      expiringCerts
    : 0;

  const trafficTotal =
    traffic.data?.days.reduce((sum, day) => sum + day.weighted, 0) ?? null;
  // 只有后端真实给出「今天 + 昨天」两个日桶时才显示变化率；否则整项省略。
  const trafficDelta = trafficDayOverDay(traffic.data?.days);

  return (
    <div className="animate-enter space-y-6">
      <PageHeader
        title={t("overview.title")}
        description={t("overview.subtitle")}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={refreshAll}
            disabled={refreshing}
          >
            <RefreshCwIcon
              className={cn("icon-md", refreshing && "animate-spin")}
            />
            {t("common.refresh")}
          </Button>
        }
      />

      {overview.isPending ? (
        <OverviewSkeleton />
      ) : overview.isError ? (
        <OverviewError
          message={statsErrorText(overview.error)}
          retrying={overview.isFetching}
          onRetry={() => void overview.refetch()}
        />
      ) : isNewInstall ? (
        <EmptyOverview />
      ) : stats ? (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label={t("overview.onlineServers")}
              icon={ServerIcon}
              value={
                <>
                  {stats.servers.online}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">
                    / {stats.servers.total}
                  </span>
                </>
              }
              hint={
                stats.alerts.offline_servers > 0
                  ? t("overview.offlineCount", { n: stats.alerts.offline_servers })
                  : t("overview.allOnline")
              }
            />
            <KpiCard
              label={t("overview.users")}
              icon={UsersIcon}
              value={
                <>
                  {stats.users.active}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">
                    / {stats.users.total}
                  </span>
                </>
              }
              hint={t(
                stats.users.total === 1
                  ? "overview.usersTotalHintOne"
                  : "overview.usersTotalHint",
                { n: stats.users.total },
              )}
            />
            <KpiCard
              label={t("overview.packageInstances")}
              icon={PackageIcon}
              value={stats.packages.instances}
              hint={t("overview.packagesTotalHint", { n: stats.packages.total })}
            />
            <KpiCard
              label={t("overview.todayTraffic")}
              icon={ActivityIcon}
              value={<ByteValue bytes={stats.traffic.today_bytes} />}
              delta={trafficDelta}
              hint={t("overview.monthTrafficHint", {
                value: formatBytes(stats.traffic.month_bytes),
              })}
            />
          </section>

          <section className="grid gap-4 xl:grid-cols-3">
            <Card className="gap-4 xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  {t("overview.trafficTrend")}
                </CardTitle>
                <CardDescription className="text-xs">
                  {t("overview.trafficTrendDesc")}
                </CardDescription>
                <CardAction>
                  <Badge
                    variant="outline"
                    className="font-mono type-micro font-normal text-muted-foreground"
                  >
                    {trafficTotal === null
                      ? "—"
                      : t("overview.trafficTotal", {
                          value: formatBytes(trafficTotal),
                        })}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                {traffic.isPending ? (
                  <Skeleton className="h-[248px] w-full" />
                ) : traffic.isError ? (
                  <div className="flex h-[248px] flex-col items-center justify-center gap-3 text-center">
                    <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
                      <TriangleAlertIcon className="icon-lg" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{t("overview.trafficLoadFailed")}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {statsErrorText(traffic.error)}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void traffic.refetch()}
                      disabled={traffic.isFetching}
                    >
                      <RefreshCwIcon
                        className={cn(
                          "icon-md",
                          traffic.isFetching && "animate-spin",
                        )}
                      />
                      {t("common.retry")}
                    </Button>
                  </div>
                ) : (
                  <Suspense fallback={<Skeleton className="h-[248px] w-full" />}>
                    <TrafficChart days={traffic.data?.days ?? []} />
                  </Suspense>
                )}
              </CardContent>
            </Card>

            <Card className="gap-0">
              <CardHeader className="border-b border-border pb-4">
                <CardTitle className="text-sm font-medium">{t("overview.alerts")}</CardTitle>
                <CardDescription className="text-xs">
                  {t("overview.alertsDesc")}
                </CardDescription>
                <CardAction>
                  {alertTotal > 0 ? (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-warning/10 font-normal text-warning"
                    >
                      {t("overview.pendingCount", { n: alertTotal })}
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="gap-1 border-transparent bg-primary/10 font-normal text-primary"
                    >
                      <CheckCircle2Icon className="size-3" />
                      {t("overview.allNormal")}
                    </Badge>
                  )}
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 p-2">
                <AlertRow
                  to="/users"
                  icon={ClockIcon}
                  label={t("overview.expiredInstances")}
                  count={stats.alerts.expired_instances}
                  hint={t("overview.expiredHint")}
                  tone="warning"
                />
                <AlertRow
                  to="/users"
                  icon={GaugeIcon}
                  label={t("overview.exhaustedInstances")}
                  count={stats.alerts.exhausted_instances}
                  hint={t("overview.exhaustedHint")}
                  tone="destructive"
                />
                <AlertRow
                  to="/servers"
                  icon={ServerOffIcon}
                  label={t("overview.offlineServers")}
                  count={stats.alerts.offline_servers}
                  hint={t("overview.offlineHint")}
                  tone="destructive"
                />
                {expiringCerts > 0 ? (
                  <AlertRow
                    to="/settings?tab=certificates"
                    icon={FileKeyIcon}
                    label={t("overview.expiringCerts")}
                    count={expiringCerts}
                    hint={t("overview.expiringHint", { n: expiringCerts })}
                    tone="warning"
                  />
                ) : null}
                {recentRemoved > 0 ? (
                  <Link
                    to="/events"
                    className="mt-1 flex items-center justify-between rounded-md px-2.5 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <HistoryIcon className="icon-sm" />
                      {t(
                        recentRemoved === 1
                          ? "overview.recentRemovedOne"
                          : "overview.recentRemoved",
                        { n: recentRemoved },
                      )}
                    </span>
                    <span className="flex items-center gap-1">
                      {t("overview.viewRecords")}
                      <ChevronRightIcon className="icon-sm" />
                    </span>
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          </section>
        </>
      ) : null}
    </div>
  );
}
