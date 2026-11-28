/**
 * 链路详情「完整链路」的纯逻辑：把 `chainTopologyGraph(chain)` 的组节点
 * 变成模板画布能直接折叠 / 布局的 `TemplateGraph`（无 React / DOM / i18n）。
 *
 * 口径：
 *
 * - 每台成员一张卡（`cf:<列>:<serverId|name>`）；多成员列里实际走的那台
 *   （节点 `server_id`）标 preferred，其余 candidate，且 preferred 排第一，
 *   默认路径不被折叠吃掉；`server_id` 为空时第一台 preferred。
 * - 没有成员（旧契约 / 只有 `member_count`）时整列一张组名卡
 *   （`cf:<列>:__node`），不伪造成员名。
 * - 目标列永远一张空名卡（`cf:<列>:__target`），由渲染层显示「链目标」；
 *   上游是上一列全部卡片，折叠目标组时仍能回到正确的列。
 * - 相邻列全连接（`cfe:<段>:<src>><dst>`），每段一个药丸：时延 / 丢包
 *   / 估算来自该段；缺数据段与「最后一跳不可测」都是虚线 + `—` + 说明，
 *   两者的区别只在 note 文案（无历史数据 vs 不可测量）。
 *
 * `chains` / `users` 恒为 0：链路详情画的是当前这一条链的路径，不聚合
 * 模板的链数；线宽、脉冲因此保持最细、静止，点亮动画由组件的 1s 前进
 * 虚线承担。
 */

import {
  chainLastHopUnmeasurable,
  chainTopologyEdgeEstimated,
  chainTopologyGraph,
  isChainBalancedStrategy,
  type ChainHealthChain,
  type ChainTopologyNode,
} from "./chainHealth.ts";
import {
  chainTemplateMemberStatus,
  type ChainTemplateMemberStatus,
} from "./chainTemplateInsight.ts";
import type {
  TemplateCardTag,
  TemplateGraph,
  TemplateGraphColumn,
  TemplateGraphEdge,
  TemplateGraphMember,
} from "./chainTemplateGraph.ts";

export interface ChainFlowTexts {
  /** 最后一跳不可测量时的完整说明（含原因）。 */
  unmeasurableText: string;
  /** 缺历史数据时的说明（「无历史数据」）。 */
  missingText: string;
}

function cardStatus(status: string | null): ChainTemplateMemberStatus {
  return chainTemplateMemberStatus(status);
}

function card(
  id: string,
  name: string,
  seq: number,
  role: "entry" | "hop" | "target",
  status: ChainTemplateMemberStatus,
  extras: Pick<TemplateGraphMember, "tag" | "group" | "memberCount"> = {},
): TemplateGraphMember {
  return {
    id,
    name,
    seq,
    role,
    status,
    chains: 0,
    users: 0,
    offline: status === "offline",
    degraded: status === "degraded",
    upstreamIds: [],
    ...extras,
  };
}

/**
 * 多成员列的卡片顺序：preferred 排第一，其余保持契约顺序。
 * 返回下标；`-1` 表示没有可判定的首选（只出现在非空 `server_id` 无匹配时）。
 */
function preferredIndex(node: ChainTopologyNode): number {
  if (node.members.length <= 1) return -1;
  const serverId = (node.serverId ?? "").trim();
  if (serverId === "") return 0;
  const index = node.members.findIndex(
    (member) => (member.serverId ?? "").trim() === serverId,
  );
  return index;
}

/** 当前通路成员在该组里的下标；没有命中时为 -1。 */
function activeIndex(node: ChainTopologyNode): number {
  const serverId = (node.activeServerId ?? "").trim();
  if (serverId === "") return -1;
  return node.members.findIndex(
    (member) => (member.serverId ?? "").trim() === serverId,
  );
}

/**
 * 多成员列的卡片顺序：
 * - 有当前通路时把 active 排第一，折叠不会把它吃掉；
 * - 没有 active 时沿用首选排第一（旧行为）；
 * - 轮询等多成员分担策略保持契约顺序：它们没有首选，顺序不该暗示优先级。
 */
function orderedMembers(
  node: ChainTopologyNode,
  role: "entry" | "hop",
): { members: ChainTopologyNode["members"]; active: number; preferred: number } {
  const members = node.members;
  const preferred = preferredIndex(node);
  // 入口列不受新策略影响：仍按代表成员（server_id）排第一。
  const balanced =
    role === "hop" &&
    members.length > 1 &&
    isChainBalancedStrategy(node.strategy);
  if (balanced) return { members, active: -1, preferred };
  const active = role === "hop" ? activeIndex(node) : -1;
  const first = active >= 0 ? active : preferred;
  if (first <= 0) return { members, active, preferred };
  return {
    members: [
      members[first],
      ...members.filter((_, index) => index !== first),
    ],
    active,
    preferred,
  };
}

function columnCards(
  node: ChainTopologyNode,
  role: "entry" | "hop",
): TemplateGraphMember[] {
  const group = node.name;
  const memberCount = node.memberCount;
  if (node.members.length === 0) {
    return [
      card(
        `cf:${node.seq}:__node`,
        node.name,
        node.seq,
        role,
        cardStatus(node.status),
        { group, memberCount },
      ),
    ];
  }
  const ordered = orderedMembers(node, role);
  const multi = ordered.members.length > 1;
  // 轮询 / 哈希 / 加权 / 最少连接：多成员列不出现首选 / 候选，列头写 N 台分担。
  const balanced =
    role === "hop" && multi && isChainBalancedStrategy(node.strategy);
  return ordered.members.map((member, index) => {
    const status = cardStatus(member.status);
    let tag: TemplateCardTag | undefined;
    if (!multi || balanced) {
      tag = undefined;
    } else if (index === 0 && ordered.active >= 0) {
      // 当前通路成员已经排到第一张：它是「当前」，其余是同组候选。
      tag = "active";
    } else if (index === 0 && ordered.preferred >= 0) {
      tag = "preferred";
    } else {
      tag = "candidate";
    }
    return card(
      `cf:${node.seq}:${member.serverId ?? member.name}`,
      member.name,
      node.seq,
      role,
      status,
      { tag, group, memberCount },
    );
  });
}

export function buildChainFlowGraph(
  chain: ChainHealthChain,
  texts: ChainFlowTexts,
): TemplateGraph {
  const topology = chainTopologyGraph(chain);
  const segments = new Map(
    chain.segments.map((segment) => [segment.seq, segment]),
  );
  const lastHopUnmeasurable = chainLastHopUnmeasurable(chain);
  const columns: TemplateGraphColumn[] = [];

  topology.nodes.forEach((node, index) => {
    const isTarget = node.role === "target";
    if (isTarget) {
      const previous = columns[columns.length - 1];
      const upstreamIds =
        previous === undefined
          ? []
          : previous.members.map((member) => member.id);
      const target = card(
        `cf:${node.seq}:__target`,
        "",
        node.seq,
        "target",
        "unknown",
      );
      target.upstreamIds = upstreamIds;
      columns.push({
        seq: node.seq,
        role: "target",
        // 目标列不设 title：列头仍显示「目标」，不把契约里的占位名当组名。
        members: [target],
      });
      return;
    }
    const role = index === 0 ? "entry" : "hop";
    columns.push({
      seq: node.seq,
      role,
      members: columnCards(node, role),
      title: node.name,
      memberCount: node.memberCount,
      // 入口没有「上一跳」；只有中继列带选路策略（旧契约 / 未知值为 null）。
      strategy: role === "hop" ? node.strategy : null,
    });
  });

  const edges: TemplateGraphEdge[] = [];
  for (let index = 0; index < columns.length - 1; index += 1) {
    const from = columns[index];
    const to = columns[index + 1];
    const topologyEdge = topology.edges[index];
    const segment =
      topologyEdge === undefined ? undefined : segments.get(topologyEdge.seq);
    const isLast = index === topology.edges.length - 1;
    const unmeasurable = isLast && lastHopUnmeasurable;
    const missing = unmeasurable
      ? false
      : topologyEdge === undefined || topologyEdge.missing;
    const unavailable = unmeasurable || missing;
    // 「测不了」不是「没数据」：note 只给其一，tooltip 不把两者混在一起。
    const note = unmeasurable
      ? texts.unmeasurableText
      : missing
        ? texts.missingText
        : null;
    const p50Ms = unavailable ? null : (topologyEdge?.p50 ?? null);
    const estimated = chainTopologyEdgeEstimated(
      chain,
      topology.nodes[index],
      topology.nodes[index + 1],
    );
    const lossPct = segment?.lossPct ?? null;
    for (const source of from.members) {
      for (const target of to.members) {
        edges.push({
          id: `cfe:${topologyEdge?.seq ?? index + 1}:${source.id}>${target.id}`,
          source: source.id,
          target: target.id,
          sourceSeq: from.seq,
          targetSeq: to.seq,
          chains: 0,
          users: 0,
          p50Ms,
          lastP50Ms: null,
          unavailable,
          degraded: false,
          lossPct,
          estimated,
          note,
        });
      }
    }
  }

  const targetColumn = columns.find((column) => column.role === "target");
  return {
    hops: Math.max(0, topology.nodes.length - 1),
    targetSeq:
      topology.nodes.length === 0
        ? 0
        : topology.nodes[topology.nodes.length - 1].seq,
    columns,
    edges,
    unused: [],
    usedMemberCount: columns.reduce(
      (sum, column) =>
        sum +
        column.members.filter((member) => member.role !== "target").length,
      0,
    ),
    // 契约口径：目标列固定一张卡。
    targetCount: 1,
    empty: targetColumn === undefined,
  };
}
