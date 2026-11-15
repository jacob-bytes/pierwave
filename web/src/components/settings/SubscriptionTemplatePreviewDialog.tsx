import { useState } from "react";
import { Loader2Icon, PlayIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SubscriptionTemplate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import {
  usePackages,
  usePreviewSubscriptionTemplate,
  useUsers,
} from "@/lib/queries";
import {
  TEMPLATE_PREVIEW_FORMATS,
  parsePreviewSubject,
  previewDisabled,
  previewSubjectValue,
  resolvePreviewFormat,
  type TemplatePreviewFormat,
} from "@/lib/subscriptionTemplates";
import { t, useI18n } from "@/i18n";

interface SubscriptionTemplatePreviewDialogProps {
  template: SubscriptionTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 用真实用户或套餐渲染目标格式的配置，并展示模板 warning。 */
export function SubscriptionTemplatePreviewDialog({
  template,
  open,
  onOpenChange,
}: SubscriptionTemplatePreviewDialogProps) {
  useI18n();
  const users = useUsers("");
  const packages = usePackages();
  const preview = usePreviewSubscriptionTemplate();
  const [subject, setSubject] = useState("");
  const [format, setFormat] = useState<TemplatePreviewFormat>("mihomo");
  const [result, setResult] = useState<{
    yaml: string;
    format?: string;
    warnings: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const userItems = users.data ?? [];
  const packageItems = packages.data ?? [];
  const subjectItemsPending = users.isPending || packages.isPending;
  const subjectItemsEmpty =
    !subjectItemsPending && userItems.length === 0 && packageItems.length === 0;

  function reset() {
    setResult(null);
    setError(null);
    preview.reset();
  }

  function run() {
    const target = parsePreviewSubject(subject);
    if (!target) return;
    setError(null);
    preview.mutate(
      {
        id: template.id,
        // 后端 user_id / package_id 二选一：这里只送选中的那一个。
        userId: target.kind === "user" ? target.id : undefined,
        packageId: target.kind === "package" ? target.id : undefined,
        target: format,
      },
      {
        onSuccess: (data) => setResult(data),
        onError: (caught) =>
          setError(errorText(caught, t("subscriptionTemplates.preview.error"))),
      },
    );
  }

  const renderedFormat = resolvePreviewFormat(result?.format ?? format);
  const formatLabel = renderedFormat
    ? t(`subscriptionTemplates.preview.formats.${renderedFormat}`)
    : (result?.format ?? format);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && preview.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("subscriptionTemplates.preview.title")}</DialogTitle>
          <DialogDescription>
            {t("subscriptionTemplates.preview.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="subscription-template-preview-subject"
            >
              {t("subscriptionTemplates.preview.subject")}
            </label>
            <Select
              value={subject}
              onValueChange={(value) => {
                setSubject(value);
                setResult(null);
                setError(null);
              }}
              disabled={preview.isPending || subjectItemsEmpty}
            >
              <SelectTrigger
                id="subscription-template-preview-subject"
                className="w-full"
              >
                <SelectValue
                  placeholder={
                    subjectItemsPending
                      ? t("subscriptionTemplates.loading")
                      : subjectItemsEmpty
                        ? t("subscriptionTemplates.preview.noSubjects")
                        : t("subscriptionTemplates.preview.subjectPlaceholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {userItems.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>
                      {t("subscriptionTemplates.preview.usersGroup")}
                    </SelectLabel>
                    {userItems.map((user) => (
                      <SelectItem
                        key={user.id}
                        value={previewSubjectValue({
                          kind: "user",
                          id: user.id,
                        })}
                      >
                        <span className="truncate">{user.username}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
                {packageItems.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>
                      {t("subscriptionTemplates.preview.packagesGroup")}
                    </SelectLabel>
                    {packageItems.map((item) => (
                      <SelectItem
                        key={item.id}
                        value={previewSubjectValue({
                          kind: "package",
                          id: item.id,
                        })}
                      >
                        <span className="truncate">{item.name}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
          </div>
          <div className="w-44 space-y-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="subscription-template-preview-format"
            >
              {t("subscriptionTemplates.preview.format")}
            </label>
            <Select
              value={format}
              onValueChange={(value) => {
                const next = resolvePreviewFormat(value);
                if (!next) return;
                setFormat(next);
                setResult(null);
                setError(null);
              }}
              disabled={preview.isPending}
            >
              <SelectTrigger
                id="subscription-template-preview-format"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TEMPLATE_PREVIEW_FORMATS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`subscriptionTemplates.preview.formats.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            type="button"
            onClick={run}
            disabled={previewDisabled({
              pending: preview.isPending,
              hasTemplate: Boolean(template.id),
              hasSubject: parsePreviewSubject(subject) !== null,
            })}
          >
            {preview.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <PlayIcon className="size-4" />
            )}
            {preview.isPending
              ? t("subscriptionTemplates.preview.running")
              : t("subscriptionTemplates.preview.run")}
          </Button>
        </div>

        {(users.isError || packages.isError) &&
        userItems.length === 0 &&
        packageItems.length === 0 ? (
          <p className="flex items-start gap-1.5 type-micro text-muted-foreground">
            <TriangleAlertIcon className="mt-0.5 size-3 shrink-0 text-destructive" />
            <span>{t("subscriptionTemplates.preview.loadSubjectsError")}</span>
          </p>
        ) : null}

        {error ? (
          <p className="flex items-start gap-1.5 type-micro text-muted-foreground">
            <TriangleAlertIcon className="mt-0.5 size-3 shrink-0 text-destructive" />
            <span>{error}</span>
          </p>
        ) : null}

        {result ? (
          <div className="min-w-0 space-y-3">
            <div className="min-w-0 space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t("subscriptionTemplates.preview.warnings")}
              </p>
              {result.warnings.length === 0 ? (
                <p className="type-micro text-muted-foreground">
                  {t("subscriptionTemplates.preview.noWarnings")}
                </p>
              ) : (
                <ul className="min-w-0 space-y-1 rounded-lg border border-border bg-muted/20 p-2.5 text-xs text-muted-foreground">
                  {result.warnings.map((warning, index) => (
                    <li key={index} className="flex min-w-0 items-start gap-1.5">
                      <TriangleAlertIcon className="mt-0.5 size-3 shrink-0 text-amber-500" />
                      <span className="min-w-0 break-words">{warning}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="min-w-0 space-y-1.5">
              <p
                className="text-xs font-medium text-muted-foreground"
                data-testid="subscription-template-preview-format-label"
              >
                {t("subscriptionTemplates.preview.output")} · {formatLabel}
              </p>
              <pre className="max-h-96 min-w-0 overflow-auto rounded-lg border border-border bg-muted/20 p-3 font-mono type-micro leading-normal">
                {result.yaml}
              </pre>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={preview.isPending}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
