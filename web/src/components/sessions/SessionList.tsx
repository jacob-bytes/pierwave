import { useState } from "react";
import { LogOutIcon, MonitorSmartphoneIcon } from "lucide-react";
import { EmptyState, ListError } from "@/components/common";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { LoginSession } from "@/lib/api";
import {
  deviceSummary,
  formatLastSeen,
  ipLabel,
  sortSessions,
} from "@/lib/sessions";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

interface SessionListProps {
  sessions: LoginSession[];
  pending: boolean;
  error?: unknown;
  errorText?: string;
  onRetry: () => void;
  onRevoke: (session: LoginSession) => Promise<void> | void;
  /** 提供时显示「退出其他设备」的确认；管理员对话框不需要。 */
  onRevokeOthers?: () => Promise<void> | void;
  revokingId?: string | null;
  revokingOthers?: boolean;
  emptyTitle?: string;
  emptyDesc?: string;
  className?: string;
}

type ConfirmTarget =
  | { kind: "one"; session: LoginSession }
  | { kind: "others" }
  | null;

/**
 * 会话列表 + 踢出确认。用户端卡片与管理员对话框共用：
 * 列表四态、当前设备标记、破坏性操作确认都在这里保持一致。
 */
export function SessionList({
  sessions,
  pending,
  error,
  errorText,
  onRetry,
  onRevoke,
  onRevokeOthers,
  revokingId,
  revokingOthers,
  emptyTitle,
  emptyDesc,
  className,
}: SessionListProps) {
  useI18n();
  const [target, setTarget] = useState<ConfirmTarget>(null);
  const rows = sortSessions(sessions);

  if (pending) {
    return (
      <div className={cn("space-y-2", className)} aria-busy="true">
        {[0, 1].map((index) => (
          <Skeleton key={index} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <ListError
        title={t("sessions.loadFailed")}
        message={errorText ?? t("sessions.loadError")}
        onRetry={onRetry}
        className={className}
      />
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={MonitorSmartphoneIcon}
        title={emptyTitle ?? t("sessions.empty")}
        description={emptyDesc ?? t("sessions.emptyDesc")}
        size="sm"
        className={className}
      />
    );
  }

  const confirming =
    target?.kind === "others"
      ? Boolean(revokingOthers)
      : target?.kind === "one"
        ? revokingId === target.session.id
        : false;

  const hasOthers = rows.some((session) => !session.current);

  return (
    <div className={cn("space-y-2", className)}>
      {onRevokeOthers && hasOthers ? (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(revokingOthers)}
            onClick={() => setTarget({ kind: "others" })}
          >
            <LogOutIcon className="icon-sm" aria-hidden="true" />
            {t("sessions.kickOthers")}
          </Button>
        </div>
      ) : null}
      <ul className="divide-y divide-border rounded-xl border">
        {rows.map((session) => {
          const revoking = revokingId === session.id;
          return (
            <li
              key={session.id}
              className="flex flex-wrap items-start justify-between gap-3 px-3 py-3"
            >
              <div className="flex min-w-0 items-start gap-3">
                <div className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                  <MonitorSmartphoneIcon className="icon-md" aria-hidden="true" />
                </div>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">
                      {deviceSummary(session.user_agent)}
                    </p>
                    {session.current ? (
                      <Badge
                        variant="outline"
                        className="border-primary/20 bg-primary/10 font-normal text-primary"
                      >
                        {t("sessions.current")}
                      </Badge>
                    ) : null}
                  </div>
                  <p
                    className="text-xs text-muted-foreground"
                    title={formatAbsoluteTime(session.created_at)}
                  >
                    {t("sessions.signedInAt", {
                      time: formatRelativeTime(session.created_at),
                    })}
                    {" · "}
                    {t("sessions.lastSeen", {
                      time: formatLastSeen(session),
                    })}
                  </p>
                  <p className="truncate font-mono type-micro text-muted-foreground">
                    {ipLabel(session.ip)}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={revoking}
                onClick={() => setTarget({ kind: "one", session })}
              >
                <LogOutIcon className="icon-sm" aria-hidden="true" />
                {session.current
                  ? t("sessions.kickCurrent")
                  : t("sessions.kick")}
              </Button>
            </li>
          );
        })}
      </ul>

      <AlertDialog
        open={target !== null}
        onOpenChange={(next) => {
          if (!next && !confirming) setTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <LogOutIcon className="icon-lg" aria-hidden="true" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {target?.kind === "others"
                ? t("sessions.kickOthersTitle")
                : target?.kind === "one" && target.session.current
                  ? t("sessions.kickCurrentTitle")
                  : t("sessions.kickTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {target?.kind === "others"
                ? t("sessions.kickOthersDesc")
                : target?.kind === "one" && target.session.current
                  ? t("sessions.kickCurrentDesc")
                  : t("sessions.kickDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={confirming}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={confirming}
              onClick={(event) => {
                event.preventDefault();
                if (!target) return;
                const current = target;
                void (async () => {
                  try {
                    if (current.kind === "others") {
                      await onRevokeOthers?.();
                    } else {
                      await onRevoke(current.session);
                    }
                  } finally {
                    setTarget(null);
                  }
                })();
              }}
            >
              {target?.kind === "others"
                ? t("sessions.kickOthersConfirm")
                : t("sessions.kickConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
