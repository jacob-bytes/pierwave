/**
 * 「当前网速」的纯格式化函数（不依赖 React / i18n）。
 *
 * 口径（与 `docs/TELEMETRY.md` 一致）：
 * * 速率单位是**字节/秒**（B/s），由主控用两次心跳的累计字节差 / 时间差算出；
 * * `null` / `undefined` / 负数 / 非有限数 = **没有数据**，返回 `null`，
 *   页面显示 `—`。真实测到的 `0` 是有效数据，显示 `0 B/s`；
 * * 只做展示，不参与计费。
 */

import { formatByteValue } from "./bytes.ts";

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

/** 展示用的单位下标：比 1024 小一档时用 B，其余按 1024 的幂。 */
function unitExponent(bps: number): number {
  return Math.min(
    Math.floor(Math.log(bps) / Math.log(1024)),
    RATE_UNITS.length - 1,
  );
}

/**
 * 字节/秒 → `{ value, unit }`；没有有效数据时返回 `null`。
 *
 * 三条边界：
 * - **0 是有效值**（确实没有流量），显示 `0 B/s`，不能被当成 `—`；
 * - **非零但不足 1 B/s** 显示 `<1 B/s`，不能四舍五入成 `0 B/s`；
 * - **舍入后达到 1024 要再进位**：`1024^4 - 1` 先缩放到 GB 再舍入会得到
 *   `1024 GB/s`，必须再升一级成 `1 TB/s`。
 */
export function rateParts(bps: number | null | undefined): RateParts | null {
  if (bps === null || bps === undefined) return null;
  if (!Number.isFinite(bps) || bps < 0) return null;

  if (bps === 0) return { value: "0", unit: "B/s" };
  if (bps < 1) return { value: "<1", unit: "B/s" };

  if (bps < 1024) {
    return { value: String(Math.round(bps)), unit: "B/s" };
  }

  let exponent = unitExponent(bps);
  let value = scaledText(bps / 1024 ** exponent);

  // 先缩放再四舍五入可能刚好顶到 1024（例如 1024^4 - 1 → 1024 GB/s）；
  // 再检查一次，能升一级就升，不能升（已是 PB）则保留。
  if (Number(value) >= 1024 && exponent < RATE_UNITS.length - 1) {
    exponent += 1;
    value = scaledText(bps / 1024 ** exponent);
  }

  return { value, unit: `${RATE_UNITS[exponent]}/s` };
}

/** `12.3 MB/s` / `<1 B/s` / `0 B/s`；没有数据时 `null`。 */
export function formatRate(bps: number | null | undefined): string | null {
  const parts = rateParts(bps);
  return parts ? `${parts.value} ${parts.unit}` : null;
}

/**
 * tooltip / 读屏用的精确读数。
 *
 * 大数字会把 `0.4 B/s` 压成 `<1 B/s`（为了让「非零」在 24px 的图里也有意义），
 * 但悬停读数不应该跟着丢掉精度：小于 1 B/s 时保留最多 3 位有效数字。
 * 其余量级沿用展示格式，保证 tooltip 与大数字量级一致。
 */
export function formatRateExact(bps: number | null | undefined): string | null {
  if (bps === null || bps === undefined) return null;
  if (!Number.isFinite(bps) || bps < 0) return null;
  if (bps === 0) return "0 B/s";
  if (bps < 1) {
    // 用最短往返表示而不是四舍五入：0.9999 不能变成 1 B/s。
    return `${bps} B/s`;
  }
  return formatRate(bps);
}

/** 紧凑双行速率的拆解：两方向共用同一个 `unit`，单位放进 label。 */
export interface CompactRatePair {
  /** 下行数值（不带单位）；没有读数为 null。 */
  rx: string | null;
  /** 上行数值（不带单位）；没有读数为 null。 */
  tx: string | null;
  /** 两方向共用的单位，如 `MB/s`；两侧都没有数据时为 null。 */
  unit: string | null;
}

/**
 * 详情页 ① 的紧凑速率：`↓17.5 · ↑2.19`，单位统一提到 label 里。
 *
 * 两个方向的量级可能差一档（900 KB/s 与 2 MB/s）。如果各用各的单位，
 * label 里只能写一个，另一个数字就会被读错；所以先按**较大的方向**选单位，
 * 再把两个方向都换算过去。规则与 `rateParts` 一致：0 是有效值、非零但
 * 不足 1 B/s 显示 `<1`、舍入顶到 1024 时进位。任一侧缺失就保持 null，
 * 不拿 0 冒充；两侧都缺失时整组返回 null，由调用方渲染 `—`。
 */
export function compactRatePair(
  rxBps: number | null | undefined,
  txBps: number | null | undefined,
): CompactRatePair | null {
  const valid = (value: number | null | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const rx = valid(rxBps);
  const tx = valid(txBps);
  if (rx === null && tx === null) return null;

  const largest = Math.max(rx ?? 0, tx ?? 0);
  let exponent = 0;
  if (largest >= 1024) {
    exponent = unitExponent(largest);
    // 与 `rateParts` 相同的进位保护：缩放后再舍入可能刚好顶到 1024。
    const scaled = scaledText(largest / 1024 ** exponent);
    if (Number(scaled) >= 1024 && exponent < RATE_UNITS.length - 1) {
      exponent += 1;
    }
  }

  const format = (bps: number | null): string | null => {
    if (bps === null) return null;
    if (exponent === 0) {
      if (bps === 0) return "0";
      if (bps < 1) return "<1";
      return String(Math.round(bps));
    }
    const scaled = bps / 1024 ** exponent;
    if (scaled > 0 && scaled < 0.01) return "<0.01";
    return scaledText(scaled);
  };

  return {
    rx: format(rx),
    tx: format(tx),
    unit: `${RATE_UNITS[exponent]}/s`,
  };
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

/**
 * 累计字节 → 展示文本（`1.48 GB`）；`null` / 负数 / 非有限值是「没有数据」，
 * 返回 `null` 由调用方渲染 `—`。真实测到的 `0 B` 是有效数据。
 *
 * 注意：这是 Agent 自开机以来的网卡累计值，服务器重启会归零；
 * UI 用「累计流量 / 自开机以来」说明边界，不说成「总流量」。
 */
export function formatTrafficTotal(
  bytes: number | null | undefined,
): string | null {
  if (bytes === null || bytes === undefined) return null;
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return formatByteValue(bytes);
}
