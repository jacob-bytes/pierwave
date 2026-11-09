import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  HistoryIcon,
  Loader2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
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
  displayAgentVersion,
} from "@/lib/agentUpgrade";
import {
  normalizeAgentBatchItemStatus,
  normalizeAgentBatchStatus,
  summarizeAgentBatchItems,
  type AgentUpgradeBatchItemStatusView,
  type AgentUpgradeBatchStatusView,
} from "@/lib/agentUpgradeBatch";
import type { AgentUpgradeBatchItem } from "@/lib/api";
import { errorText, isNotFound } from "@/lib/errors";
import {
  queryKeys,
  useAgentUpgradeBatch,
  useAgentUpgradeBatches,
  useCancelAgentUpgradeBatch,
  useTriggerAgentUpgrade,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 4;
const HEAD_CLASS =
  "h-9 px-3 text-xs font-medium tracking-wide text-muted-foreground";

const batchStatusMeta: Record<
  AgentUpgradeBatchStatusView,
  { labelKey: string; badgeClass: string; dotClass: string }
> = {
  running: {
    labelKey: "servers.batch.progress.batchStatus.running",
    badgeClass: "bg-warning/10 text-warning",
    dotClass: "bg-warning motion-safe:animate-pulse",
  },
  succeeded: {
    labelKey: "servers.batch.progress.batchStatus.succeeded",
    badgeClass: "bg-primary/10 text-primary",
    dotClass: "bg-primary",
  },
  failed: {
    labelKey: "servers.batch.progress.batchStatus.failed",
    badgeClass: "bg-destructive/10 text-destructive",
    dotClass: "bg-destructive",
  },
  cancelled: {
    labelKey: "servers.batch.progress.batchStatus.cancelled",
    badgeClass: "bg-muted text-muted-foreground",
    dotClass: "bg-muted-foreground/40",
  },
  unknown: {
    labelKey: "servers.batch.progress.batchStatus.unknown",
    badgeClass: "bg-muted text-muted-foreground",
    dotClass: "bg-muted-foreground/40",
  },
};

const itemStatusMeta: Record<
  AgentUpgradeBatchItemStatusView,
  { labelKey: string; badgeClass: string; dotClass: string }
> = {
  queued: {
    labelKey: "servers.batch.progress.itemStatus.queued",
    badgeClass: "bg-muted text-muted-foreground",
    dotClass: "bg-muted-foreground/40",
  },
  running: {
    labelKey: "servers.batch.progress.itemStatus.running",
    badgeClass: "bg-warning/10 text-warning",
    dotClass: "bg-warning motion-safe:animate-pulse",
  },
  succeeded: {
    labelKey: "servers.batch.progress.itemStatus.succeeded",
    badgeClass: "bg-primary/10 text-primary",
    dotClass: "bg-primary",
  },
  failed: {
    labelKey: "servers.batch.progress.itemStatus.failed",
    badgeClass: "bg-destructive/10 text-destructive",
    dotClass: "bg-destructive",
  },
  skipped: {
    labelKey: "servers.batch.progress.itemStatus.skipped",
    badgeClass: "bg-muted text-muted-foreground",
    dotClass: "bg-muted-foreground/40",
  },
  cancelled: {
    labelKey: "servers.batch.progress.itemStatus.cancelled",
    badgeClass: "bg-muted text-muted-foreground",
    dotClass: "bg-muted-foreground/40",
  },
  unknown: {
    labelKey: "servers.batch.progress.itemStatus.unknown",
    badgeClass: "bg-muted text-muted-foreground",
    dotClass: "bg-muted-foreground/40",
  },
};

function BatchStatusBadge({ status }: { status: string }) {
  const meta = batchStatusMeta[normalizeAgentBatchStatus(status)];

  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 border-transparent font-normal", meta.badgeClass)}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", meta.dotClass)}
      />
      {t(meta.labelKey)}
    </Badge>
  );
}

function ItemStatusBadge({ status }: { status: string }) {
  const meta = itemStatusMeta[normalizeAgentBatchItemStatus(status)];

  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 border-transparent font-normal", meta.badgeClass)}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", meta.dotClass)}
      />
      {t(meta.labelKey)}
    </Badge>
  );
}

function StatusRows({ children }: { children: ReactNode }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-3 py-12">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
          {children}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * 单台结果行。
 *
 * 重试走单台接口（不是重新建批次），成功后让批次详情重新拉一次；
 * 批次本身不会因为重试回到 running，所以不做乐观状态，等后端写回。
 */
function BatchItemRow({
  batchId,
  item,
  targetVersion,
}: {
  batchId: string;
  item: AgentUpgradeBatchItem;
  targetVersion: string;
}) {
  useI18n();
  const queryClient = useQueryClient();
  const retry = useTriggerAgentUpgrade(item.server_id);
  const [error, setError] = useState<string | null>(null);
  const view = normalizeAgentBatchItemStatus(item.status);
  const retryable = view === "failed";

  const currentVersion =
    displayAgentVersion(item.agent_version) ||
    t("servers.batch.progress.notReported");

  async function handleRetry() {
    if (retry.isPending) return;

    setError(null);
    try {
      await retry.mutateAsync({ version: targetVersion });
      toast.success(
        t("servers.batch.progress.retried", { name: item.server_name }),
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agentUpgradeBatch(batchId),
      });
    } catch (retryError) {
      const message = isNotFound(retryError)
        ? t("servers.batch.progress.retryNotReady404")
        : errorText(retryError, t("servers.batch.progress.retryError"));
      setError(message);
      toast.error(message);
    }
  }

  return (
    <TableRow>
      <TableCell className="max-w-48 px-3 py-2.5">
        <span className="block truncate font-medium">{item.server_name}</span>
        <span className="block truncate font-mono type-micro text-muted-foreground">
          {item.server_id}
        </span>
      </TableCell>
      <TableCell className="px-3 py-2.5">
        <span className="inline-flex items-center gap-1.5 font-mono text-xs">
          <span className="text-muted-foreground">{currentVersion}</span>
          <span aria-hidden="true" className="text-muted-foreground">
            →
          </span>
          <span className="text-foreground">
            {displayAgentVersion(targetVersion) ||
              t("servers.batch.progress.latest")}
          </span>
        </span>
      </TableCell>
      <TableCell className="max-w-64 px-3 py-2.5">
        <div className="flex flex-col gap-1">
          <ItemStatusBadge status={item.status} />
          {item.error ? (
            <span
              className={cn(
                // 失败原因会被管理员当成唯一线索，截成一行等于逼他去看后端日志
                "block whitespace-normal break-words text-xs leading-normal",
                retryable ? "text-destructive" : "text-muted-foreground",
              )}
              title={item.error}
            >
              {item.error}
            </span>
          ) : null}
          {error ? (
            <span
              role="alert"
              className="block text-xs text-destructive"
            >
              {error}
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="px-3 py-2.5">
        {retryable ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => void handleRetry()}
            disabled={retry.isPending}
          >
            {retry.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <RefreshCwIcon />
            )}
            {retry.isPending
              ? t("servers.batch.progress.retrying")
              : t("servers.batch.progress.retry")}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

interface AgentBatchUpgradeProgressDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 指定批次；null 表示「最近一次批次」。 */
  batchId: string | null;
}

/**
 * 批量升级进度面板。
 *
 * - 先按 batchId 拉详情；没有 batchId 时先取最近一次批次；
 * - 批次进行中每 5 秒轮询，批次与所有 item 都终态后由 hook 自动停止；
 * - 失败项可以走单台接口重试，不会影响批次里其它服务器。
 */
export function AgentBatchUpgradeProgressDialog({
  open,
  onOpenChange,
  batchId,
}: AgentBatchUpgradeProgressDialogProps) {
  useI18n();
  const latest = useAgentUpgradeBatches(20, open && !batchId);
  // 不依赖后端返回顺序：显式取创建时间最新的一条。
  const latestBatch = useMemo(
    () =>
      [...(latest.data ?? [])].sort(
        (left, right) => right.created_at - left.created_at,
      )[0],
    [latest.data],
  );
  const resolvedId = batchId ?? latestBatch?.id ?? "";
  const detail = useAgentUpgradeBatch(resolvedId, open);
  const cancelBatch = useCancelAgentUpgradeBatch(resolvedId);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setConfirmCancel(false);
      setCancelError(null);
    }
    onOpenChange(next);
  }

  const items = detail.data?.items ?? [];
  const batch = detail.data?.batch;
  const summary = summarizeAgentBatchItems(items);
  const targetVersion = (batch?.to_version ?? "").trim();
  const targetLabel =
    displayAgentVersion(targetVersion) || t("servers.batch.progress.latest");
  const running = batch?.status === "running";
  const description = batch
    ? t("servers.batch.progress.desc", {
        id: batch.id.slice(0, 8),
        version: targetLabel,
      })
    : t("servers.batch.progress.descLatest");

  const latestLoading = !batchId && latest.isPending;
  const detailLoading = Boolean(resolvedId) && detail.isPending;
  const latestError =
    !batchId && latest.isError
      ? isNotFound(latest.error)
        ? t("servers.batch.progress.notReady404")
        : errorText(latest.error, t("servers.batch.progress.loadError"))
      : null;
  const detailError = detail.isError
    ? isNotFound(detail.error)
      ? t("servers.batch.progress.notReady404")
      : errorText(detail.error, t("servers.batch.progress.loadError"))
    : null;
  const noBatches =
    !batchId && latest.data !== undefined && latest.data.length === 0;

  async function handleCancel() {
    if (cancelBatch.isPending) return;
    setCancelError(null);
    try {
      await cancelBatch.mutateAsync();
      toast.success(t("servers.batch.progress.cancelledToast"));
      setConfirmCancel(false);
    } catch (error) {
      const message = isNotFound(error)
        ? t("servers.batch.progress.notReady404")
        : errorText(error, t("servers.batch.progress.cancelError"));
      setCancelError(message);
      toast.error(message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && cancelBatch.isPending) return;
        handleOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
              <HistoryIcon className="size-3.5" />
            </span>
            {t("servers.batch.progress.title")}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {latestLoading || detailLoading ? (
          <div
            className="flex flex-col gap-3 rounded-lg border border-border p-3"
            aria-busy="true"
          >
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-1.5 w-full" />
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
            ))}
          </div>
        ) : latestError ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-3 py-12 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlertIcon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">
                {t("servers.batch.progress.loadFailed")}
              </p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                {latestError}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void latest.refetch()}
              disabled={latest.isFetching}
            >
              <RefreshCwIcon
                className={cn("size-3.5", latest.isFetching && "animate-spin")}
              />
              {t("common.retry")}
            </Button>
          </div>
        ) : noBatches ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-3 py-12 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
              <HistoryIcon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">
                {t("servers.batch.progress.emptyTitle")}
              </p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                {t("servers.batch.progress.emptyDesc")}
              </p>
            </div>
          </div>
        ) : detailError ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-border px-3 py-12 text-center">
            <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlertIcon className="size-5" />
            </div>
            <div>
              <p className="text-sm font-medium">
                {t("servers.batch.progress.loadFailed")}
              </p>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                {detailError}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void detail.refetch()}
              disabled={detail.isFetching}
            >
              <RefreshCwIcon
                className={cn("size-3.5", detail.isFetching && "animate-spin")}
              />
              {t("common.retry")}
            </Button>
          </div>
        ) : batch ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {t("servers.batch.progress.summary", {
                    succeeded: summary.succeeded,
                    failed: summary.failed,
                    remaining: summary.remaining,
                  })}
                </p>
                <BatchStatusBadge status={batch.status} />
              </div>
              <Progress
                value={summary.percent}
                aria-label={t("servers.batch.progress.progressAria", {
                  percent: summary.percent,
                })}
                className="mt-2 h-1.5"
              />
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t("servers.batch.progress.target", {
                    version: targetLabel,
                  })}
                </span>
                {summary.skipped > 0 || summary.cancelled > 0 ? (
                  <span>
                    {t("servers.batch.progress.summaryExtra", {
                      skipped: summary.skipped,
                      cancelled: summary.cancelled,
                    })}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="max-h-[52vh] overflow-y-auto rounded-lg border border-border">
              <Table aria-busy={detail.isFetching}>
                <TableHeader className="bg-muted/30">
                  <TableRow>
                    <TableHead className={HEAD_CLASS}>
                      {t("servers.batch.progress.columns.server")}
                    </TableHead>
                    <TableHead className={HEAD_CLASS}>
                      {t("servers.batch.progress.columns.version")}
                    </TableHead>
                    <TableHead className={HEAD_CLASS}>
                      {t("servers.batch.progress.columns.status")}
                    </TableHead>
                    <TableHead className={HEAD_CLASS}>
                      {t("servers.batch.progress.columns.actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 ? (
                    <StatusRows>
                      <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
                        <HistoryIcon className="size-5" />
                      </div>
                      <p className="text-sm font-medium">
                        {t("servers.batch.progress.emptyItems")}
                      </p>
                    </StatusRows>
                  ) : (
                    items.map((item) => (
                      <BatchItemRow
                        key={item.server_id}
                        batchId={resolvedId}
                        item={item}
                        targetVersion={targetVersion}
                      />
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {confirmCancel ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p className="text-xs text-destructive">
                  {t("servers.batch.progress.cancelConfirm", {
                    n: summary.remaining,
                  })}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => setConfirmCancel(false)}
                    disabled={cancelBatch.isPending}
                  >
                    {t("servers.batch.progress.cancelBack")}
                  </Button>
                  <Button
                    variant="destructive"
                    size="xs"
                    onClick={() => void handleCancel()}
                    disabled={cancelBatch.isPending}
                  >
                    {cancelBatch.isPending ? (
                      <Loader2Icon className="animate-spin" />
                    ) : null}
                    {cancelBatch.isPending
                      ? t("servers.batch.progress.cancelling")
                      : t("servers.batch.progress.cancelConfirmAction")}
                  </Button>
                </div>
              </div>
            ) : null}

            {cancelError ? (
              <p role="alert" className="text-xs text-destructive">
                {cancelError}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          {running ? (
            <Button
              variant="outline"
              onClick={() => setConfirmCancel(true)}
              disabled={cancelBatch.isPending || confirmCancel}
            >
              {t("servers.batch.progress.cancel")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => void detail.refetch()}
            disabled={!resolvedId || detail.isFetching}
          >
            <RefreshCwIcon
              className={cn("size-3.5", detail.isFetching && "animate-spin")}
            />
            {t("servers.batch.progress.refresh")}
          </Button>
          <Button onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
