import { useEffect, useMemo, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { Outbound, OutboundProtocol } from "@/lib/api";
import { formatJsonObject, parseJsonConfig } from "@/lib/json";
import {
  isOutboundProtocol,
  outboundConfigPlaceholder,
  outboundErrorText,
  outboundProtocolLabel,
  OUTBOUND_PROTOCOLS,
} from "@/lib/outbounds";
import { useCreateOutbound, useUpdateOutbound } from "@/lib/queries";
import { outboundFormSchema, type OutboundFormValues } from "@/lib/schemas";
import { useI18n } from "@/i18n";

interface OutboundFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  mode: "create" | "edit";
  outbound?: Outbound;
}

function initialProtocol(outbound?: Outbound): OutboundProtocol {
  if (outbound && isOutboundProtocol(outbound.protocol)) {
    return outbound.protocol;
  }
  return "socks";
}

export function OutboundFormDialog({
  open,
  onOpenChange,
  serverId,
  mode,
  outbound,
}: OutboundFormDialogProps) {
  const { t } = useI18n();
  const isEdit = mode === "edit";
  const createOutbound = useCreateOutbound(serverId);
  const updateOutbound = useUpdateOutbound(serverId);
  const pending = isEdit ? updateOutbound.isPending : createOutbound.isPending;

  const schema = useMemo(() => outboundFormSchema(t), [t]);
  const form = useForm<OutboundFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      tag: outbound?.tag ?? "",
      protocol: initialProtocol(outbound),
      enabled: outbound ? Boolean(outbound.enabled) : true,
    },
  });

  // 切换语言后重新校验，让已显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [t, form]);

  // 新建时故意留空：协议示例只作为 placeholder，绝不自动填充成真实配置。
  const [configText, setConfigText] = useState(() =>
    isEdit && outbound ? formatJsonObject(outbound.config ?? {}) : "",
  );

  const parsed = useMemo(
    () => parseJsonConfig(configText, t),
    [configText, t],
  );
  const configError = parsed.ok ? undefined : parsed.issue.message;

  const protocol = form.watch("protocol");
  const placeholder = outboundConfigPlaceholder(protocol);
  const showSettingsStreamHint =
    protocol === "vmess" || protocol === "vless";

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    const check = parseJsonConfig(configText, t);
    if (!check.ok) {
      toast.error(check.issue.message);
      return;
    }

    try {
      if (isEdit && outbound) {
        await updateOutbound.mutateAsync({
          id: outbound.id,
          input: {
            tag: values.tag,
            protocol: values.protocol,
            config: check.value,
            enabled: values.enabled,
          },
        });
        toast.success(t("outbounds.form.updated", { tag: values.tag }));
      } else {
        await createOutbound.mutateAsync({
          tag: values.tag,
          protocol: values.protocol,
          config: check.value,
          enabled: values.enabled,
        });
        toast.success(t("outbounds.form.created", { tag: values.tag }));
      }

      onOpenChange(false);
    } catch (error) {
      const message = outboundErrorText(error, t("outbounds.form.error"));
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("outbounds.form.editTitle")
              : t("outbounds.form.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t("outbounds.form.editDesc")
              : t("outbounds.form.createDesc")}
          </DialogDescription>
        </DialogHeader>

        <form id="outbound-form" className="space-y-4" onSubmit={onSubmit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label={t("outbounds.form.tag")}
              htmlFor="outbound-tag"
              required
              error={form.formState.errors.tag?.message}
              hint={t("outbounds.form.tagHint")}
            >
              <Input
                id="outbound-tag"
                value={form.watch("tag")}
                onChange={(event) => form.setValue("tag", event.target.value)}
                onBlur={() => void form.trigger("tag")}
                placeholder={t("outbounds.form.tagPlaceholder")}
                autoComplete="off"
                disabled={pending}
                aria-invalid={Boolean(form.formState.errors.tag)}
              />
            </FormField>

            <FormField
              label={t("outbounds.form.protocol")}
              htmlFor="outbound-protocol"
              required
              error={form.formState.errors.protocol?.message}
            >
              <Controller
                control={form.control}
                name="protocol"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={(value) =>
                      field.onChange(value as OutboundProtocol)
                    }
                    disabled={pending}
                  >
                    <SelectTrigger
                      id="outbound-protocol"
                      className="w-full"
                      aria-required
                      aria-invalid={Boolean(form.formState.errors.protocol)}
                      aria-describedby={
                        form.formState.errors.protocol
                          ? "outbound-protocol-error"
                          : undefined
                      }
                    >
                      <SelectValue
                        placeholder={t("outbounds.form.protocolPlaceholder")}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {OUTBOUND_PROTOCOLS.map((item) => (
                        <SelectItem key={item} value={item}>
                          {outboundProtocolLabel(item)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </FormField>
          </div>

          <FormField
            label={t("outbounds.form.enabled")}
            htmlFor="outbound-enabled"
            hint={t("outbounds.form.enabledHint")}
          >
            <div className="flex items-center gap-2.5">
              <Controller
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <Switch
                    id="outbound-enabled"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={pending}
                  />
                )}
              />
              <span className="text-xs text-muted-foreground">
                {form.watch("enabled")
                  ? t("outbounds.form.enabledOn")
                  : t("outbounds.form.enabledOff")}
              </span>
            </div>
          </FormField>

          <FormField
            label={t("outbounds.form.config")}
            htmlFor="outbound-config"
            required
            error={configError}
            hint={
              parsed.ok
                ? t("outbounds.form.configValid", {
                    n: configText.split("\n").length,
                  })
                : undefined
            }
          >
            <div className="space-y-2">
              <Textarea
                id="outbound-config"
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                disabled={pending}
                aria-invalid={!parsed.ok}
                className="min-h-56 resize-y font-mono text-xs leading-normal"
              />
              <p className="text-micro leading-normal text-muted-foreground">
                {t("outbounds.form.configPlaceholderHint")}
              </p>
              {showSettingsStreamHint ? (
                <p className="text-micro leading-normal text-muted-foreground">
                  {t("outbounds.form.placeholderSettingsStream")}
                </p>
              ) : null}
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
          <Button
            type="submit"
            form="outbound-form"
            disabled={pending || !parsed.ok}
          >
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("outbounds.form.saving")
              : isEdit
                ? t("outbounds.form.submitSave")
                : t("outbounds.form.submitCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
