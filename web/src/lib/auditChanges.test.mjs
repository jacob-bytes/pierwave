import assert from "node:assert/strict";
import test from "node:test";
import { setCurrentLocale } from "../i18n/locale.ts";
import {
  formatChangeText,
  formatChanges,
  formatFieldLabel,
  formatFieldValue,
} from "./auditChanges.ts";

const UUID_A = "c5e6acd0-1785-461d-b115-65b311620151";
const UUID_B = "0f9a1e42-7d3c-4a55-9b18-2e6f4c8d1a07";

/** 任务要求至少覆盖的字段；任何一个落到「下划线换空格」都算漏翻。 */
const REQUIRED_FIELDS = [
  "rule_template_id",
  "node_scope",
  "node_count",
  "node_ids",
  "quota_bytes",
  "quota_override",
  "status",
  "role",
  "panel_name",
  "name",
  "username",
  "package_id",
  "package_name",
  "xray_mode",
  "port",
  "tag",
  "enabled",
  "expires_at",
];

function withLocale(locale, fn) {
  setCurrentLocale(locale);
  try {
    fn();
  } finally {
    setCurrentLocale("en");
  }
}

const noResolve = () => undefined;

test("known field names are translated in both languages", () => {
  withLocale("zh-CN", () => {
    assert.equal(formatFieldLabel("rule_template_id"), "规则模板");
    assert.equal(formatFieldLabel("node_scope"), "节点范围");
    assert.equal(formatFieldLabel("node_count"), "节点数");
    assert.equal(formatFieldLabel("quota_override"), "流量覆写");
    assert.equal(formatFieldLabel("panel_name"), "面板名称");
    assert.equal(formatFieldLabel("xray_mode"), "Xray 模式");
    assert.equal(formatFieldLabel("expires_at"), "到期时间");
  });
  withLocale("en", () => {
    assert.equal(formatFieldLabel("rule_template_id"), "Rule template");
    assert.equal(formatFieldLabel("node_scope"), "Node scope");
    assert.equal(formatFieldLabel("node_count"), "Node count");
    assert.equal(formatFieldLabel("quota_override"), "Quota override");
    assert.equal(formatFieldLabel("panel_name"), "Panel name");
    assert.equal(formatFieldLabel("xray_mode"), "Xray mode");
    assert.equal(formatFieldLabel("expires_at"), "Expires at");
  });
});

test("every required field is mapped in both dictionaries", () => {
  for (const locale of ["zh-CN", "en"]) {
    withLocale(locale, () => {
      for (const field of REQUIRED_FIELDS) {
        const fallback = field.replace(/_/g, " ");
        assert.notEqual(
          formatFieldLabel(field),
          fallback,
          `${locale}: ${field} is missing a translation`,
        );
      }
    });
  }
});

test("unknown field names fall back to spaces instead of underscores", () => {
  withLocale("zh-CN", () => {
    assert.equal(formatFieldLabel("some_new_field"), "some new field");
  });
  withLocale("en", () => {
    assert.equal(formatFieldLabel("another_unknown_one"), "another unknown one");
  });
});

test("null and undefined render as unset", () => {
  withLocale("zh-CN", () => {
    assert.equal(formatFieldValue("quota_bytes", null), "未设置");
    assert.equal(formatFieldValue("quota_bytes", undefined), "未设置");
  });
  withLocale("en", () => {
    assert.equal(formatFieldValue("quota_bytes", null), "Not set");
    assert.equal(formatFieldValue("quota_bytes", undefined), "Not set");
  });
});

test("the real rule_template_id detail becomes a human-readable change", () => {
  withLocale("zh-CN", () => {
    const detail = {
      username: "alice",
      changes: {
        rule_template_id: { from: null, to: UUID_A },
      },
      node_scope: { from: "all", to: "custom" },
      node_count: { from: 3, to: 2 },
    };
    const calls = [];
    const items = formatChanges(detail, (kind, id) => {
      calls.push([kind, id]);
      return "流媒体分流";
    });

    assert.deepEqual(calls, [["rule_template", UUID_A]]);
    assert.deepEqual(items, [
      { label: "规则模板", from: "未设置", to: "流媒体分流" },
      { label: "节点范围", from: "全部", to: "自定义" },
      { label: "节点数", from: "3", to: "2" },
    ]);
    assert.equal(
      formatChangeText(items[0]),
      "规则模板：未设置 → 流媒体分流",
    );
  });
});

test("UUIDs that cannot be resolved fall back to the first 8 characters", () => {
  withLocale("zh-CN", () => {
    const detail = {
      changes: {
        rule_template_id: { from: UUID_A, to: UUID_B },
        package_id: { from: UUID_A, to: UUID_B },
      },
    };
    const items = formatChanges(detail, () => null);

    assert.equal(items[0].from, "c5e6acd0…");
    assert.equal(items[0].to, "0f9a1e42…");
    assert.equal(items[1].label, "套餐");
    assert.equal(items[1].from, "c5e6acd0…");
  });
});

test("non-UUID ids are not sent to the resolver", () => {
  withLocale("zh-CN", () => {
    let called = false;
    const items = formatChanges(
      { changes: { user_id: { from: "alice", to: "bob" } } },
      () => {
        called = true;
        return "should not appear";
      },
    );
    assert.equal(called, false);
    assert.deepEqual(items, [
      { label: "用户", from: "alice", to: "bob" },
    ]);
  });
});

test("a throwing resolver degrades to the id prefix instead of breaking the row", () => {
  withLocale("zh-CN", () => {
    const items = formatChanges(
      { changes: { package_id: { from: UUID_A, to: UUID_B } } },
      () => {
        throw new Error("cache unavailable");
      },
    );
    assert.deepEqual(items, [
      { label: "套餐", from: "c5e6acd0…", to: "0f9a1e42…" },
    ]);
  });
});

test("booleans render as yes/no", () => {
  withLocale("zh-CN", () => {
    const items = formatChanges(
      { changes: { enabled: { from: true, to: false } } },
      noResolve,
    );
    assert.deepEqual(items, [{ label: "启用", from: "是", to: "否" }]);
  });
  withLocale("en", () => {
    const items = formatChanges(
      { changes: { enabled: { from: true, to: false } } },
      noResolve,
    );
    assert.deepEqual(items, [{ label: "Enabled", from: "Yes", to: "No" }]);
  });
});

test("node_scope maps all/custom, other scopes stay raw", () => {
  withLocale("zh-CN", () => {
    assert.deepEqual(
      formatChanges(
        { changes: { node_scope: { from: "all", to: "custom" } } },
        noResolve,
      ),
      [{ label: "节点范围", from: "全部", to: "自定义" }],
    );
    assert.deepEqual(
      formatChanges(
        { changes: { node_scope: { from: "unknown", to: "custom" } } },
        noResolve,
      ),
      [{ label: "节点范围", from: "unknown", to: "自定义" }],
    );
  });
});

test("arrays render as item counts and numbers stay unit-free", () => {
  withLocale("zh-CN", () => {
    const items = formatChanges(
      {
        changes: {
          node_ids: { from: ["a", "b", "c"], to: ["a", "b"] },
          quota_bytes: { from: 1_073_741_824, to: 2_147_483_648 },
        },
      },
      noResolve,
    );
    assert.deepEqual(items, [
      { label: "节点", from: "3 项", to: "2 项" },
      { label: "流量额度", from: "1073741824", to: "2147483648" },
    ]);
  });
});

test("empty, array and non-object details do not throw", () => {
  for (const detail of [
    undefined,
    null,
    {},
    [],
    "not an object",
    42,
    true,
  ]) {
    assert.deepEqual(formatChanges(detail, noResolve), []);
  }
  assert.deepEqual(
    formatChanges({ changes: "broken", name: "still no diff" }, noResolve),
    [],
  );
});

test("top-level diffs and nested changes are merged without duplicates", () => {
  withLocale("zh-CN", () => {
    const items = formatChanges(
      {
        name: { from: "old", to: "new" },
        changes: {
          name: { from: "old", to: "new" },
          role: { from: "user", to: "admin" },
        },
      },
      noResolve,
    );
    assert.deepEqual(items, [
      { label: "名称", from: "old", to: "new" },
      { label: "角色", from: "user", to: "admin" },
    ]);
  });
});

test("English output uses the same shape and localized punctuation", () => {
  withLocale("en", () => {
    const items = formatChanges(
      {
        changes: { rule_template_id: { from: null, to: UUID_A } },
      },
      () => "Streaming split",
    );
    assert.deepEqual(items, [
      { label: "Rule template", from: "Not set", to: "Streaming split" },
    ]);
    assert.equal(
      formatChangeText(items[0]),
      "Rule template: Not set → Streaming split",
    );
  });
});
