import { useEffect, useMemo } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ListFilterIcon, Loader2Icon } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { CreateRuleTemplateInput, RuleTemplate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import {
  parseRuleLines,
  RULE_TEMPLATE_EXAMPLE,
} from "@/lib/ruleTemplates";
import { useCreateRuleTemplate, useUpdateRuleTemplate } from "@/lib/queries";
import {
  ruleTemplateFormSchema,
  type RuleTemplateFormValues,
} from "@/lib/schemas";
import { t, useI18n } from "@/i18n";

interface RuleTemplateFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template?: RuleTemplate;
}

export function RuleTemplateFormDialog({
  open,
  onOpenChange,
  template,
}: RuleTemplateFormDialogProps) {
  const { t: translate } = useI18n();
  const createTemplate = useCreateRuleTemplate();
  const updateTemplate = useUpdateRuleTemplate();
  const editing = Boolean(template);
  const pending = editing
    ? updateTemplate.isPending
    : createTemplate.isPending;

  const schema = useMemo(() => ruleTemplateFormSchema(translate), [translate]);
  const form = useForm<RuleTemplateFormValues>({
    resolver: zodResolver(schema),
    mode: "onTouched",
    defaultValues: template
      ? {
          name: template.name,
          description: template.description,
          rules_text: template.rules.join("\n"),
          is_default: template.is_default,
        }
      : {
          name: "",
          description: "",
          rules_text: "",
          is_default: false,
        },
  });

  // 切换语言后重新校验，让已显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");

    const input: CreateRuleTemplateInput = {
      name: values.name,
      description: values.description.trim(),
      // 与校验使用同一份拆分结果：按行切、trim、丢空行。
      rules: parseRuleLines(values.rules_text),
      is_default: values.is_default,
    };

    try {
      if (template) {
        await updateTemplate.mutateAsync({ id: template.id, input });
        toast.success(t("rules.form.updated"));
      } else {
        await createTemplate.mutateAsync(input);
        toast.success(t("rules.form.created", { name: input.name }));
      }
      onOpenChange(false);
    } catch (error) {
      // 后端中文错误（名称重复、校验失败）原样透出到表单与 toast。
      const message = errorText(error, t("rules.form.error"));
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
          <DialogTitle className="flex items-center gap-2">
            <ListFilterIcon className="size-4 text-primary" />
            {editing
              ? t("rules.form.editTitle")
              : t("rules.form.createTitle")}
          </DialogTitle>
          <DialogDescription>{t("rules.form.desc")}</DialogDescription>
        </DialogHeader>

        <form id="rule-template-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label={t("rules.form.name")}
            htmlFor="rule-template-name"
            required
            error={form.formState.errors.name?.message}
          >
            <Input
              id="rule-template-name"
              placeholder={t("rules.form.namePlaceholder")}
              autoComplete="off"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.name)}
              {...form.register("name")}
            />
          </FormField>

          <FormField
            label={t("rules.form.description")}
            htmlFor="rule-template-description"
            error={form.formState.errors.description?.message}
          >
            <Input
              id="rule-template-description"
              placeholder={t("rules.form.descriptionPlaceholder")}
              autoComplete="off"
              disabled={pending}
              {...form.register("description")}
            />
          </FormField>

          <FormField
            label={t("rules.form.rules")}
            htmlFor="rule-template-rules"
            required
            error={form.formState.errors.rules_text?.message}
            hint={
              <div className="space-y-1.5">
                <p>{t("rules.form.rulesHint")}</p>
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {RULE_TEMPLATE_EXAMPLE}
                </pre>
                <p>{t("rules.form.matchHint")}</p>
              </div>
            }
          >
            <Textarea
              id="rule-template-rules"
              rows={8}
              spellCheck={false}
              placeholder={t("rules.form.rulesPlaceholder")}
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.rules_text)}
              className="max-h-80 min-h-40 resize-y font-mono text-xs leading-relaxed"
              {...form.register("rules_text")}
            />
          </FormField>

          <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
            <div className="space-y-1">
              <Label htmlFor="rule-template-default">
                {t("rules.form.default")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("rules.form.defaultHint")}
              </p>
            </div>
            <Controller
              control={form.control}
              name="is_default"
              render={({ field }) => (
                <Switch
                  id="rule-template-default"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={pending}
                  className="mt-0.5"
                />
              )}
            />
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
          <Button type="submit" form="rule-template-form" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("common.saving")
              : editing
                ? t("rules.form.submitSave")
                : t("rules.form.submitCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
