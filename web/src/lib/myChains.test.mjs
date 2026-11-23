import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAIN_NAME_MAX_CHARS,
  canCreateChain,
  chainActualEntryPort,
  chainDisableConfirm,
  chainEditError,
  chainEditSuccess,
  chainEnableHint,
  chainEntryLabel,
  chainPath,
  chainQuotaState,
  editableChainFields,
  entryAddressPort,
  entryPortInputError,
  entryPortNotAdopted,
  entryPortNotAdoptedText,
  entryPortPayload,
  entryPortRangeLabel,
  hopCountLabel,
  planChainEdit,
  templateChainName,
  templateEntryPortRange,
  templateHopCount,
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

// ---------------------------------------------------------------------------
// 入口端口（可空 = 自动分配）/ 跳数 / 模板端口提示
// ---------------------------------------------------------------------------
test("entry port is optional and only accepts 1-65535 integers", () => {
  setCurrentLocale("zh-CN");
  assert.equal(entryPortInputError(""), null, "留空 = 自动分配");
  assert.equal(entryPortInputError("   "), null);
  assert.equal(entryPortInputError("24321"), null);
  assert.equal(entryPortInputError("1"), null);
  assert.equal(entryPortInputError("65535"), null);
  for (const invalid of ["0", "65536", "-1", "1.5", "12a", "1 2"]) {
    assert.equal(
      entryPortInputError(invalid),
      "入口端口需为 1–65535 的整数，或留空",
      invalid,
    );
  }
  assert.equal(entryPortPayload(""), undefined);
  assert.equal(entryPortPayload("024321"), 24321);
  assert.equal(entryPortPayload("70000"), undefined);

  setCurrentLocale("en");
  assert.equal(
    entryPortInputError("70000"),
    "Entry port must be an integer between 1 and 65535, or empty",
  );
});

test("hop count label handles English singular and plural", () => {
  setCurrentLocale("zh-CN");
  assert.equal(hopCountLabel(1), "1 跳");
  assert.equal(hopCountLabel(3), "3 跳");
  setCurrentLocale("en");
  assert.equal(hopCountLabel(1), "1 hop");
  assert.equal(hopCountLabel(3), "3 hops");
});

test("template entry port range only trusts the explicit template fields", () => {
  assert.equal(templateEntryPortRange(null), null);
  assert.equal(templateEntryPortRange({}), null);
  assert.deepEqual(
    templateEntryPortRange({ entry_port_start: 20000, entry_port_end: 29999 }),
    { start: 20000, end: 29999 },
  );
  // 后端还没返回模板级字段时，不拿入口服务器的端口策略伪造范围。
  assert.equal(
    templateEntryPortRange({
      groups: [
        { seq: 0, servers: [{ port_start: 30000, port_end: 30010 }] },
      ],
    }),
    null,
  );
  // 单边 / 越界 / 脏数据同样不显示。
  assert.equal(templateEntryPortRange({ entry_port_start: 25000 }), null);
  assert.equal(templateEntryPortRange({ entry_port_end: 25000 }), null);
  assert.equal(
    templateEntryPortRange({ entry_port_start: 30000, entry_port_end: 20000 }),
    null,
  );
  assert.equal(
    templateEntryPortRange({ entry_port_start: 70000, entry_port_end: 80000 }),
    null,
  );

  setCurrentLocale("zh-CN");
  assert.equal(
    entryPortRangeLabel({ start: 20000, end: 29999 }),
    "允许端口 20000-29999",
  );
  assert.equal(entryPortRangeLabel({ start: 24321, end: 24321 }), "允许端口 24321");
  assert.equal(entryPortRangeLabel(null), null);
});

test("template hop count follows the group list", () => {
  assert.equal(templateHopCount(null), 0);
  assert.equal(templateHopCount({ groups: [{ seq: 0 }, { seq: 1 }] }), 2);
});

test("generated chain names keep the target suffix within the 64-char limit", () => {
  assert.equal(CHAIN_NAME_MAX_CHARS, 64, "必须与后端 NAME_MAX_CHARS 一致");
  assert.equal(
    templateChainName("香港 → 日本", "10.0.0.8", 443),
    "香港 → 日本 · 10.0.0.8:443",
  );
  const long = templateChainName("很".repeat(200), "example.com", 8443);
  assert.equal([...long].length, 64, `${[...long].length} chars`);
  assert.ok(long.endsWith(" · example.com:8443"));
  assert.ok(long.startsWith("很"));
  assert.equal(templateChainName("   ", "h", 1), "chain · h:1");
  // 目标本身超过上限时仍不超过 64，且端口留在末尾可辨认。
  const longTarget = templateChainName("模板", "a".repeat(120) + ".example", 8443);
  assert.equal([...longTarget].length, 64);
  assert.ok(longTarget.endsWith(":8443"));
});

test("entry address port parsing handles IPv4 and bracketed IPv6", () => {
  assert.equal(entryAddressPort("203.0.113.7:24321"), 24321);
  assert.equal(entryAddressPort("[2001:db8::1]:24000"), 24000);
  assert.equal(entryAddressPort("  example.com:443  "), 443);
  for (const invalid of [
    null,
    "",
    "example.com",
    "host:",
    "host:0",
    "host:70000",
    "host:abc",
    "2001:db8::1",
    "[2001:db8::1]",
  ]) {
    assert.equal(entryAddressPort(invalid), null, String(invalid));
  }
});

test("actual entry port prefers entry_address and falls back to the entry group", () => {
  assert.equal(
    chainActualEntryPort({
      entry_address: "203.0.113.7:24000",
      groups: [{ seq: 0, members: [{ listen_port: 25000 }] }],
    }),
    24000,
  );
  // 管理端链视图没有 entry_address：从入口组（按 seq 排序）第一台推导。
  assert.equal(
    chainActualEntryPort({
      groups: [
        { seq: 1, members: [{ listen_port: 26000 }] },
        { seq: 0, members: [{ listen_port: 24321 }] },
      ],
    }),
    24321,
  );
  // 用户链视图的 groups[].servers。
  assert.equal(
    chainActualEntryPort({ groups: [{ seq: 0, servers: [{ listen_port: 27000 }] }] }),
    27000,
  );
  assert.equal(chainActualEntryPort(null), null);
  assert.equal(chainActualEntryPort({ entry_address: null, groups: [] }), null);
});

test("an ignored entry_port is detected and worded as a warning", () => {
  assert.deepEqual(entryPortNotAdopted(24321, 24000), {
    requested: 24321,
    actual: 24000,
  });
  assert.equal(entryPortNotAdopted(24321, 24321), null);
  assert.equal(entryPortNotAdopted(undefined, 24000), null, "留空 = 自动分配");
  assert.equal(entryPortNotAdopted(null, 24000), null);
  assert.equal(entryPortNotAdopted(24321, null), null, "读不到实际端口就不猜");

  setCurrentLocale("zh-CN");
  assert.equal(
    entryPortNotAdoptedText({ requested: 24321, actual: 24000 }),
    "端口 24321 未被采用，实际为 24000（保存后可在链路详情看到）",
  );
  setCurrentLocale("en");
  assert.equal(
    entryPortNotAdoptedText({ requested: 24321, actual: 24000 }),
    "Port 24321 was not used; the actual port is 24000 (you can see it in the chain details after saving)",
  );
  setCurrentLocale("en");
});
