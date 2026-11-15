/**
 * 「当前网速」的纯格式化函数（不依赖 React / i18n）。
 *
 * 口径（与 `docs/TELEMETRY.md` 一致）：
 * * 速率单位是**字节/秒**（B/s），由主控用两次心跳的累计字节差 / 时间差算出；
 * * `null` / `undefined` / 负数 / 非有限数 = **没有数据**，返回 `null`，
 *   页面显示 `—`。真实测到的 `0` 是有效数据，显示 `0 B/s`；
 * * 只做展示，不参与计费。
 */

const RATE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/** 拆分后的速率：`value` 是数字（数值优先），`unit` 单独给弱化样式用。 */
export interface RateParts {
  value: string;
  unit: string;
}

/** 1024 进制，去掉多余的小数零：12.00 → 12、1.20 → 1.2。 */
function scaledText(scaled: number): string {
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const fixed = scaled.toFixed(digits);
  return fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
}

/**
 * 字节/秒 → `{ value, unit }`；没有有效数据时返回 `null`。
 *
 * 0 是有效值（确实没有流量），必须显示 `0 B/s`，不能被当成 `—`。
 */
export function rateParts(bps: number | null | undefined): RateParts | null {
  if (bps === null || bps === undefined) return null;
  if (!Number.isFinite(bps) || bps < 0) return null;

  if (bps < 1024) {
    return { value: String(Math.round(bps)), unit: "B/s" };
  }

  const exponent = Math.min(
    Math.floor(Math.log(bps) / Math.log(1024)),
    RATE_UNITS.length - 1,
  );
  const scaled = bps / 1024 ** exponent;
  return {
    value: scaledText(scaled),
    unit: `${RATE_UNITS[exponent]}/s`,
  };
}

/** `12.3 MB/s` / `0 B/s`；没有数据时 `null`（由调用方决定 `—` 的样式）。 */
export function formatRate(bps: number | null | undefined): string | null {
  const parts = rateParts(bps);
  return parts ? `${parts.value} ${parts.unit}` : null;
}

/** 无障碍 / tooltip 文案：`↓ 12.3 MB/s · ↑ 1.2 MB/s`；两侧都没有数据时 `null`。 */
export function formatRatePairText(
  rxBps: number | null | undefined,
  txBps: number | null | undefined,
): string | null {
  const rx = formatRate(rxBps);
  const tx = formatRate(txBps);
  if (rx === null && tx === null) return null;
  return `↓ ${rx ?? "—"} · ↑ ${tx ?? "—"}`;
}
