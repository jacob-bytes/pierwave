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

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 接口与后端并行开发：404 兜底成中文，其余错误优先透出后端文案。 */
function changePasswordErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError && error.status === 404) {
    return "修改密码接口尚未就绪（后端可能还在部署），请稍后重试";
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
  const changePassword = useChangePassword();
  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: {
      old_password: "",
      new_password: "",
      confirm_password: "",
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      await changePassword.mutateAsync({
        old_password: values.old_password,
        new_password: values.new_password,
      });
      form.reset();
      toast.success("密码已修改，其它设备已下线", {
        description: "当前设备的会话仍然有效，无需重新登录。",
        duration: 6000,
      });
      onOpenChange(false);
    } catch (error) {
      const message = changePasswordErrorText(
        error,
        "修改密码失败，请稍后重试",
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
            修改密码
          </DialogTitle>
          <DialogDescription>
            修改成功后，除当前设备外的其它登录会话会立即下线；当前会话保持有效。
          </DialogDescription>
        </DialogHeader>

        <form
          id="change-password-form"
          className="space-y-4"
          onSubmit={onSubmit}
        >
          <FormField
            label="当前密码"
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
            label="新密码"
            htmlFor="change-password-new"
            required
            hint="至少 8 位，且不能与当前密码相同"
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
            label="确认新密码"
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
            取消
          </Button>
          <Button
            type="submit"
            form="change-password-form"
            disabled={changePassword.isPending}
          >
            {changePassword.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : null}
            {changePassword.isPending ? "提交中…" : "确认修改"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
