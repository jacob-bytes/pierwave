import { useState } from "react";
import type { FormEvent } from "react";
import {
  Loader2Icon,
  SlidersHorizontalIcon,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CountrySelect } from "@/components/common/CountrySelect";
import { displayAgentVersion } from "@/lib/agentUpgrade";
import type { Server } from "@/lib/api";
import { isCountryCode } from "@/lib/country";
import { errorText, isNotFound } from "@/lib/errors";
import { useUpdateServer } from "@/lib/queries";
import {
  GROUP_NAME_MAX_LENGTH,
  normalizeGroupName,
} from "@/lib/serverGroups";
import { t } from "@/i18n";


interface ServerEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: Server;
}

/**
 * 服务器设置：目前只有 P4 的「允许下发升级」开关。
 *
 * 开关不即时生效，点「保存修改」才 PATCH；后端可能暂时 404，
 * 这里统一兜底成可翻译的中文错误，不写入任何 mock 数据。
 */
export function ServerEditDialog({
  open,
  onOpenChange,
  server,
}: ServerEditDialogProps) {

  const updateServer = useUpdateServer();
  // Dialog 只在选中服务器时挂载，初始值就是最新值；不跟随轮询覆盖未保存的修改。
  const [allowUpgrade, setAllowUpgrade] = useState(() =>
    Boolean(server.allow_agent_upgrade),
  );
  const [countryCode, setCountryCode] = useState(
    () => server.country_code ?? "",
  );
  const [groupName, setGroupName] = useState(
    () => normalizeGroupName(server.group_name) ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (updateServer.isPending) return;

    const normalizedCountry = countryCode.trim().toUpperCase();
    if (normalizedCountry && !isCountryCode(normalizedCountry)) {
      setError(t("servers.countryInvalid"));
      return;
    }

    setError(null);
    try {
      await updateServer.mutateAsync({
        id: server.id,
        input: {
          allow_agent_upgrade: allowUpgrade,
          country_code: normalizedCountry,
          // 后端把空串当作「清空分组」；null 可能被当成「不改该字段」。
          group_name: normalizeGroupName(groupName) ?? "",
        },
      });
      toast.success(t("servers.editDialog.saved"));
      onOpenChange(false);
    } catch (submitError) {
      const message = isNotFound(submitError)
        ? t("servers.editDialog.notReady404")
        : errorText(submitError, t("servers.editDialog.error"));
      setError(message);
      toast.error(message);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && updateServer.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
              <SlidersHorizontalIcon className="size-3.5" />
            </span>
            {t("servers.editDialog.title")}
          </DialogTitle>
          <DialogDescription>
            {t("servers.editDialog.desc", { name: server.name })}
          </DialogDescription>
        </DialogHeader>

        <form
          id="server-settings-form"
          className="flex flex-col gap-4"
          onSubmit={handleSubmit}
        >
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs">
            <span className="text-muted-foreground">
              {t("servers.editDialog.currentVersion")}
            </span>
            <span className="font-mono text-foreground">
              {displayAgentVersion(server.agent_version) ||
                t("servers.upgradeDialog.notReported")}
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="server-country" className="text-sm">
              {t("servers.country")}
            </Label>
            <CountrySelect
              value={countryCode}
              onChange={setCountryCode}
              disabled={updateServer.isPending}
            />
            <p
              id="server-country-desc"
              className="text-xs leading-relaxed text-muted-foreground"
            >
              {t("servers.countryHint")}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="server-group" className="text-sm">
              {t("servers.group")}
            </Label>
            <Input
              id="server-group"
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              placeholder={t("servers.groupPlaceholder")}
              maxLength={GROUP_NAME_MAX_LENGTH}
              autoComplete="off"
              disabled={updateServer.isPending}
            />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="allow-agent-upgrade" className="text-sm">
                {t("servers.editDialog.allow")}
              </Label>
              <p
                id="allow-agent-upgrade-desc"
                className="text-xs leading-relaxed text-muted-foreground"
              >
                {t("servers.editDialog.allowDesc")}
              </p>
            </div>
            <Switch
              id="allow-agent-upgrade"
              checked={allowUpgrade}
              onCheckedChange={setAllowUpgrade}
              disabled={updateServer.isPending}
              aria-describedby="allow-agent-upgrade-desc"
            />
          </div>

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
            disabled={updateServer.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form="server-settings-form"
            disabled={updateServer.isPending}
          >
            {updateServer.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : null}
            {updateServer.isPending
              ? t("common.saving")
              : t("servers.editDialog.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
