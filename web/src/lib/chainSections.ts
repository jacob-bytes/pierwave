/**
 * 「链路时延」tab 内部的两个子页：转发链 / 转发模板。
 *
 * URL 是子页的唯一来源：`?view=chain&section=chains|templates`。默认的
 * 「转发链」不写 `section` 参数（与 `?view=` 的默认值约定一致），切换用
 * `replace`，避免每切一次子页就往历史里塞一条记录。
 *
 * 离开链路时延 tab 时由 `applyOverviewView` 删除 `section`；切到模板子页时
 * 同时删掉 `chain` 深链，否则切回转发链会重新弹出刚关闭的详情。
 *
 * 这里只放纯函数，方便 `node:test` 直接覆盖 URL 行为；组件只负责渲染。
 */

export const CHAIN_SECTIONS = ["chains", "templates"] as const;

export type ChainSection = (typeof CHAIN_SECTIONS)[number];

/** 默认子页：先看每条链的现状，再去看模板。 */
export const DEFAULT_CHAIN_SECTION: ChainSection = "chains";

/** 是否精确命中某个子页 id（大小写敏感，不 trim）。 */
export function isChainSection(value: unknown): value is ChainSection {
  return (
    typeof value === "string" &&
    (CHAIN_SECTIONS as readonly string[]).includes(value)
  );
}

/** 解析 `?section=`；空值、拼错、旧链接都回落到默认子页。 */
export function resolveChainSection(value: unknown): ChainSection {
  return isChainSection(value) ? value : DEFAULT_CHAIN_SECTION;
}

/** 写回 URL 的参数值；默认子页返回 `null`，表示应当删除该参数。 */
export function chainSectionParam(section: ChainSection): string | null {
  return section === DEFAULT_CHAIN_SECTION ? null : section;
}

/**
 * 在现有查询参数上应用一个子页，返回新的 `URLSearchParams`（不改入参）。
 * 其它参数（`view` / `servers` / `range` 等）原样保留。
 */
export function applyChainSection(
  params: URLSearchParams,
  section: ChainSection,
): URLSearchParams {
  const next = new URLSearchParams(params);
  const param = chainSectionParam(section);
  if (param === null) next.delete("section");
  else next.set("section", param);
  if (section !== "chains") next.delete("chain");
  return next;
}
