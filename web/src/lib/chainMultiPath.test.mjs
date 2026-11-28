/**
 * 多路径链路的时延卡文案 / 契约归一化回归。
 *
 * 覆盖三块：
 * 1. 整体时延卡的「多路径 · 按各跳中位数叠加」显示条件；
 * 2. 逐段标题的策略 + 台数，以及 `segments[].members[]` 的成员明细行
 *    （最多 8 行 + `+N`、`active` 标「当前」）、缺失契约时的降级；
 * 3. 状态文案按 `status.kind` + `cause` 生成：多成员组掉一部分成员是
 *    「降级 · 东京-02 离线」，不是「阻断」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setCurrentLocale } from "../i18n/locale.ts";
import {
  chainHasMultiPathHop,
  chainSegmentMemberRows,
  chainSegmentTitlePlan,
  normalizeChainHealth,
} from "./chainHealth.ts";
import { chainSegmentStrategyLabel, chainSegmentTitle } from "./chainSegmentText.ts";
import { chainStatusText } from "./chainStatusText.ts";
import { chainHealthState } from "./chainHealth.ts";
import { chainListStatusCounts } from "./chainListFilters.ts";
import { t } from "../i18n/index.ts";

function withLocale(locale, fn) {
  setCurrentLocale(locale);
  try {
    fn();
  } finally {
    setCurrentLocale("en");
  }
}

function member(name, overrides = {}) {
  return {
    server_id: `id-${name}`,
    name,
    status: "online",
    p50_ms: 20,
    loss_pct: 0.1,
    attempts: 120,
    failures: 1,
    ...overrides,
  };
}

function node(seq, role, name, overrides = {}) {
  const members = overrides.members ?? [member(`${name}-01`)];
  return {
    seq,
    name,
    role,
    status: overrides.status ?? "online",
    server_id: overrides.serverId ?? members[0]?.server_id ?? null,
    member_count: overrides.memberCount ?? members.length,
    members,
    ...(overrides.strategy === undefined
      ? {}
      : { strategy: overrides.strategy }),
    ...(overrides.activeServerId === undefined
      ? {}
      : { active_server_id: overrides.activeServerId }),
  };
}

function segment(seq, from, to, overrides = {}) {
  return {
    seq,
    from,
    to,
    p50: 24,
    delta_ms: 1,
    contribution_pct: 50,
    loss_pct: 0.2,
    attempts: 120,
    failures: 1,
    series: [],
    ...overrides,
  };
}

function parseChain({ nodes = [], segments, status, estimated = false }) {
  const parsed = normalizeChainHealth({
    generated_at: 1_800_000_000,
    hours: 24,
    bucket: 900,
    summary: {},
    chains: [
      {
        id: "chain-1",
        name: "香港 → 东京",
        hops: Math.max(1, nodes.length - 1),
        status,
        last_hop: { measurable: true, reason: null },
        nodes,
        missing_hops: [],
        estimated,
        series: [],
        segments,
        diagnosis: { kind: "unknown" },
        loss_pct: 0.2,
        loss_samples: { attempts: 120, failures: 1 },
      },
    ],
  });
  assert.equal(parsed.status, "ok");
  return parsed.snapshot.chains[0];
}

function singlePathChain(status) {
  return parseChain({
    nodes: [
      node(0, "source", "香港入口"),
      node(1, "hop", "东京中转"),
      { seq: 2, name: "链目标", role: "target", status: null, members: [] },
    ],
    segments: [segment(1, "香港-01", "东京-01")],
    status,
  });
}

function multiPathChain({ strategy = "failover", status, members, est = true } = {}) {
  const hopMembers =
    members ??
    [
      member("东京-01", { status: "offline" }),
      member("东京-02", { status: "online" }),
      member("东京-03", { status: "online" }),
    ];
  return parseChain({
    estimated: est,
    nodes: [
      node(0, "source", "香港入口"),
      node(1, "hop", "东京中转", {
        members: hopMembers,
        memberCount: hopMembers.length,
        strategy,
        activeServerId: hopMembers[1]?.server_id,
        status: "degraded",
      }),
      { seq: 2, name: "链目标", role: "target", status: null, members: [] },
    ],
    segments: [
      // 段 1 的源组是入口（1 台）；段 2 的源组才是东京 3 台 → 策略 + 明细都
      // 挂在段 2 上（契约 `segments[].members` 给的是源组成员）。
      segment(1, "香港-01", "东京-02", {
        members: [member("香港-01")],
      }),
      segment(2, "东京-02", "10.0.0.8", {
        members: hopMembers.map((item, index) => ({
          ...item,
          active: index === 1,
        })),
      }),
    ],
    status,
  });
}

/* ------------------------------------------------------------------ */
/* §1 多路径说明的显示条件                                             */
/* ------------------------------------------------------------------ */

test("multi-path note only when a middle hop really has more than one member", () => {
  assert.equal(chainHasMultiPathHop(multiPathChain()), true);
  assert.equal(chainHasMultiPathHop(singlePathChain()), false);
  // 入口组多台不算「多路径跳」：入口只选一台代表，不是并行路径。
  const entryOnly = parseChain({
    nodes: [
      node(0, "source", "香港入口", {
        members: [member("香港-01"), member("香港-02")],
      }),
      node(1, "hop", "东京中转"),
      { seq: 2, name: "链目标", role: "target", status: null, members: [] },
    ],
    segments: [segment(1, "香港-01", "东京-01")],
  });
  assert.equal(chainHasMultiPathHop(entryOnly), false);
  // 旧主控没有 nodes：按单路径处理，不显示说明。
  const legacy = parseChain({
    nodes: [],
    segments: [segment(1, "香港-01", "东京-01")],
  });
  assert.equal(chainHasMultiPathHop(legacy), false);
  // 只有 member_count（后端只回前几台成员）也要算多成员跳。
  const countOnly = parseChain({
    nodes: [
      node(0, "source", "香港入口"),
      node(1, "hop", "东京中转", { members: [member("东京-01")], memberCount: 3 }),
      { seq: 2, name: "链目标", role: "target", status: null, members: [] },
    ],
    segments: [segment(1, "香港-01", "东京-01")],
  });
  assert.equal(chainHasMultiPathHop(countOnly), true);
});

test("multi-path note copy is bilingual and names the RTT boundary", () => {
  withLocale("zh-CN", () => {
    assert.equal(t("overview.chainLatency.multiPathNote"), "多路径 · 按各跳中位数叠加");
    assert.match(t("overview.chainLatency.multiPathNoteHint"), /不是单条连接的 RTT/);
  });
  withLocale("en", () => {
    assert.equal(
      t("overview.chainLatency.multiPathNote"),
      "Multi-path · summed per-hop medians",
    );
    assert.match(
      t("overview.chainLatency.multiPathNoteHint"),
      /not the RTT of a single connection/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* §2 段标题策略 + 台数                                                */
/* ------------------------------------------------------------------ */

test("segment title plan covers failover / lowest_latency / round_robin", () => {
  const failover = multiPathChain({ strategy: "failover" });
  // 段 2 的源组才是东京 3 台；契约 members 与标题必须指向同一组。
  const plan = chainSegmentTitlePlan(failover.segments[1], failover.nodes);
  assert.deepEqual(plan, { strategy: "failover", kind: "choose", count: 3 });

  const lowest = multiPathChain({ strategy: "lowest_latency" });
  assert.deepEqual(chainSegmentTitlePlan(lowest.segments[1], lowest.nodes), {
    strategy: "lowest_latency",
    kind: "choose",
    count: 3,
  });

  const roundRobin = multiPathChain({ strategy: "round_robin" });
  assert.deepEqual(chainSegmentTitlePlan(roundRobin.segments[1], roundRobin.nodes), {
    strategy: "round_robin",
    kind: "balanced",
    count: 3,
  });
});

test("segment title drops the strategy for single-member / entry / unknown strategy", () => {
  const single = singlePathChain();
  assert.equal(chainSegmentTitlePlan(single.segments[0], single.nodes), null);
  assert.equal(chainSegmentTitlePlan(single.segments[1], single.nodes), null);

  // 段 1 的源组是入口（契约里入口没有「上一跳进入本组」的策略）→ 不显示。
  const multi = multiPathChain();
  assert.equal(chainSegmentTitlePlan(multi.segments[0], multi.nodes), null);

  // 没有契约策略时不猜一个策略名。
  const noStrategy = multiPathChain({ strategy: null });
  const hop = noStrategy.nodes.find((item) => item.role === "hop");
  assert.equal(hop.strategy, null);
  assert.equal(chainSegmentTitlePlan(noStrategy.segments[1], noStrategy.nodes), null);
  // 旧主控没有 nodes：保持「第 N 段」。
  assert.equal(chainSegmentTitlePlan(single.segments[1], []), null);
});

test("segment titles read 第 2 段 · 最低延迟 · 3 选 1 / 轮询 · 3 台分担", () => {
  const failover = multiPathChain({ strategy: "failover" });
  const roundRobin = multiPathChain({ strategy: "round_robin" });
  const titleOf = (chain) =>
    chainSegmentTitle(
      chain.segments[1],
      chainSegmentTitlePlan(chain.segments[1], chain.nodes),
    );
  withLocale("zh-CN", () => {
    assert.equal(titleOf(failover), "第 2 段 · 主备 · 3 选 1");
    assert.equal(titleOf(roundRobin), "第 2 段 · 轮询 · 3 台分担");
    assert.equal(
      chainSegmentTitle(singlePathChain().segments[1], null),
      "第 2 段",
    );
    assert.equal(chainSegmentStrategyLabel("lowest_latency"), "最低延迟");
  });
  withLocale("en", () => {
    assert.equal(titleOf(failover), "Segment 2 · Active/standby · 1 of 3");
    assert.equal(titleOf(roundRobin), "Segment 2 · Round robin · 3 sharing");
    assert.equal(chainSegmentStrategyLabel("weighted"), "Weighted");
  });
  // 「第 2 段」的序号来自契约，标题不重新编号。
  withLocale("zh-CN", () => {
    assert.equal(
      chainSegmentTitle({ seq: 2 }, { strategy: "failover", kind: "choose", count: 2 }),
      "第 2 段 · 主备 · 2 选 1",
    );
  });
});

/* ------------------------------------------------------------------ */
/* §2 成员明细：契约解析 + 8 行上限 + 当前标记                          */
/* ------------------------------------------------------------------ */

test("segment members are normalized from the contract", () => {
  const chain = multiPathChain();
  // 契约 members 是段**源组**成员：段 1 只有入口 1 台，段 2 才是东京 3 台。
  assert.equal(chain.segments[0].members.length, 1);
  const members = chain.segments[1].members;
  assert.equal(members.length, 3);
  assert.deepEqual(
    members.map((item) => [item.name, item.status, item.active]),
    [
      ["东京-01", "offline", false],
      ["东京-02", "online", true],
      ["东京-03", "online", false],
    ],
  );
  assert.equal(members[0].p50, 20);
  assert.equal(members[0].lossPct, 0.1);
});

test("missing contract fields degrade to no member rows instead of fake data", () => {
  const legacy = parseChain({
    nodes: [],
    segments: [segment(1, "香港-01", "东京-01")],
  });
  assert.deepEqual(legacy.segments[0].members, []);
  assert.deepEqual(chainSegmentMemberRows(legacy.segments[0].members), {
    rows: [],
    overflow: 0,
  });
  // 缺 active / p50_ms / 脏计数：按「没有」处理，不补假值。
  const dirty = parseChain({
    nodes: [
      node(0, "source", "香港入口"),
      node(1, "hop", "东京中转", { members: [member("东京-01")] }),
      { seq: 2, name: "链目标", role: "target", status: null, members: [] },
    ],
    segments: [
      segment(1, "香港-01", "东京-01", {
        members: [
          {
            server_id: "s1",
            name: "东京-01",
            status: "online",
            p50_ms: null,
            loss_pct: 120,
            attempts: 10,
            failures: 11,
          },
          { server_id: "s2" },
        ],
      }),
    ],
  });
  assert.equal(dirty.segments[0].members.length, 1);
  const only = dirty.segments[0].members[0];
  assert.equal(only.p50, null);
  assert.equal(only.lossPct, null, "out-of-range loss is dropped");
  assert.equal(only.failures, null, "failures > attempts is dropped");
  assert.equal(only.active, null, "missing active stays unknown");
});

test("member table caps at 8 rows and keeps the active member visible", () => {
  const members = Array.from({ length: 10 }, (_, index) =>
    member(`东京-${String(index + 1).padStart(2, "0")}`, {
      active: index === 9,
    }),
  );
  const { rows, overflow } = chainSegmentMemberRows(members);
  assert.equal(rows.length, 8);
  assert.equal(overflow, 2);
  assert.equal(rows[0].name, "东京-10", "active member is never folded into +N");
  assert.equal(rows.filter((item) => item.active === true).length, 1);
  // 恰好 8 台时没有 +N。
  assert.deepEqual(chainSegmentMemberRows(members.slice(0, 8)), {
    rows: members.slice(0, 8),
    overflow: 0,
  });
});

/* ------------------------------------------------------------------ */
/* §3 状态文案：按 kind + cause，不把降级说成阻断                       */
/* ------------------------------------------------------------------ */

function statusChain(kind, cause, nodeName) {
  return parseChain({
    nodes: [
      node(0, "source", "香港入口"),
      node(1, "hop", "东京中转", {
        members: [
          member("东京-01", { status: "offline" }),
          member("东京-02", { status: "online" }),
        ],
        memberCount: 2,
      }),
      { seq: 2, name: "链目标", role: "target", status: null, members: [] },
    ],
    segments: [segment(1, "香港-01", "东京-01")],
    status: {
      kind,
      cause,
      node: nodeName === null ? null : { seq: 1, name: nodeName },
    },
  });
}

test("partial member loss is degraded · node offline, not blocked", () => {
  const chain = statusChain("degraded", "node_offline", "东京-02");
  withLocale("zh-CN", () => {
    assert.equal(chainStatusText(chain), "降级 · 东京-02 离线");
  });
  withLocale("en", () => {
    assert.equal(chainStatusText(chain), "Degraded · 东京-02 offline");
  });
  assert.equal(chainHealthState(chain, null), "degraded");
});

test("a whole hop with no online member stays blocked", () => {
  const chain = statusChain("blocked", "node_offline", "大阪-01");
  withLocale("zh-CN", () => {
    assert.equal(chainStatusText(chain), "阻断 · 大阪-01 离线");
  });
  withLocale("en", () => {
    assert.equal(chainStatusText(chain), "Blocked · 大阪-01 offline");
  });
  assert.equal(chainHealthState(chain, null), "blocked");
});

test("contract status wins over the legacy config-level blocked reason", () => {
  const chain = statusChain("degraded", "node_offline", "东京-02");
  const config = { enabled: true, degraded: true, blocked_reason: "证书过期" };
  assert.equal(chainHealthState(chain, config), "degraded");
  withLocale("zh-CN", () => {
    assert.equal(chainStatusText(chain, config), "降级 · 东京-02 离线");
  });
});

test("list status counts aggregate by status.kind", () => {
  const degraded = statusChain("degraded", "node_offline", "东京-02");
  const blocked = statusChain("blocked", "node_offline", "大阪-01");
  const ok = singlePathChain({ kind: "ok", cause: null, node: null });
  const counts = chainListStatusCounts([degraded, blocked, ok], null);
  assert.equal(counts.all, 3);
  assert.equal(counts.degraded, 1);
  assert.equal(counts.blocked, 1);
  assert.equal(counts.ok, 1);
});
