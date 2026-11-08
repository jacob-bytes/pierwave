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
import {
  EmptyState,
  ListError,
  MobileDataCard,
  PageHeader,
  SkeletonCard,
  SkeletonTable,
} from "@/components/common";
import { PackageFormDialog } from "@/components/packages/PackageFormDialog";
import { SpeedLimitBadge } from "@/components/SpeedLimitBadge";
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
import { t, useI18n } from "@/i18n";
import { useIsDesktop } from "@/lib/useIsDesktop";

const COLUMN_COUNT = 8;

/** 节点范围三态：全部（N）/ 指定 N 个 / 无节点。 */
function NodeScopeBadge({ item }: { item: Package }) {
  if (item.node_scope === "all") {
    return (
      <Badge
        variant="secondary"
        className="font-normal text-muted-foreground"
        title={t("packages.scope.allTitle")}
      >
        {t("packages.scope.all", { n: item.node_count })}
      </Badge>
    );
  }

  if (item.node_ids.length === 0) {
    return (
      <Badge
        variant="destructive"
        className="font-normal"
        title={t("packages.scope.emptyTitle")}
      >
        {t("packages.scope.empty")}
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="font-normal text-muted-foreground"
      title={t("packages.scope.selectedTitle")}
    >
      {t("packages.scope.selected", { n: item.node_count })}
    </Badge>
  );
}

function EmptyRow({ onCreate }: { onCreate: () => void }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-8">
        <EmptyState
          size="sm"
          icon={PackageIcon}
          title={t("packages.emptyTitle")}
          description={t("packages.emptyDesc")}
          action={
            <Button variant="outline" size="sm" onClick={onCreate}>
              <PlusIcon className="size-3.5" />
              {t("packages.emptyAction")}
            </Button>
          }
        />
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
            <p className="text-sm font-medium">{t("packages.loadFailed")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            <RefreshCwIcon
              className={cn("size-3.5", retrying && "animate-spin")}
            />
            {t("common.retry")}
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
          <AlertDialogTitle>{t("packages.delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("packages.delete.desc", { name: packageItem.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deletePackage.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deletePackage.isPending}
            onClick={(event) => {
              event.preventDefault();
              deletePackage.mutate(packageItem.id, {
                onSuccess: () => {
                  toast.success(t("packages.delete.success"));
                  onOpenChange(false);
                },
                onError: (error) => {
                  // 契约要求直接透出后端中文 error，例如「该套餐还有 N 个用户在用」
                  toast.error(
                    errorText(error, t("packages.delete.error")),
                  );
                },
              });
            }}
          >
            {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function PackagesPage() {
  useI18n();
  const isDesktop = useIsDesktop();
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
    t("packages.loadError"),
  );

  function renderPackageName(item: Package) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <PackageIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
        <SpeedLimitBadge kbps={item.speed_limit_kbps} approximate />
      </div>
    );
  }

  function renderPackagePeriod(item: Package) {
    return item.period_days
      ? t(
          item.period_days === 1
            ? "packages.period.day"
            : "packages.period.days",
          { n: item.period_days },
        )
      : t("packages.period.longTerm");
  }

  function renderPackageDirection(item: Package) {
    return (
      <Badge
        variant="outline"
        className="font-normal text-muted-foreground"
      >
        {directionLabel(item.direction)}
      </Badge>
    );
  }

  function renderPackageUserCount(item: Package) {
    return (
      <Badge
        variant="secondary"
        className="font-mono text-[11px] font-normal text-muted-foreground"
      >
        {t(
          item.user_count === 1
            ? "packages.userCountOne"
            : "packages.userCount",
          { n: item.user_count },
        )}
      </Badge>
    );
  }

  function renderPackageActions(item: Package) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("packages.actionsAria", { name: item.name })}
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
            {t("common.edit")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={item.user_count > 0}
            title={
              item.user_count > 0
                ? t("packages.delete.disabledTitle", {
                    n: item.user_count,
                  })
                : undefined
            }
            onSelect={() => setDeleteTarget(item)}
          >
            <Trash2Icon className="size-3.5" />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  function renderRow(item: Package) {
    return (
      <TableRow key={item.id}>
        <TableCell sticky="left" className="px-4 py-2.5">
          {renderPackageName(item)}
        </TableCell>
        <TableCell className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
          {formatBytes(item.quota_bytes)}
        </TableCell>
        <TableCell className="px-4 py-2.5 text-xs text-muted-foreground">
          {renderPackagePeriod(item)}
        </TableCell>
        <TableCell className="px-4 py-2.5">
          {renderPackageDirection(item)}
        </TableCell>
        <TableCell className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
          ×{item.node_ratio}
        </TableCell>
        <TableCell className="px-4 py-2.5">
          <NodeScopeBadge item={item} />
        </TableCell>
        <TableCell className="px-4 py-2.5">
          {renderPackageUserCount(item)}
        </TableCell>
        <TableCell sticky="right" className="px-4 py-2.5">
          {renderPackageActions(item)}
        </TableCell>
      </TableRow>
    );
  }

  function renderCard(item: Package) {
    return (
      <MobileDataCard
        key={item.id}
        title={item.name}
        actions={renderPackageActions(item)}
        fields={[
          {
            label: t("packages.columns.quota"),
            value: (
              <span className="font-mono text-muted-foreground">
                {formatBytes(item.quota_bytes)}
              </span>
            ),
          },
          {
            label: t("packages.columns.period"),
            value: renderPackagePeriod(item),
          },
          {
            label: t("packages.columns.direction"),
            value: renderPackageDirection(item),
          },
          {
            label: t("packages.columns.ratio"),
            value: (
              <span className="font-mono text-muted-foreground">
                ×{item.node_ratio}
              </span>
            ),
          },
          {
            label: t("packages.columns.scope"),
            value: <NodeScopeBadge item={item} />,
          },
          {
            label: t("packages.columns.userCount"),
            value: renderPackageUserCount(item),
          },
        ]}
      />
    );
  }


  return (
    <div className="animate-enter space-y-6">
      <PageHeader
        title={t("packages.title")}
        description={t("packages.subtitle")}
        actions={
          <Button onClick={() => setFormState({ mode: "create" })}>
            <PlusIcon className="size-4" />
            {t("packages.create")}
          </Button>
        }
      />

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("packages.list")}
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
              {t("common.refresh")}
            </Button>
          </div>
          <CardDescription className="text-xs">
            {t("packages.desc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0" aria-busy={packages.isPending}>
          {packages.isPending && isDesktop ? (
            <SkeletonTable rows={5} columns={COLUMN_COUNT} />
          ) : null}
          {packages.isPending && !isDesktop ? (
            <div className="space-y-3 p-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <SkeletonCard key={index} lines={4} />
              ))}
            </div>
          ) : null}
          {isDesktop ? (
          <div className={cn(packages.isPending && "hidden")}>
          <Table className="min-w-[880px]">
            <TableCaption className="sr-only">{t("packages.tableCaption")}</TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                {[
                  t("packages.columns.name"),
                  t("packages.columns.quota"),
                  t("packages.columns.period"),
                  t("packages.columns.direction"),
                  t("packages.columns.ratio"),
                  t("packages.columns.scope"),
                  t("packages.columns.userCount"),
                  t("packages.columns.actions"),
                ].map((label, index, columns) => (
                  <TableHead
                    key={label}
                    sticky={
                      index === 0
                        ? "left"
                        : index === columns.length - 1
                          ? "right"
                          : undefined
                    }
                    className="h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground"
                  >
                    {label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {showError ? (
                <ErrorRow
                  message={errorMessage}
                  retrying={packages.isFetching}
                  onRetry={() => void packages.refetch()}
                />
              ) : items.length === 0 ? (
                <EmptyRow onCreate={() => setFormState({ mode: "create" })} />
              ) : (
                items.map(renderRow)
              )}
            </TableBody>
          </Table>
          </div>
          ) : null}

          {!packages.isPending && !isDesktop ? (
            <div className="space-y-3 p-3">
              {showError ? (
                <Card size="sm" className="py-0">
                  <ListError
                    title={t("packages.loadFailed")}
                    message={errorMessage}
                    retrying={packages.isFetching}
                    onRetry={() => void packages.refetch()}
                  />
                </Card>
              ) : items.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={PackageIcon}
                  title={t("packages.emptyTitle")}
                  description={t("packages.emptyDesc")}
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFormState({ mode: "create" })}
                    >
                      <PlusIcon className="size-3.5" />
                      {t("packages.create")}
                    </Button>
                  }
                />
              ) : (
                items.map(renderCard)
              )}
            </div>
          ) : null}
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
