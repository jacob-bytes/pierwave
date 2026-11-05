import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRoundIcon, Loader2Icon } from "lucide-react";
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
import { ApiError } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useChangePassword } from "@/lib/queries";
import {
  changePasswordSchema,
  type ChangePasswordValues,
} from "@/lib/schemas";
import { t, useI18n } from "@/i18n";

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 接口与后端并行开发：404 兜底成中文，其余错误优先透出后端文案。 */
function changePasswordErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 404) {
    return t("changePassword.notReady404");
  }
  return errorText(error, fallback);
}

/**
 * 当前登录用户改密码：管理员与普通用户共用。
 *
 * 成功后后端会吊销其它设备、保留当前会话，因此这里不跳登录页；
 * 只清掉缓存里的旧数据，并提示「当前会话仍然有效」。
 */
export function ChangePasswordDialog({
  open,
  onOpenChange,
}: ChangePasswordDialogProps) {
  const { t: translate } = useI18n();
  const changePassword = useChangePassword();
  const schema = useMemo(() => changePasswordSchema(translate), [translate]);
  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      old_password: "",
      new_password: "",
      confirm_password: "",
    },
  });

  // 切换语言后重新校验，让已显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      await changePassword.mutateAsync({
        old_password: values.old_password,
        new_password: values.new_password,
      });
      form.reset();
      toast.success(t("changePassword.success"), {
        description: t("changePassword.successDesc"),
        duration: 6000,
      });
      onOpenChange(false);
    } catch (error) {
      const message = changePasswordErrorText(
        error,
        t("changePassword.error"),
      );
      form.setError("root", { message });
      toast.error(message);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && changePassword.isPending) return;
        if (!next) form.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
              <KeyRoundIcon className="size-3.5" />
            </span>
            {t("changePassword.title")}
          </DialogTitle>
          <DialogDescription>
            {t("changePassword.desc")}
          </DialogDescription>
        </DialogHeader>

        <form
          id="change-password-form"
          className="space-y-4"
          onSubmit={onSubmit}
        >
          <FormField
            label={t("changePassword.current")}
            htmlFor="change-password-old"
            required
            error={form.formState.errors.old_password?.message}
          >
            <Input
              id="change-password-old"
              type="password"
              autoComplete="current-password"
              disabled={changePassword.isPending}
              aria-invalid={Boolean(form.formState.errors.old_password)}
              {...form.register("old_password")}
            />
          </FormField>

          <FormField
            label={t("changePassword.next")}
            htmlFor="change-password-new"
            required
            hint={t("changePassword.nextHint")}
            error={form.formState.errors.new_password?.message}
          >
            <Input
              id="change-password-new"
              type="password"
              autoComplete="new-password"
              disabled={changePassword.isPending}
              aria-invalid={Boolean(form.formState.errors.new_password)}
              {...form.register("new_password")}
            />
          </FormField>

          <FormField
            label={t("changePassword.confirm")}
            htmlFor="change-password-confirm"
            required
            error={form.formState.errors.confirm_password?.message}
          >
            <Input
              id="change-password-confirm"
              type="password"
              autoComplete="new-password"
              disabled={changePassword.isPending}
              aria-invalid={Boolean(form.formState.errors.confirm_password)}
              {...form.register("confirm_password")}
            />
          </FormField>

          <FormRootError message={form.formState.errors.root?.message} />
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={changePassword.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="change-password-form"
            disabled={changePassword.isPending}
          >
            {changePassword.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : null}
            {changePassword.isPending
              ? t("changePassword.submitting")
              : t("changePassword.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
