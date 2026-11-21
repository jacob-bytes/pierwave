/**
 * 「设置 → 常规 → 公开状态页」的纯逻辑。
 *
 * 不依赖 React / DOM / i18n：开关值归一化、白名单摘要、排序与搜索都可以用
 * `node --test` 直接覆盖边界。接口契约里开关是 0/1，但旧后端可能返回
 * boolean 或字符串，前端一律按「只有 1 / true / "1" 才算开」处理。
 */

import type {
  PublicStatus,
  PublicStatusServer,
  PublicStatusServerChoice,
} from "./api.ts";
import { matchesServerQuery } from "./publicStatus.ts";

/** 设置接口里一个开关的原始值；缺失 / null / 未知格式都要能容忍。 */
export type SettingsFlagValue =
  | boolean
  | number
  | string
  | null
  | undefined;

/**
 * 把设置值归一化成 boolean。
 *
 * - `true` / `1` / `"1"` → true，`false` / `0` / `"0"` → false；
 * - 缺失、null、空串、`2` 这类未知值 → `fallback`，不把脏数据猜成开或关。
 */
export function settingsFlag(
  value: SettingsFlagValue,
  fallback: boolean,
): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return fallback;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "1") return true;
    if (trimmed === "0") return false;
  }
  return fallback;
}

/** 提交设置时的取值：契约固定 0/1，不用 boolean 让后端再猜。 */
export function flagSettingValue(enabled: boolean): 0 | 1 {
  return enabled ? 1 : 0;
}

/** 白名单摘要「公开 8 / 共 10 台」的两个数字。 */
export interface PublicVisibilitySummary {
  visible: number;
  total: number;
}

/**
 * 统计公开页白名单：`public_visible === true` 才算公开。
 *
 * 旧后端不返回 `public_visible` 时按「未公开」计数，不把缺失当成公开；
 * 这样摘要与真实公开页一致（公开页只会展示明确标记为公开的节点）。
 */
export function publicVisibilitySummary(
  items: readonly PublicStatusServerChoice[],
): PublicVisibilitySummary {
  let visible = 0;
  for (const item of items) {
    if (item.public_visible === true) visible += 1;
  }
  return { visible, total: items.length };
}

/** 名称排序用的比较器：数字按数值、大小写不敏感，同名时用 id 兜底保持稳定。 */
const nameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/**
 * 按名称升序返回新数组（不修改入参）。
 *
 * 数字段按数值排序（`node-2` 在 `node-10` 前面），大小写不敏感；
 * 同名节点用 id 兜底，避免每次打开对话框顺序都变。
 */
export function sortPublicServerChoices<
  T extends { id: string; name: string },
>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const byName = nameCollator.compare(a.name, b.name);
    if (byName !== 0) return byName;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 搜索只按名称做子串匹配，大小写与首尾空格都不敏感；空查询返回全部。 */
export function filterPublicServerChoices<
  T extends { id: string; name: string },
>(items: readonly T[], query: string): T[] {
  return items.filter((item) => matchesServerQuery(item, query));
}

/**
 * 公开页是否隐藏了价格 / 到期。
 *
 * 契约里 `billing_hidden` 是布尔值；旧后端不返回该字段时按「未隐藏」处理。
 * 只有明确的 `true` 才算隐藏，避免把缺失 / null 误读成隐私状态。
 */
export function billingHidden(fields: {
  billing_hidden?: boolean | null;
}): boolean {
  return fields.billing_hidden === true;
}

/**
 * 把公开接口的顶层 `billing_hidden` 合并到每台服务器上。
 *
 * 后端把「公开到期与价格」实现为一个全局设置，字段放在 `PublicStatus` 顶层；
 * 任务契约又允许每台服务器各带一份。查询层统一成页面只读的形状：
 * 顶层为 true 时给所有服务器打上 `billing_hidden: true`，
 * 顶层缺失 / false 时保留服务器自己的值，两种契约都能工作。
 *
 * 返回新对象、不改入参；顶层未隐藏时直接返回原对象，避免无谓重渲染。
 */
export function withBillingVisibility(status: PublicStatus): PublicStatus {
  if (status.billing_hidden !== true) return status;
  return {
    ...status,
    servers: status.servers.map(
      (server): PublicStatusServer =>
        server.billing_hidden === true
          ? server
          : { ...server, billing_hidden: true },
    ),
  };
}
