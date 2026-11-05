import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  CalendarIcon,
  Loader2Icon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  UnlinkIcon,
} from "lucide-react";
import { FormField, FormRootError } from "@/components/FormField";
import { PackageStatusBadge } from "@/components/packages/PackageStatusBadge";
import { UsageBar } from "@/components/UsageBar";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  UpdateUserPackageInput,
  UserPackageView,
  UserView,
} from "@/lib/api";
import { errorText } from "@/lib/errors";
import { bytesToGbInput, formatBytes, parseGbInput } from "@/lib/format";
import { directionLabel } from "@/lib/labels";
import {
  useBindUserPackage,
  usePackages,
  useUnbindUserPackage,
  useUpdateUserPackage,
  useUserPackages,
} from "@/lib/queries";
import {
  bindUserPackageSchema,
  editUserPackageSchema,
  type BindUserPackageValues,
  type EditUserPackageValues,
} from "@/lib/schemas";
import {
  dateInputAfterDays,
  dateInputToUnixEndOfDay,
  formatDate,
  toDateInputValue,
} from "@/lib/time";
import { cn } from "@/lib/utils";

interface UserPackagesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserView;
}

function BindPackageForm({ userId }: { userId: string }) {
  const packages = usePackages();
  const bind = useBindUserPackage(userId);
  const form = useForm<BindUserPackageValues>({
    resolver: zodResolver(bindUserPackageSchema),
    defaultValues: {
      package_id: "",
      expires_at: "",
      quota_override_gb: "",
      reset_day: "",
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      await bind.mutateAsync({
        package_id: values.package_id,
        expires_at: dateInputToUnixEndOfDay(values.expires_at),
        quota_override: parseGbInput(values.quota_override_gb),
        reset_day: values.reset_day ? Number(values.reset_day) : null,
      });
      toast.success("套餐已绑定");
      form.reset();
    } catch (error) {
      const message = errorText(error, "绑定套餐失败，请稍后重试");
      form.setError("root", { message });
      toast.error(message);
    }
  });

  if (packages.isPending) {
    return (
      <Card className="gap-3 p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </Card>
    );
  }

  if (packages.isError) {
    return (
      <Card className="flex flex-row items-center justify-between gap-3 p-4">
        <div className="text-sm text-destructive">
          {errorText(packages.error, "套餐模板加载失败，请稍后重试")}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void packages.refetch()}
          disabled={packages.isFetching}
        >
          <RefreshCwIcon
            className={cn("size-3.5", packages.isFetching && "animate-spin")}
          />
          重试
        </Button>
      </Card>
    );
  }

  if (!packages.data || packages.data.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-3 p-6 text-center">
        <div className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground">
          <PackageIcon className="size-4" />
        </div>
        <div>
          <p className="text-sm font-medium">还没有套餐模板</p>
          <p className="mt-1 text-xs text-muted-foreground">
            先创建套餐模板，才能给用户绑定流量卡。
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link to="/packages">去创建套餐</Link>
        </Button>
      </Card>
    );
  }

  return (
    <Card className="gap-4 p-4">
      <div>
        <h3 className="text-sm font-medium">绑定新套餐</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          一个用户可以同时绑定多张卡，额度、到期日与重置日相互独立。
        </p>
      </div>

      <form className="space-y-4" onSubmit={onSubmit}>
        <FormField
          label="套餐模板"
          htmlFor="bind-package"
          required
          error={form.formState.errors.package_id?.message}
        >
          <Controller
            control={form.control}
            name="package_id"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={bind.isPending}
              >
                <SelectTrigger
                  id="bind-package"
                  className="w-full"
                  aria-invalid={Boolean(form.formState.errors.package_id)}
                >
                  <SelectValue placeholder="选择套餐模板" />
                </SelectTrigger>
                <SelectContent>
                  {packages.data.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}（{formatBytes(item.quota_bytes)}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </FormField>

        <FormField
          label="到期日期"
          htmlFor="bind-expires"
          hint="留空表示长期有效；按所选日期当天结束计算。"
          error={form.formState.errors.expires_at?.message}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="bind-expires"
              type="date"
              className="w-auto min-w-36"
              disabled={bind.isPending}
              aria-invalid={Boolean(form.formState.errors.expires_at)}
              {...form.register("expires_at")}
            />
            {[30, 60, 90].map((days) => (
              <Button
                key={days}
                type="button"
                variant="outline"
                size="xs"
                disabled={bind.isPending}
                onClick={() =>
                  form.setValue("expires_at", dateInputAfterDays(days), {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              >
                {days} 天
              </Button>
            ))}
          </div>
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="流量覆写（GB）"
            htmlFor="bind-quota"
            hint="留空 = 继承套餐额度；填 0 = 不限"
            error={form.formState.errors.quota_override_gb?.message}
          >
            <Input
              id="bind-quota"
              inputMode="decimal"
              placeholder="留空沿用"
              disabled={bind.isPending}
              aria-invalid={Boolean(
                form.formState.errors.quota_override_gb,
              )}
              {...form.register("quota_override_gb")}
            />
          </FormField>

          <FormField
            label="月度重置日"
            htmlFor="bind-reset-day"
            hint="1–31，留空表示不重置。"
            error={form.formState.errors.reset_day?.message}
          >
            <Input
              id="bind-reset-day"
              inputMode="numeric"
              placeholder="例如 1"
              disabled={bind.isPending}
              aria-invalid={Boolean(form.formState.errors.reset_day)}
              {...form.register("reset_day")}
            />
          </FormField>
        </div>

        <FormRootError message={form.formState.errors.root?.message} />

        <Button type="submit" className="w-full" disabled={bind.isPending}>
          {bind.isPending ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <PlusIcon className="size-4" />
          )}
          {bind.isPending ? "绑定中…" : "绑定套餐"}
        </Button>
      </form>
    </Card>
  );
}

interface EditUserPackageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  item: UserPackageView;
}

function EditUserPackageDialog({
  open,
  onOpenChange,
  userId,
  item,
}: EditUserPackageDialogProps) {
  const update = useUpdateUserPackage(userId);
  const form = useForm<EditUserPackageValues>({
    resolver: zodResolver(editUserPackageSchema),
    defaultValues: {
      expires_at: toDateInputValue(item.expires_at),
      quota_override_gb: bytesToGbInput(item.quota_override),
      reset_day: item.reset_day ? String(item.reset_day) : "",
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    try {
      const input: UpdateUserPackageInput = {
        expires_at: dateInputToUnixEndOfDay(values.expires_at),
        reset_day: values.reset_day ? Number(values.reset_day) : null,
        // 空串必须显式发 null（清空覆写 = 改回继承）；省略字段会保留旧覆写。
        quota_override: parseGbInput(values.quota_override_gb),
      };
      await update.mutateAsync({ id: item.id, input });
      toast.success("套餐已更新");
      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, "更新套餐失败，请稍后重试");
      form.setError("root", { message });
      toast.error(message);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑套餐</DialogTitle>
          <DialogDescription>
            {item.package_name} · 只修改这张卡，不影响套餐模板。
          </DialogDescription>
        </DialogHeader>

        <form id="edit-user-package-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label="到期日期"
            htmlFor="edit-package-expires"
            hint="留空表示长期有效。"
            error={form.formState.errors.expires_at?.message}
          >
            <Input
              id="edit-package-expires"
              type="date"
              disabled={update.isPending}
              aria-invalid={Boolean(form.formState.errors.expires_at)}
              {...form.register("expires_at")}
            />
          </FormField>

          <FormField
            label="流量覆写（GB）"
            htmlFor="edit-package-quota"
            error={form.formState.errors.quota_override_gb?.message}
          >
            <Input
              id="edit-package-quota"
              inputMode="decimal"
              placeholder="留空继承"
              disabled={update.isPending}
              aria-invalid={Boolean(
                form.formState.errors.quota_override_gb,
              )}
              {...form.register("quota_override_gb")}
            />
          </FormField>

          <FormField
            label="月度重置日"
            htmlFor="edit-package-reset-day"
            hint="1–31，留空表示不重置。"
            error={form.formState.errors.reset_day?.message}
          >
            <Input
              id="edit-package-reset-day"
              inputMode="numeric"
              disabled={update.isPending}
              aria-invalid={Boolean(form.formState.errors.reset_day)}
              {...form.register("reset_day")}
            />
          </FormField>

          <p className="text-xs text-muted-foreground">
            留空 = 继承套餐额度；填 0 = 不限
          </p>

          <FormRootError message={form.formState.errors.root?.message} />
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={update.isPending}
          >
            取消
          </Button>
          <Button
            type="submit"
            form="edit-user-package-form"
            disabled={update.isPending}
          >
            {update.isPending ? <Loader2Icon className="animate-spin" /> : null}
            {update.isPending ? "保存中…" : "保存修改"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UserPackagesSheet({
  open,
  onOpenChange,
  user,
}: UserPackagesSheetProps) {
  const bindings = useUserPackages(user.id);
  const unbind = useUnbindUserPackage(user.id);
  const [editTarget, setEditTarget] = useState<UserPackageView | null>(null);
  const [unbindTarget, setUnbindTarget] = useState<UserPackageView | null>(null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border pr-12">
          <SheetTitle>管理套餐</SheetTitle>
          <SheetDescription>
            {user.username} · {user.short_code}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          {user.quota_exceeded ? (
            <Alert
              variant="destructive"
              className="border-destructive/25 bg-destructive/10"
            >
              <TriangleAlertIcon />
              <AlertTitle>已超出账户总额度</AlertTitle>
              <AlertDescription className="text-destructive/90">
                该用户已超出账户总额度，所有节点已停用；调大总额度或重置后约
                30 秒恢复。
              </AlertDescription>
            </Alert>
          ) : null}

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium">已绑套餐</h3>
                {bindings.data ? (
                  <Badge
                    variant="secondary"
                    className="font-mono text-[11px] font-normal text-muted-foreground"
                  >
                    {bindings.data.length}
                  </Badge>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void bindings.refetch()}
                disabled={bindings.isFetching}
              >
                <RefreshCwIcon
                  className={cn(
                    "size-3.5",
                    bindings.isFetching && "animate-spin",
                  )}
                />
                刷新
              </Button>
            </div>

            {bindings.isPending ? (
              <div className="space-y-3">
                {[0, 1].map((index) => (
                  <Card key={index} className="gap-3 p-4">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3.5 w-full" />
                    <Skeleton className="h-3.5 w-2/3" />
                  </Card>
                ))}
              </div>
            ) : bindings.isError ? (
              <Card className="flex flex-col items-center gap-3 p-6 text-center">
                <div className="grid size-9 place-items-center rounded-full bg-destructive/10 text-destructive">
                  <TriangleAlertIcon className="size-4" />
                </div>
                <p className="text-sm text-destructive">
                  {errorText(bindings.error, "套餐加载失败，请稍后重试")}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void bindings.refetch()}
                  disabled={bindings.isFetching}
                >
                  <RefreshCwIcon
                    className={cn(
                      "size-3.5",
                      bindings.isFetching && "animate-spin",
                    )}
                  />
                  重试
                </Button>
              </Card>
            ) : bindings.data && bindings.data.length === 0 ? (
              <Card className="flex flex-col items-center gap-2 p-8 text-center">
                <div className="grid size-9 place-items-center rounded-full bg-muted text-muted-foreground">
                  <PackageIcon className="size-4" />
                </div>
                <p className="text-sm font-medium">还没有绑定套餐</p>
                <p className="text-xs text-muted-foreground">
                  在下方选择一个套餐模板开始绑定。
                </p>
              </Card>
            ) : (
              <div className="space-y-3">
                {bindings.data?.map((item) => (
                  <Card key={item.id} className="gap-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium">
                            {item.package_name}
                          </p>
                          <PackageStatusBadge status={item.status} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {directionLabel(item.direction)} · 节点倍率 ×
                          {item.node_ratio}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="编辑套餐"
                          title="编辑套餐"
                          onClick={() => setEditTarget(item)}
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="解绑套餐"
                          title="解绑套餐"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setUnbindTarget(item)}
                        >
                          <UnlinkIcon className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    <UsageBar
                      usedBytes={item.used_bytes}
                      quotaBytes={item.quota_bytes}
                      zeroAsUnlimited
                    />

                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1.5">
                        <CalendarIcon className="size-3.5" />
                        到期
                        <span className="text-foreground/80">
                          {item.expires_at
                            ? formatDate(item.expires_at)
                            : "长期"}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <RefreshCwIcon className="size-3.5" />
                        重置
                        <span className="text-foreground/80">
                          {item.reset_day
                            ? `每月 ${item.reset_day} 日`
                            : "不重置"}
                        </span>
                      </span>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <BindPackageForm userId={user.id} />
          </section>
        </div>
      </SheetContent>

      {editTarget ? (
        <EditUserPackageDialog
          key={editTarget.id}
          open={Boolean(editTarget)}
          onOpenChange={(next) => {
            if (!next) setEditTarget(null);
          }}
          userId={user.id}
          item={editTarget}
        />
      ) : null}

      <AlertDialog
        open={Boolean(unbindTarget)}
        onOpenChange={(next) => {
          if (!next && !unbind.isPending) setUnbindTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <UnlinkIcon className="size-5" />
            </AlertDialogMedia>
            <AlertDialogTitle>解绑套餐</AlertDialogTitle>
            <AlertDialogDescription>
              确定解绑「{unbindTarget?.package_name}
              」？解绑后该用户不再享有此套餐额度，历史用量保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unbind.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={unbind.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (!unbindTarget) return;
                unbind.mutate(unbindTarget.id, {
                  onSuccess: () => {
                    toast.success("已解绑套餐");
                    setUnbindTarget(null);
                  },
                  onError: (error) => {
                    toast.error(
                      errorText(error, "解绑失败，请稍后重试"),
                    );
                  },
                });
              }}
            >
              解绑
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}
