import { useReducer } from "react";
import type { FormEvent } from "react";
import {
  CalendarPlusIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorText } from "@/lib/errors";
import {
  RENEW_DAY_PRESETS,
  RENEW_DAYS_MAX,
  RENEW_DAYS_MIN,
  initialRenewDialogState,
  renewDialogReducer,
  validateRenewDays,
} from "@/lib/overviewActions";
import { useBatchRenewUserPackages } from "@/lib/queries";
import { t, useI18n } from "@/i18n";

interface BatchRenewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前概览统计里的过期实例数；仅用于展示影响范围。 */
  expiredCount: number;
}

/**
 * 过期套餐实例的批量续期：选择天数 → 二次确认 → 提交。
 *
 * 二次确认必须写清「基准是当前时间」与影响范围；提交成功但 `updated = 0`
 * 时提示「没有可处理的对象」，不当成错误。
 */
export function BatchRenewDialog({
  open,
  onOpenChange,
  expiredCount,
}: BatchRenewDialogProps) {
  useI18n();
  const [state, dispatch] = useReducer(
    renewDialogReducer,
    undefined,
    initialRenewDialogState,
  );
  const renew = useBatchRenewUserPackages();

  const validation = validateRenewDays(state.daysInput);
  const days = validation.ok ? validation.days : null;
  const showInvalid =
    !validation.ok && validation.problem !== "empty";
  const pending = state.submitting || renew.isPending;

  function changeOpen(next: boolean) {
    if (!next && pending) return;
    onOpenChange(next);
  }

  function goNext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (days === null || pending) return;
    dispatch({ type: "next" });
  }

  async function confirmRenew() {
    if (days === null || pending) return;
    dispatch({ type: "submit" });
    try {
      const result = await renew.mutateAsync(days);
      if (result.updated === 0) {
        toast.info(t("overview.renewDialog.empty"));
      } else {
        toast.success(
          t("overview.renewDialog.success", { n: result.updated }),
        );
      }
      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, t("overview.renewDialog.error"));
      dispatch({ type: "failure", message });
      toast.error(message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
              <CalendarPlusIcon className="size-3.5" />
            </span>
            {t("overview.renewDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("overview.renewDialog.desc")}
          </DialogDescription>
        </DialogHeader>

        {state.stage === "input" ? (
          <form
            id="batch-renew-form"
            className="flex flex-col gap-4"
            onSubmit={goNext}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="batch-renew-days">
                {t("overview.renewDialog.daysLabel", {
                  min: RENEW_DAYS_MIN,
                  max: RENEW_DAYS_MAX,
                })}
              </Label>
              <div className="flex flex-wrap gap-2">
                {RENEW_DAY_PRESETS.map((preset) => (
                  <Button
                    key={preset}
                    type="button"
                    size="sm"
                    variant={
                      state.daysInput === String(preset)
                        ? "default"
                        : "outline"
                    }
                    disabled={pending}
                    onClick={() =>
                      dispatch({ type: "preset", days: preset })
                    }
                  >
                    {t("common.days", { n: preset })}
                  </Button>
                ))}
              </div>
              <Input
                id="batch-renew-days"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={state.daysInput}
                placeholder={t("overview.renewDialog.daysPlaceholder")}
                aria-invalid={showInvalid || undefined}
                disabled={pending}
                onChange={(event) =>
                  dispatch({ type: "input", value: event.target.value })
                }
              />
              {showInvalid ? (
                <p className="text-xs text-destructive">
                  {t("overview.renewDialog.invalidDays", {
                    min: RENEW_DAYS_MIN,
                    max: RENEW_DAYS_MAX,
                  })}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {t("overview.renewDialog.scope", { n: expiredCount })}
              </p>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm">
              {t("overview.renewDialog.confirmDesc", {
                n: expiredCount,
                days: days ?? RENEW_DAYS_MIN,
              })}
            </p>
            <Alert className="border-warning/30 bg-warning/10 text-warning">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertDescription className="text-xs text-warning">
                {t("overview.renewDialog.confirmWarning")}
              </AlertDescription>
            </Alert>
            <p className="text-xs text-muted-foreground">
              {t("overview.renewDialog.basis")}
            </p>
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
              ? t("overview.renewDialog.back")
              : t("common.cancel")}
          </Button>
          {state.stage === "input" ? (
            <Button type="submit" form="batch-renew-form" disabled={days === null || pending}>
              {t("overview.renewDialog.next")}
            </Button>
          ) : (
            <Button type="button" disabled={pending} onClick={() => void confirmRenew()}>
              {pending ? <Loader2Icon className="animate-spin" /> : null}
              {pending
                ? t("overview.renewDialog.submitting")
                : t("overview.renewDialog.submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
