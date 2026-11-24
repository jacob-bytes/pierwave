import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAIN_MAX_GROUPS,
  CHAIN_MIN_GROUPS,
  CHAIN_STRATEGIES,
  CHAIN_WEIGHT_MAX,
  CHAIN_WEIGHT_MIN,
  DEFAULT_CHAIN_WEIGHT,
  GROUP_MAX_MEMBERS,
  GROUP_MIN_MEMBERS,
  chainGroupSummary,
  chainPathNames,
  chainStatus,
  collectGroupIssues,
  collectTemplateGroupIssues,
  degradedGroups,
  degradedHops,
  degradedMembers,
  entryHop,
  entryMember,
  formatHopEndpoint,
  formatMemberEndpoint,
  groupIsDegraded,
  groupKind,
  hopListeningState,
  hopTargetState,
  isChainStrategy,
  nftablesStrategySupported,
  normalizeStrategy,
  normalizeWeight,
  orderGroups,
  orderHops,
  orderMembers,
  parseWeight,
  serverUsagesElsewhere,
  strategyUsesWeight,
  templateServerUsagesElsewhere,
  weightFieldVisible,
} from "./chains.ts";

const hop = (seq, overrides = {}) => ({
  seq,
  server_name: `server-${seq}`,
  listen_port: 20000 + seq,
  listening: true,
  target_ok: true,
  degraded: false,
  error: "",
  updated_at: 1_700_000_000,
  ...overrides,
});

test("chainStatus reports disabled before degraded", () => {
  assert.equal(chainStatus(false, true), "disabled");
  assert.equal(chainStatus(0, true), "disabled");
  assert.equal(chainStatus(undefined, true), "disabled");
});

test("chainStatus distinguishes degraded from ok", () => {
  assert.equal(chainStatus(true, true), "degraded");
  assert.equal(chainStatus(1, 1), "degraded");
  assert.equal(chainStatus(true, false), "ok");
  assert.equal(chainStatus(1, 0), "ok");
  assert.equal(chainStatus(true, undefined), "ok");
});

test("hopListeningState treats null as unreported, not failed", () => {
  assert.equal(hopListeningState(null), "unreported");
  assert.equal(hopListeningState(undefined), "unreported");
  assert.equal(hopListeningState(true), "listening");
  assert.equal(hopListeningState(false), "failed");
});

test("hopTargetState treats null as unprobed, not reachable", () => {
  assert.equal(hopTargetState(null), "unprobed");
  assert.equal(hopTargetState(undefined), "unprobed");
  assert.equal(hopTargetState(true), "reachable");
  assert.equal(hopTargetState(false), "unreachable");
});

test("orderHops sorts by seq without mutating the input", () => {
  const input = [hop(2), hop(0), hop(1)];
  const ordered = orderHops(input);

  assert.deepEqual(
    ordered.map((item) => item.seq),
    [0, 1, 2],
  );
  assert.deepEqual(
    input.map((item) => item.seq),
    [2, 0, 1],
  );
});

test("entryHop returns the lowest seq and null for an empty chain", () => {
  assert.equal(entryHop([hop(2), hop(0), hop(1)])?.seq, 0);
  assert.equal(entryHop([hop(1)])?.seq, 1);
  assert.equal(entryHop([]), null);
});

test("degradedHops lists only degrading hops in chain order", () => {
  const hops = [
    hop(2, { degraded: true, target_ok: false }),
    hop(0),
    hop(1, { degraded: true, target_ok: false }),
  ];

  assert.deepEqual(
    degradedHops(hops).map((item) => item.seq),
    [1, 2],
  );
  assert.deepEqual(degradedHops([hop(0), hop(1)]), []);
});

test("formatHopEndpoint trims the server name and appends the port", () => {
  assert.equal(
    formatHopEndpoint({ server_name: " 香港中转 ", listen_port: 443 }),
    "香港中转:443",
  );
  assert.equal(
    formatHopEndpoint({ server_name: "sg-02", listen_port: 20000 }),
    "sg-02:20000",
  );
});

// ---- 组（group）语义：一条链由 1-6 组、每组 1-8 台成员组成 ----

const member = (priority, overrides = {}) => ({
  server_id: `server-${priority}`,
  server_name: `server-${priority}`,
  listen_port: 20000 + priority,
  priority,
  listening: true,
  target_ok: true,
  degraded: false,
  ...overrides,
});

const group = (seq, members, overrides = {}) => ({
  seq,
  name: null,
  strategy: "round_robin",
  degraded: false,
  members,
  ...overrides,
});

test("group limits match the backend contract", () => {
  assert.equal(CHAIN_MIN_GROUPS, 1);
  assert.equal(CHAIN_MAX_GROUPS, 6);
  assert.equal(GROUP_MIN_MEMBERS, 1);
  assert.equal(GROUP_MAX_MEMBERS, 8);
  assert.deepEqual([...CHAIN_STRATEGIES], [
    "round_robin",
    "failover",
    "lowest_latency",
    "ip_hashed",
    "weighted",
    "least_conn",
  ]);
});

test("isChainStrategy accepts all six documented values", () => {
  for (const strategy of CHAIN_STRATEGIES) {
    assert.equal(isChainStrategy(strategy), true);
  }
  assert.equal(isChainStrategy("weighted"), true);
  assert.equal(isChainStrategy("least_conn"), true);
  assert.equal(isChainStrategy("RoundRobin"), false);
  assert.equal(isChainStrategy("random"), false);
  assert.equal(isChainStrategy("leastconn"), false);
  assert.equal(isChainStrategy(null), false);
  assert.equal(isChainStrategy(1), false);
});

test("normalizeStrategy keeps new strategies and falls back for unknown db values", () => {
  assert.equal(normalizeStrategy("failover"), "failover");
  assert.equal(normalizeStrategy("ip_hashed"), "ip_hashed");
  assert.equal(normalizeStrategy("weighted"), "weighted");
  assert.equal(normalizeStrategy("least_conn"), "least_conn");
  assert.equal(normalizeStrategy("legacy"), "round_robin");
  assert.equal(normalizeStrategy(null), "round_robin");
  assert.equal(normalizeStrategy(undefined), "round_robin");
});

test("weight controls are only available for weighted multi-member groups", () => {
  assert.equal(strategyUsesWeight("weighted"), true);
  assert.equal(strategyUsesWeight("least_conn"), false);
  assert.equal(strategyUsesWeight("round_robin"), false);

  assert.equal(weightFieldVisible("weighted", 2), true);
  assert.equal(weightFieldVisible("weighted", 8), true);
  assert.equal(
    weightFieldVisible("weighted", 1),
    false,
    "单成员组没有可分配的对象，不显示权重",
  );
  assert.equal(
    weightFieldVisible("least_conn", 3),
    false,
    "只有加权策略读取权重",
  );
});

test("member weight must be an integer between 1 and 100", () => {
  assert.equal(CHAIN_WEIGHT_MIN, 1);
  assert.equal(CHAIN_WEIGHT_MAX, 100);
  assert.equal(DEFAULT_CHAIN_WEIGHT, 1);

  for (const weight of [1, 2, 50, 100]) {
    assert.equal(parseWeight(weight), weight);
    assert.equal(parseWeight(String(weight)), weight);
  }
  for (const weight of [0, -1, 101, 1.5, "", "abc", null, undefined]) {
    assert.equal(parseWeight(weight), null, `weight=${String(weight)}`);
  }
  assert.equal(normalizeWeight("7"), 7);
  assert.equal(normalizeWeight("0"), 1, "非法权重提交前回落缺省 1");
  assert.equal(normalizeWeight(undefined), 1);
});

test("orderGroups sorts by seq without mutating the input", () => {
  const input = [group(2, [member(0)]), group(0, [member(0)]), group(1, [])];
  const ordered = orderGroups(input);

  assert.deepEqual(
    ordered.map((item) => item.seq),
    [0, 1, 2],
  );
  assert.deepEqual(
    input.map((item) => item.seq),
    [2, 0, 1],
  );
});

test("orderMembers sorts by priority and keeps equal priorities stable", () => {
  const first = member(1, { server_id: "a" });
  const second = member(0, { server_id: "b" });
  const third = member(1, { server_id: "c" });
  const ordered = orderMembers([first, third, second]);

  assert.deepEqual(
    ordered.map((item) => item.server_id),
    ["b", "a", "c"],
  );
  assert.deepEqual(
    [first, third, second].map((item) => item.server_id),
    ["a", "c", "b"],
  );
});

test("entryMember points at the first member of the first group", () => {
  const groups = [
    group(1, [member(0), member(1)], { name: "exit" }),
    group(0, [member(2), member(0)], { name: "entry" }),
  ];

  assert.equal(entryMember(groups)?.server_id, "server-0");
  assert.equal(entryMember([]), null);
  assert.equal(entryMember([group(0, [])]), null);
});

test("chainGroupSummary counts groups and every member", () => {
  assert.deepEqual(
    chainGroupSummary([
      group(0, [member(0), member(1), member(2)]),
      group(1, [member(0)]),
      group(2, [member(0), member(1)]),
    ]),
    { groups: 3, members: 6 },
  );
  assert.deepEqual(chainGroupSummary([]), { groups: 0, members: 0 });
});

test("groupIsDegraded covers both the group flag and member flags", () => {
  assert.equal(groupIsDegraded(group(0, [member(0)])), false);
  assert.equal(
    groupIsDegraded(group(0, [member(0)], { degraded: true })),
    true,
  );
  assert.equal(
    groupIsDegraded(
      group(0, [member(0), member(1, { degraded: true })]),
    ),
    true,
  );
});

test("degradedGroups and degradedMembers keep chain / priority order", () => {
  const groups = [
    group(2, [member(0), member(1, { degraded: true })], { degraded: true }),
    group(0, [member(0)]),
    group(1, [member(0, { degraded: true })], {
      degraded: true,
      name: "exit",
    }),
  ];

  assert.deepEqual(
    degradedGroups(groups).map((item) => item.seq),
    [1, 2],
  );
  assert.deepEqual(
    degradedMembers(groups[0]).map((item) => item.priority),
    [1],
  );
  assert.deepEqual(degradedMembers(group(0, [member(0)])), []);
});

test("formatMemberEndpoint trims the server name and appends the port", () => {
  assert.equal(
    formatMemberEndpoint({ server_name: " 香港中转 ", listen_port: 443 }),
    "香港中转:443",
  );
  assert.equal(
    formatMemberEndpoint({ server_name: "sg-02", listen_port: 20000 }),
    "sg-02:20000",
  );
});

// ---- 组校验：纯规则单测，表单只负责把 issue 映射成文案 / 字段层级 ----

const groupInput = (serverIds) => ({
  members: serverIds.map((server_id) => ({ server_id })),
});

test("collectGroupIssues accepts the 1-6 groups / 1-8 members boundaries", () => {
  assert.deepEqual(collectGroupIssues([groupInput(["a"])]), []);
  assert.deepEqual(
    collectGroupIssues(
      Array.from({ length: 4 }, (_, groupIndex) =>
        groupInput(
          Array.from(
            { length: 8 },
            (_, memberIndex) => `s-${groupIndex}-${memberIndex}`,
          ),
        ),
      ),
    ),
    [],
  );
});

test("collectGroupIssues rejects group counts outside 1-6", () => {
  assert.deepEqual(collectGroupIssues([]), [
    { kind: "group_count", count: 0, min: 1, max: 6 },
  ]);

  const issues = collectGroupIssues(
    Array.from({ length: 7 }, (_, index) => groupInput([`s-${index}`])),
  );
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    kind: "group_count",
    count: 7,
    min: 1,
    max: 6,
  });
});

test("collectGroupIssues rejects member counts outside 1-8", () => {
  assert.deepEqual(collectGroupIssues([groupInput([])]), [
    { kind: "member_count", groupIndex: 0, count: 0, min: 1, max: 8 },
  ]);

  const issues = collectGroupIssues([
    groupInput(Array.from({ length: 9 }, (_, index) => `s-${index}`)),
  ]);
  assert.deepEqual(issues, [
    { kind: "member_count", groupIndex: 0, count: 9, min: 1, max: 8 },
  ]);
});

test("collectGroupIssues reports same-group duplicates once, on the later member", () => {
  assert.deepEqual(collectGroupIssues([groupInput(["a", "a"])]), [
    { kind: "member_duplicate", groupIndex: 0, memberIndex: 1 },
  ]);
});

test("collectGroupIssues reports cross-group duplicates on the later member", () => {
  assert.deepEqual(
    collectGroupIssues([groupInput(["a", "b"]), groupInput(["c", "a"])]),
    [
      {
        kind: "server_duplicate",
        groupIndex: 1,
        memberIndex: 1,
        firstGroupIndex: 0,
      },
    ],
  );
});

test("collectGroupIssues ignores blank server ids", () => {
  assert.deepEqual(
    collectGroupIssues([groupInput(["", ""]), groupInput(["a"])]),
    [],
  );
});

test("groupKind treats one unnamed default-strategy member as a single node", () => {
  const member = { server_id: "a", listen_port: 19001 };
  assert.equal(groupKind({ members: [member] }), "single");
  assert.equal(groupKind({ name: "  ", strategy: "round_robin", members: [member] }), "single");
  assert.equal(groupKind({ name: "香港入口", members: [member] }), "group");
  assert.equal(groupKind({ strategy: "failover", members: [member] }), "group");
  assert.equal(groupKind({ members: [member, { ...member, server_id: "b" }] }), "group");
  assert.equal(groupKind({ members: [] }), "group");
});

test("nftablesStrategySupported mirrors the kernel-supported strategies", () => {
  for (const supported of ["round_robin", "weighted", "ip_hashed"]) {
    assert.equal(nftablesStrategySupported(supported), true, supported);
  }
  for (const unsupported of ["failover", "lowest_latency", "least_conn"]) {
    assert.equal(nftablesStrategySupported(unsupported), false, unsupported);
  }
  // 未知值按默认轮询处理，与 normalizeStrategy 的回落一致。
  assert.equal(nftablesStrategySupported("garbage"), true);
  assert.equal(nftablesStrategySupported(undefined), true);
});

test("chainPathNames joins entry to exit, or to the target on a single hop", () => {
  assert.deepEqual(
    chainPathNames(
      [
        group(1, [member(0, { server_name: "大阪-01" })]),
        group(0, [member(0, { server_name: "香港-01" })]),
      ],
      { host: "10.0.0.8", port: 443 },
    ),
    { from: "香港-01", to: "大阪-01" },
  );
  assert.deepEqual(
    chainPathNames(
      [group(0, [member(1, { server_name: "  香港-01  " })])],
      { host: " 10.0.0.8 ", port: 443 },
    ),
    { from: "香港-01", to: "10.0.0.8:443" },
  );
  assert.deepEqual(
    chainPathNames([group(0, [member(0, { server_name: "香港-01" })])], null),
    { from: "香港-01", to: null },
  );
  assert.deepEqual(chainPathNames([]), { from: null, to: null });
  assert.deepEqual(chainPathNames([group(0, [])]), { from: null, to: null });
});

// ---- 服务器占用：跨跳 / 同跳置灰，但当前值必须可选 ----

const chainGroups = (serverIdsByGroup) => ({
  groups: serverIdsByGroup.map((serverIds, groupIndex) => ({
    seq: groupIndex,
    strategy: "round_robin",
    name: null,
    members: serverIds.map((server_id, memberIndex) => ({
      server_id,
      listen_port: 20000 + memberIndex,
      priority: memberIndex,
    })),
  })),
});

test("serverUsagesElsewhere marks servers taken by another hop", () => {
  const { groups } = chainGroups([["hk-01"], ["tokyo-01"]]);
  const taken = serverUsagesElsewhere(groups, 1, 0);
  assert.deepEqual([...taken.entries()], [
    ["hk-01", { groupIndex: 0, memberIndex: 0 }],
  ]);
  assert.equal(taken.has("tokyo-01"), false);
});

test("serverUsagesElsewhere never blocks the member's own current server", () => {
  const { groups } = chainGroups([["hk-01"], ["tokyo-01"]]);
  // 第 1 跳自己选了 hk-01：下拉里它必须可选，否则打不开当前值；
  // 其它跳占用的东京-01 仍然置灰。
  const taken = serverUsagesElsewhere(groups, 0, 0);
  assert.equal(taken.has("hk-01"), false);
  assert.deepEqual(taken.get("tokyo-01"), { groupIndex: 1, memberIndex: 0 });
});

test("serverUsagesElsewhere reports same-hop duplicates on later members", () => {
  const { groups } = chainGroups([["hk-01", "hk-02"], ["tokyo-01"]]);
  // 第 1 跳第 2 台看到「已在第 1 跳第 1 台」。
  const second = serverUsagesElsewhere(groups, 0, 1);
  assert.deepEqual(second.get("hk-01"), { groupIndex: 0, memberIndex: 0 });
  // 第 1 跳第 1 台同样看到第 2 台已选的值。
  const first = serverUsagesElsewhere(groups, 0, 0);
  assert.deepEqual(first.get("hk-02"), { groupIndex: 0, memberIndex: 1 });
});

test("serverUsagesElsewhere releases a server once an earlier hop drops it", () => {
  const { groups } = chainGroups([["hk-01"], ["tokyo-01"]]);
  assert.equal(serverUsagesElsewhere(groups, 1, 0).has("hk-01"), true);

  // 第 1 跳改选香港-02：第 2 跳的香港-01 立即恢复可选，香港-02 被置灰。
  groups[0].members[0].server_id = "hk-02";
  const taken = serverUsagesElsewhere(groups, 1, 0);
  assert.equal(taken.has("hk-01"), false);
  assert.deepEqual(taken.get("hk-02"), { groupIndex: 0, memberIndex: 0 });
});

test("serverUsagesElsewhere prefers the earliest hop and keeps group reasons", () => {
  const { groups } = chainGroups([
    ["hk-01", "hk-02"],
    ["hk-01"],
    ["tokyo-01"],
  ]);
  assert.deepEqual(serverUsagesElsewhere(groups, 2, 0).get("hk-01"), {
    groupIndex: 0,
    memberIndex: 0,
  });
  assert.deepEqual(serverUsagesElsewhere(groups, 2, 0).get("hk-02"), {
    groupIndex: 0,
    memberIndex: 1,
  });
});

test("serverUsagesElsewhere ignores blank server ids", () => {
  const { groups } = chainGroups([[""], ["tokyo-01"]]);
  assert.deepEqual([...serverUsagesElsewhere(groups, 1, 0).entries()], []);
});

test("templateServerUsagesElsewhere marks servers taken by other hops", () => {
  const groups = [
    { strategy: "round_robin", server_ids: ["hk-01", "hk-02"] },
    { strategy: "round_robin", server_ids: ["tokyo-01"] },
  ];
  assert.deepEqual([...templateServerUsagesElsewhere(groups, 1).entries()], [
    ["hk-01", 0],
    ["hk-02", 0],
  ]);
  // 本跳自己已选的不算占用，才能取消勾选。
  assert.equal(templateServerUsagesElsewhere(groups, 0).has("hk-01"), false);
  // 反向同理：第 1 跳不能选第 2 跳已用的东京-01。
  assert.equal(templateServerUsagesElsewhere(groups, 0).get("tokyo-01"), 1);
});

test("templateServerUsagesElsewhere releases a server once an earlier hop drops it", () => {
  const groups = [
    { strategy: "round_robin", server_ids: ["hk-01"] },
    { strategy: "round_robin", server_ids: ["tokyo-01"] },
  ];
  assert.equal(templateServerUsagesElsewhere(groups, 1).has("hk-01"), true);

  groups[0].server_ids = ["hk-02"];
  const taken = templateServerUsagesElsewhere(groups, 1);
  assert.equal(taken.has("hk-01"), false);
  assert.equal(taken.get("hk-02"), 0);
});

test("collectTemplateGroupIssues reports same-hop duplicates once per hop", () => {
  assert.deepEqual(
    collectTemplateGroupIssues([
      { strategy: "round_robin", server_ids: ["hk-01", "hk-01", "hk-02", "hk-02"] },
    ]),
    [{ kind: "member_duplicate", groupIndex: 0 }],
  );
});

test("collectTemplateGroupIssues reports cross-hop duplicates on the later hop", () => {
  assert.deepEqual(
    collectTemplateGroupIssues([
      { strategy: "round_robin", server_ids: ["hk-01", "hk-02"] },
      { strategy: "round_robin", server_ids: ["tokyo-01", "hk-01", "hk-02"] },
    ]),
    [{ kind: "server_duplicate", groupIndex: 1, firstGroupIndex: 0 }],
  );
  assert.deepEqual(
    collectTemplateGroupIssues([
      { strategy: "round_robin", server_ids: ["hk-01"] },
      { strategy: "round_robin", server_ids: ["tokyo-01"] },
    ]),
    [],
  );
  assert.deepEqual(
    collectTemplateGroupIssues([
      { strategy: "round_robin", server_ids: ["", " "] },
      { strategy: "round_robin", server_ids: ["tokyo-01"] },
    ]),
    [],
  );
});
