import assert from "node:assert/strict";
import test from "node:test";
import {
  canCreateChain,
  chainDisableConfirm,
  chainEditError,
  chainEditSuccess,
  chainEnableHint,
  chainEntryLabel,
  chainPath,
  chainQuotaState,
  editableChainFields,
  planChainEdit,
  templatePath,
  templateServerCount,
} from "./myChains.ts";
import { setCurrentLocale } from "../i18n/locale.ts";

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

// ---------------------------------------------------------------------------
// 编辑自己的链（可编辑字段 / 停用确认 / 启用后的端口提示）
// ---------------------------------------------------------------------------
const liveChain = {
  id: "chain-1",
  name: "港日 · 10.0.0.8:443",
  template_id: "tpl-1",
  template_name: "港日",
  target_host: "10.0.0.8",
  target_port: 443,
  enabled: true,
  entry_address: "203.0.113.7:20000",
  groups: [{ seq: 0, servers: [{ server_name: "香港-01", listen_port: 20000 }] }],
};

test("editable fields only expose name / target / enabled", () => {
  const fields = editableChainFields(liveChain);
  assert.deepEqual(fields, {
    name: "港日 · 10.0.0.8:443",
    targetHost: "10.0.0.8",
    targetPort: "443",
    enabled: true,
  });
  // 模板、groups、入口端口不进表单。
  assert.equal("id" in fields, false);
  assert.equal("template_id" in fields, false);
  assert.equal("groups" in fields, false);
  assert.equal("entry_address" in fields, false);
});

test("planChainEdit submits only changed fields and flags transitions", () => {
  const targetOnly = planChainEdit(liveChain, {
    ...editableChainFields(liveChain),
    targetHost: "10.9.9.10",
    targetPort: "8443",
  });
  assert.deepEqual(targetOnly.input, {
    target_host: "10.9.9.10",
    target_port: 8443,
  });
  assert.equal(targetOnly.targetChanged, true);
  assert.equal(targetOnly.enabling, false);
  assert.equal(targetOnly.disabling, false);
  assert.equal(targetOnly.needsDisableConfirm, false);

  const disable = planChainEdit(liveChain, {
    ...editableChainFields(liveChain),
    enabled: false,
  });
  assert.deepEqual(disable.input, { enabled: false });
  assert.equal(disable.disabling, true);
  assert.equal(disable.needsDisableConfirm, true, "停用必须先确认");

  const disabledChain = { ...liveChain, enabled: false };
  const enable = planChainEdit(disabledChain, {
    ...editableChainFields(disabledChain),
    enabled: true,
  });
  assert.deepEqual(enable.input, { enabled: true });
  assert.equal(enable.enabling, true);
  assert.equal(enable.needsDisableConfirm, false);

  const unchanged = planChainEdit(liveChain, editableChainFields(liveChain));
  assert.equal(unchanged.hasChanges, false);
});

test("name-only edits do not pretend the target changed", () => {
  const plan = planChainEdit(liveChain, {
    ...editableChainFields(liveChain),
    name: "  香港出口  ",
  });
  assert.deepEqual(plan.input, { name: "香港出口" });
  assert.equal(plan.targetChanged, false);
});

test("chain edit validation allows an empty target only while disabled", () => {
  setCurrentLocale("zh-CN");
  const base = editableChainFields(liveChain);
  assert.equal(chainEditError({ ...base, name: "" }), "请输入转发链名称");
  assert.equal(chainEditError({ ...base, targetHost: "" }), "请输入目标地址");
  assert.equal(chainEditError({ ...base, targetPort: "0" }), "目标端口需为 1–65535 的整数");
  assert.equal(chainEditError({ ...base, targetPort: "70000" }), "目标端口需为 1–65535 的整数");
  assert.equal(
    chainEditError({ ...base, enabled: false, targetHost: "", targetPort: "" }),
    null,
    "停用的链允许暂不填目标",
  );
});

test("disable confirmation says the chain is removed and the port may change", () => {
  setCurrentLocale("zh-CN");
  const confirm = chainDisableConfirm();
  assert.match(confirm.title, /停用转发链/);
  assert.match(confirm.description, /从服务器移除该转发链/);
  assert.match(confirm.description, /入口端口可能变化/);
  assert.match(chainEnableHint(), /重新分配入口端口/);
  assert.match(chainEnableHint(), /可能与之前不同/);

  setCurrentLocale("en");
  const english = chainDisableConfirm();
  assert.match(english.description, /removes this forward chain from the server/i);
  assert.match(english.description, /entry port may change/i);
  assert.match(chainEnableHint(), /allocates a new entry port/i);
});

test("success toasts carry the new target or the new entry address", () => {
  setCurrentLocale("zh-CN");
  const targetPlan = planChainEdit(liveChain, {
    ...editableChainFields(liveChain),
    targetHost: "10.9.9.10",
    targetPort: "8443",
  });
  const targetToast = chainEditSuccess(targetPlan, {
    ...liveChain,
    target_host: "10.9.9.10",
    target_port: 8443,
  });
  assert.match(targetToast, /10\.9\.9\.10:8443/);
  // 入口端口没变，成功提示不应把它当成变化项。
  assert.doesNotMatch(targetToast, /20000/);

  const enablePlan = planChainEdit(
    { ...liveChain, enabled: false },
    { ...editableChainFields(liveChain), enabled: true },
  );
  const enableToast = chainEditSuccess(enablePlan, {
    ...liveChain,
    entry_address: "203.0.113.7:20001",
  });
  assert.match(enableToast, /203\.0\.113\.7:20001/);
  assert.match(enableToast, /入口端口可能已变化/);

  const disablePlan = planChainEdit(liveChain, {
    ...editableChainFields(liveChain),
    enabled: false,
  });
  assert.match(chainEditSuccess(disablePlan, liveChain), /端口已释放/);
});
