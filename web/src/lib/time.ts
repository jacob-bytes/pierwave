const MINUTE_MS = 60_000;

/** 后端时间一律 Unix 秒；展示优先相对时间。 */
export function formatRelativeTime(
  unixSeconds: number | null | undefined,
  now = Date.now(),
): string {
  if (unixSeconds === null || unixSeconds === undefined) return "从未在线";

  const diff = now - unixSeconds * 1_000;
  if (diff < MINUTE_MS) return "刚刚";

  const minutes = Math.floor(diff / MINUTE_MS);
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;

  return new Date(unixSeconds * 1_000).toLocaleDateString("zh-CN");
}

export function formatAbsoluteTime(
  unixSeconds: number | null | undefined,
): string {
  if (unixSeconds === null || unixSeconds === undefined) return "从未在线";
  return new Date(unixSeconds * 1_000).toLocaleString("zh-CN", {
    hour12: false,
  });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Unix 秒 → 本地 YYYY-MM-DD；空值返回空串，方便直接作为 input[type=date] 的值。 */
export function toDateInputValue(
  unixSeconds: number | null | undefined,
): string {
  if (unixSeconds === null || unixSeconds === undefined) return "";
  const date = new Date(unixSeconds * 1_000);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** YYYY-MM-DD → 当天 23:59:59 的 Unix 秒；无效日期返回 null。 */
export function dateInputToUnixEndOfDay(value: string): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 23, 59, 59);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return Math.floor(date.getTime() / 1_000);
}

/** 今天 + N 天的本地 YYYY-MM-DD。 */
export function dateInputAfterDays(days: number, now = Date.now()): string {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  return toDateInputValue(Math.floor(date.getTime() / 1_000));
}

/** Unix 秒 → 本地 YYYY-MM-DD；空值显示「—」。 */
export function formatDate(unixSeconds: number | null | undefined): string {
  return toDateInputValue(unixSeconds) || "—";
}
