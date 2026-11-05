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
          <AlertDialogTitle>删除节点</AlertDialogTitle>
          <AlertDialogDescription>
            确定删除「{node.name}」？删除后需要重新应用配置才对服务器生效。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteNode.isPending}>
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteNode.isPending}
            onClick={(event) => {
              event.preventDefault();
              deleteNode.mutate(node.id, {
                onSuccess: () => {
                  toast.success("节点已删除，记得重新应用配置");
                  onOpenChange(false);
                },
                onError: (error) => {
                  toast.error(
                    errorText(error, "删除节点失败，请稍后重试"),
                  );
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
