import { useState } from "react";
import { ArrowUpCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { normalizeBatchVersionInput } from "@/lib/agentUpgradeBatch";
import { t, useI18n } from "@/i18n";

type VersionMode = "latest" | "custom";

interface AgentBatchUpgradeBarProps {
  selectedCount: number;
  disabled?: boolean;
  /** 传空串表示「最新版本」；确认弹窗负责再展示一次目标版本。 */
  onStart: (version: string) => void;
  onClear: () => void;
}

/**
 * 有选中服务器时浮在表格上方的批量操作条。
 *
 * 版本选择用「最新版本 / 指定版本」两态，避免空输入框歧义；
 * 确认与「失败即停止」开关放在提交前的确认弹窗里。
 */
export function AgentBatchUpgradeBar({
  selectedCount,
  disabled = false,
  onStart,
  onClear,
}: AgentBatchUpgradeBarProps) {
  useI18n();
  const [versionMode, setVersionMode] = useState<VersionMode>("latest");
  const [customVersion, setCustomVersion] = useState("");

  const version =
    versionMode === "custom" ? normalizeBatchVersionInput(customVersion) : "";
  const customMissing = versionMode === "custom" && version === "";

  return (
    <div
      role="region"
      aria-label={t("servers.batch.barAria")}
      className="animate-in border-b border-border bg-muted/30 px-4 py-3 fade-in-0 slide-in-from-top-1 duration-150"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-medium text-foreground">
          {t("servers.batch.selected", { n: selectedCount })}
        </span>
        <span aria-hidden="true" className="hidden h-4 w-px bg-border sm:block" />
        <div className="flex flex-wrap items-center gap-2">
          <Label
            htmlFor="batch-version-mode"
            className="text-xs text-muted-foreground"
          >
            {t("servers.batch.versionLabel")}
          </Label>
          <Select
            value={versionMode}
            onValueChange={(value) => setVersionMode(value as VersionMode)}
            disabled={disabled}
          >
            <SelectTrigger
              id="batch-version-mode"
              size="sm"
              className="w-32"
              aria-label={t("servers.batch.versionLabel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="latest">
                {t("servers.batch.versionLatest")}
              </SelectItem>
              <SelectItem value="custom">
                {t("servers.batch.versionCustom")}
              </SelectItem>
            </SelectContent>
          </Select>
          {versionMode === "custom" ? (
            <Input
              value={customVersion}
              onChange={(event) => setCustomVersion(event.target.value)}
              placeholder={t("servers.batch.versionPlaceholder")}
              aria-label={t("servers.batch.versionCustom")}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              className="h-7 w-36 font-mono text-xs"
            />
          ) : null}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={disabled}
          >
            {t("servers.batch.clear")}
          </Button>
          <Button
            size="sm"
            onClick={() => onStart(version)}
            disabled={disabled || customMissing}
          >
            <ArrowUpCircleIcon className="size-3.5" />
            {t("servers.batch.start")}
          </Button>
        </div>
      </div>
      {customMissing ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("servers.batch.versionHint")}
        </p>
      ) : null}
    </div>
  );
}
