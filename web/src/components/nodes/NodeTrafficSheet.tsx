import { lazy, Suspense } from "react";
import {
  ActivityIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ApiError,
  type Node,
  type NodeTrafficDetail,
  type NodeTrafficUser,
} from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { nodeSummary } from "@/lib/protocols";
import { useNodeTrafficDetail } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const DETAIL_DAYS = 30;
const TOP_USERS = 10;

/**
 * recharts 体积较大，仍按需加载：这个 Sheet 由节点页 `lazy()` 引入，
 * 图表再单独拆一个 chunk，节点列表的同步依赖里没有 recharts。
 */
const TrafficChart = lazy(
  () => import("@/components/overview/TrafficChart"),
);

interface NodeTrafficSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: Node;
  /** 服务器列表里的名称；详情接口回来之前先用它填头部。 */
  serverName?: string;
}

/** 流量为 0 时统一显示破折号，避免一屏「0 B」。 */
function trafficAmount(value: number): string {
  return value > 0 ? formatBytes(value) : "—";
}

/** 后端接口可能尚未上线，404 单独给一句可理解的中文。 */
function trafficErrorText(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return t("nodes.traffic.notReady");
  }
  return errorText(error, t("nodes.traffic.loadError"));
}

function hasAnyTraffic(detail: NodeTrafficDetail): boolean {
  return (
    detail.node.weighted > 0 ||
    detail.node.today_bytes > 0 ||
    detail.node.month_bytes > 0 ||
    detail.days.some(
      (day) => day.uplink > 0 || day.downlink > 0 || day.weighted > 0,
    ) ||
    detail.users.some(
      (user) => user.uplink > 0 || user.downlink > 0 || user.weighted > 0,
    )
  );
}

function TrafficKpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card size="sm" className="gap-1 px-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg leading-tight font-medium tracking-tight tabular-nums">
        {value}
      </p>
      {hint ? (
        <p className="type-micro text-muted-foreground">{hint}</p>
      ) : null}
    </Card>
  );
}

function TrafficSheetSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((index) => (
          <Card key={index} size="sm" className="gap-2 px-4">
            <Skeleton className="h-3 w-10" />
            <Skeleton className="h-5 w-16" />
          </Card>
        ))}
      </div>
      <Card className="gap-3 p-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-3 w-52" />
        <Skeleton className="h-[248px] w-full" />
      </Card>
      <Card className="gap-3 p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3 w-44" />
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </Card>
    </div>
  );
}

function TrafficError({
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
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
          <TriangleAlertIcon className="size-5" />
        </div>
        <div>
          <p className="text-sm font-medium">{t("nodes.traffic.loadFailed")}</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            {message}
          </p>
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
          {t("common.retry")}
        </Button>
      </CardContent>
    </Card>
  );
}

function TrafficEmpty({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
        <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <ActivityIcon className="size-5" />
        </div>
        <div>
          <p className="text-sm font-medium">{t("nodes.traffic.emptyTitle")}</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
            {t("nodes.traffic.emptyDesc")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCwIcon
            className={cn("size-3.5", refreshing && "animate-spin")}
          />
          {t("common.refresh")}
        </Button>
      </CardContent>
    </Card>
  );
}

function TopUsersTable({ users }: { users: NodeTrafficUser[] }) {
  const rows = [...users]
    .sort((a, b) => b.weighted - a.weighted)
    .slice(0, TOP_USERS);

  return (
    <Card className="gap-0 overflow-hidden">
      <CardHeader className="border-b border-border">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {t("nodes.traffic.topUsers")}
          <Badge
            variant="secondary"
            className="font-mono type-micro font-normal text-muted-foreground"
          >
            {rows.length}
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs">
          {t("nodes.traffic.topUsersDesc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <div className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground">
              <UsersIcon className="size-4" />
            </div>
            <p className="text-sm font-medium">
              {t("nodes.traffic.emptyUsers")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("nodes.traffic.emptyUsersDesc")}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground">
                  {t("nodes.traffic.userColumn")}
                </TableHead>
                <TableHead className="h-9 px-4 text-right text-xs font-medium tracking-wide text-muted-foreground">
                  {t("trafficChart.downlink")}
                </TableHead>
                <TableHead className="h-9 px-4 text-right text-xs font-medium tracking-wide text-muted-foreground">
                  {t("trafficChart.uplink")}
                </TableHead>
                <TableHead className="h-9 px-4 text-right text-xs font-medium tracking-wide text-muted-foreground">
                  {t("nodes.traffic.weighted")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((user, index) => (
                <TableRow key={`${user.user_id}-${index}`}>
                  <TableCell className="max-w-48 px-4 py-2.5">
                    <div
                      className="truncate text-sm"
                      title={user.user_id || undefined}
                    >
                      {user.username || t("common.none")}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {trafficAmount(user.downlink)}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {trafficAmount(user.uplink)}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-right font-mono text-xs tabular-nums">
                    {trafficAmount(user.weighted)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function NodeTrafficSheet({
  open,
  onOpenChange,
  node,
  serverName,
}: NodeTrafficSheetProps) {
  useI18n();
  const detail = useNodeTrafficDetail(node.id, DETAIL_DAYS, TOP_USERS);
  const data = detail.data;
  const serverLabel =
    data?.node.server_name || serverName || t("nodes.unknownServer");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate">{node.name}</span>
            <Badge
              variant="secondary"
              className="font-normal text-muted-foreground"
            >
              {t("nodes.traffic.title")}
            </Badge>
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="font-mono text-xs">
              {nodeSummary(node.protocol, node.transport, node.security)}
            </span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{serverLabel}</span>
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4">
          {detail.isPending ? (
            <TrafficSheetSkeleton />
          ) : detail.isError ? (
            <TrafficError
              message={trafficErrorText(detail.error)}
              retrying={detail.isFetching}
              onRetry={() => void detail.refetch()}
            />
          ) : data ? (
            hasAnyTraffic(data) ? (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  <TrafficKpi
                    label={t("nodes.traffic.today")}
                    value={trafficAmount(data.node.today_bytes)}
                  />
                  <TrafficKpi
                    label={t("nodes.traffic.thisMonth")}
                    value={trafficAmount(data.node.month_bytes)}
                  />
                  <TrafficKpi
                    label={t("nodes.traffic.last30")}
                    value={trafficAmount(data.node.weighted)}
                    hint={t("nodes.traffic.last30Hint")}
                  />
                </div>

                <Card className="gap-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium">
                        {t("nodes.traffic.trendTitle")}
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("nodes.traffic.trendDesc")}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className="font-mono type-micro font-normal text-muted-foreground"
                    >
                      {t("nodes.traffic.trendTotal", {
                        value: formatBytes(data.node.weighted),
                      })}
                    </Badge>
                  </div>
                  <Suspense fallback={<Skeleton className="h-[248px] w-full" />}>
                    <TrafficChart days={data.days} />
                  </Suspense>
                </Card>

                <TopUsersTable users={data.users} />
              </div>
            ) : (
              <TrafficEmpty
                refreshing={detail.isFetching}
                onRefresh={() => void detail.refetch()}
              />
            )
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
