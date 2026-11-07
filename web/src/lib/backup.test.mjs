import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKUP_MAX_BYTES,
  isBackupFileName,
  validateBackupFile,
} from "./backup.ts";

test("isBackupFileName accepts .db and gzip variants", () => {
  assert.equal(isBackupFileName("pierwave.db"), true);
  assert.equal(isBackupFileName("pierwave.DB"), true);
  assert.equal(isBackupFileName("pierwave-backup-20260101-120000.db.gz"), true);
  assert.equal(isBackupFileName("pierwave-backup-20260101-120000.gz"), true);
  assert.equal(isBackupFileName("  pierwave.db  "), true);
});

test("isBackupFileName rejects anything else", () => {
  assert.equal(isBackupFileName("pierwave.sqlite"), false);
  assert.equal(isBackupFileName("pierwave.db.bak"), false);
  assert.equal(isBackupFileName("pierwave.gz.tmp"), false);
  assert.equal(isBackupFileName("pierwave"), false);
  assert.equal(isBackupFileName(""), false);
});

test("validateBackupFile accepts a normal .db/.gz file", () => {
  assert.equal(validateBackupFile({ name: "pierwave.db", size: 1 }), null);
  assert.equal(
    validateBackupFile({ name: "pierwave.db.gz", size: BACKUP_MAX_BYTES }),
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
