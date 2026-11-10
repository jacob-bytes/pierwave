/**
 * Shadowsocks 纯逻辑：方法白名单、密钥校验/生成、`settings` 归一化。
 *
 * 与后端 `crates/domain/src/xray.rs` 保持同一套规则：
 * - `SS_METHODS` / `SS_NETWORKS` 顺序与后端一致（下拉框顺序也靠它）；
 * - 2022 方法要求 base64 解码后恰好 16 / 32 字节；
 * - 旧 AEAD 密码至少 8 个字符；
 * - `method` / `network` 去空白并转小写，`password` 去两侧空白。
 *
 * 只用 `btoa` / `atob`，不引入 base64 依赖。
 */

export const SS_METHODS = [
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
  "aes-256-gcm",
  "aes-128-gcm",
  "chacha20-poly1305",
  "xchacha20-poly1305",
] as const;

export type SsMethod = (typeof SS_METHODS)[number];

/** 缺省值与后端 `SS_DEFAULT_METHOD` 一致。 */
export const SS_DEFAULT_METHOD: SsMethod = "2022-blake3-aes-256-gcm";

/** `settings.network`：tcp / udp / tcp,udp。 */
export const SS_NETWORKS = ["tcp", "udp", "tcp,udp"] as const;

export type SsNetwork = (typeof SS_NETWORKS)[number];

/** 表单新建 SS 节点时的默认监听方式（同时开 TCP 与 UDP）。 */
export const SS_DEFAULT_NETWORK: SsNetwork = "tcp,udp";

/** 旧 AEAD 密码的最小长度，与后端 `SS_LEGACY_PASSWORD_MIN` 一致。 */
export const SS_LEGACY_PASSWORD_MIN = 8;

/** 旧 AEAD 生成密码的长度。 */
export const SS_LEGACY_GENERATED_LENGTH = 24;

export function normalizeSsMethod(method: string): string {
  return method.trim().toLowerCase();
}

export function normalizeSsNetwork(network: string): string {
  return network.trim().toLowerCase();
}

/** 2022 方法要求的密钥字节数；旧 AEAD 返回 `null`（密码是任意字符串）。 */
export function expectedKeyBytes(method: string): 16 | 32 | null {
  switch (normalizeSsMethod(method)) {
    case "2022-blake3-aes-128-gcm":
      return 16;
    case "2022-blake3-aes-256-gcm":
    case "2022-blake3-chacha20-poly1305":
      return 32;
    default:
      return null;
  }
}

export type SsKeyError = "key_length" | "key_base64" | "key_too_short";

export type SsKeyCheck = { ok: true } | { ok: false; error: SsKeyError };

/** 标准 base64（带 padding，字符集不含空白）；与后端 base64 crate 的 STANDARD 对齐。 */
const BASE64_STANDARD =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 严格解码标准 base64；不合法（含缺 padding、非规范尾位）返回 `null`。
 *
 * 单独做 `btoa(atob(raw)) === raw` 回环，避免 `atob` 比 Rust 的 STANDARD
 * 解码器更宽松：前端放行、后端拒绝的密钥只会让用户白填一次。
 */
export function base64ToBytes(raw: string): Uint8Array | null {
  if (!BASE64_STANDARD.test(raw)) return null;
  try {
    const binary = atob(raw);
    if (btoa(binary) !== raw) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * 校验 SS 密钥。
 *
 * - 2022：空串 / 长度不符 → `key_length`；不是标准 base64 → `key_base64`；
 * - 旧 AEAD：按 Unicode 字符数计，少于 8 → `key_too_short`。
 */
export function validateSsKey(method: string, raw: string): SsKeyCheck {
  const trimmed = raw.trim();
  const expected = expectedKeyBytes(method);

  if (expected !== null) {
    const bytes = base64ToBytes(trimmed);
    if (bytes === null) return { ok: false, error: "key_base64" };
    if (bytes.length !== expected) return { ok: false, error: "key_length" };
    return { ok: true };
  }

  if (Array.from(trimmed).length < SS_LEGACY_PASSWORD_MIN) {
    return { ok: false, error: "key_too_short" };
  }
  return { ok: true };
}

export type RandomSource = (length: number) => Uint8Array;

const LEGACY_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function defaultRandom(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * 生成密钥：2022 → 方法要求的字节数；旧 AEAD → 24 字符字母数字密码。
 *
 * `random` 可注入，测试里就不必碰真随机源。
 */
export function generateSsKey(
  method: string,
  random: RandomSource = defaultRandom,
): string {
  const expected = expectedKeyBytes(method);
  if (expected !== null) return bytesToBase64(random(expected));

  const bytes = random(SS_LEGACY_GENERATED_LENGTH);
  let password = "";
  for (let index = 0; index < SS_LEGACY_GENERATED_LENGTH; index += 1) {
    password += LEGACY_ALPHABET[bytes[index] % LEGACY_ALPHABET.length];
  }
  return password;
}

export interface SsSettings {
  method: string;
  password: string;
  network: string;
}

type NodeLike = { config?: Record<string, unknown> | null } | null | undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 从节点 config 读取 SS 设置并归一化。
 *
 * 缺省：method = 2022-blake3-aes-256-gcm，network = tcp,udp（表单里同时开
 * TCP/UDP 更常见），password = 空串。未知的 method / network 原样保留，
 * 让表单显示原值并由校验拦下，而不是悄悄改成默认值。
 */
export function ssSettings(node: NodeLike): SsSettings {
  const settings = asRecord(asRecord(node?.config)?.settings);

  const method = normalizeSsMethod(asString(settings?.method));
  const network = normalizeSsNetwork(asString(settings?.network));

  return {
    method: method || SS_DEFAULT_METHOD,
    password: asString(settings?.password).trim(),
    network: network || SS_DEFAULT_NETWORK,
  };
}

/** 把三件套写回 `config.settings`，保留 settings 里其它键（如 clients）。 */
export function withSsSettings(
  config: Record<string, unknown>,
  settings: SsSettings,
): Record<string, unknown> {
  const current = asRecord(config.settings);
  return {
    ...config,
    settings: {
      ...(current ?? {}),
      method: normalizeSsMethod(settings.method),
      password: settings.password.trim(),
      network: normalizeSsNetwork(settings.network),
    },
  };
}

const SS_ONLY_SETTING_KEYS = ["method", "password", "network"] as const;

/**
 * 从 `config.settings` 剥掉 SS 专有键；切到 vless 等协议时用，避免
 * `settings.password` 被后端误认为 SS 配置。没有可剥的键时返回原对象。
 */
export function stripSsSettings(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const settings = asRecord(config.settings);
  if (!settings) return config;
  if (!SS_ONLY_SETTING_KEYS.some((key) => key in settings)) return config;

  const next = { ...settings };
  for (const key of SS_ONLY_SETTING_KEYS) delete next[key];
  return { ...config, settings: next };
}

/** 列表徽标：`SS · 2022-256`。未知方法只显示 `SS`。 */
const SS_METHOD_BADGES: Record<string, string> = {
  "2022-blake3-aes-128-gcm": "2022-128",
  "2022-blake3-aes-256-gcm": "2022-256",
  "2022-blake3-chacha20-poly1305": "2022-Chacha",
  "aes-256-gcm": "AES-256",
  "aes-128-gcm": "AES-128",
  "chacha20-poly1305": "ChaCha20",
  "xchacha20-poly1305": "XChaCha20",
};

export function ssMethodBadge(method: string): string {
  const short = SS_METHOD_BADGES[normalizeSsMethod(method)];
  return short ? `SS · ${short}` : "SS";
}

/**
 * 长度错误里的方法简称：`2022-blake3-aes-128-gcm` → `128-gcm`。
 * 完整方法名太长，塞进字段下方一行会挤成两行。
 */
const SS_METHOD_REQUIREMENT_LABELS: Record<string, string> = {
  "2022-blake3-aes-128-gcm": "128-gcm",
  "2022-blake3-aes-256-gcm": "256-gcm",
  "2022-blake3-chacha20-poly1305": "chacha20-poly1305",
};

export function ssKeyRequirementLabel(method: string): string {
  const normalized = normalizeSsMethod(method);
  return SS_METHOD_REQUIREMENT_LABELS[normalized] ?? normalized;
}
