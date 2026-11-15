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
import type { SubscriptionTemplate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useDeleteSubscriptionTemplate } from "@/lib/queries";
import { t } from "@/i18n";

interface DeleteSubscriptionTemplateDialogProps {
  template: SubscriptionTemplate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteSubscriptionTemplateDialog({
  template,
  open,
  onOpenChange,
}: DeleteSubscriptionTemplateDialogProps) {
  const deleteTemplate = useDeleteSubscriptionTemplate();
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
          <AlertDialogTitle>
            {t("subscriptionTemplates.delete.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("subscriptionTemplates.delete.desc", { name: template.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>
              {t("subscriptionTemplates.delete.errorTitle")}
            </AlertTitle>
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
                    t("subscriptionTemplates.delete.success", {
                      name: template.name,
                    }),
                  );
                  onOpenChange(false);
                },
                onError: (caught) =>
                  setError(
                    errorText(
                      caught,
                      t("subscriptionTemplates.delete.error"),
                    ),
                  ),
              });
            }}
          >
            {t("subscriptionTemplates.delete.action")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
