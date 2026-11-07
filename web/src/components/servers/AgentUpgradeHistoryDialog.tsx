import { useMemo } from "react";
import type { ReactNode } from "react";
import {
  ArrowRightIcon,
  HistoryIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
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
  normalizeAgentUpgradeStatus,
  type AgentUpgradeStatusView,
} from "@/lib/agentUpgrade";
import type { Server } from "@/lib/api";
import { errorText, isNotFound } from "@/lib/errors";
import { useAgentUpgrades } from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 4;
const HEAD_CLASS =
  "h-9 px-3 text-xs font-medium tracking-wide text-muted-foreground";

interface AgentUpgradeHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: Server;
}

const statusMeta: Record<
  AgentUpgradeStatusView,
  { labelKey: string; badgeClass: string; dotClass: string }
> = {
  pending: {
    labelKey: "servers.historyDialog.status.pending",
    badgeClass: "bg-warning/10 text-warning",
    dotClass: "bg-warning motion-safe:animate-pulse",
  },
  succeeded: {
    labelKey: "servers.historyDialog.status.succeeded",
    badgeClass: "bg-primary/10 text-primary",
    dotClass: "bg-primary",
  },
  failed: {
    labelKey: "servers.historyDialog.status.failed",
    badgeClass: "bg-destructive/10 text-destructive",
    dotClass: "bg-destructive",
  },
  unknown: {
    labelKey: "servers.historyDialog.status.unknown",
    badgeClass: "bg-muted text-muted-foreground",
    dotClass: "bg-muted-foreground/40",
  },
};

function UpgradeStatusBadge({ status }: { status: string }) {
  const meta = statusMeta[normalizeAgentUpgradeStatus(status)];

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 border-transparent font-normal",
        meta.badgeClass,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", meta.dotClass)} />
      {t(meta.labelKey)}
    </Badge>
  );
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="px-3 py-2.5">
            <Skeleton className="h-3.5 w-32" />
          </TableCell>
          <TableCell className="px-3 py-2.5">
            <Skeleton className="h-5 w-16 rounded-full" />
          </TableCell>
          <TableCell className="px-3 py-2.5">
            <Skeleton className="h-3.5 w-20" />
          </TableCell>
          <TableCell className="px-3 py-2.5">
            <Skeleton className="h-3.5 w-40" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function StatusRows({
  children,
}: {
  children: ReactNode;
}) {
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
 * 单台服务器的 Agent 升级历史。
 *
 * 四态齐全：loading / error（可重试）/ empty / 正常；
 * 后端可能暂时 404，错误态会说明「接口尚未上线」而不是丢一句请求失败。
 */
export function AgentUpgradeHistoryDialog({
  open,
  onOpenChange,
  server,
}: AgentUpgradeHistoryDialogProps) {
  useI18n();
  const history = useAgentUpgrades(server.id, open);
  const items = useMemo(
    () =>
      [...(history.data ?? [])].sort(
        (left, right) => right.updated_at - left.updated_at,
      ),
    [history.data],
  );

  const errorMessage = history.isError
    ? isNotFound(history.error)
      ? t("servers.historyDialog.notReady404")
      : errorText(history.error, t("servers.historyDialog.loadError"))
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
              <HistoryIcon className="size-3.5" />
            </span>
            {t("servers.historyDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("servers.historyDialog.desc", { name: server.name })}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border">
          <Table aria-busy={history.isPending}>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className={HEAD_CLASS}>
                  {t("servers.historyDialog.columns.versions")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>
                  {t("servers.historyDialog.columns.status")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>
                  {t("servers.historyDialog.columns.time")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>
                  {t("servers.historyDialog.columns.error")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.isPending ? (
                <LoadingRows />
              ) : history.isError ? (
                <StatusRows>
                  <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
                    <TriangleAlertIcon className="size-5" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {t("servers.historyDialog.loadFailed")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {errorMessage}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void history.refetch()}
                    disabled={history.isFetching}
                  >
                    <RefreshCwIcon
                      className={cn(
                        "size-3.5",
                        history.isFetching && "animate-spin",
                      )}
                    />
                    {t("common.retry")}
                  </Button>
                </StatusRows>
              ) : items.length === 0 ? (
                <StatusRows>
                  <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
                    <HistoryIcon className="size-5" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {t("servers.historyDialog.emptyTitle")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("servers.historyDialog.emptyDesc")}
                    </p>
                  </div>
                </StatusRows>
              ) : (
                items.map((upgrade) => (
                  <TableRow key={upgrade.id}>
                    <TableCell className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                        <span>
                          {displayAgentVersion(upgrade.from_version) || "—"}
                        </span>
                        <ArrowRightIcon
                          aria-hidden="true"
                          className="size-3 text-muted-foreground"
                        />
                        <span className="text-foreground">
                          {displayAgentVersion(upgrade.to_version) || "—"}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="px-3 py-2.5">
                      <UpgradeStatusBadge status={upgrade.status} />
                    </TableCell>
                    <TableCell className="px-3 py-2.5 text-xs text-muted-foreground">
                      <span
                        title={t("servers.historyDialog.timeTitle", {
                          created: formatAbsoluteTime(upgrade.created_at),
                          updated: formatAbsoluteTime(upgrade.updated_at),
                        })}
                      >
                        {formatRelativeTime(upgrade.updated_at)}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-72 px-3 py-2.5">
                      {upgrade.error ? (
                        <span
                          className="block truncate text-xs text-destructive"
                          title={upgrade.error}
                        >
                          {upgrade.error}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => void history.refetch()}
            disabled={history.isFetching}
          >
            <RefreshCwIcon
              className={cn("size-3.5", history.isFetching && "animate-spin")}
            />
            {t("common.refresh")}
          </Button>
          <Button onClick={() => onOpenChange(false)}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
