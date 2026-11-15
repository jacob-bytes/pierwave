import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INTERVAL_SECS,
  MAX_NAME_CONTAINS_CHARS,
  MAX_REGION_CHARS,
  MAX_TAG_CHARS,
  copyTemplateDraft,
  draftFromTemplate,
  emptyFilterDraft,
  emptyGroupDraft,
  emptyTemplateDraft,
  groupFilterSummary,
  groupsFromDraft,
  joinList,
  moveGroup,
  parsePreviewSubject,
  previewDisabled,
  previewSubjectValue,
  resolvePreviewFormat,
  splitList,
  templateUsage,
  uniqueTemplateName,
  validateTemplateDraft,
} from "./subscriptionTemplates.ts";

test("splitList trims, drops empties, dedupes and accepts both comma styles", () => {
  assert.deepEqual(splitList(" 香港 , 中转，香港 ,, 日本 "), [
    "香港",
    "中转",
    "日本",
  ]);
  assert.deepEqual(splitList(""), []);
  assert.deepEqual(splitList("，，"), []);
});

test("joinList round-trips through splitList", () => {
  assert.equal(joinList(["香港", "中转"]), "香港, 中转");
  assert.deepEqual(splitList(joinList(["HK", "JP"])), ["HK", "JP"]);
  assert.equal(joinList(null), "");
});

test("empty template draft is invalid until a name is filled in", () => {
  const draft = emptyTemplateDraft();
  const errors = validateTemplateDraft(draft);
  assert.deepEqual(
    errors.map((error) => error.code),
    ["nameRequired", "groupNameRequired"],
  );

  draft.name = "常用分组";
  draft.groups[0].name = "节点选择";
  // 默认带一个空 filter（= 全部节点），所以已经合法。
  assert.deepEqual(validateTemplateDraft(draft), []);
});

test("group name is required and must be unique", () => {
  const draft = emptyTemplateDraft();
  draft.name = "模板";
  draft.groups = [emptyGroupDraft(), emptyGroupDraft()];
  draft.groups[0].name = "节点选择";
  draft.groups[1].name = "节点选择";
  const errors = validateTemplateDraft(draft);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "groupNameTaken");
  assert.equal(errors[0].index, 1);

  draft.groups[1].name = "   ";
  assert.equal(validateTemplateDraft(draft)[0].code, "groupNameRequired");
});

test("a group without any filter is rejected; an empty filter means all nodes", () => {
  const draft = emptyTemplateDraft();
  draft.name = "模板";
  draft.groups[0].name = "节点选择";
  draft.groups[0].filters = [];
  assert.equal(validateTemplateDraft(draft)[0].code, "filtersRequired");

  // 空条件 `{}`（表单里 tags/regions 为空、protocols 为空）合法。
  draft.groups[0].filters = [emptyFilterDraft()];
  assert.deepEqual(validateTemplateDraft(draft), []);
  assert.deepEqual(groupsFromDraft(draft.groups)[0].filters, [
    {
      tags: [],
      regions: [],
      protocols: [],
      exclude_tags: [],
      exclude_regions: [],
      exclude_protocols: [],
    },
  ]);
});

test("url-test interval must be a number inside the backend range", () => {
  const draft = emptyTemplateDraft();
  draft.name = "模板";
  draft.groups[0].name = "自动选择";
  draft.groups[0].type = "url-test";
  assert.deepEqual(validateTemplateDraft(draft), [], "默认 300 合法");

  draft.groups[0].interval = "5";
  assert.equal(validateTemplateDraft(draft)[0].code, "intervalInvalid");
  draft.groups[0].interval = "abc";
  assert.equal(validateTemplateDraft(draft)[0].code, "intervalInvalid");
  draft.groups[0].interval = "";
  assert.equal(validateTemplateDraft(draft)[0].code, "intervalInvalid");

  // select 组忽略 interval。
  draft.groups[0].type = "select";
  draft.groups[0].interval = "abc";
  assert.deepEqual(validateTemplateDraft(draft), []);
});

test("filter values are length-checked like the node metadata limits", () => {
  const draft = emptyTemplateDraft();
  draft.name = "模板";
  draft.groups[0].name = "节点选择";
  draft.groups[0].filters[0].tags = "x".repeat(MAX_TAG_CHARS + 1);
  assert.equal(validateTemplateDraft(draft)[0].code, "tagTooLong");

  draft.groups[0].filters[0].tags = "";
  draft.groups[0].filters[0].regions = "y".repeat(MAX_REGION_CHARS + 1);
  assert.equal(validateTemplateDraft(draft)[0].code, "regionTooLong");

  draft.groups[0].filters[0].regions = "";
  assert.deepEqual(validateTemplateDraft(draft), []);
});

test("groupsFromDraft produces the declarative payload and drops select intervals", () => {
  const draft = emptyTemplateDraft();
  draft.name = "模板";
  draft.groups = [
    {
      name: " 节点选择 ",
      type: "select",
      includeAuto: true,
      interval: "999",
      filters: [{ tags: "香港, 中转", regions: "HK", protocols: ["vless"] }],
    },
    {
      name: "自动选择",
      type: "url-test",
      includeAuto: false,
      interval: "120",
      filters: [emptyFilterDraft()],
    },
  ];
  const groups = groupsFromDraft(draft.groups);
  assert.deepEqual(groups[0], {
    name: "节点选择",
    type: "select",
    filters: [
      {
        tags: ["香港", "中转"],
        regions: ["HK"],
        protocols: ["vless"],
        exclude_tags: [],
        exclude_regions: [],
        exclude_protocols: [],
      },
    ],
    include_auto: true,
  });
  assert.equal(groups[1].interval, 120);
  assert.equal(groups[1].include_auto, false);
});

test("draftFromTemplate round-trips a saved template", () => {
  const template = {
    id: "tpl",
    name: "常用",
    created_at: 0,
    updated_at: 0,
    groups: [
      {
        name: "节点选择",
        type: "select",
        filters: [{ tags: ["香港"], regions: ["HK"], protocols: ["vless"] }],
        include_auto: true,
      },
      {
        name: "自动选择",
        type: "url-test",
        filters: [{}],
        interval: 120,
      },
    ],
  };
  const draft = draftFromTemplate(template);
  assert.equal(draft.name, "常用");
  assert.equal(draft.groups[0].filters[0].tags, "香港");
  assert.equal(draft.groups[1].interval, "120");
  assert.deepEqual(
    groupsFromDraft(draft.groups),
    template.groups.map((group) => ({
      ...group,
      include_auto: Boolean(group.include_auto),
      filters: group.filters.map((filter) => ({
        tags: filter.tags ?? [],
        regions: filter.regions ?? [],
        protocols: filter.protocols ?? [],
        exclude_tags: filter.exclude_tags ?? [],
        exclude_regions: filter.exclude_regions ?? [],
        exclude_protocols: filter.exclude_protocols ?? [],
      })),
    })),
  );

  // 没有 filters 的脏模板也要给出一个空条件，避免编辑器直接非法。
  const dirty = draftFromTemplate({ ...template, groups: [{
    name: "全部",
    type: "select",
    filters: [],
  }] });
  assert.equal(dirty.groups[0].filters.length, 1);
});

test("preview button is disabled without a saved template or a selected subject", () => {
  assert.equal(
    previewDisabled({ pending: false, hasTemplate: true, hasSubject: true }),
    false,
  );
  assert.equal(
    previewDisabled({ pending: false, hasTemplate: false, hasSubject: true }),
    true,
  );
  assert.equal(
    previewDisabled({ pending: false, hasTemplate: true, hasSubject: false }),
    true,
  );
  assert.equal(
    previewDisabled({ pending: true, hasTemplate: true, hasSubject: true }),
    true,
  );
});

test("groupFilterSummary marks the catch-all filter with *", () => {
  assert.deepEqual(groupFilterSummary([{}, { tags: ["香港"] }]), ["*", "#香港"]);
  assert.deepEqual(
    groupFilterSummary([{ regions: ["HK"], protocols: ["vless"] }]),
    ["@HK vless"],
  );
});

test("default interval constant matches the backend fallback", () => {
  assert.equal(DEFAULT_INTERVAL_SECS, 300);
  assert.equal(emptyGroupDraft().interval, "300");
});

test("subscription template binding sentinel helpers", async () => {
  const {
    SUBSCRIPTION_TEMPLATE_INHERIT,
    subscriptionTemplateFromSelectValue,
    subscriptionTemplateInputValue,
    subscriptionTemplateToSelectValue,
  } = await import("./subscriptionTemplates.ts");
  assert.equal(subscriptionTemplateToSelectValue(null), SUBSCRIPTION_TEMPLATE_INHERIT);
  assert.equal(subscriptionTemplateToSelectValue("  "), SUBSCRIPTION_TEMPLATE_INHERIT);
  assert.equal(subscriptionTemplateToSelectValue(" tpl "), "tpl");
  assert.equal(subscriptionTemplateFromSelectValue(SUBSCRIPTION_TEMPLATE_INHERIT), "");
  assert.equal(subscriptionTemplateFromSelectValue("tpl"), "tpl");
  assert.equal(subscriptionTemplateInputValue(""), null);
  assert.equal(subscriptionTemplateInputValue(" tpl "), "tpl");
});

// ---------------------------------------------------------------------------
// 第二轮：排除条件 / name_contains / 新组类型 / 拖拽 / 复制 / 预览格式
// ---------------------------------------------------------------------------

test("filters emit exclusion conditions and a trimmed name_contains substring", () => {
  const group = {
    ...emptyGroupDraft(),
    name: "香港-可用",
    filters: [
      {
        ...emptyFilterDraft(),
        tags: "香港",
        excludeTags: "中转, 测试，中转",
        excludeRegions: "US",
        excludeProtocols: ["ss"],
        nameContains: " HK ",
      },
    ],
  };
  const payload = groupsFromDraft([group])[0];
  assert.deepEqual(payload.filters[0], {
    tags: ["香港"],
    regions: [],
    protocols: [],
    exclude_tags: ["中转", "测试"],
    exclude_regions: ["US"],
    exclude_protocols: ["ss"],
    name_contains: "HK",
  });

  // 空的 name_contains 不写进 payload（空 = 不限制）。
  const empty = groupsFromDraft([
    { ...group, filters: [{ ...emptyFilterDraft(), nameContains: "  " }] },
  ])[0];
  assert.equal("name_contains" in empty.filters[0], false);
});

test("load-balance strategy defaults to round-robin and is dropped for other kinds", () => {
  const loadBalance = { ...emptyGroupDraft(), name: "负载", type: "load-balance" };
  assert.equal(groupsFromDraft([loadBalance])[0].strategy, "round-robin");
  loadBalance.strategy = "consistent-hashing";
  assert.equal(groupsFromDraft([loadBalance])[0].strategy, "consistent-hashing");

  const fallback = { ...emptyGroupDraft(), name: "备用", type: "fallback" };
  assert.equal(groupsFromDraft([fallback])[0].strategy, undefined);
  assert.equal(groupsFromDraft([fallback])[0].include_auto, false);

  const select = { ...emptyGroupDraft(), name: "选择", includeAuto: true };
  assert.equal(groupsFromDraft([select])[0].strategy, undefined);
  assert.equal(groupsFromDraft([select])[0].include_auto, true);
});

test("fallback and load-balance validate their interval like url-test", () => {
  for (const type of ["url-test", "fallback", "load-balance"]) {
    const draft = emptyTemplateDraft();
    draft.name = "模板";
    draft.groups[0] = { ...emptyGroupDraft(), name: "自动", type, interval: "5" };
    assert.equal(validateTemplateDraft(draft)[0].code, "intervalInvalid", type);
    draft.groups[0].interval = "120";
    assert.deepEqual(validateTemplateDraft(draft), [], type);
  }
});

test("name_contains and exclusion values are length-checked", () => {
  const draft = emptyTemplateDraft();
  draft.name = "模板";
  draft.groups[0].name = "节点选择";
  draft.groups[0].filters[0].nameContains = "x".repeat(MAX_NAME_CONTAINS_CHARS + 1);
  assert.equal(validateTemplateDraft(draft)[0].code, "nameContainsTooLong");

  draft.groups[0].filters[0].nameContains = "";
  draft.groups[0].filters[0].excludeTags = "x".repeat(MAX_TAG_CHARS + 1);
  assert.equal(validateTemplateDraft(draft)[0].code, "tagTooLong");

  draft.groups[0].filters[0].excludeTags = "";
  draft.groups[0].filters[0].excludeRegions = "y".repeat(MAX_REGION_CHARS + 1);
  assert.equal(validateTemplateDraft(draft)[0].code, "regionTooLong");
});

test("draftFromTemplate keeps exclusions, name_contains and strategy", () => {
  const template = {
    id: "tpl",
    name: "负载",
    created_at: 0,
    updated_at: 0,
    groups: [
      {
        name: "哈希负载",
        type: "load-balance",
        strategy: "consistent-hashing",
        interval: 60,
        filters: [
          {
            tags: ["香港"],
            exclude_tags: ["中转"],
            exclude_regions: ["US"],
            exclude_protocols: ["ss"],
            name_contains: "HK",
          },
        ],
      },
    ],
  };
  const draft = draftFromTemplate(template);
  assert.equal(draft.groups[0].strategy, "consistent-hashing");
  assert.equal(draft.groups[0].interval, "60");
  assert.equal(draft.groups[0].filters[0].excludeTags, "中转");
  assert.equal(draft.groups[0].filters[0].excludeRegions, "US");
  assert.deepEqual(draft.groups[0].filters[0].excludeProtocols, ["ss"]);
  assert.equal(draft.groups[0].filters[0].nameContains, "HK");

  const payload = groupsFromDraft(draft.groups)[0];
  assert.deepEqual(payload, {
    name: "哈希负载",
    type: "load-balance",
    filters: [
      {
        tags: ["香港"],
        regions: [],
        protocols: [],
        exclude_tags: ["中转"],
        exclude_regions: ["US"],
        exclude_protocols: ["ss"],
        name_contains: "HK",
      },
    ],
    include_auto: false,
    interval: 60,
    strategy: "consistent-hashing",
  });
});

test("moveGroup reorders groups and tolerates invalid indexes", () => {
  const groups = ["a", "b", "c", "d"];
  assert.deepEqual(moveGroup(groups, 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveGroup(groups, 3, 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveGroup(groups, 1, 1), groups);
  assert.deepEqual(moveGroup(groups, -1, 2), groups);
  assert.deepEqual(moveGroup(groups, 0, 9), groups);
  // 原数组不被修改（React state 依赖这一点）。
  assert.deepEqual(groups, ["a", "b", "c", "d"]);
});

test("copied template draft gets a unique name and is independent from the original", () => {
  const template = {
    id: "tpl",
    name: "常用",
    created_at: 0,
    updated_at: 0,
    groups: [
      {
        name: "节点选择",
        type: "select",
        filters: [{ tags: ["香港"], name_contains: "HK" }],
        include_auto: true,
      },
    ],
  };
  const copy = copyTemplateDraft(template, ["常用"]);
  assert.equal(copy.name, "常用 (copy)");
  assert.equal(copy.groups[0].name, "节点选择");

  // 改副本不影响原件（组、filter、名称都是独立对象）。
  copy.groups[0].name = "副本组";
  copy.groups[0].filters[0].tags = "日本";
  copy.groups[0].filters[0].nameContains = "JP";
  copy.groups.push(emptyGroupDraft());
  assert.equal(template.groups.length, 1);
  assert.equal(template.groups[0].name, "节点选择");
  assert.deepEqual(template.groups[0].filters[0].tags, ["香港"]);
  assert.equal(template.groups[0].filters[0].name_contains, "HK");

  assert.equal(uniqueTemplateName("常用", ["常用"]), "常用 (copy)");
  assert.equal(
    uniqueTemplateName("常用", ["常用", "常用 (copy)"]),
    "常用 (copy) 2",
  );
  assert.equal(
    copyTemplateDraft(template, ["常用", "常用 (copy)"]).name,
    "常用 (copy) 2",
  );
});

test("preview format fuzzy matching covers every template-aware exporter", () => {
  const cases = [
    ["", "mihomo"],
    ["mihomo", "mihomo"],
    ["Clash", "clash"],
    ["Clash Meta", "mihomo"],
    ["Stash", "stash"],
    ["sing-box", "singbox"],
    ["sing box full", "singbox-full"],
    ["Surge", "surge"],
    ["surge full", "surge-full"],
    ["SING_BOX", "singbox"],
    // 第三轮接入的三种格式：精确 id 与模糊写法都要能解析。
    ["Surfboard", "surfboard"],
    ["surf board", "surfboard"],
    ["Loon", "loon"],
    ["Egern", "egern"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolvePreviewFormat(input), expected, input);
  }
  // 不支持模板分组的格式仍然返回 null，预览会给出 400 而不是塞回 YAML。
  assert.equal(resolvePreviewFormat("qx"), null);
  assert.equal(resolvePreviewFormat("shadowrocket"), null);
  assert.equal(resolvePreviewFormat("not-a-client"), null);
});

test("templateUsage treats missing or dirty counts as unused", () => {
  assert.deepEqual(templateUsage(undefined), {
    users: 0,
    packages: 0,
    inUse: false,
  });
  assert.deepEqual(templateUsage({ users: 3, packages: 2 }), {
    users: 3,
    packages: 2,
    inUse: true,
  });
  // 只有套餐绑定时也算使用中。
  assert.deepEqual(templateUsage({ users: 0, packages: 1 }), {
    users: 0,
    packages: 1,
    inUse: true,
  });
  // 负数是脏数据，展示层归零。
  assert.deepEqual(templateUsage({ users: -1, packages: -2 }), {
    users: 0,
    packages: 0,
    inUse: false,
  });
});

test("preview subject values round-trip user and package ids", () => {
  const user = { kind: "user", id: "u-1" };
  const pkg = { kind: "package", id: "p-2" };
  assert.equal(previewSubjectValue(user), "user:u-1");
  assert.equal(previewSubjectValue(pkg), "package:p-2");
  assert.deepEqual(parsePreviewSubject("user:u-1"), user);
  assert.deepEqual(parsePreviewSubject("package:p-2"), pkg);
  // 空 id / 未知前缀都不能成为合法预览对象。
  assert.equal(parsePreviewSubject("user:"), null);
  assert.equal(parsePreviewSubject(":u-1"), null);
  assert.equal(parsePreviewSubject("group:g-1"), null);
  assert.equal(parsePreviewSubject(""), null);
});

test("groupFilterSummary shows exclusions and name_contains", () => {
  assert.deepEqual(
    groupFilterSummary([
      { exclude_tags: ["中转"], name_contains: "HK" },
      { exclude_regions: ["US"], exclude_protocols: ["ss"] },
    ]),
    ["!#中转 ~HK", "!@US !ss"],
  );
});
