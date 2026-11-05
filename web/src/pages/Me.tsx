import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  CalendarClockIcon,
  CalendarIcon,
  CopyIcon,
  InfoIcon,
  KeyRoundIcon,
  Link2Icon,
  PackageIcon,
  QrCodeIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import { PackageStatusBadge } from "@/components/packages/PackageStatusBadge";
import {
  statusToneClasses,
  type PackageStatusTone,
} from "@/components/packages/packageTone";
import { ChangePasswordDialog } from "@/components/settings/ChangePasswordDialog";
import { SubscriptionQrDialog } from "@/components/subscriptions/SubscriptionQrDialog";
import { UsageBar } from "@/components/UsageBar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import {
  ApiError,
  type MeSummary,
  type MeTraffic,
  type UserPackageStatus,
  type UserPackageView,
} from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { directionLabel, packageStatusTone } from "@/lib/labels";
import { useMeSummary, useMeTraffic } from "@/lib/queries";
import { formatDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** recharts 仍然只通过 lazy() 加载，不会进入主 chunk。 */
const TrafficChart = lazy(() => import("@/components/overview/TrafficChart"));

const TRAFFIC_DAYS = 7;

/** 自助接口与后端并行开发，404 给一句能看懂的中文，不写 mock。 */
function meErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 404) {
    return t("me.apiNotReady");
  }
  return errorText(error, fallback);
}

type MeStatus = UserPackageStatus | "none" | "quota_exceeded";

const statusMeta: Record<
  MeStatus,
  { labelKey: string; tone: PackageStatusTone }
> = {
  active: { labelKey: "me.status.active", tone: "primary" },
  exhausted: { labelKey: "me.status.exhausted", tone: "destructive" },
  expired: { labelKey: "me.status.expired", tone: "warning" },
  disabled: { labelKey: "me.status.disabled", tone: "muted" },
  none: { labelKey: "me.status.none", tone: "muted" },
  /** 账户级总闸命中；与单卡「已用尽」用不同文案区分。 */
  quota_exceeded: { labelKey: "me.status.quotaExceeded", tone: "destructive" },
};

/** 多张卡取最严重者：用尽 > 过期 > 生效中 > 全部停用 > 无套餐。 */
function overallStatus(packages: UserPackageView[]): MeStatus {
  if (packages.some((item) => item.status === "exhausted")) return "exhausted";
  if (packages.some((item) => item.status === "expired")) return "expired";
  if (packages.some((item) => item.status === "active")) return "active";
  if (packages.length === 0) return "none";
  return "disabled";
}

function MeStatusBadge({ status }: { status: MeStatus }) {
  const meta = statusMeta[status];
  return (
    <Badge
      variant="outline"
      className={cn(
        "border-transparent font-normal",
        statusToneClasses[meta.tone],
      )}
    >
      {t(meta.labelKey)}
    </Badge>
  );
}

const packageCardTone: Record<PackageStatusTone, string> = {
  primary: "ring-primary/30",
  warning: "ring-warning/30",
  destructive: "ring-destructive/30",
  muted: "ring-border",
};

function StatusAlerts({
  packages,
  quotaExceeded,
}: {
  packages: UserPackageView[];
  quotaExceeded: boolean;
}) {
  // 账户级总额度是总闸：命中时全站停用，只留这一条，不再叠单卡提示。
  if (quotaExceeded) {
    return (
      <Alert
        variant="destructive"
        className="border-destructive/25 bg-destructive/10"
      >
        <TriangleAlertIcon />
        <AlertTitle>{t("me.alerts.quotaExceededTitle")}</AlertTitle>
        <AlertDescription className="text-destructive/90">
          {t("me.alerts.quotaExceededDesc")}
        </AlertDescription>
      </Alert>
    );
  }

  const exhausted = packages.some((item) => item.status === "exhausted");
  const expired = packages.some((item) => item.status === "expired");
  if (!exhausted && !expired) return null;

  return (
    <div className="space-y-3">
      {exhausted ? (
        <Alert
          variant="destructive"
          className="border-destructive/25 bg-destructive/10"
        >
          <TriangleAlertIcon />
          <AlertTitle>{t("me.alerts.exhaustedTitle")}</AlertTitle>
          <AlertDescription className="text-destructive/90">
            {t("me.alerts.exhaustedDesc")}
          </AlertDescription>
        </Alert>
      ) : null}
      {expired ? (
        <Alert className="border-warning/25 bg-warning/10 text-warning">
          <CalendarClockIcon />
          <AlertTitle>{t("me.alerts.expiredTitle")}</AlertTitle>
          <AlertDescription className="text-warning/90">
            {t("me.alerts.expiredDesc")}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function MetricCard({
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

function PackageCard({ item }: { item: UserPackageView }) {
  const tone = packageStatusTone(item.status);

  return (
    <Card className={cn("gap-3 ring-1", packageCardTone[tone])}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm font-medium">
              {item.package_name}
            </CardTitle>
            <CardDescription className="mt-1 text-xs">
              {directionLabel(item.direction)} ·{" "}
              {t("me.package.ratio", { ratio: item.node_ratio })}
            </CardDescription>
          </div>
          <PackageStatusBadge status={item.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* zeroAsUnlimited：quota_override=0 是显式不限，不画进度条。 */}
        <UsageBar
          usedBytes={item.used_bytes}
          quotaBytes={item.quota_override === 0 ? 0 : item.quota_bytes}
          zeroAsUnlimited
        />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <CalendarIcon className="size-3.5" />
            {t("me.package.expires")}
            <span className="text-foreground/80">
              {item.expires_at
                ? formatDate(item.expires_at)
                : t("common.longTermValid")}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <RefreshCwIcon className="size-3.5" />
            {t("me.package.reset")}
            <span className="text-foreground/80">
              {item.reset_day
                ? t("me.package.resetMonthly", { day: item.reset_day })
                : t("me.package.noReset")}
            </span>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function MeSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Card key={index} size="sm" className="gap-3">
            <CardHeader>
              <Skeleton className="h-3 w-20" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-7 w-24" />
              <Skeleton className="h-3 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1].map((index) => (
          <Card key={index} className="gap-3">
            <CardHeader>
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-1.5 w-full rounded-full" />
              <Skeleton className="h-3 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Skeleton className="h-44 w-full rounded-xl" />
    </div>
  );
}

function MeError({
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
          <p className="text-sm font-medium">{t("me.loadFailed")}</p>
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
          {t("common.retry")}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * 订阅地址是后端可能返回的站内相对路径，二维码与复制都需要绝对 URL。
 */
function absoluteSubscriptionUrl(summary: MeSummary): string {
  const fallback = `${window.location.origin}/api/v1/sub/${encodeURIComponent(
    summary.user.short_code,
  )}`;
  if (!summary.subscription_url) return fallback;

  try {
    return new URL(summary.subscription_url, window.location.origin).toString();
  } catch {
    return fallback;
  }
}

function SubscriptionSection({ summary }: { summary: MeSummary }) {
  const [qrOpen, setQrOpen] = useState(false);
  const url = absoluteSubscriptionUrl(summary);

  async function handleCopy() {
    if (await copyText(url)) {
      toast.success(t("me.subscription.copied"));
    } else {
      toast.error(t("me.subscription.copyError"));
    }
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Link2Icon className="size-4 text-muted-foreground" />
          {t("me.subscription.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("me.subscription.desc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <code
            className="min-w-0 flex-1 truncate rounded-md bg-muted px-2.5 py-2 font-mono text-xs text-muted-foreground"
            title={url}
          >
            {url}
          </code>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void handleCopy()}>
              <CopyIcon className="size-3.5" />
              {t("me.subscription.copy")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setQrOpen(true)}
            >
              <QrCodeIcon className="size-3.5" />
              {t("me.subscription.qr")}
            </Button>
          </div>
        </div>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          {t("me.subscription.hint")}
        </p>
      </CardContent>

      {qrOpen ? (
        <SubscriptionQrDialog
          open={qrOpen}
          onOpenChange={setQrOpen}
          username={summary.user.username}
          url={url}
        />
      ) : null}
    </Card>
  );
}

function TrafficSection({
  traffic,
}: {
  traffic: UseQueryResult<MeTraffic>;
}) {
  const total =
    traffic.data?.days.reduce((sum, day) => sum + day.weighted, 0) ?? null;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-sm font-medium">{t("me.traffic.title")}</CardTitle>
        <CardDescription className="text-xs">
          {t("me.traffic.desc")}
        </CardDescription>
        <CardAction>
          <Badge
            variant="outline"
            className="font-mono text-[11px] font-normal text-muted-foreground"
          >
            {total === null
              ? "—"
              : t("me.traffic.total", { value: formatBytes(total) })}
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

export default function MePage() {
  useI18n();
  const summary = useMeSummary();
  const traffic = useMeTraffic(TRAFFIC_DAYS);
  const { pathname } = useLocation();
  const subscriptionRef = useRef<HTMLDivElement>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);

  // 侧边栏「订阅」指向 /me/subscription，同一页滚动到订阅区。
  useEffect(() => {
    if (pathname !== "/me/subscription" || !summary.data) return;
    subscriptionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [pathname, summary.data]);

  if (summary.isPending) return <MeSkeleton />;

  if (summary.isError) {
    return (
      <MeError
        message={meErrorText(
          summary.error,
          t("me.loadError"),
        )}
        retrying={summary.isFetching}
        onRetry={() => void summary.refetch()}
      />
    );
  }

  if (!summary.data) return null;

  const data = summary.data;
  const packages = data.packages ?? [];
  const status: MeStatus = data.user.quota_exceeded
    ? "quota_exceeded"
    : overallStatus(packages);
  const initial = data.user.username.slice(0, 1).toUpperCase();
  const refreshing = summary.isFetching || traffic.isFetching;

  function refreshAll() {
    void summary.refetch();
    void traffic.refetch();
  }

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar size="lg">
            <AvatarFallback className="bg-primary/15 font-semibold text-primary">
              {initial}
            </AvatarFallback>
          </Avatar>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">
                {data.user.username}
              </h1>
              <MeStatusBadge status={status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("me.shortCode")}{" "}
              <span className="font-mono text-foreground/80">
                {data.user.short_code}
              </span>{" "}
              · {t("me.onlyOwnData")}
            </p>
          </div>
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
          {t("common.refresh")}
        </Button>
      </div>

      <StatusAlerts
        packages={packages}
        quotaExceeded={data.user.quota_exceeded}
      />

      <section className="grid gap-4 sm:grid-cols-3">
        <MetricCard
          label={t("me.todayTraffic")}
          icon={ActivityIcon}
          value={formatBytes(data.traffic.today_bytes)}
          hint={t("me.todayHint")}
        />
        <MetricCard
          label={t("me.monthTraffic")}
          icon={CalendarIcon}
          value={formatBytes(data.traffic.month_bytes)}
          hint={t("me.monthHint")}
        />
        <MetricCard
          label={t("me.packages")}
          icon={PackageIcon}
          value={t("me.packagesValue", { n: packages.length })}
          hint={t("me.packagesHint")}
        />
      </section>

      <section id="packages" className="scroll-mt-6 space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">{t("me.myPackages")}</h2>
          {packages.length > 0 ? (
            <Badge
              variant="secondary"
              className="font-mono text-[11px] font-normal text-muted-foreground"
            >
              {packages.length}
            </Badge>
          ) : null}
        </div>

        {packages.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border px-6 py-10 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
              <PackageIcon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">{t("me.emptyPackages")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("me.emptyPackagesDesc")}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {packages.map((item) => (
              <PackageCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </section>

      <section
        id="subscription"
        ref={subscriptionRef}
        className="scroll-mt-6"
      >
        <SubscriptionSection summary={data} />
      </section>

      <section id="traffic" className="scroll-mt-6">
        <TrafficSection traffic={traffic} />
      </section>

      <section id="account" className="scroll-mt-6">
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheckIcon className="size-4 text-muted-foreground" />
              {t("me.accountSecurity")}
            </CardTitle>
            <CardDescription className="text-xs">
              {t("me.accountSecurityDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {t("me.currentAccount")}{" "}
              <span className="font-mono text-foreground/80">
                {data.user.username}
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
          </CardContent>
        </Card>
      </section>

      <ChangePasswordDialog
        open={passwordOpen}
        onOpenChange={setPasswordOpen}
      />
    </div>
  );
}
