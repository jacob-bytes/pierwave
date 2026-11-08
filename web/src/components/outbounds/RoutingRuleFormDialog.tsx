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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { RoutingRule } from "@/lib/api";
import {
  ANY_INBOUND_TAG,
  outboundErrorText,
} from "@/lib/outbounds";
import {
  useCreateRoutingRule,
  useNodes,
  useOutbounds,
  useRoutingRules,
  useUpdateRoutingRule,
} from "@/lib/queries";
import {
  routingRuleFormSchema,
  type RoutingRuleFormValues,
} from "@/lib/schemas";
import { useI18n } from "@/i18n";

interface RoutingRuleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  mode: "create" | "edit";
  rule?: RoutingRule;
}

const BUILTIN_OUTBOUNDS = ["direct", "blocked"] as const;

export function RoutingRuleFormDialog({
  open,
  onOpenChange,
  serverId,
  mode,
  rule,
}: RoutingRuleFormDialogProps) {
  const { t } = useI18n();
  const isEdit = mode === "edit";
  const createRule = useCreateRoutingRule(serverId);
  const updateRule = useUpdateRoutingRule(serverId);
  const rules = useRoutingRules(serverId);
  const nodes = useNodes(serverId);
  const outbounds = useOutbounds(serverId);
  const pending = isEdit ? updateRule.isPending : createRule.isPending;

  const schema = useMemo(() => routingRuleFormSchema(t), [t]);
  const form = useForm<RoutingRuleFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      inbound_tag:
        rule?.inbound_tag?.trim() || ANY_INBOUND_TAG,
      domain: rule?.domain ?? "",
      ip: rule?.ip ?? "",
      outbound_tag: rule?.outbound_tag?.trim() || "direct",
      enabled: rule ? Boolean(rule.enabled) : true,
    },
  });

  // 切换语言后重新校验，让已显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [t, form]);

  const nodeTags = Array.from(
    new Set((nodes.data ?? []).map((node) => node.tag).filter(Boolean)),
  );
  const selectedInbound = rule?.inbound_tag?.trim() ?? "";
  const inboundOptions =
    selectedInbound && !nodeTags.includes(selectedInbound)
      ? [selectedInbound, ...nodeTags]
      : nodeTags;

  const customOutbounds = outbounds.data ?? [];
  const customTags = customOutbounds.map((item) => item.tag);
  const selectedTarget = rule?.outbound_tag?.trim() ?? "";
  const extraTargets =
    selectedTarget &&
    !(BUILTIN_OUTBOUNDS as readonly string[]).includes(selectedTarget) &&
    !customTags.includes(selectedTarget)
      ? [selectedTarget]
      : [];
  // 已停用的自定义出站也列出来：编辑旧规则时不能悄悄丢掉当前目标。
  const targetOptions = Array.from(
    new Set([...BUILTIN_OUTBOUNDS, ...customTags, ...extraTargets]),
  );
  const disabledTargets = new Set(
    customOutbounds
      .filter((item) => !item.enabled)
      .map((item) => item.tag),
  );

  const inboundHint = nodes.isPending
    ? t("outbounds.rules.form.inboundLoading")
    : nodes.isError
      ? t("outbounds.rules.form.inboundLoadError")
      : nodeTags.length === 0
        ? t("outbounds.rules.form.inboundEmpty")
        : undefined;

  const outboundHint = outbounds.isError
    ? t("outbounds.rules.form.outboundLoadError")
    : undefined;

  const nextSortOrder =
    Math.max(-1, ...(rules.data ?? []).map((item) => item.sort_order)) + 1;

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");

    // 空字符串统一转 null，后端才能真正清掉旧匹配条件。
    const inboundTag =
      values.inbound_tag === ANY_INBOUND_TAG
        ? null
        : values.inbound_tag.trim() || null;
    const domain = values.domain.trim() || null;
    const ip = values.ip.trim() || null;

    try {
      if (isEdit && rule) {
        await updateRule.mutateAsync({
          id: rule.id,
          input: {
            inbound_tag: inboundTag,
            domain,
            ip,
            outbound_tag: values.outbound_tag,
            enabled: values.enabled,
          },
        });
        toast.success(t("outbounds.rules.form.updated"));
      } else {
        await createRule.mutateAsync({
          inbound_tag: inboundTag,
          domain,
          ip,
          outbound_tag: values.outbound_tag,
          sort_order: nextSortOrder,
          enabled: values.enabled,
        });
        toast.success(t("outbounds.rules.form.created"));
      }

      onOpenChange(false);
    } catch (error) {
      const message = outboundErrorText(
        error,
        t("outbounds.rules.form.error"),
      );
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("outbounds.rules.form.editTitle")
              : t("outbounds.rules.form.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? t("outbounds.rules.form.editDesc")
              : t("outbounds.rules.form.createDesc")}
          </DialogDescription>
        </DialogHeader>

        <form id="routing-rule-form" className="space-y-4" onSubmit={onSubmit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label={t("outbounds.rules.form.inbound")}
              htmlFor="routing-rule-inbound"
              error={form.formState.errors.inbound_tag?.message}
              hint={inboundHint}
            >
              <Controller
                control={form.control}
                name="inbound_tag"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={pending || nodes.isPending}
                  >
                    <SelectTrigger
                      id="routing-rule-inbound"
                      className="w-full"
                      aria-invalid={Boolean(
                        form.formState.errors.inbound_tag,
                      )}
                    >
                      <SelectValue
                        placeholder={t("outbounds.rules.form.inboundAny")}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ANY_INBOUND_TAG}>
                        {t("outbounds.rules.form.inboundAny")}
                      </SelectItem>
                      {inboundOptions.map((tag) => (
                        <SelectItem key={tag} value={tag}>
                          {tag}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </FormField>

            <FormField
              label={t("outbounds.rules.form.outbound")}
              htmlFor="routing-rule-outbound"
              required
              error={form.formState.errors.outbound_tag?.message}
              hint={outboundHint}
            >
              <Controller
                control={form.control}
                name="outbound_tag"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={pending}
                  >
                    <SelectTrigger
                      id="routing-rule-outbound"
                      className="w-full"
                      aria-required
                      aria-invalid={Boolean(
                        form.formState.errors.outbound_tag,
                      )}
                      aria-describedby={
                        form.formState.errors.outbound_tag
                          ? "routing-rule-outbound-error"
                          : outboundHint
                            ? "routing-rule-outbound-hint"
                            : undefined
                      }
                    >
                      <SelectValue
                        placeholder={t("outbounds.rules.form.outboundPlaceholder")}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {targetOptions.map((tag) => (
                        <SelectItem key={tag} value={tag}>
                          <span className="font-mono">{tag}</span>
                          {disabledTargets.has(tag)
                            ? ` · ${t("common.disabled")}`
                            : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </FormField>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label={t("outbounds.rules.form.domain")}
              htmlFor="routing-rule-domain"
              error={form.formState.errors.domain?.message}
              hint={t("outbounds.rules.form.domainHint")}
            >
              <Input
                id="routing-rule-domain"
                value={form.watch("domain")}
                onChange={(event) =>
                  form.setValue("domain", event.target.value)
                }
                placeholder={t("outbounds.rules.form.domainPlaceholder")}
                autoComplete="off"
                disabled={pending}
                aria-invalid={Boolean(form.formState.errors.domain)}
              />
            </FormField>

            <FormField
              label={t("outbounds.rules.form.ip")}
              htmlFor="routing-rule-ip"
              error={form.formState.errors.ip?.message}
              hint={t("outbounds.rules.form.ipHint")}
            >
              <Input
                id="routing-rule-ip"
                value={form.watch("ip")}
                onChange={(event) => form.setValue("ip", event.target.value)}
                placeholder={t("outbounds.rules.form.ipPlaceholder")}
                autoComplete="off"
                disabled={pending}
                aria-invalid={Boolean(form.formState.errors.ip)}
              />
            </FormField>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("outbounds.rules.form.conditionHint")}
          </p>

          <FormField
            label={t("outbounds.rules.form.enabled")}
            htmlFor="routing-rule-enabled"
            hint={t("outbounds.rules.form.enabledHint")}
          >
            <div className="flex items-center gap-2.5">
              <Controller
                control={form.control}
                name="enabled"
                render={({ field }) => (
                  <Switch
                    id="routing-rule-enabled"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={pending}
                  />
                )}
              />
              <span className="text-xs text-muted-foreground">
                {form.watch("enabled")
                  ? t("outbounds.rules.form.enabledOn")
                  : t("outbounds.rules.form.enabledOff")}
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
          <Button type="submit" form="routing-rule-form" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("outbounds.rules.form.saving")
              : isEdit
                ? t("outbounds.rules.form.submitSave")
                : t("outbounds.rules.form.submitCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
