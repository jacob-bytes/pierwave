/**
 * 链模板 / 自助建链的纯展示逻辑：不依赖 React / DOM / API 类型。
 *
 * 模板是管理员定义的「形态」，用户只看得到路径与服务器名；这里把组结构
 * 压成一行可读文本（`香港-01 → 日本-02`），供列表与选择器复用。
 *
 * 配额语义复用自助转发的实现（`./myForwards.ts`）：`none` / `available` /
 * `exhausted` 三态与边界完全一致，避免两套口径。
 */

import {
  canCreate,
  entryLabel,
  quotaState,
  type ForwardQuotaLike,
  type QuotaState,
} from "./myForwards.ts";

export type ChainQuotaState = QuotaState;

/** 自助建链的配额判定：与自助转发同语义。 */
export function chainQuotaState(
  quota: ForwardQuotaLike | null | undefined,
): ChainQuotaState {
  return quotaState(quota);
}

/** 只有 `available` 才允许新建链。 */
export function canCreateChain(
  quota: ForwardQuotaLike | null | undefined,
): boolean {
  return canCreate(quota);
}

/** 组里至少有一个可展示的服务器名/id。 */
interface GroupLike {
  seq?: number | null;
  strategy?: string | null;
  servers?: readonly { name?: string | null }[] | null;
  server_ids?: readonly string[] | null;
}

/** 用户链的组（`servers[].server_name`）。 */
interface ChainGroupLike {
  seq?: number | null;
  servers?: readonly { server_name?: string | null }[] | null;
}

function groupLabel(group: GroupLike): string {
  const names = (group.servers ?? [])
    .map((server) => (server.name ?? "").trim())
    .filter(Boolean);
  if (names.length > 0) return names.join(" / ");
  const ids = (group.server_ids ?? [])
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? ids.join(" / ") : "—";
}

/** 按 seq 升序复制：后端已排序，但展示不依赖响应顺序。 */
function ordered<T extends { seq?: number | null }>(groups: readonly T[]): T[] {
  return [...groups].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * 模板的路径文本：`香港-01 → 日本-02`；多成员组用 `/` 分隔候选。
 * `—` 表示模板没有任何组（脏数据），不抛错。
 */
export function templatePath(
  template: { groups?: readonly GroupLike[] | null } | null | undefined,
): string {
  const groups = template?.groups ?? [];
  if (groups.length === 0) return "—";
  return ordered(groups).map(groupLabel).join(" → ");
}

/** 自助链的路径文本：每组按 `server_name` 展示。 */
export function chainPath(
  chain: { groups?: readonly ChainGroupLike[] | null } | null | undefined,
): string {
  const groups = chain?.groups ?? [];
  if (groups.length === 0) return "—";
  return ordered(groups)
    .map((group) => {
      const names = (group.servers ?? [])
        .map((server) => (server.server_name ?? "").trim())
        .filter(Boolean);
      return names.length > 0 ? names.join(" / ") : "—";
    })
    .join(" → ");
}

/** 入口地址：后端已拼好 `地址:端口`；缺失时与自助转发一样展示 `—`。 */
export function chainEntryLabel(
  chain: { entry_address?: string | null } | null | undefined,
): string {
  return entryLabel(chain);
}

/** 模板的服务器总数（组内成员累加）；选择器用它展示规模。 */
export function templateServerCount(
  template: { groups?: readonly GroupLike[] | null } | null | undefined,
): number {
  return (template?.groups ?? []).reduce((sum, group) => {
    const count =
      group.servers?.length ?? group.server_ids?.length ?? 0;
    return sum + count;
  }, 0);
}
