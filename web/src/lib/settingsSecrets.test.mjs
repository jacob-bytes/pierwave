import assert from "node:assert/strict";
import test from "node:test";
import { setCurrentLocale } from "../i18n/locale.ts";
import {
  BACKUP_ENCRYPTION_DOC_URL,
  buildSecretPatch,
  secretKeyText,
  secretRecoveryFromSettings,
  subscriptionSecretAtRisk,
  SUBSCRIPTION_SECRET_KEY,
} from "./settingsSecrets.ts";

test("secretRecoveryFromSettings hides the card when secret_errors is absent", () => {
  assert.equal(secretRecoveryFromSettings(undefined), null);
  assert.equal(secretRecoveryFromSettings(null), null);
  assert.equal(secretRecoveryFromSettings({}), null);
  assert.equal(secretRecoveryFromSettings({ secret_errors: null }), null);
});

test("secretRecoveryFromSettings hides the card for an empty keys array", () => {
  assert.equal(
    secretRecoveryFromSettings({ secret_errors: { keys: [] } }),
    null,
  );
  assert.equal(
    secretRecoveryFromSettings({ secret_errors: { keys: ["", 42] } }),
    null,
    "没有有效字符串键时视为正常",
  );
  assert.equal(
    secretRecoveryFromSettings({ secret_errors: {} }),
    null,
    "旧后端缺少 keys 时也视为正常",
  );
});

test("secretRecoveryFromSettings splits editable and internal secrets", () => {
  const recovery = secretRecoveryFromSettings({
    secret_errors: {
      keys: [
        "telegram_bot_token",
        "hmac_secret_v1",
        "backup_webdav_password",
      ],
    },
  });
  assert.deepEqual(recovery.keys, [
    "telegram_bot_token",
    "hmac_secret_v1",
    "backup_webdav_password",
  ]);
  assert.deepEqual(recovery.editableKeys, [
    "telegram_bot_token",
    "backup_webdav_password",
  ]);
  assert.deepEqual(recovery.internalKeys, ["hmac_secret_v1"]);
});

test("secretRecoveryFromSettings keeps unknown keys visible as internal", () => {
  const recovery = secretRecoveryFromSettings({
    secret_errors: { keys: ["telegram_bot_token", "future_secret"] },
  });
  assert.deepEqual(recovery.keys, ["telegram_bot_token", "future_secret"]);
  assert.deepEqual(recovery.editableKeys, ["telegram_bot_token"]);
  // 未知内部键原样保留；订阅 secret 按同一把主密钥补在末尾。
  assert.deepEqual(recovery.internalKeys, ["future_secret", "hmac_secret_v1"]);
  assert.equal(secretKeyText("future_secret"), "future_secret");
});

test("secretRecoveryFromSettings ignores non-string and duplicate-adjacent junk", () => {
  const recovery = secretRecoveryFromSettings({
    secret_errors: {
      keys: ["webhook_url", 42, null, { key: "x" }, "webhook_url"],
    },
  });
  // 只过滤非字符串；合法键保持后端顺序，不擅自去重。
  assert.deepEqual(recovery.keys, ["webhook_url", "webhook_url"]);
  assert.deepEqual(recovery.editableKeys, ["webhook_url", "webhook_url"]);
  assert.deepEqual(recovery.internalKeys, ["hmac_secret_v1"]);
});

test("secretKeyText localizes known keys and falls back to raw names", () => {
  setCurrentLocale("zh-CN");
  assert.equal(secretKeyText("telegram_bot_token"), "Telegram Bot Token");
  assert.equal(secretKeyText("backup_webdav_password"), "WebDAV 密码");
  assert.equal(secretKeyText("hmac_secret_v1"), "订阅派生 secret");
  assert.equal(secretKeyText("future_secret"), "future_secret");

  setCurrentLocale("en");
  assert.equal(secretKeyText("telegram_bot_token"), "Telegram bot token");
  assert.equal(secretKeyText("webhook_url"), "Webhook URL");
  assert.equal(secretKeyText("future_secret"), "future_secret");
  setCurrentLocale("zh-CN");
});

test("buildSecretPatch trims values and only includes editable non-empty secrets", () => {
  assert.deepEqual(
    buildSecretPatch({
      telegram_bot_token: "  new-token  ",
      backup_webdav_password: "   ",
      webhook_url: " https://example.com/hook ",
      hmac_secret_v1: "should-not-be-sent",
    }),
    {
      telegram_bot_token: "new-token",
      webhook_url: "https://example.com/hook",
    },
  );
  assert.deepEqual(buildSecretPatch({ hmac_secret_v1: "x" }), {});
  assert.deepEqual(buildSecretPatch({}), {});
});


test("the subscription secret is inferred when the master key is wrong", () => {
  // 后端 GET 只上报三个可见秘密；hmac_secret_v1 不在 keys 里，但它和它们
  // 共用同一把主密钥，恢复卡必须给出订阅链接的下一步。
  const recovery = secretRecoveryFromSettings({
    secret_errors: { keys: ["telegram_bot_token"] },
  });
  assert.deepEqual(recovery.keys, ["telegram_bot_token"]);
  assert.deepEqual(recovery.internalKeys, [SUBSCRIPTION_SECRET_KEY]);
  assert.equal(subscriptionSecretAtRisk(recovery), true);
  assert.match(BACKUP_ENCRYPTION_DOC_URL, /docs\/BACKUP_ENCRYPTION\.md$/);

  // 只有内部键时也成立；没有秘密错误时不会伪造恢复卡。
  const internalOnly = secretRecoveryFromSettings({
    secret_errors: { keys: ["hmac_secret_v1"] },
  });
  assert.deepEqual(internalOnly.internalKeys, ["hmac_secret_v1"]);
  assert.equal(
    subscriptionSecretAtRisk({
      keys: [],
      editableKeys: [],
      internalKeys: [],
    }),
    false,
  );
  assert.equal(secretRecoveryFromSettings({ secret_errors: { keys: [] } }), null);
});
