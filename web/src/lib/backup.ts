/**
 * P7：备份与恢复的前端预检，见 docs/PLAN.md「P7：备份与恢复」。
 *
 * 后端会再校验文件头、必要表与迁移版本；这里只挡掉明显不合法的输入，
 * 避免把 0 字节、错误扩展名或超过 512 MB 的文件发出去。
 */
import { ApiError } from "./apiError.ts";

/** 与后端一致的 512 MB 上限。 */
export const BACKUP_MAX_BYTES = 512 * 1024 * 1024;

/** 恢复上传接口；`force` 只能放在查询串（请求体是原始文件字节）。 */
const RESTORE_PATH = "/api/v1/backup/restore";

/** 恢复上传地址：只有管理员确认丢弃旧秘密时才带 `force=true`。 */
export function restorePath(force = false): string {
  return force ? `${RESTORE_PATH}?force=true` : RESTORE_PATH;
}

/**
 * 只有 `backup.key_mismatch` 才提供强制恢复入口：普通恢复失败仍然只报错，
 * 不给用户绕过校验的机会。
 */
export function needsForceRestore(error: unknown): boolean {
  return error instanceof ApiError && error.code === "backup.key_mismatch";
}

/** `<input type="file" accept>` 的取值；`.db.gz` 以 `.gz` 结尾，`.enc` 单独列出。 */
export const BACKUP_ACCEPT = ".db,.gz,.enc";

export type BackupFileProblem = "unsupported" | "empty" | "tooLarge";

/**
 * 只按扩展名放行：`.db`、gzip 压缩后的 `.gz`（含 `.db.gz`）以及加密备份
 * `.db.gz.enc`。真正的格式由后端按内容判断。
 */
export function isBackupFileName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return (
    lower.endsWith(".db") || lower.endsWith(".gz") || lower.endsWith(".enc")
  );
}

/**
 * 上传前检查，返回第一个问题；合法时返回 `null`。
 * 先看扩展名，再挡空文件，最后才是体积上限。
 */
export function validateBackupFile(file: {
  name: string;
  size: number;
}): BackupFileProblem | null {
  if (!isBackupFileName(file.name)) return "unsupported";
  if (file.size <= 0) return "empty";
  if (file.size > BACKUP_MAX_BYTES) return "tooLarge";
  return null;
}
