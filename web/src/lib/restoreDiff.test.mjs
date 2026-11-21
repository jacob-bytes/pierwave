import assert from "node:assert/strict";
import test from "node:test";
import en from "../i18n/en.ts";
import zh from "../i18n/zh-CN.ts";
import {
  emptyRestorePreview,
  formatRestoreValue,
  hasRestorePreviewContent,
  isRestoreFlagKey,
  normalizeServerTokenRefresh,
  normalizeSettingsDiff,
  restorePreviewFromResponse,
  restoreSettingLabel,
} from "./restoreDiff.ts";

function lookup(dictionary, path) {
  return path
    .split(".")
    .reduce((node, part) => (node == null ? undefined : node[part]), dictionary);
}

test("normalizeSettingsDiff keeps known scalar changes in response order", () => {
  const diff = normalizeSettingsDiff([
    { key: "backup_encrypt", before: false, after: true },
    { key: "public_status_servers", before: "公开 2 台 / 2 public", after: "公开 1 台 / 1 public" },
    { key: "panel_name", before: "AfterRestore", after: "BeforeRestore" },
  ]);

  assert.deepEqual(diff, [
    {
      key: "backup_encrypt",
      before: false,
      after: true,
      secret: false,
    },
    {
      key: "public_status_servers",
      before: "公开 2 台 / 2 public",
      after: "公开 1 台 / 1 public",
      secret: false,
    },
    {
      key: "panel_name",
      before: "AfterRestore",
      after: "BeforeRestore",
      secret: false,
    },
  ]);
});

test("normalizeSettingsDiff skips malformed entries and dedupes keys", () => {
  const diff = normalizeSettingsDiff([
    null,
    "nope",
    { before: true, after: false },
    { key: "  ", before: 1, after: 0 },
    { key: "backup_encrypt", before: {}, after: [] },
    { key: "backup_encrypt", before: false, after: true },
    { key: "backup_encrypt", before: true, after: false },
    { key: "login_max_attempts", before: 5, after: 10 },
    { key: "login_lock_secs" },
  ]);

  assert.deepEqual(
    diff.map((entry) => entry.key),
    ["backup_encrypt", "login_max_attempts"],
  );
  assert.equal(diff[0].before, false, "重复 key 保留第一条");
  assert.equal(diff[0].after, true);
  assert.deepEqual(normalizeSettingsDiff(undefined), []);
  assert.deepEqual(normalizeSettingsDiff({ key: "x" }), []);
});

test("secret rows never retain values", () => {
  const canary = "123456:from-another-instance";
  const diff = normalizeSettingsDiff([
    {
      key: "telegram_bot_token",
      before: canary,
      after: `${canary}-new`,
      secret: true,
    },
  ]);

  assert.deepEqual(diff, [
    {
      key: "telegram_bot_token",
      before: null,
      after: null,
      secret: true,
    },
  ]);
  assert.equal(JSON.stringify(diff).includes(canary), false, "秘密值不能进入前端状态");
});

test("normalizeServerTokenRefresh aligns count with names and dedupes", () => {
  assert.deepEqual(
    normalizeServerTokenRefresh({
      count: 2,
      names: ["hk-1", " sg-2 ", "hk-1", "", 42],
    }),
    { count: 2, names: ["hk-1", "sg-2"] },
  );
  // count 缺失/非法时退回名称数量，避免提示「0 台」却列出名称。
  assert.deepEqual(normalizeServerTokenRefresh({ names: ["hk-1"] }), {
    count: 1,
    names: ["hk-1"],
  });
  assert.deepEqual(normalizeServerTokenRefresh({ count: 3, names: [] }), {
    count: 3,
    names: [],
  });
  assert.deepEqual(normalizeServerTokenRefresh(null), {
    count: 0,
    names: [],
  });
});

test("an empty preview renders nothing; any content turns it on", () => {
  const empty = emptyRestorePreview();
  assert.equal(hasRestorePreviewContent(empty), false);
  assert.equal(
    hasRestorePreviewContent({
      settingsDiff: [],
      serversNeedingTokenRefresh: { count: 0, names: [] },
    }),
    false,
  );
  assert.equal(
    hasRestorePreviewContent({
      settingsDiff: normalizeSettingsDiff([{ key: "backup_encrypt", before: false, after: true }]),
      serversNeedingTokenRefresh: { count: 0, names: [] },
    }),
    true,
  );
  assert.equal(
    hasRestorePreviewContent({
      settingsDiff: [],
      serversNeedingTokenRefresh: { count: 2, names: ["hk-1", "sg-2"] },
    }),
    true,
  );
});

test("restorePreviewFromResponse tolerates old backends without the fields", () => {
  assert.deepEqual(restorePreviewFromResponse(null), emptyRestorePreview());
  assert.deepEqual(restorePreviewFromResponse({ restart_required: true }), emptyRestorePreview());
  assert.deepEqual(
    restorePreviewFromResponse({
      restart_required: true,
      settings_diff: [{ key: "backup_encrypt", before: false, after: true }],
      servers_needing_token_refresh: { count: 1, names: ["hk-1"] },
    }),
    {
      settingsDiff: [
        { key: "backup_encrypt", before: false, after: true, secret: false },
      ],
      serversNeedingTokenRefresh: { count: 1, names: ["hk-1"] },
    },
  );
});

test("setting labels cover the required keys in both locales and fall back raw", () => {
  const required = [
    "backup_encrypt",
    "public_status_enabled",
    "public_billing_visible",
    "public_status_servers",
    "telegram_bot_enabled",
    "backup_webdav_enabled",
  ];

  for (const [locale, dictionary] of [
    ["zh-CN", zh],
    ["en", en],
  ]) {
    const translate = (path) =>
      lookup(dictionary, path) ?? path;
    for (const key of required) {
      const label = restoreSettingLabel(key, translate);
      assert.notEqual(label, key, `${locale} 缺少可读名：${key}`);
      assert.equal(typeof label, "string");
      assert.ok(label.length > 0);
    }
    assert.equal(
      restoreSettingLabel("future_unknown_key", translate),
      "future_unknown_key",
      `${locale} 未知 key 必须原样显示`,
    );
  }

  // 抽查语义，防止中英张冠李戴。
  const zhLabel = (key) =>
    restoreSettingLabel(key, (path) => lookup(zh, path) ?? path);
  const enLabel = (key) =>
    restoreSettingLabel(key, (path) => lookup(en, path) ?? path);
  assert.equal(zhLabel("backup_encrypt"), "备份加密");
  assert.equal(enLabel("backup_encrypt"), "Backup encryption");
  assert.equal(zhLabel("public_status_servers"), "公开页服务器");
  assert.equal(enLabel("public_status_servers"), "Public servers");
});

test("flag keys render as on/off while other numbers stay numeric", () => {
  assert.equal(isRestoreFlagKey("backup_encrypt"), true);
  assert.equal(isRestoreFlagKey("public_status_enabled"), true);
  assert.equal(isRestoreFlagKey("login_max_attempts"), false);
  assert.equal(
    formatRestoreValue(false, { on: "启用", off: "停用", none: "—" }),
    "停用",
  );
  assert.equal(
    formatRestoreValue(5, { on: "启用", off: "停用", none: "—" }),
    "5",
  );
  assert.equal(
    formatRestoreValue(null, { on: "启用", off: "停用", none: "—" }),
    "—",
  );
});

test("restore copy and the sync error code are paired in both locales", () => {
  for (const dictionary of [zh, en]) {
    assert.equal(typeof dictionary.settings.backup.restoreSyncFailed, "string");
    assert.equal(typeof dictionary.settings.backup.restoreDiff.title, "string");
    assert.equal(
      typeof dictionary.settings.backup.restoreDiff.secretReset,
      "string",
    );
    assert.equal(
      typeof dictionary.settings.backup.restoreDiff.servers.title,
      "string",
    );
    assert.equal(
      typeof dictionary.settings.backup.restoreDiff.servers.desc,
      "string",
    );
    assert.equal(
      typeof dictionary.errors["backup.restore_sync_failed"],
      "string",
    );
  }
  assert.ok(zh.settings.backup.restoreSyncFailed.includes("磁盘"));
  assert.ok(en.settings.backup.restoreSyncFailed.includes("disk"));
  assert.equal(
    zh.settings.backup.restoreDiff.secretReset.includes("值已隐藏"),
    true,
  );
  assert.equal(
    en.settings.backup.restoreDiff.secretReset.toLowerCase().includes("hidden"),
    true,
  );
});
