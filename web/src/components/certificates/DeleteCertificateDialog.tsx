import { useState } from "react";
import { TriangleAlertIcon, Trash2Icon } from "lucide-react";
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
import type { Certificate } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useDeleteCertificate } from "@/lib/queries";
import { t } from "@/i18n";

interface DeleteCertificateDialogProps {
  certificate: Certificate;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteCertificateDialog({
  certificate,
  open,
  onOpenChange,
}: DeleteCertificateDialogProps) {
  const deleteCertificate = useDeleteCertificate();
  const [error, setError] = useState<string | null>(null);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && deleteCertificate.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("certificates.delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("certificates.delete.desc", { name: certificate.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>{t("certificates.delete.errorTitle")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteCertificate.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteCertificate.isPending}
            onClick={(event) => {
              event.preventDefault();
              setError(null);
              deleteCertificate.mutate(certificate.id, {
                onSuccess: () => {
                  toast.success(t("certificates.delete.success", { name: certificate.name }));
                  onOpenChange(false);
                },
                onError: (err) => {
                  // 被节点引用时后端返回 400 的中文说明，原样展示在对话框里。
                  setError(errorText(err, t("certificates.delete.error")));
                },
              });
            }}
          >
            {t("certificates.delete.action")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
