/**
 * 概览页新增两张卡（节点流量 Top 5 / 套餐用量分布）的纯逻辑。
 *
 * 后端已按流量降序并限制 5 条；这里再做一次防御：丢掉空 id / 非正流量、
 * 重排、截断。0 流量不会为了凑数保留（空数组时卡片显示空态）。
 */
import type { OverviewPackageSplit, OverviewTopNode } from "./api.ts";
import { formatShare } from "./overview.ts";

function bytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function limitOf(limit: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
}

/** 节点流量 Top：缺 id / 缺名称 / 非正流量的行丢弃，按流量降序截断。 */
export function topNodeRows(
  nodes: readonly OverviewTopNode[] | null | undefined,
  limit = 5,
): OverviewTopNode[] {
  const max = limitOf(limit);
  if (!nodes?.length || max === 0) return [];

  return nodes
    .filter(
      (node) =>
        typeof node.node_id === "string" &&
        node.node_id.trim() !== "" &&
        typeof node.name === "string" &&
        node.name.trim() !== "" &&
        bytes(node.traffic_7d) > 0,
    )
    .map((node, index) => ({ node, index }))
    .sort(
      (a, b) =>
        bytes(b.node.traffic_7d) - bytes(a.node.traffic_7d) ||
        a.index - b.index,
    )
    .slice(0, max)
    .map(({ node }) => node);
}

/** 节点行的第二行：协议 · 服务器名；缺失字段用 `—`，不显示空串。 */
export function topNodeMeta(
  node: Pick<OverviewTopNode, "protocol" | "server_name">,
): string {
  const protocol = node.protocol?.trim() || "—";
  const server = node.server_name?.trim() || "—";
  return `${protocol} · ${server}`;
}

/** 套餐用量分布：只保留有流量且用户数 > 0 的套餐，按流量降序截断。 */
export function packageSplitRows(
  rows: readonly OverviewPackageSplit[] | null | undefined,
  limit = 5,
): OverviewPackageSplit[] {
  const max = limitOf(limit);
  if (!rows?.length || max === 0) return [];

  return rows
    .filter(
      (row) =>
        typeof row.package_id === "string" &&
        row.package_id.trim() !== "" &&
        typeof row.name === "string" &&
        row.name.trim() !== "" &&
        Number.isFinite(row.users) &&
        row.users > 0 &&
        bytes(row.traffic_7d) > 0,
    )
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        bytes(b.row.traffic_7d) - bytes(a.row.traffic_7d) ||
        a.index - b.index,
    )
    .slice(0, max)
    .map(({ row }) => row);
}

/** 套餐分布条的合计流量；空列表为 0。 */
export function packageTotal(
  rows: readonly OverviewPackageSplit[] | null | undefined,
): number {
  return (rows ?? []).reduce((sum, row) => sum + bytes(row.traffic_7d), 0);
}

/** 单个套餐占分布条的百分比（0–100），边界值沿用 `formatShare`。 */
export function packageShare(
  traffic: number,
  total: number,
): number {
  return formatShare(bytes(traffic), bytes(total));
}

/** 套餐行尾的用户数文案用的安全值：非法 / 负数按 0。 */
export function packageUsers(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
