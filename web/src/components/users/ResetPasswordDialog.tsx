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
import { Input } from "@/components/ui/input";
import type { UserView } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useUpdateUser } from "@/lib/queries";
import {
  resetPasswordSchema,
  type ResetPasswordValues,
} from "@/lib/schemas";

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
  const updateUser = useUpdateUser();
  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      await updateUser.mutateAsync({
        id: user.id,
        input: { password: values.password },
      });
      toast.success(`已重置「${user.username}」的密码`);
      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, "重置密码失败，请稍后重试");
      form.setError("root", { message });
      toast.error(message);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription>
            为「{user.username}」设置新密码。重置后旧会话不会被立即踢下线。
          </DialogDescription>
        </DialogHeader>

        <form id="reset-password-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label="新密码"
            htmlFor="reset-password"
            required
            hint="至少 8 位"
            error={form.formState.errors.password?.message}
          >
            <Input
              id="reset-password"
              type="password"
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
            取消
          </Button>
          <Button
            type="submit"
            form="reset-password-form"
            disabled={updateUser.isPending}
          >
            {updateUser.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : null}
            {updateUser.isPending ? "重置中…" : "重置密码"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
