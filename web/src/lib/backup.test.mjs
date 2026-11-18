import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./apiError.ts";
import {
  BACKUP_MAX_BYTES,
  isBackupFileName,
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
