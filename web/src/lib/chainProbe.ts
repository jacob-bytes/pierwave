/**
 * 转发链可用率 / 丢包近似的纯格式化函数（不依赖 React / i18n）。
 *
 * 口径（与 `docs/TELEMETRY.md` 一致）：
 * * `availability_24h` / `loss_24h` 是 `0..1` 的比例，来自 Agent 的**目标探测**
 *   成功 / 失败次数；
 * * 「丢包」是**探测失败率近似**，不是业务报文丢包率——UI 必须把这个边界
 *   写出来（i18n 里的 `chains.probe.note`）；
 * * `null` = 样本不足（少于主控的最少探测次数）或旧 Agent 没有上报，
 *   必须显示 `—`；`0%` 是「有数据的全失败」，不能和 `—` 混用。
 */

/** 展示用的默认告警阈值；后端会把可配置的阈值随链视图返回。 */
export const DEFAULT_AVAILABILITY_THRESHOLD_PERCENT = 99;

export type AvailabilityTone = "default" | "warning" | "muted";

/** 0..1 → 0..100；非法值返回 `null`（不是 0）。 */
export function availabilityPercent(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value * 100;
}

/** `99.2%` / `100%` / `—`。 */
export function availabilityLabel(value: number | null | undefined): string {
  const percent = availabilityPercent(value);
  if (percent === null) return "—";
  // 整百分比（0 / 100 / 99.0）不显示小数，其余保留 1 位（99.2%），
  // 与链路延迟的数字密度一致。
  const fixed = percent.toFixed(1);
  return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}%`;
}

/** `0.8%` / `0%` / `—`。 */
export function lossLabel(value: number | null | undefined): string {
  const percent = availabilityPercent(value);
  if (percent === null) return "—";
  if (percent === 0) return "0%";
  return `${percent.toFixed(1)}%`;
}

/**
 * 可用率的颜色档位：没有数据 = muted（显示 `—`），低于阈值 = warning。
 *
 * 只用既有的 `--muted-foreground` / `--warning`，不引入新色相。
 */
export function availabilityTone(
  value: number | null | undefined,
  thresholdPercent: number = DEFAULT_AVAILABILITY_THRESHOLD_PERCENT,
): AvailabilityTone {
  const percent = availabilityPercent(value);
  if (percent === null) return "muted";
  const threshold =
    Number.isFinite(thresholdPercent) && thresholdPercent > 0
      ? thresholdPercent
      : DEFAULT_AVAILABILITY_THRESHOLD_PERCENT;
  return percent < threshold ? "warning" : "default";
}

/** 成员行徽标：`99.2%` / `—`，颜色只看链级阈值（缺省 99%）。 */
export interface MemberAvailability {
  label: string;
  tone: AvailabilityTone;
}

export function memberAvailability(
  value: number | null | undefined,
  thresholdPercent: number = DEFAULT_AVAILABILITY_THRESHOLD_PERCENT,
): MemberAvailability {
  return {
    label: availabilityLabel(value),
    tone: availabilityTone(value, thresholdPercent),
  };
}

/**
 * 趋势点的丢包率（0..1）：桶的探测次数为 0 时是 `null`。
 *
 * 与 24h 汇总不同，这里**不套样本门槛**：5 分钟桶天然只有个位数探测，
 * 用 24h 的门槛会把整条趋势清空。
 */
export function bucketLoss(
  attempts: number | null | undefined,
  failures: number | null | undefined,
): number | null {
  if (
    attempts === null ||
    attempts === undefined ||
    failures === null ||
    failures === undefined ||
    !Number.isFinite(attempts) ||
    !Number.isFinite(failures) ||
    attempts <= 0 ||
    failures < 0 ||
    failures > attempts
  ) {
    return null;
  }
  return failures / attempts;
}

/** 探测次数展示：`1.2k` / `—`（0 次也算有数据，显示 `0`）。 */
export function probeAttemptsLabel(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (!Number.isFinite(value) || value < 0) return "—";
  const rounded = Math.round(value);
  if (rounded >= 10_000) return `${Math.round(rounded / 1_000)}k`;
  if (rounded >= 1_000) return `${(rounded / 1_000).toFixed(1)}k`;
  return String(rounded);
}
