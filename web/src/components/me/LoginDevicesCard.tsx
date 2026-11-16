import { ClockIcon, MonitorSmartphoneIcon } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, ListError } from "@/components/common";
import { SessionList } from "@/components/sessions/SessionList";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { LoginSession } from "@/lib/api";
import { errorText } from "@/lib/errors";
import {
  useRecentLogins,
  useRevokeOtherSessions,
  useRevokeSession,
  useSessions,
} from "@/lib/queries";
import { deviceSummary, formatLoginTime, ipLabel } from "@/lib/sessions";
import { formatAbsoluteTime } from "@/lib/time";
import { t, useI18n } from "@/i18n";

/** 把当前会话踢掉后立即跳登录页：Cookie 已由后端清除。 */
function leaveToLogin() {
  window.location.assign("/login");
}

/**
 * 用户端「登录设备」：列表 + 单个踢出 + 退出其他设备。
 * 所有数据来自 `/api/v1/sessions`，服务端按会话用户过滤。
 */
export function LoginDevicesCard() {
  useI18n();
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();

  async function handleRevoke(session: LoginSession) {
    try {
      const result = await revoke.mutateAsync(session.id);
      if (result.current) {
        toast.success(t("sessions.kickedCurrent"));
        leaveToLogin();
        return;
      }
      toast.success(t("sessions.kicked"));
    } catch (error) {
      toast.error(errorText(error, t("sessions.kickFailed")));
    }
  }

  async function handleRevokeOthers() {
    try {
      const result = await revokeOthers.mutateAsync();
      toast.success(t("sessions.kickedOthers", { n: result.revoked }));
    } catch (error) {
      toast.error(errorText(error, t("sessions.kickFailed")));
    }
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          {t("sessions.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <SessionList
          sessions={sessions.data ?? []}
          pending={sessions.isPending}
          error={sessions.isError ? sessions.error : null}
          errorText={
            sessions.isError
              ? errorText(sessions.error, t("sessions.loadError"))
              : undefined
          }
          onRetry={() => void sessions.refetch()}
          onRevoke={handleRevoke}
          onRevokeOthers={handleRevokeOthers}
          revokingId={revoke.isPending ? revoke.variables : null}
          revokingOthers={revokeOthers.isPending}
        />
      </CardContent>
    </Card>
  );
}

/** 用户端「最近登录」：最近 5 条成功登录，只显示自己的。 */
export function RecentLoginsCard() {
  useI18n();
  const logins = useRecentLogins();
  const items = logins.data ?? [];

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          {t("sessions.history.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {logins.isPending ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : logins.isError ? (
          <ListError
            title={t("sessions.history.loadFailed")}
            message={errorText(logins.error, t("sessions.history.loadError"))}
            onRetry={() => void logins.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={ClockIcon}
            title={t("sessions.history.empty")}
            description={t("sessions.history.emptyDesc")}
            size="sm"
          />
        ) : (
          <ul className="divide-y divide-border rounded-xl border">
            {items.map((login) => (
              <li
                key={login.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                    <MonitorSmartphoneIcon
                      className="icon-sm"
                      aria-hidden="true"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm">
                      {deviceSummary(login.user_agent)}
                    </p>
                    <p className="truncate font-mono type-micro text-muted-foreground">
                      {ipLabel(login.ip)}
                    </p>
                  </div>
                </div>
                <span
                  className="shrink-0 text-xs tabular-nums text-muted-foreground"
                  title={formatAbsoluteTime(login.created_at)}
                >
                  {formatLoginTime(login)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
