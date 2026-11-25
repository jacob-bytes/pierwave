/**
 * 服务器列表「负载 / 内存」合并列的纯展示值。
 *
 * 两列合成一列后，表格里只保留数值：`0.39 / 31%`。格式在这里定死，
 * 组件只负责把 `/` 换成 muted 色，避免 UI 与测试各写一份。
 * 没有数据的维度一律用 `—`（不是 0）：
 * - `load1` 为 null / undefined / 非有限数 / 负数 = Agent 没上报；
 * - 内存缺任一值或 `mem_total <= 0` = 无法算百分比。
 *
 * Pure formatting for the merged "load / memory" table column. Missing
 * dimensions always render `—` (never 0) so the two sides stay distinguishable.
 */

/** 合并列里数值之间的分隔文本；真实空格保证 DOM 文案就是 `0.39 / 31%`。 */
export const LOAD_MEMORY_SEPARATOR = " / ";

export const NO_VALUE = "—";

export interface LoadMemoryDisplay {
  /** 1 分钟平均负载，两位小数；没有数据时 `—`。 */
  load: string;
  /** 内存占用百分比，四舍五入到整数；没有数据时 `—`。 */
  memory: string;
  /** 未取整的内存百分比，用于 title；没有数据时 null。 */
  percent: number | null;
}

/**
 * 内存占用百分比，夹在 0–100。
 *
 * 负数用量按 0 处理（Agent 上报异常时不要把进度条/百分比画成负值）；
 * 总量缺失或为 0 时返回 null，由调用方显示 `—`。
 */
export function memoryPercent(
  memUsed: number | null | undefined,
  memTotal: number | null | undefined,
): number | null {
  if (memUsed === null || memUsed === undefined) return null;
  if (memTotal === null || memTotal === undefined) return null;
  if (!Number.isFinite(memUsed) || !Number.isFinite(memTotal)) return null;
  if (memTotal <= 0) return null;
  return Math.min(100, Math.max(0, (memUsed / memTotal) * 100));
}

/** 负载固定两位小数（`0.39`、`12.00`）；不合法时 `—`。 */
export function loadText(load1: number | null | undefined): string {
  if (load1 === null || load1 === undefined) return NO_VALUE;
  if (!Number.isFinite(load1) || load1 < 0) return NO_VALUE;
  return load1.toFixed(2);
}

export function loadMemoryDisplay(
  load1: number | null | undefined,
  memUsed: number | null | undefined,
  memTotal: number | null | undefined,
): LoadMemoryDisplay {
  const percent = memoryPercent(memUsed, memTotal);
  return {
    load: loadText(load1),
    memory: percent === null ? NO_VALUE : `${Math.round(percent)}%`,
    percent,
  };
}

/** 合并列的完整文案（`0.39 / 31%`），用于测试与 title/读屏。 */
export function formatLoadMemory(
  load1: number | null | undefined,
  memUsed: number | null | undefined,
  memTotal: number | null | undefined,
): string {
  const { load, memory } = loadMemoryDisplay(load1, memUsed, memTotal);
  return `${load}${LOAD_MEMORY_SEPARATOR}${memory}`;
}
