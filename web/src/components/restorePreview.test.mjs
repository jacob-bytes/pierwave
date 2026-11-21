import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../components/settings/${relative}`, import.meta.url)),
    "utf8",
  );
}

test("BackupCard keeps the restore preview from the scheduling response", () => {
  const source = read("BackupCard.tsx");
  assert.match(source, /restorePreviewFromResponse\(result\)/);
  assert.match(source, /setRestorePreview\(/);
  assert.match(source, /setRestorePreview\(emptyRestorePreview\(\)\)/);
  assert.match(source, /<RestorePreviewNotice preview=\{restorePreview\} \/>/);
  // 恢复响应现在带 diff / token 信息，回调必须把整个 result 交出去。
  assert.match(source, /onScheduled: \(result: RestoreBackupResponse\) => void/);
  assert.match(source, /onScheduled\(result\)/);
});

test("RestorePreviewNotice renders nothing when both sections are empty", () => {
  const source = read("RestorePreviewNotice.tsx");
  assert.match(source, /if \(!hasRestorePreviewContent\(preview\)\) return null;/);
  // 两个区块各自按内容条件渲染，不留空 details。
  assert.match(source, /settingsDiff\.length > 0 \?/);
  assert.match(source, /serversNeedingTokenRefresh\.count > 0 \?/);
});

test("settings diff uses readable labels and collapsible details", () => {
  const source = read("RestorePreviewNotice.tsx");
  assert.match(source, /restoreSettingLabel\(entry\.key, t\)/);
  assert.match(source, /<details/);
  assert.match(source, /<summary/);
  assert.match(source, /restoreDiff\.title/);
});

test("secret rows only say the secret was reset and never render values", () => {
  const source = read("RestorePreviewNotice.tsx");
  assert.match(source, /entry\.secret \?/);
  assert.match(source, /restoreDiff\.secretReset/);
  // 值只在非秘密分支（`: (` 之后）渲染；secret 分支不允许调用 valueText。
  const secretIndex = source.indexOf("entry.secret ?");
  const valueIndex = source.indexOf("valueText(entry.key, entry.before)");
  assert.notEqual(secretIndex, -1);
  assert.ok(
    valueIndex > secretIndex,
    "before/after 只能出现在非 secret 分支里",
  );
  assert.equal(
    /entry\.secret[\s\S]{0,120}?valueText/.test(source),
    false,
    "secret 分支不能渲染 before/after",
  );
});

test("token refresh warning shows the count and expands to names", () => {
  const source = read("RestorePreviewNotice.tsx");
  assert.match(source, /restoreDiff\.servers\.title/);
  assert.match(source, /serversNeedingTokenRefresh\.names\.map/);
  assert.match(source, /restoreDiff\.servers\.desc/);
  // 0 台时整个 warning 不出现（由 count > 0 条件保证）。
  assert.match(source, /serversNeedingTokenRefresh\.count > 0 \?/);
});

test("BackupCard maps backup.restore_sync_failed to a disk-specific message", () => {
  const source = read("BackupCard.tsx");
  assert.match(source, /backup\.restore_sync_failed/);
  assert.match(source, /settings\.backup\.restoreSyncFailed/);
});
