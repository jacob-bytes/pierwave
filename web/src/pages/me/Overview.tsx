import { lazy, Suspense, useState } from "react";
import { RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { meErrorText } from "@/lib/meError";
import { useMeShellSummary } from "@/lib/meShell";
import { ChangePasswordDialog } from "@/components/settings/ChangePasswordDialog";
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
import type { MeTraffic } from "@/lib/api";
import { formatBytes, usagePercent } from "@/lib/format";
import { dailyAverage, daysTone, trafficTone } from "@/lib/meOverview";
import { useMeTraffic } from "@/lib/queries";
import { cn } from "@/lib/utils";
import type { OverviewCardProps } from "@/components/me/overview/types";
import OverviewCardA from "@/components/me/overview/OverviewCardA";
import { t, useI18n } from "@/i18n";

/** recharts 仍然只通过 lazy() 加载，不会进入主 chunk。 */
const TrafficChart = lazy(() => import("@/components/overview/TrafficChart"));
const TrafficLegend = lazy(() =>
  import("@/components/overview/TrafficChart").then((m) => ({
    default: m.TrafficLegend,
  })),
);

const TRAFFIC_DAYS = 7;

function TrafficCard({ traffic }: { traffic: UseQueryResult<MeTraffic> }) {
  useI18n();
  const total =
    traffic.data?.days.reduce((sum, day) => sum + day.weighted, 0) ?? null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          {t("me.traffic.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("me.traffic.desc")}
        </CardDescription>
        <CardAction>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Suspense fallback={null}>
            <TrafficLegend showCumulative />
          </Suspense>
          <span
            className={cn(
              "inline-flex items-center rounded-full border border-border px-2 py-0.5 font-mono type-micro font-normal text-muted-foreground tabular-nums",
            )}
          >
            {total === null
              ? "—"
              : t("me.traffic.total", { value: formatBytes(total) })}
          </span>
          </div>
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
              <p className="text-sm font-medium">{t("me.traffic.loadFailed")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {meErrorText(traffic.error, t("me.traffic.loadError"))}
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
              {t("common.retry")}
            </Button>
          </div>
        ) : (
          <Suspense fallback={<Skeleton className="h-[248px] w-full" />}>
            <TrafficChart days={traffic.data?.days ?? []} showLegend={false} />
          </Suspense>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 概览：只展示数据卡片（环形指标 + 流量趋势），不放任何快捷操作。
 * 复制订阅 / 转发入口分别在各自的标签页；这里只保留次要的账号与改密入口。
 */
export default function MeOverviewPage() {
  useI18n();
  const summary = useMeShellSummary();
  const traffic = useMeTraffic(TRAFFIC_DAYS);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const { package: plan, usage } = summary;
  const limit = plan?.traffic_limit ?? null;
  const unlimited = limit === null || limit <= 0;
  const overQuota = !unlimited && usage.used_bytes >= limit;
  const usedPercent = unlimited
    ? null
    : usagePercent(usage.used_bytes, limit);
  const remainingTone = trafficTone(usage.remaining_bytes, limit);
  const expiryTone = daysTone(usage.days_left);

  const cardProps: Omit<
    OverviewCardProps,
    "username" | "onChangePassword"
  > = {
    plan,
    usage,
    overQuota,
    usedPercent,
    remainingTone,
    expiryTone,
    // 今日计费流量由 summary 直接给出；拿不到就隐藏该项，不画占位 0。
    todayBytes: Number.isFinite(summary.traffic.today_bytes)
      ? summary.traffic.today_bytes
      : null,
    // 日均来自页面已请求的 7 天趋势；未加载 / 查询失败时为 null。
    dailyAverageBytes: dailyAverage(traffic.data?.days),
  };

  return (
    <div className="space-y-4">
      <OverviewCardA
        {...cardProps}
        username={summary.user.username}
        onChangePassword={() => setPasswordOpen(true)}
      />

      <TrafficCard traffic={traffic} />

      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
      />
    </div>
  );
}
