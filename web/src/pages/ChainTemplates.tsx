import { useState } from "react";
import { toast } from "sonner";
import {
  BracesIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  EmptyState,
  EngineBadge,
  ListError,
  MobileDataCard,
  PageHeader,
  ProtocolBadge,
  SkeletonCard,
  SkeletonTable,
} from "@/components/common";
import { ChainTemplateFormDialog } from "@/components/chains/ChainTemplateFormDialog";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ChainTemplate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { templatePath } from "@/lib/myChains";
import {
  useChainTemplates,
  useDeleteChainTemplate,
  useUpdateChainTemplate,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";
import { useIsDesktop } from "@/lib/useIsDesktop";

const COLUMN_COUNT = 7;

function SecurityBadge({ template }: { template: ChainTemplate }) {
  if (template.engine !== "tunnel") {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <Badge variant="outline" className="font-normal text-muted-foreground">
      {t(
        template.security === "noise"
          ? "chains.tunnelSecurity.noise.badge"
          : "chains.tunnelSecurity.tls.badge",
      )}
    </Badge>
  );
}

function TemplatePath({ template }: { template: ChainTemplate }) {
  const path = templatePath(template);
  return (
    <span
      className="block max-w-[320px] truncate font-mono text-xs text-muted-foreground"
      title={path}
    >
      {path}
    </span>
  );
}

function DeleteTemplateDialog({
  template,
  open,
  onOpenChange,
}: {
  template: ChainTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteChainTemplate();

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && remove.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {t("chainTemplates.delete.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("chainTemplates.delete.desc", { name: template.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={remove.isPending}
            onClick={(event) => {
              event.preventDefault();
              remove.mutate(template.id, {
                onSuccess: () => {
                  toast.success(t("chainTemplates.delete.success"));
                  onOpenChange(false);
                },
                onError: (error) => {
                  toast.error(
                    errorText(error, t("chainTemplates.delete.error")),
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

export default function ChainTemplatesPage() {
  useI18n();
  const isDesktop = useIsDesktop();
  const templates = useChainTemplates();
  const update = useUpdateChainTemplate();
  const [formState, setFormState] = useState<{
    mode: "create" | "edit";
    template?: ChainTemplate;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChainTemplate | null>(null);

  const items = templates.data ?? [];
  const showError = templates.isError;
  const errorMessage = errorText(
    templates.error,
    t("chainTemplates.loadError"),
  );

  function toggle(template: ChainTemplate, enabled: boolean) {
    update.mutate(
      { id: template.id, input: { enabled } },
      {
        onError: (error) =>
          toast.error(errorText(error, t("chainTemplates.toggleError"))),
      },
    );
  }

  function renderActions(item: ChainTemplate) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("chainTemplates.actionsAria", { name: item.name })}
          >
            <MoreHorizontalIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem
            onSelect={() => setFormState({ mode: "edit", template: item })}
          >
            <PencilIcon className="size-3.5" />
            {t("common.edit")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteTarget(item)}
          >
            <Trash2Icon className="size-3.5" />
            {t("common.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  function renderRow(item: ChainTemplate) {
    return (
      <TableRow key={item.id}>
        <TableCell sticky="left" className="px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <BracesIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 max-w-[200px] truncate font-medium">
              {item.name}
            </span>
          </div>
        </TableCell>
        <TableCell className="px-4 py-2.5">
          <TemplatePath template={item} />
        </TableCell>
        <TableCell className="px-4 py-2.5">
          <EngineBadge engine={item.engine} />
        </TableCell>
        <TableCell className="px-4 py-2.5">
          <ProtocolBadge protocol={item.protocol} />
        </TableCell>
        <TableCell className="px-4 py-2.5">
          <SecurityBadge template={item} />
        </TableCell>
        <TableCell className="px-4 py-2.5">
          <Switch
            size="sm"
            checked={item.enabled}
            aria-label={t("chainTemplates.toggleAria", { name: item.name })}
            disabled={update.isPending}
            onCheckedChange={(checked) => toggle(item, checked)}
          />
        </TableCell>
        <TableCell sticky="right" className="px-4 py-2.5">
          {renderActions(item)}
        </TableCell>
      </TableRow>
    );
  }

  function renderCard(item: ChainTemplate) {
    return (
      <MobileDataCard
        key={item.id}
        title={item.name}
        actions={renderActions(item)}
        fields={[
          {
            label: t("chainTemplates.columns.path"),
            value: <TemplatePath template={item} />,
          },
          {
            label: t("chainTemplates.columns.engine"),
            value: <EngineBadge engine={item.engine} />,
          },
          {
            label: t("chainTemplates.columns.protocol"),
            value: <ProtocolBadge protocol={item.protocol} />,
          },
          {
            label: t("chainTemplates.columns.security"),
            value: <SecurityBadge template={item} />,
          },
          {
            label: t("chainTemplates.columns.enabled"),
            value: (
              <Switch
                size="sm"
                checked={item.enabled}
                aria-label={t("chainTemplates.toggleAria", {
                  name: item.name,
                })}
                disabled={update.isPending}
                onCheckedChange={(checked) => toggle(item, checked)}
              />
            ),
          },
        ]}
      />
    );
  }

  const createButton = (
    <Button onClick={() => setFormState({ mode: "create" })}>
      <PlusIcon className="size-4" />
      {t("chainTemplates.create")}
    </Button>
  );

  return (
    <div className="animate-enter space-y-6">
      <PageHeader
        title={t("chainTemplates.title")}
        description={t("chainTemplates.subtitle")}
        actions={createButton}
      />

      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("chainTemplates.list")}
              {templates.data && !templates.isError ? (
                <Badge
                  variant="secondary"
                  className="font-mono type-micro font-normal text-muted-foreground"
                >
                  {items.length}
                </Badge>
              ) : null}
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void templates.refetch()}
              disabled={templates.isFetching}
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  templates.isFetching && "animate-spin",
                )}
              />
              {t("common.refresh")}
            </Button>
          </div>
          <CardDescription className="text-xs">
            {t("chainTemplates.desc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0" aria-busy={templates.isPending}>
          {templates.isPending && isDesktop ? (
            <SkeletonTable rows={4} columns={COLUMN_COUNT} />
          ) : null}
          {templates.isPending && !isDesktop ? (
            <div className="space-y-3 p-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <SkeletonCard key={index} lines={4} />
              ))}
            </div>
          ) : null}
          {isDesktop ? (
            <div className={cn(templates.isPending && "hidden")}>
              <Table className="min-w-[820px]">
                <TableCaption className="sr-only">
                  {t("chainTemplates.tableCaption")}
                </TableCaption>
                <TableHeader className="bg-muted/30">
                  <TableRow>
                    {[
                      t("chainTemplates.columns.name"),
                      t("chainTemplates.columns.path"),
                      t("chainTemplates.columns.engine"),
                      t("chainTemplates.columns.protocol"),
                      t("chainTemplates.columns.security"),
                      t("chainTemplates.columns.enabled"),
                      t("chainTemplates.columns.actions"),
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
                        className="h-9 px-4 text-xs font-[550] tracking-wide text-muted-foreground"
                      >
                        {label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {showError ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-16">
                        <div className="mx-auto flex max-w-md flex-col items-center gap-3 text-center">
                          <div className="grid size-10 place-items-center rounded-full bg-destructive/10 text-destructive">
                            <TriangleAlertIcon className="size-5" />
                          </div>
                          <div>
                            <p className="text-sm font-medium">
                              {t("chainTemplates.loadFailed")}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {errorMessage}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void templates.refetch()}
                            disabled={templates.isFetching}
                          >
                            <RefreshCwIcon
                              className={cn(
                                "size-3.5",
                                templates.isFetching && "animate-spin",
                              )}
                            />
                            {t("common.retry")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : items.length === 0 ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-8">
                        <EmptyState
                          size="sm"
                          icon={BracesIcon}
                          title={t("chainTemplates.emptyTitle")}
                          description={t("chainTemplates.emptyDesc")}
                          action={
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setFormState({ mode: "create" })
                              }
                            >
                              <PlusIcon className="size-3.5" />
                              {t("chainTemplates.emptyAction")}
                            </Button>
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    items.map(renderRow)
                  )}
                </TableBody>
              </Table>
            </div>
          ) : null}

          {!templates.isPending && !isDesktop ? (
            <div className="space-y-3 p-3">
              {showError ? (
                <Card size="sm" className="py-0">
                  <ListError
                    title={t("chainTemplates.loadFailed")}
                    message={errorMessage}
                    retrying={templates.isFetching}
                    onRetry={() => void templates.refetch()}
                  />
                </Card>
              ) : items.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={BracesIcon}
                  title={t("chainTemplates.emptyTitle")}
                  description={t("chainTemplates.emptyDesc")}
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setFormState({ mode: "create" })}
                    >
                      <PlusIcon className="size-3.5" />
                      {t("chainTemplates.emptyAction")}
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
        <ChainTemplateFormDialog
          key={`${formState.mode}-${formState.template?.id ?? "new"}`}
          open
          template={formState.template}
          onOpenChange={(open) => {
            if (!open) setFormState(null);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteTemplateDialog
          key={deleteTarget.id}
          open
          template={deleteTarget}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}
