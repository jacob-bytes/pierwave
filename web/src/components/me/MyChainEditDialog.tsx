import { useState } from "react";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { FormField } from "@/components/FormField";
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
import { Switch } from "@/components/ui/switch";
import type { MeChain } from "@/lib/api";
import { errorText } from "@/lib/errors";
import {
  chainDisableConfirm,
  chainEditError,
  chainEditSuccess,
  chainEnableHint,
  editableChainFields,
  planChainEdit,
} from "@/lib/myChains";
import { useUpdateMyChain } from "@/lib/queries";
import { t, useI18n } from "@/i18n";

/**
 * 编辑自己的链：只暴露名称、目标与启用开关。
 *
 * 模板 / groups / 入口端口由系统固定，换模板请删除后重建；停用会从服务器
 * 移除转发链并释放端口，所以点了保存后还要再过一次确认框。
 */
export function MyChainEditDialog({
  chain,
  open,
  onOpenChange,
}: {
  chain: MeChain;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useI18n();
  const update = useUpdateMyChain();
  const [fields, setFields] = useState(() => editableChainFields(chain));
  const [error, setError] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);

  function submit(force = false) {
    const validationError = chainEditError(fields);
    if (validationError) {
      setError(validationError);
      return;
    }
    const plan = planChainEdit(chain, fields);
    if (!plan.hasChanges) {
      onOpenChange(false);
      return;
    }
    if (plan.needsDisableConfirm && !force) {
      setConfirmDisable(true);
      return;
    }
    setError(null);
    update.mutate(
      { id: chain.id, input: plan.input },
      {
        onSuccess: (updated) => {
          toast.success(chainEditSuccess(plan, updated));
          onOpenChange(false);
        },
        onError: (submitError) => {
          const message = errorText(submitError, t("me.chains.editError"));
          setError(message);
          toast.error(message);
        },
      },
    );
  }

  const confirm = chainDisableConfirm();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && (update.isPending || confirmDisable)) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("me.chains.editTitle")}</DialogTitle>
          <DialogDescription>{t("me.chains.editDesc")}</DialogDescription>
        </DialogHeader>

        <form
          id="my-chain-edit-form"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <FormField
            label={t("me.chains.form.name")}
            htmlFor="my-chain-edit-name"
            required
          >
            <Input
              id="my-chain-edit-name"
              value={fields.name}
              autoComplete="off"
              disabled={update.isPending}
              onChange={(event) =>
                setFields((current) => ({ ...current, name: event.target.value }))
              }
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <FormField
              label={t("me.chains.form.targetHost")}
              htmlFor="my-chain-edit-target-host"
            >
              <Input
                id="my-chain-edit-target-host"
                value={fields.targetHost}
                autoComplete="off"
                disabled={update.isPending}
                placeholder={t("me.chains.form.targetHostPlaceholder")}
                onChange={(event) =>
                  setFields((current) => ({
                    ...current,
                    targetHost: event.target.value,
                  }))
                }
              />
            </FormField>
            <FormField
              label={t("me.chains.form.targetPort")}
              htmlFor="my-chain-edit-target-port"
            >
              <Input
                id="my-chain-edit-target-port"
                value={fields.targetPort}
                inputMode="numeric"
                autoComplete="off"
                disabled={update.isPending}
                placeholder="443"
                onChange={(event) =>
                  setFields((current) => ({
                    ...current,
                    targetPort: event.target.value,
                  }))
                }
              />
            </FormField>
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="my-chain-edit-enabled" className="text-sm">
                {t("common.enabled")}
              </Label>
              {!chain.enabled ? (
                <p className="text-xs text-muted-foreground">
                  {chainEnableHint()}
                </p>
              ) : null}
            </div>
            <Switch
              id="my-chain-edit-enabled"
              checked={fields.enabled}
              disabled={update.isPending}
              aria-label={t("common.enabled")}
              onCheckedChange={(checked) =>
                setFields((current) => ({ ...current, enabled: checked }))
              }
            />
          </div>

          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={update.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="my-chain-edit-form"
            disabled={update.isPending}
          >
            {update.isPending ? <Loader2Icon className="animate-spin" /> : null}
            {update.isPending ? t("common.saving") : t("me.chains.editSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>

      <AlertDialog
        open={confirmDisable}
        onOpenChange={(next) => {
          if (update.isPending) return;
          setConfirmDisable(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-warning/10 text-warning">
              <TriangleAlertIcon className="size-5" />
            </AlertDialogMedia>
            <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={update.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={update.isPending}
              onClick={(event) => {
                event.preventDefault();
                setConfirmDisable(false);
                submit(true);
              }}
            >
              {t("me.chains.disableConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
