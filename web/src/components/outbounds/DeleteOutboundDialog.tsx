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
import type { Outbound } from "@/lib/api";
import { outboundErrorText } from "@/lib/outbounds";
import { useDeleteOutbound } from "@/lib/queries";
import { useI18n } from "@/i18n";

interface DeleteOutboundDialogProps {
  serverId: string;
  outbound: Outbound;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteOutboundDialog({
  serverId,
  outbound,
  open,
  onOpenChange,
}: DeleteOutboundDialogProps) {
  const { t } = useI18n();
  const deleteOutbound = useDeleteOutbound(serverId);
  // 被路由规则引用时后端返回 400 中文说明，原样贴在对话框里。
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && deleteOutbound.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {t("outbounds.delete.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("outbounds.delete.desc", { tag: outbound.tag })}
          </AlertDialogDescription>
          {errorMessage ? (
            <p role="alert" className="text-xs text-destructive">
              {errorMessage}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteOutbound.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteOutbound.isPending}
            onClick={(event) => {
              event.preventDefault();
              setErrorMessage(null);
              deleteOutbound.mutate(outbound.id, {
                onSuccess: () => {
                  toast.success(
                    t("outbounds.delete.success", { tag: outbound.tag }),
                  );
                  onOpenChange(false);
                },
                onError: (error) => {
                  const message = outboundErrorText(
                    error,
                    t("outbounds.delete.error"),
                  );
                  setErrorMessage(message);
                  toast.error(message);
                },
              });
            }}
          >
            {t("outbounds.delete.action")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
