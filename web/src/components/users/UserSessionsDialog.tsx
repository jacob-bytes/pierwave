import { toast } from "sonner";
import { SessionList } from "@/components/sessions/SessionList";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LoginSession, UserView } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useAdminRevokeSession, useUserSessions } from "@/lib/queries";
import { t, useI18n } from "@/i18n";

/** 管理员在「用户」页查看并踢掉某用户的登录设备。 */
export function UserSessionsDialog({
  user,
  open,
  onOpenChange,
}: {
  user: UserView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useI18n();
  const sessions = useUserSessions(user.id, open);
  const revoke = useAdminRevokeSession(user.id);

  async function handleRevoke(session: LoginSession) {
    try {
      const result = await revoke.mutateAsync(session.id);
      if (result.current) {
        toast.success(t("sessions.kickedCurrent"));
        window.location.assign("/login");
        return;
      }
      toast.success(t("sessions.kicked"));
    } catch (error) {
      toast.error(errorText(error, t("sessions.kickFailed")));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && revoke.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("sessions.admin.title", { username: user.username })}
          </DialogTitle>
        </DialogHeader>

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
          revokingId={revoke.isPending ? revoke.variables : null}
          emptyTitle={t("sessions.admin.empty")}
          emptyDesc={t("sessions.admin.emptyDesc")}
        />

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={revoke.isPending}
            onClick={() => onOpenChange(false)}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
