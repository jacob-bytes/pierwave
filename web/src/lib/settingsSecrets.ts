import { t } from "../i18n/index.ts";

/**
 * 设置页「秘密解不开」的专用恢复逻辑。
 *
 * 新后端 `GET /api/v1/settings` 始终 200：秘密解不开时在顶层带
 * `secret_errors.keys`，`items` 里对应秘密字段为空。这里只做纯逻辑：
 * 从设置响应里取出键名、拆成「可重填 / 内部不可重填」两组、生成只包含
 * 非空可编辑秘密的 PATCH。页面负责展示与提交。
 */

export type SecretFieldKind = "password" | "url";

export interface SecretFieldMeta {
  /** PATCH /settings 的字段名，与后端白名单一致。 */
  apiKey: "telegram_bot_token" | "backup_webdav_password" | "webhook_url";
  input: SecretFieldKind;
}

/**
 * 设置页可以重填的秘密。`hmac_secret_v1` 是订阅派生内部密钥，故意不在这里：
 * 它只能通过备份恢复 / 重新生成，没有输入框。
 */
export const EDITABLE_SECRET_FIELDS: Record<string, SecretFieldMeta> = {
  telegram_bot_token: { apiKey: "telegram_bot_token", input: "password" },
  backup_webdav_password: {
    apiKey: "backup_webdav_password",
    input: "password",
  },
  webhook_url: { apiKey: "webhook_url", input: "url" },
};

export interface SecretDecryptFailure {
  /** 后端报告的原始键名，保持顺序。 */
  keys: string[];
  /** 可以在设置页重新填写的键。 */
  editableKeys: string[];
  /** 设置页无法重填的内部键（目前只有 hmac_secret_v1）。 */
  internalKeys: string[];
}

/** 设置响应的最小结构：GET 的 items 与顶层 secret_errors 合并后即可传入。 */
export interface SettingsSecretErrorsInput {
  secret_errors?: {
    keys?: unknown;
  } | null;
}

function stringKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * 从设置响应里识别「有秘密解不开」。
 *
 * - `secret_errors` 缺失 / 为 null / keys 为空 → 返回 null（不显示恢复卡）。
 * - keys 非空 → 拆分可重填与内部不可重填的键，未知键按内部键处理并原样展示。
 */
export function secretRecoveryFromSettings(
  settings: SettingsSecretErrorsInput | null | undefined,
): SecretDecryptFailure | null {
  const keys = stringKeys(settings?.secret_errors?.keys);
  if (keys.length === 0) return null;

  return {
    keys,
    editableKeys: keys.filter((key) => key in EDITABLE_SECRET_FIELDS),
    internalKeys: keys.filter((key) => !(key in EDITABLE_SECRET_FIELDS)),
  };
}

/**
 * 秘密键的可读名称；未知键原样回退，不把 `secretKeys.xxx` 暴露给用户。
 */
export function secretKeyText(key: string): string {
  const i18nKey = `secretKeys.${key}`;
  const text = t(i18nKey);
  return text === i18nKey ? key : text;
}

/**
 * 只把已填写的可编辑秘密放进 PATCH：
 * - 空输入不提交，避免把「已保存」误清空；
 * - 首尾空白统一 trim，与后端 normalize 保持一致；
 * - 未知 / 内部键直接忽略，前端不擅自改内部密钥。
 */
export function buildSecretPatch(
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    const meta = EDITABLE_SECRET_FIELDS[key];
    if (!meta || typeof raw !== "string") continue;
    const value = raw.trim();
    if (value) patch[meta.apiKey] = value;
  }
  return patch;
}
