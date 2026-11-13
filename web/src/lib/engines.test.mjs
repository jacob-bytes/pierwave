import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAIN_ENGINES,
  DEFAULT_FORWARD_ENGINE,
  FORWARD_ENGINES,
  chainEngineMissing,
  chainEngineOptions,
  chainServersMissingRealm,
  effectiveUdp,
  engineInput,
  engineMeta,
  engineMissing,
  formatServerNameList,
  forwardEngineMissing,
  isForwardEngine,
  missingNftablesServerNames,
  missingRealmServerNames,
  missingTunnelServerNames,
  nftablesMissingOnServer,
  nftablesMultiMemberGroups,
  normalizeEngine,
  realmMissingOnServer,
  serversMissingNftables,
  serversMissingRealm,
  serversMissingTunnel,
  tunnelAvailable,
  tunnelIssues,
  udpBadgeVisible,
} from "./engines.ts";
import en from "../i18n/en.ts";
import zhCN from "../i18n/zh-CN.ts";

function lookup(dictionary, key) {
  let node = dictionary;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

const dictionaries = [
  ["zh-CN", zhCN],
  ["en", en],
];

// ---- 枚举与默认值 ----

test("engine enum matches the backend whitelist and defaults to native", () => {
  assert.deepEqual([...FORWARD_ENGINES], ["native", "realm", "nftables"]);
  assert.equal(DEFAULT_FORWARD_ENGINE, "native");
});

test("isForwardEngine accepts only the documented values", () => {
  assert.equal(isForwardEngine("native"), true);
  assert.equal(isForwardEngine("realm"), true);
  assert.equal(isForwardEngine("nftables"), true);

  for (const bad of [
    "",
    " ",
    "Native",
    "REALM",
    "wireguard",
    "realm2",
    null,
    undefined,
    0,
    1,
    {},
  ]) {
    assert.equal(isForwardEngine(bad), false, `bad=${String(bad)}`);
  }
});

test("normalizeEngine keeps legal values and falls back to native", () => {
  assert.equal(normalizeEngine("native"), "native");
  assert.equal(normalizeEngine("realm"), "realm");
  assert.equal(normalizeEngine("nftables"), "nftables");
  // 后端写路径允许首尾空白；前后端规则保持一致。
  assert.equal(normalizeEngine("  realm  "), "realm");
  // 大小写不匹配与未来新增值都按后端读路径回落 native。
  assert.equal(normalizeEngine("Realm"), "native");
  assert.equal(normalizeEngine("wireguard"), "native");
  assert.equal(normalizeEngine(""), "native");
  assert.equal(normalizeEngine(null), "native");
  assert.equal(normalizeEngine(undefined), "native");
  assert.equal(normalizeEngine(42), "native");
});

// ---- 展示映射：未知引擎不能渲染成空白 ----

test("engineMeta maps known engines to common.engine.* keys", () => {
  for (const engine of FORWARD_ENGINES) {
    const meta = engineMeta(engine);
    assert.equal(meta.known, true);
    assert.equal(meta.engine, engine);
    assert.equal(meta.labelKey, `common.engine.${engine}.label`);
    assert.equal(meta.descKey, `common.engine.${engine}.desc`);
  }
});

test("engineMeta treats a missing field as native, not unknown", () => {
  // 旧后端 / 迁移前的数据没有 engine 字段：契约缺省值是 native。
  for (const value of [undefined, null, "", "   "]) {
    const meta = engineMeta(value);
    assert.equal(meta.known, true, `value=${String(value)}`);
    assert.equal(meta.engine, "native");
    assert.equal(meta.labelKey, "common.engine.native.label");
  }
});

test("engineMeta falls back to a non-empty unknown label for future values", () => {
  const meta = engineMeta("wireguard");

  assert.equal(meta.known, false);
  assert.equal(meta.engine, null);
  assert.equal(meta.labelKey, "common.engine.unknown.label");
  assert.equal(meta.descKey, "common.engine.unknown.desc");

  // 兜底必须真的有字，不能渲染空白。
  assert.equal(lookup(zhCN, meta.labelKey), "未知引擎");
  assert.equal(lookup(en, meta.labelKey), "Unknown engine");
  assert.ok((lookup(zhCN, meta.descKey) ?? "").trim().length > 0);
  assert.ok((lookup(en, meta.descKey) ?? "").trim().length > 0);
});

test("engine labels are bilingual and match the badge copy", () => {
  assert.equal(lookup(zhCN, "common.engine.native.label"), "PierWave 核心");
  assert.equal(lookup(zhCN, "common.engine.realm.label"), "realm");
  assert.equal(lookup(zhCN, "common.engine.nftables.label"), "nftables");
  assert.equal(lookup(en, "common.engine.native.label"), "PierWave Core");
  assert.equal(lookup(en, "common.engine.realm.label"), "realm");
  assert.equal(lookup(en, "common.engine.nftables.label"), "nftables");
});

const ENGINE_I18N_KEYS = [
  "common.engine.native.label",
  "common.engine.native.short",
  "common.engine.native.desc",
  "common.engine.realm.label",
  "common.engine.realm.short",
  "common.engine.realm.desc",
  "common.engine.nftables.label",
  "common.engine.nftables.short",
  "common.engine.nftables.desc",
  "common.engine.nftables.notAvailable",
  "common.engine.tunnel.label",
  "common.engine.tunnel.short",
  "common.engine.tunnel.desc",
  "common.engine.tunnel.experimental",
  "common.engine.unknown.label",
  "common.engine.unknown.desc",
  "forwards.engine.missing",
  "forwards.engine.missingHint",
  "forwards.engine.missingTitle",
  "forwards.form.engine",
  "forwards.form.engineHint",
  "forwards.form.engineAria",
  "forwards.form.realmNotInstalled",
  "chains.engine.missing",
  "chains.engine.missingHint",
  "chains.engine.missingTitle",
  "chains.engine.memberMissing",
  "chains.engine.memberMissingTitle",
  "chains.form.engine",
  "chains.form.engineHint",
  "chains.form.engineAria",
  "chains.form.realmNotInstalled",
  "chains.form.tunnelNotAvailable",
  "chains.tunnel.protocolTitle",
  "chains.tls.tunnelDisabledTitle",
  "common.engine.realm.notInstalled",
  "validation.chainTunnelTwoHops",
  "validation.chainTunnelSingleMember",
];

test("every engine i18n key exists and is non-empty in both languages", () => {
  for (const key of ENGINE_I18N_KEYS) {
    for (const [locale, dictionary] of dictionaries) {
      const value = lookup(dictionary, key);
      assert.equal(typeof value, "string", `${locale} is missing ${key}`);
      assert.ok(
        value.trim().length > 0,
        `${locale} has a blank value for ${key}`,
      );
    }
  }
});

test("engine descriptions carry the required semantics", () => {
  // native：TCP、组内选路与降级、暂不支持 UDP。
  const nativeZh = lookup(zhCN, "common.engine.native.desc");
  assert.match(nativeZh, /TCP/);
  assert.match(nativeZh, /组内选路/);
  assert.match(nativeZh, /降级/);
  assert.match(nativeZh, /UDP/);

  // realm：UDP、带权重负载均衡、端口级探测、未安装提示。
  const realmZh = lookup(zhCN, "common.engine.realm.desc");
  assert.match(realmZh, /realm/);
  assert.match(realmZh, /UDP/);
  assert.match(realmZh, /权重/);
  assert.match(realmZh, /端口级/);
  assert.match(realmZh, /未安装/);
});

// ---- 「realm 未安装」判定 ----

test("engineMissing ignores anything that is not a false listener", () => {
  assert.equal(engineMissing(true, "realm 未安装"), false);
  assert.equal(engineMissing(null, "realm 未安装"), false);
  assert.equal(engineMissing(undefined, "realm 未安装"), false);
  assert.equal(engineMissing(1, "realm 未安装"), false);
});

test("engineMissing ignores blank or unrelated failures", () => {
  assert.equal(engineMissing(false, ""), false);
  assert.equal(engineMissing(false, "   "), false);
  assert.equal(engineMissing(false, null), false);
  assert.equal(engineMissing(false, undefined), false);
  assert.equal(engineMissing(false, "端口已被占用"), false);
  assert.equal(engineMissing(false, "bind failed"), false);
  // realm 装了但没监听成功：这是运行错误，不是引擎缺失。
  assert.equal(engineMissing(false, "realm 未监听端口"), false);
  assert.equal(engineMissing(false, "realm exited with code 1"), false);
  assert.equal(engineMissing(false, "xray not installed"), false);
});

test("engineMissing recognizes the Chinese agent message, even embedded", () => {
  assert.equal(engineMissing(false, "realm 未安装"), true);
  assert.equal(engineMissing(false, "  realm 未安装  "), true);
  assert.equal(engineMissing(false, "realm未安装"), true);
  assert.equal(
    engineMissing(false, "realm 未安装，realm 规则保持未监听（native 规则不受影响）"),
    true,
  );
});

test("engineMissing also recognizes English not-installed wording", () => {
  assert.equal(engineMissing(false, "realm not installed"), true);
  assert.equal(engineMissing(false, "realm is not installed"), true);
  assert.equal(engineMissing(false, "Realm is not installed."), true);
  assert.equal(engineMissing(false, "not installed: realm"), true);
  assert.equal(
    engineMissing(false, "realm not installed; realm rules stay down"),
    true,
  );
});

test("forwardEngineMissing only applies to realm rules", () => {
  const runtime = { listening: false, error: "realm 未安装" };

  assert.equal(forwardEngineMissing({ engine: "realm", runtime }), true);
  assert.equal(forwardEngineMissing({ engine: "native", runtime }), false);
  assert.equal(forwardEngineMissing({ engine: undefined, runtime }), false);
  assert.equal(forwardEngineMissing({ engine: "wireguard", runtime }), false);
  assert.equal(
    forwardEngineMissing({
      engine: "realm",
      runtime: { listening: true, error: "realm 未安装" },
    }),
    false,
  );
  assert.equal(forwardEngineMissing({ engine: "realm", runtime: null }), false);
  assert.equal(forwardEngineMissing({ engine: "realm" }), false);
});

test("chainEngineMissing reports any realm member that is missing the engine", () => {
  const member = (listening, error) => ({
    listening,
    error,
    server_name: "hk-01",
    listen_port: 20000,
  });

  assert.equal(
    chainEngineMissing({
      engine: "realm",
      groups: [{ members: [member(true, ""), member(false, "realm 未安装")] }],
    }),
    true,
  );
  assert.equal(
    chainEngineMissing({
      engine: "native",
      groups: [{ members: [member(false, "realm 未安装")] }],
    }),
    false,
  );
  assert.equal(
    chainEngineMissing({
      engine: "realm",
      groups: [{ members: [member(true, ""), member(null, "")] }],
    }),
    false,
  );
  assert.equal(
    chainEngineMissing({
      engine: "realm",
      groups: [{ members: [member(false, "realm 未监听端口")] }],
    }),
    false,
  );
  assert.equal(chainEngineMissing({ engine: "realm", groups: [] }), false);
  assert.equal(chainEngineMissing({ engine: "realm" }), false);
  assert.equal(chainEngineMissing({ engine: "realm", groups: [{}] }), false);
});

// ---- 服务器未安装 realm（静态事实，来自服务器列表） ----

test("serversMissingRealm only reports servers that explicitly lack realm", () => {
  // 全部明确装了 → 不提示。
  assert.equal(
    serversMissingRealm([
      { realm_available: true },
      { realm_available: true },
    ]),
    false,
  );

  // 至少一台明确没装 → 提示。
  assert.equal(
    serversMissingRealm([
      { realm_available: true },
      { realm_available: false },
    ]),
    true,
  );

  // null / undefined / 字段缺失 = 旧 Agent 未上报，不能误报。
  assert.equal(
    serversMissingRealm([
      { realm_available: null },
      { realm_available: undefined },
      {},
    ]),
    false,
  );

  assert.equal(serversMissingRealm([]), false);

  // false 与 null 混合：null 不参与，但只要有一台 false 就提示。
  assert.equal(
    serversMissingRealm([
      { realm_available: false },
      { realm_available: null },
    ]),
    true,
  );
});

test("missingRealmServerNames lists only false servers, in order, without duplicates", () => {
  const server = (name, realm_available) => ({
    id: name,
    name,
    realm_available,
  });

  assert.deepEqual(
    missingRealmServerNames([
      server("hk-01", true),
      server("hk-02", false),
      server("us-03", null),
      server("us-04", false),
    ]),
    ["hk-02", "us-04"],
  );

  // 同一台服务器在链的不同跳里出现时，名字只列一次。
  assert.deepEqual(
    missingRealmServerNames([server("hk-02", false), server("hk-02", false)]),
    ["hk-02"],
  );

  assert.deepEqual(missingRealmServerNames([]), []);
  assert.deepEqual(
    missingRealmServerNames([server("hk-01", true), server("us-03", null)]),
    [],
  );
});

test("formatServerNameList joins names with the locale separator", () => {
  assert.equal(formatServerNameList(["hk-02", "us-04"], "、"), "hk-02、us-04");
  assert.equal(formatServerNameList(["hk-02"], ", "), "hk-02");
  assert.equal(formatServerNameList([], "、"), "");
  // 空名字不能拼出「、」这种悬空分隔符。
  assert.equal(formatServerNameList(["hk-02", "", "us-04"], "、"), "hk-02、us-04");
});

test("realmMissingOnServer only fires for realm rules on a server that lacks realm", () => {
  assert.equal(realmMissingOnServer("realm", { realm_available: false }), true);

  assert.equal(realmMissingOnServer("native", { realm_available: false }), false);
  assert.equal(realmMissingOnServer(undefined, { realm_available: false }), false);
  assert.equal(realmMissingOnServer("", { realm_available: false }), false);
  // 未知引擎按 native 兜底，不能因为服务器没装 realm 就提示。
  assert.equal(
    realmMissingOnServer("wireguard", { realm_available: false }),
    false,
  );

  // 服务器明确装了 / 未上报（null）/ 服务器数据缺失 → 都不能提示「未安装」。
  assert.equal(realmMissingOnServer("realm", { realm_available: true }), false);
  assert.equal(realmMissingOnServer("realm", { realm_available: null }), false);
  assert.equal(realmMissingOnServer("realm", undefined), false);
  assert.equal(realmMissingOnServer("realm", null), false);
});

test("chainServersMissingRealm resolves member server ids against the server list", () => {
  const chain = (engine, groups) => ({
    engine,
    groups: groups.map((ids, index) => ({
      id: String(index),
      members: ids.map((server_id) => ({ server_id })),
    })),
  });
  const servers = [
    { id: "s1", realm_available: true },
    { id: "s2", realm_available: false },
    { id: "s3", realm_available: null },
  ];

  assert.equal(
    chainServersMissingRealm(chain("realm", [["s1", "s3"]]), servers),
    false,
  );
  assert.equal(
    chainServersMissingRealm(chain("realm", [["s1"], ["s2"]]), servers),
    true,
  );
  // 非 realm 链不受服务器是否装 realm 影响。
  assert.equal(
    chainServersMissingRealm(chain("native", [["s2"]]), servers),
    false,
  );
  // 未知 server_id / 空链 / 服务器列表未加载：不能误报。
  assert.equal(
    chainServersMissingRealm(chain("realm", [["missing"]]), servers),
    false,
  );
  assert.equal(chainServersMissingRealm(chain("realm", []), servers), false);
  assert.equal(chainServersMissingRealm({ engine: "realm" }, servers), false);
  assert.equal(chainServersMissingRealm(chain("realm", [["s2"]]), []), false);
});

test("realm-not-installed hint interpolates the joined server names", () => {
  const servers = [
    { id: "hk-02", name: "hk-02", realm_available: false },
    { id: "us-03", name: "us-03", realm_available: false },
  ];
  const names = missingRealmServerNames(servers);

  for (const [locale, dictionary] of dictionaries) {
    const template = lookup(dictionary, "chains.form.realmNotInstalled");
    const separator = lookup(dictionary, "common.listSeparator");
    const rendered = template
      .replace("{servers}", formatServerNameList(names, separator))
      .replace(/\s+/g, " ");

    assert.ok(
      rendered.includes(`hk-02${separator}us-03`),
      `${locale} should join both server names`,
    );
    assert.match(rendered, /realm/);
  }

  // 中文按需求给出完整可执行的一句话。
  const zhHint = lookup(zhCN, "chains.form.realmNotInstalled").replace(
    "{servers}",
    formatServerNameList(names, lookup(zhCN, "common.listSeparator")),
  );
  assert.equal(
    zhHint,
    "所选服务器中有未安装 realm 的：hk-02、us-03。保存后这些跳会显示「未监听 · realm 未安装」，装好 realm 并重新应用即可恢复。",
  );
});

test("realm-not-installed badge tooltip is bilingual", () => {
  assert.equal(
    lookup(zhCN, "common.engine.realm.notInstalled"),
    "该服务器未安装 realm",
  );
  assert.equal(
    lookup(en, "common.engine.realm.notInstalled"),
    "realm is not installed on this server",
  );
});

// ---- 表单提交序列化 ----

test("engineInput always sends an explicit legal value", () => {
  // native 也显式发送：edit 时把 realm 改回 native，PATCH 若省略 engine
  // 会被后端理解为「不改」，引擎就永远停在 realm。
  assert.deepEqual(engineInput("native"), { engine: "native" });
  assert.deepEqual(engineInput("realm"), { engine: "realm" });

  // 表单值缺失 / 非法时不能把未知值写回后端。
  assert.deepEqual(engineInput(undefined), { engine: "native" });
  assert.deepEqual(engineInput(null), { engine: "native" });
  assert.deepEqual(engineInput("wireguard"), { engine: "native" });
  assert.deepEqual(engineInput("Realm"), { engine: "native" });
});

test("engineInput serializes to JSON with exactly one engine field", () => {
  assert.equal(JSON.stringify(engineInput("realm")), '{"engine":"realm"}');
  assert.equal(JSON.stringify(engineInput("native")), '{"engine":"native"}');
});

// ---- UDP：realm 恒为开启，其它引擎按用户选择 ----

test("effectiveUdp forces UDP on for realm and passes the flag otherwise", () => {
  // realm 的配置里本来就是 use_udp = true：开关只是展示，不能是关闭。
  assert.equal(effectiveUdp("realm", true), true);
  assert.equal(effectiveUdp("realm", false), true);
  assert.equal(effectiveUdp("realm", undefined), true);
  // 后端写路径允许首尾空白，与 normalizeEngine 一致。
  assert.equal(effectiveUdp("  realm  ", false), true);

  // native 原样透传；缺失 / 旧数据按 false 处理。
  assert.equal(effectiveUdp("native", true), true);
  assert.equal(effectiveUdp("native", false), false);
  assert.equal(effectiveUdp("native", undefined), false);
  assert.equal(effectiveUdp("native", null), false);

  // 未知引擎也原样透传，不因为不认识就改写用户的开关。
  assert.equal(effectiveUdp("wireguard", true), true);
  assert.equal(effectiveUdp("wireguard", false), false);
  assert.equal(effectiveUdp(undefined, true), true);
  assert.equal(effectiveUdp(null, false), false);
});

test("udpBadgeVisible never duplicates the realm badge", () => {
  // realm 的引擎徽标已经说明「UDP」，列表里不再额外加 UDP 徽标。
  assert.equal(udpBadgeVisible("realm", true), false);
  assert.equal(udpBadgeVisible("realm", false), false);
  assert.equal(udpBadgeVisible("realm", undefined), false);
  assert.equal(udpBadgeVisible("  realm  ", true), false);

  // native 只有真的开启 UDP 才显示。
  assert.equal(udpBadgeVisible("native", true), true);
  assert.equal(udpBadgeVisible("native", false), false);
  assert.equal(udpBadgeVisible("native", undefined), false);
  assert.equal(udpBadgeVisible("native", null), false);

  // 未知引擎的引擎徽标没有提到 UDP，按实际开关显示，不能吞掉信息。
  assert.equal(udpBadgeVisible("wireguard", true), true);
  assert.equal(udpBadgeVisible("wireguard", false), false);
  assert.equal(udpBadgeVisible(undefined, true), true);
  assert.equal(udpBadgeVisible(null, false), false);
});

test("UDP label, badge and realm title stay terse and bilingual", () => {
  assert.equal(lookup(zhCN, "common.udp"), "UDP");
  assert.equal(lookup(en, "common.udp"), "UDP");

  // 只允许 label 与徽标，不写「适合游戏 / 语音」这类说明。
  assert.equal(lookup(zhCN, "forwards.form.udp"), "UDP 转发");
  assert.equal(lookup(en, "forwards.form.udp"), "UDP forwarding");
  assert.equal(lookup(zhCN, "chains.form.udp"), "UDP 转发");
  assert.equal(lookup(en, "chains.form.udp"), "UDP forwarding");

  // 禁用态只用 title 说明原因：realm 已包含 UDP。
  for (const dictionary of [zhCN, en]) {
    const title = lookup(dictionary, "common.udpRealmTitle");
    assert.ok(title.trim().length > 0);
    assert.match(title, /UDP/);
    assert.match(title, /realm/);
  }
});

// ---- nftables 能力与链限制 ----

test("serversMissingNftables requires an explicit true", () => {
  assert.equal(serversMissingNftables([]), false);
  assert.equal(serversMissingNftables([{ nftables_available: true }]), false);
  assert.equal(serversMissingNftables([{ nftables_available: false }]), true);
  assert.equal(serversMissingNftables([{ nftables_available: null }]), true);
  assert.equal(serversMissingNftables([{}]), true);
});

test("missingNftablesServerNames trims and dedupes unsupported servers", () => {
  assert.deepEqual(
    missingNftablesServerNames([
      { name: " 香港-01 ", nftables_available: true },
      { name: "日本-02", nftables_available: false },
      { name: " 日本-02 ", nftables_available: null },
      { name: "美国-04" },
      { name: "   ", nftables_available: false },
    ]),
    ["日本-02", "美国-04"],
  );
  assert.deepEqual(missingNftablesServerNames([]), []);
});

test("nftablesMissingOnServer only applies to the nftables engine", () => {
  assert.equal(
    nftablesMissingOnServer("nftables", { nftables_available: true }),
    false,
  );
  assert.equal(
    nftablesMissingOnServer("nftables", { nftables_available: false }),
    true,
  );
  assert.equal(nftablesMissingOnServer("nftables", null), true);
  assert.equal(
    nftablesMissingOnServer("native", { nftables_available: false }),
    false,
  );
  assert.equal(
    nftablesMissingOnServer("realm", { nftables_available: false }),
    false,
  );
});

test("nftablesMultiMemberGroups only flags non-entry groups", () => {
  const groups = [
    { members: [{}, {}] }, // entry group: allowed
    { members: [{}] }, // single: fine
    { members: [{}, {}] }, // non-entry multi: rejected
  ];
  assert.deepEqual(nftablesMultiMemberGroups("nftables", groups), [2]);
  assert.deepEqual(nftablesMultiMemberGroups("native", groups), []);
  assert.deepEqual(nftablesMultiMemberGroups("realm", groups), []);
});

// ---- tunnel：链专属引擎、2 跳 / 单成员拓扑与能力门禁 ----

test("chain engine list adds experimental tunnel after the standalone engines", () => {
  assert.deepEqual(
    [...CHAIN_ENGINES],
    ["native", "realm", "nftables", "tunnel"],
  );
  // 独立转发的白名单保持不变：tunnel 没有下一跳，后端拒绝独立转发使用它。
  assert.deepEqual([...FORWARD_ENGINES], ["native", "realm", "nftables"]);
});

test("engineMeta knows tunnel and maps it to common.engine.tunnel.*", () => {
  const meta = engineMeta("tunnel");
  assert.equal(meta.known, true);
  assert.equal(meta.engine, "tunnel");
  assert.equal(meta.labelKey, "common.engine.tunnel.label");
  assert.equal(meta.descKey, "common.engine.tunnel.desc");
  // normalizeEngine 也必须保留 tunnel，否则编辑现有 tunnel 链会回落 native。
  assert.equal(normalizeEngine("tunnel"), "tunnel");
  assert.equal(normalizeEngine("  tunnel  "), "tunnel");
});

test("tunnelAvailable accepts only a 2-hop chain with one member per group", () => {
  // 1 跳：不允许。
  assert.equal(tunnelAvailable("tunnel", 1, [1]), false);
  // 3 跳：不允许。
  assert.equal(tunnelAvailable("tunnel", 3, [1, 1, 1]), false);
  // 2 跳但某组多成员：不允许。
  assert.equal(tunnelAvailable("tunnel", 2, [1, 2]), false);
  assert.equal(tunnelAvailable("tunnel", 2, [2, 1]), false);
  // 2 跳且每组恰好 1 台：唯一合法形态。
  assert.equal(tunnelAvailable("tunnel", 2, [1, 1]), true);
  // groupSizes 与 groupCount 不一致时不能误判。
  assert.equal(tunnelAvailable("tunnel", 2, [1]), false);
  assert.equal(tunnelAvailable("tunnel", 2, [1, 1, 1]), false);
  // 其它引擎即使拓扑是 2×1 也不是 tunnel。
  assert.equal(tunnelAvailable("native", 2, [1, 1]), false);
  assert.equal(tunnelAvailable("realm", 2, [1, 1]), false);
  assert.equal(tunnelAvailable("nftables", 2, [1, 1]), false);
  // 未知引擎按 native 兜底，不能误判成 tunnel。
  assert.equal(tunnelAvailable("wireguard", 2, [1, 1]), false);
  assert.equal(tunnelAvailable(undefined, 2, [1, 1]), false);
});

test("tunnelIssues reports hop count and per-group member count", () => {
  assert.deepEqual(tunnelIssues("tunnel", [{ members: [{}] }]), [
    { kind: "group_count", count: 1 },
  ]);
  assert.deepEqual(
    tunnelIssues("tunnel", [
      { members: [{}] },
      { members: [{}] },
      { members: [{}] },
    ]),
    [{ kind: "group_count", count: 3 }],
  );
  assert.deepEqual(
    tunnelIssues("tunnel", [
      { members: [{}, {}] },
      { members: [{}] },
    ]),
    [{ kind: "member_count", groupIndex: 0, count: 2 }],
  );
  assert.deepEqual(
    tunnelIssues("tunnel", [
      { members: [{}] },
      { members: [{}] },
    ]),
    [],
  );
  // 非 tunnel 引擎不产生 tunnel 专属问题。
  assert.deepEqual(tunnelIssues("native", [{ members: [] }]), []);
});

test("chainEngineOptions keeps tunnel selectable and exposes topology readiness", () => {
  const invalid = chainEngineOptions(1, [1]);
  assert.deepEqual(
    invalid.map((option) => option.engine),
    ["native", "realm", "nftables", "tunnel"],
  );
  const tunnelOption = invalid.find((option) => option.engine === "tunnel");
  assert.equal(tunnelOption.experimental, true);
  assert.equal(tunnelOption.available, false);
  assert.equal(tunnelOption.labelKey, "common.engine.tunnel.label");
  // 其它引擎没有实验小标，也不会被 tunnel 的拓扑要求影响。
  assert.equal(
    invalid.find((option) => option.engine === "native").available,
    true,
  );
  assert.equal(
    invalid.find((option) => option.engine === "native").experimental,
    false,
  );

  const valid = chainEngineOptions(2, [1, 1]);
  assert.equal(
    valid.find((option) => option.engine === "tunnel").available,
    true,
  );
});

test("tunnel capability requires an explicit true", () => {
  assert.equal(serversMissingTunnel([]), false);
  assert.equal(serversMissingTunnel([{ tunnel_available: true }]), false);
  assert.equal(serversMissingTunnel([{ tunnel_available: false }]), true);
  assert.equal(serversMissingTunnel([{ tunnel_available: null }]), true);
  assert.equal(serversMissingTunnel([{}]), true);

  assert.deepEqual(
    missingTunnelServerNames([
      { name: " 香港-01 ", tunnel_available: true },
      { name: "日本-02", tunnel_available: false },
      { name: " 日本-02 ", tunnel_available: null },
      { name: "美国-04" },
      { name: "   ", tunnel_available: false },
    ]),
    ["日本-02", "美国-04"],
  );
  assert.deepEqual(missingTunnelServerNames([]), []);
});

test("tunnel error dictionary covers all five backend codes in both languages", () => {
  const codes = [
    "chain.tunnel_requires_two_hops",
    "chain.tunnel_single_member",
    "chain.tunnel_tcp_only",
    "chain.tunnel_transport_conflict",
    "chain.tunnel_unavailable",
  ];
  for (const code of codes) {
    assert.equal(typeof zhCN.errors[code], "string", `zh missing ${code}`);
    assert.equal(typeof en.errors[code], "string", `en missing ${code}`);
    assert.ok(zhCN.errors[code].trim().length > 0);
    assert.ok(en.errors[code].trim().length > 0);
  }
});

test("tunnel copy is bilingual and names its experimental limits", () => {
  assert.equal(lookup(zhCN, "common.engine.tunnel.label"), "tunnel");
  assert.equal(lookup(en, "common.engine.tunnel.label"), "tunnel");
  assert.equal(lookup(zhCN, "common.engine.tunnel.experimental"), "实验性");
  assert.equal(lookup(en, "common.engine.tunnel.experimental"), "Experimental");
  for (const dictionary of [zhCN, en]) {
    const desc = lookup(dictionary, "common.engine.tunnel.desc");
    assert.match(desc, /2\s*(跳|hops?)/);
    assert.match(desc, /TCP/);
    assert.match(desc, /CA/);
  }
  // 禁用的 title 说明 tunnel 自带加密，不能和跳间 TLS 同时开启。
  assert.match(
    lookup(zhCN, "chains.tls.tunnelDisabledTitle"),
    /tunnel.*加密/,
  );
  assert.match(
    lookup(en, "chains.tls.tunnelDisabledTitle"),
    /tunnel.*encrypt/i,
  );
});
