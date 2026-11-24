import { formatMs } from "./chainHealth.ts";
import type { TreeChartLink, TreeNode } from "./treeChart.ts";
import { targetLabel } from "./chainTemplateInsight.ts";
import {
  type ChainTemplateDetail,
  type ChainTemplateEdge,
  type ChainTemplateMember,
  type ChainTemplateMemberStatus,
} from "./chainTemplateInsight.ts";

/**
 * 把「转发链模板」详情转成横向树：
 *
 *   「入口」（聚合根，SOURCE 组）
 *     └─ 第 1 跳成员（edges 里真实 from → to）
 *         └─ 第 2 跳成员
 *             └─ … → 目标 host:port（叶子）
 *
 * 只收 `chains > 0` 的实际路径；DAG 里的汇合 / 分流保留为交叉边，树结构
 * 取每个节点链数最大的入边当主父节点（用于折叠、hover 到根、行布局）。
 * 目标超过 `targetLimit`（默认 8）且未展开时，只留前 8 个叶子并把其余
 * 折叠成「+N 个目标」节点。
 */

export const CHAIN_TEMPLATE_TARGET_LIMIT = 8;

export type ChainTemplateTreeNodeKind = "root" | "member" | "target" | "fold";

export interface ChainTemplateTreeNodeMeta {
  kind: ChainTemplateTreeNodeKind;
  seq: number;
  status: ChainTemplateMemberStatus;
  chains: number;
  users: number;
  offline: boolean;
  /** 成员去重键：优先 server id，缺失时用名字。 */
  memberKey: string;
  /** 折叠节点：被折叠的目标数量。 */
  hiddenTargets?: number;
}

export interface ChainTemplateUnusedMember {
  key: string;
  name: string;
  seq: number;
  status: ChainTemplateMemberStatus;
  chains: number;
  users: number;
}

export interface ChainTemplateTreeLabels {
  /** 聚合根文案，调用方传 i18n。 */
  root: string;
  /** `+N 个目标`。 */
  targets: (count: number) => string;
}

export interface ChainTemplateTreeOptions {
  labels: ChainTemplateTreeLabels;
  targetsExpanded?: boolean;
  targetLimit?: number;
}

export interface ChainTemplateTreeModel {
  data: TreeNode;
  links: TreeChartLink[];
  /** 可见节点数（含根 / 折叠节点，不含被折叠的子树）。 */
  nodeCount: number;
  usedMemberCount: number;
  /** 实际被使用的目标数。 */
  targetCount: number;
  visibleTargetCount: number;
  hiddenTargetCount: number;
  foldTargets: boolean;
  maxEdgeChains: number;
  hasOffline: boolean;
  pulseCount: number;
  unusedMembers: ChainTemplateUnusedMember[];
}

export function chainTemplateTreeNodeMeta(
  node: TreeNode,
): ChainTemplateTreeNodeMeta | null {
  const meta = node.meta;
  if (meta === undefined || typeof meta.kind !== "string") return null;
  const kind = meta.kind;
  if (
    kind !== "root" &&
    kind !== "member" &&
    kind !== "target" &&
    kind !== "fold"
  ) {
    return null;
  }
  const number = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const status =
    meta.status === "online" ||
    meta.status === "offline" ||
    meta.status === "unknown"
      ? meta.status
      : "unknown";
  return {
    kind,
    seq: number(meta.seq),
    status,
    chains: number(meta.chains),
    users: number(meta.users),
    offline: meta.offline === true,
    memberKey: typeof meta.memberKey === "string" ? meta.memberKey : node.name,
    hiddenTargets:
      typeof meta.hiddenTargets === "number" ? meta.hiddenTargets : undefined,
  };
}

function memberNodeId(seq: number, name: string): string {
  return `m:${seq}:${name}`;
}

function targetNodeId(label: string): string {
  return `t:${label}`;
}

function memberKey(seq: number, name: string): string {
  return `${seq}::${name}`;
}

interface MemberDraft {
  id: string;
  seq: number;
  name: string;
  member: ChainTemplateMember | null;
  chains: number;
  users: number;
  status: ChainTemplateMemberStatus;
  offline: boolean;
  incoming: ChainTemplateEdge[];
  primary: ChainTemplateEdge | null;
  parentId: string;
}

interface TargetSeed {
  label: string;
  chains: number;
  users: number;
  status: ChainTemplateMemberStatus;
  incoming: ChainTemplateEdge[];
  parentId: string;
  offline: boolean;
}

function statusOf(member: ChainTemplateMember | null): ChainTemplateMemberStatus {
  return member?.status ?? "unknown";
}

function pickPrimary(
  incoming: readonly ChainTemplateEdge[],
): ChainTemplateEdge | null {
  if (incoming.length === 0) return null;
  return [...incoming].sort(
    (a, b) =>
      b.chains - a.chains ||
      b.fromSeq - a.fromSeq ||
      a.fromMember.localeCompare(b.fromMember),
  )[0];
}

function sumChains(edges: readonly ChainTemplateEdge[]): number {
  return edges.reduce((sum, edge) => sum + Math.max(0, edge.chains), 0);
}

function maxUsers(edges: readonly ChainTemplateEdge[]): number {
  return edges.reduce((max, edge) => Math.max(max, edge.users), 0);
}

/**
 * 边的主路径链数 P50：链数加权；全部缺失时 `null`（组件显示 `—`）。
 */
function weightedP50(
  entries: readonly { p50Ms: number | null; chains: number }[],
): number | null {
  let sum = 0;
  let weight = 0;
  for (const entry of entries) {
    if (entry.p50Ms === null) continue;
    const w = Math.max(1, entry.chains);
    sum += entry.p50Ms * w;
    weight += w;
  }
  return weight > 0 ? Math.round((sum / weight) * 10) / 10 : null;
}

function seedTarget(
  seeds: Map<string, TargetSeed>,
  label: string,
  chains: number,
  users: number,
  status: ChainTemplateMemberStatus,
): void {
  const key = label.trim();
  if (key === "") return;
  const existing = seeds.get(key);
  if (existing === undefined) {
    seeds.set(key, {
      label: key,
      chains: Math.max(0, chains),
      users: Math.max(0, users),
      status,
      incoming: [],
      parentId: "root",
      offline: status === "offline",
    });
    return;
  }
  existing.chains = Math.max(existing.chains, chains);
  existing.users = Math.max(existing.users, users);
  if (status === "offline") existing.status = "offline";
  else if (existing.status === "unknown" && status === "online") {
    existing.status = "online";
  }
}

/**
 * 把边上的 `to.member`（可能是 host:port，也可能只有 host）对到目标标签。
 * 先精确匹配，再按 host 前缀 / 去端口匹配；没有候选时返回边上的原文。
 */
function resolveTargetKey(
  raw: string,
  candidates: ReadonlyMap<string, TargetSeed>,
): string | null {
  const label = raw.trim();
  if (label === "") return null;
  if (candidates.has(label)) return label;
  const lower = label.toLowerCase();
  for (const key of candidates.keys()) {
    if (key.toLowerCase() === lower) return key;
  }
  for (const key of candidates.keys()) {
    const host = key.toLowerCase();
    if (
      host.startsWith(`${lower}:`) ||
      host.startsWith(`[${lower}]:`) ||
      host === lower
    ) {
      return key;
    }
  }
  return null;
}

function collectSourceMembers(
  detail: ChainTemplateDetail,
): ChainTemplateMember[] {
  return detail.nodes.find((node) => node.role === "source")?.members ?? [];
}


/** 按 kind / 链数 / 名字排序子树，纯视觉稳定，不影响布局复杂度。 */
function sortChildren(node: TreeNode): void {
  if (node.children === undefined) return;
  node.children.sort((a, b) => {
    const kindRank = (item: TreeNode): number => {
      const meta = chainTemplateTreeNodeMeta(item);
      if (meta?.kind === "member") return 0;
      if (meta?.kind === "target") return 1;
      if (meta?.kind === "fold") return 2;
      return 0;
    };
    return (
      kindRank(a) - kindRank(b) ||
      (b.value ?? 0) - (a.value ?? 0) ||
      a.name.localeCompare(b.name)
    );
  });
  for (const child of node.children) sortChildren(child);
}

export function chainTemplateTree(
  detail: ChainTemplateDetail,
  options: ChainTemplateTreeOptions,
): ChainTemplateTreeModel {
  const targetLimit = Math.max(
    1,
    Math.floor(options.targetLimit ?? CHAIN_TEMPLATE_TARGET_LIMIT),
  );
  const targetSeq =
    detail.nodes.find((node) => node.role === "target")?.seq ??
    detail.template.hops;
  const usedEdges = detail.edges.filter((edge) => edge.chains > 0);

  const sourceMembers = collectSourceMembers(detail);
  const memberByLevel = new Map<number, Map<string, ChainTemplateMember>>();
  for (const node of detail.nodes) {
    if (node.role === "target") continue;
    let level = memberByLevel.get(node.seq);
    if (level === undefined) {
      level = new Map<string, ChainTemplateMember>();
      memberByLevel.set(node.seq, level);
    }
    for (const member of node.members) {
      if (!level.has(member.name)) level.set(member.name, member);
    }
  }
  const findMember = (
    seq: number,
    name: string,
  ): ChainTemplateMember | null =>
    memberByLevel.get(seq)?.get(name) ?? null;

  const usedSourceNames = new Set(
    usedEdges
      .filter((edge) => edge.fromSeq === 0 && edge.fromMember !== "")
      .map((edge) => edge.fromMember),
  );
  const usedSourceMembers =
    usedSourceNames.size > 0
      ? sourceMembers.filter(
          (member) =>
            usedSourceNames.has(member.name) && member.chains > 0,
        )
      : sourceMembers.filter((member) => member.chains > 0);
  const rootOffline =
    usedSourceMembers.length > 0 &&
    usedSourceMembers.every((member) => member.status === "offline");
  const rootOnline = usedSourceMembers.some(
    (member) => member.status === "online",
  );
  const rootStatus: ChainTemplateMemberStatus = rootOffline
    ? "offline"
    : usedSourceMembers.length === 0
      ? "unknown"
      : rootOnline
        ? "online"
        : "unknown";
  const rootChains =
    usedSourceMembers.length > 0
      ? usedSourceMembers.reduce((sum, member) => sum + member.chains, 0)
      : sumChains(usedEdges.filter((edge) => edge.fromSeq === 0));
  const rootUsers =
    usedSourceMembers.length > 0
      ? usedSourceMembers.reduce((sum, member) => sum + member.users, 0)
      : maxUsers(usedEdges.filter((edge) => edge.fromSeq === 0));

  const drafts = new Map<string, MemberDraft>();
  const ensureDraft = (seq: number, name: string): MemberDraft | null => {
    if (seq <= 0 || seq >= targetSeq || name === "") return null;
    const key = memberKey(seq, name);
    const existing = drafts.get(key);
    if (existing !== undefined) return existing;
    const member = findMember(seq, name);
    const draft: MemberDraft = {
      id: memberNodeId(seq, name),
      seq,
      name,
      member,
      chains: Math.max(0, member?.chains ?? 0),
      users: Math.max(0, member?.users ?? 0),
      status: statusOf(member),
      offline: statusOf(member) === "offline",
      incoming: [],
      primary: null,
      parentId: "root",
    };
    drafts.set(key, draft);
    return draft;
  };
  for (const edge of usedEdges) {
    if (edge.toSeq > 0 && edge.toSeq < targetSeq) {
      ensureDraft(edge.toSeq, edge.toMember);
    }
    if (edge.fromSeq > 0 && edge.fromSeq < targetSeq) {
      ensureDraft(edge.fromSeq, edge.fromMember);
    }
  }

  const maxHopSeq = [...drafts.values()].reduce(
    (max, draft) => Math.max(max, draft.seq),
    0,
  );
  for (const draft of drafts.values()) {
    draft.incoming = usedEdges.filter(
      (edge) => edge.toSeq === draft.seq && edge.toMember === draft.name,
    );
    draft.primary = pickPrimary(draft.incoming);
    if (draft.primary !== null) {
      draft.parentId =
        draft.primary.fromSeq === 0
          ? "root"
          : memberNodeId(draft.primary.fromSeq, draft.primary.fromMember);
    }
    if (draft.chains <= 0) {
      draft.chains = sumChains(draft.incoming);
    }
    if (draft.users <= 0) {
      draft.users = maxUsers(draft.incoming);
    }
  }

  const seeds = new Map<string, TargetSeed>();
  for (const target of detail.targets) {
    seedTarget(
      seeds,
      targetLabel(target),
      target.chains,
      target.users.length,
      "unknown",
    );
  }
  for (const node of detail.nodes) {
    if (node.role !== "target") continue;
    for (const member of node.members) {
      seedTarget(seeds, member.name, member.chains, member.users, member.status);
    }
  }
  const targetIncoming = usedEdges.filter((edge) => edge.toSeq === targetSeq);
  for (const edge of targetIncoming) {
    const raw = edge.toMember.trim();
    let key = resolveTargetKey(edge.toMember, seeds);
    if (key === null) {
      if (raw === "") {
        if (seeds.size !== 1) continue;
        key = [...seeds.keys()][0];
      } else {
        seedTarget(seeds, raw, edge.chains, edge.users, "unknown");
        key = raw;
      }
    }
    const seed = seeds.get(key);
    if (seed !== undefined) seed.incoming.push(edge);
  }
  const seedsByChain = [...seeds.values()]
    .map((seed) => {
      const incomingSum = sumChains(seed.incoming);
      const chains = Math.max(seed.chains, incomingSum);
      return {
        ...seed,
        chains,
        users: Math.max(seed.users, maxUsers(seed.incoming)),
        offline: seed.status === "offline",
      };
    })
    .filter((seed) => seed.chains > 0)
    .sort((a, b) => b.chains - a.chains || a.label.localeCompare(b.label));

  const lastHopDrafts = [...drafts.values()]
    .filter((draft) => draft.seq === maxHopSeq)
    .sort((a, b) => b.chains - a.chains || a.name.localeCompare(b.name));
  const fallbackParent = lastHopDrafts[0]?.id ?? "root";
  for (const seed of seedsByChain) {
    const primary = pickPrimary(seed.incoming);
    seed.parentId =
      primary === null
        ? fallbackParent
        : primary.fromSeq === 0
          ? "root"
          : memberNodeId(primary.fromSeq, primary.fromMember);
    seed.offline = seed.status === "offline";
  }

  const foldTargets =
    options.targetsExpanded !== true && seedsByChain.length > targetLimit;
  const visibleSeeds = foldTargets
    ? seedsByChain.slice(0, targetLimit)
    : seedsByChain;
  const hiddenSeeds = foldTargets ? seedsByChain.slice(targetLimit) : [];

  const root: TreeNode = {
    id: "root",
    name: options.labels.root,
    value: rootChains,
    meta: {
      kind: "root",
      seq: 0,
      status: rootStatus,
      chains: rootChains,
      users: rootUsers,
      offline: rootOffline,
      memberKey: "root",
    },
  };

  const memberNodes = new Map<string, TreeNode>();
  for (const draft of [...drafts.values()].sort(
    (a, b) => a.seq - b.seq || b.chains - a.chains || a.name.localeCompare(b.name),
  )) {
    const node: TreeNode = {
      id: draft.id,
      name: draft.name,
      value: draft.chains,
      meta: {
        kind: "member",
        seq: draft.seq,
        status: draft.status,
        chains: draft.chains,
        users: draft.users,
        offline: draft.offline,
        memberKey: draft.member?.serverId ?? draft.name,
      },
    };
    memberNodes.set(draft.id, node);
    const parent =
      draft.parentId === "root"
        ? root
        : memberNodes.get(draft.parentId) ?? root;
    parent.children ??= [];
    parent.children.push(node);
  }
  for (const seed of visibleSeeds) {
    const node: TreeNode = {
      id: targetNodeId(seed.label),
      name: seed.label,
      value: seed.chains,
      meta: {
        kind: "target",
        seq: targetSeq,
        status: seed.status,
        chains: seed.chains,
        users: seed.users,
        offline: seed.offline,
        memberKey: seed.label,
      },
    };
    const parent =
      seed.parentId === "root"
        ? root
        : memberNodes.get(seed.parentId) ?? root;
    parent.children ??= [];
    parent.children.push(node);
  }
  if (foldTargets && hiddenSeeds.length > 0) {
    const hiddenChains = hiddenSeeds.reduce((sum, seed) => sum + seed.chains, 0);
    const hiddenUsers = hiddenSeeds.reduce(
      (max, seed) => Math.max(max, seed.users),
      0,
    );
    const foldNode: TreeNode = {
      id: targetNodeId("__fold__"),
      name: options.labels.targets(hiddenSeeds.length),
      value: hiddenChains,
      meta: {
        kind: "fold",
        seq: targetSeq,
        status: "unknown",
        chains: hiddenChains,
        users: hiddenUsers,
        offline: false,
        memberKey: "targets-fold",
        hiddenTargets: hiddenSeeds.length,
      },
    };
    const parent =
      hiddenSeeds[0].parentId === "root"
        ? root
        : memberNodes.get(hiddenSeeds[0].parentId) ?? root;
    parent.children ??= [];
    parent.children.push(foldNode);
  }
  sortChildren(root);

  const visibleNodes = collectNodes(root);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));

  const targetIdsByLabel = new Map<string, string>();
  for (const seed of visibleSeeds) {
    targetIdsByLabel.set(seed.label, targetNodeId(seed.label));
  }
  const findVisibleTargetId = (raw: string): string | null => {
    if (raw.trim() === "") {
      return visibleSeeds.length === 1
        ? targetNodeId(visibleSeeds[0].label)
        : null;
    }
    const exact = targetIdsByLabel.get(raw.trim());
    if (exact !== undefined) return exact;
    const lower = raw.trim().toLowerCase();
    for (const [label, id] of targetIdsByLabel) {
      if (
        label.toLowerCase() === lower ||
        label.toLowerCase().startsWith(`${lower}:`) ||
        label.toLowerCase().startsWith(`[${lower}]:`)
      ) {
        return id;
      }
    }
    return null;
  };
  const memberOffline = (seq: number, name: string): boolean =>
    findMember(seq, name)?.status === "offline";
  const targetOfflineByLabel = new Map(
    visibleSeeds.map((seed) => [seed.label, seed.offline]),
  );

  interface LinkAccumulator {
    source: string;
    target: string;
    value: number;
    p50: { p50Ms: number | null; chains: number }[];
    unavailable: boolean;
  }
  const linkMap = new Map<string, LinkAccumulator>();
  for (const edge of usedEdges) {
    const source =
      edge.fromSeq === 0 ? "root" : memberNodeId(edge.fromSeq, edge.fromMember);
    if (!visibleIds.has(source)) continue;
    let target: string | null = null;
    if (edge.toSeq === targetSeq) {
      target = findVisibleTargetId(edge.toMember);
    } else if (edge.toSeq > 0 && edge.toSeq < targetSeq) {
      const id = memberNodeId(edge.toSeq, edge.toMember);
      if (visibleIds.has(id)) target = id;
    }
    if (target === null) continue;
    const fromOffline =
      edge.fromSeq === 0
        ? rootOffline
        : memberOffline(edge.fromSeq, edge.fromMember);
    let toOffline = false;
    if (edge.toSeq === targetSeq) {
      const label = resolveTargetKey(edge.toMember, seeds);
      toOffline =
        label !== null && targetOfflineByLabel.get(label) === true;
    } else {
      toOffline = memberOffline(edge.toSeq, edge.toMember);
    }
    const key = `${source}->${target}`;
    const existing = linkMap.get(key);
    if (existing === undefined) {
      linkMap.set(key, {
        source,
        target,
        value: Math.max(0, edge.chains),
        p50: [{ p50Ms: edge.p50Ms, chains: edge.chains }],
        unavailable: fromOffline || toOffline,
      });
    } else {
      existing.value += Math.max(0, edge.chains);
      existing.p50.push({ p50Ms: edge.p50Ms, chains: edge.chains });
      existing.unavailable = existing.unavailable || fromOffline || toOffline;
    }
  }
  const links: TreeChartLink[] = [...linkMap.values()].map(
    (item, index) => {
      const p50 = weightedP50(item.p50);
      return {
        id: `link-${index}-${item.source}-${item.target}`,
        source: item.source,
        target: item.target,
        value: item.value,
        label: p50 === null ? "—" : formatMs(p50),
        unavailable: item.unavailable,
        pulse: !item.unavailable,
      };
    },
  );

  // 折叠标记也走一条真实曲线：标签保持 `—`，与其它缺失 P50 的边一致。
  if (foldTargets && hiddenSeeds.length > 0) {
    const hiddenChains = hiddenSeeds.reduce((sum, seed) => sum + seed.chains, 0);
    links.push({
      id: "link-target-fold",
      source: hiddenSeeds[0].parentId,
      target: targetNodeId("__fold__"),
      value: hiddenChains,
      label: "—",
      unavailable: false,
      pulse: false,
    });
  }

  // 目标声明了链数但契约里没有对应边时，补一条回退边，保证离线父节点
  // 下的目标路径同样标「不可用」且不脉冲。
  const linkedTargets = new Set(links.map((link) => link.target));
  const draftById = new Map(
    [...drafts.values()].map((draft) => [draft.id, draft]),
  );
  for (const seed of visibleSeeds) {
    const id = targetNodeId(seed.label);
    if (linkedTargets.has(id)) continue;
    const parentOffline =
      seed.parentId === "root"
        ? rootOffline
        : draftById.get(seed.parentId)?.offline === true;
    const unavailable = parentOffline || seed.offline;
    links.push({
      id: `link-fallback-${id}`,
      source: seed.parentId,
      target: id,
      value: seed.chains,
      label: "—",
      unavailable,
      pulse: !unavailable && seed.chains > 0,
    });
  }

  const unusedMembers: ChainTemplateUnusedMember[] = [];
  for (const node of detail.nodes) {
    if (node.role === "target") continue;
    for (const member of node.members) {
      const used =
        node.seq === 0
          ? usedSourceNames.has(member.name) || member.chains > 0
          : drafts.has(memberKey(node.seq, member.name));
      if (used) continue;
      unusedMembers.push({
        key: member.serverId ?? member.name,
        name: member.name,
        seq: node.seq,
        status: member.status,
        chains: member.chains,
        users: member.users,
      });
    }
  }
  unusedMembers.sort(
    (a, b) => a.seq - b.seq || a.name.localeCompare(b.name),
  );

  const maxEdgeChains = Math.max(1, ...links.map((link) => link.value));
  const nodeCount =
    1 +
    drafts.size +
    visibleSeeds.length +
    (foldTargets && hiddenSeeds.length > 0 ? 1 : 0);
  return {
    data: root,
    links,
    nodeCount,
    usedMemberCount: drafts.size,
    targetCount: seedsByChain.length,
    visibleTargetCount: visibleSeeds.length,
    hiddenTargetCount: hiddenSeeds.length,
    foldTargets: foldTargets && hiddenSeeds.length > 0,
    maxEdgeChains,
    hasOffline:
      rootOffline ||
      [...drafts.values()].some((draft) => draft.offline) ||
      visibleSeeds.some((seed) => seed.offline),
    pulseCount: links.filter((link) => link.pulse).length,
    unusedMembers,
  };
}

function collectNodes(root: TreeNode): TreeNode[] {
  const nodes: TreeNode[] = [];
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as TreeNode;
    nodes.push(node);
    for (const child of node.children ?? []) stack.push(child);
  }
  return nodes;
}

export { targetLabel };
