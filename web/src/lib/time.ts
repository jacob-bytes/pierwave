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
