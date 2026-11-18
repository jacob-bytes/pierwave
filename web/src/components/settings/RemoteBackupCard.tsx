import { useState } from "react";
import type { FormEvent } from "react";
import {
  CheckCircle2Icon,
  CloudUploadIcon,
  FileArchiveIcon,
  Loader2Icon,
  RefreshCwIcon,
  SaveIcon,
  TestTube2Icon,
  TriangleAlertIcon,
  UploadCloudIcon,
} from "lucide-react";
import { toast } from "sonner";
import { FormField } from "@/components/FormField";
import {
  SettingsGroup,
  SETTINGS_FULL_ROW,
} from "@/components/settings/SettingsGroup";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ListError } from "@/components/common";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  ApiError,
  type RemoteBackupRunResult,
  type RemoteBackupStatus,
  type RemoteBackupTestResult,
  type Settings,
} from "@/lib/api";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import {
  buildRemoteBackupPayload,
  hasRemoteBackupFormErrors,
  isRemoteBackupConfigured,
  normalizeWebdavUrl,
  redactRemoteError,
  remoteBackupFormFromSettings,
  selectRemoteBackupFiles,
  validateRemoteBackupForm,
  type RemoteBackupFormErrors,
  type RemoteBackupFormValues,
  type RemoteBackupSettings,
  type WebdavUrlProblem,
} from "@/lib/remoteBackup";
import {
  useRemoteBackupStatus,
  useRunRemoteBackup,
  useSettings,
  useTestRemoteBackup,
  useUpdateSettings,
} from "@/lib/queries";
import { formatAbsoluteTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/**
 * 异地备份（WebDAV）：设置卡 + 状态/最近文件。
 *
 * 与「备份与恢复」其它卡片一致：独立于主设置表单，自己拉设置、自己保存
 * （只 PATCH 异地备份相关的键）。密码由后端保存且不回显：输入框永远为空，
 * 占位文案提示「已保存（留空不修改）」。
 */

/** 后端校验失败 → 卡片内可翻译文案。 */
const REMOTE_SETTINGS_ERROR_KEYS: Record<string, string> = {
  "settings.backup_webdav_url_invalid":
    "settings.backup.remote.validation.urlInvalid",
  "settings.backup_webdav_username_invalid":
    "settings.backup.remote.validation.usernameInvalid",
  "settings.backup_webdav_password_invalid":
    "settings.backup.remote.validation.passwordInvalid",
  "settings.backup_webdav_url_required":
    "settings.backup.remote.validation.urlRequired",
  "settings.backup_webdav_password_required":
    "settings.backup.remote.validation.passwordRequired",
};

const URL_PROBLEM_KEYS: Record<WebdavUrlProblem, string> = {
  scheme: "settings.backup.remote.validation.scheme",
  host: "settings.backup.remote.validation.host",
  credentials: "settings.backup.remote.validation.credentials",
  query: "settings.backup.remote.validation.query",
  whitespace: "settings.backup.remote.validation.whitespace",
  port: "settings.backup.remote.validation.port",
};

function remoteErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return t("settings.backup.notReady404");
    if (error.status === 403) return t("settings.backup.forbidden");
    if (error.code && Object.hasOwn(REMOTE_SETTINGS_ERROR_KEYS, error.code)) {
      return t(REMOTE_SETTINGS_ERROR_KEYS[error.code]);
    }
  }
  return redactRemoteError(errorText(error, fallback));
}

function RemoteBackupSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-5" aria-busy="true">
        <div className="space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-8 w-full max-w-md" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
        <Skeleton className="h-24 w-full" />
      </CardContent>
    </Card>
  );
}

function timeText(value: number | null | undefined, fallback: string): string {
  return value ? formatAbsoluteTime(value) : fallback;
}

/** 最近文件列表：加载 / 失败 / 空 / 正常四态。 */
function RemoteFiles({
  status,
  onRetry,
}: {
  status: {
    isPending: boolean;
    isError: boolean;
    isFetching: boolean;
    error: unknown;
    data?: RemoteBackupStatus;
    refetch: () => void;
  };
  onRetry: () => void;
}) {
  if (status.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (status.isError) {
    return (
      <div className="space-y-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
        <p className="text-xs font-medium text-destructive">
          {t("settings.backup.remote.filesLoadFailed")}
        </p>
        <p className="text-xs text-muted-foreground">
          {remoteErrorText(
            status.error,
            t("settings.backup.remote.filesLoadError"),
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={status.isFetching}
        >
          <RefreshCwIcon
            className={status.isFetching ? "animate-spin" : undefined}
          />
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  const files = selectRemoteBackupFiles(status.data?.files ?? []);
  if (files.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("settings.backup.remote.filesEmpty")}
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {files.map((file) => (
        <li
          key={file.name}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-xs"
        >
          <span className="min-w-0 truncate font-medium" title={file.name}>
            {file.name}
          </span>
          <span className="flex shrink-0 items-center gap-3 tabular-nums text-muted-foreground">
            <span>{formatBytes(file.size, { unlimitedLabel: "—" })}</span>
            <span>
              {file.modified
                ? formatAbsoluteTime(file.modified)
                : t("settings.backup.remote.unknownTime")}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function RemoteBackupForm({ initial }: { initial: Settings }) {
  const updateSettings = useUpdateSettings();
  const testConnection = useTestRemoteBackup();
  const runBackup = useRunRemoteBackup();
  const status = useRemoteBackupStatus();

  const [values, setValues] = useState<RemoteBackupFormValues>(() =>
    remoteBackupFormFromSettings(initial),
  );
  const [savedHasPassword, setSavedHasPassword] = useState(
    initial.backup_webdav_has_password === true,
  );
  const [fieldErrors, setFieldErrors] = useState<RemoteBackupFormErrors>({});
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<RemoteBackupTestResult | null>(
    null,
  );
  const [runResult, setRunResult] = useState<RemoteBackupRunResult | null>(
    null,
  );
  const [runError, setRunError] = useState<string | null>(null);

  const saving = updateSettings.isPending;
  const savedSettings: RemoteBackupSettings = {
    backup_webdav_url: initial.backup_webdav_url,
    backup_webdav_has_password: savedHasPassword,
  };
  const configured = isRemoteBackupConfigured(savedSettings);
  const canOperate = configured && !saving && !dirty;

  const update = <Key extends keyof RemoteBackupFormValues>(
    key: Key,
    value: RemoteBackupFormValues[Key],
  ) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setSaveError(null);
    if (key === "url") {
      setFieldErrors((current) => ({ ...current, url: undefined }));
    }
    if (key === "intervalHours") {
      setFieldErrors((current) => ({ ...current, intervalHours: undefined }));
    }
    if (key === "keep") {
      setFieldErrors((current) => ({ ...current, keep: undefined }));
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaveError(null);

    const errors = validateRemoteBackupForm(values);
    setFieldErrors(errors);
    if (hasRemoteBackupFormErrors(errors)) return;

    if (values.enabled && normalizeWebdavUrl(values.url) === "") {
      setSaveError(t("settings.backup.remote.validation.urlRequired"));
      return;
    }
    if (
      values.enabled &&
      !savedHasPassword &&
      values.password.trim() === ""
    ) {
      setSaveError(t("settings.backup.remote.validation.passwordRequired"));
      return;
    }

    try {
      const items = await updateSettings.mutateAsync(
        buildRemoteBackupPayload(values),
      );
      // PATCH 返回的 items 是权威值：回填表单并清掉脏标记。
      setValues(remoteBackupFormFromSettings(items));
      setSavedHasPassword(items.backup_webdav_has_password === true);
      setDirty(false);
      setFieldErrors({});
      setTestResult(null);
      setRunResult(null);
      setRunError(null);
      toast.success(t("settings.backup.remote.saved"));
      void status.refetch();
    } catch (error) {
      const message = remoteErrorText(
        error,
        t("settings.backup.remote.saveError"),
      );
      setSaveError(message);
      toast.error(message);
    }
  };

  const handleTest = () => {
    setTestResult(null);
    testConnection.mutate(undefined, {
      onSuccess: (result) => {
        const normalized: RemoteBackupTestResult = {
          ok: result.ok === true,
          error: result.error ? redactRemoteError(String(result.error)) : null,
        };
        setTestResult(normalized);
        if (normalized.ok) {
          toast.success(t("settings.backup.remote.testOk"));
        } else {
          toast.error(t("settings.backup.remote.testFailed"));
        }
      },
      onError: (error) => {
        const message = remoteErrorText(
          error,
          t("settings.backup.remote.testFailed"),
        );
        setTestResult({ ok: false, error: message });
        toast.error(message);
      },
    });
  };

  const handleRun = () => {
    setRunResult(null);
    setRunError(null);
    runBackup.mutate(undefined, {
      onSuccess: (result) => {
        setRunResult(result);
        toast.success(
          t("settings.backup.remote.runOk", {
            name: result.file.name,
            size: formatBytes(result.file.size),
          }),
        );
        void status.refetch();
      },
      onError: (error) => {
        const message = remoteErrorText(
          error,
          t("settings.backup.remote.runFailed"),
        );
        setRunError(message);
        toast.error(message);
      },
    });
  };

  const statusData = status.data;
  const tone = statusData
    ? statusData.last_error
      ? "failed"
      : statusData.last_success_at
        ? "ok"
        : "never"
    : "never";

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <SettingsGroup
        icon={CloudUploadIcon}
        title={t("settings.backup.remote.title")}
        description={t("settings.backup.remote.desc")}
      >
        <div
          className={cn(
            SETTINGS_FULL_ROW,
            "flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2",
          )}
        >
          <Label
            htmlFor="settings-backup-remote-enabled"
            className="cursor-pointer text-sm font-medium"
          >
            {t("settings.backup.remote.enabled")}
          </Label>
          <Switch
            id="settings-backup-remote-enabled"
            checked={values.enabled}
            disabled={saving}
            onCheckedChange={(checked) => update("enabled", checked === true)}
          />
        </div>

        <FormField
          label={t("settings.backup.remote.url")}
          htmlFor="settings-backup-remote-url"
          className={SETTINGS_FULL_ROW}
          error={
            fieldErrors.url
              ? t(URL_PROBLEM_KEYS[fieldErrors.url])
              : undefined
          }
        >
          <Input
            id="settings-backup-remote-url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("settings.backup.remote.urlPlaceholder")}
            disabled={saving}
            aria-invalid={Boolean(fieldErrors.url)}
            value={values.url}
            onChange={(event) => update("url", event.target.value)}
          />
        </FormField>

        <FormField
          label={t("settings.backup.remote.username")}
          htmlFor="settings-backup-remote-username"
        >
          <Input
            id="settings-backup-remote-username"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("settings.backup.remote.usernamePlaceholder")}
            disabled={saving}
            value={values.username}
            onChange={(event) => update("username", event.target.value)}
          />
        </FormField>

        <FormField
          label={t("settings.backup.remote.password")}
          htmlFor="settings-backup-remote-password"
        >
          <PasswordInput
            id="settings-backup-remote-password"
            autoComplete="new-password"
            placeholder={
              savedHasPassword
                ? t("settings.backup.remote.passwordSavedPlaceholder")
                : t("settings.backup.remote.passwordPlaceholder")
            }
            disabled={saving}
            value={values.password}
            onChange={(event) => update("password", event.target.value)}
          />
        </FormField>

        <FormField
          label={t("settings.backup.remote.interval")}
          htmlFor="settings-backup-remote-interval"
          required
          error={
            fieldErrors.intervalHours
              ? t("settings.backup.remote.validation.interval")
              : undefined
          }
        >
          <Input
            id="settings-backup-remote-interval"
            inputMode="numeric"
            placeholder="24"
            disabled={saving}
            aria-invalid={Boolean(fieldErrors.intervalHours)}
            value={values.intervalHours}
            onChange={(event) => update("intervalHours", event.target.value)}
          />
        </FormField>

        <FormField
          label={t("settings.backup.remote.keep")}
          htmlFor="settings-backup-remote-keep"
          required
          error={
            fieldErrors.keep
              ? t("settings.backup.remote.validation.keep")
              : undefined
          }
        >
          <Input
            id="settings-backup-remote-keep"
            inputMode="numeric"
            placeholder="7"
            disabled={saving}
            aria-invalid={Boolean(fieldErrors.keep)}
            value={values.keep}
            onChange={(event) => update("keep", event.target.value)}
          />
        </FormField>

        {saveError ? (
          <Alert
            variant="destructive"
            className={cn(
              SETTINGS_FULL_ROW,
              "border-destructive/25 bg-destructive/10",
            )}
          >
            <TriangleAlertIcon />
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        ) : null}

        <div
          className={cn(
            SETTINGS_FULL_ROW,
            "flex flex-wrap items-center justify-end gap-3",
          )}
        >
          <Button type="submit" disabled={saving || !dirty}>
            {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
            {saving
              ? t("settings.backup.remote.saving")
              : t("settings.backup.remote.save")}
          </Button>
        </div>

        {/* 状态与最近文件属于同一张卡：用分隔线把「配置」与「结果」分开。 */}
        <div className={cn(SETTINGS_FULL_ROW, "space-y-4 border-t pt-5")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium">
              {t("settings.backup.remote.statusTitle")}
            </p>
            {/* 测试/立即备份都走已保存的配置：与保存按钮同组，靠右。 */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTest}
                disabled={!canOperate || testConnection.isPending}
              >
                {testConnection.isPending ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <TestTube2Icon />
                )}
                {testConnection.isPending
                  ? t("settings.backup.remote.testing")
                  : t("settings.backup.remote.test")}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleRun}
                disabled={!canOperate || runBackup.isPending}
              >
                {runBackup.isPending ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <UploadCloudIcon />
                )}
                {runBackup.isPending
                  ? t("settings.backup.remote.running")
                  : t("settings.backup.remote.run")}
              </Button>
            </div>
          </div>

          {dirty ? (
            <p className="text-xs text-muted-foreground">
              {t("settings.backup.remote.saveFirstHint")}
            </p>
          ) : null}

          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="flex items-baseline justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2">
              <span className="text-muted-foreground">
                {t("settings.backup.remote.lastSuccess")}
              </span>
              <span className="truncate font-medium tabular-nums">
                {timeText(
                  statusData?.last_success_at,
                  t("settings.backup.remote.never"),
                )}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2">
              <span className="text-muted-foreground">
                {t("settings.backup.remote.lastFailure")}
              </span>
              <span
                className={cn(
                  "truncate font-medium tabular-nums",
                  tone === "failed" && "text-destructive",
                )}
              >
                {timeText(
                  statusData?.last_failure_at,
                  t("settings.backup.remote.unknownTime"),
                )}
              </span>
            </div>
          </div>

          {statusData?.last_error ? (
            <Alert
              variant="destructive"
              className="border-destructive/25 bg-destructive/10"
            >
              <TriangleAlertIcon />
              <AlertTitle>{t("settings.backup.remote.errorTitle")}</AlertTitle>
              <AlertDescription className="break-words">
                {redactRemoteError(statusData.last_error)}
              </AlertDescription>
            </Alert>
          ) : null}

          {testResult ? (
            <Alert
              className={
                testResult.ok
                  ? "border-primary/25 bg-primary/10 text-primary"
                  : "border-destructive/25 bg-destructive/10 text-destructive"
              }
            >
              {testResult.ok ? (
                <CheckCircle2Icon />
              ) : (
                <TriangleAlertIcon />
              )}
              <AlertDescription
                className={cn(
                  "break-words",
                  testResult.ok ? "text-primary" : "text-destructive",
                )}
              >
                {testResult.ok
                  ? t("settings.backup.remote.testOk")
                  : testResult.error ||
                    t("settings.backup.remote.testFailed")}
              </AlertDescription>
            </Alert>
          ) : null}

          {runResult ? (
            <Alert className="border-primary/25 bg-primary/10 text-primary">
              <CheckCircle2Icon />
              <AlertDescription className="break-words text-primary">
                {t("settings.backup.remote.runOk", {
                  name: runResult.file.name,
                  size: formatBytes(runResult.file.size),
                })}
                {runResult.deleted && runResult.deleted.length > 0
                  ? t("settings.backup.remote.runDeleted", {
                      n: runResult.deleted.length,
                    })
                  : ""}
              </AlertDescription>
            </Alert>
          ) : null}

          {runError ? (
            <Alert
              variant="destructive"
              className="border-destructive/25 bg-destructive/10"
            >
              <TriangleAlertIcon />
              <AlertDescription className="break-words">
                {runError}
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <FileArchiveIcon className="size-3.5 text-muted-foreground" />
              <p className="text-xs font-medium">
                {t("settings.backup.remote.filesTitle")}
              </p>
            </div>
            <RemoteFiles
              status={status}
              onRetry={() => void status.refetch()}
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.backup.remote.filesHint")}
            </p>
          </div>
        </div>
      </SettingsGroup>
    </form>
  );
}

/** 设置页「备份与恢复」tab 的异地备份卡；自己处理设置接口的加载/错误态。 */
export function RemoteBackupCard() {
  useI18n();
  const settings = useSettings();

  if (settings.isPending) return <RemoteBackupSkeleton />;

  if (settings.isError) {
    return (
      <Card>
        <CardContent>
          <ListError
            title={t("settings.backup.loadFailed")}
            message={remoteErrorText(settings.error, t("settings.backup.loadError"))}
            retrying={settings.isFetching}
            onRetry={() => void settings.refetch()}
          />
        </CardContent>
      </Card>
    );
  }

  if (!settings.data) return null;
  return <RemoteBackupForm initial={settings.data} />;
}
