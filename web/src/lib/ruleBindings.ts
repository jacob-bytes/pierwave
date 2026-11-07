/**
 * P6：规则模板绑定的前端纯逻辑，见 docs/PLAN.md「P6：规则模板绑定到用户 / 套餐」。
 *
 * 表单里用空串表示「没有绑定」（跟随套餐 / 全局默认）。Radix Select 不允许
 * 选项值为空串，所以下拉展示时换成一个固定哨兵；提交时再还原成空串，
 * 最后由 `ruleTemplateInputValue` 变成显式的 `null`。
 *
 * 注意 `null` 与 `undefined` 的语义不同：
 * - `null` = 显式清空绑定，回落到下一级；
 * - `undefined` = 请求里不带该字段，保持原绑定不变（见 `lib/api.ts` 的写接口类型）。
 * 表单永远产出具体值，因此这里只接受字符串，不会把「未改动」误当成「清空」。
 */

/** 下拉里代表「跟随套餐 / 全局默认」的哨兵值；真实模板 id 不会长这样。 */
export const RULE_TEMPLATE_INHERIT = "__inherit__";

/** 表单值（模板 id 或空串）→ Select 的 value。 */
export function ruleTemplateToSelectValue(
  id: string | null | undefined,
): string {
  const trimmed = (id ?? "").trim();
  return trimmed === "" ? RULE_TEMPLATE_INHERIT : trimmed;
}

/** Select 的 value → 表单值：哨兵还原成空串，其余原样返回。 */
export function ruleTemplateFromSelectValue(value: string): string {
  return value === RULE_TEMPLATE_INHERIT ? "" : value;
}

/**
 * 表单值 → 写接口参数：空串必须写成 `null`（显式清空），不能省略字段。
 *
 * 只有「完全没碰这个字段」的场景才应该传 `undefined`，例如列表里的快捷开关；
 * 本函数只服务表单，所以空值统一落到 `null`。
 */
export function ruleTemplateInputValue(
  value: string | null | undefined,
): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}
