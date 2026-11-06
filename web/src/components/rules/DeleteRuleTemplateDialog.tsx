import { useState } from "react";
import { Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
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
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import type { RuleTemplate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useDeleteRuleTemplate } from "@/lib/queries";
import { t } from "@/i18n";

interface DeleteRuleTemplateDialogProps {
  template: RuleTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteRuleTemplateDialog({
  template,
  open,
  onOpenChange,
}: DeleteRuleTemplateDialogProps) {
  const deleteTemplate = useDeleteRuleTemplate();
  const [error, setError] = useState<string | null>(null);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && deleteTemplate.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("rules.delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("rules.delete.desc", { name: template.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>{t("rules.delete.errorTitle")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteTemplate.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteTemplate.isPending}
            onClick={(event) => {
              event.preventDefault();
              setError(null);
              deleteTemplate.mutate(template.id, {
                onSuccess: () => {
                  toast.success(
                    t("rules.delete.success", { name: template.name }),
                  );
                  onOpenChange(false);
                },
                onError: (err) => {
                  // 默认模板 / 名称冲突等后端中文错误原样展示。
                  setError(errorText(err, t("rules.delete.error")));
                },
              });
            }}
          >
            {t("rules.delete.action")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
