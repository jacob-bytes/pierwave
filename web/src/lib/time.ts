import { t } from "../i18n/index.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** 一年按 365 天算：超过就不再用「N 个月前」硬撑，回退绝对时间。 */
const YEAR_MS = 365 * DAY_MS;
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
  // 未来时间（时钟偏差或数据写错）没有「多久以前」可言：按「刚刚」处理。
  // 不能回退绝对时间——19 位时间戳会把「最后在线」列撑爆，而且未来时间本身
  // 就说明这条数据不可信，绝对时间不会让它更可信。
  if (diff < 0) return t("time.justNow");

  if (diff < MINUTE_MS) {
    if (!includeSeconds) return t("time.justNow");
    const seconds = Math.floor(diff / 1_000);
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

  // 30 天到一年之间用「N 个月前」，避免同一列里突然冒出 `2026-07-21`
  // 这样的裸日期；超过一年回退绝对时间（年数多了以后相对时间反而难读）。
  if (diff < YEAR_MS) {
    const months = Math.floor(days / 30);
    return t(months === 1 ? "time.monthAgo" : "time.monthsAgo", {
      n: months,
    });
  }

  return formatAbsoluteTime(unixSeconds);
}

/**
 * Unix 秒 → UTC+8 的 `HH:mm:ss`，用于页头的「更新于」一行。
 *
 * 探针页与参考实现一致，把秒也画出来：数据停住时，读者从秒位就能看出
 * 停在哪一刻，而不是只看到一个模糊的分钟。
 */
export function formatClockTime(
  unixSeconds: number | null | undefined,
): string {
  if (unixSeconds === null || unixSeconds === undefined) return "—";
  const date = toUtc8WallClock(unixSeconds * 1_000);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(
    date.getUTCSeconds(),
  )}`;
}

/**
 * Unix 秒 → UTC+8 的整点小时区间 `03:00–04:00`。
 *
 * 详情页的「最低时段」用它：桶起点就是整点，结束时间固定加一小时；
 * 23:00 的下一段是次日 00:00，只写小时，不跨日期展开。
 */
export function formatHourRange(
  unixSeconds: number | null | undefined,
): string {
  if (unixSeconds === null || unixSeconds === undefined) return "—";
  const start = toUtc8WallClock(unixSeconds * 1_000);
  if (Number.isNaN(start.getTime())) return "—";
  const end = new Date(start.getTime() + 60 * 60 * 1_000);
  return `${pad(start.getUTCHours())}:00–${pad(end.getUTCHours())}:00`;
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
