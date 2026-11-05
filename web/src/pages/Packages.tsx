import { useState } from "react";
import { toast } from "sonner";
import {
  MoreHorizontalIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { PackageFormDialog } from "@/components/packages/PackageFormDialog";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Package } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { directionLabel } from "@/lib/labels";
import { useDeletePackage, usePackages } from "@/lib/queries";
import { cn } from "@/lib/utils";

const COLUMN_COUNT = 7;

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-32" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-16" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-14" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-12 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-10" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-12 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="size-7 rounded-md" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function EmptyRow({ onCreate }: { onCreate: () => void }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
            <PackageIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">还没有套餐模板</p>
            <p className="mt-1 text-xs text-muted-foreground">
              创建模板后，可以在用户抽屉里给用户绑定多张套餐实例。
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <PlusIcon className="size-3.5" />
            新建套餐
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function ErrorRow({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
          <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
            <TriangleAlertIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">套餐模板加载失败</p>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            <RefreshCwIcon
              className={cn("size-3.5", retrying && "animate-spin")}
            />
            重试
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function DeletePackageDialog({
  packageItem,
  open,
  onOpenChange,
}: {
  packageItem: Package;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deletePackage = useDeletePackage();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && deletePackage.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>删除套餐模板</AlertDialogTitle>
          <AlertDialogDescription>
            确定删除「{packageItem.name}」？删除后不可恢复；如果还有用户绑定，需要先解绑。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletePackage.isPending}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deletePackage.isPending}
            onClick={(event) => {
              event.preventDefault();
              deletePackage.mutate(packageItem.id, {
                onSuccess: () => {
                  toast.success("套餐模板已删除");
                  onOpenChange(false);
                },
                onError: (error) => {
                  // 契约要求直接透出后端中文 error，例如「该套餐还有 N 个用户在用」
                  toast.error(
                    errorText(error, "删除套餐模板失败，请稍后重试"),
                  );
                },
              });
            }}
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function PackagesPage() {
  const packages = usePackages();
  const [formState, setFormState] = useState<{
    mode: "create" | "edit";
    packageItem?: Package;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Package | null>(null);

  const items = packages.data ?? [];
  const showError = packages.isError;
  const errorMessage = errorText(
    packages.error,
    "加载套餐模板失败，请检查网络后重试",
  );

  return (
    <div className="animate-in space-y-6 fade-in-0 slide-in-from-bottom-1 duration-150">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">套餐模板</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            定义额度、周期、方向与倍率，用户绑定后生成独立实例。
          </p>
        </div>
        <Button onClick={() => setFormState({ mode: "create" })}>
          <PlusIcon className="size-4" />
          新建套餐
        </Button>
      </div>

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              套餐列表
              {packages.data && !packages.isError ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] font-normal text-muted-foreground"
                >
                  {items.length}
                </Badge>
              ) : null}
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void packages.refetch()}
              disabled={packages.isFetching}
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  packages.isFetching && "animate-spin",
                )}
              />
              刷新
            </Button>
          </div>
          <CardDescription className="text-xs">
            用户绑定后生成独立套餐实例；删除前请先确认没有用户在用。
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table className="min-w-[760px]" aria-busy={packages.isPending}>
            <TableCaption className="sr-only">套餐模板列表</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  "名称",
                  "额度",
                  "周期",
                  "方向",
                  "节点倍率",
                  "在用人数",
                  "操作",
                ].map((label) => (
                  <TableHead
                    key={label}
                    className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground"
                  >
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {packages.isPending ? (
                <LoadingRows />
              ) : showError ? (
                <ErrorRow
                  message={errorMessage}
                  retrying={packages.isFetching}
                  onRetry={() => void packages.refetch()}
                />
              ) : items.length === 0 ? (
                <EmptyRow onCreate={() => setFormState({ mode: "create" })} />
              ) : (
                items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <PackageIcon className="size-4 text-muted-foreground" />
                        <span className="font-medium">{item.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      {formatBytes(item.quota_bytes)}
                    </TableCell>
                    <TableCell className="px-4 py-2.5 text-xs text-muted-foreground">
                      {item.period_days ? `${item.period_days} 天` : "长期"}
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <Badge
                        variant="outline"
                        className="font-normal text-muted-foreground"
                      >
                        {directionLabel(item.direction)}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      ×{item.node_ratio}
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <Badge
                        variant="secondary"
                        className="font-mono text-[11px] font-normal text-muted-foreground"
                      >
                        {item.user_count} 人
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`操作 ${item.name}`}
                          >
                            <MoreHorizontalIcon className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-36">
                          <DropdownMenuItem
                            onSelect={() =>
                              setFormState({ mode: "edit", packageItem: item })
                            }
                          >
                            <PencilIcon className="size-3.5" />
                            编辑
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={item.user_count > 0}
                            title={
                              item.user_count > 0
                                ? `还有 ${item.user_count} 个用户在用，需先解绑`
                                : undefined
                            }
                            onSelect={() => setDeleteTarget(item)}
                          >
                            <Trash2Icon className="size-3.5" />
                            删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {formState ? (
        <PackageFormDialog
          key={`${formState.mode}-${formState.packageItem?.id ?? "new"}`}
          open
          packageItem={formState.packageItem}
          onOpenChange={(open) => {
            if (!open) setFormState(null);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeletePackageDialog
          key={deleteTarget.id}
          open
          packageItem={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
