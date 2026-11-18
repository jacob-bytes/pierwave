import { LockKeyholeIcon } from "lucide-react";
import { toast } from "sonner";
import {
  SettingsGroup,
  SETTINGS_FULL_ROW,
} from "@/components/settings/SettingsGroup";
import { ListError } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/errors";
import { useSettings, useUpdateSettings } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/**
 * 备份加密开关。
 *
 * 与「备份与恢复」共用 `GET /api/v1/settings` 缓存；默认开启，关闭后
 * 导出与异地备份都是明文 `.db.gz`，所以关闭状态必须常驻一条显式提示。
 */
export function BackupEncryptionCard() {
  useI18n();
  const settings = useSettings();
  const update = useUpdateSettings();

  const enabled = settings.data?.backup_encrypt ?? true;

  const handleChange = (next: boolean) => {
    update.mutate(
      { backup_encrypt: next },
      {
        onSuccess: () => toast.success(t("settings.backup.encrypt.saved")),
        onError: (error) =>
          toast.error(
            errorText(error, t("settings.backup.encrypt.saveError")),
          ),
      },
    );
  };

  if (settings.isPending) {
    return (
      <Card>
        <CardContent className="space-y-3" aria-busy="true">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-full max-w-md" />
        </CardContent>
      </Card>
    );
  }

  if (settings.isError) {
    return (
      <Card>
        <CardContent>
          <ListError
            title={t("settings.backup.encrypt.loadFailed")}
            message={errorText(settings.error, t("settings.backup.encrypt.loadError"))}
            retrying={settings.isFetching}
            onRetry={() => void settings.refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <SettingsGroup
      icon={LockKeyholeIcon}
      title={t("settings.backup.encrypt.title")}
    >
      <div className={cn(SETTINGS_FULL_ROW, "space-y-3")}>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="settings-backup-encrypt" className="cursor-pointer">
            {t("settings.backup.encrypt.label")}
          </Label>
          <Switch
            id="settings-backup-encrypt"
            checked={enabled}
            disabled={update.isPending}
            onCheckedChange={handleChange}
          />
        </div>
        {enabled ? null : (
          <p className="text-xs leading-relaxed text-destructive">
            {t("settings.backup.encrypt.offWarning")}
          </p>
        )}
      </div>
    </SettingsGroup>
  );
}
