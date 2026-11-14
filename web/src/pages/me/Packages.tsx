import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  HistoryIcon,
  PackageIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { meErrorText } from "@/lib/meError";
import { useMeShellSummary } from "@/lib/meShell";
import { MeStatusBadge } from "@/components/me/MeStatus";
import { EmptyState } from "@/components/common";
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
import type { EnforcementEvent, UserPackageView } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { useMeEvents } from "@/lib/queries";
import {
  formatAbsoluteTime,
  formatDate,
  formatRelativeTime,
} from "@/lib/time";
import { cn } from "@/lib/utils";
import { useI18n, t } from "@/i18n";

const EVENTS_LIMIT = 20;

function PackageRow({ instance }: { instance: UserPackageView }) {
  useI18n();
  const quota =
    instance.quota_bytes === null
      ? t("me.packagesPage.unlimited")
      : formatBytes(instance.quota_bytes, { zeroAsUnlimited: true });

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">
            {instance.package_name}
          </span>
          <MeStatusBadge status={instance.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t("me.package.expires")}{" "}
            <span className="text-foreground/80">
              {instance.expires_at
                ? formatDate(instance.expires_at)
                : t("common.longTermValid")}
            </span>
          </span>
          <span>
            {t("me.overview.used")}{" "}
            <span className="font-mono text-foreground/80">
              {formatBytes(instance.used_bytes)} / {quota}
            </span>
          </span>
          <span>
            {t("me.package.reset")}{" "}
            <span className="text-foreground/80">
              {instance.reset_day === null
                ? t("me.package.noReset")
                : t("me.package.resetMonthly", { day: instance.reset_day })}
            </span>
          </span>
        </div>
      </div>
      {instance.node_ratio !== 1 ? (
        <Badge
          variant="secondary"
          className="w-fit shrink-0 font-mono type-micro font-normal text-muted-foreground"
        >
          {t("me.package.ratio", { ratio: instance.node_ratio })}
        </Badge>
      ) : null}
    </li>
  );
}

function PackageListCard({
  titleKey,
  count,
  instances,
  empty,
}: {
  titleKey: string;
  count: number;
  instances: UserPackageView[];
  empty: ReactNode;
}) {
  useI18n();
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <PackageIcon className="size-4 text-muted-foreground" />
          {t(titleKey)}
        </CardTitle>
        <CardAction>
          <Badge
            variant="secondary"
            className="font-mono type-micro font-normal text-muted-foreground tabular-nums"
          >
            {t("me.packagesValue", { n: count })}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        {instances.length === 0 ? (
          empty
        ) : (
          <ul className="divide-y divide-border">
            {instances.map((instance) => (
              <PackageRow key={instance.id} instance={instance} />
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
  useI18n();
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
            className="border-transparent bg-muted type-micro font-normal text-muted-foreground"
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
  useI18n();
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

/**
 * 套餐：当前已开通的实例、每张卡的到期时间与历史实例；
 * 断流/恢复事件也归在这里，避免从「我的」拆页后丢失既有记录。
 */
export default function MePackagesPage() {
  useI18n();
  const summary = useMeShellSummary();
  const events = useMeEvents(EVENTS_LIMIT);

  // 后端 `packages` 含生效中与已结束的实例；过期才算历史。
  const instances = summary.packages ?? [];
  const current = instances.filter((item) => item.status !== "expired");
  const history = instances.filter((item) => item.status === "expired");

  return (
    <div className="space-y-4">
      <PackageListCard
        titleKey="me.packagesPage.current"
        count={current.length}
        instances={current}
        empty={
          <EmptyState
            icon={PackageIcon}
            title={
              instances.length === 0
                ? t("me.emptyPackages")
                : t("me.packagesPage.currentEmpty")
            }
            description={
              instances.length === 0
                ? t("me.emptyPackagesDesc")
                : t("me.packagesPage.currentEmptyDesc")
            }
          />
        }
      />
      <PackageListCard
        titleKey="me.packagesPage.history"
        count={history.length}
        instances={history}
        empty={
          <EmptyState
            icon={HistoryIcon}
            title={t("me.packagesPage.historyEmpty")}
            description={t("me.packagesPage.historyEmptyDesc")}
          />
        }
      />
      <EventsCard events={events} />
    </div>
  );
}
