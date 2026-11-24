import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  PackageIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import {
  EmptyState,
  ListError,
  PageHeader,
  SkeletonCard,
} from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import OverviewInsight from "@/components/overview/OverviewInsight";
import { useOverviewScope } from "@/components/overview/useOverviewScope";
import { useOverview, useOverviewStats, useTraffic } from "@/lib/queries";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { statsErrorText } from "@/lib/overviewErrors";
import { OVERVIEW_TRAFFIC_DAYS } from "@/lib/overviewViews";
import { trafficDayOverDay } from "@/lib/trafficDelta";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

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
  global,
}: {
  label: string;
  icon: LucideIcon;
  value: ReactNode;
  hint: string;
  /** 相对上一周期的变化百分比；没有可比数据时传 null 或省略。 */
  delta?: number | null;
  /** 该 KPI 不受服务器筛选影响（用户 / 套餐实例），加「全局」小字。 */
  global?: boolean;
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
        {/* 标签用普通文本而不是 CardDescription：后者会触发卡头的两行网格，
            在只有标签 + 图标时多出一条 8px 空行。 */}
        <p
          data-kpi-label
          className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-tight text-muted-foreground"
        >
          <span className="min-w-0">{label}</span>
          {global ? (
            <span
              data-kpi-global
              className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[11px] leading-none text-muted-foreground"
            >
              {t("overview.scope.global")}
            </span>
          ) : null}
        </p>
        <div className="grid size-6 place-items-center rounded-md bg-primary/10 text-primary">
          <Icon className="icon-sm" />
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        {/* leading-none 收紧 28px 数字的行距，字号与字重不变。 */}
        <div
          data-kpi-value
          className="flex items-baseline text-[28px] leading-none font-medium tracking-tight tabular-nums"
        >
          {value}
        </div>
        {/* 底部对齐：有变化率时不会把同一行的其它卡片撑得高低不一。
            宽屏把变化率并到说明同一行（说明靠左、变化率靠右），
            放不下时才换行，避免四张卡被多出来的一行整体撑高。 */}
        <div className="mt-auto flex flex-col gap-y-0.5 pt-2 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-3 sm:gap-y-0">
          {deltaText ? (
            // 流量涨跌本身没有好坏：保持 muted，不用绿 / 红，也不加图标。
            <p className="text-xs text-muted-foreground tabular-nums sm:ml-auto sm:whitespace-nowrap">
              {deltaText}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground sm:order-first sm:whitespace-nowrap">
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
      <section className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <KpiSkeletons />
      </section>
      <section className="grid min-w-0 gap-4">
        <Skeleton className="h-9 w-full rounded-lg" />
        <Card className="gap-4">
          <CardContent className="p-4">
            <Skeleton className="h-[320px] w-full" />
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function OverviewError({
  title,
  message,
  retrying,
  onRetry,
}: {
  title?: string;
  message: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardContent>
        <ListError
          title={title ?? t("overview.loadFailed")}
          message={message}
          retrying={retrying}
          onRetry={onRetry}
        />
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

export default function OverviewPage() {
  useI18n();
  // 全局 KPI 只需要 stats + 今日流量的日环比；趋势 / 分布 / 排行等
  // 都在「流量」tab 里按需挂载，切到其它 tab 不会请求它们。
  const statsQuery = useOverviewStats();
  const traffic = useTraffic(OVERVIEW_TRAFFIC_DAYS);
  const scope = useOverviewScope();
  // 只有缩小了范围才请求带 server_ids 的聚合；全选时沿用 stats 的全量值。
  const scopedOverview = useOverview(
    OVERVIEW_TRAFFIC_DAYS,
    scope.filtered ? scope.selectedIds : [],
    scope.filtered && scope.selectedIds.length > 0,
  );
  const queryClient = useQueryClient();
  const activeOverviewFetching =
    useIsFetching({ queryKey: ["overview"] }) > 0;
  const activeChainsFetching = useIsFetching({ queryKey: ["chains"] }) > 0;
  const activeServersFetching = useIsFetching({ queryKey: ["servers"] }) > 0;
  const activeSettingsFetching =
    useIsFetching({ queryKey: ["settings"] }) > 0;
  const refreshing =
    statsQuery.isFetching ||
    traffic.isFetching ||
    activeOverviewFetching ||
    activeChainsFetching ||
    activeServersFetching ||
    activeSettingsFetching;

  function refreshAll() {
    void statsQuery.refetch();
    void traffic.refetch();
    // 只刷新当前 active 的 tab 查询，避免离开的 tab 被无关重拉。
    void queryClient.refetchQueries({ queryKey: ["overview"], type: "active" });
    void queryClient.refetchQueries({ queryKey: ["chains"], type: "active" });
    void queryClient.refetchQueries({ queryKey: ["servers"], type: "active" });
    void queryClient.refetchQueries({ queryKey: ["settings"], type: "active" });
  }

  const stats = statsQuery.data;
  const trafficDelta = trafficDayOverDay(traffic.data?.days);
  const scopeReady = scope.ready && scope.servers.length > 0;
  const emptyScope = scopeReady && scope.selectedIds.length === 0;
  const scopedOnline = scopeReady
    ? scope.selectedServers.filter((server) => server.status === "online")
        .length
    : (stats?.servers.online ?? 0);
  const scopedTotal = scopeReady
    ? scope.selectedServers.length
    : (stats?.servers.total ?? 0);
  const scopedOffline = Math.max(0, scopedTotal - scopedOnline);

  // 后端真正应用了筛选才用聚合里的流量；旧主控返回不带 scope，保留全量值。
  const scopedAggregate =
    scope.filtered && scope.selectedIds.length > 0
      ? scopedOverview.data
      : undefined;
  const trafficScoped = scopedAggregate?.scope?.filtered === true;
  // 后端会忽略请求里不认识的 id；这里提示一次，避免用户以为筛选坏了。
  const unknownServerIds = scopedAggregate?.warnings?.unknown_ids ?? [];
  const scopeUnsupported =
    scope.filtered &&
    scope.selectedIds.length > 0 &&
    scopedOverview.isSuccess &&
    !trafficScoped;
  const todayBytes =
    trafficScoped && scopedAggregate
      ? scopedAggregate.kpi.traffic_today
      : stats?.traffic.today_bytes;
  const monthBytes =
    trafficScoped && scopedAggregate
      ? scopedAggregate.kpi.traffic_month
      : stats?.traffic.month_bytes;
  const trafficHint = emptyScope
    ? t("overview.scope.emptyTitle")
    : scope.filtered
      ? scopeUnsupported
        ? t("overview.scope.trafficNeedsUpgrade")
        : scopedOverview.isError
          ? t("overview.scope.trafficUnavailable")
          : t("overview.monthTrafficHint", {
              value: formatBytes(monthBytes ?? 0),
            })
      : t("overview.monthTrafficHint", {
          value: formatBytes(monthBytes ?? 0),
        });
  // 新装系统最先要做的动作是加服务器；即使已经有管理员账号也走这个空态。
  const isNewInstall = stats !== undefined && stats.servers.total === 0;

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

      {statsQuery.isPending ? (
        <OverviewSkeleton />
      ) : statsQuery.isError ? (
        <OverviewError
          message={statsErrorText(statsQuery.error)}
          retrying={statsQuery.isFetching}
          onRetry={() => void statsQuery.refetch()}
        />
      ) : scope.isError ? (
        // 服务器列表失败时不能显示「未选择 / 没有服务器」：那是假空态。
        <OverviewError
          title={t("servers.loadFailed")}
          message={errorText(scope.error, t("servers.loadFailed"))}
          retrying={scope.isFetching}
          onRetry={() => void scope.refetch()}
        />
      ) : !scope.ready ? (
        // 筛选范围还没算出来时先显示骨架，四个 tab 不渲染空态。
        <OverviewSkeleton />
      ) : isNewInstall ? (
        <EmptyOverview />
      ) : stats ? (
        <>
          {unknownServerIds.length > 0 ? (
            <div
              data-overview-unknown-ids
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-normal text-warning"
            >
              <TriangleAlertIcon
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0"
              />
              <span>
                {t("overview.scope.unknownIds", {
                  n: unknownServerIds.length,
                })}
              </span>
            </div>
          ) : null}
          <section className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <KpiCard
              label={t("overview.onlineServers")}
              icon={ServerIcon}
              value={
                emptyScope ? (
                  "—"
                ) : (
                  <>
                    {scopedOnline}
                    <span className="ml-1 text-sm font-normal text-muted-foreground">
                      / {scopedTotal}
                    </span>
                  </>
                )
              }
              hint={
                emptyScope
                  ? t("overview.scope.emptyTitle")
                  : scopedOffline > 0
                    ? t("overview.offlineCount", { n: scopedOffline })
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
              global
            />
            <KpiCard
              label={t("overview.packageInstances")}
              icon={PackageIcon}
              value={stats.packages.instances}
              hint={t("overview.packagesTotalHint", {
                n: stats.packages.total,
              })}
              global
            />
            <KpiCard
              label={t("overview.todayTraffic")}
              icon={ActivityIcon}
              value={
                emptyScope ? "—" : <ByteValue bytes={todayBytes ?? 0} />
              }
              delta={scope.filtered || emptyScope ? null : trafficDelta}
              hint={trafficHint}
            />
          </section>

          {/* 全局 KPI 在 tab 之上；tab 内部只渲染当前视图自己的卡片。 */}
          <section className="grid min-w-0 gap-4" data-overview-insight-section>
            <OverviewInsight stats={stats} scope={scope} />
          </section>
        </>
      ) : null}
    </div>
  );
}
