import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  CheckCircle2Icon,
  DatabaseBackupIcon,
  DownloadIcon,
  Loader2Icon,
  RefreshCwIcon,
  TriangleAlertIcon,
  Undo2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  SettingsGroup,
  SETTINGS_FULL_ROW,
} from "@/components/settings/SettingsGroup";
import { api, ApiError, type BackupPending } from "@/lib/api";
import {
  BACKUP_ACCEPT,
  BACKUP_MAX_BYTES,
  needsForceRestore,
  validateBackupFile,
  type BackupFileProblem,
} from "@/lib/backup";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import {
  useBackupInfo,
  useCancelRestore,
  useRestoreBackup,
} from "@/lib/queries";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/time";
import { pickBilingual } from "@/lib/updates";
import { cn } from "@/lib/utils";
import { t, useI18n } from "@/i18n";

/** 备份接口与后端并行开发：404/403/413 给中文说明，不写 mock 数据。 */
function backupErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return t("settings.backup.notReady404");
    }
    if (error.status === 403) {
      return t("settings.backup.forbidden");
    }
    if (error.status === 413) {
      return t("settings.backup.tooLarge", {
        size: formatBytes(BACKUP_MAX_BYTES),
      });
    }
  }
  return errorText(error, fallback);
}

function fileProblemText(problem: BackupFileProblem): string {
  if (problem === "tooLarge") {
    return t("settings.backup.tooLarge", {
      size: formatBytes(BACKUP_MAX_BYTES),
    });
  }
  if (problem === "empty") return t("settings.backup.emptyFile");
  return t("settings.backup.unsupportedFile");
}

function BackupSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-20" />
        </div>
        <Skeleton className="h-7 w-28" />
      </div>
      <Skeleton className="h-px w-full" />
      <div className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-3 w-64" />
        <Skeleton className="h-8 w-full max-w-md" />
      </div>
    </div>
  );
}

function PendingNotice({
  pending,
  warning,
}: {
  pending: BackupPending;
  /** force=true 时后端返回的双语提醒；null 表示正常恢复。 */
  warning: string | null;
}) {
  const { locale } = useI18n();

  return (
    <Alert className="border-warning/25 bg-warning/10 text-warning">
      <TriangleAlertIcon />
      <AlertTitle>{t("settings.backup.pendingTitle")}</AlertTitle>
      <AlertDescription className="text-warning/90">
        <span
          className="block"
          title={formatRelativeTime(pending.uploaded_at)}
        >
          {t("settings.backup.pendingDesc", {
            time: formatAbsoluteTime(pending.uploaded_at),
            size: formatBytes(pending.bytes, { unlimitedLabel: "—" }),
          })}
        </span>
        {warning ? (
          <span className="mt-1 block border-t border-warning/20 pt-1 text-xs">
            <span className="font-medium">
              {t("settings.backup.forceWarningLabel")}
            </span>{" "}
            {pickBilingual(warning, locale)}
          </span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * 上传区只在没有待恢复文件时挂载。
 *
 * 这样上传成功、或别的管理员安排了恢复后，选择/勾选状态随组件卸载一起丢弃，
 * 不需要用 effect 在 pending 出现时手动清空。
 */
function RestoreForm({
  onWarning,
}: {
  /** 把 force 恢复的 warning 交给父组件，常驻显示在待恢复提示里。 */
  onWarning: (warning: string | null) => void;
}) {
  const restoreBackup = useRestoreBackup();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // 只有 key_mismatch 才会打开；正常情况下这条路径完全不存在。
  const [forceOpen, setForceOpen] = useState(false);
  const [forceConfirmed, setForceConfirmed] = useState(false);
  const [forceError, setForceError] = useState<string | null>(null);

  const resetSelection = () => {
    setFile(null);
    setConfirmed(false);
    setFileError(null);
    setUploadError(null);
    setForceOpen(false);
    setForceConfirmed(false);
    setForceError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] ?? null;
    setUploadError(null);
    setFileError(null);
    setForceOpen(false);
    setForceConfirmed(false);
    setForceError(null);
    setConfirmed(false);

    if (!next) {
      setFile(null);
      return;
    }

    const problem = validateBackupFile(next);
    if (problem) {
      setFile(null);
      setFileError(fileProblemText(problem));
      // 允许用户修好后重新选同一个文件：清空 input 的值。
      event.target.value = "";
      return;
    }

    setFile(next);
  };

  const submitRestore = (force: boolean) => {
    if (!file || restoreBackup.isPending) return;

    // 第二步预检：选文件后文件可能被替换，提交前再挡一次 512 MB。
    const problem = validateBackupFile(file);
    if (problem) {
      setFileError(fileProblemText(problem));
      return;
    }

    setFileError(null);
    setUploadError(null);
    setForceError(null);
    restoreBackup.mutate(
      { file, force },
      {
        onSuccess: (result) => {
          resetSelection();
          onWarning(result.warning ?? null);
          toast.success(t("settings.backup.uploadedToast"));
        },
        onError: (error) => {
          // key_mismatch 不直接报错：先让管理员看清 force 的破坏性后果。
          if (needsForceRestore(error)) {
            setForceOpen(true);
            setForceConfirmed(false);
            setForceError(null);
            return;
          }
          const message = backupErrorText(
            error,
            force
              ? t("settings.backup.forceError")
              : t("settings.backup.uploadError"),
          );
          if (force) {
            setForceError(message);
          } else {
            setUploadError(message);
          }
        },
      },
    );
  };

  const handleUpload = () => {
    if (!file || !confirmed || restoreBackup.isPending) return;
    submitRestore(false);
  };

  const handleForceRestore = () => {
    if (!file || !forceConfirmed || restoreBackup.isPending) return;
    submitRestore(true);
  };

  const uploadDisabled = !file || !confirmed || restoreBackup.isPending;

  return (
    <>
      {/* 文件选择是整行：文件名可能很长，半列会截断到看不清选的是哪个文件。 */}
      <div className={cn(SETTINGS_FULL_ROW, "space-y-2")}>
        <Label htmlFor="settings-backup-file">
          {t("settings.backup.chooseFile")}
        </Label>
        <Input
          id="settings-backup-file"
          ref={inputRef}
          type="file"
          accept={BACKUP_ACCEPT}
          disabled={restoreBackup.isPending}
          aria-invalid={Boolean(fileError)}
          aria-describedby="settings-backup-file-hint"
          className="max-w-md cursor-pointer file:mr-2 file:rounded-md file:bg-muted file:px-2 file:py-1 file:text-xs"
          onChange={handleFileChange}
        />
        <p
          id="settings-backup-file-hint"
          className="text-xs text-muted-foreground"
        >
          {t("settings.backup.chooseHint", {
            size: formatBytes(BACKUP_MAX_BYTES),
          })}
        </p>
      </div>

      {file ? (
        <div
          className={cn(
            SETTINGS_FULL_ROW,
            "flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2",
          )}
        >
          <p className="min-w-0 truncate text-xs font-medium">
            {t("settings.backup.selectedFile", {
              name: file.name,
              size: formatBytes(file.size),
            })}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={resetSelection}
            disabled={restoreBackup.isPending}
          >
            <XIcon />
            {t("settings.backup.clearFile")}
          </Button>
        </div>
      ) : null}

      {fileError ? (
        <p
          className={cn(SETTINGS_FULL_ROW, "text-xs text-destructive")}
          role="alert"
        >
          {fileError}
        </p>
      ) : null}

      <div
        className={cn(
          SETTINGS_FULL_ROW,
          "flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3",
        )}
      >
        <Checkbox
          id="settings-backup-confirm"
          className="mt-0.5"
          checked={confirmed}
          disabled={restoreBackup.isPending}
          onCheckedChange={(checked) => setConfirmed(checked === true)}
        />
        <div className="space-y-1">
          <Label
            htmlFor="settings-backup-confirm"
            className="block cursor-pointer text-xs leading-relaxed font-normal text-destructive"
          >
            {t("settings.backup.confirmLabel")}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("settings.backup.confirmHint")}
          </p>
        </div>
      </div>

      {uploadError ? (
        <Alert
          variant="destructive"
          className={cn(
            SETTINGS_FULL_ROW,
            "border-destructive/25 bg-destructive/10",
          )}
        >
          <TriangleAlertIcon />
          <AlertDescription>{uploadError}</AlertDescription>
        </Alert>
      ) : null}

      {/* 上传是破坏性操作：自己一行、靠左；下载在另一张卡里，不与它并排。 */}
      <div className={cn(SETTINGS_FULL_ROW, "flex flex-wrap items-center gap-3")}>
        <Button
          type="button"
          variant="destructive"
          onClick={handleUpload}
          disabled={uploadDisabled}
        >
          {restoreBackup.isPending ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <UploadIcon />
          )}
          {restoreBackup.isPending
            ? t("settings.backup.uploading")
            : t("settings.backup.upload")}
        </Button>
      </div>

      {/*
       * 只有后端返回 backup.key_mismatch 才打开。
       * force 会删除备份中解不开的秘密并让旧订阅链接失效，必须逐条写清后果。
       */}
      <AlertDialog
        open={forceOpen}
        onOpenChange={(next) => {
          if (!next && restoreBackup.isPending) return;
          if (!next) {
            setForceOpen(false);
            setForceConfirmed(false);
            setForceError(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <TriangleAlertIcon className="size-5" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t("settings.backup.forceTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.backup.forceDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <ul className="space-y-1.5 text-sm text-muted-foreground">
            <li className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>{t("settings.backup.forceSecretConsequence")}</span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>{t("settings.backup.forceHmacConsequence")}</span>
            </li>
            <li className="flex gap-2 font-medium text-destructive">
              <span aria-hidden="true">•</span>
              <span>{t("settings.backup.forceLinksConsequence")}</span>
            </li>
          </ul>

          {forceError ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>{t("settings.backup.forceError")}</AlertTitle>
              <AlertDescription>{forceError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
            <Checkbox
              id="settings-backup-force-confirm"
              className="mt-0.5"
              checked={forceConfirmed}
              disabled={restoreBackup.isPending}
              onCheckedChange={(checked) =>
                setForceConfirmed(checked === true)
              }
            />
            <Label
              htmlFor="settings-backup-force-confirm"
              className="block cursor-pointer text-xs leading-relaxed font-normal text-destructive"
            >
              {t("settings.backup.forceConfirmLabel")}
            </Label>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoreBackup.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={!forceConfirmed || restoreBackup.isPending}
              onClick={(event) => {
                event.preventDefault();
                handleForceRestore();
              }}
            >
              {restoreBackup.isPending ? (
                <Loader2Icon className="animate-spin" />
              ) : null}
              {restoreBackup.isPending
                ? t("settings.backup.forceActionPending")
                : t("settings.backup.forceAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * P7：备份与恢复，见 docs/PLAN.md「P7：备份与恢复」。
 *
 * 下载走同源直链，浏览器自己带 Cookie；恢复必须把文件作为原始字节 POST，
 * 不能套 FormData。上传前在本地挡掉错误扩展名、空文件与 >512 MB。
 *
 * 与其它 tab 同一套结构：每个分组一张独立卡片（数据库大小与下载 / 恢复数据），
 * 破坏性按钮不与下载并排。
 */
export function BackupCard() {
  useI18n();
  const info = useBackupInfo();
  const cancelRestore = useCancelRestore();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  // force 恢复返回的 warning：只属于当前待恢复文件，取消或重新上传后清空。
  const [forceWarning, setForceWarning] = useState<string | null>(null);

  const pending = info.data?.pending ?? null;

  const handleCancelRestore = () => {
    setCancelError(null);
    cancelRestore.mutate(undefined, {
      onSuccess: () => {
        setCancelOpen(false);
        setForceWarning(null);
        toast.success(t("settings.backup.cancelRestoreSuccess"));
      },
      onError: (error) => {
        setCancelError(
          backupErrorText(error, t("settings.backup.cancelRestoreError")),
        );
      },
    });
  };

  if (info.isPending) {
    return (
      <Card>
        <CardContent>
          <BackupSkeleton />
        </CardContent>
      </Card>
    );
  }

  if (info.isError) {
    return (
      <Card>
        <CardContent className="space-y-3">
          <Alert
            variant="destructive"
            className="border-destructive/25 bg-destructive/10"
          >
            <TriangleAlertIcon />
            <AlertTitle>{t("settings.backup.loadFailed")}</AlertTitle>
            <AlertDescription>
              {backupErrorText(info.error, t("settings.backup.loadError"))}
            </AlertDescription>
          </Alert>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void info.refetch()}
            disabled={info.isFetching}
          >
            <RefreshCwIcon
              className={info.isFetching ? "animate-spin" : undefined}
            />
            {t("common.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* 当前库大小与下载并排：同一张卡的两栏。 */}
      <SettingsGroup
        icon={DatabaseBackupIcon}
        title={t("settings.backup.sizeLabel")}
        description={t("settings.backup.sizeHint")}
      >
        <div className="space-y-1">
          <p className="text-sm font-medium tabular-nums">
            {formatBytes(info.data.db_bytes, { unlimitedLabel: "—" })}
          </p>
        </div>

        <div className="space-y-2">
          <Button variant="outline" size="sm" asChild>
            <a href={api.backup.downloadUrl} download>
              <DownloadIcon />
              {t("settings.backup.download")}
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">
            {t("settings.backup.downloadHint")}
          </p>
        </div>
      </SettingsGroup>

      <SettingsGroup
        icon={UploadIcon}
        title={t("settings.backup.restoreTitle")}
        description={t("settings.backup.restoreDesc")}
      >
        {pending ? (
          <>
            <div className={SETTINGS_FULL_ROW}>
              <PendingNotice pending={pending} warning={forceWarning} />
            </div>
            <div
              className={cn(
                SETTINGS_FULL_ROW,
                "space-y-3 rounded-lg border border-primary/25 bg-primary/10 p-3",
              )}
            >
              <div className="flex items-start gap-2">
                <CheckCircle2Icon className="mt-0.5 size-4 text-primary" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-primary">
                    {t("settings.backup.uploadSuccessTitle")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("settings.backup.uploadSuccessDesc")}
                  </p>
                  <p
                    className="mt-1 text-xs text-muted-foreground"
                    title={formatRelativeTime(pending.uploaded_at)}
                  >
                    {t("settings.backup.pendingDesc", {
                      time: formatAbsoluteTime(pending.uploaded_at),
                      size: formatBytes(pending.bytes, {
                        unlimitedLabel: "—",
                      }),
                    })}
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCancelError(null);
                    setCancelOpen(true);
                  }}
                >
                  <Undo2Icon />
                  {t("settings.backup.cancelRestore")}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <RestoreForm onWarning={setForceWarning} />
        )}
      </SettingsGroup>

      <AlertDialog
        open={cancelOpen}
        onOpenChange={(next) => {
          if (!next && cancelRestore.isPending) return;
          if (!next) setCancelError(null);
          setCancelOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive">
              <TriangleAlertIcon className="size-5" />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t("settings.backup.cancelRestoreTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.backup.cancelRestoreDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {cancelError ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>
                {t("settings.backup.cancelRestoreError")}
              </AlertTitle>
              <AlertDescription>{cancelError}</AlertDescription>
            </Alert>
          ) : null}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelRestore.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={cancelRestore.isPending}
              onClick={(event) => {
                event.preventDefault();
                handleCancelRestore();
              }}
            >
              {cancelRestore.isPending ? (
                <Loader2Icon className="animate-spin" />
              ) : null}
              {t("settings.backup.cancelRestoreAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
