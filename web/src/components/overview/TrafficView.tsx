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
  NetworkIcon,
  PackageIcon,
  PowerIcon,
  ServerIcon,
  ServerOffIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UsersIcon,
  WaypointsIcon,
} from "lucide-react";
import { EmptyState, ListError, SkeletonCard } from "@/components/common";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BatchDisableDialog } from "@/components/overview/BatchDisableDialog";
import { BatchRenewDialog } from "@/components/overview/BatchRenewDialog";
import { CleanupEventsDialog } from "@/components/overview/CleanupEventsDialog";
import { PanelError } from "@/components/overview/PanelError";
import { RateSparkline } from "@/components/overview/Sparkline";
import {
  type OverviewPackageSplit,
  type OverviewProtocol,
  type OverviewProtocolSeries,
  type OverviewStats,
  type OverviewTopItem,
  type OverviewTopNode,
  type OverviewTopUser,
  type TrafficDay,
} from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { statsErrorText } from "@/lib/overviewErrors";
import {
  formatShare,
  sortProtocols,
  topServers,
  topUsers,
  visibleAlerts,
} from "@/lib/overview";
import {
  packageShare,
  packageSplitRows,
  packageTotal,
  packageUsers,
  topNodeMeta,
  topNodeRows,
} from "@/lib/overviewExtras";
import {
  DEFAULT_OVERVIEW_DISTRIBUTION_TAB,
  DEFAULT_OVERVIEW_LEADERBOARD_TAB,
  DEFAULT_OVERVIEW_TREND_TAB,
  overviewDistributionEmptyKey,
  overviewLeaderboardEmptyKey,
  resolveOverviewDistributionTab,
  resolveOverviewLeaderboardTab,
  resolveOverviewTrendTab,
  type OverviewDistributionTab,
  type OverviewLeaderboardTab,
  type OverviewTrendTab,
} from "@/lib/overviewTabs";
import { OVERVIEW_TRAFFIC_DAYS } from "@/lib/overviewViews";
import {
  useEnforcementEvents,
  useOverview,
  useTraffic,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const TrafficChart = lazy(
  () => import("@/components/overview/TrafficChart"),
);
const ProtocolTrendChart = lazy(
  () => import("@/components/overview/ProtocolTrendChart"),
);

function ProtocolDistributionList({
  rows,
  total,
}: {
  rows: OverviewProtocol[];
  total: number;
}) {
  return (
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
                <span className="w-8 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                  {Math.round(share)}%
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </CardContent>
  );
}

function PackageDistributionList({
  rows,
  total,
}: {
  rows: OverviewPackageSplit[];
  total: number;
}) {
  return (
    <CardContent className="p-2">
      <ul className="flex flex-col">
        {rows.map((row) => {
          const share = packageShare(row.traffic_7d, total);
          const users = packageUsers(row.users);
          return (
            <li
              key={row.package_id}
              className="flex flex-col gap-1.5 rounded-md px-2.5 py-2"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-sm" title={row.name}>
                    {row.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {t(
                      users === 1
                        ? "overview.packageUsersOne"
                        : "overview.packageUsers",
                      { n: users },
                    )}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-xs tabular-nums">
                  {formatBytes(row.traffic_7d)}
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
                <span className="w-8 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                  {Math.round(share)}%
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </CardContent>
  );
}

/**
 * 分布卡：协议 / 套餐共用同一张卡。两套数据都来自已加载的聚合查询，
 * 切标签只换视图，不会重新请求。
 */
function DistributionCard({
  protocols,
  packages,
  isPending,
  error,
  retrying,
  onRetry,
  className,
}: {
  protocols: OverviewProtocol[] | undefined;
  packages: OverviewPackageSplit[] | undefined;
  isPending: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  className?: string;
}) {
  const [tab, setTab] = useState<OverviewDistributionTab>(
    DEFAULT_OVERVIEW_DISTRIBUTION_TAB,
  );
  const protocolRows = sortProtocols(protocols ?? []);
  const protocolTotal = protocolRows.reduce(
    (sum, row) => sum + (Number.isFinite(row.traffic_7d) ? row.traffic_7d : 0),
    0,
  );
  const packageRows = packageSplitRows(packages);
  const packageTraffic = packageTotal(packageRows);
  const EmptyIcon = tab === "protocol" ? ChartColumnIcon : PackageIcon;
  // 加载 / 失败态对两个标签一致，提到变量里，避免面板内容为空。
  const pendingBody = isPending ? (
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
  ) : null;

  return (
    <Card className={cn("flex flex-col gap-0", className)}>
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setTab(resolveOverviewDistributionTab(value))
        }
        className="flex flex-1 flex-col gap-0"
      >
        <CardHeader className="border-b border-border pb-4">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <CardTitle className="text-sm font-medium">
              {t("overview.distributionTitle")}
            </CardTitle>
            <TabsList
              aria-label={t("overview.distributionTabsAria")}
              className="max-w-full overflow-x-auto"
            >
              <TabsTrigger value="protocol">
                {t("overview.distributionTabProtocol")}
              </TabsTrigger>
              <TabsTrigger value="package">
                {t("overview.distributionTabPackage")}
              </TabsTrigger>
            </TabsList>
          </div>
        </CardHeader>
        <TabsContent value="protocol">
          {pendingBody ??
            (protocolRows.length === 0 ? (
              <EmptyState
                size="sm"
                icon={EmptyIcon}
                title={t(overviewDistributionEmptyKey("protocol"))}
                className="py-10"
              />
            ) : (
              <ProtocolDistributionList
                rows={protocolRows}
                total={protocolTotal}
              />
            ))}
        </TabsContent>
        <TabsContent value="package">
          {pendingBody ??
            (packageRows.length === 0 ? (
              <EmptyState
                size="sm"
                icon={EmptyIcon}
                title={t(overviewDistributionEmptyKey("package"))}
                className="py-10"
              />
            ) : (
              <PackageDistributionList
                rows={packageRows}
                total={packageTraffic}
              />
            ))}
        </TabsContent>
      </Tabs>
    </Card>
  );
}

/**
 * 榜单行里的服务器：保留原来的趋势线、在线点、负载与 7 天流量。
 *
 * `<md` 收敛成两行：名称 + 趋势线 / 负载与流量合并一行，390 下不再把
 * 名称挤成一个词；`md` 以上用 `md:contents` 把两层包裹拆开，恢复原来的
 * 单行顺序（名称、趋势、流量、状态点、负载、箭头），显式 order 保证
 * 移动端重排不影响桌面顺序。
 */
function LeaderboardServerRow({ item }: { item: OverviewTopItem }) {
  const load =
    typeof item.load1 === "number" && Number.isFinite(item.load1)
      ? item.load1.toFixed(2)
      : "—";
  const statusLabel = item.online
    ? t("servers.statusOnline")
    : t("servers.statusOffline");
  const loadLabel = t("overview.loadValue", { value: load });

  return (
    <li>
      <Link
        to="/servers"
        className="group flex flex-col gap-1 rounded-md px-2.5 py-2.5 transition-colors duration-150 hover:bg-muted/40 active:bg-muted/60 md:flex-row md:items-center md:gap-3"
      >
        <span className="flex min-w-0 items-center gap-2 md:contents">
          <span className="min-w-0 flex-1 truncate text-sm" title={item.name}>
            {item.name}
          </span>
          {/* 窄屏把状态点留在名称行；桌面 order 把它放回流量之后。 */}
          <span
            role="img"
            aria-label={statusLabel}
            title={statusLabel}
            className={cn(
              "size-2 shrink-0 rounded-full md:order-3",
              item.online
                ? "bg-primary status-breathe"
                : "bg-muted-foreground/40",
            )}
          />
          {/* 只用线型表达最近 1 小时的趋势；采样不足显示 —。 */}
          <RateSparkline
            name={item.name}
            points={item.rates}
            className="w-14 md:order-1 md:w-[72px]"
          />
        </span>

        <span className="flex min-w-0 items-center gap-2 text-xs md:contents">
          {/* 移动端把负载与流量并成一行；桌面 order 恢复「流量 → 点 → 负载」。
              两端都带「负载」二字：桌面上只有 0.42 时看不出这是负载。 */}
          <span
            title={loadLabel}
            className="flex shrink-0 items-baseline gap-1 font-mono text-muted-foreground tabular-nums md:order-4 md:w-20 md:justify-end md:text-right"
          >
            <span className="md:hidden">{loadLabel}</span>
            <span className="hidden font-sans text-[11px] text-muted-foreground md:inline">
              {t("overview.loadLabel")}
            </span>
            <span className="hidden md:inline">{load}</span>
          </span>
          <span aria-hidden="true" className="text-muted-foreground md:hidden">
            ·
          </span>
          <span className="shrink-0 font-mono tabular-nums md:order-2">
            {formatBytes(item.traffic_7d)}
          </span>
          <ChevronRightIcon className="icon-sm ml-auto shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5 md:order-5" />
        </span>
      </Link>
    </li>
  );
}

/** 榜单行里的节点：协议 · 服务器名与原来一致，点击去节点总览。 */
function LeaderboardNodeRow({ node }: { node: OverviewTopNode }) {
  return (
    <li>
      <Link
        to="/nodes"
        className="group flex items-center gap-2 rounded-md px-2.5 py-2.5 transition-colors duration-150 hover:bg-muted/40 active:bg-muted/60 sm:gap-3"
      >
        <span className="min-w-0 flex-1 truncate text-sm" title={node.name}>
          {node.name}
        </span>
        <span
          className="min-w-0 max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted-foreground"
          title={topNodeMeta(node)}
        >
          {topNodeMeta(node)}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums">
          {formatBytes(node.traffic_7d)}
        </span>
        <ChevronRightIcon className="icon-sm shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
      </Link>
    </li>
  );
}

/** 榜单行里的用户：用户名 + 7 天流量，点击去用户页。 */
function LeaderboardUserRow({ user }: { user: OverviewTopUser }) {
  return (
    <li>
      <Link
        to="/users"
        className="group flex items-center gap-3 rounded-md px-2.5 py-2.5 transition-colors duration-150 hover:bg-muted/40 active:bg-muted/60"
      >
        <span
          className="min-w-0 flex-1 truncate text-sm"
          title={user.username}
        >
          {user.username}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums">
          {formatBytes(user.traffic_7d)}
        </span>
        <ChevronRightIcon className="icon-sm shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5" />
      </Link>
    </li>
  );
}

/**
 * 榜单卡：服务器 / 节点 / 用户三张 Top 5 合并成一张。
 * 三类数据都来自已加载的聚合查询，切标签不重新请求；每行一个跳转。
 */
function LeaderboardCard({
  items,
  users,
  nodes,
  isPending,
  error,
  retrying,
  onRetry,
  className,
}: {
  items: OverviewTopItem[] | undefined;
  users: OverviewTopUser[] | undefined;
  nodes: OverviewTopNode[] | undefined;
  isPending: boolean;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
  className?: string;
}) {
  const [tab, setTab] = useState<OverviewLeaderboardTab>(
    DEFAULT_OVERVIEW_LEADERBOARD_TAB,
  );
  const serverRows = topServers(items);
  const nodeRows = topNodeRows(nodes);
  const userRows = topUsers(users);
  const pendingBody = isPending ? (
    <CardContent className="flex flex-col gap-3 p-4" aria-hidden="true">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3 w-14" />
        </div>
      ))}
    </CardContent>
  ) : error ? (
    <PanelError
      message={statsErrorText(error)}
      retrying={retrying}
      onRetry={onRetry}
    />
  ) : null;

  function body(value: OverviewLeaderboardTab) {
    if (pendingBody) return pendingBody;

    const count =
      value === "node"
        ? nodeRows.length
        : value === "user"
          ? userRows.length
          : serverRows.length;
    if (count === 0) {
      const Icon =
        value === "node"
          ? NetworkIcon
          : value === "user"
            ? UsersIcon
            : ServerIcon;
      return (
        <EmptyState
          size="sm"
          icon={Icon}
          title={t(overviewLeaderboardEmptyKey(value))}
          className="py-10"
        />
      );
    }

    return (
      <CardContent className="flex flex-1 flex-col p-2">
        <ul className="flex flex-1 flex-col gap-0.5">
          {value === "server"
            ? serverRows.map((item, index) => (
                <LeaderboardServerRow
                  key={`${item.name}-${index}`}
                  item={item}
                />
              ))
            : value === "node"
              ? nodeRows.map((node) => (
                  <LeaderboardNodeRow key={node.node_id} node={node} />
                ))
              : userRows.map((user) => (
                  <LeaderboardUserRow key={user.user_id} user={user} />
                ))}
        </ul>
      </CardContent>
    );
  }

  return (
    <Card className={cn("flex flex-col gap-0", className)}>
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setTab(resolveOverviewLeaderboardTab(value))
        }
        className="flex flex-1 flex-col gap-0"
      >
        <CardHeader className="border-b border-border pb-4">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <CardTitle className="text-sm font-medium">
              {t("overview.leaderboardTitle")}
            </CardTitle>
            <TabsList
              aria-label={t("overview.leaderboardTabsAria")}
              className="max-w-full overflow-x-auto"
            >
              <TabsTrigger value="server">
                {t("overview.leaderboardTabServer")}
              </TabsTrigger>
              <TabsTrigger value="node">
                {t("overview.leaderboardTabNode")}
              </TabsTrigger>
              <TabsTrigger value="user">
                {t("overview.leaderboardTabUser")}
              </TabsTrigger>
            </TabsList>
          </div>
        </CardHeader>
        <TabsContent value="server">{body("server")}</TabsContent>
        <TabsContent value="node">{body("node")}</TabsContent>
        <TabsContent value="user">{body("user")}</TabsContent>
      </Tabs>
    </Card>
  );
}

/**
 * 趋势卡：同一张卡内切换「总流量」与「协议」。
 * 两套数据分别由 traffic / aggregate 查询提供，进页面时都已加载；
 * 切换只切视图，不触发 refetch。
 */
function TrendCard({
  trafficDays,
  trafficTotal,
  trafficPending,
  trafficError,
  trafficFetching,
  onTrafficRetry,
  series,
  aggregatePending,
  aggregateError,
  aggregateFetching,
  onAggregateRetry,
}: {
  trafficDays: TrafficDay[] | undefined;
  trafficTotal: number | null;
  trafficPending: boolean;
  trafficError: unknown;
  trafficFetching: boolean;
  onTrafficRetry: () => void;
  series: OverviewProtocolSeries[] | undefined;
  aggregatePending: boolean;
  aggregateError: unknown;
  aggregateFetching: boolean;
  onAggregateRetry: () => void;
}) {
  const [tab, setTab] = useState<OverviewTrendTab>(
    DEFAULT_OVERVIEW_TREND_TAB,
  );

  return (
    <Card className="flex flex-col gap-0">
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(resolveOverviewTrendTab(value))}
        className="flex flex-1 flex-col gap-0"
      >
        <CardHeader className="border-b border-border pb-4">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <CardTitle className="text-sm font-medium">
                {t("overview.trendTitle")}
              </CardTitle>
              <CardDescription className="mt-1 text-xs">
                {t("overview.trafficTrendDesc")}
              </CardDescription>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:w-full">
              <TabsList
                aria-label={t("overview.trendTabsAria")}
                className="max-w-full overflow-x-auto"
              >
                <TabsTrigger value="traffic">
                  {t("overview.trendTabTraffic")}
                </TabsTrigger>
                <TabsTrigger value="protocol">
                  {t("overview.trendTabProtocol")}
                </TabsTrigger>
              </TabsList>
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
            </div>
          </div>
        </CardHeader>
        <TabsContent value="traffic" className="p-4">
          {trafficPending ? (
            <Skeleton className="h-[248px] w-full" />
          ) : trafficError ? (
            <div className="flex h-[248px] items-center justify-center">
              <ListError
                title={t("overview.trafficLoadFailed")}
                message={statsErrorText(trafficError)}
                retrying={trafficFetching}
                onRetry={onTrafficRetry}
              />
            </div>
          ) : (
            <Suspense fallback={<Skeleton className="h-[248px] w-full" />}>
              <TrafficChart days={trafficDays ?? []} />
            </Suspense>
          )}
        </TabsContent>
        <TabsContent value="protocol" className="p-4">
          {aggregatePending ? (
            <Skeleton className="h-[248px] w-full" />
          ) : aggregateError ? (
            <PanelError
              message={statsErrorText(aggregateError)}
              retrying={aggregateFetching}
              onRetry={onAggregateRetry}
            />
          ) : (
            <Suspense fallback={<Skeleton className="h-[248px] w-full" />}>
              <ProtocolTrendChart series={series ?? []} />
            </Suspense>
          )}
        </TabsContent>
      </Tabs>
    </Card>
  );
}

/** 转发链健康卡的状态样式；阻断用 destructive，降级用 warning，与链列表一致。 */

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
  /** 数字来自全站 stats / 全局 chains，不随服务器筛选变化。 */
  sitewide?: boolean;
}

function AlertRow({
  to,
  icon: Icon,
  label,
  count,
  hint,
  tone,
  action,
  sitewide,
  onNavigate,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  count: number;
  hint: string;
  tone: AlertTone;
  /** 数字来自全站 stats / 全局 chains，不随服务器筛选变化。 */
  sitewide?: boolean;
  /** 行尾的批量操作入口；按钮不能嵌在 Link 里，所以单独作为兄弟节点。 */
  action?: ReactNode;
  /** 在弹窗里点击后关掉弹窗。 */
  onNavigate?: () => void;
}) {
  const active = count > 0;

  return (
    <div className="group flex items-center rounded-md transition-colors duration-150 hover:bg-muted/40 has-[a:active]:bg-muted/60">
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
              "flex min-w-0 items-center gap-1.5 text-sm",
              !active && "text-muted-foreground",
            )}
          >
            <span className="truncate">{label}</span>
            {sitewide ? (
              <span
                data-alert-sitewide
                className="shrink-0 rounded-sm bg-muted px-1 py-0.5 text-[11px] leading-none text-muted-foreground"
              >
                {t("overview.scope.sitewide")}
              </span>
            ) : null}
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
        <ChevronRightIcon className="icon-sm text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-has-[a:focus-visible]:translate-x-0.5" />
      </Link>
      {action ? <div className="shrink-0 pr-1.5">{action}</div> : null}
    </div>
  );
}


/**
 * 「流量」tab：原概览的趋势 / 分布 / 排行 / 告警整体搬到这里。
 *
 * 服务器筛选通过 `server_ids` 交给后端聚合；旧主控不认识该参数时
 * 响应不带 `scope`，这里只提示「需新版本主控」并继续展示全量数据，
 * 绝不把缺失的筛选结果画成 0。
 */
export default function TrafficView({
  stats,
  selectedIds,
  filtered,
}: {
  stats: OverviewStats;
  selectedIds: readonly string[];
  filtered: boolean;
}) {
  useI18n();
  // 全选等价于「不筛选」：不把整份 id 列表塞进 URL/查询参数。
  const aggregate = useOverview(
    OVERVIEW_TRAFFIC_DAYS,
    filtered ? selectedIds : [],
    selectedIds.length > 0,
  );
  const traffic = useTraffic(OVERVIEW_TRAFFIC_DAYS);
  const events = useEnforcementEvents(50);
  const recentRemoved =
    events.data?.filter((event) => event.kind === "removed").length ?? 0;

  const scopeFiltered = filtered && selectedIds.length > 0;
  const aggregateScope = aggregate.data?.scope ?? null;
  const scopeReady = aggregateScope?.filtered === true;
  // `scope.global` 明确说明 `global` / `chains` 是全局口径；旧主控不返回
  // scope 时按「未筛选」处理，同样标成全站，绝不把它伪装成选中范围。
  const aggregateGlobal =
    scopeFiltered && (aggregateScope?.global === true || aggregateScope === null);
  // 后端应用了 server_ids 后，趋势图用同一份过滤后的 series，避免 KPI 已缩小
  // 而图表仍是全站数字；旧主控（无 scope）继续用 /stats/traffic 的全量值。
  const trendDays =
    scopeFiltered && scopeReady
      ? (aggregate.data?.series ?? []).map((point) => ({
          date: point.day,
          uplink: point.uplink,
          downlink: point.downlink,
          weighted: point.uplink + point.downlink,
        }))
      : traffic.data?.days;
  const trafficTotal =
    trendDays?.reduce((sum, day) => sum + day.weighted, 0) ?? null;
  const chainAlerts = visibleAlerts(aggregate.data?.chains);
  const chainAlertTotal = chainAlerts.reduce(
    (sum, alert) => sum + alert.count,
    0,
  );
  const expiringCerts = stats.alerts.expiring_certs ?? 0;
  const alertTotal =
    stats.alerts.expired_instances +
    stats.alerts.exhausted_instances +
    stats.alerts.offline_servers +
    expiringCerts +
    chainAlertTotal;

  const [allAlertsOpen, setAllAlertsOpen] = useState(false);
  const [renewOpen, setRenewOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const alertItems: AlertItem[] = [
    {
      key: "expired",
      to: "/users",
      icon: ClockIcon,
      label: t("overview.expiredInstances"),
      count: stats.alerts.expired_instances,
      hint: t("overview.expiredHint"),
      tone: "warning",
      sitewide: scopeFiltered,
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
      sitewide: scopeFiltered,
      action: (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setAllAlertsOpen(false);
            setDisableOpen(true);
          }}
        >
          <PowerIcon />
          {t("overview.disableAction")}
        </Button>
      ),
    },
    {
      key: "offline",
      to: "/servers",
      icon: ServerOffIcon,
      label: t("overview.offlineServers"),
      count: stats.alerts.offline_servers,
      hint: t("overview.offlineHint"),
      tone: "destructive",
      sitewide: scopeFiltered,
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
            sitewide: scopeFiltered,
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
      sitewide: aggregateGlobal,
    })),
  ];
  const previewAlerts = alertItems.slice(0, ALERT_PREVIEW);
  const hiddenAlertCount = alertItems.length - previewAlerts.length;

  const scopeUnsupported =
    scopeFiltered &&
    aggregate.isSuccess &&
    aggregate.data?.scope?.filtered !== true;
  const trafficPending = scopeFiltered && scopeReady ? false : traffic.isPending;
  const trafficFailed = scopeFiltered && scopeReady ? false : traffic.isError;
  const trafficError = scopeFiltered && aggregate.isError
    ? aggregate.error
    : traffic.isError
      ? traffic.error
      : null;
  const pending = trafficPending || aggregate.isPending;
  const bothFailed = trafficFailed && aggregate.isError;
  const noData =
    !pending &&
    !bothFailed &&
    (trendDays?.length ?? 0) === 0 &&
    (aggregate.data?.protocols.length ?? 0) === 0 &&
    (aggregate.data?.top.length ?? 0) === 0 &&
    alertTotal === 0 &&
    recentRemoved === 0;

  if (selectedIds.length === 0) return <TrafficEmptyScope />;
  if (pending) return <TrafficSkeleton />;
  if (bothFailed) {
    return (
      <Card>
        <CardContent>
          <ListError
            title={t("overview.loadFailed")}
            message={statsErrorText(aggregate.error ?? traffic.error)}
            retrying={traffic.isFetching || aggregate.isFetching}
            onRetry={() => {
              void traffic.refetch();
              void aggregate.refetch();
            }}
          />
        </CardContent>
      </Card>
    );
  }
  if (noData) return <TrafficEmpty />;

  return (
    <div className="space-y-4" data-traffic-view>
      {scopeUnsupported ? (
        <div
          data-traffic-scope-warning
          className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-normal text-warning"
        >
          <TriangleAlertIcon
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span>{t("overview.scope.trafficNeedsUpgrade")}</span>
        </div>
      ) : null}
      <section className="grid gap-4">
        <TrendCard
          trafficDays={trendDays}
          trafficTotal={trafficTotal}
          trafficPending={trafficPending}
          trafficError={trafficError}
          trafficFetching={traffic.isFetching || aggregate.isFetching}
          onTrafficRetry={() => void traffic.refetch()}
          series={aggregate.data?.protocol_series}
          aggregatePending={aggregate.isPending}
          aggregateError={aggregate.isError ? aggregate.error : null}
          aggregateFetching={aggregate.isFetching}
          onAggregateRetry={() => void aggregate.refetch()}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <DistributionCard
          protocols={aggregate.data?.protocols}
          packages={aggregate.data?.package_split}
          isPending={aggregate.isPending}
          error={aggregate.isError ? aggregate.error : null}
          retrying={aggregate.isFetching}
          onRetry={() => void aggregate.refetch()}
        />
        <LeaderboardCard
          items={aggregate.data?.top}
          users={aggregate.data?.top_users}
          nodes={aggregate.data?.top_nodes}
          isPending={aggregate.isPending}
          error={aggregate.isError ? aggregate.error : null}
          retrying={aggregate.isFetching}
          onRetry={() => void aggregate.refetch()}
          className="xl:col-span-2"
        />
      </section>

      <Card className="gap-0">
        <CardHeader className="border-b border-border pb-4">
          <CardTitle className="text-sm font-medium">
            {t("overview.alerts")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("overview.alertsDesc")}
          </CardDescription>
          <CardAction>
            <div className="flex items-center gap-1.5">
              {scopeFiltered ? (
                <Badge
                  data-alert-card-sitewide
                  variant="outline"
                  className="font-normal text-muted-foreground"
                >
                  {t("overview.scope.sitewide")}
                </Badge>
              ) : null}
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
            </div>
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
              sitewide={alert.sitewide}
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

      <Dialog open={allAlertsOpen} onOpenChange={setAllAlertsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("overview.alertsAllTitle")}</DialogTitle>
            <DialogDescription>
              {t("overview.pendingCount", { n: alertTotal })}
            </DialogDescription>
          </DialogHeader>
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
                sitewide={alert.sitewide}
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
          expiredCount={stats.alerts.expired_instances}
        />
      ) : null}
      {disableOpen ? (
        <BatchDisableDialog open onOpenChange={setDisableOpen} />
      ) : null}
      {cleanupOpen ? (
        <CleanupEventsDialog open onOpenChange={setCleanupOpen} />
      ) : null}
    </div>
  );
}

function TrafficSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <SkeletonCard lines={5} />
      <section className="grid gap-4 xl:grid-cols-3">
        <SkeletonCard lines={4} />
        <SkeletonCard lines={5} className="xl:col-span-2" />
      </section>
      <SkeletonCard lines={4} />
    </div>
  );
}

function TrafficEmptyScope() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          size="sm"
          icon={ServerOffIcon}
          title={t("overview.scope.emptyTitle")}
          description={t("overview.scope.emptyDesc")}
          className="py-16"
        />
      </CardContent>
    </Card>
  );
}

function TrafficEmpty() {
  return (
    <Card>
      <CardContent>
        <EmptyState
          tone="primary"
          icon={ActivityIcon}
          title={t("overview.trafficEmptyTitle")}
          description={t("overview.trafficEmptyDesc")}
          className="py-16"
          action={
            <Button asChild>
              <Link to="/servers">{t("overview.trafficEmptyAction")}</Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
