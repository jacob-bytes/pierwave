import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INTERVAL_SECS,
  MAX_REGION_CHARS,
  MAX_TAG_CHARS,
  draftFromTemplate,
  emptyFilterDraft,
  emptyGroupDraft,
  emptyTemplateDraft,
  groupFilterSummary,
  groupsFromDraft,
  joinList,
  previewDisabled,
  splitList,
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
    { tags: [], regions: [], protocols: [] },
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
    filters: [{ tags: ["香港", "中转"], regions: ["HK"], protocols: ["vless"] }],
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

test("preview button is disabled without a saved template or a selected user", () => {
  assert.equal(
    previewDisabled({ pending: false, hasTemplate: true, hasUser: true }),
    false,
  );
  assert.equal(
    previewDisabled({ pending: false, hasTemplate: false, hasUser: true }),
    true,
  );
  assert.equal(
    previewDisabled({ pending: false, hasTemplate: true, hasUser: false }),
    true,
  );
  assert.equal(
    previewDisabled({ pending: true, hasTemplate: true, hasUser: true }),
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
