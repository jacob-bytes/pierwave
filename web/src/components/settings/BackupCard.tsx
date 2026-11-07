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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, type BackupPending } from "@/lib/api";
import {
  BACKUP_ACCEPT,
  BACKUP_MAX_BYTES,
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

function PendingNotice({ pending }: { pending: BackupPending }) {
  return (
    <Alert className="border-warning/25 bg-warning/10 text-warning">
      <TriangleAlertIcon />
      <AlertTitle>{t("settings.backup.pendingTitle")}</AlertTitle>
      <AlertDescription className="text-warning/90">
        <span title={formatRelativeTime(pending.uploaded_at)}>
          {t("settings.backup.pendingDesc", {
            time: formatAbsoluteTime(pending.uploaded_at),
            size: formatBytes(pending.bytes, { unlimitedLabel: "—" }),
          })}
        </span>
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
function RestoreForm() {
  const restoreBackup = useRestoreBackup();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const resetSelection = () => {
    setFile(null);
    setConfirmed(false);
    setFileError(null);
    setUploadError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.files?.[0] ?? null;
    setUploadError(null);
    setFileError(null);
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

  const handleUpload = () => {
    if (!file || !confirmed || restoreBackup.isPending) return;

    // 第二步预检：选文件后文件可能被替换，提交前再挡一次 512 MB。
    const problem = validateBackupFile(file);
    if (problem) {
      setFileError(fileProblemText(problem));
      return;
    }

    setFileError(null);
    setUploadError(null);
    restoreBackup.mutate(file, {
      onSuccess: () => {
        resetSelection();
        toast.success(t("settings.backup.uploadedToast"));
      },
      onError: (error) => {
        setUploadError(
          backupErrorText(error, t("settings.backup.uploadError")),
        );
      },
    });
  };

  const uploadDisabled = !file || !confirmed || restoreBackup.isPending;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium">
          {t("settings.backup.restoreTitle")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.backup.restoreDesc")}
        </p>
      </div>

      <div className="space-y-2">
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
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2">
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
        <p className="text-xs text-destructive" role="alert">
          {fileError}
        </p>
      ) : null}

      <div className="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
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
          className="border-destructive/25 bg-destructive/10"
        >
          <TriangleAlertIcon />
          <AlertDescription>{uploadError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
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
    </div>
  );
}

/**
 * P7：备份与恢复卡片，见 docs/PLAN.md「P7：备份与恢复」。
 *
 * 下载走同源直链，浏览器自己带 Cookie；恢复必须把文件作为原始字节 POST，
 * 不能套 FormData。上传前在本地挡掉错误扩展名、空文件与 >512 MB。
 */
export function BackupCard() {
  useI18n();
  const info = useBackupInfo();
  const cancelRestore = useCancelRestore();

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const pending = info.data?.pending ?? null;

  const handleCancelRestore = () => {
    setCancelError(null);
    cancelRestore.mutate(undefined, {
      onSuccess: () => {
        setCancelOpen(false);
        toast.success(t("settings.backup.cancelRestoreSuccess"));
      },
      onError: (error) => {
        setCancelError(
          backupErrorText(error, t("settings.backup.cancelRestoreError")),
        );
      },
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <DatabaseBackupIcon className="size-4 text-muted-foreground" />
          {t("settings.backup.title")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("settings.backup.desc")}
        </CardDescription>
      </CardHeader>
      <CardContent className="max-w-2xl space-y-5">
        {info.isPending ? (
          <BackupSkeleton />
        ) : info.isError ? (
          <div className="space-y-3">
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
          </div>
        ) : (
          <>
            {pending ? <PendingNotice pending={pending} /> : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs text-muted-foreground">
                  {t("settings.backup.sizeLabel")}
                </p>
                <p className="mt-0.5 text-sm font-medium">
                  {formatBytes(info.data.db_bytes, { unlimitedLabel: "—" })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settings.backup.sizeHint")}
                </p>
              </div>
              <div className="text-right">
                <Button variant="outline" size="sm" asChild>
                  <a href={api.backup.downloadUrl} download>
                    <DownloadIcon />
                    {t("settings.backup.download")}
                  </a>
                </Button>
                <p className="mt-1 max-w-60 text-xs text-muted-foreground">
                  {t("settings.backup.downloadHint")}
                </p>
              </div>
            </div>

            <Separator />

            {pending ? (
              <div className="space-y-3 rounded-lg border border-primary/25 bg-primary/10 p-3">
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
                        size: formatBytes(pending.bytes, { unlimitedLabel: "—" }),
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
            ) : (
              <RestoreForm />
            )}
          </>
        )}
      </CardContent>

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
    </Card>
  );
}
