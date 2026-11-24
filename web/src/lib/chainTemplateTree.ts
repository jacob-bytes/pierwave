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
 *
 * 目标折叠按**父节点分组**：同一个父节点下的目标超过 `targetLimit`（默认 8）
 * 时，只留链数最多的 8 个，其余折成**这个父节点自己的** `+N`。早先按全局
 * 排序 slice 再挂到第一个父节点，会让某些父节点变成 0 目标的死端，还会把
 * 别家的目标计入自己的 `+N`。
 *
 * 状态口径与链路详情一致：online / offline / degraded（后端 abnormal、
 * no_data）/ unknown。offline 路径标红且不脉冲；degraded 路径标黄、不脉冲。
 * 不可用路径的边标签固定 `—`，历史 P50 只以 `lastP50Ms`（「最近已知」）
 * 出现，不冒充当前值。
 */

export const CHAIN_TEMPLATE_TARGET_LIMIT = 8;

/** 不可用路径的边标签：不给可能已经过期的 P50 冒充当前值。 */
export const CHAIN_TEMPLATE_UNAVAILABLE_LABEL = "—";

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
  /** 折叠节点：它折叠的是哪个父节点的目标（展开时只展开这一组）。 */
  foldParent?: string;
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
  /** 展开全部目标（不再折叠任何父节点）。 */
  targetsExpanded?: boolean;
  /** 只展开这些父节点下的目标，其余父节点仍折叠。 */
  expandedParents?: ReadonlySet<string>;
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
  /** 折叠节点数量（每个折叠的父节点一个）。 */
  foldCount: number;
  foldTargets: boolean;
  hasOffline: boolean;
  pulseCount: number;
  /** 0 链：拓扑显示空态，不画孤立根节点。 */
  isEmpty: boolean;
  unusedMembers: ChainTemplateUnusedMember[];
}

const STATUS_RANK: Record<ChainTemplateMemberStatus, number> = {
  unknown: 0,
  online: 1,
  degraded: 2,
  offline: 3,
};

/** 取更差的状态；offline > degraded > online > unknown。 */
function worstStatus(
  a: ChainTemplateMemberStatus,
  b: ChainTemplateMemberStatus,
): ChainTemplateMemberStatus {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
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
    meta.status === "degraded" ||
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
    foldParent:
      typeof meta.foldParent === "string" ? meta.foldParent : undefined,
  };
}

function memberNodeId(seq: number, name: string): string {
  return `m:${seq}:${name}`;
}

function targetNodeId(label: string): string {
  return `t:${label}`;
}

function foldNodeId(parentId: string): string {
  return targetNodeId(`__fold__:${parentId}`);
}

/** 去重键：优先 server id，缺失时用名字。 */
function memberIdentity(member: ChainTemplateMember): string {
  const serverId = member.serverId ?? "";
  return serverId !== "" ? serverId : member.name;
}

interface MemberLookup {
  /** `seq::name`（含别名）→ 去重后的成员。 */
  byName: Map<string, ChainTemplateMember>;
  /** `seq::identity` → 成员。 */
  byIdentity: Map<string, ChainTemplateMember>;
}

/**
 * 按 `serverId ?? name` 去重；同一台机器的旧名字作为别名指到同一个成员，
 * 这样边里引用任一名字都能连到同一个节点。
 */
function buildMemberLookup(detail: ChainTemplateDetail): MemberLookup {
  const byName = new Map<string, ChainTemplateMember>();
  const byIdentity = new Map<string, ChainTemplateMember>();
  for (const node of detail.nodes) {
    if (node.role === "target") continue;
    for (const member of node.members) {
      if (member.name === "") continue;
      const identityKey = `${node.seq}::${memberIdentity(member)}`;
      const existing = byIdentity.get(identityKey);
      if (existing === undefined) byIdentity.set(identityKey, member);
      const canonical = existing ?? member;
      if (!byName.has(`${node.seq}::${member.name}`)) {
        byName.set(`${node.seq}::${member.name}`, canonical);
      }
    }
  }
  return { byName, byIdentity };
}

/** 解析边上的成员名 → 去重后的成员 + 稳定键。 */
function resolveMember(
  lookup: MemberLookup,
  seq: number,
  name: string,
): { member: ChainTemplateMember | null; key: string } {
  const member = lookup.byName.get(`${seq}::${name}`) ?? null;
  return {
    member,
    key: `${seq}::${member === null ? name : memberIdentity(member)}`,
  };
}

function dedupeMembers(
  members: readonly ChainTemplateMember[],
): ChainTemplateMember[] {
  const seen = new Set<string>();
  const unique: ChainTemplateMember[] = [];
  for (const member of members) {
    const identity = memberIdentity(member);
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(member);
  }
  return unique;
}

interface MemberDraft {
  id: string;
  /** 去重键 `seq::serverId ?? name`。 */
  key: string;
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
  degraded: boolean;
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

/** 边的 P50：链数加权；全部缺失时 `null`（组件显示 `—`）。 */
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
      degraded: status === "degraded",
    });
    return;
  }
  existing.chains = Math.max(existing.chains, chains);
  existing.users = Math.max(existing.users, users);
  existing.status = worstStatus(existing.status, status);
  existing.offline = existing.status === "offline";
  existing.degraded = existing.status === "degraded";
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

  const lookup = buildMemberLookup(detail);
  const sourceMembers = dedupeMembers(collectSourceMembers(detail));

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
  const rootStatus: ChainTemplateMemberStatus =
    usedSourceMembers.length === 0
      ? "unknown"
      : usedSourceMembers.reduce<ChainTemplateMemberStatus>(
          (status, member) => worstStatus(status, member.status),
          "unknown",
        );
  const rootOffline =
    usedSourceMembers.length > 0 &&
    usedSourceMembers.every((member) => member.status === "offline");
  const rootDegraded =
    !rootOffline && usedSourceMembers.some((member) => member.status === "degraded");
  const rootOnline = usedSourceMembers.some(
    (member) => member.status === "online",
  );
  const resolvedRootStatus: ChainTemplateMemberStatus = rootOffline
    ? "offline"
    : usedSourceMembers.length === 0
      ? "unknown"
      : rootOnline
        ? "online"
        : rootDegraded
          ? "degraded"
          : rootStatus;
  const rootChains =
    usedSourceMembers.length > 0
      ? usedSourceMembers.reduce((sum, member) => sum + member.chains, 0)
      : sumChains(usedEdges.filter((edge) => edge.fromSeq === 0));
  const rootUsers =
    usedSourceMembers.length > 0
      ? usedSourceMembers.reduce((sum, member) => sum + member.users, 0)
      : maxUsers(usedEdges.filter((edge) => edge.fromSeq === 0));

  const drafts = new Map<string, MemberDraft>();
  /** 边的成员名 → 节点 id（别名也指到去重后的节点）。 */
  const draftIdByRef = new Map<string, string>();
  const ensureDraft = (seq: number, name: string): MemberDraft | null => {
    if (seq <= 0 || seq >= targetSeq || name === "") return null;
    const { member, key } = resolveMember(lookup, seq, name);
    const existing = drafts.get(key);
    if (existing !== undefined) {
      draftIdByRef.set(`${seq}::${name}`, existing.id);
      return existing;
    }
    const displayName = member?.name ?? name;
    const draft: MemberDraft = {
      id: memberNodeId(seq, displayName),
      key,
      seq,
      name: displayName,
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
    draftIdByRef.set(`${seq}::${name}`, draft.id);
    draftIdByRef.set(`${seq}::${displayName}`, draft.id);
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

  const draftIdFor = (seq: number, name: string): string =>
    draftIdByRef.get(`${seq}::${name}`) ?? memberNodeId(seq, name);

  const maxHopSeq = [...drafts.values()].reduce(
    (max, draft) => Math.max(max, draft.seq),
    0,
  );
  for (const draft of drafts.values()) {
    draft.incoming = usedEdges.filter(
      (edge) =>
        edge.toSeq === draft.seq &&
        resolveMember(lookup, draft.seq, edge.toMember).key === draft.key,
    );
    draft.primary = pickPrimary(draft.incoming);
    if (draft.primary !== null) {
      draft.parentId =
        draft.primary.fromSeq === 0
          ? "root"
          : draftIdFor(draft.primary.fromSeq, draft.primary.fromMember);
    }
    if (draft.chains <= 0) {
      draft.chains = sumChains(draft.incoming);
    }
    if (draft.users <= 0) {
      draft.users = maxUsers(draft.incoming);
    }
    draft.offline = draft.status === "offline";
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
        degraded: seed.status === "degraded",
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
          : draftIdFor(primary.fromSeq, primary.fromMember);
    seed.offline = seed.status === "offline";
    seed.degraded = seed.status === "degraded";
  }

  /* ---------------- 目标折叠：按父节点分组 ---------------- */
  const seedsByParent = new Map<string, TargetSeed[]>();
  for (const seed of seedsByChain) {
    const group = seedsByParent.get(seed.parentId);
    if (group === undefined) seedsByParent.set(seed.parentId, [seed]);
    else group.push(seed);
  }
  const visibleSeeds: TargetSeed[] = [];
  const folds: { parentId: string; hidden: TargetSeed[] }[] = [];
  for (const [parentId, group] of seedsByParent) {
    const expanded =
      options.targetsExpanded === true ||
      (options.expandedParents?.has(parentId) ?? false);
    if (!expanded && group.length > targetLimit) {
      visibleSeeds.push(...group.slice(0, targetLimit));
      folds.push({
        parentId,
        hidden: group.slice(targetLimit),
      });
    } else {
      visibleSeeds.push(...group);
    }
  }
  const hiddenTargetCount = folds.reduce(
    (sum, fold) => sum + fold.hidden.length,
    0,
  );

  const root: TreeNode = {
    id: "root",
    name: options.labels.root,
    value: rootChains,
    meta: {
      kind: "root",
      seq: 0,
      status: resolvedRootStatus,
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
  for (const fold of folds) {
    const hiddenChains = fold.hidden.reduce((sum, seed) => sum + seed.chains, 0);
    const hiddenUsers = fold.hidden.reduce(
      (max, seed) => Math.max(max, seed.users),
      0,
    );
    const parentStatus =
      fold.parentId === "root"
        ? resolvedRootStatus
        : (memberNodes.get(fold.parentId)?.meta?.status as
            | ChainTemplateMemberStatus
            | undefined) ?? "unknown";
    const foldNode: TreeNode = {
      id: foldNodeId(fold.parentId),
      name: options.labels.targets(fold.hidden.length),
      value: hiddenChains,
      meta: {
        kind: "fold",
        seq: targetSeq,
        status: parentStatus,
        chains: hiddenChains,
        users: hiddenUsers,
        offline: parentStatus === "offline",
        memberKey: `targets-fold:${fold.parentId}`,
        hiddenTargets: fold.hidden.length,
        foldParent: fold.parentId,
      },
    };
    const parent =
      fold.parentId === "root"
        ? root
        : memberNodes.get(fold.parentId) ?? root;
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
  const memberStatusOf = (seq: number, name: string): ChainTemplateMemberStatus =>
    resolveMember(lookup, seq, name).member?.status ?? "unknown";
  const targetStatusByLabel = new Map(
    visibleSeeds.map((seed) => [seed.label, seed.status]),
  );

  interface LinkAccumulator {
    source: string;
    target: string;
    value: number;
    users: number;
    p50: { p50Ms: number | null; chains: number }[];
    unavailable: boolean;
    degraded: boolean;
  }
  const linkMap = new Map<string, LinkAccumulator>();
  for (const edge of usedEdges) {
    const source =
      edge.fromSeq === 0 ? "root" : draftIdFor(edge.fromSeq, edge.fromMember);
    if (!visibleIds.has(source)) continue;
    let target: string | null = null;
    if (edge.toSeq === targetSeq) {
      target = findVisibleTargetId(edge.toMember);
    } else if (edge.toSeq > 0 && edge.toSeq < targetSeq) {
      const id = draftIdFor(edge.toSeq, edge.toMember);
      if (visibleIds.has(id)) target = id;
    }
    if (target === null) continue;
    const fromStatus =
      edge.fromSeq === 0
        ? resolvedRootStatus
        : memberStatusOf(edge.fromSeq, edge.fromMember);
    let toStatus: ChainTemplateMemberStatus;
    if (edge.toSeq === targetSeq) {
      const label = resolveTargetKey(edge.toMember, seeds);
      toStatus = label === null ? "unknown" : targetStatusByLabel.get(label) ?? "unknown";
    } else {
      toStatus = memberStatusOf(edge.toSeq, edge.toMember);
    }
    const unavailable = fromStatus === "offline" || toStatus === "offline";
    const degraded =
      !unavailable && (fromStatus === "degraded" || toStatus === "degraded");
    const key = `${source}->${target}`;
    const existing = linkMap.get(key);
    if (existing === undefined) {
      linkMap.set(key, {
        source,
        target,
        value: Math.max(0, edge.chains),
        users: Math.max(0, edge.users),
        p50: [{ p50Ms: edge.p50Ms, chains: edge.chains }],
        unavailable,
        degraded,
      });
    } else {
      existing.value += Math.max(0, edge.chains);
      existing.users = Math.max(existing.users, edge.users);
      existing.p50.push({ p50Ms: edge.p50Ms, chains: edge.chains });
      existing.unavailable = existing.unavailable || unavailable;
      existing.degraded = existing.degraded || degraded;
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
        users: item.users,
        // 不可用路径不给当前 P50：标签固定 —，历史值只走 lastP50Ms。
        label: item.unavailable
          ? CHAIN_TEMPLATE_UNAVAILABLE_LABEL
          : p50 === null
            ? "—"
            : formatMs(p50),
        lastP50Ms: item.unavailable ? p50 : null,
        unavailable: item.unavailable,
        degraded: item.unavailable ? false : item.degraded,
        pulse: !item.unavailable && !item.degraded && item.value > 0,
      };
    },
  );

  // 每个折叠节点各走一条真实曲线连到自己的父节点。
  for (const fold of folds) {
    const hiddenChains = fold.hidden.reduce((sum, seed) => sum + seed.chains, 0);
    const parentStatus =
      fold.parentId === "root"
        ? resolvedRootStatus
        : (memberNodes.get(fold.parentId)?.meta?.status as
            | ChainTemplateMemberStatus
            | undefined) ?? "unknown";
    const unavailable = parentStatus === "offline";
    links.push({
      id: `link-target-fold-${fold.parentId}`,
      source: fold.parentId,
      target: foldNodeId(fold.parentId),
      value: hiddenChains,
      users: fold.hidden.reduce((max, seed) => Math.max(max, seed.users), 0),
      label: CHAIN_TEMPLATE_UNAVAILABLE_LABEL,
      lastP50Ms: null,
      unavailable,
      degraded: !unavailable && parentStatus === "degraded",
      pulse: false,
    });
  }

  // 目标声明了链数但契约里没有对应边时，补一条回退边，保证离线 / 降级父节点
  // 下的目标路径同样标状态且不脉冲。
  const linkedTargets = new Set(links.map((link) => link.target));
  const draftById = new Map(
    [...drafts.values()].map((draft) => [draft.id, draft]),
  );
  for (const seed of visibleSeeds) {
    const id = targetNodeId(seed.label);
    if (linkedTargets.has(id)) continue;
    const parentStatus =
      seed.parentId === "root"
        ? resolvedRootStatus
        : draftById.get(seed.parentId)?.status ?? "unknown";
    const unavailable = parentStatus === "offline" || seed.offline;
    links.push({
      id: `link-fallback-${id}`,
      source: seed.parentId,
      target: id,
      value: seed.chains,
      users: seed.users,
      label: CHAIN_TEMPLATE_UNAVAILABLE_LABEL,
      lastP50Ms: null,
      unavailable,
      degraded:
        !unavailable && (parentStatus === "degraded" || seed.degraded),
      pulse: !unavailable && seed.chains > 0 && !seed.degraded,
    });
  }

  // 未使用候选只来自契约的 `unused_candidates`；旧主控没有该数组时为空，
  // 不再从 nodes 反推（新契约的 nodes 只含真实链成员）。
  const unusedMembers: ChainTemplateUnusedMember[] = detail.unusedCandidates.map(
    (candidate) => ({
      key: candidate.serverId ?? candidate.name,
      name: candidate.name,
      seq: candidate.seq,
      status: candidate.status,
      chains: 0,
      users: 0,
    }),
  );
  unusedMembers.sort(
    (a, b) => a.seq - b.seq || a.name.localeCompare(b.name),
  );

  const nodeCount =
    1 + drafts.size + visibleSeeds.length + folds.length;
  const isEmpty = usedEdges.length === 0 && seedsByChain.length === 0;
  return {
    data: root,
    links,
    nodeCount,
    usedMemberCount: drafts.size,
    targetCount: seedsByChain.length,
    visibleTargetCount: visibleSeeds.length,
    hiddenTargetCount,
    foldCount: folds.length,
    foldTargets: folds.length > 0,
    hasOffline:
      rootOffline ||
      [...drafts.values()].some((draft) => draft.offline) ||
      visibleSeeds.some((seed) => seed.offline),
    pulseCount: links.filter((link) => link.pulse).length,
    isEmpty,
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
