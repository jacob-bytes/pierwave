import { useState } from "react";
import { Trash2Icon } from "lucide-react";
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
import type { Forward } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatForwardTarget } from "@/lib/forwards";
import { useDeleteForward } from "@/lib/queries";
import { useI18n } from "@/i18n";

interface DeleteForwardDialogProps {
  serverId: string;
  forward: Forward;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteForwardDialog({
  serverId,
  forward,
  open,
  onOpenChange,
}: DeleteForwardDialogProps) {
  const { t } = useI18n();
  const deleteForward = useDeleteForward(serverId);
  // 删除失败（例如规则已被别处删掉）时把后端文案原样贴在对话框里。
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const target = formatForwardTarget(forward.target_host, forward.target_port);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && deleteForward.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("forwards.delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("forwards.delete.desc", { name: forward.name, target })}
          </AlertDialogDescription>
          {errorMessage ? (
            <p role="alert" className="text-xs text-destructive">
              {errorMessage}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteForward.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteForward.isPending}
            onClick={(event) => {
              event.preventDefault();
              setErrorMessage(null);
              deleteForward.mutate(forward.id, {
                onSuccess: () => {
                  toast.success(
                    t("forwards.delete.success", { name: forward.name }),
                  );
                  onOpenChange(false);
                },
                onError: (error) => {
                  const message = errorText(
                    error,
                    t("forwards.delete.error"),
                  );
                  setErrorMessage(message);
                  toast.error(message);
                },
              });
            }}
          >
            {t("forwards.delete.action")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
