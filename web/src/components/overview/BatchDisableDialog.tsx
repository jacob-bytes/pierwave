import { useReducer } from "react";
import { Loader2Icon, PowerIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { errorText } from "@/lib/errors";
import {
  disableOverQuotaDialogReducer,
  initialDisableOverQuotaDialogState,
  overQuotaResultNotice,
  overQuotaScopeNotice,
} from "@/lib/overviewActions";
import {
  useBatchDisableOverQuotaUsers,
  useOverQuotaUserCount,
} from "@/lib/queries";
import { t, useI18n } from "@/i18n";

interface BatchDisableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 超额用户的批量停用：预检人数 → 二次确认 → 停用。
 *
 * 第一步的 `count` 来自后端预检接口，不按概览里的实例数估算；提交时再以后端
 * 条件更新为准（`disabled = 0` 是正常结果，提示「没有需要停用的用户」）。
 * 停用不可自动恢复，确认页必须写明连接会中断、需要手动重新启用。
 */
export function BatchDisableDialog({
  open,
  onOpenChange,
}: BatchDisableDialogProps) {
  useI18n();
  const [state, dispatch] = useReducer(
    disableOverQuotaDialogReducer,
    undefined,
    initialDisableOverQuotaDialogState,
  );
  const countQuery = useOverQuotaUserCount(open);
  const disable = useBatchDisableOverQuotaUsers();

  const pending = state.submitting || disable.isPending;
  const count = countQuery.data?.count ?? 0;
  const scope = overQuotaScopeNotice(count);
  const canConfirm = countQuery.isSuccess && count > 0 && !pending;

  function changeOpen(next: boolean) {
    if (!next && pending) return;
    onOpenChange(next);
  }

  async function confirmDisable() {
    if (pending) return;
    dispatch({ type: "submit" });
    try {
      const result = await disable.mutateAsync();
      const notice = overQuotaResultNotice(result.disabled);
      if (notice.tone === "info") {
        toast.info(t(notice.key));
      } else {
        toast.success(t(notice.key, notice.params));
      }
      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, t("overview.disableDialog.error"));
      dispatch({ type: "failure", message });
      toast.error(message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-destructive/10 text-destructive">
              <PowerIcon className="size-3.5" />
            </span>
            {t("overview.disableDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("overview.disableDialog.desc")}
          </DialogDescription>
        </DialogHeader>

        {state.stage === "count" ? (
          <div className="flex flex-col gap-3">
            {countQuery.isPending ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2Icon className="animate-spin" />
                {t("overview.disableDialog.loading")}
              </p>
            ) : countQuery.isError ? (
              <div className="flex flex-col gap-2">
                <p
                  role="alert"
                  aria-live="polite"
                  className="text-sm text-destructive"
                >
                  {errorText(
                    countQuery.error,
                    t("overview.disableDialog.countError"),
                  )}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={countQuery.isFetching}
                  onClick={() => void countQuery.refetch()}
                >
                  <RefreshCwIcon
                    className={countQuery.isFetching ? "animate-spin" : undefined}
                  />
                  {t("common.retry")}
                </Button>
              </div>
            ) : (
              <>
                <p className="text-sm">{t(scope.key, scope.params)}</p>
                <p className="text-xs text-muted-foreground">
                  {t("overview.disableDialog.criteria")}
                </p>
              </>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {t("overview.disableDialog.confirmDesc", { n: state.count })}
            </p>
            <Alert variant="destructive">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription className="text-xs">
                {t("overview.disableDialog.confirmWarning")}
              </AlertDescription>
            </Alert>
            {state.error ? (
              <p
                role="alert"
                aria-live="polite"
                className="text-xs text-destructive"
              >
                {state.error}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() =>
              state.stage === "confirm"
                ? dispatch({ type: "back" })
                : changeOpen(false)
            }
          >
            {state.stage === "confirm"
              ? t("overview.disableDialog.back")
              : t("common.cancel")}
          </Button>
          {state.stage === "count" ? (
            <Button
              type="button"
              variant="destructive"
              disabled={!canConfirm}
              onClick={() => dispatch({ type: "next", count })}
            >
              {t("overview.disableDialog.next")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => void confirmDisable()}
            >
              {pending ? <Loader2Icon className="animate-spin" /> : null}
              {pending
                ? t("overview.disableDialog.submitting")
                : t("overview.disableDialog.submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
