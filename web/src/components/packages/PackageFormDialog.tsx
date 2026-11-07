import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { FormField, FormRootError } from "@/components/FormField";
import { RuleTemplateBindingField } from "@/components/rules/RuleTemplateBindingField";
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
import { PackageNodeScopeField } from "@/components/packages/PackageNodeScopeField";
import type { CreatePackageInput, Package } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { bytesToGbInput, parseGbInput } from "@/lib/format";
import { ruleTemplateInputValue } from "@/lib/ruleBindings";
import { useCreatePackage, useRuleTemplates, useUpdatePackage } from "@/lib/queries";
import { ruleTemplateErrorText } from "@/lib/ruleTemplates";
import {
  packageFormSchema,
  type PackageFormValues,
  type PackageNodeScope,
} from "@/lib/schemas";
import { t, useI18n } from "@/i18n";

interface PackageFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packageItem?: Package;
}

/**
 * 回填三态：直接看后端给的 `node_scope`。
 *
 * 不再从 `node_ids` / `node_count` 反推：系统里一个节点都没有时，
 * 「全部」与「一个都不给」会得到同样的空数组和 0，无法区分。
 * `all` → 全部；`custom` 且 node_ids 非空 → 指定；`custom` 且为空 → 不给。
 */
function packageNodeScope(item: Package): PackageNodeScope {
  if (item.node_scope === "all") return "all";
  return item.node_ids.length > 0 ? "selected" : "none";
}

export function PackageFormDialog({
  open,
  onOpenChange,
  packageItem,
}: PackageFormDialogProps) {
  const { t: translate } = useI18n();
  const createPackage = useCreatePackage();
  const updatePackage = useUpdatePackage();
  const ruleTemplates = useRuleTemplates();
  const templates = ruleTemplates.data ?? [];
  const ruleTemplateError =
    ruleTemplates.isError && templates.length === 0
      ? ruleTemplateErrorText(ruleTemplates.error)
      : null;
  const editing = Boolean(packageItem);
  const pending = editing
    ? updatePackage.isPending
    : createPackage.isPending;

  const schema = useMemo(() => packageFormSchema(translate), [translate]);
  const form = useForm<PackageFormValues>({
    resolver: zodResolver(schema),
    defaultValues: packageItem
      ? {
          name: packageItem.name,
          quota_gb: bytesToGbInput(packageItem.quota_bytes),
          period_days: packageItem.period_days
            ? String(packageItem.period_days)
            : "",
          direction: packageItem.direction,
          node_ratio: String(packageItem.node_ratio),
          node_scope: packageNodeScope(packageItem),
          node_ids: packageItem.node_ids,
          rule_template_id: packageItem.rule_template_id ?? "",
        }
      : {
          name: "",
          quota_gb: "",
          period_days: "",
          direction: "both",
          node_ratio: "1",
          node_scope: "all",
          node_ids: [],
          rule_template_id: "",
        },
  });

  // 切换语言后重新校验，让已显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

  const nodeScope = form.watch("node_scope");
  const selectedNodeIds = form.watch("node_ids");
  const nodeScopeError =
    form.formState.errors.node_scope?.message ??
    form.formState.errors.node_ids?.message;

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");

    // 三态转换：全部 → 新建省略 / 编辑传 null；指定 → 数组；不给 → 空数组。
    const scopeFields: Pick<CreatePackageInput, "node_ids"> =
      values.node_scope === "selected"
        ? { node_ids: values.node_ids }
        : values.node_scope === "none"
          ? { node_ids: [] }
          : {};

    const input: CreatePackageInput = {
      name: values.name,
      quota_bytes: parseGbInput(values.quota_gb),
      period_days: values.period_days.trim()
        ? Number(values.period_days)
        : null,
      direction: values.direction,
      node_ratio: Number(values.node_ratio),
      // 空选项 → 显式 null（回落到全局默认），而不是省略字段。
      rule_template_id: ruleTemplateInputValue(values.rule_template_id),
      ...scopeFields,
    };

    try {
      if (packageItem) {
        await updatePackage.mutateAsync({
          id: packageItem.id,
          input:
            values.node_scope === "all"
              ? { ...input, node_ids: null }
              : input,
        });
        toast.success(t("packages.form.updated"));
      } else {
        await createPackage.mutateAsync(input);
        toast.success(t("packages.form.created", { name: values.name }));
      }
      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, t("packages.form.error"));
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
            {editing ? t("packages.form.editTitle") : t("packages.form.createTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("packages.form.desc")}
          </DialogDescription>
        </DialogHeader>

        <form id="package-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label={t("packages.form.name")}
            htmlFor="package-name"
            required
            error={form.formState.errors.name?.message}
          >
            <Input
              id="package-name"
              placeholder={t("packages.form.namePlaceholder")}
              autoComplete="off"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.name)}
              {...form.register("name")}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("packages.form.quota")}
              htmlFor="package-quota"
              hint={t("packages.form.quotaHint")}
              error={form.formState.errors.quota_gb?.message}
            >
              <Input
                id="package-quota"
                inputMode="decimal"
                placeholder={t("packages.form.quotaPlaceholder")}
                disabled={pending}
                aria-invalid={Boolean(form.formState.errors.quota_gb)}
                {...form.register("quota_gb")}
              />
            </FormField>

            <FormField
              label={t("packages.form.period")}
              htmlFor="package-period"
              hint={t("packages.form.periodHint")}
              error={form.formState.errors.period_days?.message}
            >
              <Input
                id="package-period"
                inputMode="numeric"
                placeholder={t("packages.form.periodPlaceholder")}
                disabled={pending}
                aria-invalid={Boolean(form.formState.errors.period_days)}
                {...form.register("period_days")}
              />
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label={t("packages.form.direction")}
              htmlFor="package-direction"
              error={form.formState.errors.direction?.message}
            >
              <Controller
                control={form.control}
                name="direction"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={pending}
                  >
                    <SelectTrigger id="package-direction" className="w-full">
                      <SelectValue placeholder={t("packages.form.directionPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="both">{t("direction.both")}</SelectItem>
                      <SelectItem value="upload">{t("direction.upload")}</SelectItem>
                      <SelectItem value="download">
                        {t("direction.download")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </FormField>

            <FormField
              label={t("packages.form.ratio")}
              htmlFor="package-ratio"
              hint={t("packages.form.ratioHint")}
              error={form.formState.errors.node_ratio?.message}
            >
              <Input
                id="package-ratio"
                inputMode="decimal"
                disabled={pending}
                aria-invalid={Boolean(form.formState.errors.node_ratio)}
                {...form.register("node_ratio")}
              />
            </FormField>
          </div>

          <FormField
            label={t("packages.form.ruleTemplate")}
            htmlFor="package-rule-template"
            hint={t("packages.form.ruleTemplateHint")}
            error={form.formState.errors.rule_template_id?.message}
          >
            <Controller
              control={form.control}
              name="rule_template_id"
              render={({ field }) => (
                <RuleTemplateBindingField
                  id="package-rule-template"
                  value={field.value}
                  onChange={field.onChange}
                  templates={templates}
                  pending={ruleTemplates.isPending}
                  error={ruleTemplateError}
                  disabled={pending}
                  inheritLabel={t("packages.form.ruleTemplateInherit")}
                  loadingLabel={t("packages.form.ruleTemplateLoading")}
                  currentLabel={t("packages.form.ruleTemplateCurrent")}
                  ariaLabel={t("packages.form.ruleTemplate")}
                />
              )}
            />
          </FormField>

          <div className="border-t border-border pt-4">
            <FormField
              label={t("packages.form.scope")}
              hint={
                nodeScope === "selected"
                  ? t("packages.form.scopeSelectedHint")
                  : t("packages.form.scopeHint")
              }
              error={nodeScopeError}
            >
              <Controller
                control={form.control}
                name="node_scope"
                render={({ field }) => (
                  <PackageNodeScopeField
                    value={field.value}
                    disabled={pending}
                    onChange={(next) => {
                      field.onChange(next);
                      if (next !== "selected") {
                        form.clearErrors("node_ids");
                      }
                    }}
                    selectedIds={selectedNodeIds}
                    onSelectedChange={(ids) => {
                      form.setValue("node_ids", ids, {
                        shouldDirty: true,
                        shouldValidate: Boolean(
                          form.formState.errors.node_ids,
                        ),
                      });
                    }}
                  />
                )}
              />
            </FormField>
          </div>

          <FormRootError message={form.formState.errors.root?.message} />
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="package-form" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("common.saving")
              : editing
                ? t("packages.form.submitSave")
                : t("packages.form.submitCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
