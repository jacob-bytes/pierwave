import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
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
import { Switch } from "@/components/ui/switch";
import type { Forward } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useCreateForward, useUpdateForward } from "@/lib/queries";
import { forwardFormSchema, type ForwardFormValues } from "@/lib/schemas";
import { useI18n } from "@/i18n";

interface ForwardFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  mode: "create" | "edit";
  forward?: Forward;
}

/**
 * 新建 / 编辑端口转发。
 *
 * 前端只拦「端口 1–65535 + 目标地址非空」；保留端口、节点/转发端口冲突与
 * 自连回环都要查服务器数据，直接展示后端返回的带 code 的中文文案。
 */
export function ForwardFormDialog({
  open,
  onOpenChange,
  serverId,
  mode,
  forward,
}: ForwardFormDialogProps) {
  const { t } = useI18n();
  const isEdit = mode === "edit";
  const createForward = useCreateForward(serverId);
  const updateForward = useUpdateForward(serverId);
  const pending = isEdit ? updateForward.isPending : createForward.isPending;

  const schema = useMemo(() => forwardFormSchema(t), [t]);
  const form = useForm<ForwardFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: forward?.name ?? "",
      listen_port: forward ? String(forward.listen_port) : "",
      target_host: forward?.target_host ?? "",
      target_port: forward ? String(forward.target_port) : "",
      enabled: forward ? Boolean(forward.enabled) : true,
    },
  });

  // 切换语言后重新校验，让已经显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [t, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");

    const input = {
      name: values.name.trim(),
      listen_port: Number(values.listen_port),
      target_host: values.target_host.trim(),
      target_port: Number(values.target_port),
      enabled: values.enabled,
    };

    try {
      if (isEdit && forward) {
        await updateForward.mutateAsync({ id: forward.id, input });
        toast.success(t("forwards.form.updated", { name: input.name }));
      } else {
        await createForward.mutateAsync(input);
        toast.success(t("forwards.form.created", { name: input.name }));
      }

      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, t("forwards.form.error"));
      form.setError("root", { message });
      toast.error(message);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("forwards.form.editTitle")
              : t("forwards.form.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t("forwards.form.editDesc")
              : t("forwards.form.createDesc")}
          </DialogDescription>
        </DialogHeader>

        <form id="forward-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label={t("forwards.form.name")}
            htmlFor="forward-name"
            required
            error={form.formState.errors.name?.message}
          >
            <Input
              id="forward-name"
              value={form.watch("name")}
              onChange={(event) => form.setValue("name", event.target.value)}
              onBlur={() => void form.trigger("name")}
              placeholder={t("forwards.form.namePlaceholder")}
              autoComplete="off"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.name)}
            />
          </FormField>

          <FormField
            label={t("forwards.form.listenPort")}
            htmlFor="forward-listen-port"
            required
            error={form.formState.errors.listen_port?.message}
            hint={t("forwards.form.listenPortHint")}
          >
            <Input
              id="forward-listen-port"
              value={form.watch("listen_port")}
              onChange={(event) =>
                form.setValue("listen_port", event.target.value)
              }
              onBlur={() => void form.trigger("listen_port")}
              inputMode="numeric"
              autoComplete="off"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.listen_port)}
              className="font-mono tabular-nums"
            />
          </FormField>

          <FormField
            label={t("forwards.form.targetHost")}
            htmlFor="forward-target-host"
            required
            error={form.formState.errors.target_host?.message}
            hint={t("forwards.form.targetHostHint")}
          >
            <Input
              id="forward-target-host"
              value={form.watch("target_host")}
              onChange={(event) =>
                form.setValue("target_host", event.target.value)
              }
              onBlur={() => void form.trigger("target_host")}
              placeholder={t("forwards.form.targetHostPlaceholder")}
              autoComplete="off"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.target_host)}
              className="font-mono"
            />
          </FormField>

          <FormField
            label={t("forwards.form.targetPort")}
            htmlFor="forward-target-port"
            required
            error={form.formState.errors.target_port?.message}
            hint={t("forwards.form.targetPortHint")}
          >
            <Input
              id="forward-target-port"
              value={form.watch("target_port")}
              onChange={(event) =>
                form.setValue("target_port", event.target.value)
              }
              onBlur={() => void form.trigger("target_port")}
              inputMode="numeric"
              autoComplete="off"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.target_port)}
              className="font-mono tabular-nums"
            />
          </FormField>

          <FormField
            label={t("forwards.form.enabled")}
            htmlFor="forward-enabled"
            hint={t("forwards.form.enabledHint")}
          >
            <div className="flex items-center gap-2.5">
              <Controller
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <Switch
                    id="forward-enabled"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={pending}
                  />
                )}
              />
              <span className="text-xs text-muted-foreground">
                {form.watch("enabled")
                  ? t("forwards.form.enabledOn")
                  : t("forwards.form.enabledOff")}
              </span>
            </div>
          </FormField>

          <FormRootError message={form.formState.errors.root?.message} />
        </form>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="forward-form" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("forwards.form.saving")
              : isEdit
                ? t("forwards.form.submitSave")
                : t("forwards.form.submitCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
