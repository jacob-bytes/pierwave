import { toast } from "sonner";
import { Trash2Icon } from "lucide-react";
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
import type { Node } from "@/lib/api";
import { errorText } from "@/lib/errors";
import { useDeleteNode } from "@/lib/queries";
import { t } from "@/i18n";

interface DeleteNodeDialogProps {
  serverId: string;
  node: Node;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DeleteNodeDialog({
  serverId,
  node,
  open,
  onOpenChange,
}: DeleteNodeDialogProps) {
  const deleteNode = useDeleteNode(serverId);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && deleteNode.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("nodes.deleteDialog.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("nodes.deleteDialog.desc", { name: node.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteNode.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteNode.isPending}
            onClick={(event) => {
              event.preventDefault();
              deleteNode.mutate(node.id, {
                onSuccess: () => {
                  toast.success(t("nodes.deleteDialog.success"));
                  onOpenChange(false);
                },
                onError: (error) => {
                  toast.error(
                    errorText(error, t("nodes.deleteDialog.error")),
                  );
                },
              });
            }}
          >
            {t("nodes.deleteDialog.action")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
