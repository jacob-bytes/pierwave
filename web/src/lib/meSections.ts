/**
 * 用户端「我的」四个独立路由：纯逻辑放在这里，方便单测（四个页面都是
 * 懒加载入口，不便在 node:test 里挂载 React）。
 *
 * 路由约定：
 *   /me                概览
 *   /me/subscription   我的订阅
 *   /me/forwards       我的转发
 *   /me/packages       套餐
 *
 * 为什么不用前缀匹配：`/me` 是后三个路径的前缀，前缀匹配会把
 * `/me/subscription` 误判成概览。这里按完整路径精确比对（只忽略末尾 `/`）。
 */

export const ME_SECTION_IDS = [
  "overview",
  "subscription",
  "forwards",
  "packages",
] as const;

export type MeSectionId = (typeof ME_SECTION_IDS)[number];

export interface MeSection {
  id: MeSectionId;
  /** 独立路由；可直接收藏/刷新，标签切换走 `<Link>`。 */
  path: string;
  /** 顶部标签文案键。 */
  labelKey: string;
  /** 页面标题 / 面包屑文案键。 */
  titleKey: string;
}

/**
 * 顺序即顶部标签顺序；`/me` 必须排第一（普通用户登录后的落地页）。
 */
const SECTIONS: readonly MeSection[] = Object.freeze([
  {
    id: "overview",
    path: "/me",
    labelKey: "me.tabs.overview",
    titleKey: "me.pages.overview.title",
  },
  {
    id: "subscription",
    path: "/me/subscription",
    labelKey: "me.tabs.subscription",
    titleKey: "me.pages.subscription.title",
  },
  {
    id: "forwards",
    path: "/me/forwards",
    labelKey: "me.tabs.forwards",
    titleKey: "me.pages.forwards.title",
  },
  {
    id: "packages",
    path: "/me/packages",
    labelKey: "me.tabs.packages",
    titleKey: "me.pages.packages.title",
  },
]);

/** 四个入口的唯一来源；返回值冻结，调用方不要就地修改。 */
export function meSections(): readonly MeSection[] {
  return SECTIONS;
}

/** 去掉末尾斜杠：`/me/` 与 `/me` 视为同一节，`/` 保持根路径。 */
function normalizePath(pathname: string): string {
  if (!pathname) return "";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * 当前 pathname 命中的入口；未知路径返回 `null`（四个标签都不点亮），
 * 而不是回落到概览——`/me/unknown` 由路由表重定向，标签不该先亮错一个。
 */
export function activeSection(pathname: string): MeSection | null {
  const normalized = normalizePath(pathname);
  return SECTIONS.find((section) => section.path === normalized) ?? null;
}

/** 页面标题的 i18n 键；未知 id 回落到概览，保证标题永远有值。 */
export function sectionTitleKey(id: MeSectionId): string {
  return (
    SECTIONS.find((section) => section.id === id)?.titleKey ??
    SECTIONS[0].titleKey
  );
}
