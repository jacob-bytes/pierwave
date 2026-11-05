import { useMemo } from "react";
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
import type { UpdateUserInput, UserView } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { bytesToGbInput, parseGbInput } from "@/lib/format";
import { useCreateUser, useMe, useUpdateUser } from "@/lib/queries";
import {
  userFormSchema,
  type UserFormMode,
  type UserFormValues,
} from "@/lib/schemas";

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
  const me = useMe();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const pending =
    mode === "create" ? createUser.isPending : updateUser.isPending;
  const isSelf = mode === "edit" && Boolean(user) && user?.id === me.data?.id;

  const schema = useMemo(() => userFormSchema(mode), [mode]);
  const form = useForm<UserFormValues>({
    resolver: zodResolver(schema),
    defaultValues:
      mode === "edit" && user
        ? {
            username: user.username,
            password: "",
            role: user.role,
            quota_gb: bytesToGbInput(user.quota_bytes),
          }
        : {
            username: "",
            password: "",
            role: "user",
            quota_gb: "",
          },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      const quotaBytes = parseGbInput(values.quota_gb);

      if (mode === "create") {
        await createUser.mutateAsync({
          username: values.username,
          password: values.password,
          role: values.role,
          quota_bytes: quotaBytes,
        });
        toast.success(`用户「${values.username}」已创建`);
      } else if (user) {
        const input: UpdateUserInput = {
          role: values.role,
          quota_bytes: quotaBytes,
        };
        if (values.password) input.password = values.password;
        await updateUser.mutateAsync({ id: user.id, input });
        toast.success("用户已更新");
      }

      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, "保存用户失败，请稍后重试");
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
          <DialogTitle>{mode === "create" ? "新建用户" : "编辑用户"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "创建后可在「管理套餐」里绑定流量卡。"
              : "用户名创建后不可修改；密码留空表示不修改。"}
          </DialogDescription>
        </DialogHeader>

        <form id="user-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label="用户名"
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
            label="密码"
            htmlFor="user-password"
            required={mode === "create"}
            hint={
              mode === "create"
                ? "至少 8 位"
                : "留空表示不修改；填写时至少 8 位"
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
            label="角色"
            htmlFor="user-role"
            error={form.formState.errors.role?.message}
            hint={
              isSelf ? "不能把自己的角色降级，避免锁死后台。" : undefined
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
                    <SelectValue placeholder="选择角色" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">普通用户</SelectItem>
                    <SelectItem value="admin">管理员</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>

          <FormField
            label="总额度（GB）"
            htmlFor="user-quota"
            hint="留空表示不限；按 1024³ 换算。"
            error={form.formState.errors.quota_gb?.message}
          >
            <Input
              id="user-quota"
              inputMode="decimal"
              placeholder="例如 100"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.quota_gb)}
              {...form.register("quota_gb")}
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
            取消
          </Button>
          <Button type="submit" form="user-form" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? "保存中…"
              : mode === "create"
                ? "创建用户"
                : "保存修改"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
