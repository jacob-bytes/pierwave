import assert from "node:assert/strict";
import test from "node:test";
import {
  displayAgentVersion,
  hasPendingAgentUpgrade,
  normalizeAgentUpgradeStatus,
  normalizeAgentVersion,
} from "./agentUpgrade.ts";

test("normalizeAgentVersion trims, drops the v prefix and lowercases", () => {
  assert.equal(normalizeAgentVersion(" V1.2.3 "), "1.2.3");
  assert.equal(normalizeAgentVersion("0.2.0"), "0.2.0");
  assert.equal(normalizeAgentVersion(null), "");
  assert.equal(normalizeAgentVersion(undefined), "");
});

test("displayAgentVersion adds a missing v prefix and keeps empty values empty", () => {
  assert.equal(displayAgentVersion("0.2.0"), "v0.2.0");
  assert.equal(displayAgentVersion("v0.2.0"), "v0.2.0");
  assert.equal(displayAgentVersion("  "), "");
  assert.equal(displayAgentVersion(null), "");
});

test("hasPendingAgentUpgrade only reports a real target mismatch", () => {
  assert.equal(
    hasPendingAgentUpgrade({ agent_version: "0.2.0", agent_target_version: null }),
    false,
  );
  assert.equal(
    hasPendingAgentUpgrade({
      agent_version: "0.2.0",
      agent_target_version: "0.2.0",
    }),
    false,
  );
  // 只差前导 v / 大小写不算待升级，否则列表会永远轮询。
  assert.equal(
    hasPendingAgentUpgrade({
      agent_version: "0.2.0",
      agent_target_version: "V0.2.0",
    }),
    false,
  );
  assert.equal(
    hasPendingAgentUpgrade({
      agent_version: "0.2.0",
      agent_target_version: "0.3.0",
    }),
    true,
  );
  // Agent 还没上报过版本时，有目标版本就算待升级。
  assert.equal(
    hasPendingAgentUpgrade({
      agent_version: null,
      agent_target_version: "0.3.0",
    }),
    true,
  );
  // 旧后端不返回 agent_target_version 时不能崩。
  assert.equal(hasPendingAgentUpgrade({ agent_version: "0.2.0" }), false);
});

test("normalizeAgentUpgradeStatus falls back to unknown", () => {
  assert.equal(normalizeAgentUpgradeStatus("pending"), "pending");
  assert.equal(normalizeAgentUpgradeStatus("succeeded"), "succeeded");
  assert.equal(normalizeAgentUpgradeStatus("failed"), "failed");
  assert.equal(normalizeAgentUpgradeStatus("rolled_back"), "unknown");
  assert.equal(normalizeAgentUpgradeStatus(""), "unknown");
});
