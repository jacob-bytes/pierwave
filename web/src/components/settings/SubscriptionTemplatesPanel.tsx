import { useState } from "react";
import {
  CopyIcon,
  EyeIcon,
  ListFilterIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  WorkflowIcon,
} from "lucide-react";
import { DeleteSubscriptionTemplateDialog } from "@/components/settings/DeleteSubscriptionTemplateDialog";
import { SubscriptionTemplateFormDialog } from "@/components/settings/SubscriptionTemplateFormDialog";
import { SubscriptionTemplatePreviewDialog } from "@/components/settings/SubscriptionTemplatePreviewDialog";
import { EmptyState, ListErrorRow, SkeletonTable } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SubscriptionTemplate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useSubscriptionTemplates } from "@/lib/queries";
import {
  copyTemplateDraft,
  groupFilterSummary,
  templateUsage,
} from "@/lib/subscriptionTemplates";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

const COLUMN_COUNT = 5;
const HEAD_CLASS =
  "h-9 px-4 text-xs font-medium tracking-wide text-muted-foreground";

type FormState =
  | { mode: "create" }
  | { mode: "edit"; template: SubscriptionTemplate }
  | { mode: "copy"; template: SubscriptionTemplate };

/** 组名 + 条件摘要：`节点选择 · #香港 @HK vless / 自动选择 · *`。 */
function groupSummary(template: SubscriptionTemplate): string {
  return template.groups
    .map((group) => {
      const filters = groupFilterSummary(group.filters).join(" | ");
      return `${group.name} · ${filters}`;
    })
    .join(" / ");
}

/** 列表里的「被 N 个用户 / M 个套餐使用」；未使用时明确显示「未被使用」。 */
function UsageCell({ template }: { template: SubscriptionTemplate }) {
  const usage = templateUsage(template.usage);
  if (!usage.inUse) {
    return (
      <span className="type-micro text-muted-foreground">
        {t("subscriptionTemplates.usageNone")}
      </span>
    );
  }
  return (
    <span className="type-micro">
      {t("subscriptionTemplates.usageCount", {
        users: usage.users,
        packages: usage.packages,
      })}
    </span>
  );
}

function EmptyRow({ onCreate }: { onCreate: () => void }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={COLUMN_COUNT} className="px-4 py-8">
        <EmptyState
          size="sm"
          icon={ListFilterIcon}
          title={t("subscriptionTemplates.emptyTitle")}
          description={t("subscriptionTemplates.emptyDesc")}
          action={
            <Button size="sm" onClick={onCreate}>
              <PlusIcon className="size-3.5" />
              {t("subscriptionTemplates.emptyAction")}
            </Button>
          }
        />
      </TableCell>
    </TableRow>
  );
}


/** 设置页的「订阅模板」tab：列表 + 新建/编辑/预览/删除，四态齐全。 */
export function SubscriptionTemplatesPanel() {
  useI18n();
  const templates = useSubscriptionTemplates();
  const [formState, setFormState] = useState<FormState | null>(null);
  const [previewTarget, setPreviewTarget] =
    useState<SubscriptionTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<SubscriptionTemplate | null>(null);

  const items = templates.data ?? [];
  const showError = templates.isError && !templates.data;
  const isEmpty =
    templates.data !== undefined && !templates.isError && items.length === 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <WorkflowIcon className="size-4 text-muted-foreground" />
            {t("subscriptionTemplates.list")}
            <span className="type-micro font-normal text-muted-foreground">
              {t(
                items.length === 1
                  ? "subscriptionTemplates.templateCountOne"
                  : "subscriptionTemplates.templateCount",
                { n: items.length },
              )}
            </span>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            {isEmpty ? null : (
              <Button size="sm" onClick={() => setFormState({ mode: "create" })}>
                <PlusIcon className="size-3.5" />
                {t("subscriptionTemplates.create")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void templates.refetch()}
              disabled={templates.isFetching}
            >
              <RefreshCwIcon
                className={cn("size-3.5", templates.isFetching && "animate-spin")}
              />
              {t("common.refresh")}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0" aria-busy={templates.isPending}>
        {templates.isPending ? (
          <SkeletonTable rows={3} columns={COLUMN_COUNT} />
        ) : null}
        <Table className={cn("min-w-[720px]", templates.isPending && "hidden")}>
          <TableCaption className="sr-only">
            {t("subscriptionTemplates.tableCaption")}
          </TableCaption>
          <TableHeader className="bg-muted/30">
            <TableRow>
              <TableHead className={HEAD_CLASS}>
                {t("subscriptionTemplates.columns.name")}
              </TableHead>
              <TableHead className={HEAD_CLASS}>
                {t("subscriptionTemplates.columns.groups")}
              </TableHead>
              <TableHead className={HEAD_CLASS}>
                {t("subscriptionTemplates.columns.usage")}
              </TableHead>
              <TableHead className={HEAD_CLASS}>
                {t("subscriptionTemplates.columns.updatedAt")}
              </TableHead>
              <TableHead className={cn(HEAD_CLASS, "text-right")}>
                {t("subscriptionTemplates.columns.actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {showError ? (
              <ListErrorRow
                  colSpan={COLUMN_COUNT}
                  title={t("subscriptionTemplates.loadFailed")}
                  message={errorText(
                  templates.error,
                  t("subscriptionTemplates.loadError"),
                )}
                  retrying={templates.isFetching}
                  onRetry={() => void templates.refetch()}
                />
            ) : items.length === 0 ? (
              <EmptyRow onCreate={() => setFormState({ mode: "create" })} />
            ) : (
              items.map((template) => (
                <TableRow key={template.id}>
                  <TableCell className="px-4 py-3 font-medium">
                    {template.name}
                  </TableCell>
                  <TableCell className="max-w-[420px] px-4 py-3">
                    <Badge
                      variant="secondary"
                      className="font-normal text-muted-foreground"
                    >
                      {t(
                        template.groups.length === 1
                          ? "subscriptionTemplates.groupCountOne"
                          : "subscriptionTemplates.groupCount",
                        { n: template.groups.length },
                      )}
                    </Badge>
                    <p
                      className="mt-1 truncate font-mono type-micro text-muted-foreground"
                      title={groupSummary(template)}
                    >
                      {groupSummary(template)}
                    </p>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <UsageCell template={template} />
                  </TableCell>
                  <TableCell
                    className="px-4 py-3 type-micro text-muted-foreground"
                    title={formatAbsoluteTime(template.updated_at)}
                  >
                    {formatRelativeTime(template.updated_at)}
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={t("subscriptionTemplates.previewAria", {
                          name: template.name,
                        })}
                        title={t("subscriptionTemplates.previewAria", {
                          name: template.name,
                        })}
                        onClick={() => setPreviewTarget(template)}
                      >
                        <EyeIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={t("subscriptionTemplates.copyAria", {
                          name: template.name,
                        })}
                        title={t("subscriptionTemplates.copyAria", {
                          name: template.name,
                        })}
                        onClick={() => setFormState({ mode: "copy", template })}
                      >
                        <CopyIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label={t("subscriptionTemplates.editAria", {
                          name: template.name,
                        })}
                        title={t("subscriptionTemplates.editAria", {
                          name: template.name,
                        })}
                        onClick={() => setFormState({ mode: "edit", template })}
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        aria-label={t("subscriptionTemplates.deleteAria", {
                          name: template.name,
                        })}
                        title={t("subscriptionTemplates.deleteAria", {
                          name: template.name,
                        })}
                        onClick={() => setDeleteTarget(template)}
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

      <SubscriptionTemplateFormDialog
        key={
          formState?.mode === "edit"
            ? `edit-${formState.template.id}`
            : formState?.mode === "copy"
              ? `copy-${formState.template.id}`
              : "create"
        }
        open={formState !== null}
        template={
          formState?.mode === "edit" ? formState.template : undefined
        }
        initialDraft={
          formState?.mode === "copy"
            ? copyTemplateDraft(
                formState.template,
                items.map((template) => template.name),
                t("subscriptionTemplates.copySuffix"),
              )
            : undefined
        }
        onOpenChange={(open) => {
          if (!open) setFormState(null);
        }}
      />

      {previewTarget ? (
        <SubscriptionTemplatePreviewDialog
          template={previewTarget}
          open
          onOpenChange={(open) => {
            if (!open) setPreviewTarget(null);
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteSubscriptionTemplateDialog
          template={deleteTarget}
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      ) : null}
    </Card>
  );
}
