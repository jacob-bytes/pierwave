/**
 * 登录设备 / 最近登录的纯逻辑（不依赖 React）。
 *
 * 后端只返回原始 `user_agent`、`ip` 与时间戳；设备名由这里解析：
 * - 命中常见浏览器 / 系统时显示「浏览器 · 系统」（只保留主版本号）；
 * - 解析不出浏览器时显示截断后的原始 UA，满足「解析失败也别空白」；
 * - 空 UA 显示「未知设备」。
 *
 * 这些函数放在独立模块里，方便 `node --test` 直接覆盖边界（手机 UA、
 * 超长 UA、current 排序、时间回退）。
 */

import { t } from "../i18n/index.ts";
import { formatRelativeTime } from "./time.ts";

/** 原始 UA 兜底展示的最大字符数（含省略号）。 */
export const RAW_UA_MAX_CHARS = 48;

export const SESSIONS_EMPTY_KEY = "sessions.empty";
export const LOGINS_EMPTY_KEY = "sessions.history.empty";

/** 本次新增的登录告警事件；与 `alerts.ts` 的 ALERT_EVENTS 保持一致。 */
export const LOGIN_ALERT_EVENTS = ["login_failed", "login_new_ip"] as const;
export type LoginAlertEvent = (typeof LOGIN_ALERT_EVENTS)[number];

export interface SessionLike {
  id: string;
  user_agent?: string | null;
  ip?: string | null;
  created_at: number;
  last_seen_at?: number | null;
  current: boolean;
}

export interface LoginRecordLike {
  id: string;
  user_agent?: string | null;
  ip?: string | null;
  created_at: number;
}

/**
 * 截断原始 UA：按 Unicode 字符而不是 UTF-16 单元切，避免切出半个表情符号。
 * `max` 包含末尾的省略号。
 */
export function truncateUserAgent(raw: string, max = RAW_UA_MAX_CHARS): string {
  const value = raw.trim();
  if (!value || max <= 0) return "";
  const characters = Array.from(value);
  if (characters.length <= max) return value;
  if (max === 1) return "…";
  return `${characters.slice(0, max - 1).join("")}…`;
}

function browserLabel(userAgent: string): string | null {
  const match = (pattern: RegExp): string | null => {
    const result = pattern.exec(userAgent);
    return result ? result[1] : null;
  };

  // 顺序很重要：Edge / Opera 的 UA 里也包含 Chrome，Safari 的 UA 里也可能有
  // Chrome（iOS 上的 CriOS）；先匹配更具体的那个。
  const edge = match(/Edg(?:e|A|iOS)?\/(\d+)/);
  if (edge) return `Edge ${edge}`;
  const opera = match(/OPR\/(\d+)/);
  if (opera) return `Opera ${opera}`;
  const firefox = match(/(?:Firefox|FxiOS)\/(\d+)/);
  if (firefox) return `Firefox ${firefox}`;
  const chrome = match(/(?:Chrome|CriOS)\/(\d+)/);
  if (chrome) return `Chrome ${chrome}`;
  const safari = match(/Version\/(\d+).*Safari\//);
  if (safari) return `Safari ${safari}`;
  if (/Safari\//.test(userAgent)) return "Safari";
  return null;
}

function osLabel(userAgent: string): string | null {
  // Android 的 UA 里有 Linux，必须先判断。
  if (/Android/.test(userAgent)) return "Android";
  if (/(?:iPhone|iPad|iPod)/.test(userAgent)) return "iOS";
  if (/Windows NT|Windows Phone/.test(userAgent)) return "Windows";
  if (/Mac OS X|Macintosh/.test(userAgent)) return "macOS";
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Linux/.test(userAgent)) return "Linux";
  return null;
}

export interface ParsedUserAgent {
  browser: string | null;
  os: string | null;
}

/** 拆出浏览器与系统；识别失败的部分为 null。 */
export function parseUserAgent(raw: string | null | undefined): ParsedUserAgent {
  const userAgent = (raw ?? "").trim();
  if (!userAgent) return { browser: null, os: null };
  return { browser: browserLabel(userAgent), os: osLabel(userAgent) };
}

/**
 * 列表里显示的设备摘要。
 *
 * - 空 UA → `sessions.unknownDevice`；
 * - 识别出浏览器 → `Chrome 120 · macOS`（系统缺失时只显示浏览器）；
 * - 识别不出浏览器 → 原始 UA 截断（即使识别出了系统，也按「解析失败」处理）。
 */
export function deviceSummary(raw: string | null | undefined): string {
  const { browser, os } = parseUserAgent(raw);
  if (!browser) {
    const fallback = truncateUserAgent(raw ?? "");
    return fallback || t("sessions.unknownDevice");
  }
  return os ? `${browser} · ${os}` : browser;
}

/** 最近活跃时间；老会话没有该字段时回退到创建时间。 */
export function lastSeenAt(session: SessionLike): number {
  return session.last_seen_at ?? session.created_at;
}

/** 相对时间文案；`now` 可注入，测试不依赖系统时钟。 */
export function formatLastSeen(
  session: SessionLike,
  now = Date.now(),
): string {
  return formatRelativeTime(lastSeenAt(session), now);
}

/**
 * 会话排序：当前会话永远第一，其余按最近活跃倒序，最后按创建时间倒序。
 * 不改原数组。
 */
export function sortSessions<T extends SessionLike>(sessions: readonly T[]): T[] {
  return [...sessions].sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    const seen = lastSeenAt(right) - lastSeenAt(left);
    if (seen !== 0) return seen;
    return right.created_at - left.created_at;
  });
}

/** 设备数量文案（中英都通过 i18n 提供单复数）。 */
export function sessionCountText(count: number): string {
  return count === 1
    ? t("sessions.countOne")
    : t("sessions.countMany", { n: count });
}

/** 最近登录行的时间文案；没有 last_seen 概念，统一用 created_at。 */
export function formatLoginTime(
  login: LoginRecordLike,
  now = Date.now(),
): string {
  return formatRelativeTime(login.created_at, now);
}

/** IP 为空时显示占位文案。 */
export function ipLabel(ip: string | null | undefined): string {
  const value = (ip ?? "").trim();
  return value || t("sessions.unknownIp");
}
