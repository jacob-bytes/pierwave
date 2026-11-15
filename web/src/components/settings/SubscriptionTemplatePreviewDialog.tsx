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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SubscriptionTemplate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { usePreviewSubscriptionTemplate, useUsers } from "@/lib/queries";
import { previewDisabled } from "@/lib/subscriptionTemplates";
import { t, useI18n } from "@/i18n";

interface SubscriptionTemplatePreviewDialogProps {
  template: SubscriptionTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 用真实用户渲染 mihomo 配置，并展示模板 warning。 */
export function SubscriptionTemplatePreviewDialog({
  template,
  open,
  onOpenChange,
}: SubscriptionTemplatePreviewDialogProps) {
  useI18n();
  const users = useUsers("");
  const preview = usePreviewSubscriptionTemplate();
  const [userId, setUserId] = useState("");
  const [result, setResult] = useState<{
    yaml: string;
    warnings: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items = users.data ?? [];

  function reset() {
    setResult(null);
    setError(null);
    preview.reset();
  }

  function run() {
    setError(null);
    preview.mutate(
      { id: template.id, userId },
      {
        onSuccess: (data) => setResult(data),
        onError: (caught) =>
          setError(errorText(caught, t("subscriptionTemplates.preview.error"))),
      },
    );
  }

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

        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="subscription-template-preview-user"
            >
              {t("subscriptionTemplates.preview.user")}
            </label>
            <Select
              value={userId}
              onValueChange={(value) => {
                setUserId(value);
                setResult(null);
                setError(null);
              }}
              disabled={preview.isPending || items.length === 0}
            >
              <SelectTrigger
                id="subscription-template-preview-user"
                className="w-full"
              >
                <SelectValue
                  placeholder={
                    users.isPending
                      ? t("subscriptionTemplates.loading")
                      : items.length === 0
                        ? t("subscriptionTemplates.preview.noUsers")
                        : t("subscriptionTemplates.preview.userPlaceholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {items.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    <span className="truncate">{user.username}</span>
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
              hasUser: userId !== "",
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

        {users.isError && items.length === 0 ? (
          <p className="flex items-start gap-1.5 type-micro text-muted-foreground">
            <TriangleAlertIcon className="mt-0.5 size-3 shrink-0 text-destructive" />
            <span>{t("subscriptionTemplates.preview.loadUsersError")}</span>
          </p>
        ) : null}

        {error ? (
          <p className="flex items-start gap-1.5 type-micro text-muted-foreground">
            <TriangleAlertIcon className="mt-0.5 size-3 shrink-0 text-destructive" />
            <span>{error}</span>
          </p>
        ) : null}

        {result ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t("subscriptionTemplates.preview.warnings")}
              </p>
              {result.warnings.length === 0 ? (
                <p className="type-micro text-muted-foreground">
                  {t("subscriptionTemplates.preview.noWarnings")}
                </p>
              ) : (
                <ul className="space-y-1 rounded-lg border border-border bg-muted/20 p-2.5 text-xs text-muted-foreground">
                  {result.warnings.map((warning, index) => (
                    <li key={index} className="flex items-start gap-1.5">
                      <TriangleAlertIcon className="mt-0.5 size-3 shrink-0 text-amber-500" />
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t("subscriptionTemplates.preview.yaml")}
              </p>
              <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/20 p-3 font-mono type-micro leading-normal">
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
