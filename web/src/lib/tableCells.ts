/**
 * 表格单元格的对齐约定（见 docs/DESIGN.md「表格行高 40px」与 F2 一致性要求）。
 *
 * - `numeric`：数值 / 流量 / 百分比 / 速率，右对齐并启用等宽数字，
 *   这样不同行的数字末位对齐，扫视时不会跳。
 * - `id`：ID / 地址 / 端口这类需要逐字符比对的列，左对齐 + 等宽。
 * - `text`：默认文案列，不加额外对齐。
 */

/** 数值列单元格：右对齐 + 等宽数字。 */
export const NUMERIC_CELL = "text-right tabular-nums";

/** 数值列表头：与单元格同侧对齐，避免表头与数字错位。 */
export const NUMERIC_HEAD = "text-right tabular-nums";

/** ID / 地址列：左对齐 + 等宽。 */
export const ID_CELL = "text-left font-mono tabular-nums";

export type CellAlign = "text" | "numeric" | "id";

/** 给单元格/表头选对齐类；`text` 返回 undefined，调用方可直接忽略。 */
export function alignClass(align: CellAlign): string | undefined {
  switch (align) {
    case "numeric":
      return NUMERIC_CELL;
    case "id":
      return ID_CELL;
    default:
      return undefined;
  }
}
