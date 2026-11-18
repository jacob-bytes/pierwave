/**
 * 表单必填项收敛：提交按钮禁用时只列出缺失字段名，不写额外解释文案。
 *
 * 之所以单独抽出来：`ServerFormDialog` 这类手写表单没有 react-hook-form 的
 * 字段状态，禁用按钮与「缺什么」必须由同一份数据推导，避免两处判断漂移。
 */

export type RequiredFieldInput = {
  /** 字段展示名（已翻译）。 */
  label: string;
  /** 当前值；`null` / `undefined` 视为空。 */
  value: string | null | undefined;
};

/** 返回仍需填写的字段名，顺序与传入顺序一致；全填了返回空数组。 */
export function missingRequiredLabels(
  fields: readonly RequiredFieldInput[],
): string[] {
  return fields
    .filter((field) => !(field.value ?? "").trim())
    .map((field) => field.label);
}
