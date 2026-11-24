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

const FIXTURES: Record<string, unknown> = { single, multi, fold, offline };

export function detailFor(name: string) {
  const payload = FIXTURES[name] ?? multi;
  return normalizeChainTemplateDetail(payload);
}
