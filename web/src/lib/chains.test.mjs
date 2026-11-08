import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAIN_MAX_GROUPS,
  CHAIN_MIN_GROUPS,
  CHAIN_STRATEGIES,
  GROUP_MAX_MEMBERS,
  GROUP_MIN_MEMBERS,
  chainGroupSummary,
  chainStatus,
  collectGroupIssues,
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
  normalizeStrategy,
  orderGroups,
  orderHops,
  orderMembers,
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

// ---- 组（group）语义：一条链由 1-4 组、每组 1-8 台成员组成 ----

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
  assert.equal(CHAIN_MAX_GROUPS, 4);
  assert.equal(GROUP_MIN_MEMBERS, 1);
  assert.equal(GROUP_MAX_MEMBERS, 8);
  assert.deepEqual([...CHAIN_STRATEGIES], [
    "round_robin",
    "failover",
    "lowest_latency",
    "ip_hashed",
  ]);
});

test("isChainStrategy accepts only the four documented values", () => {
  for (const strategy of CHAIN_STRATEGIES) {
    assert.equal(isChainStrategy(strategy), true);
  }
  assert.equal(isChainStrategy("RoundRobin"), false);
  assert.equal(isChainStrategy("random"), false);
  assert.equal(isChainStrategy(null), false);
  assert.equal(isChainStrategy(1), false);
});

test("normalizeStrategy falls back to round robin for unknown db values", () => {
  assert.equal(normalizeStrategy("failover"), "failover");
  assert.equal(normalizeStrategy("ip_hashed"), "ip_hashed");
  assert.equal(normalizeStrategy("legacy"), "round_robin");
  assert.equal(normalizeStrategy(null), "round_robin");
  assert.equal(normalizeStrategy(undefined), "round_robin");
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

test("collectGroupIssues accepts the 1-4 groups / 1-8 members boundaries", () => {
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

test("collectGroupIssues rejects group counts outside 1-4", () => {
  assert.deepEqual(collectGroupIssues([]), [
    { kind: "group_count", count: 0, min: 1, max: 4 },
  ]);

  const issues = collectGroupIssues(
    Array.from({ length: 5 }, (_, index) => groupInput([`s-${index}`])),
  );
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0], {
    kind: "group_count",
    count: 5,
    min: 1,
    max: 4,
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
