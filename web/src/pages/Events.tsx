import { useState } from "react";
import {
  HistoryIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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

const COLUMN_COUNT = 6;
const LIMIT_OPTIONS = [50, 200] as const;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

type KindFilter = "all" | EnforcementEventKind;

const kindMeta: Record<
  EnforcementEventKind,
  { label: string; badge: string; dot: string }
> = {
  removed: {
    label: "移除",
    badge: "bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
  restored: {
    label: "恢复",
    badge: "bg-primary/10 text-primary",
    dot: "bg-primary",
  },
};

const reasonLabels: Record<string, string> = {
  exhausted: "额度用尽",
  expired: "套餐已到期",
  disabled: "套餐已停用",
  inactive: "账号或套餐不可用",
  recovered: "套餐恢复可用",
};

/** 后端可能返回逗号分隔的多原因；按固定顺序由后端排好，这里只负责翻译。 */
function reasonLabel(reason: string): string {
  const labels = reason
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean)
    .map((code) => reasonLabels[code] ?? code);
  return labels.length > 0 ? labels.join("、") : "—";
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
      {meta.label}
    </Badge>
  );
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-20" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-14 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-20" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-24" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-16" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-64" />
          </TableCell>
        </TableRow>
      ))}
    </>
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
  const label = filter === "removed" ? "移除" : "恢复";

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <HistoryIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">
              {filtered ? `还没有「${label}」记录` : "还没有断流记录"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {filtered
                ? "当前条数范围内没有这类事件，换个筛选条件看看。"
                : "用户流量用尽、套餐过期或被停用时，主控会在这里记录断流与恢复。"}
            </p>
          </div>
          {filtered ? (
            <Button variant="outline" size="sm" onClick={onReset}>
              查看全部
            </Button>
          ) : null}
        </div>
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
            <p className="text-sm font-medium">事件记录加载失败</p>
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
            重试
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function EventsPage() {
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
    "加载事件记录失败，请检查网络后重试",
  );

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">事件</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          查看用户断流与恢复的记录，按时间倒序排列。
        </p>
      </div>

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              事件记录
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
              刷新
            </Button>
          </div>
          <CardDescription className="text-xs">
            断流与恢复由主控自动记录；按时间倒序展示，筛选在已加载的记录内生效。
          </CardDescription>
        </CardHeader>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <Tabs
            value={filter}
            onValueChange={(value) => setFilter(value as KindFilter)}
          >
            <TabsList>
              <TabsTrigger value="all">全部</TabsTrigger>
              <TabsTrigger value="removed">移除</TabsTrigger>
              <TabsTrigger value="restored">恢复</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">条数</span>
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
                      最近 {option} 条
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>

        <CardContent className="p-0">
          <Table className="min-w-[760px]" aria-busy={events.isPending}>
            <TableCaption className="sr-only">断流与恢复事件</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className={HEAD_CLASS}>时间</TableHead>
                <TableHead className={HEAD_CLASS}>类型</TableHead>
                <TableHead className={HEAD_CLASS}>用户</TableHead>
                <TableHead className={HEAD_CLASS}>服务器</TableHead>
                <TableHead className={HEAD_CLASS}>原因</TableHead>
                <TableHead className={HEAD_CLASS}>说明</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.isPending ? (
                <LoadingRows />
              ) : showError ? (
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
                    <TableCell className="px-4 py-2.5">
                      <span
                        className="text-xs text-muted-foreground"
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
    </div>
  );
}
