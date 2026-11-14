import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeftIcon, ChartColumnIcon } from "lucide-react";
import {
  EmptyState,
  ListError,
  PageHeader,
} from "@/components/common";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ForwardUsageDay, ForwardUsageRow } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import {
  FORWARD_USAGE_WINDOWS,
  filterUsageRows,
  forwardUsageName,
  forwardUsageUserName,
  isUsageEmpty,
  sortUsageRows,
  sumUsageDays,
  usageUserOptions,
  windowLabel,
  type ForwardUsageWindow,
} from "@/lib/forwardUsage";
import { useForwardUsage } from "@/lib/queries";
import { useI18n } from "@/i18n";

function WindowSwitcher({
  value,
  onChange,
}: {
  value: ForwardUsageWindow;
  onChange: (days: ForwardUsageWindow) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t("forwardUsage.windowAria")}
      className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
    >
      {FORWARD_USAGE_WINDOWS.map((days) => (
        <Button
          key={days}
          type="button"
          size="sm"
          variant={days === value ? "secondary" : "ghost"}
          aria-pressed={days === value}
          onClick={() => onChange(days)}
          className="h-7 px-2.5 text-xs"
        >
          {windowLabel(days, t)}
        </Button>
      ))}
    </div>
  );
}

function TotalCard({ label, value }: { label: string; value: number }) {
  return (
    <Card size="sm">
      <CardContent className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-lg tabular-nums">{formatBytes(value)}</span>
      </CardContent>
    </Card>
  );
}

function DailyTable({ days }: { days: ForwardUsageDay[] }) {
  const { t } = useI18n();
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ChartColumnIcon className="size-4 text-muted-foreground" />
          {t("forwardUsage.dailyTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="max-h-[420px] overflow-y-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 px-4 text-xs">
                  {t("forwardUsage.day")}
                </TableHead>
                <TableHead className="h-8 px-4 text-right text-xs">
                  {t("forwardUsage.raw")}
                </TableHead>
                <TableHead className="h-8 px-4 text-right text-xs">
                  {t("forwardUsage.billed")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.map((day) => (
                <TableRow key={day.day}>
                  <TableCell className="px-4 py-2 font-mono text-xs">
                    {day.day}
                  </TableCell>
                  <TableCell className="px-4 py-2 text-right font-mono text-xs tabular-nums">
                    {formatBytes(day.bytes)}
                  </TableCell>
                  <TableCell className="px-4 py-2 text-right font-mono text-xs tabular-nums">
                    {formatBytes(day.weighted)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function ForwardRows({
  rows,
  userFilter,
}: {
  rows: ForwardUsageRow[];
  userFilter: string;
}) {
  const { t } = useI18n();
  const deletedLabel = t("forwardUsage.deleted");
  const filtered = filterUsageRows(rows, userFilter);

  if (filtered.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={ArrowRightLeftIcon}
        title={t("forwardUsage.filteredEmpty")}
      />
    );
  }

  return (
    <ul className="divide-y divide-border">
      {filtered.map((row) => (
        <li
          key={`${row.forward_id}:${row.user_id}`}
          className="flex flex-col gap-2 px-4 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <div
              className="truncate text-sm font-medium"
              title={forwardUsageName(row, deletedLabel)}
            >
              {forwardUsageName(row, deletedLabel)}
            </div>
            <div
              className="truncate text-xs text-muted-foreground"
              title={forwardUsageUserName(row, deletedLabel)}
            >
              {forwardUsageUserName(row, deletedLabel)}
            </div>
          </div>
          <dl className="flex shrink-0 items-baseline gap-4 text-xs">
            <div className="flex items-baseline gap-1.5">
              <dt className="text-muted-foreground">{t("forwardUsage.raw")}</dt>
              <dd className="font-mono tabular-nums">{formatBytes(row.bytes)}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-muted-foreground">{t("forwardUsage.billed")}</dt>
              <dd className="font-mono tabular-nums">
                {formatBytes(row.weighted)}
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

export default function ForwardUsagePage() {
  const { t } = useI18n();
  const [days, setDays] = useState<ForwardUsageWindow>(7);
  const [userFilter, setUserFilter] = useState("");
  const usage = useForwardUsage(days);

  const data = usage.data;
  const rows = useMemo(
    () => sortUsageRows(data?.by_forward),
    [data?.by_forward],
  );
  const users = useMemo(
    () => usageUserOptions(rows, t("forwardUsage.deleted")),
    [rows, t],
  );

  // 切换时间窗后，原筛选用户可能已不在窗口内：回落到「全部用户」，
  // 避免 Select 显示空白、列表又像是空数据。
  useEffect(() => {
    if (userFilter && !users.some((user) => user.id === userFilter)) {
      setUserFilter("");
    }
  }, [userFilter, users]);

  const empty = data ? isUsageEmpty(data.totals, data.by_forward) : false;
  const showError = usage.isError && !data;
  const loadError = errorText(usage.error, t("forwardUsage.loadError"));
  const totals = data ? sumUsageDays(data.days) : { bytes: 0, weighted: 0 };

  return (
    <div className="animate-enter space-y-6">
      <PageHeader
        title={t("forwardUsage.title")}
        actions={<WindowSwitcher value={days} onChange={setDays} />}
      />

      {usage.isPending && !data ? (
        <div className="space-y-4" aria-busy="true">
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : showError ? (
        <Card>
          <ListError
            title={t("forwardUsage.loadFailed")}
            message={loadError}
            retrying={usage.isFetching}
            onRetry={() => void usage.refetch()}
          />
        </Card>
      ) : empty ? (
        <Card>
          <EmptyState
            icon={ArrowRightLeftIcon}
            title={t("forwardUsage.emptyTitle", { days })}
            description={t("forwardUsage.emptyDesc")}
          />
        </Card>
      ) : data ? (
        <>
          <section
            className="grid gap-3 sm:grid-cols-2"
            aria-label={t("forwardUsage.title")}
          >
            <TotalCard label={t("forwardUsage.raw")} value={totals.bytes} />
            <TotalCard label={t("forwardUsage.billed")} value={totals.weighted} />
          </section>

          <DailyTable days={data.days} />

          <Card className="gap-3">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <ArrowRightLeftIcon className="size-4 text-muted-foreground" />
                {t("forwardUsage.byForwardTitle")}
              </CardTitle>
              <CardAction>
                <Select
                  value={userFilter || "__all__"}
                  onValueChange={(value) =>
                    setUserFilter(value === "__all__" ? "" : value)
                  }
                >
                  <SelectTrigger
                    className="h-8 w-40 text-xs"
                    aria-label={t("forwardUsage.userFilterAria")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">
                      {t("forwardUsage.allUsers")}
                    </SelectItem>
                    {users.map((user) => (
                      <SelectItem key={user.id} value={user.id}>
                        {user.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0">
              <ForwardRows rows={rows} userFilter={userFilter} />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
