/**
 * 建链时监听端口的归属规则：纯逻辑，不依赖 React / DOM。
 *
 * 入口组（seq 0）由用户决定监听端口；中间跳（seq ≥ 1）不再让用户规划，
 * 由后端从 20000–29999 的端口池自动分配。表单据此决定是否渲染端口输入，
 * 提交时把中间跳的 `listen_port` 整个去掉，让后端分配。
 *
 * 非法的 seq（负数 / 小数 / NaN）不按「自动」处理：宁可多显示一个端口输入，
 * 也不要把用户明确填过的端口悄悄丢掉。
 */

/** 中间跳（seq ≥ 1）的端口由后端自动分配，用户不可编辑。 */
export function isAutoPortGroup(seq: number): boolean {
  return Number.isInteger(seq) && seq >= 1;
}

/** 端口输入框只在入口组（seq 0）显示；中间跳显示只读值或什么都不显示。 */
export function portFieldVisible(seq: number): boolean {
  return !isAutoPortGroup(seq);
}

export interface PortCarryingMember {
  listen_port?: number;
}

/**
 * 组可以有成员级端口（当前前端的形状），也可以有组级端口
 * （简化契约 `{ seq, server_ids, strategy, listen_port? }`）。
 * 两种形状的自动组都要把端口去掉。
 */
export interface PortCarryingGroup {
  seq: number;
  listen_port?: number;
  members?: readonly PortCarryingMember[];
}

export type StrippedPortGroup<G> = G extends {
  members: readonly (infer M)[];
}
  ? Omit<G, "members" | "listen_port"> & {
      members: Omit<M, "listen_port">[];
    }
  : Omit<G, "listen_port">;

/**
 * 去掉自动分配组的监听端口，入口组与非法 seq 原样保留。
 *
 * - 成员级 `members[].listen_port`（当前前端提交形状）；
 * - 组级 `listen_port`（简化契约形状）。
 *
 * 返回新数组与新对象，不修改入参；组 / 成员的其它字段（name、strategy、
 * server_ids、server_id、priority …）全部保留。
 */
export function stripAutoPorts<G extends PortCarryingGroup>(
  groups: readonly G[],
): StrippedPortGroup<G>[] {
  return groups.map((group) => {
    if (!isAutoPortGroup(group.seq)) {
      return group as unknown as StrippedPortGroup<G>;
    }

    const copy = { ...group } as unknown as Record<string, unknown>;
    delete copy.listen_port;

    if (Array.isArray(group.members)) {
      copy.members = group.members.map((member) => {
        const stripped = { ...member };
        delete (stripped as PortCarryingMember).listen_port;
        return stripped;
      });
    }

    return copy as unknown as StrippedPortGroup<G>;
  });
}
