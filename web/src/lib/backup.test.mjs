import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./apiError.ts";
import {
  BACKUP_EXPORT_TOO_LARGE,
  BACKUP_MAX_BYTES,
  backupExportLimitBytes,
  exportTooLargeLimitBytes,
  isBackupExportBlocked,
  isBackupFileName,
  isExportTooLarge,
  needsForceRestore,
  restorePath,
  validateBackupFile,
} from "./backup.ts";

test("isBackupFileName accepts .db and gzip variants", () => {
  assert.equal(isBackupFileName("pierwave.db"), true);
  assert.equal(isBackupFileName("pierwave.DB"), true);
  assert.equal(isBackupFileName("pierwave-backup-20260101-120000.db.gz"), true);
  assert.equal(
    isBackupFileName("pierwave-backup-20260101-120000.db.gz.enc"),
    true,
    "加密备份必须能选择",
  );
  assert.equal(isBackupFileName("pierwave-backup-20260101-120000.gz"), true);
  assert.equal(isBackupFileName("  pierwave.db  "), true);
});

test("isBackupFileName rejects anything else", () => {
  assert.equal(isBackupFileName("pierwave.sqlite"), false);
  assert.equal(isBackupFileName("pierwave.db.bak"), false);
  assert.equal(isBackupFileName("pierwave.gz.tmp"), false);
  assert.equal(isBackupFileName("pierwave.enc.bak"), false);
  assert.equal(isBackupFileName("pierwave"), false);
  assert.equal(isBackupFileName(""), false);
});

test("validateBackupFile accepts a normal .db/.gz file", () => {
  assert.equal(validateBackupFile({ name: "pierwave.db", size: 1 }), null);
  assert.equal(
    validateBackupFile({ name: "pierwave.db.gz", size: BACKUP_MAX_BYTES }),
    null,
  );
  assert.equal(
    validateBackupFile({ name: "pierwave.db.gz.enc", size: 1024 }),
    null,
  );
});

test("validateBackupFile rejects unsupported names, empty files and >512MB", () => {
  assert.equal(
    validateBackupFile({ name: "pierwave.txt", size: 1024 }),
    "unsupported",
  );
  assert.equal(validateBackupFile({ name: "pierwave.db", size: 0 }), "empty");
  assert.equal(
    validateBackupFile({ name: "pierwave.db", size: BACKUP_MAX_BYTES + 1 }),
    "tooLarge",
  );
  assert.equal(
    validateBackupFile({ name: "pierwave.db", size: -1 }),
    "empty",
  );
});

test("restorePath only sends force=true after explicit confirmation", () => {
  assert.equal(restorePath(), "/api/v1/backup/restore");
  assert.equal(restorePath(false), "/api/v1/backup/restore");
  assert.equal(
    restorePath(true),
    "/api/v1/backup/restore?force=true",
    "force 只能放在查询串，和原始文件 body 分开",
  );
});

test("needsForceRestore only opens the force dialog for backup.key_mismatch", () => {
  assert.equal(
    needsForceRestore(
      new ApiError("备份来自另一把主密钥", 400, "backup.key_mismatch", {
        keys: ["webhook_url"],
      }),
    ),
    true,
  );
  // 其它恢复失败不能给用户绕过校验的入口。
  assert.equal(
    needsForceRestore(
      new ApiError("备份文件校验失败", 400, "backup.restore_invalid"),
    ),
    false,
  );
  assert.equal(
    needsForceRestore(
      new ApiError("备份解密失败", 400, "backup.restore_decrypt_failed"),
    ),
    false,
  );
  assert.equal(needsForceRestore(new ApiError("服务器内部错误", 500)), false);
  assert.equal(needsForceRestore(new Error("network down")), false);
});

// ---------------------------------------------------------------------------
// B14：导出/异地备份超限
// ---------------------------------------------------------------------------

test("too_large from /backup/info disables export and immediate upload", () => {
  assert.equal(isBackupExportBlocked({ too_large: true }), true);
  assert.equal(isBackupExportBlocked({ too_large: false }), false);
  assert.equal(isBackupExportBlocked({}), false);
  assert.equal(isBackupExportBlocked(null), false);
  assert.equal(isBackupExportBlocked(undefined), false);
});

test("the export limit uses max_bytes and falls back to 512 MB", () => {
  assert.equal(backupExportLimitBytes({ max_bytes: 64 * 1024 * 1024 }), 64 * 1024 * 1024);
  assert.equal(backupExportLimitBytes({ max_bytes: 1 }), 1);
  for (const info of [
    {},
    { max_bytes: 0 },
    { max_bytes: -1 },
    { max_bytes: Number.NaN },
    { max_bytes: "1024" },
    null,
    undefined,
  ]) {
    assert.equal(backupExportLimitBytes(info), BACKUP_MAX_BYTES);
  }
});

test("backup.export_too_large is recognized by its stable code only", () => {
  const tooLarge = new ApiError(
    "当前数据库超过导出上限",
    400,
    BACKUP_EXPORT_TOO_LARGE,
    { db_bytes: 2_000, max_bytes: 1_024, max_mb: 0 },
  );
  assert.equal(isExportTooLarge(tooLarge), true);
  assert.equal(exportTooLargeLimitBytes(tooLarge), 1_024);
  // 参数缺失/非法时由调用方回落到 info 或 512 MB。
  assert.equal(
    exportTooLargeLimitBytes(
      new ApiError("超限", 400, BACKUP_EXPORT_TOO_LARGE),
    ),
    null,
  );
  assert.equal(
    exportTooLargeLimitBytes(
      new ApiError("超限", 400, BACKUP_EXPORT_TOO_LARGE, { max_bytes: 0 }),
    ),
    null,
  );

  assert.equal(
    isExportTooLarge(
      new ApiError("文件过大", 400, "backup.restore_too_large"),
    ),
    false,
    "恢复文件超限是另一个错误码",
  );
  assert.equal(
    isExportTooLarge(new ApiError("服务器内部错误", 500)),
    false,
  );
  assert.equal(isExportTooLarge(new Error("network down")), false);
  assert.equal(exportTooLargeLimitBytes(new Error("network down")), null);
});
