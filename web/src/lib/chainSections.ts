/**
 * 「链路时延」tab 内部的三个子页：转发链 / 转发模板 / 转发用量。
 *
 * URL 是子页的唯一来源：`?view=chain&section=chains|templates|usage`。默认的
 * 「转发链」不写 `section` 参数（与 `?view=` 的默认值约定一致），切换用
 * `replace`，避免每切一次子页就往历史里塞一条记录。
 *
 * 子页只写自己的 `section`：`status` / `q` / `series` 是链路列表与趋势图的
 * 参数，切子页时原样保留，反过来改筛选也不会覆盖 `section`。
 *
 * 离开链路时延 tab 时由 `applyOverviewView` 删除 `section`；切到模板 / 用量
 * 子页时同时删掉 `chain` 深链，否则切回转发链会重新弹出刚关闭的详情。
 *
 * 这里只放纯函数，方便 `node:test` 直接覆盖 URL 行为；组件只负责渲染。
 */

export const CHAIN_SECTIONS = ["chains", "templates", "usage"] as const;

export type ChainSection = (typeof CHAIN_SECTIONS)[number];

/** 默认子页：先看每条链的现状，再去看模板，最后是对账用量。 */
export const DEFAULT_CHAIN_SECTION: ChainSection = "chains";

/**
 * 旧独立页 `/forward-usage` 的去处：链路时延的第三个子页。
 * 保留常量给路由与测试共用，避免重定向地址在两处各写一份。
 */
export const CHAIN_USAGE_URL = "/?view=chain&section=usage";

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
