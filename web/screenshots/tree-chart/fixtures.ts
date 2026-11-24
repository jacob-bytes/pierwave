import { normalizeChainTemplateDetail } from "@/lib/chainTemplateInsight";

function member(name: string, chains: number, users: number, status = "online") {
  return { server_id: name, name, status, chains, users };
}

function edge(
  fromSeq: number,
  fromMember: string,
  toSeq: number,
  toMember: string,
  chains: number,
  p50: number | null = 20,
  users = 1,
) {
  return {
    seq: toSeq,
    from: { seq: fromSeq, member: fromMember },
    to: { seq: toSeq, member: toMember },
    chains,
    users,
    p50_ms: p50,
    loss_pct: 0,
  };
}

function target(host: string, port: number, chains: number) {
  return {
    host,
    port,
    chains,
    users: [{ id: "u1", name: "demo", chains }],
  };
}

const single = {
  template: { id: "single", name: "单跳直出", hops: 1 },
  nodes: [
    {
      seq: 0,
      role: "source",
      name: "入口",
      members: [member("香港-01", 3, 2), member("香港-02", 2, 1)],
    },
    {
      seq: 1,
      role: "hop",
      name: "东京",
      members: [member("东京-01", 3, 2), member("东京-02", 2, 1)],
    },
    {
      seq: 2,
      role: "target",
      name: "目标",
      members: [
        { name: "1.2.3.4:443", chains: 2, users: 2 },
        { name: "5.6.7.8:8443", chains: 1, users: 1 },
        { name: "[2001:db8::1]:443", chains: 2, users: 1 },
      ],
    },
  ],
  edges: [
    edge(0, "香港-01", 1, "东京-01", 3, 12),
    edge(0, "香港-02", 1, "东京-02", 2, 18),
    edge(1, "东京-01", 2, "1.2.3.4:443", 2, 46),
    edge(1, "东京-01", 2, "5.6.7.8:8443", 1, null),
    edge(1, "东京-02", 2, "[2001:db8::1]:443", 2, 62),
  ],
  targets: [
    target("1.2.3.4", 443, 2),
    target("5.6.7.8", 8443, 1),
    target("2001:db8::1", 443, 2),
  ],
  users: [],
  series: [],
  strategies: [{ strategy: "round_robin", chains: 5, users: 3 }],
};

const multi = {
  template: { id: "multi", name: "三跳多路径", hops: 3 },
  nodes: [
    {
      seq: 0,
      role: "source",
      name: "入口",
      members: [member("香港-01", 10, 6), member("香港-02", 6, 4)],
    },
    {
      seq: 1,
      role: "hop",
      name: "东京",
      members: [
        member("东京-01", 10, 6),
        member("东京-02", 4, 2),
        member("东京-03", 2, 1),
        member("东京-备用", 0, 0),
      ],
    },
    {
      seq: 2,
      role: "hop",
      name: "洛杉矶",
      members: [
        member("洛杉矶-01", 8, 5),
        member("洛杉矶-02", 4, 2),
        member("洛杉矶-03", 4, 2),
      ],
    },
    {
      seq: 3,
      role: "hop",
      name: "法兰克福",
      members: [
        member("法兰克福-01", 9, 5),
        member("法兰克福-02", 4, 2),
        member("法兰克福-03", 3, 2),
      ],
    },
    {
      seq: 4,
      role: "target",
      name: "目标",
      members: [
        { name: "1.1.1.1:443", chains: 5, users: 3 },
        { name: "2.2.2.2:8443", chains: 4, users: 2 },
        { name: "3.3.3.3:443", chains: 3, users: 2 },
        { name: "4.4.4.4:2053", chains: 3, users: 1 },
      ],
    },
  ],
  edges: [
    edge(0, "香港-01", 1, "东京-01", 7, 14),
    edge(0, "香港-02", 1, "东京-01", 3, 19),
    edge(0, "香港-02", 1, "东京-02", 2, 21),
    edge(0, "香港-02", 1, "东京-03", 1, null),
    edge(1, "东京-01", 2, "洛杉矶-01", 5, 88),
    edge(1, "东京-01", 2, "洛杉矶-02", 2, 96),
    edge(1, "东京-02", 2, "洛杉矶-01", 2, 91),
    edge(1, "东京-03", 2, "洛杉矶-03", 1, 110),
    edge(2, "洛杉矶-01", 3, "法兰克福-01", 5, 142),
    edge(2, "洛杉矶-01", 3, "法兰克福-02", 2, 151),
    edge(2, "洛杉矶-02", 3, "法兰克福-02", 2, 148),
    edge(2, "洛杉矶-03", 3, "法兰克福-03", 1, 160),
    edge(3, "法兰克福-01", 4, "1.1.1.1:443", 3, 172),
    edge(3, "法兰克福-01", 4, "2.2.2.2:8443", 2, 180),
    edge(3, "法兰克福-02", 4, "3.3.3.3:443", 2, 184),
    edge(3, "法兰克福-03", 4, "4.4.4.4:2053", 1, null),
  ],
  targets: [
    target("1.1.1.1", 443, 3),
    target("2.2.2.2", 8443, 2),
    target("3.3.3.3", 443, 2),
    target("4.4.4.4", 2053, 1),
  ],
  users: [],
  series: [],
  strategies: [{ strategy: "failover", chains: 12, users: 6 }],
};

const fold = {
  ...multi,
  template: { id: "fold", name: "多目标折叠", hops: 3 },
  nodes: multi.nodes.map((node) =>
    node.role === "target"
      ? {
          ...node,
          members: Array.from({ length: 12 }, (_, index) => ({
            name: `10.0.${index}.1:443`,
            chains: 12 - index,
            users: 1,
          })),
        }
      : node,
  ),
  edges: [
    ...multi.edges.filter((item) => item.to.seq !== 4),
    ...Array.from({ length: 12 }, (_, index) =>
      edge(3, "法兰克福-01", 4, `10.0.${index}.1:443`, 12 - index, 90 + index * 5),
    ),
  ],
  targets: Array.from({ length: 12 }, (_, index) =>
    target(`10.0.${index}.1`, 443, 12 - index),
  ),
};

const offline = {
  ...multi,
  template: { id: "offline", name: "离线路径", hops: 3 },
  nodes: multi.nodes.map((node) =>
    node.role === "hop" && node.seq === 2
      ? {
          ...node,
          members: node.members.map((item, index) =>
            index === 1
              ? { ...item, status: "offline" }
              : item,
          ),
        }
      : node,
  ),
};

/** 两个父节点各 10 个目标、链数交错：验证「+N 按父节点分组」。 */
const foldMulti = {
  template: { id: "fold-multi", name: "多父目标折叠", hops: 2 },
  nodes: [
    {
      seq: 0,
      role: "source",
      name: "入口",
      members: [member("入口-01", 40, 8)],
    },
    {
      seq: 1,
      role: "hop",
      name: "第一跳",
      members: [member("p1", 20, 5), member("p2", 19, 3)],
    },
    { seq: 2, role: "target", name: "目标", members: [] },
  ],
  edges: [
    edge(0, "入口-01", 1, "p1", 20, 12),
    edge(0, "入口-01", 1, "p2", 19, 13),
    ...Array.from({ length: 10 }, (_, index) =>
      edge(1, "p1", 2, `10.1.0.${index + 1}:443`, 50 - index, 30 + index),
    ),
    ...Array.from({ length: 10 }, (_, index) =>
      edge(1, "p2", 2, `10.2.0.${index + 1}:443`, 49 - index, 40 + index),
    ),
  ],
  targets: [
    ...Array.from({ length: 10 }, (_, index) =>
      target(`10.1.0.${index + 1}`, 443, 50 - index),
    ),
    ...Array.from({ length: 10 }, (_, index) =>
      target(`10.2.0.${index + 1}`, 443, 49 - index),
    ),
  ],
  users: [],
  series: [],
  strategies: [{ strategy: "round_robin", chains: 39, users: 8 }],
};

/** 110 节点 / 109 边：DOM 预算、脉冲并发上限、hover 写入、空闲帧率。 */
const perf = {
  template: { id: "perf", name: "性能基线", hops: 4 },
  nodes: [
    { seq: 0, role: "source", name: "入口", members: [member("入口-01", 109, 12)] },
    ...[1, 2, 3].map((seq) => ({
      seq,
      role: "hop" as const,
      name: `第 ${seq} 跳`,
      members: Array.from({ length: 36 }, (_, index) =>
        member(`h${seq}-${index}`, 36 - index, 10),
      ),
    })),
    {
      seq: 4,
      role: "target",
      name: "目标",
      members: [{ name: "1.1.1.1:443", chains: 5, users: 2 }],
    },
  ],
  edges: [
    ...Array.from({ length: 36 }, (_, index) =>
      edge(0, "入口-01", 1, `h1-${index}`, 36 - index, 10 + index),
    ),
    ...Array.from({ length: 36 }, (_, index) =>
      edge(1, `h1-${index}`, 2, `h2-${index}`, 36 - index, 20 + index),
    ),
    ...Array.from({ length: 36 }, (_, index) =>
      edge(2, `h2-${index}`, 3, `h3-${index}`, 36 - index, 30 + index),
    ),
    edge(3, "h3-0", 4, "1.1.1.1:443", 5, 60),
  ],
  targets: [target("1.1.1.1", 443, 5)],
  users: [],
  series: [],
  strategies: [{ strategy: "failover", chains: 109, users: 12 }],
};

/** 降级成员：abnormal / no_data 归一为 degraded，路径标黄、不脉冲。 */
const degraded = {
  ...multi,
  template: { id: "degraded", name: "降级路径", hops: 3 },
  nodes: multi.nodes.map((node) => ({
    ...node,
    members: node.members.map((item) => {
      if (node.seq === 2 && item.name === "洛杉矶-02") {
        return { ...item, status: "abnormal" };
      }
      if (node.seq === 3 && item.name === "法兰克福-03") {
        return { ...item, status: "no_data" };
      }
      return item;
    }),
  })),
};

/** 0 链：拓扑给空态，不画孤立 root。 */
const empty = {
  ...multi,
  template: { id: "empty", name: "空模板", hops: 3 },
  nodes: multi.nodes.map((node) => ({
    ...node,
    members: node.members.map((item) => ({ ...item, chains: 0, users: 0 })),
  })),
  edges: multi.edges.map((item) => ({ ...item, chains: 0, users: 0 })),
  targets: [],
};

/** 超长成员 / 目标名：标签截断到 ~24 字符 + …，完整名留在 tooltip / aria。 */
const longLabel = {
  template: { id: "long-label", name: "超长标签", hops: 1 },
  nodes: [
    { seq: 0, role: "source", name: "入口", members: [member("入口-01", 2, 1)] },
    {
      seq: 1,
      role: "hop",
      name: "第一个跳点",
      members: [member("香港-节点名字非常长需要截断-01", 2, 1)],
    },
    {
      seq: 2,
      role: "target",
      name: "目标",
      members: [
        {
          name: "a-very-long-target-hostname.example.com:443",
          chains: 2,
          users: 1,
        },
      ],
    },
  ],
  edges: [
    edge(0, "入口-01", 1, "香港-节点名字非常长需要截断-01", 2, 12),
    edge(
      1,
      "香港-节点名字非常长需要截断-01",
      2,
      "a-very-long-target-hostname.example.com:443",
      2,
      30,
    ),
  ],
  targets: [
    {
      host: "a-very-long-target-hostname.example.com",
      port: 443,
      chains: 2,
      users: [{ id: "u1", name: "demo", chains: 2 }],
    },
  ],
  users: [],
  series: [],
  strategies: [{ strategy: "round_robin", chains: 2, users: 1 }],
};

/** 模板已修改：真实链仍是 2 跳，模板当前是 3 跳；节点只来自真实链。 */
const stale = {
  template: {
    id: "stale",
    name: "模板已修改",
    hops: 3,
    stale: true,
    stale_reason:
      "链的跳数（2）与模板（3）不一致 / chain hop count (2) differs from the template (3)",
  },
  nodes: [
    {
      seq: 0,
      role: "source",
      name: "入口",
      members: [member("香港-01", 2, 1)],
    },
    {
      seq: 1,
      role: "hop",
      name: "东京",
      members: [member("东京-01", 2, 1)],
    },
    {
      seq: 2,
      role: "target",
      name: "目标",
      members: [{ name: "1.2.3.4:443", chains: 2, users: 1 }],
    },
  ],
  edges: [
    edge(0, "香港-01", 1, "东京-01", 2, 14),
    edge(1, "东京-01", 2, "1.2.3.4:443", 2, 52),
  ],
  targets: [target("1.2.3.4", 443, 2)],
  users: [],
  series: [],
  strategies: [{ strategy: "round_robin", chains: 2, users: 1 }],
  series_basis: "existing_chains",
  unused_candidates: [
    { seq: 2, server_id: "srv-osaka", name: "大阪-01", status: "online" },
  ],
};

/** 未使用候选：真实链用到的成员进树，候选只进底部列表。 */
const unused = {
  template: { id: "unused", name: "未使用候选", hops: 2, stale: false },
  nodes: [
    {
      seq: 0,
      role: "source",
      name: "入口",
      members: [member("香港-01", 3, 2)],
    },
    {
      seq: 1,
      role: "hop",
      name: "东京",
      members: [
        member("东京-01", 2, 1),
        member("东京-02", 1, 1, "abnormal"),
      ],
    },
    {
      seq: 2,
      role: "target",
      name: "目标",
      members: [{ name: "1.2.3.4:443", chains: 3, users: 2 }],
    },
  ],
  edges: [
    edge(0, "香港-01", 1, "东京-01", 2, 12),
    edge(0, "香港-01", 1, "东京-02", 1, 16),
    edge(1, "东京-01", 2, "1.2.3.4:443", 2, 48),
    edge(1, "东京-02", 2, "1.2.3.4:443", 1, 55),
  ],
  targets: [target("1.2.3.4", 443, 3)],
  users: [],
  series: [],
  strategies: [{ strategy: "round_robin", chains: 3, users: 2 }],
  unused_candidates: [
    { seq: 1, server_id: "srv-tyo-3", name: "东京-03", status: "offline" },
    { seq: 1, server_id: "srv-tyo-4", name: "东京-04", status: "no_data" },
  ],
};

const FIXTURES: Record<string, unknown> = {
  single,
  multi,
  fold,
  offline,
  "fold-multi": foldMulti,
  perf,
  degraded,
  empty,
  longlabel: longLabel,
  stale,
  unused,
};

export function detailFor(name: string) {
  const payload = FIXTURES[name] ?? multi;
  return normalizeChainTemplateDetail(payload);
}
