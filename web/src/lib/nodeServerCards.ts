/**
 * 节点页服务器卡片的纯逻辑：统计行三态、排序与协议小标。
 *
 * 这些规则不依赖 React / DOM / i18n，`node --test` 可直接覆盖；
 * 页面只负责把结果映射成文案与 token。后端是唯一数据源：
 * `node_count` / `node_enabled_count` / `node_protocols` 都是只读聚合字段。
 */

import type { Server } from "./api";
import { normalizeGroupName } from "./serverGroups.ts";

/** 每张卡片最多展示的协议数；与后端 `NODE_PROTOCOL_LIMIT` 保持一致。 */
export const MAX_PROTOCOL_CHIPS = 4;

/** 统计行三态：没有节点 / 全部启用 / 有停用。 */
export type NodeSummaryState = "empty" | "allEnabled" | "hasDisabled";

export interface NodeSummary {
  total: number;
  enabled: number;
  disabled: number;
  state: NodeSummaryState;
}

type NodeStatFields = Pick<Server, "node_count" | "node_enabled_count">;

/** 计数只接受非负有限数并向下取整；脏数据按 0 处理。 */
function count(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/**
 * 卡片统计行：
 * - `empty`：`total = 0`（后端 `node_count = 0` 或旧后端没有该字段）；
 * - `allEnabled`：有节点且全部启用；
 * - `hasDisabled`：有节点且至少一个停用，`disabled` 永远不超过 `total`。
 */
export function nodeSummary(server: NodeStatFields): NodeSummary {
  const total = count(server.node_count);
  const enabled = Math.min(total, count(server.node_enabled_count));
  const disabled = total - enabled;

  let state: NodeSummaryState = "hasDisabled";
  if (total === 0) state = "empty";
  else if (disabled === 0) state = "allEnabled";

  return { total, enabled, disabled, state };
}

type SortableServer = {
  name: string;
  status: string;
  group_name?: string | null;
};

/**
 * 卡片排序：分组（具名分组按名称，未分组最后）→ 在线优先 → 名称。
 *
 * 名称与分组都用 code point 比较，保证中英文在不同浏览器/测试环境里顺序一致；
 * 完全相同的项保持输入顺序（稳定），输入数组不被修改。
 */
export function sortedServers<T extends SortableServer>(
  servers: readonly T[],
): T[] {
  return servers
    .map((server, index) => ({
      server,
      index,
      group: normalizeGroupName(server.group_name),
      online: server.status === "online",
    }))
    .sort((a, b) => {
      if (a.group !== b.group) {
        if (a.group === null) return 1;
        if (b.group === null) return -1;
        return a.group < b.group ? -1 : 1;
      }
      if (a.online !== b.online) return a.online ? -1 : 1;
      if (a.server.name !== b.server.name) {
        return a.server.name < b.server.name ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map(({ server }) => server);
}

export interface ProtocolChips {
  /** 实际展示的协议（最多 `max` 个，去重、小写）。 */
  protocols: string[];
  /** 被折叠的协议数量；0 表示没有溢出。 */
  overflow: number;
}

/**
 * 协议小标：去重、去空白、转小写，最多展示 `max` 个，其余计入溢出。
 *
 * 后端已按节点数排好序并截断到 4 个；这里仍做防御性去重，
 * 避免旧后端或脏数据画出重复小标。`null` / `undefined` 视为空数组。
 */
export function protocolChips(
  protocols: readonly string[] | null | undefined,
  max: number = MAX_PROTOCOL_CHIPS,
): ProtocolChips {
  const limit = Number.isFinite(max)
    ? Math.max(0, Math.floor(max))
    : MAX_PROTOCOL_CHIPS;
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const item of protocols ?? []) {
    if (typeof item !== "string") continue;
    const protocol = item.trim().toLowerCase();
    if (protocol === "" || seen.has(protocol)) continue;
    seen.add(protocol);
    unique.push(protocol);
  }

  const shown = unique.slice(0, limit);
  return { protocols: shown, overflow: unique.length - shown.length };
}
