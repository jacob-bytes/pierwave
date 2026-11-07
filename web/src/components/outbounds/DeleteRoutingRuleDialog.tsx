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
import type { RoutingRule } from "@/lib/api";
import { outboundErrorText } from "@/lib/outbounds";
import { useDeleteRoutingRule } from "@/lib/queries";
import { useI18n } from "@/i18n";

interface DeleteRoutingRuleDialogProps {
  serverId: string;
  rule: RoutingRule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 规则没有 tag，用「匹配条件摘要」在确认框里指明删的是哪一条。 */
function ruleSummary(rule: RoutingRule, separator: string): string {
  const parts = [
    rule.inbound_tag?.trim(),
    rule.domain?.trim(),
    rule.ip?.trim(),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(separator) : "—";
}

export function DeleteRoutingRuleDialog({
  serverId,
  rule,
  open,
  onOpenChange,
}: DeleteRoutingRuleDialogProps) {
  const { t } = useI18n();
  const deleteRule = useDeleteRoutingRule(serverId);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && deleteRule.isPending) return;
        onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-destructive/10 text-destructive">
            <Trash2Icon className="size-5" />
          </AlertDialogMedia>
          <AlertDialogTitle>
            {t("outbounds.rules.delete.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("outbounds.rules.delete.desc", {
              rule: ruleSummary(rule, t("common.listSeparator")),
            })}
          </AlertDialogDescription>
          {errorMessage ? (
            <p role="alert" className="text-xs text-destructive">
              {errorMessage}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteRule.isPending}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteRule.isPending}
            onClick={(event) => {
              event.preventDefault();
              setErrorMessage(null);
              deleteRule.mutate(rule.id, {
                onSuccess: () => {
                  toast.success(t("outbounds.rules.delete.success"));
                  onOpenChange(false);
                },
                onError: (error) => {
                  const message = outboundErrorText(
                    error,
                    t("outbounds.rules.delete.error"),
                  );
                  setErrorMessage(message);
                  toast.error(message);
                },
              });
            }}
          >
            {t("outbounds.rules.delete.action")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
