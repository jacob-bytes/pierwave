import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
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
import { PasswordInput } from "@/components/ui/password-input";
import type { UserView } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useUpdateUser } from "@/lib/queries";
import {
  resetPasswordSchema,
  type ResetPasswordValues,
} from "@/lib/schemas";
import { t, useI18n } from "@/i18n";

interface ResetPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserView;
}

export function ResetPasswordDialog({
  open,
  onOpenChange,
  user,
}: ResetPasswordDialogProps) {
  const { t: translate } = useI18n();
  const updateUser = useUpdateUser();
  const schema = useMemo(() => resetPasswordSchema(translate), [translate]);
  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: "" },
  });

  // 切换语言后重新校验，让已显示的错误跟着换语言。
  useEffect(() => {
    if (form.formState.isSubmitted) void form.trigger();
  }, [translate, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      await updateUser.mutateAsync({
        id: user.id,
        input: { password: values.password },
      });
      toast.success(t("users.resetPassword.success", { username: user.username }));
      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, t("users.resetPassword.error"));
      form.setError("root", { message });
      toast.error(message);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("users.resetPassword.title")}</DialogTitle>
          <DialogDescription>
            {t("users.resetPassword.desc", { username: user.username })}
          </DialogDescription>
        </DialogHeader>

        <form id="reset-password-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label={t("users.resetPassword.password")}
            htmlFor="reset-password"
            required
            hint={t("users.resetPassword.passwordHint")}
            error={form.formState.errors.password?.message}
          >
            <PasswordInput
              id="reset-password"
              autoComplete="new-password"
              disabled={updateUser.isPending}
              aria-invalid={Boolean(form.formState.errors.password)}
              {...form.register("password")}
            />
          </FormField>

          <FormRootError message={form.formState.errors.root?.message} />
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateUser.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="reset-password-form"
            disabled={updateUser.isPending}
          >
            {updateUser.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : null}
            {updateUser.isPending
              ? t("users.resetPassword.submitting")
              : t("users.resetPassword.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
