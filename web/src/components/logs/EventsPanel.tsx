import { useState } from "react";
import {
  HistoryIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { EmptyState, SkeletonTable } from "@/components/common";
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { EnforcementEventKind } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useEnforcementEvents } from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 6;
const LIMIT_OPTIONS = [50, 200] as const;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

type KindFilter = "all" | EnforcementEventKind;

const kindMeta: Record<
  EnforcementEventKind,
  { labelKey: string; badge: string; dot: string }
> = {
  removed: {
    labelKey: "events.kind.removed",
    badge: "bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
  restored: {
    labelKey: "events.kind.restored",
    badge: "bg-primary/10 text-primary",
    dot: "bg-primary",
  },
};

const reasonLabelKeys: Record<string, string> = {
  exhausted: "events.reason.exhausted",
  expired: "events.reason.expired",
  disabled: "events.reason.disabled",
  inactive: "events.reason.inactive",
  recovered: "events.reason.recovered",
};

/** 后端可能返回逗号分隔的多原因；按固定顺序由后端排好，这里只负责翻译。 */
function reasonLabel(reason: string): string {
  const labels = reason
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) =>
      reasonLabelKeys[code] ? t(reasonLabelKeys[code]) : code,
    );
  return labels.length > 0
    ? labels.join(t("common.listSeparator"))
    : "—";
}

function EventTypeBadge({ kind }: { kind: EnforcementEventKind }) {
  const meta = kindMeta[kind];

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border-transparent font-normal",
        meta.badge,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", meta.dot)}
      />
      {t(meta.labelKey)}
    </Badge>
  );
}

function EmptyRow({
  filter,
  onReset,
}: {
  filter: KindFilter;
  onReset: () => void;
}) {
  const filtered = filter !== "all";
  const label =
    filter === "removed"
      ? t("events.kind.removed")
      : t("events.kind.restored");

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-8">
        <EmptyState
          size="sm"
          icon={HistoryIcon}
          title={
            filtered
              ? t("events.empty.filtered", { label })
              : t("events.empty.all")
          }
          description={
            filtered
              ? t("events.empty.filteredDesc")
              : t("events.empty.allDesc")
          }
          action={
            filtered ? (
              <Button variant="outline" size="sm" onClick={onReset}>
                {t("common.viewAll")}
              </Button>
            ) : undefined
          }
        />
      </TableCell>
    </TableRow>
  );
}

function ErrorRow({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlertIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("events.loadFailed")}</p>
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
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * 「系统事件」面板：由 `/logs` 的 tab 挂载。
 * 页面标题与 tab 外壳在 `Logs.tsx`；这里的筛选、条数与四态逻辑保持原样。
 */
export function EventsPanel() {
  useI18n();
  const [filter, setFilter] = useState<KindFilter>("all");
  const [limit, setLimit] = useState<number>(LIMIT_OPTIONS[0]);
  const events = useEnforcementEvents(limit);

  const items = events.data ?? [];
  const filteredItems =
    filter === "all" ? items : items.filter((item) => item.kind === filter);
  const noFilteredResults = items.length > 0 && filteredItems.length === 0;
  const showError = events.isError && !events.data;
  const errorMessage = errorText(
    events.error,
    t("events.loadError"),
  );

  return (
    <Card className="gap-0 overflow-hidden">
      <CardHeader className="border-b border-border">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            {t("events.list")}
            {events.data ? (
              <Badge
                variant="secondary"
                className="font-mono text-[11px] font-normal text-muted-foreground"
              >
                {items.length}
              </Badge>
            ) : null}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void events.refetch()}
            disabled={events.isFetching}
          >
            <RefreshCwIcon
              className={cn(
                "size-3.5",
                events.isFetching && "animate-spin",
              )}
            />
            {t("common.refresh")}
          </Button>
        </div>
        <CardDescription className="text-xs">
          {t("events.desc")}
        </CardDescription>
      </CardHeader>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <Tabs
          value={filter}
          onValueChange={(value) => setFilter(value as KindFilter)}
        >
          <TabsList>
            <TabsTrigger value="all">{t("events.filter.all")}</TabsTrigger>
            <TabsTrigger value="removed">{t("events.filter.removed")}</TabsTrigger>
            <TabsTrigger value="restored">{t("events.filter.restored")}</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("events.limitLabel")}
          </span>
          <Select
            value={String(limit)}
            onValueChange={(value) => setLimit(Number(value))}
          >
            <SelectTrigger size="sm" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {LIMIT_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {t("events.limitOption", { n: option })}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>

      <CardContent className="p-0" aria-busy={events.isPending}>
        {events.isPending ? (
          <SkeletonTable rows={5} columns={COLUMN_COUNT} />
        ) : null}
        <Table
          className={cn("min-w-[760px]", events.isPending && "hidden")}
        >
          <TableCaption className="sr-only">{t("events.tableCaption")}</TableCaption>
          <TableHeader className="bg-muted/30">
            <TableRow>
              <TableHead sticky="left" className={HEAD_CLASS}>{t("events.columns.time")}</TableHead>
              <TableHead className={HEAD_CLASS}>{t("events.columns.type")}</TableHead>
              <TableHead className={HEAD_CLASS}>{t("events.columns.user")}</TableHead>
              <TableHead className={HEAD_CLASS}>{t("events.columns.server")}</TableHead>
              <TableHead className={HEAD_CLASS}>{t("events.columns.reason")}</TableHead>
              <TableHead className={HEAD_CLASS}>{t("events.columns.message")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {showError ? (
              <ErrorRow
                message={errorMessage}
                retrying={events.isFetching}
                onRetry={() => void events.refetch()}
              />
            ) : items.length === 0 ? (
              <EmptyRow filter="all" onReset={() => setFilter("all")} />
            ) : noFilteredResults ? (
              <EmptyRow
                filter={filter}
                onReset={() => setFilter("all")}
              />
            ) : (
              filteredItems.map((event) => (
                <TableRow key={event.id}>
                  <TableCell sticky="left" className="px-4 py-2.5">
                    <span
                      className="text-xs tabular-nums text-muted-foreground"
                      title={formatAbsoluteTime(event.created_at)}
                    >
                      {formatRelativeTime(event.created_at)}
                    </span>
                  </TableCell>
                  <TableCell className="px-4 py-2.5">
                    <EventTypeBadge kind={event.kind} />
                  </TableCell>
                  <TableCell
                    className="max-w-40 truncate px-4 py-2.5 text-sm"
                    title={event.user_id}
                  >
                    {event.username || "—"}
                  </TableCell>
                  <TableCell
                    className="max-w-40 truncate px-4 py-2.5 text-sm"
                    title={event.server_id}
                  >
                    {event.server_name || "—"}
                  </TableCell>
                  <TableCell className="px-4 py-2.5 text-xs text-muted-foreground">
                    {reasonLabel(event.reason)}
                  </TableCell>
                  <TableCell className="max-w-[460px] min-w-[240px] px-4 py-2.5 text-xs whitespace-normal text-muted-foreground">
                    {event.message}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
