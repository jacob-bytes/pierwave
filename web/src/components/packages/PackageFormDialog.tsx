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
import type { CreatePackageInput, Package } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { bytesToGbInput, parseGbInput } from "@/lib/format";
import { useCreatePackage, useUpdatePackage } from "@/lib/queries";
import {
  packageFormSchema,
  type PackageFormValues,
} from "@/lib/schemas";

interface PackageFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packageItem?: Package;
}

export function PackageFormDialog({
  open,
  onOpenChange,
  packageItem,
}: PackageFormDialogProps) {
  const createPackage = useCreatePackage();
  const updatePackage = useUpdatePackage();
  const editing = Boolean(packageItem);
  const pending = editing
    ? updatePackage.isPending
    : createPackage.isPending;

  const form = useForm<PackageFormValues>({
    resolver: zodResolver(packageFormSchema),
    defaultValues: packageItem
      ? {
          name: packageItem.name,
          quota_gb: bytesToGbInput(packageItem.quota_bytes),
          period_days: packageItem.period_days
            ? String(packageItem.period_days)
            : "",
          direction: packageItem.direction,
          node_ratio: String(packageItem.node_ratio),
        }
      : {
          name: "",
          quota_gb: "",
          period_days: "",
          direction: "both",
          node_ratio: "1",
        },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    form.clearErrors("root");
    const input: CreatePackageInput = {
      name: values.name,
      quota_bytes: parseGbInput(values.quota_gb),
      period_days: values.period_days.trim()
        ? Number(values.period_days)
        : null,
      direction: values.direction,
      node_ratio: Number(values.node_ratio),
    };

    try {
      if (packageItem) {
        await updatePackage.mutateAsync({
          id: packageItem.id,
          input,
        });
        toast.success("套餐模板已更新");
      } else {
        await createPackage.mutateAsync(input);
        toast.success(`套餐模板「${values.name}」已创建`);
      }
      onOpenChange(false);
    } catch (error) {
      const message = errorText(error, "保存套餐模板失败，请稍后重试");
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
            {editing ? "编辑套餐模板" : "新建套餐模板"}
          </DialogTitle>
          <DialogDescription>
            模板只定义额度、周期与倍率；用户绑定后生成独立的套餐实例。
          </DialogDescription>
        </DialogHeader>

        <form id="package-form" className="space-y-4" onSubmit={onSubmit}>
          <FormField
            label="名称"
            htmlFor="package-name"
            required
            error={form.formState.errors.name?.message}
          >
            <Input
              id="package-name"
              placeholder="例如 100G 月卡"
              autoComplete="off"
              disabled={pending}
              aria-invalid={Boolean(form.formState.errors.name)}
              {...form.register("name")}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="额度（GB）"
              htmlFor="package-quota"
              hint="留空表示不限。"
              error={form.formState.errors.quota_gb?.message}
            >
              <Input
                id="package-quota"
                inputMode="decimal"
                placeholder="例如 100"
                disabled={pending}
                aria-invalid={Boolean(form.formState.errors.quota_gb)}
                {...form.register("quota_gb")}
              />
            </FormField>

            <FormField
              label="周期（天）"
              htmlFor="package-period"
              hint="留空表示长期。"
              error={form.formState.errors.period_days?.message}
            >
              <Input
                id="package-period"
                inputMode="numeric"
                placeholder="例如 30"
                disabled={pending}
                aria-invalid={Boolean(form.formState.errors.period_days)}
                {...form.register("period_days")}
              />
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="方向"
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
                      <SelectValue placeholder="选择方向" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="both">双向</SelectItem>
                      <SelectItem value="upload">上行</SelectItem>
                      <SelectItem value="download">下行</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </FormField>

            <FormField
              label="节点倍率"
              htmlFor="package-ratio"
              hint="大于 0 且不超过 10。"
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
          <Button type="submit" form="package-form" disabled={pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : null}
            {pending
              ? "保存中…"
              : editing
                ? "保存修改"
                : "创建套餐"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
