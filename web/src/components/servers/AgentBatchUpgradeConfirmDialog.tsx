import { useState } from "react";
import type { FormEvent } from "react";
import { ArrowUpCircleIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { displayAgentVersion } from "@/lib/agentUpgrade";
import type { AgentUpgradeBatch } from "@/lib/api";
import { errorText, isNotFound } from "@/lib/errors";
import { useCreateAgentUpgradeBatch } from "@/lib/queries";
import { t, useI18n } from "@/i18n";

interface AgentBatchUpgradeConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已选且都开启了「允许下发升级」的服务器 id。 */
  serverIds: string[];
  /** 归一化后的目标版本；空串表示最新版本。 */
  version: string;
  onCreated: (batch: AgentUpgradeBatch) => void;
}

/**
 * 批量升级提交前的确认。
 *
 * 明确告知「N 台、会依次中断」，并把默认开启的「失败即停止」放在这里，
 * 避免用户在服务器列表的操作条上直接触发一个会中断多台节点的动作。
 */
export function AgentBatchUpgradeConfirmDialog({
  open,
  onOpenChange,
  serverIds,
  version,
  onCreated,
}: AgentBatchUpgradeConfirmDialogProps) {
  useI18n();
  const createBatch = useCreateAgentUpgradeBatch();
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 弹窗由列表按需挂载，每次打开都是新实例，默认策略就是「失败即停止」。

  const count = serverIds.length;
  const targetLabel =
    displayAgentVersion(version) || t("servers.batch.progress.latest");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (createBatch.isPending || count === 0) return;

    setError(null);
    try {
      const batch = await createBatch.mutateAsync({
        server_ids: serverIds,
        // 空串省略：让后端按「最新版本」处理，而不是上报一个空版本号。
        ...(version ? { version } : {}),
        stop_on_failure: stopOnFailure,
      });
      toast.success(t("servers.batch.confirm.queued"), {
        description: t("servers.batch.confirm.queuedDesc", { n: count }),
        duration: 6000,
      });
      onCreated(batch);
      onOpenChange(false);
    } catch (submitError) {
      const message = isNotFound(submitError)
        ? t("servers.batch.confirm.notReady404")
        : errorText(submitError, t("servers.batch.confirm.error"));
      setError(message);
      toast.error(message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && createBatch.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
              <ArrowUpCircleIcon className="size-3.5" />
            </span>
            {t("servers.batch.confirm.title")}
          </DialogTitle>
          <DialogDescription>
            {t("servers.batch.confirm.desc", { n: count })}
          </DialogDescription>
        </DialogHeader>

        <form
          id="agent-batch-upgrade-form"
          className="flex flex-col gap-4"
          onSubmit={handleSubmit}
        >
          <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-xs">
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">
                {t("servers.batch.confirm.count")}
              </dt>
              <dd className="text-sm font-medium text-foreground">
                {t("servers.batch.confirm.countValue", { n: count })}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground">
                {t("servers.batch.confirm.target")}
              </dt>
              <dd className="font-mono text-sm text-foreground">
                {targetLabel}
              </dd>
            </div>
          </dl>

          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="batch-stop-on-failure" className="text-sm">
                {t("servers.batch.confirm.stopOnFailure")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("servers.batch.confirm.stopOnFailureHint")}
              </p>
            </div>
            <Switch
              id="batch-stop-on-failure"
              checked={stopOnFailure}
              onCheckedChange={setStopOnFailure}
              disabled={createBatch.isPending}
            />
          </div>

          <Alert className="border-warning/30 bg-warning/10 text-warning">
            <TriangleAlertIcon aria-hidden="true" />
            <AlertDescription className="text-xs text-warning">
              {t("servers.batch.confirm.warning", { n: count })}
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
            disabled={createBatch.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="agent-batch-upgrade-form"
            disabled={createBatch.isPending || count === 0}
          >
            {createBatch.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : null}
            {createBatch.isPending
              ? t("servers.batch.confirm.submitting")
              : t("servers.batch.confirm.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
