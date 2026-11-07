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
import type { UpdateUserInput, UserView } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { bytesToGbInput, parseGbInput } from "@/lib/format";
import { ruleTemplateInputValue } from "@/lib/ruleBindings";
import { useCreateUser, useMe, useRuleTemplates, useUpdateUser } from "@/lib/queries";
import { ruleTemplateErrorText } from "@/lib/ruleTemplates";
import {
  userFormSchema,
  type UserFormMode,
  type UserFormValues,
} from "@/lib/schemas";
import { t, useI18n } from "@/i18n";

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: UserFormMode;
  user?: UserView;
}

export function UserFormDialog({
  open,
  onOpenChange,
  mode,
  user,
}: UserFormDialogProps) {
  const { t: translate } = useI18n();
  const me = useMe();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const ruleTemplates = useRuleTemplates();
  const templates = ruleTemplates.data ?? [];
  const ruleTemplateError =
    ruleTemplates.isError && templates.length === 0
      ? ruleTemplateErrorText(ruleTemplates.error)
      : null;
  const pending =
    mode === "create" ? createUser.isPending : updateUser.isPending;
  const isSelf = mode === "edit" && Boolean(user) && user?.id === me.data?.id;

  const schema = useMemo(() => userFormSchema(translate, mode), [translate, mode]);
  const form = useForm<UserFormValues>({
    resolver: zodResolver(schema),
    defaultValues:
      mode === "edit" && user
        ? {
            username: user.username,
            password: "",
            role: user.role,
            quota_gb: bytesToGbInput(user.quota_bytes),
            rule_template_id: user.rule_template_id ?? "",
          }
        : {
            username: "",
            password: "",
            role: "user",
            quota_gb: "",
            rule_template_id: "",
          },
  });

  // 切换语言后重新校验，让已显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      const quotaBytes = parseGbInput(values.quota_gb);
      // 空选项 → 显式 null（回落到套餐 / 全局默认），而不是省略字段。
      const ruleTemplateId = ruleTemplateInputValue(values.rule_template_id);

      if (mode === "create") {
        await createUser.mutateAsync({
          username: values.username,
          password: values.password,
          role: values.role,
          quota_bytes: quotaBytes,
          rule_template_id: ruleTemplateId,
        });
        toast.success(t("users.form.created", { name: values.username }));
      } else if (user) {
        const input: UpdateUserInput = {
          role: values.role,
          quota_bytes: quotaBytes,
          rule_template_id: ruleTemplateId,
        };
        if (values.password) input.password = values.password;
        await updateUser.mutateAsync({ id: user.id, input });
        toast.success(t("users.form.updated"));
      }

      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, t("users.form.error"));
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
            {mode === "create" ? t("users.form.createTitle") : t("users.form.editTitle")}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? t("users.form.createDesc")
              : t("users.form.editDesc")}
          </DialogDescription>
        </DialogHeader>

        <form id="user-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label={t("users.form.username")}
            htmlFor="user-username"
            required
            error={form.formState.errors.username?.message}
          >
            <Input
              id="user-username"
              autoComplete="off"
              disabled={mode === "edit" || pending}
              aria-invalid={Boolean(form.formState.errors.username)}
              {...form.register("username")}
            />
          </FormField>

          <FormField
            label={t("users.form.password")}
            htmlFor="user-password"
            required={mode === "create"}
            hint={
              mode === "create"
                ? t("users.form.passwordHintCreate")
                : t("users.form.passwordHintEdit")
            }
            error={form.formState.errors.password?.message}
          >
            <Input
              id="user-password"
              type="password"
              autoComplete="new-password"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.password)}
              {...form.register("password")}
            />
          </FormField>

          <FormField
            label={t("users.form.role")}
            htmlFor="user-role"
            error={form.formState.errors.role?.message}
            hint={
              isSelf ? t("users.form.roleSelfHint") : undefined
            }
          >
            <Controller
              control={form.control}
              name="role"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={isSelf || pending}
                >
                  <SelectTrigger
                    id="user-role"
                    className="w-full"
                    aria-invalid={Boolean(form.formState.errors.role)}
                  >
                    <SelectValue placeholder={t("users.form.rolePlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">{t("roles.user")}</SelectItem>
                    <SelectItem value="admin">{t("roles.admin")}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>

          <FormField
            label={t("users.form.quota")}
            htmlFor="user-quota"
            hint={t("users.form.quotaHint")}
            error={form.formState.errors.quota_gb?.message}
          >
            <Input
              id="user-quota"
              inputMode="decimal"
              placeholder={t("users.form.quotaPlaceholder")}
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.quota_gb)}
              {...form.register("quota_gb")}
            />
          </FormField>

          <FormField
            label={t("users.form.ruleTemplate")}
            htmlFor="user-rule-template"
            hint={t("users.form.ruleTemplateHint")}
            error={form.formState.errors.rule_template_id?.message}
          >
            <Controller
              control={form.control}
              name="rule_template_id"
              render={({ field }) => (
                <RuleTemplateBindingField
                  id="user-rule-template"
                  value={field.value}
                  onChange={field.onChange}
                  templates={templates}
                  pending={ruleTemplates.isPending}
                  error={ruleTemplateError}
                  disabled={pending}
                  inheritLabel={t("users.form.ruleTemplateInherit")}
                  loadingLabel={t("users.form.ruleTemplateLoading")}
                  currentLabel={t("users.form.ruleTemplateCurrent")}
                  ariaLabel={t("users.form.ruleTemplate")}
                />
              )}
            />
          </FormField>

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
          <Button type="submit" form="user-form" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? t("common.saving")
              : mode === "create"
                ? t("users.form.submitCreate")
                : t("users.form.submitSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
