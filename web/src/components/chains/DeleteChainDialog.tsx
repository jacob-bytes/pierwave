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
import type { Chain } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatForwardTarget } from "@/lib/forwards";
import { useDeleteChain } from "@/lib/queries";
import { useI18n } from "@/i18n";

interface DeleteChainDialogProps {
  chain: Chain;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteChainDialog({
  chain,
  open,
  onOpenChange,
}: DeleteChainDialogProps) {
  const { t } = useI18n();
  const deleteChain = useDeleteChain();
  // 删除失败（例如链已被别处删掉）时把后端文案原样贴在对话框里。
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const target = formatForwardTarget(chain.target_host, chain.target_port);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && deleteChain.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("chains.delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("chains.delete.desc", {
              name: chain.name,
              hops: chain.hops.length,
              target,
            })}
          </AlertDialogDescription>
          {errorMessage ? (
            <p role="alert" className="text-xs text-destructive">
              {errorMessage}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteChain.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteChain.isPending}
            onClick={(event) => {
              event.preventDefault();
              setErrorMessage(null);
              deleteChain.mutate(chain.id, {
                onSuccess: () => {
                  toast.success(
                    t("chains.delete.success", { name: chain.name }),
                  );
                  onOpenChange(false);
                },
                onError: (error) => {
                  const message = errorText(error, t("chains.delete.error"));
                  setErrorMessage(message);
                  toast.error(message);
                },
              });
            }}
          >
            {t("chains.delete.action")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
