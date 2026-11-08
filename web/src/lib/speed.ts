/**
 * 限速单位换算：后端一律用 kbps，界面一律用 Mbps。
 *
 * 转换只允许发生在这个文件里：
 * - 表单回填用 `kbpsToMbpsInput`；
 * - 表单提交用 `mbpsInputToKbps`；
 * - 列表展示用 `formatMbps`。
 *
 * 0 / null / undefined 都表示「不限」；节点侧是 tc 精确带宽，套餐侧只能
 * 映射到 Xray 的 `bufferSize`，是近似限速。
 */

export const KBPS_PER_MBPS = 1_000;

/** 后端白名单上限：10 Gbps。 */
export const SPEED_LIMIT_MAX_KBPS = 10_000_000;

/** 界面输入上限：10000 Mbps。 */
export const SPEED_LIMIT_MAX_MBPS = SPEED_LIMIT_MAX_KBPS / KBPS_PER_MBPS;

/** 是否设置了有限速；0 / null / 非有限值都视为不限。 */
export function isSpeedLimited(
  kbps: number | null | undefined,
): kbps is number {
  return typeof kbps === "number" && Number.isFinite(kbps) && kbps > 0;
}

/** kbps → Mbps 数字（不负责 0 / null 的展示语义）。 */
export function kbpsToMbps(kbps: number): number {
  return kbps / KBPS_PER_MBPS;
}

/**
 * 列表徽标用：把 kbps 格式化成 Mbps 文本，去掉无意义的尾随 0。
 * 例如 100000 → "100"、50000 → "50"、1234 → "1.234"。
 */
export function formatMbps(kbps: number | null | undefined): string {
  if (!isSpeedLimited(kbps)) return "";
  return String(Number(kbpsToMbps(kbps).toFixed(3)));
}

/**
 * 表单回填：kbps → Mbps 文本。
 * 0 / null / undefined 返回空串，让输入框保持「不限」的空白状态。
 */
export function kbpsToMbpsInput(kbps: number | null | undefined): string {
  return isSpeedLimited(kbps) ? formatMbps(kbps) : "";
}

/**
 * 表单提交：Mbps 文本 → kbps。
 * 空串 / 0 → 0（后端约定 0 = 不限）；最多保留 1 kbps 精度。
 */
export function mbpsInputToKbps(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;

  const mbps = Number(trimmed);
  if (!Number.isFinite(mbps) || mbps <= 0) return 0;

  return Math.round(mbps * KBPS_PER_MBPS);
}

/**
 * 前端校验：空串合法（不限）；否则必须是 0–10000 之间、最多 3 位小数的数字。
 * 3 位小数正好对应 1 kbps，避免提交时被四舍五入成另一个值。
 */
export function isValidSpeedLimitMbpsInput(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (!/^\d+(\.\d{1,3})?$/.test(trimmed)) return false;

  const mbps = Number(trimmed);
  return (
    Number.isFinite(mbps) && mbps >= 0 && mbps <= SPEED_LIMIT_MAX_MBPS
  );
}
