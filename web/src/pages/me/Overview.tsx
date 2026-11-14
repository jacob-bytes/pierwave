import { lazy, Suspense, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  ArrowRightLeftIcon,
  CalendarClockIcon,
  ChevronDownIcon,
  CopyIcon,
  GaugeIcon,
  KeyRoundIcon,
  PackageIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { meErrorText } from "@/lib/meError";
import { useMeShellSummary } from "@/lib/meShell";
import { ChangePasswordDialog } from "@/components/settings/ChangePasswordDialog";
import { UsageBar, UsageTrack } from "@/components/UsageBar";
import { EmptyState } from "@/components/common";
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
import { copyText } from "@/lib/clipboard";
import { formatBytes, usagePercent } from "@/lib/format";
import {
  OVERVIEW_BAR_TONE,
  OVERVIEW_TEXT_CLASS,
  daysTone,
  trafficTone,
} from "@/lib/meOverview";
import { subscriptionUrl } from "@/lib/meSubscription";
import { useMeTraffic } from "@/lib/queries";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** recharts 仍然只通过 lazy() 加载，不会进入主 chunk。 */
const TrafficChart = lazy(() => import("@/components/overview/TrafficChart"));

const TRAFFIC_DAYS = 7;

function Metric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  icon: LucideIcon;
}) {
  return (
    <div className="rounded-lg bg-muted/40 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1 text-base leading-tight font-medium tracking-tight tabular-nums">
        {value}
      </div>
    </div>
  );
}

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
          <span
            className={cn(
              "inline-flex items-center rounded-full border border-border px-2 py-0.5 font-mono type-micro font-normal text-muted-foreground tabular-nums",
            )}
          >
            {total === null
              ? "—"
              : t("me.traffic.total", { value: formatBytes(total) })}
          </span>
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
            <TrafficChart days={traffic.data?.days ?? []} />
          </Suspense>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 概览：只看两个关键数字（剩余流量 / 到期），其余细节收进「更多信息」。
 * 不重复堆卡片，避免变成第二个仪表盘。
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
  const daysLeft =
    usage.days_left === null
      ? t("me.overview.longTerm")
      : t("me.overview.days", { n: usage.days_left });

  async function handleCopy() {
    if (await copyText(subscriptionUrl(summary))) {
      toast.success(t("me.subscription.copied"));
    } else {
      toast.error(t("me.subscription.copyError"));
    }
  }

  return (
    <div className="space-y-4">
      <Card className="gap-4">
        <CardContent>
          {!plan ? (
            <EmptyState
              icon={PackageIcon}
              title={t("me.overview.noPackage")}
              description={t("me.overview.noPackageDesc")}
            />
          ) : (
            <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col">
                <p className="text-xs text-muted-foreground">
                  {t("me.overview.remainingTraffic")}
                </p>
                <p
                  className={cn(
                    "mt-1.5 text-4xl leading-none font-semibold tracking-tight tabular-nums",
                    OVERVIEW_TEXT_CLASS[remainingTone],
                  )}
                >
                  {usage.remaining_bytes === null
                    ? t("me.overview.unlimited")
                    : formatBytes(usage.remaining_bytes)}
                </p>
                <div className="mt-auto flex items-center gap-3 pt-3">
                  {usedPercent === null ? null : (
                    <UsageTrack
                      percent={usedPercent}
                      tone={OVERVIEW_BAR_TONE[remainingTone]}
                      label={t("me.overview.usage")}
                      className="min-w-0 flex-1"
                    />
                  )}
                  <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                    {t("me.overview.used")} {formatBytes(usage.used_bytes)} /{" "}
                    {formatBytes(limit, { zeroAsUnlimited: true })}
                  </span>
                </div>
              </div>
              <div className="flex min-w-0 flex-col sm:text-right">
                <p className="text-xs text-muted-foreground">
                  {t("me.overview.expiresAt")}
                </p>
                <p
                  className={cn(
                    "mt-1.5 text-3xl leading-none font-semibold tracking-tight tabular-nums",
                    OVERVIEW_TEXT_CLASS[expiryTone],
                  )}
                >
                  {daysLeft}
                </p>
                {plan.expires_at !== null ? (
                  <p className="mt-auto pt-3 text-xs text-muted-foreground tabular-nums">
                    {formatDate(plan.expires_at)}
                  </p>
                ) : null}
              </div>
              {overQuota ? (
                <p className="flex items-center gap-1.5 text-xs text-warning sm:col-span-2">
                  <TriangleAlertIcon className="size-3.5" />
                  {t("me.overview.overQuota")}
                </p>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={() => void handleCopy()}>
          <CopyIcon className="size-3.5" />
          {t("me.overview.quickCopy")}
        </Button>
        <Button variant="outline" asChild>
          <Link to="/me/forwards">
            <ArrowRightLeftIcon className="size-3.5" />
            {t("me.overview.quickForwards")}
          </Link>
        </Button>
      </div>

      <TrafficCard traffic={traffic} />

      <details className="group rounded-xl border border-border bg-card">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span>{t("me.overview.more")}</span>
          <ChevronDownIcon className="size-4 text-muted-foreground transition-transform duration-150 group-open:rotate-180" />
        </summary>
        <div className="space-y-4 border-t border-border px-4 py-4">
          {plan ? (
            <>
              <UsageBar
                usedBytes={usage.used_bytes}
                quotaBytes={limit}
                zeroAsUnlimited
                overTone="warning"
                label={t("me.overview.usage")}
              />
              <div className="grid gap-2 sm:grid-cols-3">
                <Metric
                  icon={ActivityIcon}
                  label={t("me.overview.used")}
                  value={formatBytes(usage.used_bytes)}
                />
                <Metric
                  icon={GaugeIcon}
                  label={t("me.overview.remaining")}
                  value={
                    usage.remaining_bytes === null
                      ? t("me.overview.unlimited")
                      : formatBytes(usage.remaining_bytes)
                  }
                />
                <Metric
                  icon={CalendarClockIcon}
                  label={t("me.overview.daysLeft")}
                  value={
                    usage.days_left === null
                      ? t("me.overview.longTerm")
                      : t("me.overview.days", { n: usage.days_left })
                  }
                />
              </div>
            </>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              {t("me.currentAccount")}{" "}
              <span className="font-mono text-foreground/80">
                {summary.user.username}
              </span>
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPasswordOpen(true)}
            >
              <KeyRoundIcon className="size-3.5" />
              {t("me.changePassword")}
            </Button>
          </div>
        </div>
      </details>

      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
      />
    </div>
  );
}
