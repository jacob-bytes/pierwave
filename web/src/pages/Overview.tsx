import { lazy, Suspense, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  CalendarPlusIcon,
  ChartColumnIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClockIcon,
  FileKeyIcon,
  GaugeIcon,
  HandshakeIcon,
  HistoryIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ServerOffIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UsersIcon,
  WaypointsIcon,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { BatchRenewDialog } from "@/components/overview/BatchRenewDialog";
import { CleanupEventsDialog } from "@/components/overview/CleanupEventsDialog";
import { ApiError, type OverviewProtocol, type OverviewTopItem } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import {
  formatShare,
  sortProtocols,
  topServers,
  visibleAlerts,
} from "@/lib/overview";
import {
  useEnforcementEvents,
  useOverview,
  useOverviewStats,
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
        <SkeletonCard lines={5} />
      </section>
      <section className="grid gap-4 xl:grid-cols-3">
        <SkeletonCard lines={4} />
        <Card className="gap-4 xl:col-span-2">
          <CardHeader>
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-8 w-full" />
            ))}
          </CardContent>
        </Card>
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

/** 新增卡片的错误态：比整页错误轻，避免新接口 404 时拖垮既有概览。 */
function PanelError({
  message,
  retrying,
  onRetry,
}: {
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <div className="grid size-9 place-items-center rounded-full bg-destructive/10 text-destructive">
        <TriangleAlertIcon className="icon-md" />
      </div>
      <div>
        <p className="text-sm font-medium">{t("overview.panelLoadFailed")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{message}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={retrying}
      >
        <RefreshCwIcon className={cn("icon-md", retrying && "animate-spin")} />
        {t("common.retry")}
      </Button>
    </div>
  );
}

function ProtocolCard({
  protocols,
  isPending,
  error,
  retrying,
  onRetry,
  className,
}: {
  protocols: OverviewProtocol[] | undefined;
  isPending: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  className?: string;
}) {
  const rows = sortProtocols(protocols ?? []);
  const total = rows.reduce(
    (sum, row) => sum + (Number.isFinite(row.traffic_7d) ? row.traffic_7d : 0),
    0,
  );

  return (
    <Card className={cn("flex flex-col gap-0", className)}>
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-sm font-medium">
          {t("overview.protocolTitle")}
        </CardTitle>
      </CardHeader>
      {isPending ? (
        <CardContent className="flex flex-col gap-4 p-4" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="h-1.5 w-full" />
            </div>
          ))}
        </CardContent>
      ) : error ? (
        <PanelError
          message={statsErrorText(error)}
          retrying={retrying}
          onRetry={onRetry}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={ChartColumnIcon}
          title={t("overview.protocolEmpty")}
          className="py-10"
        />
      ) : (
        <CardContent className="p-2">
          <ul className="flex flex-col">
            {rows.map((row) => {
              const traffic = Number.isFinite(row.traffic_7d)
                ? row.traffic_7d
                : 0;
              const share = formatShare(traffic, total);
              const label =
                row.protocol === "unknown"
                  ? t("overview.protocolUnknown")
                  : row.protocol;

              return (
                <li
                  key={row.protocol}
                  className="flex flex-col gap-1.5 rounded-md px-2.5 py-2"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span
                        className={cn(
                          "truncate text-sm",
                          row.protocol !== "unknown" && "font-mono",
                        )}
                      >
                        {label}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {t(
                          row.nodes === 1
                            ? "overview.protocolNodesOne"
                            : "overview.protocolNodes",
                          { n: row.nodes },
                        )}
                      </span>
                    </div>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      {formatBytes(traffic)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      aria-hidden="true"
                      className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                    >
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${share}%` }}
                      />
                    </div>
                    <span className="w-8 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
                      {Math.round(share)}%
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

function TopCard({
  items,
  isPending,
  error,
  retrying,
  onRetry,
  className,
}: {
  items: OverviewTopItem[] | undefined;
  isPending: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  className?: string;
}) {
  const rows = topServers(items);

  return (
    <Card className={cn("flex flex-col gap-0", className)}>
      <CardHeader className="border-b border-border pb-4">
        <CardTitle className="text-sm font-medium">
          {t("overview.topTitle")}
        </CardTitle>
      </CardHeader>
      {isPending ? (
        <CardContent className="flex flex-col gap-3 p-4" aria-hidden="true">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex items-center gap-3">
              <Skeleton className="h-3.5 flex-1" />
              <Skeleton className="h-3 w-14" />
              <Skeleton className="size-2 rounded-full" />
              <Skeleton className="h-3 w-10" />
            </div>
          ))}
        </CardContent>
      ) : error ? (
        <PanelError
          message={statsErrorText(error)}
          retrying={retrying}
          onRetry={onRetry}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={ServerIcon}
          title={t("overview.topEmpty")}
          className="py-10"
        />
      ) : (
        <CardContent className="flex flex-1 flex-col p-2">
          <ul className="flex flex-1 flex-col justify-between gap-0.5">
            {rows.map((item, index) => {
              const load =
                typeof item.load1 === "number" && Number.isFinite(item.load1)
                  ? item.load1.toFixed(2)
                  : "—";
              const statusLabel = item.online
                ? t("servers.statusOnline")
                : t("servers.statusOffline");

              return (
                <li key={`${item.name}-${index}`}>
                  <Link
                    to="/servers"
                    className="group flex items-center gap-3 rounded-md px-2.5 py-3.5 transition-colors duration-150 hover:bg-muted/40"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {item.name}
                    </span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      {formatBytes(item.traffic_7d)}
                    </span>
                    <span
                      role="img"
                      aria-label={statusLabel}
                      title={statusLabel}
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        item.online
                          ? "bg-primary status-breathe"
                          : "bg-muted-foreground/40",
                      )}
                    />
                    <span
                      title={t("overview.loadValue", { value: load })}
                      className="w-12 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums"
                    >
                      {load}
                    </span>
                    <ChevronRightIcon className="icon-sm text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

type AlertTone = "warning" | "destructive";

const alertToneClasses: Record<AlertTone, string> = {
  warning: "bg-warning/10 text-warning",
  destructive: "bg-destructive/10 text-destructive",
};

/** 告警卡最多平铺几条：与右侧 Top 5 的高度对齐，其余进弹窗。 */
const ALERT_PREVIEW = 3;

interface AlertItem {
  key: string;
  to: string;
  icon: LucideIcon;
  label: string;
  count: number;
  hint: string;
  tone: AlertTone;
  /** 行尾的批量操作入口；目前只有「过期套餐实例」带。 */
  action?: ReactNode;
}

function AlertRow({
  to,
  icon: Icon,
  label,
  count,
  hint,
  tone,
  action,
  onNavigate,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  count: number;
  hint: string;
  tone: AlertTone;
  /** 行尾的批量操作入口；按钮不能嵌在 Link 里，所以单独作为兄弟节点。 */
  action?: ReactNode;
  /** 在弹窗里点击后关掉弹窗。 */
  onNavigate?: () => void;
}) {
  const active = count > 0;

  return (
    <div className="group flex items-center rounded-md transition-colors duration-150 hover:bg-muted/40">
      <Link
        to={to}
        onClick={onNavigate}
        className="flex min-w-0 flex-1 items-center gap-3 px-2.5 py-2.5"
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
      {action ? <div className="shrink-0 pr-1.5">{action}</div> : null}
    </div>
  );
}

export default function OverviewPage() {
  useI18n();
  // 既有统计接口继续供第一行 KPI 与告警计数；新聚合接口只驱动新增卡片。
  const overview = useOverviewStats();
  const aggregate = useOverview(TRAFFIC_DAYS);
  const traffic = useTraffic(TRAFFIC_DAYS);
  const events = useEnforcementEvents(50);
  const recentRemoved =
    events.data?.filter((event) => event.kind === "removed").length ?? 0;
  const refreshing =
    overview.isFetching || aggregate.isFetching || traffic.isFetching;

  function refreshAll() {
    void overview.refetch();
    void aggregate.refetch();
    void traffic.refetch();
  }

  const stats = overview.data;
  const chainAlerts = visibleAlerts(aggregate.data?.chains);
  const chainAlertTotal = chainAlerts.reduce(
    (sum, alert) => sum + alert.count,
    0,
  );
  // 新装系统最先要做的动作是加服务器；即使已经有管理员账号也走这个空态。
  const isNewInstall = stats !== undefined && stats.servers.total === 0;
  const expiringCerts = stats?.alerts.expiring_certs ?? 0;
  const alertTotal = stats
    ? stats.alerts.expired_instances +
      stats.alerts.exhausted_instances +
      stats.alerts.offline_servers +
      expiringCerts +
      chainAlertTotal
    : 0;

  const trafficTotal =
    traffic.data?.days.reduce((sum, day) => sum + day.weighted, 0) ?? null;
  // 只有后端真实给出「今天 + 昨天」两个日桶时才显示变化率；否则整项省略。
  const trafficDelta = trafficDayOverDay(traffic.data?.days);

  // 告警项统一成一个数组：卡片里只展示前 ALERT_PREVIEW 条（与右侧 Top 5 高度对齐），
  // 其余进「查看全部」弹窗。告警多时不再把整列拉长。
  const [allAlertsOpen, setAllAlertsOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const alertItems: AlertItem[] = stats
    ? [
        {
          key: "expired",
          to: "/users",
          icon: ClockIcon,
          label: t("overview.expiredInstances"),
          count: stats.alerts.expired_instances,
          hint: t("overview.expiredHint"),
          tone: "warning",
          action: (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setAllAlertsOpen(false);
                setRenewOpen(true);
              }}
            >
              <CalendarPlusIcon />
              {t("overview.renewAction")}
            </Button>
          ),
        },
        {
          key: "exhausted",
          to: "/users",
          icon: GaugeIcon,
          label: t("overview.exhaustedInstances"),
          count: stats.alerts.exhausted_instances,
          hint: t("overview.exhaustedHint"),
          tone: "destructive",
        },
        {
          key: "offline",
          to: "/servers",
          icon: ServerOffIcon,
          label: t("overview.offlineServers"),
          count: stats.alerts.offline_servers,
          hint: t("overview.offlineHint"),
          tone: "destructive",
        },
        ...(expiringCerts > 0
          ? [
              {
                key: "certs",
                to: "/settings?tab=certificates",
                icon: FileKeyIcon,
                label: t("overview.expiringCerts"),
                count: expiringCerts,
                hint: t("overview.expiringHint", { n: expiringCerts }),
                tone: "warning" as const,
              },
            ]
          : []),
        ...chainAlerts.map((alert) => ({
          key: alert.kind,
          to: "/chains",
          icon: alert.kind === "degraded" ? WaypointsIcon : HandshakeIcon,
          label: t(
            alert.kind === "degraded"
              ? "overview.degradedChains"
              : "overview.handshakeFailures",
          ),
          count: alert.count,
          hint: t(
            alert.kind === "degraded"
              ? "overview.degradedChainsHint"
              : "overview.handshakeFailuresHint",
          ),
          tone: "warning" as const,
        })),
      ]
    : [];
  const previewAlerts = alertItems.slice(0, ALERT_PREVIEW);
  const hiddenAlertCount = alertItems.length - previewAlerts.length;

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

            <ProtocolCard
              protocols={aggregate.data?.protocols}
              isPending={aggregate.isPending}
              error={aggregate.isError ? aggregate.error : null}
              retrying={aggregate.isFetching}
              onRetry={() => void aggregate.refetch()}
            />
          </section>

          {/* 这里保持默认 stretch：告警卡高、Top 5 矮，让 Top 5 的行均分剩余高度，
              两卡底部对齐且卡片内部不出现大片空白。告警超过 ALERT_PREVIEW 条进弹窗。 */}
          <section className="grid gap-4 xl:grid-cols-3">
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
                {previewAlerts.map((alert) => (
                  <AlertRow
                    key={alert.key}
                    to={alert.to}
                    icon={alert.icon}
                    label={alert.label}
                    count={alert.count}
                    hint={alert.hint}
                    tone={alert.tone}
                    action={alert.action}
                  />
                ))}
                {hiddenAlertCount > 0 ? (
                  <button
                    type="button"
                    onClick={() => setAllAlertsOpen(true)}
                    className="mt-1 flex items-center justify-between rounded-md px-2.5 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground"
                  >
                    <span>
                      {t("overview.alertMore", { n: hiddenAlertCount })}
                    </span>
                    <ChevronRightIcon className="icon-sm" />
                  </button>
                ) : null}
                {recentRemoved > 0 ? (
                  <div className="mt-1 flex items-center rounded-md transition-colors duration-150 hover:bg-muted/40">
                    <Link
                      to="/events"
                      className="flex min-w-0 flex-1 items-center justify-between gap-2 px-2.5 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <HistoryIcon className="icon-sm shrink-0" />
                        <span className="truncate">
                          {t(
                            recentRemoved === 1
                              ? "overview.recentRemovedOne"
                              : "overview.recentRemoved",
                            { n: recentRemoved },
                          )}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {t("overview.viewRecords")}
                        <ChevronRightIcon className="icon-sm" />
                      </span>
                    </Link>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="mr-1 shrink-0 text-muted-foreground"
                      title={t("overview.cleanupAria")}
                      onClick={() => setCleanupOpen(true)}
                    >
                      <Trash2Icon />
                      {t("overview.cleanupAction")}
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <TopCard
              items={aggregate.data?.top}
              isPending={aggregate.isPending}
              error={aggregate.isError ? aggregate.error : null}
              retrying={aggregate.isFetching}
              onRetry={() => void aggregate.refetch()}
              className="xl:col-span-2"
            />
          </section>
        </>
      ) : null}

      <Dialog open={allAlertsOpen} onOpenChange={setAllAlertsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("overview.alertsAllTitle")}</DialogTitle>
            <DialogDescription>
              {t("overview.pendingCount", { n: alertTotal })}
            </DialogDescription>
          </DialogHeader>
          {/* 告警项多时可滚动，弹窗高度不随条数增长 */}
          <div className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto">
            {alertItems.map((alert) => (
              <AlertRow
                key={alert.key}
                to={alert.to}
                icon={alert.icon}
                label={alert.label}
                count={alert.count}
                hint={alert.hint}
                tone={alert.tone}
                onNavigate={() => setAllAlertsOpen(false)}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {renewOpen ? (
        <BatchRenewDialog
          open
          onOpenChange={setRenewOpen}
          expiredCount={stats?.alerts.expired_instances ?? 0}
        />
      ) : null}
      {cleanupOpen ? (
        <CleanupEventsDialog open onOpenChange={setCleanupOpen} />
      ) : null}
    </div>
  );
}
