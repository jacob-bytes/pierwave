/**
 * 订阅模板编辑器的纯逻辑：表单 ↔ API payload、校验、预览按钮状态。
 *
 * 设置页是懒加载入口，不便在 node:test 里挂载 React，所以把可测的部分放这里。
 * 校验规则与后端 `crates/domain/src/subscription_template.rs` 保持一致：
 * 组名必填、每组至少一个筛选条件（空条件 `{}` = 全部节点）。
 */
import type {
  SubscriptionGroup,
  SubscriptionGroupFilter,
  SubscriptionGroupKind,
  SubscriptionTemplate,
} from "./api.ts";

/** 与后端一致：单个组名上限。 */
export const MAX_GROUP_NAME_CHARS = 32;
export const MAX_GROUPS = 16;
export const MAX_FILTERS_PER_GROUP = 8;
export const MAX_FILTER_VALUES = 16;
export const MAX_TAG_CHARS = 24;
export const MAX_REGION_CHARS = 8;
export const MIN_INTERVAL_SECS = 10;
export const MAX_INTERVAL_SECS = 86_400;
export const DEFAULT_INTERVAL_SECS = 300;

export const TEMPLATE_PROTOCOLS = ["vless", "vmess", "trojan", "ss"] as const;
export type TemplateProtocol = (typeof TEMPLATE_PROTOCOLS)[number];

export interface FilterDraft {
  /** 逗号分隔的标签输入。 */
  tags: string;
  /** 逗号分隔的地区输入。 */
  regions: string;
  protocols: TemplateProtocol[];
}

export interface GroupDraft {
  name: string;
  type: SubscriptionGroupKind;
  includeAuto: boolean;
  /** 秒；select 组忽略。 */
  interval: string;
  filters: FilterDraft[];
}

export interface TemplateDraft {
  name: string;
  groups: GroupDraft[];
}

export interface FilterPayload extends SubscriptionGroupFilter {}

/** 校验错误：`field` 用于表单定位，`code` 供 i18n 翻译。 */
export interface DraftError {
  code: string;
  field: string;
  index?: number;
  params?: Record<string, string | number>;
}

export function emptyFilterDraft(): FilterDraft {
  return { tags: "", regions: "", protocols: [] };
}

export function emptyGroupDraft(): GroupDraft {
  return {
    name: "",
    type: "select",
    includeAuto: false,
    interval: String(DEFAULT_INTERVAL_SECS),
    // 每组至少一个筛选条件；空条件 = 全部节点。
    filters: [emptyFilterDraft()],
  };
}

export function emptyTemplateDraft(): TemplateDraft {
  return { name: "", groups: [emptyGroupDraft()] };
}

/** 中英文逗号都当分隔符；trim、去空、去重、保持顺序。 */
export function splitList(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(/[,，]/)) {
    const value = part.trim();
    if (value !== "" && !out.includes(value)) out.push(value);
  }
  return out;
}

export function joinList(values: string[] | undefined | null): string {
  return (values ?? []).join(", ");
}

function draftFilterToPayload(filter: FilterDraft): FilterPayload {
  return {
    tags: splitList(filter.tags),
    regions: splitList(filter.regions),
    protocols: filter.protocols.filter((protocol) =>
      (TEMPLATE_PROTOCOLS as readonly string[]).includes(protocol),
    ),
  };
}

function draftInterval(group: GroupDraft): number | null {
  if (group.type !== "url-test") return null;
  const trimmed = group.interval.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** 表单 → API payload；校验通过后再调用。 */
export function groupsFromDraft(groups: GroupDraft[]): SubscriptionGroup[] {
  return groups.map((group) => {
    const interval = draftInterval(group);
    return {
      name: group.name.trim(),
      type: group.type,
      filters: group.filters.map(draftFilterToPayload),
      include_auto: group.type === "select" ? group.includeAuto : false,
      ...(interval === null ? {} : { interval }),
    };
  });
}

/** API 模板 → 表单；缺字段按默认值兜底。 */
export function draftFromTemplate(template: SubscriptionTemplate): TemplateDraft {
  return {
    name: template.name,
    groups: template.groups.map((group) => ({
      name: group.name,
      type: group.type,
      includeAuto: Boolean(group.include_auto),
      interval: String(group.interval ?? DEFAULT_INTERVAL_SECS),
      filters:
        group.filters.length > 0
          ? group.filters.map((filter) => ({
              tags: joinList(filter.tags),
              regions: joinList(filter.regions),
              protocols: (filter.protocols ?? []).filter((protocol) =>
                (TEMPLATE_PROTOCOLS as readonly string[]).includes(protocol),
              ) as TemplateProtocol[],
            }))
          : [emptyFilterDraft()],
    })),
  };
}

/**
 * 表单校验。返回第一条错误即可（表单一次只展示一处），但保留全部便于测试。
 *
 * 与后端规则的差异只有一处：这里把「组名重复」也当前端错误，省一次 400 往返。
 */
export function validateTemplateDraft(draft: TemplateDraft): DraftError[] {
  const errors: DraftError[] = [];
  if (draft.name.trim() === "") {
    errors.push({ code: "nameRequired", field: "name" });
  } else if (draft.name.trim().length > MAX_GROUP_NAME_CHARS) {
    errors.push({
      code: "nameTooLong",
      field: "name",
      params: { max: MAX_GROUP_NAME_CHARS },
    });
  }
  if (draft.groups.length === 0) {
    errors.push({ code: "groupsRequired", field: "groups" });
  }
  if (draft.groups.length > MAX_GROUPS) {
    errors.push({
      code: "tooManyGroups",
      field: "groups",
      params: { max: MAX_GROUPS },
    });
  }

  const seenNames = new Set<string>();
  draft.groups.forEach((group, index) => {
    const name = group.name.trim();
    if (name === "") {
      errors.push({
        code: "groupNameRequired",
        field: "groups",
        index,
      });
    } else if (name.length > MAX_GROUP_NAME_CHARS) {
      errors.push({
        code: "groupNameTooLong",
        field: "groups",
        index,
        params: { max: MAX_GROUP_NAME_CHARS },
      });
    } else if (seenNames.has(name)) {
      errors.push({
        code: "groupNameTaken",
        field: "groups",
        index,
        params: { name },
      });
    }
    seenNames.add(name);

    if (group.filters.length === 0) {
      errors.push({ code: "filtersRequired", field: "groups", index });
    } else if (group.filters.length > MAX_FILTERS_PER_GROUP) {
      errors.push({
        code: "tooManyFilters",
        field: "groups",
        index,
        params: { max: MAX_FILTERS_PER_GROUP },
      });
    }

    group.filters.forEach((filter, filterIndex) => {
      const tags = splitList(filter.tags);
      const regions = splitList(filter.regions);
      if (tags.length > MAX_FILTER_VALUES || regions.length > MAX_FILTER_VALUES) {
        errors.push({
          code: "tooManyValues",
          field: "groups",
          index,
          params: { max: MAX_FILTER_VALUES, filter: filterIndex + 1 },
        });
      }
      if (tags.some((tag) => tag.length > MAX_TAG_CHARS)) {
        errors.push({
          code: "tagTooLong",
          field: "groups",
          index,
          params: { max: MAX_TAG_CHARS, filter: filterIndex + 1 },
        });
      }
      if (regions.some((region) => region.length > MAX_REGION_CHARS)) {
        errors.push({
          code: "regionTooLong",
          field: "groups",
          index,
          params: { max: MAX_REGION_CHARS, filter: filterIndex + 1 },
        });
      }
      if (filter.protocols.length > MAX_FILTER_VALUES) {
        errors.push({
          code: "tooManyValues",
          field: "groups",
          index,
          params: { max: MAX_FILTER_VALUES, filter: filterIndex + 1 },
        });
      }
    });

    if (group.type === "url-test") {
      const interval = draftInterval(group);
      if (
        interval === null ||
        interval < MIN_INTERVAL_SECS ||
        interval > MAX_INTERVAL_SECS
      ) {
        errors.push({
          code: "intervalInvalid",
          field: "groups",
          index,
          params: { min: MIN_INTERVAL_SECS, max: MAX_INTERVAL_SECS },
        });
      }
    }
  });

  return errors;
}

/** 预览按钮：只有已保存的模板 + 选中的用户 + 空闲状态才可点。 */
export function previewDisabled(state: {
  pending: boolean;
  hasTemplate: boolean;
  hasUser: boolean;
}): boolean {
  return state.pending || !state.hasTemplate || !state.hasUser;
}

/** 组内成员摘要：`全部节点` / `标签: 香港`，用于列表页。 */
export function groupFilterSummary(filters: SubscriptionGroupFilter[]): string[] {
  return filters.map((filter) => {
    const parts: string[] = [];
    if (filter.tags && filter.tags.length > 0) {
      parts.push(`#${filter.tags.join("/")}`);
    }
    if (filter.regions && filter.regions.length > 0) {
      parts.push(`@${filter.regions.join("/")}`);
    }
    if (filter.protocols && filter.protocols.length > 0) {
      parts.push(filter.protocols.join("/"));
    }
    return parts.length > 0 ? parts.join(" ") : "*";
  });
}

/** 「无模板」哨兵：Radix Select 不接受空字符串作为 item value。 */
export const SUBSCRIPTION_TEMPLATE_INHERIT = "__none__";

export function subscriptionTemplateToSelectValue(
  value: string | null | undefined,
): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? SUBSCRIPTION_TEMPLATE_INHERIT : trimmed;
}

export function subscriptionTemplateFromSelectValue(value: string): string {
  return value === SUBSCRIPTION_TEMPLATE_INHERIT ? "" : value;
}

/** 表单里的空值 → 显式 `null`（不绑定），而不是省略字段。 */
export function subscriptionTemplateInputValue(
  value: string | null | undefined,
): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}
