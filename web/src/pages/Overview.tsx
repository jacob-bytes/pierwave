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
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ServerOffIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
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
import { useOverview, useTraffic } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** recharts 只在概览页内部按需加载，避免拖大主 chunk。 */
const TrafficChart = lazy(
  () => import("@/components/overview/TrafficChart"),
);

const TRAFFIC_DAYS = 7;

/** 后端接口可能尚未上线，404 单独给一句可理解的中文。 */
function statsErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "统计接口暂未就绪，后端上线后刷新即可";
  }
  return errorText(error, "无法加载统计数据，请检查网络后重试");
}

function KpiCard({
  label,
  icon: Icon,
  value,
  hint,
}: {
  label: string;
  icon: LucideIcon;
  value: ReactNode;
  hint: string;
}) {
  return (
    <Card size="sm" className="gap-3">
      <CardHeader className="grid-cols-[1fr_auto] items-center gap-2">
        <CardDescription className="text-xs">{label}</CardDescription>
        <div className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
          <Icon className="size-3.5" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">
          {value}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function KpiSkeletons() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, index) => (
        <Card key={index} size="sm" className="gap-3">
          <CardHeader className="grid-cols-[1fr_auto] items-center gap-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="size-7 rounded-md" />
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Skeleton className="h-7 w-24" />
            <Skeleton className="h-3 w-16" />
          </CardContent>
        </Card>
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
        <Card className="gap-4">
          <CardHeader>
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-32" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-md" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-2.5 w-16" />
                </div>
                <Skeleton className="h-4 w-6" />
              </div>
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
          <TriangleAlertIcon className="size-5" />
        </div>
        <div>
          <p className="text-sm font-medium">概览加载失败</p>
          <p className="mt-1 text-xs text-muted-foreground">{message}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
        >
          <RefreshCwIcon
            className={cn("size-3.5", retrying && "animate-spin")}
          />
          重试
        </Button>
      </CardContent>
    </Card>
  );
}

function EmptyOverview() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-4 py-20 text-center">
        <div className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
          <ServerIcon className="size-6" />
        </div>
        <div>
          <p className="text-base font-medium">先添加服务器</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            添加服务器并安装 Agent
            后，这里会显示在线状态、用户、流量趋势与告警。
          </p>
        </div>
        <Button asChild>
          <Link to="/servers">
            <PlusIcon className="size-4" />
            去添加服务器
          </Link>
        </Button>
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
      className={cn(
        "group flex items-center gap-3 rounded-md px-2.5 py-2.5 transition-colors duration-150 hover:bg-muted/40",
        !active && "opacity-60 hover:opacity-100",
      )}
    >
      <div
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-md",
          active ? alertToneClasses[tone] : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {active ? hint : "暂无"}
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
      <ChevronRightIcon className="size-3.5 text-muted-foreground/50 transition-transform duration-150 group-hover:translate-x-0.5" />
    </Link>
  );
}

export default function OverviewPage() {
  const overview = useOverview();
  const traffic = useTraffic(TRAFFIC_DAYS);
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

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">概览</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            主控、服务器与订阅的实时概况。
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshAll}
          disabled={refreshing}
        >
          <RefreshCwIcon
            className={cn("size-3.5", refreshing && "animate-spin")}
          />
          刷新
        </Button>
      </div>

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
              label="在线服务器"
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
                  ? `${stats.alerts.offline_servers} 台离线`
                  : "全部在线"
              }
            />
            <KpiCard
              label="用户"
              icon={UsersIcon}
              value={
                <>
                  {stats.users.active}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">
                    / {stats.users.total}
                  </span>
                </>
              }
              hint={`共 ${stats.users.total} 个用户`}
            />
            <KpiCard
              label="套餐实例"
              icon={PackageIcon}
              value={stats.packages.instances}
              hint={`共 ${stats.packages.total} 个套餐模板`}
            />
            <KpiCard
              label="今日流量"
              icon={ActivityIcon}
              value={formatBytes(stats.traffic.today_bytes)}
              hint={`本月 ${formatBytes(stats.traffic.month_bytes)}`}
            />
          </section>

          <section className="grid gap-4 xl:grid-cols-3">
            <Card className="gap-4 xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm font-medium">
                  近 7 天流量趋势
                </CardTitle>
                <CardDescription className="text-xs">
                  按 UTC+8 自然日统计，缺少数据的日期按 0 计。
                </CardDescription>
                <CardAction>
                  <Badge
                    variant="outline"
                    className="font-mono text-[11px] font-normal text-muted-foreground"
                  >
                    {trafficTotal === null
                      ? "—"
                      : `7 天 ${formatBytes(trafficTotal)}`}
                  </Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                {traffic.isPending ? (
                  <Skeleton className="h-[248px] w-full" />
                ) : traffic.isError ? (
                  <div className="flex h-[248px] flex-col items-center justify-center gap-3 text-center">
                    <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
                      <TriangleAlertIcon className="size-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">流量趋势加载失败</p>
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
                          "size-3.5",
                          traffic.isFetching && "animate-spin",
                        )}
                      />
                      重试
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
                <CardTitle className="text-sm font-medium">告警</CardTitle>
                <CardDescription className="text-xs">
                  需要你处理的事项，点击可跳转。
                </CardDescription>
                <CardAction>
                  {alertTotal > 0 ? (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-warning/10 font-normal text-warning"
                    >
                      {alertTotal} 项待处理
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="gap-1 border-transparent bg-primary/10 font-normal text-primary"
                    >
                      <CheckCircle2Icon className="size-3" />
                      全部正常
                    </Badge>
                  )}
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 p-2">
                <AlertRow
                  to="/users"
                  icon={ClockIcon}
                  label="过期套餐实例"
                  count={stats.alerts.expired_instances}
                  hint="去用户页续期"
                  tone="warning"
                />
                <AlertRow
                  to="/users"
                  icon={GaugeIcon}
                  label="流量用尽实例"
                  count={stats.alerts.exhausted_instances}
                  hint="去用户页调整额度"
                  tone="destructive"
                />
                <AlertRow
                  to="/servers"
                  icon={ServerOffIcon}
                  label="离线服务器"
                  count={stats.alerts.offline_servers}
                  hint="去服务器页检查 Agent"
                  tone="destructive"
                />
                {expiringCerts > 0 ? (
                  <AlertRow
                    to="/certificates"
                    icon={FileKeyIcon}
                    label="即将到期的证书"
                    count={expiringCerts}
                    hint={`${expiringCerts} 张证书 30 天内到期，点击去更换`}
                    tone="warning"
                  />
                ) : null}
              </CardContent>
            </Card>
          </section>
        </>
      ) : null}
    </div>
  );
}
