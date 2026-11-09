import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_FORWARD_ENGINE,
  FORWARD_ENGINES,
  chainEngineMissing,
  engineInput,
  engineMeta,
  engineMissing,
  forwardEngineMissing,
  isForwardEngine,
  normalizeEngine,
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
  assert.deepEqual([...FORWARD_ENGINES], ["native", "realm"]);
  assert.equal(DEFAULT_FORWARD_ENGINE, "native");
});

test("isForwardEngine accepts only the two documented values", () => {
  assert.equal(isForwardEngine("native"), true);
  assert.equal(isForwardEngine("realm"), true);

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
  assert.equal(lookup(zhCN, "common.engine.native.label"), "自带");
  assert.equal(lookup(zhCN, "common.engine.realm.label"), "realm");
  assert.equal(lookup(en, "common.engine.native.label"), "Native");
  assert.equal(lookup(en, "common.engine.realm.label"), "realm");
});

const ENGINE_I18N_KEYS = [
  "common.engine.native.label",
  "common.engine.native.short",
  "common.engine.native.desc",
  "common.engine.realm.label",
  "common.engine.realm.short",
  "common.engine.realm.desc",
  "common.engine.unknown.label",
  "common.engine.unknown.desc",
  "forwards.engine.missing",
  "forwards.engine.missingHint",
  "forwards.engine.missingTitle",
  "forwards.form.engine",
  "forwards.form.engineHint",
  "forwards.form.engineAria",
  "chains.engine.missing",
  "chains.engine.missingHint",
  "chains.engine.missingTitle",
  "chains.engine.memberMissing",
  "chains.engine.memberMissingTitle",
  "chains.form.engine",
  "chains.form.engineHint",
  "chains.form.engineAria",
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
