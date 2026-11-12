import { t } from "../i18n/index.ts";

const MINUTE_MS = 60_000;
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1_000;
const UTC8_OFFSET_SECONDS = 8 * 60 * 60;

/**
 * 把 Unix 毫秒平移到 UTC+8 的「墙上时间」，之后统一用 getUTC* 读取。
 *
 * 业务日（到期、重置、日账本）按 UTC+8 计算，与浏览器所在时区无关；
 * 东京/伦敦的管理员看到和提交的都应该是同一个日期。
 */
function toUtc8WallClock(unixMs: number): Date {
  return new Date(unixMs + UTC8_OFFSET_MS);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatUtc8Date(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function formatUtc8DateTime(date: Date): string {
  return `${formatUtc8Date(date)} ${pad(date.getUTCHours())}:${pad(
    date.getUTCMinutes(),
  )}:${pad(date.getUTCSeconds())}`;
}

/**
 * 后端时间一律 Unix 秒；展示优先相对时间。
 *
 * `includeSeconds` 只给需要看清「刚刚有多久」的成员行用：默认行为不变，
 * 1 分钟内仍是「刚刚」；开启后同一段区间显示 `32 秒前`。
 */
export function formatRelativeTime(
  unixSeconds: number | null | undefined,
  now = Date.now(),
  includeSeconds = false,
): string {
  if (unixSeconds === null || unixSeconds === undefined)
    return t("time.neverOnline");

  const diff = now - unixSeconds * 1_000;
  if (diff < MINUTE_MS) {
    if (!includeSeconds) return t("time.justNow");
    const seconds = Math.max(0, Math.floor(diff / 1_000));
    return t(seconds === 1 ? "time.secondAgo" : "time.secondsAgo", {
      n: seconds,
    });
  }

  const minutes = Math.floor(diff / MINUTE_MS);
  if (minutes < 60)
    return t(minutes === 1 ? "time.minuteAgo" : "time.minutesAgo", {
      n: minutes,
    });

  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return t(hours === 1 ? "time.hourAgo" : "time.hoursAgo", { n: hours });

  const days = Math.floor(hours / 24);
  if (days < 30)
    return t(days === 1 ? "time.dayAgo" : "time.daysAgo", { n: days });

  return toDateInputValue(unixSeconds);
}

/** Unix 秒 → UTC+8 的 `HH:mm`，用于页头的「更新于」一行。 */
export function formatClockTime(
  unixSeconds: number | null | undefined,
): string {
  if (unixSeconds === null || unixSeconds === undefined) return "—";
  const date = toUtc8WallClock(unixSeconds * 1_000);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

/** Unix 秒 → UTC+8 的 `YYYY-MM-DD HH:mm:ss`，用于 hover 绝对时间。 */
export function formatAbsoluteTime(
  unixSeconds: number | null | undefined,
): string {
  if (unixSeconds === null || unixSeconds === undefined)
    return t("time.neverOnline");
  const date = toUtc8WallClock(unixSeconds * 1_000);
  if (Number.isNaN(date.getTime())) return "—";
  return formatUtc8DateTime(date);
}

/** Unix 秒 → UTC+8 的 YYYY-MM-DD；空值返回空串，方便直接作为 input[type=date] 的值。 */
export function toDateInputValue(
  unixSeconds: number | null | undefined,
): string {
  if (unixSeconds === null || unixSeconds === undefined) return "";
  const date = toUtc8WallClock(unixSeconds * 1_000);
  if (Number.isNaN(date.getTime())) return "";
  return formatUtc8Date(date);
}

/** YYYY-MM-DD → 当天 23:59:59（UTC+8）的 Unix 秒；无效日期返回 null。 */
export function dateInputToUnixEndOfDay(value: string): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // setUTCFullYear 避免 Date.UTC 对 0–99 年份的 1900 偏移。
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(23, 59, 59, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(date.getTime() / 1_000) - UTC8_OFFSET_SECONDS;
}

/** 今天（UTC+8）+ N 天的 YYYY-MM-DD。 */
export function dateInputAfterDays(days: number, now = Date.now()): string {
  const date = toUtc8WallClock(now);
  date.setUTCDate(date.getUTCDate() + days);
  return formatUtc8Date(date);
}

/** Unix 秒 → UTC+8 的 YYYY-MM-DD；空值显示「—」。 */
export function formatDate(unixSeconds: number | null | undefined): string {
  return toDateInputValue(unixSeconds) || "—";
}
