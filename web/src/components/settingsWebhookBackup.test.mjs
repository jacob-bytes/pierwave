import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import zh from "../i18n/zh-CN.ts";
import en from "../i18n/en.ts";

function read(relative) {
  return readFileSync(
    fileURLToPath(new URL(`../components/settings/${relative}`, import.meta.url)),
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// B13：Webhook 不回显 / has_url 状态 / 留空不改 / 显式清除
// ---------------------------------------------------------------------------

test("AlertsCard derives the webhook state from webhook_has_url", () => {
  const source = read("AlertsCard.tsx");
  assert.match(source, /webhookHasUrl: items\.webhook_has_url === true/);
  assert.match(source, /webhookFieldState\(savedConfig\)/);
  // 已配置时占位与提示必须换成「留空保持」，不能再显示示例地址。
  assert.match(
    source,
    /savedHasWebhook\s*\?\s*t\("settings\.alerts\.webhook\.savedPlaceholder"\)\s*:\s*t\("settings\.alerts\.webhook\.placeholder"\)/,
  );
  assert.match(source, /webhook\.savedHint/);
  assert.match(source, /webhook\.urlHint/);
  assert.match(source, /savedHasWebhook \? \(/);
});

test("webhook save omits blank input and clear is an explicit dialog", () => {
  const source = read("AlertsCard.tsx");
  // 保存走统一 payload 构造器；留空时它不会带 webhook_url。
  assert.match(source, /buildAlertSettingsPatch\(values\)/);
  // 清空走单独的 null PATCH，且必须经过确认对话框。
  assert.match(source, /clearWebhookPatch\(\)/);
  assert.match(source, /<AlertDialog[\s\S]*?webhook\.clearTitle/);
  assert.match(source, /webhook\.clearDesc/);
  assert.match(source, /webhook\.clearConfirm/);
  // 保存/清除后都用 PATCH 返回的权威值刷新 has_url 状态。
  assert.match(source, /setSavedConfig\(channelConfig\(items\)\)/);
});

test("webhook saved-state copy exists in both locales", () => {
  for (const dictionary of [zh, en]) {
    for (const key of [
      "savedHint",
      "savedPlaceholder",
      "clear",
      "clearTitle",
      "clearDesc",
      "clearConfirm",
      "clearing",
      "cleared",
      "clearError",
    ]) {
      assert.equal(
        typeof dictionary.settings.alerts.webhook[key],
        "string",
        key,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// B14：too_large 禁用导出/立即上传，并识别 backup.export_too_large
// ---------------------------------------------------------------------------

test("BackupCard disables export when /backup/info reports too_large", () => {
  const source = read("BackupCard.tsx");
  assert.match(source, /isBackupExportBlocked\(info\.data\)/);
  assert.match(source, /disabled=\{exportBlocked \|\| downloading\}/);
  assert.match(source, /settings\.backup\.exportBlocked/);
  assert.match(source, /formatBytes\(exportLimitBytes\)/);
  // 导出不再是无法感知错误的 <a download>：先读 Blob，失败再翻译错误码。
  assert.match(source, /api\.backup\.download\(\)/);
  assert.match(source, /isExportTooLarge\(error\)/);
  assert.match(source, /exportTooLargeLimitBytes\(error\)/);
  assert.equal(source.includes("downloadUrl"), false);
});

test("RemoteBackupCard disables immediate upload but keeps the connection test", () => {
  const source = read("RemoteBackupCard.tsx");
  assert.match(source, /useBackupInfo\(\)/);
  assert.match(source, /canRun = canTest && !exportBlocked/);
  assert.match(source, /disabled=\{!canRun \|\| runBackup\.isPending\}/);
  assert.match(source, /disabled=\{!canTest \|\| testConnection\.isPending\}/);
  assert.match(source, /settings\.backup\.exportBlocked/);
  assert.match(source, /isExportTooLarge\(error\)/);
});

test("backup.export_too_large has paired error entries", () => {
  assert.equal(typeof zh.errors["backup.export_too_large"], "string");
  assert.equal(typeof en.errors["backup.export_too_large"], "string");
  assert.ok(zh.errors["backup.export_too_large"].includes("上限"));
  assert.ok(en.errors["backup.export_too_large"].includes("limit"));
  for (const dictionary of [zh, en]) {
    for (const key of [
      "exportBlocked",
      "exportTooLargeError",
      "downloadError",
      "downloading",
    ]) {
      assert.equal(
        typeof dictionary.settings.backup[key],
        "string",
        key,
      );
    }
  }
});
