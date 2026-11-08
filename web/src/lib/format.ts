import { t } from "@/i18n";

export const BYTES_PER_GB = 1024 ** 3;

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

interface FormatBytesOptions {
  /** 空值时的文案，默认「不限」。 */
  unlimitedLabel?: string;
  /** 用户套餐的 quota_override=0 表示显式不限。 */
  zeroAsUnlimited?: boolean;
}

/** 流量统一入口：GB 按 1024³，null 表示不限。 */
export function formatBytes(
  value: number | null | undefined,
  options: FormatBytesOptions = {},
): string {
  const { unlimitedLabel = t("format.unlimited"), zeroAsUnlimited = false } = options;

  if (value === null || value === undefined) return unlimitedLabel;
  if (!Number.isFinite(value)) return "—";
  if (zeroAsUnlimited && value === 0) return unlimitedLabel;

  const negative = value < 0;
  const absolute = Math.abs(value);
  const sign = negative ? "-" : "";

  if (absolute < 1024) {
    return `${sign}${Math.round(absolute)} B`;
  }

  const exponent = Math.min(
    Math.floor(Math.log(absolute) / Math.log(1024)),
    UNITS.length - 1,
  );
  const scaled = absolute / 1024 ** exponent;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const fixed = scaled.toFixed(digits);
  const text = fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;

  return `${sign}${text} ${UNITS[exponent]}`;
}

export function gbToBytes(gb: number): number {
  return Math.round(gb * BYTES_PER_GB);
}

/**
 * 已用 / 总量的一行文字；总量非正数或任一侧缺失时返回 `null`，
 * 页面据此显示「未上报」，而不是把 0 容量算成 0%。
 */
export function formatBytePair(
  used: number | null,
  total: number | null,
): string | null {
  if (
    used === null ||
    total === null ||
    !Number.isFinite(used) ||
    !Number.isFinite(total) ||
    total <= 0
  ) {
    return null;
  }
  return `${formatBytes(used)} / ${formatBytes(total)}`;
}

export function bytesToGb(bytes: number | null | undefined): number | null {
  if (bytes === null || bytes === undefined) return null;
  return bytes / BYTES_PER_GB;
}

/** 表单里的 GB 初始值；null 渲染空串（=不限）。 */
export function bytesToGbInput(bytes: number | null | undefined): string {
  const gb = bytesToGb(bytes);
  if (gb === null) return "";
  return Number.isInteger(gb) ? String(gb) : String(Number(gb.toFixed(2)));
}

/** 空串 → null（不限/沿用），其余转 bytes。调用前应由 zod 校验非负数字。 */
export function parseGbInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return gbToBytes(Number(trimmed));
}

export function usagePercent(
  usedBytes: number,
  quotaBytes: number | null | undefined,
): number | null {
  if (quotaBytes === null || quotaBytes === undefined || quotaBytes <= 0) {
    return null;
  }
  const percent = (usedBytes / quotaBytes) * 100;
  return Math.min(100, Math.max(0, percent));
}
