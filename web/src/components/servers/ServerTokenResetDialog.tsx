import { useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { ResetServerTokenResponse, Server } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { errorText, isNotFound } from "@/lib/errors";
import { useResetServerToken } from "@/lib/queries";
import { useI18n } from "@/i18n";

/**
 * 重置连接令牌：先二次确认破坏性后果，成功后只展示新的安装命令。
 * 旧 token 由主控立即作废，前端不做任何远程执行。
 */
export function ServerTokenResetDialog({
  open,
  onOpenChange,
  server,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: Server;
}) {
  const { t } = useI18n();
  const resetToken = useResetServerToken();
  const [result, setResult] = useState<ResetServerTokenResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    if (resetToken.isPending) return;
    setError(null);
    try {
      const next = await resetToken.mutateAsync({ id: server.id });
      setResult(next);
    } catch (submitError) {
      setError(
        isNotFound(submitError)
          ? t("servers.tokenReset.notReady404")
          : errorText(submitError, t("servers.tokenReset.error")),
      );
    }
  }

  async function handleCopy() {
    if (!result) return;
    if (!(await copyText(result.install_command))) {
      toast.error(t("servers.tokenReset.copyFailed"));
      return;
    }
    setCopied(true);
    toast.success(t("servers.tokenReset.copied"));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && resetToken.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon className="icon-md text-primary" />
            {result
              ? t("servers.tokenReset.successTitle")
              : t("servers.tokenReset.title")}
          </DialogTitle>
          <DialogDescription>
            {result
              ? t("servers.tokenReset.successDesc")
              : t("servers.tokenReset.desc", { name: server.name })}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label>{t("servers.tokenReset.installCommand")}</Label>
              <Button variant="ghost" size="xs" onClick={() => void handleCopy()}>
                {copied ? (
                  <CheckIcon className="text-primary" />
                ) : (
                  <CopyIcon />
                )}
                {copied ? t("common.copied") : t("common.copy")}
              </Button>
            </div>
            <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-normal break-words whitespace-pre-wrap">
              {result.install_command}
            </pre>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
            <TriangleAlertIcon className="mt-0.5 icon-sm shrink-0 text-destructive" />
            <p className="text-muted-foreground">
              {t("servers.tokenReset.warning")}
            </p>
          </div>
        )}

        {error ? (
          <p role="alert" aria-live="polite" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>
              {t("servers.tokenReset.done")}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={resetToken.isPending}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleReset()}
                disabled={resetToken.isPending}
              >
                {resetToken.isPending ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <KeyRoundIcon className="icon-md" />
                )}
                {resetToken.isPending
                  ? t("servers.tokenReset.confirming")
                  : t("servers.tokenReset.confirm")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
