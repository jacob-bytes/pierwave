import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import type { Forward, Server } from "@/lib/api";
import {
  FORWARD_ENGINES,
  engineInput,
  isForwardEngine,
  nftablesMissingOnServer,
  normalizeEngine,
  realmMissingOnServer,
} from "@/lib/engines";
import { errorText } from "@/lib/errors";
import {
  DEFAULT_PROTOCOL,
  PROTOCOL_MODES,
  normalizeProtocol,
  protocolAvailable,
} from "@/lib/protocolMode";
import { useCreateForward, useUpdateForward } from "@/lib/queries";
import { forwardFormSchema, type ForwardFormValues } from "@/lib/schemas";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";

interface ForwardFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  /** 规则所属服务器；用于在保存前提示「这台机器没装 realm」。 */
  server?: Server | null;
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
  server,
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
      // 旧数据 / 旧后端没有 engine：按契约缺省 native 回填。
      engine: normalizeEngine(forward?.engine),
      // 旧数据 / 旧后端没有 protocol：旧 udp:true 按 both 回填，否则 tcp。
      protocol: normalizeProtocol(forward?.protocol, forward?.udp),
    },
  });
  const selectedEngine = form.watch("engine");
  const selectedProtocol = form.watch("protocol");
  const availability = protocolAvailable(selectedEngine);
  // 静态事实：这台服务器明确没装 realm 时，保存前就告诉用户；
  // `null` / 缺失（旧 Agent）不提示，避免误报。不阻止保存。
  const realmUnavailable = realmMissingOnServer(selectedEngine, server);
  // nftables 必须由 Agent 明确上报可用；未知（离线 / 旧 Agent）也提示。
  const nftablesUnavailable = nftablesMissingOnServer(selectedEngine, server);

  // 引擎改动可能让当前协议失效（realm 不接受仅 UDP）：立即回落到 tcp，
  // 避免留下「禁用但仍选中」的无效状态。
  useEffect(() => {
    if (availability[selectedProtocol]) return;
    form.setValue("protocol", DEFAULT_PROTOCOL, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: form.formState.isSubmitted,
    });
  }, [
    availability.tcp,
    availability.udp,
    availability.both,
    selectedProtocol,
    form,
  ]);

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
      // native 也显式发送：edit 时把 realm 改回 native 必须带字段，
      // 否则 PATCH 的缺省语义是「不改」。
      ...engineInput(values.engine),
      // 协议是权威字段；无效组合（引擎切换瞬间）回落 tcp。
      protocol: protocolAvailable(values.engine)[values.protocol]
        ? values.protocol
        : DEFAULT_PROTOCOL,
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
            label={t("forwards.form.engine")}
            hint={t("forwards.form.engineHint")}
          >
            <div className="space-y-2">
              <RadioGroup
                aria-label={t("forwards.form.engineAria")}
                value={selectedEngine}
                onValueChange={(next) => {
                  if (!isForwardEngine(next)) return;
                  form.setValue("engine", next, {
                    shouldDirty: true,
                    shouldTouch: true,
                    shouldValidate: true,
                  });
                  // realm 固定双开：先把仅 UDP 收回 tcp，再等 effect 兜底。
                  if (
                    next === "realm" &&
                    form.getValues("protocol") === "udp"
                  ) {
                    form.setValue("protocol", DEFAULT_PROTOCOL, {
                      shouldDirty: true,
                      shouldTouch: true,
                      shouldValidate: true,
                    });
                  }
                }}
                disabled={pending}
                className="grid gap-2 sm:grid-cols-2"
              >
                {FORWARD_ENGINES.map((engine) => {
                  const active = selectedEngine === engine;
                  return (
                    <Label
                      key={engine}
                      htmlFor={`forward-engine-${engine}`}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-2.5 transition-colors duration-150 hover:bg-muted/40",
                        active &&
                          "border-primary/60 bg-primary/5 hover:bg-primary/5",
                        engine === "nftables" && "sm:col-span-2",
                        pending && "cursor-not-allowed opacity-60",
                      )}
                    >
                      <RadioGroupItem
                        id={`forward-engine-${engine}`}
                        value={engine}
                        disabled={pending}
                        className="mt-0.5"
                      />
                      <span className="min-w-0 space-y-0.5">
                        <span className="block text-sm font-medium">
                          {t(`common.engine.${engine}.label`)}
                        </span>
                        <span className="block type-micro leading-normal text-muted-foreground">
                          {t(`common.engine.${engine}.short`)}
                        </span>
                      </span>
                    </Label>
                  );
                })}
              </RadioGroup>
              {/* 随选择切换的完整说明：native 不支持 UDP / realm 支持 UDP 与权重。 */}
              <p className="rounded-md border border-border bg-muted/20 px-2.5 py-2 type-micro leading-normal text-muted-foreground">
                {t(`common.engine.${selectedEngine}.desc`)}
              </p>
              {realmUnavailable ? (
                <div
                  role="status"
                  className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-normal text-warning"
                >
                  <TriangleAlertIcon
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{t("forwards.form.realmNotInstalled")}</span>
                </div>
              ) : null}
              {nftablesUnavailable ? (
                <div
                  role="status"
                  className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-normal text-warning"
                >
                  <TriangleAlertIcon
                    className="mt-0.5 size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{t("common.engine.nftables.notAvailable")}</span>
                </div>
              ) : null}
            </div>
          </FormField>

          <FormField
            label={t("common.protocolMode.label")}
            error={form.formState.errors.protocol?.message}
          >
            <RadioGroup
              aria-label={t("common.protocolMode.label")}
              value={selectedProtocol}
              onValueChange={(next) => {
                if (!availability[next as keyof typeof availability]) return;
                form.setValue("protocol", next as typeof selectedProtocol, {
                  shouldDirty: true,
                  shouldTouch: true,
                  shouldValidate: form.formState.isSubmitted,
                });
              }}
              disabled={pending}
              className="grid gap-2 sm:grid-cols-3"
            >
              {PROTOCOL_MODES.map((mode) => {
                const active = selectedProtocol === mode;
                const disabled = pending || !availability[mode];
                return (
                  <Label
                    key={mode}
                    htmlFor={`forward-protocol-${mode}`}
                    title={
                      availability[mode]
                        ? undefined
                        : t("common.udpRealmTitle")
                    }
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 transition-colors duration-150 hover:bg-muted/40",
                      active &&
                        "border-primary/60 bg-primary/5 hover:bg-primary/5",
                      disabled && "cursor-not-allowed opacity-60",
                    )}
                  >
                    <RadioGroupItem
                      id={`forward-protocol-${mode}`}
                      value={mode}
                      disabled={disabled}
                    />
                    <span className="text-sm font-medium">
                      {t(`common.protocolMode.${mode}`)}
                    </span>
                  </Label>
                );
              })}
            </RadioGroup>
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
