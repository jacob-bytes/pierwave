import { useReducer } from "react";
import { Loader2Icon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { errorText } from "@/lib/errors";
import {
  CLEANUP_PRESETS,
  cleanupDaysFor,
  cleanupDialogReducer,
  initialCleanupDialogState,
} from "@/lib/overviewActions";
import { useCleanupEnforcementEvents } from "@/lib/queries";
import { t, useI18n } from "@/i18n";

interface CleanupEventsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const RANGE_LABEL_KEYS = {
  "7": "overview.cleanupDialog.range7",
  "30": "overview.cleanupDialog.range30",
  all: "overview.cleanupDialog.rangeAll",
} as const;

const CONFIRM_DESC_KEYS = {
  "7": "overview.cleanupDialog.confirmDesc7",
  "30": "overview.cleanupDialog.confirmDesc30",
  all: "overview.cleanupDialog.confirmDescAll",
} as const;

/**
 * 断流记录清理：选择时间范围 → 二次确认 → 删除。
 *
 * 删除不可恢复，确认页必须说明后果；`deleted = 0` 是正常结果（范围内没有
 * 记录），提示「没有可处理的对象」而不是报错。
 */
export function CleanupEventsDialog({
  open,
  onOpenChange,
}: CleanupEventsDialogProps) {
  useI18n();
  const [state, dispatch] = useReducer(
    cleanupDialogReducer,
    undefined,
    initialCleanupDialogState,
  );
  const cleanup = useCleanupEnforcementEvents();

  const pending = state.submitting || cleanup.isPending;

  function changeOpen(next: boolean) {
    if (!next && pending) return;
    onOpenChange(next);
  }

  async function confirmCleanup() {
    if (pending) return;
    dispatch({ type: "submit" });
    try {
      const deleted = await cleanup.mutateAsync(cleanupDaysFor(state.range));
      if (deleted.deleted === 0) {
        toast.info(t("overview.cleanupDialog.empty"));
      } else {
        toast.success(
          t("overview.cleanupDialog.success", { n: deleted.deleted }),
        );
      }
      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, t("overview.cleanupDialog.error"));
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
              <Trash2Icon className="size-3.5" />
            </span>
            {t("overview.cleanupDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("overview.cleanupDialog.desc")}
          </DialogDescription>
        </DialogHeader>

        {state.stage === "input" ? (
          <div className="flex flex-col gap-2">
            <Label>{t("overview.cleanupDialog.rangeLabel")}</Label>
            <div className="flex flex-col gap-1">
              {CLEANUP_PRESETS.map((preset) => (
                <Button
                  key={preset.value}
                  type="button"
                  variant={state.range === preset.value ? "secondary" : "ghost"}
                  className="justify-start"
                  disabled={pending}
                  onClick={() =>
                    dispatch({ type: "select", range: preset.value })
                  }
                >
                  {t(RANGE_LABEL_KEYS[preset.value])}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {t(CONFIRM_DESC_KEYS[state.range])}
            </p>
            <Alert variant="destructive">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription className="text-xs">
                {t("overview.cleanupDialog.confirmWarning")}
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
              ? t("overview.cleanupDialog.back")
              : t("common.cancel")}
          </Button>
          {state.stage === "input" ? (
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => dispatch({ type: "next" })}
            >
              {t("overview.cleanupDialog.next")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => void confirmCleanup()}
            >
              {pending ? <Loader2Icon className="animate-spin" /> : null}
              {pending
                ? t("overview.cleanupDialog.submitting")
                : t("overview.cleanupDialog.submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
