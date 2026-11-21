import assert from "node:assert/strict";
import test from "node:test";
import { t } from "../i18n/index.ts";
import { setCurrentLocale } from "../i18n/locale.ts";
import { ApiError } from "./apiError.ts";
import {
  BACKUP_ENCRYPTION_DOC_URL,
  buildSecretPatch,
  canResetSubscriptionSecret,
  isSecretDecryptError,
  secretKeyText,
  secretRecoveryFromSettings,
  subscriptionSecretAtRisk,
  subscriptionSecretResetUnsupported,
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

test("a card is still produced when hmac_secret_v1 is the only broken secret", () => {
  // 新后端会把内部订阅派生 secret 也放进 secret_errors.keys。以前只有三个
  // 用户可见键才会进这个数组，若前端再按「可编辑键」过滤，整张恢复卡会被
  // 藏掉——只有 hmac 坏时用户就看不到任何下一步。
  const recovery = secretRecoveryFromSettings({
    secret_errors: { keys: [SUBSCRIPTION_SECRET_KEY] },
  });
  assert.ok(recovery, "只有 hmac 坏掉时也必须显示恢复卡");
  assert.deepEqual(recovery.keys, [SUBSCRIPTION_SECRET_KEY]);
  assert.deepEqual(recovery.editableKeys, []);
  assert.deepEqual(recovery.internalKeys, [SUBSCRIPTION_SECRET_KEY]);
  assert.equal(subscriptionSecretAtRisk(recovery), true);
});

test("canResetSubscriptionSecret only unlocks the explicit hmac failure", () => {
  // 后端明确报告 hmac 坏了 → 提供在线重置。
  const hmacOnly = secretRecoveryFromSettings({
    secret_errors: { keys: [SUBSCRIPTION_SECRET_KEY] },
  });
  assert.equal(canResetSubscriptionSecret(hmacOnly), true);

  const mixed = secretRecoveryFromSettings({
    secret_errors: {
      keys: ["telegram_bot_token", SUBSCRIPTION_SECRET_KEY],
    },
  });
  assert.equal(canResetSubscriptionSecret(mixed), true);

  // 只有用户可见秘密坏掉时，hmac 只是「可能同主密钥」的推断，不能凭推断
  // 就给出会轮换所有凭据的破坏性入口。
  const editableOnly = secretRecoveryFromSettings({
    secret_errors: { keys: ["telegram_bot_token"] },
  });
  assert.deepEqual(editableOnly.internalKeys, [SUBSCRIPTION_SECRET_KEY]);
  assert.equal(canResetSubscriptionSecret(editableOnly), false);
});

test("a missing reset endpoint is a safe 404/405 fallback, not an error", () => {
  assert.equal(
    subscriptionSecretResetUnsupported(new ApiError("not found", 404)),
    true,
  );
  // 旧版 master 的 SPA 静态兜底只服务 GET/HEAD，POST 未注册路径会 405。
  assert.equal(
    subscriptionSecretResetUnsupported(new ApiError("method not allowed", 405)),
    true,
  );
  assert.equal(
    subscriptionSecretResetUnsupported(new ApiError("bad request", 400)),
    false,
  );
  assert.equal(
    subscriptionSecretResetUnsupported(new ApiError("forbidden", 403)),
    false,
  );
  assert.equal(
    subscriptionSecretResetUnsupported(new ApiError("unavailable", 503)),
    false,
    "503 是真实故障，必须留在弹窗里展示错误",
  );
  assert.equal(subscriptionSecretResetUnsupported(new Error("network")), false);
  assert.equal(subscriptionSecretResetUnsupported(null), false);
});

test("the reset confirmation states both consequences in both languages", () => {
  setCurrentLocale("zh-CN");
  const zhDesc = t("settings.secretError.resetDesc");
  assert.match(zhDesc, /所有客户端需重新拉取订阅/);
  assert.match(zhDesc, /旧凭据立即失效/);
  assert.match(t("settings.secretError.resetTitle"), /重置/);
  assert.match(t("settings.secretError.resetAction"), /重置/);

  setCurrentLocale("en");
  const enDesc = t("settings.secretError.resetDesc");
  assert.match(enDesc, /every client must fetch its subscription again/i);
  assert.match(enDesc, /old credentials stop working immediately/i);
  assert.match(t("settings.secretError.resetTitle"), /reset/i);
  assert.match(t("settings.secretError.resetAction"), /reset/i);
  setCurrentLocale("zh-CN");
});

test("the 503 secret_decrypt_failed code is recognized by code, not status", () => {
  assert.equal(
    isSecretDecryptError(
      new ApiError("upstream", 503, "settings.secret_decrypt_failed", {
        keys: [SUBSCRIPTION_SECRET_KEY],
      }),
    ),
    true,
  );
  assert.equal(
    isSecretDecryptError(new ApiError("other", 503, "request.busy")),
    false,
  );
  assert.equal(isSecretDecryptError(new ApiError("not found", 404)), false);
  assert.equal(isSecretDecryptError(new Error("network")), false);
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
