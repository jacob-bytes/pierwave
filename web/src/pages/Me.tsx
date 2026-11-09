import { lazy, Suspense, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  CalendarClockIcon,
  CalendarIcon,
  CopyIcon,
  GaugeIcon,
  HistoryIcon,
  InfoIcon,
  KeyRoundIcon,
  Link2Icon,
  PackageIcon,
  QrCodeIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ServerIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  statusToneClasses,
  type PackageStatusTone,
} from "@/components/packages/packageTone";
import { ChangePasswordDialog } from "@/components/settings/ChangePasswordDialog";
import { SubscriptionQrDialog } from "@/components/subscriptions/SubscriptionQrDialog";
import { UsageBar } from "@/components/UsageBar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ApiError,
  type EnforcementEvent,
  type MeSummary,
  type MeTraffic,
  type UserPackageStatus,
} from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import {
  useMeEvents,
  useMeSummary,
  useMeTraffic,
  useResetSubscription,
} from "@/lib/queries";
import {
  DEFAULT_SUBSCRIPTION_FORMAT,
  SUBSCRIPTION_FORMAT_DESCRIPTIONS,
  SUBSCRIPTION_FORMATS,
  withSubscriptionFormat,
  type SubscriptionFormat,
} from "@/lib/subscriptionFormats";
import {
  formatAbsoluteTime,
  formatDate,
  formatRelativeTime,
} from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** recharts 仍然只通过 lazy() 加载，不会进入主 chunk。 */
const TrafficChart = lazy(() => import("@/components/overview/TrafficChart"));

const TRAFFIC_DAYS = 7;
const EVENTS_LIMIT = 20;

/** 自助接口与后端并行开发，404 给一句能看懂的中文，不写 mock。 */
function meErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 404) {
    return t("me.apiNotReady");
  }
  return errorText(error, fallback);
}

type MeStatus = UserPackageStatus | "none";

const statusMeta: Record<
  MeStatus,
  { labelKey: string; tone: PackageStatusTone }
> = {
  active: { labelKey: "me.status.active", tone: "primary" },
  exhausted: { labelKey: "me.status.exhausted", tone: "destructive" },
  expired: { labelKey: "me.status.expired", tone: "warning" },
  disabled: { labelKey: "me.status.disabled", tone: "muted" },
  none: { labelKey: "me.status.none", tone: "muted" },
};

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

function StatusAlerts({ summary }: { summary: MeSummary }) {
  const { usage, user } = summary;

  // 账户级总额度是总闸：命中时全站停用，只留这一条，不再叠单卡提示。
  if (user.quota_exceeded) {
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

  if (usage.status === "active" || usage.status === "none") return null;

  if (usage.status === "exhausted") {
    return (
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
    );
  }

  if (usage.status === "expired") {
    return (
      <Alert className="border-warning/25 bg-warning/10 text-warning">
        <CalendarClockIcon />
        <AlertTitle>{t("me.alerts.expiredTitle")}</AlertTitle>
        <AlertDescription className="text-warning/90">
          {t("me.alerts.expiredDesc")}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="border-border bg-muted/40">
      <ShieldCheckIcon />
      <AlertTitle>{t("me.alerts.disabledTitle")}</AlertTitle>
      <AlertDescription>{t("me.alerts.disabledDesc")}</AlertDescription>
    </Alert>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

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
      <div className="mt-1 text-base leading-tight font-semibold tracking-tight tabular-nums">
        {value}
      </div>
    </div>
  );
}

function OverviewCard({ summary }: { summary: MeSummary }) {
  const { package: plan, usage } = summary;
  const limit = plan?.traffic_limit ?? null;
  const unlimited = limit === null || limit <= 0;
  const overQuota = !unlimited && usage.used_bytes >= limit;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <GaugeIcon className="size-4 text-muted-foreground" />
          {t("me.overview.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("me.overview.desc")}
        </CardDescription>
        <CardAction>
          <MeStatusBadge status={usage.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {!plan ? (
          <EmptyState
            icon={PackageIcon}
            title={t("me.overview.noPackage")}
            description={t("me.overview.noPackageDesc")}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="min-w-0">
                <div className="text-lg leading-tight font-medium tracking-tight">
                  {plan.name}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CalendarIcon className="size-3.5" />
                  {t("me.overview.expires")}
                  <span className="text-foreground/80">
                    {plan.expires_at
                      ? formatDate(plan.expires_at)
                      : t("common.longTermValid")}
                  </span>
                </div>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                {t("me.overview.trafficLimit")}
                <div className="mt-0.5 font-mono text-sm text-foreground/90">
                  {formatBytes(limit, { zeroAsUnlimited: true })}
                </div>
              </div>
            </div>

            <UsageBar
              usedBytes={usage.used_bytes}
              quotaBytes={limit}
              zeroAsUnlimited
              overTone="warning"
              label={t("me.overview.usage")}
            />
            {overQuota ? (
              <p className="flex items-center gap-1.5 text-xs text-warning">
                <TriangleAlertIcon className="size-3.5" />
                {t("me.overview.overQuota")}
              </p>
            ) : null}

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
        )}
      </CardContent>
    </Card>
  );
}

/** 订阅地址是后端返回的站内相对路径；复制、二维码都要绝对 URL。 */
function absoluteSubscriptionUrl(summary: MeSummary): string {
  const raw = summary.subscription?.url || summary.subscription_url;
  const fallback = `${window.location.origin}/api/v1/sub/${encodeURIComponent(
    summary.user.short_code,
  )}`;
  if (!raw) return fallback;
  try {
    return new URL(raw, window.location.origin).toString();
  } catch {
    return fallback;
  }
}

function SubscriptionCard({
  summary,
  onReset,
}: {
  summary: MeSummary;
  onReset: () => void;
}) {
  const [format, setFormat] = useState<SubscriptionFormat>(
    DEFAULT_SUBSCRIPTION_FORMAT,
  );
  const [qrOpen, setQrOpen] = useState(false);
  const baseUrl = absoluteSubscriptionUrl(summary);
  const url = withSubscriptionFormat(baseUrl, format);

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
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">
              {t("me.subscription.format")}
            </span>
            <Select
              value={format}
              onValueChange={(value) => setFormat(value as SubscriptionFormat)}
            >
              <SelectTrigger
                size="sm"
                className="h-8 w-[150px] text-xs"
                aria-label={t("me.subscription.formatAria")}
                title={t("me.subscription.formatHint")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {SUBSCRIPTION_FORMATS.map((item) => {
                  const description = SUBSCRIPTION_FORMAT_DESCRIPTIONS[item];
                  return (
                    <SelectItem
                      key={item}
                      value={item}
                      className="text-xs"
                      title={description ? t(description) : undefined}
                    >
                      {t(`subscriptions.formats.${item}`)}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("me.subscription.updatedAt", {
              time: formatAbsoluteTime(summary.subscription?.updated_at),
            })}
          </p>
        </div>

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

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
            {t("me.subscription.hint")}
          </p>
          <Button variant="outline" size="sm" onClick={onReset}>
            <RotateCcwIcon className="size-3.5" />
            {t("me.subscription.reset")}
          </Button>
        </div>
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

function NodesCard({ summary }: { summary: MeSummary }) {
  // 断流/过期时授权集合为空：空态文案要说明「恢复后才有」，不能只说「没有套餐」。
  const unavailable = ["exhausted", "expired", "disabled"].includes(
    summary.usage.status,
  );

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ServerIcon className="size-4 text-muted-foreground" />
          {t("me.nodes.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("me.nodes.desc")}
        </CardDescription>
        <CardAction>
          <Badge
            variant="secondary"
            className="font-mono text-micro font-normal text-muted-foreground"
          >
            {summary.nodes.length}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {summary.nodes.length === 0 ? (
          <EmptyState
            icon={ServerIcon}
            title={
              unavailable ? t("me.nodes.unavailable") : t("me.nodes.empty")
            }
            description={
              unavailable
                ? t("me.nodes.unavailableDesc")
                : t("me.nodes.emptyDesc")
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {summary.nodes.map((node) => (
              <li
                key={node.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
              >
                <span className="min-w-0 truncate text-sm font-medium">
                  {node.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge
                    variant="outline"
                    className="border-transparent bg-primary/10 font-mono text-micro font-normal text-primary"
                  >
                    {node.protocol}
                  </Badge>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ServerIcon className="size-3.5" />
                    {node.server_name || "—"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const eventReasonKeys: Record<string, string> = {
  exhausted: "me.events.reason.exhausted",
  expired: "me.events.reason.expired",
  disabled: "me.events.reason.disabled",
  inactive: "me.events.reason.inactive",
  recovered: "me.events.reason.recovered",
};

/** 后端 `reason` 是逗号分隔的机器码；按当前语言翻译，未知码原样展示。 */
function eventReasonLabel(reason: string): string {
  const labels = reason
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => (eventReasonKeys[code] ? t(eventReasonKeys[code]) : code));
  return labels.join(" · ");
}

function EventRow({ event }: { event: EnforcementEvent }) {
  const removed = event.kind === "removed";
  return (
    <li className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
      <div
        className={cn(
          "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full",
          removed
            ? "bg-destructive/10 text-destructive"
            : "bg-primary/10 text-primary",
        )}
      >
        {removed ? (
          <TriangleAlertIcon className="size-3.5" />
        ) : (
          <ShieldCheckIcon className="size-3.5" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {t(removed ? "me.events.kind.removed" : "me.events.kind.restored")}
          </span>
          <Badge
            variant="outline"
            className="border-transparent bg-muted text-micro font-normal text-muted-foreground"
          >
            {eventReasonLabel(event.reason)}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("me.events.server", { name: event.server_name || "—" })}
        </p>
      </div>
      <time
        className="shrink-0 text-xs text-muted-foreground"
        dateTime={new Date(event.created_at * 1_000).toISOString()}
        title={formatAbsoluteTime(event.created_at)}
      >
        {formatRelativeTime(event.created_at)}
      </time>
    </li>
  );
}

function EventsCard({
  events,
}: {
  events: UseQueryResult<EnforcementEvent[]>;
}) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <HistoryIcon className="size-4 text-muted-foreground" />
          {t("me.events.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("me.events.desc")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {events.isPending ? (
          <div className="space-y-3">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : events.isError ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlertIcon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">{t("me.events.loadFailed")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {meErrorText(events.error, t("me.events.loadError"))}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void events.refetch()}
              disabled={events.isFetching}
            >
              <RefreshCwIcon
                className={cn("size-3.5", events.isFetching && "animate-spin")}
              />
              {t("common.retry")}
            </Button>
          </div>
        ) : events.data && events.data.length > 0 ? (
          <ul className="divide-y divide-border">
            {events.data.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={HistoryIcon}
            title={t("me.events.empty")}
            description={t("me.events.emptyDesc")}
          />
        )}
      </CardContent>
    </Card>
  );
}

function TrafficCard({ traffic }: { traffic: UseQueryResult<MeTraffic> }) {
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
          <Badge
            variant="outline"
            className="font-mono text-micro font-normal text-muted-foreground"
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
      <Skeleton className="h-52 w-full rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
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

function ResetSubscriptionDialog({
  open,
  onOpenChange,
  username,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  username: string;
}) {
  const reset = useResetSubscription();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && reset.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-warning/10 text-warning">
            <RotateCcwIcon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {t("me.subscription.resetTitle")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("me.subscription.resetDesc")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={reset.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={reset.isPending}
            onClick={(event) => {
              event.preventDefault();
              reset.mutate(undefined, {
                onSuccess: () => {
                  toast.success(t("me.subscription.resetSuccess", { username }));
                  onOpenChange(false);
                },
                onError: (error) => {
                  toast.error(
                    errorText(error, t("me.subscription.resetError")),
                  );
                },
              });
            }}
          >
            {t("me.subscription.resetAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function MePage() {
  useI18n();
  const summary = useMeSummary();
  const traffic = useMeTraffic(TRAFFIC_DAYS);
  const events = useMeEvents(EVENTS_LIMIT);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  if (summary.isPending) return <MeSkeleton />;

  if (summary.isError) {
    return (
      <MeError
        message={meErrorText(summary.error, t("me.loadError"))}
        retrying={summary.isFetching}
        onRetry={() => void summary.refetch()}
      />
    );
  }

  if (!summary.data) return null;

  const data = summary.data;
  const initial = data.user.username.slice(0, 1).toUpperCase();
  const refreshing = summary.isFetching || traffic.isFetching;

  function refreshAll() {
    void summary.refetch();
    void traffic.refetch();
    void events.refetch();
  }

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar size="lg">
            <AvatarFallback className="bg-primary/15 font-medium text-primary">
              {initial}
            </AvatarFallback>
          </Avatar>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl leading-tight font-semibold tracking-tight">
                {data.user.username}
              </h1>
              <MeStatusBadge status={data.usage.status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {data.user.email ? `${data.user.email} · ` : ""}
              {t("me.onlyOwnData")}
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

      <StatusAlerts summary={data} />

      <OverviewCard summary={data} />

      <div className="grid gap-4 lg:grid-cols-2">
        <SubscriptionCard
          summary={data}
          onReset={() => setResetOpen(true)}
        />
        <TrafficCard traffic={traffic} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <NodesCard summary={data} />
        <EventsCard events={events} />
      </div>

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

      <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />
      <ResetSubscriptionDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        username={data.user.username}
      />
    </div>
  );
}
