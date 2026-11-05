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
          <AlertDialogTitle>删除证书</AlertDialogTitle>
          <AlertDialogDescription>
            确定删除「{certificate.name}」？删除后不可恢复；如果还有 TLS
            节点在引用，需要先删除或重建这些节点。
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>无法删除</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteCertificate.isPending}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteCertificate.isPending}
            onClick={(event) => {
              event.preventDefault();
              setError(null);
              deleteCertificate.mutate(certificate.id, {
                onSuccess: () => {
                  toast.success(`证书「${certificate.name}」已删除`);
                  onOpenChange(false);
                },
                onError: (err) => {
                  // 被节点引用时后端返回 400 的中文说明，原样展示在对话框里。
                  setError(errorText(err, "删除证书失败，请稍后重试"));
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
