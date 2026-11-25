import { formatByteValue } from "./bytes.ts";

/**
 * 图表坐标轴的纯逻辑：整齐步长、1024 进位字节轴、时间轴刻度。
 *
 * 只依赖 `./bytes.ts`（同为无 i18n / React 的纯函数），
 * 以便 `node --test` 直接覆盖，不解析 tsconfig 的 `@/` 别名。
 */

/** 「整齐」步长候选：1 / 2 / 2.5 / 5 × 10^n。 */
export const NICE_STEPS = [1, 2, 2.5, 5] as const;

/** 字节轴的进位基数：B / KB / MB / GB / TB / PB 都按 1024。 */
export const BYTE_BASE = 1024;

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;
/** 业务时区固定 UTC+8，与热力图 / 链路趋势的时间轴一致。 */
const UTC8_OFFSET_SECONDS = 8 * HOUR_SECONDS;

function roundMagnitude(value: number): number {
  // 去掉 2.5000000000000004 / 0.30000000000000004 这类浮点尾巴。
  return Number(value.toPrecision(12));
}

/**
 * 向上取到最近的整齐步长（1 / 2 / 2.5 / 5 × 10^n）。
 *
 * 例：11.65 → 20，3 → 5，0.25 → 0.25。0 / 负数 / 非有限数返回 0，
 * 调用方据此保留 0 基线，不把 NaN 传进 recharts。
 */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const exponent = Math.floor(Math.log10(raw));
  const magnitude = 10 ** exponent;
  const normalized = raw / magnitude;
  for (const candidate of NICE_STEPS) {
    // 1e-9 容差：normalized 是 2.0000000000000004 时仍应命中 2。
    if (normalized <= candidate * (1 + 1e-9)) {
      return roundMagnitude(candidate * magnitude);
    }
  }
  return roundMagnitude(10 * magnitude);
}

export interface AxisScale {
  /** 坐标轴上界，一定 ≥ dataMax。 */
  max: number;
  /** 相邻刻度的步长。 */
  step: number;
  /** 从 0 到 max 的刻度值（含两端）。 */
  ticks: number[];
}

function emptyScale(): AxisScale {
  return { max: 1, step: 1, ticks: [0, 1] };
}

function byteExponent(value: number): number {
  const exponent = Math.floor(Math.log(value) / Math.log(BYTE_BASE));
  return Math.min(BYTE_UNITS.length - 1, Math.max(0, exponent));
}

/**
 * 字节量（流量 / 协议）的 y 轴：步长先在当前 1024 单位内取整齐值，
 * 再换算回字节，因此刻度标签落到 B / KB / MB / GB / TB 上时
 * 是整数或一位小数，不会出现 46.6 GB / 93.1 GB 这种比例刻度。
 *
 * 若取整后的上界在「单位内」超过 1024，会进位到下一单位重新取步长，
 * 避免出现 1000+ MB 这种别扭的顶刻度。
 */
export function byteAxisScale(dataMax: number, targetTicks = 4): AxisScale {
  if (!Number.isFinite(dataMax) || dataMax <= 0) return emptyScale();

  let exponent = byteExponent(dataMax);
  let unitStep = 1;
  let maxUnit = 1;

  for (let attempt = 0; attempt < BYTE_UNITS.length; attempt += 1) {
    const unitValue = dataMax / BYTE_BASE ** exponent;
    const rawStep = unitValue / Math.max(1, targetTicks);
    // 单位内的步长至少是 1，保证刻度是整数或一位小数。
    unitStep = Math.max(1, niceStep(rawStep));
    maxUnit = Math.ceil(unitValue / unitStep - 1e-9) * unitStep;
    if (maxUnit < BYTE_BASE || exponent === BYTE_UNITS.length - 1) break;
    exponent += 1;
  }

  const unitBytes = BYTE_BASE ** exponent;
  const step = Math.round(unitStep * unitBytes);
  const intervals = Math.max(1, Math.round(maxUnit / unitStep));
  const ticks = Array.from({ length: intervals + 1 }, (_, index) =>
    Math.round(index * step),
  );
  return { max: ticks[ticks.length - 1], step, ticks };
}

/**
 * 字节轴刻度的标签：0 不带单位（避免和 GB 刻度混排成「0 B」），
 * 其余按 1024 进位，最多一位小数。
 */
export function formatByteAxisTick(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  return formatByteValue(value);
}

/** 时间轴刻度：`ts` 为 x 轴数值，`label` 已按窗口长度选好日期或时刻。 */
export interface TimeAxisTick {
  ts: number;
  label: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function utc8Date(ts: number): Date {
  return new Date((ts + UTC8_OFFSET_SECONDS) * 1_000);
}

function clockLabel(ts: number): string {
  const date = utc8Date(ts);
  return `${pad2(date.getUTCHours())}:00`;
}

function monthDayLabel(ts: number): string {
  const date = utc8Date(ts);
  return `${pad2(date.getUTCMonth() + 1)}/${pad2(date.getUTCDate())}`;
}

/**
 * 小时桶时间序列的 x 轴刻度。
 *
 * - 窗口 ≤ 24h：每 6 小时一个时刻刻度（`HH:00`），重复的钟点只保留一次；
 * - 窗口 > 24h：每天一个 UTC+8 零点刻度（`M/D`），不再对
 *   `MM/DD HH:00` 做 `slice(0, 5)`，避免「11/18 11/18」这种重复标签。
 *
 * 刻度一定落在窗口内且严格递增；零点刻度不会落在最右端（避免标签被裁切）。
 * 只有一个点或窗口非法时不画刻度。
 */
export function timeAxisTicks(startTs: number, endTs: number): TimeAxisTick[] {
  if (
    !Number.isFinite(startTs) ||
    !Number.isFinite(endTs) ||
    endTs <= startTs
  ) {
    return [];
  }

  const span = endTs - startTs;
  const ticks: TimeAxisTick[] = [];
  const labels = new Set<string>();

  if (span <= DAY_SECONDS) {
    const interval = 6 * HOUR_SECONDS;
    for (let ts = startTs; ts < endTs; ts += interval) {
      const label = clockLabel(ts);
      if (labels.has(label)) continue;
      labels.add(label);
      ticks.push({ ts, label });
    }
    return ticks;
  }

  const firstMidnight =
    Math.ceil((startTs + UTC8_OFFSET_SECONDS) / DAY_SECONDS) * DAY_SECONDS -
    UTC8_OFFSET_SECONDS;
  // 严格小于右端：零点刻度正好落在 dataMax 时，居中的日期标签会被
  // svg 右边缘裁掉；少一个刻度比半个标签更好读。
  for (let ts = firstMidnight; ts < endTs; ts += DAY_SECONDS) {
    const label = monthDayLabel(ts);
    if (labels.has(label)) continue;
    labels.add(label);
    ticks.push({ ts, label });
  }
  return ticks;
}
