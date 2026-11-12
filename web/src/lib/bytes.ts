/**
 * 字节数值 → 展示文本的纯函数，不依赖 i18n / React。
 *
 * `format.ts::formatBytes` 负责 null（不限）与「0 = 不限」这类业务语义；
 * 这里只格式化一个已知的有限数字，供纯逻辑模块（如链路拓扑）直接复用，
 * 避免 `node --test` 去解析 tsconfig 的 `@/i18n` 别名。
 */
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/** 1024 进制；0 显示 `0 B`，负数带 `-` 前缀。调用方需先保证是有限数。 */
export function formatByteValue(value: number): string {
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
