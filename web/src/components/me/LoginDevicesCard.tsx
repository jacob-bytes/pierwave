import { toast } from "sonner";
import { SessionList } from "@/components/sessions/SessionList";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { LoginSession } from "@/lib/api";
import { errorText } from "@/lib/errors";
import {
  useRevokeOtherSessions,
  useRevokeSession,
  useSessions,
} from "@/lib/queries";
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
