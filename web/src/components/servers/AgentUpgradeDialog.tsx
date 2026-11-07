import { useState } from "react";
import type { FormEvent } from "react";
import {
  ArrowUpCircleIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  displayAgentVersion,
  hasPendingAgentUpgrade,
} from "@/lib/agentUpgrade";
import type { Server } from "@/lib/api";
import { errorText, isNotFound } from "@/lib/errors";
import { useTriggerAgentUpgrade } from "@/lib/queries";
import { t, useI18n } from "@/i18n";

interface AgentUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: Server;
}

/**
 * 下发 Agent 升级。
 *
 * 前端目前拿不到可用版本列表，所以不预填、不猜版本号：
 * 留空表示「使用最新版本」，需要指定时由管理员手填。
 */
export function AgentUpgradeDialog({
  open,
  onOpenChange,
  server,
}: AgentUpgradeDialogProps) {
  useI18n();
  const triggerUpgrade = useTriggerAgentUpgrade(server.id);
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);

  const currentLabel =
    displayAgentVersion(server.agent_version) ||
    t("servers.upgradeDialog.notReported");
  const trimmedVersion = version.trim();
  const targetLabel = trimmedVersion
    ? displayAgentVersion(trimmedVersion)
    : t("servers.upgradeDialog.latest");
  const pendingTarget = hasPendingAgentUpgrade(server)
    ? displayAgentVersion(server.agent_target_version)
    : "";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (triggerUpgrade.isPending) return;

    setError(null);
    try {
      const upgrade = await triggerUpgrade.mutateAsync({
        // 空串 = 使用最新版本；不要在这里猜一个版本号。
        version: trimmedVersion,
      });
      const resolvedTarget =
        displayAgentVersion(upgrade.to_version) ||
        t("servers.upgradeDialog.latest");
      toast.success(t("servers.upgradeDialog.queued"), {
        description: t("servers.upgradeDialog.queuedDesc", {
          version: resolvedTarget,
        }),
        duration: 6000,
      });
      onOpenChange(false);
    } catch (submitError) {
      const message = isNotFound(submitError)
        ? t("servers.upgradeDialog.notReady404")
        : errorText(submitError, t("servers.upgradeDialog.error"));
      setError(message);
      toast.error(message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && triggerUpgrade.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
              <ArrowUpCircleIcon className="size-3.5" />
            </span>
            {t("servers.upgradeDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("servers.upgradeDialog.desc", { name: server.name })}
          </DialogDescription>
        </DialogHeader>

        <form
          id="agent-upgrade-form"
          className="flex flex-col gap-4"
          onSubmit={handleSubmit}
        >
          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs">
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">
                {t("servers.upgradeDialog.current")}
              </dt>
              <dd className="font-mono text-sm text-foreground">{currentLabel}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">
                {t("servers.upgradeDialog.target")}
              </dt>
              <dd className="font-mono text-sm text-foreground">{targetLabel}</dd>
            </div>
          </dl>

          <div className="flex flex-col gap-2">
            <Label htmlFor="agent-upgrade-version">
              {t("servers.upgradeDialog.version")}
            </Label>
            <Input
              id="agent-upgrade-version"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder={t("servers.upgradeDialog.versionPlaceholder")}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              disabled={triggerUpgrade.isPending}
            />
            <p className="text-xs text-muted-foreground">
              {t("servers.upgradeDialog.versionHint")}
            </p>
            {pendingTarget ? (
              <p className="text-xs text-warning">
                {t("servers.upgradeDialog.pendingHint", {
                  version: pendingTarget,
                })}
              </p>
            ) : null}
          </div>

          <Alert className="border-warning/30 bg-warning/10 text-warning">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription className="text-xs text-warning">
              {t("servers.upgradeDialog.warning")}
            </AlertDescription>
          </Alert>

          {error ? (
            <p
              role="alert"
              aria-live="polite"
              className="text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={triggerUpgrade.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="agent-upgrade-form"
            disabled={triggerUpgrade.isPending}
          >
            {triggerUpgrade.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : null}
            {triggerUpgrade.isPending
              ? t("servers.upgradeDialog.submitting")
              : t("servers.upgradeDialog.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
