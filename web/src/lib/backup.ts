/**
 * P7：备份与恢复的前端预检，见 docs/PLAN.md「P7：备份与恢复」。
 *
 * 后端会再校验文件头、必要表与迁移版本；这里只挡掉明显不合法的输入，
 * 避免把 0 字节、错误扩展名或超过 512 MB 的文件发出去。
 */

/** 与后端一致的 512 MB 上限。 */
export const BACKUP_MAX_BYTES = 512 * 1024 * 1024;

/** `<input type="file" accept>` 的取值；`.db.gz` 以 `.gz` 结尾，已被覆盖。 */
export const BACKUP_ACCEPT = ".db,.gz";

export type BackupFileProblem = "unsupported" | "empty" | "tooLarge";

/** 只按扩展名放行：`.db` 或 gzip 压缩后的 `.gz`（含 `.db.gz`）。 */
export function isBackupFileName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower.endsWith(".db") || lower.endsWith(".gz");
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
