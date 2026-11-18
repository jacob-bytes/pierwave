import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_REMOTE_BACKUP_FORM,
  REMOTE_BACKUP_INTERVAL_MAX,
  REMOTE_BACKUP_INTERVAL_MIN,
  REMOTE_BACKUP_KEEP_MAX,
  REMOTE_BACKUP_KEEP_MIN,
  REMOTE_BACKUP_MAX_FILES,
  buildRemoteBackupPayload,
  hasRemoteBackupFormErrors,
  isManagedRemoteBackupName,
  isRemoteBackupConfigured,
  normalizeWebdavUrl,
  parseIntegerInRange,
  redactRemoteError,
  remoteBackupFormFromSettings,
  remoteBackupTone,
  selectRemoteBackupFiles,
  validateRemoteBackupForm,
  validateWebdavUrl,
} from "./remoteBackup.ts";

test("webdav URL accepts http(s) and rejects embedded credentials", () => {
  assert.equal(validateWebdavUrl(""), null, "空串 = 未配置，允许保存");
  assert.equal(
    validateWebdavUrl("https://dav.example.com/remote.php/dav/files/user/pierwave"),
    null,
  );
  assert.equal(
    validateWebdavUrl("http://10.0.0.5:8080/dav"),
    null,
    "内网允许 http",
  );
  assert.equal(validateWebdavUrl("ftp://dav.example.com/dav"), "scheme");
  assert.equal(validateWebdavUrl("dav.example.com/dav"), "scheme");
  assert.equal(
    validateWebdavUrl("https://user:pass@dav.example.com/dav"),
    "credentials",
    "地址里不能带用户名密码",
  );
  assert.equal(validateWebdavUrl("https://dav.example.com/dav?x=1"), "query");
  assert.equal(validateWebdavUrl("https://dav.example.com/dav#top"), "query");
  assert.equal(validateWebdavUrl("https://dav example.com/dav"), "whitespace");
  assert.equal(validateWebdavUrl("https://"), "host");
});

test("normalizeWebdavUrl trims whitespace and trailing slashes", () => {
  assert.equal(
    normalizeWebdavUrl("  https://dav.example.com/dav//  "),
    "https://dav.example.com/dav",
  );
  assert.equal(normalizeWebdavUrl(""), "");
});

test("interval accepts 1-168 and keep accepts 1-30", () => {
  assert.equal(parseIntegerInRange("1", 1, 168), 1);
  assert.equal(parseIntegerInRange("168", 1, 168), 168);
  for (const bad of ["0", "169", "-1", "1.5", "", "  ", "x", "24h"]) {
    assert.equal(
      parseIntegerInRange(bad, REMOTE_BACKUP_INTERVAL_MIN, REMOTE_BACKUP_INTERVAL_MAX),
      null,
      `间隔应拒绝 ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(parseIntegerInRange("1", 1, 30), 1);
  assert.equal(parseIntegerInRange("30", 1, 30), 30);
  for (const bad of ["0", "31", "7.5", "seven"]) {
    assert.equal(
      parseIntegerInRange(bad, REMOTE_BACKUP_KEEP_MIN, REMOTE_BACKUP_KEEP_MAX),
      null,
      `保留份数应拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

test("form validation reports the first problem of each field", () => {
  assert.deepEqual(validateRemoteBackupForm(EMPTY_REMOTE_BACKUP_FORM), {});
  assert.equal(
    hasRemoteBackupFormErrors(validateRemoteBackupForm(EMPTY_REMOTE_BACKUP_FORM)),
    false,
  );

  const errors = validateRemoteBackupForm({
    ...EMPTY_REMOTE_BACKUP_FORM,
    url: "ftp://dav.example.com/dav",
    intervalHours: "0",
    keep: "31",
  });
  assert.equal(errors.url, "scheme");
  assert.equal(errors.intervalHours, true);
  assert.equal(errors.keep, true);
  assert.equal(hasRemoteBackupFormErrors(errors), true);
});

test("payload omits the password when the field is left empty", () => {
  const base = {
    ...EMPTY_REMOTE_BACKUP_FORM,
    enabled: true,
    url: " https://dav.example.com/dav/ ",
    username: " pierwave ",
    intervalHours: "12",
    keep: "3",
  };

  const unchanged = buildRemoteBackupPayload(base);
  assert.equal(
    Object.hasOwn(unchanged, "backup_webdav_password"),
    false,
    "留空 = 保持不变，不能发送空密码字段",
  );
  assert.equal(unchanged.backup_webdav_url, "https://dav.example.com/dav");
  assert.equal(unchanged.backup_webdav_username, "pierwave");
  assert.equal(unchanged.backup_webdav_interval_hours, 12);
  assert.equal(unchanged.backup_webdav_keep, 3);
  assert.equal(unchanged.backup_webdav_enabled, true);

  const changed = buildRemoteBackupPayload({ ...base, password: " new-pass " });
  assert.equal(changed.backup_webdav_password, " new-pass ");
});

test("form values come from settings without ever exposing the password", () => {
  const form = remoteBackupFormFromSettings({
    backup_webdav_enabled: true,
    backup_webdav_url: "https://dav.example.com/dav",
    backup_webdav_username: "pierwave",
    backup_webdav_has_password: true,
    backup_webdav_interval_hours: 6,
    backup_webdav_keep: 14,
  });
  assert.equal(form.enabled, true);
  assert.equal(form.password, "", "后端不回显密码，表单必须是空串");
  assert.equal(form.intervalHours, "6");
  assert.equal(form.keep, "14");

  const defaults = remoteBackupFormFromSettings({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.intervalHours, "24");
  assert.equal(defaults.keep, "7");
});

test("only managed backup names are listed, newest first and capped", () => {
  assert.equal(
    isManagedRemoteBackupName("pierwave-backup-20261115-190533.db.gz"),
    true,
  );
  assert.equal(
    isManagedRemoteBackupName("pierwave-backup-20261115-190533.db.gz.enc"),
    true,
    "默认加密备份也要列出来",
  );
  for (const name of [
    "notes.txt",
    "pierwave-backup-manual.db.gz",
    "pierwave-backup-20261115-19053.db.gz",
    "pierwave-backup-2026-1115-190533.db.gz",
    "other-20261115-190533.db.gz",
    "pierwave-backup-20261115-190533.db",
    "pierwave-backup-20261115-190533.db.gz.enc.bak",
  ]) {
    assert.equal(isManagedRemoteBackupName(name), false, `不应展示 ${name}`);
  }

  const files = [
    { name: "pierwave-backup-20260101-000000.db.gz", size: 1, modified: 1 },
    { name: "pierwave-backup-20260103-000000.db.gz", size: 3, modified: 3 },
    {
      name: "pierwave-backup-20260102-000000.db.gz.enc",
      size: 2,
      modified: null,
    },
    { name: "notes.txt", size: 9, modified: null },
  ];
  const selected = selectRemoteBackupFiles(files);
  assert.deepEqual(
    selected.map((file) => file.name),
    [
      "pierwave-backup-20260103-000000.db.gz",
      "pierwave-backup-20260102-000000.db.gz.enc",
      "pierwave-backup-20260101-000000.db.gz",
    ],
  );
  assert.equal(selected[1].modified, null, "服务器没给时间时保持 null");

  const many = Array.from({ length: 40 }, (_, index) => ({
    name: `pierwave-backup-202601${String(index + 1).padStart(2, "0")}-000000.db.gz`,
    size: index,
    modified: null,
  }));
  assert.equal(selectRemoteBackupFiles(many).length, REMOTE_BACKUP_MAX_FILES);
});

test("configuration and status tone reflect saved state", () => {
  assert.equal(isRemoteBackupConfigured({}), false);
  assert.equal(
    isRemoteBackupConfigured({
      backup_webdav_url: "https://dav.example.com/dav",
      backup_webdav_has_password: false,
    }),
    false,
    "只有地址没有密码不算配置完成",
  );
  assert.equal(
    isRemoteBackupConfigured({
      backup_webdav_url: "https://dav.example.com/dav",
      backup_webdav_has_password: true,
    }),
    true,
  );

  assert.equal(remoteBackupTone({}), "never");
  assert.equal(remoteBackupTone({ last_success_at: 1 }), "ok");
  assert.equal(
    remoteBackupTone({ last_success_at: 1, last_error: "HTTP 500" }),
    "failed",
    "错误优先于成功时间",
  );
  assert.equal(remoteBackupTone({ last_error: "HTTP 401" }), "failed");
});

test("error text masks credentials embedded in URLs", () => {
  assert.equal(
    redactRemoteError("failed: https://user:pass@dav.example.com/dav returned 401"),
    "failed: https://***@dav.example.com/dav returned 401",
  );
  assert.equal(
    redactRemoteError("WebDAV 认证失败（HTTP 401）"),
    "WebDAV 认证失败（HTTP 401）",
  );
});
