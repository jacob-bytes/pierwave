import { useState } from "react";
import {
  ListFilterIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  StarIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { DeleteRuleTemplateDialog } from "@/components/rules/DeleteRuleTemplateDialog";
import { RuleTemplateFormDialog } from "@/components/rules/RuleTemplateFormDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import type { RuleTemplate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useRuleTemplates, useUpdateRuleTemplate } from "@/lib/queries";
import { ruleTemplateErrorText } from "@/lib/ruleTemplates";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 5;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

type FormState =
  | { mode: "create" }
  | { mode: "edit"; template: RuleTemplate };

function RuleCount({ count }: { count: number }) {
  return (
    <Badge
      variant="secondary"
      className="font-mono text-[11px] font-normal text-muted-foreground"
    >
      {t(count === 1 ? "rules.ruleCountOne" : "rules.ruleCount", { n: count })}
    </Badge>
  );
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-32" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-48" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-5 w-14 rounded-full" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="h-3.5 w-20" />
          </TableCell>
          <TableCell className="px-4 py-3">
            <Skeleton className="ml-auto h-6 w-24" />
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
            <ListFilterIcon className="size-5" />
          </div>
          <div>
            <p className="text-sm font-medium">{t("rules.emptyTitle")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("rules.emptyDesc")}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onCreate}>
            <PlusIcon className="size-3.5" />
            {t("rules.emptyAction")}
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
            <p className="text-sm font-medium">{t("rules.loadFailed")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{message}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
          >
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

/** 设置页的「规则模板」tab：列表 + 新建/编辑/删除对话框，四态齐全。 */
export function RuleTemplatesPanel() {
  useI18n();
  const templates = useRuleTemplates();
  const updateTemplate = useUpdateRuleTemplate();
  const [formState, setFormState] = useState<FormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RuleTemplate | null>(null);

  const items = templates.data ?? [];
  const showError = templates.isError && !templates.data;

  function handleSetDefault(template: RuleTemplate) {
    updateTemplate.mutate(
      { id: template.id, input: { is_default: true } },
      {
        onSuccess: () => {
          toast.success(
            t("rules.setDefaultSuccess", { name: template.name }),
          );
        },
        onError: (error) => {
          toast.error(errorText(error, t("rules.setDefaultError")));
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <Card className="gap-0 overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              {t("rules.list")}
              {templates.data && !templates.isError ? (
                <Badge
                  variant="secondary"
                  className="font-mono text-[11px] font-normal text-muted-foreground"
                >
                  {items.length}
                </Badge>
              ) : null}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => setFormState({ mode: "create" })}
              >
                <PlusIcon className="size-3.5" />
                {t("rules.create")}
              </Button>
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
          </div>
          <CardDescription className="text-xs">
            {t("rules.desc")}
          </CardDescription>
        </CardHeader>

        <CardContent className="p-0">
          <Table className="min-w-[760px]" aria-busy={templates.isPending}>
            <TableCaption className="sr-only">
              {t("rules.tableCaption")}
            </TableCaption>
            <TableHeader className="bg-muted/30">
              <TableRow>
                <TableHead className={HEAD_CLASS}>
                  {t("rules.columns.name")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>
                  {t("rules.columns.description")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>
                  {t("rules.columns.count")}
                </TableHead>
                <TableHead className={HEAD_CLASS}>
                  {t("rules.columns.updatedAt")}
                </TableHead>
                <TableHead className={cn(HEAD_CLASS, "text-right")}>
                  {t("rules.columns.actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.isPending ? (
                <LoadingRows />
              ) : showError ? (
                <ErrorRow
                  message={ruleTemplateErrorText(templates.error)}
                  retrying={templates.isFetching}
                  onRetry={() => void templates.refetch()}
                />
              ) : items.length === 0 ? (
                <EmptyRow onCreate={() => setFormState({ mode: "create" })} />
              ) : (
                items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <ListFilterIcon className="size-4 shrink-0 text-muted-foreground" />
                        <span
                          className="max-w-[260px] truncate font-medium"
                          title={item.name}
                        >
                          {item.name}
                        </span>
                        {item.is_default ? (
                          <Badge
                            variant="outline"
                            className="border-primary/30 bg-primary/10 font-normal text-primary"
                          >
                            {t("rules.defaultBadge")}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      {item.description.trim() ? (
                        <span
                          className="block max-w-[320px] truncate text-xs text-muted-foreground"
                          title={item.description}
                        >
                          {item.description}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <RuleCount count={item.rules.length} />
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      {/* 迁移写入的初始模板时间戳是 0，别显示成 1970 年。 */}
                      {item.updated_at > 0 ? (
                        <span
                          className="text-xs whitespace-nowrap text-muted-foreground"
                          title={formatAbsoluteTime(item.updated_at)}
                        >
                          {formatRelativeTime(item.updated_at)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={t("rules.editAria", { name: item.name })}
                          aria-label={t("rules.editAria", {
                            name: item.name,
                          })}
                          onClick={() =>
                            setFormState({ mode: "edit", template: item })
                          }
                        >
                          <PencilIcon className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={
                            item.is_default
                              ? t("rules.setDefaultDisabled")
                              : t("rules.setDefault")
                          }
                          aria-label={
                            item.is_default
                              ? t("rules.setDefaultDisabled")
                              : t("rules.setDefault")
                          }
                          disabled={
                            item.is_default || updateTemplate.isPending
                          }
                          onClick={() => handleSetDefault(item)}
                        >
                          <StarIcon className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title={
                            item.is_default
                              ? t("rules.deleteDisabled")
                              : t("rules.deleteAria", { name: item.name })
                          }
                          aria-label={
                            item.is_default
                              ? t("rules.deleteDisabled")
                              : t("rules.deleteAria", { name: item.name })
                          }
                          disabled={item.is_default}
                          onClick={() => setDeleteTarget(item)}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {formState ? (
        <RuleTemplateFormDialog
          key={
            formState.mode === "edit"
              ? `edit-${formState.template.id}`
              : "create"
          }
          open
          template={formState.mode === "edit" ? formState.template : undefined}
          onOpenChange={(open) => {
            if (!open) setFormState(null);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteRuleTemplateDialog
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
