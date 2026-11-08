/**
 * P13：告警通知的前端纯逻辑，见 docs/PLAN.md「P13：告警通知」。
 *
 * 这里只放与 React / 网络无关的规则：
 * - `alert_events` 是逗号分隔的白名单值，必须按契约顺序解析与序列化；
 * - Webhook 只接受 http(s) 绝对地址；
 * - 已保存的 Bot Token 只用「掩码 + 末 4 位」回显，任何时候都不展示完整值；
 * - 测试结果按 telegram / webhook 固定顺序展示，未知渠道保留原样兜底。
 */

/** 与后端白名单一致；顺序也是 UI 的展示与序列化顺序。 */
export const ALERT_EVENTS = [
  "server_offline",
  "user_exhausted",
  "chain_degraded",
  "upgrade_failed",
] as const;

export type AlertEvent = (typeof ALERT_EVENTS)[number];

/** 后端缺省值（见 docs/PLAN.md）：升级失败默认不通知。 */
export const DEFAULT_ALERT_EVENTS: readonly AlertEvent[] = [
  "server_offline",
  "user_exhausted",
  "chain_degraded",
];

export const DEFAULT_ALERT_COOLDOWN_SECS = 600;
export const ALERT_COOLDOWN_MIN = 0;
export const ALERT_COOLDOWN_MAX = 86400;

/** 测试接口按渠道返回；后续后端新增渠道时前端不崩，未知值原样展示。 */
export interface AlertTestResult {
  channel: string;
  ok: boolean;
  error: string;
}

export interface AlertChannelConfig {
  telegramBotToken?: string | null;
  telegramChatId?: string | null;
  webhookUrl?: string | null;
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

export function isAlertEvent(value: string): value is AlertEvent {
  return (ALERT_EVENTS as readonly string[]).includes(value);
}

/**
 * 解析 `alert_events`。
 *
 * - 字段缺失（null / undefined）= 后端没返回该键，按契约默认值处理；
 * - 空字符串 = 管理员显式取消全部事件，返回空数组；
 * - 未知值、重复值忽略，结果始终按 `ALERT_EVENTS` 顺序排列。
 */
export function parseAlertEvents(
  raw: string | null | undefined,
): AlertEvent[] {
  if (raw === null || raw === undefined) return [...DEFAULT_ALERT_EVENTS];

  const selected = new Set(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter(isAlertEvent),
  );
  return ALERT_EVENTS.filter((event) => selected.has(event));
}

/** 序列化为后端要求的逗号分隔串；空数组返回空串（= 不发送任何告警）。 */
export function serializeAlertEvents(events: readonly string[]): string {
  const selected = new Set(events);
  return ALERT_EVENTS.filter((event) => selected.has(event)).join(",");
}

/**
 * Webhook 只接受 http(s) 绝对地址。
 *
 * 刻意拒绝带空白的串与缺少主机的地址：`new URL` 对 `http://` 会抛错，
 * 但 `http:// example.com` 这类输入在不同浏览器里行为不一致，这里先挡掉。
 */
export function isHttpUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;

  try {
    const url = new URL(trimmed);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== ""
    );
  } catch {
    return false;
  }
}

const SECRET_BULLET = "•";

/**
 * 已保存密钥的展示值：最多 8 个掩码 + 末 4 位。
 *
 * 短于等于 8 个字符时全部掩码，避免「末 4 位」反而暴露大半；
 * 后端若已经返回掩码串（含 `•`）则原样展示，不重复打码。
 */
export function maskSecret(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (value.includes(SECRET_BULLET)) return value;
  if (value.length <= 8) return SECRET_BULLET.repeat(value.length);

  const masked = SECRET_BULLET.repeat(Math.min(8, value.length - 4));
  return `${masked}${value.slice(-4)}`;
}

/** 是否至少配置了一个完整可用的渠道（Telegram 需要 Token + Chat ID 同时存在）。 */
export function hasConfiguredAlertChannel(config: AlertChannelConfig): boolean {
  if (hasText(config.webhookUrl)) return true;
  return hasText(config.telegramBotToken) && hasText(config.telegramChatId);
}

/** 只填了 Telegram 两个字段之一：能保存，但不会真的发出消息，UI 需要提示。 */
export function isTelegramIncomplete(config: AlertChannelConfig): boolean {
  const hasToken = hasText(config.telegramBotToken);
  const hasChatId = hasText(config.telegramChatId);
  return hasToken !== hasChatId;
}

/**
 * Telegram Token / Chat ID 不允许空白或控制字符（与后端一致）。
 *
 * 不用正则字符类写控制字符，避免 lint 的 `no-control-regex`；
 * Rust 的 `is_control()` 覆盖 U+0000–U+001F 与 U+007F–U+009F。
 */
export function hasWhitespaceOrControl(value: string): boolean {
  for (const character of Array.from(value)) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (/\s/u.test(character)) return true;
  }
  return false;
}

const CHANNEL_ORDER = ["telegram", "webhook"] as const;

function channelRank(channel: string): number {
  const index = (CHANNEL_ORDER as readonly string[]).indexOf(channel);
  return index === -1 ? CHANNEL_ORDER.length : index;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 归一化测试接口的响应。
 *
 * 后端可能暂时返回非契约结构：缺 `results`、条目不是对象或 `ok` 不是布尔
 * 都按失败/空结果兜底，而不是让卡片崩掉；同一渠道重复出现时只保留第一条。
 */
export function normalizeAlertTestResults(payload: unknown): AlertTestResult[] {
  const raw =
    isRecord(payload) && Array.isArray(payload.results)
      ? payload.results
      : [];

  const results: AlertTestResult[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const channel =
      typeof item.channel === "string" ? item.channel.trim() : "";
    if (!channel || seen.has(channel)) continue;
    seen.add(channel);

    results.push({
      channel,
      ok: item.ok === true,
      error: typeof item.error === "string" ? item.error.trim() : "",
    });
  }

  // 稳定排序：telegram → webhook → 未知渠道（保持后端返回顺序）。
  return results
    .map((result, index) => ({ result, index }))
    .sort(
      (a, b) =>
        channelRank(a.result.channel) - channelRank(b.result.channel) ||
        a.index - b.index,
    )
    .map(({ result }) => result);
}

export type AlertTestOutcome = "empty" | "ok" | "partial" | "failed";

/** 测试结果汇总，用于 toast 与结果区标题；空数组单独成一种状态。 */
export function alertTestOutcome(
  results: readonly AlertTestResult[],
): AlertTestOutcome {
  if (results.length === 0) return "empty";

  const okCount = results.filter((result) => result.ok).length;
  if (okCount === results.length) return "ok";
  if (okCount === 0) return "failed";
  return "partial";
}
