import assert from "node:assert/strict";
import test from "node:test";
import {
  canCreateChain,
  chainEntryLabel,
  chainPath,
  chainQuotaState,
  templatePath,
  templateServerCount,
} from "./myChains.ts";

test("chain quota reuses the self-service forward semantics", () => {
  assert.equal(chainQuotaState(null), "none");
  assert.equal(chainQuotaState({ limit: 0, used: 0 }), "none");
  assert.equal(chainQuotaState({ limit: 2, used: 0 }), "available");
  assert.equal(chainQuotaState({ limit: 2, used: 2 }), "exhausted");
  assert.equal(canCreateChain({ limit: 1, used: 0 }), true);
  assert.equal(canCreateChain({ limit: 1, used: 1 }), false);
  assert.equal(canCreateChain(undefined), false);
});

test("templatePath orders groups and joins server names with arrows", () => {
  assert.equal(templatePath(null), "—");
  assert.equal(templatePath({ groups: [] }), "—");
  assert.equal(
    templatePath({
      groups: [
        { seq: 1, servers: [{ name: "日本-02" }] },
        { seq: 0, servers: [{ name: "香港-01" }, { name: "香港-02" }] },
      ],
    }),
    "香港-01 / 香港-02 → 日本-02",
  );
  // 服务器名缺失时回落到 id，而不是显示空串。
  assert.equal(
    templatePath({ groups: [{ seq: 0, server_ids: ["srv-a"] }] }),
    "srv-a",
  );
  assert.equal(templatePath({ groups: [{ seq: 0, server_ids: [] }] }), "—");
});

test("chainPath joins members per group", () => {
  assert.equal(chainPath(null), "—");
  assert.equal(
    chainPath({
      groups: [
        {
          seq: 1,
          servers: [{ server_name: "东京-01" }],
        },
        {
          seq: 0,
          servers: [{ server_name: "香港-01" }, { server_name: "香港-02" }],
        },
      ],
    }),
    "香港-01 / 香港-02 → 东京-01",
  );
});

test("chainEntryLabel trims the backend address and falls back to a dash", () => {
  assert.equal(chainEntryLabel({ entry_address: " 203.0.113.7:20000 " }), "203.0.113.7:20000");
  assert.equal(chainEntryLabel({ entry_address: null }), "—");
  assert.equal(chainEntryLabel(null), "—");
});

test("templateServerCount sums group members", () => {
  assert.equal(templateServerCount(null), 0);
  assert.equal(
    templateServerCount({
      groups: [
        { servers: [{ name: "a" }, { name: "b" }] },
        { server_ids: ["c"] },
      ],
    }),
    3,
  );
});
