import assert from "node:assert/strict";
import test from "node:test";
import {
  batchSelectionState,
  canSelectForBatchUpgrade,
  isAgentBatchItemTerminal,
  isAgentBatchStatusTerminal,
  normalizeAgentBatchItemStatus,
  normalizeAgentBatchStatus,
  normalizeBatchVersionInput,
  pruneBatchSelection,
  selectableServerIds,
  shouldPollAgentBatch,
  summarizeAgentBatchItems,
  toggleBatchSelection,
} from "./agentUpgradeBatch.ts";

test("normalizeAgentBatchStatus keeps known values and falls back to unknown", () => {
  assert.equal(normalizeAgentBatchStatus("running"), "running");
  assert.equal(normalizeAgentBatchStatus("succeeded"), "succeeded");
  assert.equal(normalizeAgentBatchStatus("failed"), "failed");
  assert.equal(normalizeAgentBatchStatus("cancelled"), "cancelled");
  assert.equal(normalizeAgentBatchStatus("paused"), "unknown");
  assert.equal(normalizeAgentBatchStatus(""), "unknown");
});

test("normalizeAgentBatchItemStatus keeps known values and falls back to unknown", () => {
  for (const status of [
    "queued",
    "running",
    "succeeded",
    "failed",
    "skipped",
    "cancelled",
  ]) {
    assert.equal(normalizeAgentBatchItemStatus(status), status);
  }
  assert.equal(normalizeAgentBatchItemStatus("pending"), "unknown");
  assert.equal(normalizeAgentBatchItemStatus(""), "unknown");
});

test("terminal predicates only accept finished states", () => {
  assert.equal(isAgentBatchStatusTerminal("running"), false);
  assert.equal(isAgentBatchStatusTerminal("succeeded"), true);
  assert.equal(isAgentBatchStatusTerminal("failed"), true);
  assert.equal(isAgentBatchStatusTerminal("cancelled"), true);
  assert.equal(isAgentBatchStatusTerminal("unknown"), false);

  assert.equal(isAgentBatchItemTerminal("queued"), false);
  assert.equal(isAgentBatchItemTerminal("running"), false);
  assert.equal(isAgentBatchItemTerminal("succeeded"), true);
  assert.equal(isAgentBatchItemTerminal("failed"), true);
  assert.equal(isAgentBatchItemTerminal("skipped"), true);
  assert.equal(isAgentBatchItemTerminal("cancelled"), true);
  assert.equal(isAgentBatchItemTerminal("unknown"), false);
});

test("summarizeAgentBatchItems counts every state and leaves unknown as remaining", () => {
  const summary = summarizeAgentBatchItems([
    { status: "succeeded" },
    { status: "succeeded" },
    { status: "failed" },
    { status: "skipped" },
    { status: "cancelled" },
    { status: "queued" },
    { status: "running" },
    { status: "mystery" },
  ]);

  assert.equal(summary.total, 8);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.cancelled, 1);
  assert.equal(summary.remaining, 3);
  assert.equal(summary.done, 5);
  assert.equal(summary.percent, 62);
});

test("summarizeAgentBatchItems handles empty and all-terminal batches", () => {
  assert.deepEqual(summarizeAgentBatchItems([]), {
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    remaining: 0,
    done: 0,
    percent: 0,
  });

  const failedSummary = summarizeAgentBatchItems([
    { status: "failed" },
    { status: "skipped" },
  ]);
  assert.equal(failedSummary.remaining, 0);
  assert.equal(failedSummary.done, 2);
  assert.equal(failedSummary.percent, 100);
});

test("shouldPollAgentBatch keeps polling until the batch and every item are terminal", () => {
  // 批次还在跑：即使当前所有 item 都是终态也继续轮询，等批次本身收尾。
  assert.equal(shouldPollAgentBatch("running", [{ status: "succeeded" }]), true);
  assert.equal(shouldPollAgentBatch("running", []), true);

  // 批次已终态但还有排队/执行中的 item：继续轮询。
  assert.equal(
    shouldPollAgentBatch("failed", [{ status: "queued" }]),
    true,
  );
  assert.equal(
    shouldPollAgentBatch("succeeded", [{ status: "running" }]),
    true,
  );

  // 批次与所有 item 都是终态：停止轮询。
  assert.equal(
    shouldPollAgentBatch("failed", [
      { status: "succeeded" },
      { status: "failed" },
      { status: "skipped" },
    ]),
    false,
  );
  assert.equal(shouldPollAgentBatch("cancelled", []), false);

  // 未知批次状态：只有还有未终态 item 时才继续。
  assert.equal(shouldPollAgentBatch("paused", [{ status: "running" }]), true);
  assert.equal(shouldPollAgentBatch("paused", [{ status: "failed" }]), false);

  // 未知 item 状态不算终态，避免提前停掉轮询。
  assert.equal(
    shouldPollAgentBatch("succeeded", [{ status: "mystery" }]),
    true,
  );
});

test("canSelectForBatchUpgrade only accepts servers that allow upgrades", () => {
  assert.equal(canSelectForBatchUpgrade({ id: "a", allow_agent_upgrade: true }), true);
  // 后端 0/1 序列化也要认。
  assert.equal(canSelectForBatchUpgrade({ id: "a", allow_agent_upgrade: 1 }), true);
  assert.equal(canSelectForBatchUpgrade({ id: "a", allow_agent_upgrade: false }), false);
  assert.equal(canSelectForBatchUpgrade({ id: "a", allow_agent_upgrade: 0 }), false);
  assert.equal(canSelectForBatchUpgrade({ id: "a", allow_agent_upgrade: null }), false);
  assert.equal(canSelectForBatchUpgrade({ id: "a" }), false);
});

test("selectableServerIds keeps table order and drops ineligible rows", () => {
  assert.deepEqual(
    selectableServerIds([
      { id: "a", allow_agent_upgrade: true },
      { id: "b", allow_agent_upgrade: false },
      { id: "c", allow_agent_upgrade: 1 },
    ]),
    ["a", "c"],
  );
  assert.deepEqual(selectableServerIds([]), []);
});

test("toggleBatchSelection adds then removes an id", () => {
  assert.deepEqual(toggleBatchSelection([], "a"), ["a"]);
  assert.deepEqual(toggleBatchSelection(["a"], "b"), ["a", "b"]);
  assert.deepEqual(toggleBatchSelection(["a", "b"], "a"), ["b"]);
  assert.deepEqual(toggleBatchSelection(["a"], "missing"), ["a", "missing"]);
});

test("pruneBatchSelection drops ids that are no longer eligible", () => {
  assert.deepEqual(pruneBatchSelection(["a", "b", "c"], ["a", "c", "d"]), ["a", "c"]);
  assert.deepEqual(pruneBatchSelection(["a"], []), []);
  assert.deepEqual(pruneBatchSelection([], ["a"]), []);
});

test("batchSelectionState drives the header checkbox", () => {
  // 没有可选行时表头复选框置灰、保持未选中。
  assert.equal(batchSelectionState([], []), "none");
  assert.equal(batchSelectionState(["a"], []), "none");
  assert.equal(batchSelectionState([], ["a", "b"]), "none");
  assert.equal(batchSelectionState(["a"], ["a", "b"]), "some");
  // 已选里混入不可选 id 时只看可选集合。
  assert.equal(batchSelectionState(["a", "x"], ["a", "b"]), "some");
  assert.equal(batchSelectionState(["a", "b"], ["a", "b"]), "all");
  assert.equal(batchSelectionState(["a", "b", "x"], ["a", "b"]), "all");
});

test("normalizeBatchVersionInput trims and keeps an empty value as latest", () => {
  assert.equal(normalizeBatchVersionInput("  v0.5.2 "), "v0.5.2");
  assert.equal(normalizeBatchVersionInput(""), "");
  assert.equal(normalizeBatchVersionInput("   "), "");
});
