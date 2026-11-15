/**
 * 订阅模板编辑器的纯逻辑：表单 ↔ API payload、校验、预览按钮状态、排序与复制。
 *
 * 设置页是懒加载入口，不便在 node:test 里挂载 React，所以把可测的部分放这里。
 * 校验规则与后端 `crates/domain/src/subscription_template.rs` 保持一致：
 * 组名必填、每组至少一个筛选条件（空条件 `{}` = 全部节点）、排除条件优先。
 */
import type {
  SubscriptionGroup,
  SubscriptionGroupFilter,
  SubscriptionGroupKind,
  SubscriptionLoadBalanceStrategy,
  SubscriptionTemplate,
} from "./api.ts";

/** 与后端一致：单个组名上限。 */
export const MAX_GROUP_NAME_CHARS = 32;
export const MAX_GROUPS = 16;
export const MAX_FILTERS_PER_GROUP = 8;
export const MAX_FILTER_VALUES = 16;
export const MAX_TAG_CHARS = 24;
export const MAX_REGION_CHARS = 8;
/** `name_contains` 只做子串，不做正则；长度上限与后端一致。 */
export const MAX_NAME_CONTAINS_CHARS = 64;
export const MIN_INTERVAL_SECS = 10;
export const MAX_INTERVAL_SECS = 86_400;
export const DEFAULT_INTERVAL_SECS = 300;

export const TEMPLATE_PROTOCOLS = ["vless", "vmess", "trojan", "ss"] as const;
export type TemplateProtocol = (typeof TEMPLATE_PROTOCOLS)[number];

export const TEMPLATE_GROUP_KINDS = [
  "select",
  "url-test",
  "fallback",
  "load-balance",
] as const;

export const LOAD_BALANCE_STRATEGIES = [
  "round-robin",
  "consistent-hashing",
] as const;

export const DEFAULT_LOAD_BALANCE_STRATEGY: SubscriptionLoadBalanceStrategy =
  "round-robin";

/** 自动测速类组：需要 interval，成员只能是节点。 */
export function isAutoGroupKind(kind: SubscriptionGroupKind): boolean {
  return kind === "url-test" || kind === "fallback" || kind === "load-balance";
}

export interface FilterDraft {
  /** 逗号分隔的标签输入。 */
  tags: string;
  /** 逗号分隔的地区输入。 */
  regions: string;
  protocols: TemplateProtocol[];
  /** 排除条件优先于包含条件。 */
  excludeTags: string;
  excludeRegions: string;
  excludeProtocols: TemplateProtocol[];
  /** 节点名子串（大小写不敏感，不是正则）。 */
  nameContains: string;
}

export interface GroupDraft {
  name: string;
  type: SubscriptionGroupKind;
  includeAuto: boolean;
  /** 秒；仅自动测速类组使用。 */
  interval: string;
  /** 仅 load-balance 使用。 */
  strategy: SubscriptionLoadBalanceStrategy;
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
  return {
    tags: "",
    regions: "",
    protocols: [],
    excludeTags: "",
    excludeRegions: "",
    excludeProtocols: [],
    nameContains: "",
  };
}

export function emptyGroupDraft(): GroupDraft {
  return {
    name: "",
    type: "select",
    includeAuto: false,
    interval: String(DEFAULT_INTERVAL_SECS),
    strategy: DEFAULT_LOAD_BALANCE_STRATEGY,
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

function protocolList(values: string[] | undefined | null): TemplateProtocol[] {
  return (values ?? []).filter((protocol): protocol is TemplateProtocol =>
    (TEMPLATE_PROTOCOLS as readonly string[]).includes(protocol),
  );
}

function draftFilterToPayload(filter: FilterDraft): FilterPayload {
  const nameContains = (filter.nameContains ?? "").trim();
  return {
    tags: splitList(filter.tags ?? ""),
    regions: splitList(filter.regions ?? ""),
    protocols: protocolList(filter.protocols),
    exclude_tags: splitList(filter.excludeTags ?? ""),
    exclude_regions: splitList(filter.excludeRegions ?? ""),
    exclude_protocols: protocolList(filter.excludeProtocols),
    ...(nameContains === "" ? {} : { name_contains: nameContains }),
  };
}

function draftInterval(group: GroupDraft): number | null {
  if (!isAutoGroupKind(group.type)) return null;
  const trimmed = group.interval.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function draftStrategy(
  group: GroupDraft,
): SubscriptionLoadBalanceStrategy | null {
  if (group.type !== "load-balance") return null;
  return (LOAD_BALANCE_STRATEGIES as readonly string[]).includes(group.strategy)
    ? group.strategy
    : DEFAULT_LOAD_BALANCE_STRATEGY;
}

/** 表单 → API payload；校验通过后再调用。 */
export function groupsFromDraft(groups: GroupDraft[]): SubscriptionGroup[] {
  return groups.map((group) => {
    const interval = draftInterval(group);
    const strategy = draftStrategy(group);
    return {
      name: group.name.trim(),
      type: group.type,
      filters: group.filters.map(draftFilterToPayload),
      include_auto: group.type === "select" ? group.includeAuto : false,
      ...(interval === null ? {} : { interval }),
      ...(strategy === null ? {} : { strategy }),
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
      strategy: group.strategy ?? DEFAULT_LOAD_BALANCE_STRATEGY,
      filters:
        group.filters.length > 0
          ? group.filters.map((filter) => ({
              tags: joinList(filter.tags),
              regions: joinList(filter.regions),
              protocols: protocolList(filter.protocols),
              excludeTags: joinList(filter.exclude_tags),
              excludeRegions: joinList(filter.exclude_regions),
              excludeProtocols: protocolList(filter.exclude_protocols),
              nameContains: filter.name_contains ?? "",
            }))
          : [emptyFilterDraft()],
    })),
  };
}

/**
 * 复制模板为**草稿**（不写库）：名称自动去重，组结构与原模板独立。
 *
 * 返回的是全新的 `TemplateDraft`，后续编辑副本不会改动原模板对象。
 */
export function copyTemplateDraft(
  template: SubscriptionTemplate,
  existingNames: string[],
  suffix = " (copy)",
): TemplateDraft {
  const name = uniqueTemplateName(template.name, existingNames, suffix);
  return { ...draftFromTemplate(template), name };
}

/** `名称 (copy)` / `名称 (copy 2)` …，只用于草稿名称，保存前仍可改。 */
export function uniqueTemplateName(
  base: string,
  existingNames: string[],
  suffix = " (copy)",
): string {
  const trimmed = base.trim() === "" ? "template" : base.trim();
  // 留出后缀与「 2」这类序号的空间，保证复制出来的草稿名称仍能过校验。
  const budget = Math.max(1, MAX_GROUP_NAME_CHARS - suffix.length - 4);
  const stem = Array.from(trimmed).slice(0, budget).join("");
  const taken = new Set(existingNames.map((name) => name.trim()));
  const first = `${stem}${suffix}`;
  if (!taken.has(first)) return first;
  let index = 2;
  while (taken.has(`${first} ${index}`)) index += 1;
  return `${first} ${index}`;
}

/** 拖拽排序用的纯函数：把 `from` 移到 `to`，越界时原样返回。 */
export function moveGroup<T>(items: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return items;
  }
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
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
      const listFields = [
        { values: splitList(filter.tags), max: MAX_TAG_CHARS, code: "tagTooLong" },
        {
          values: splitList(filter.regions),
          max: MAX_REGION_CHARS,
          code: "regionTooLong",
        },
        {
          values: splitList(filter.excludeTags),
          max: MAX_TAG_CHARS,
          code: "tagTooLong",
        },
        {
          values: splitList(filter.excludeRegions),
          max: MAX_REGION_CHARS,
          code: "regionTooLong",
        },
      ];
      for (const { values, max, code } of listFields) {
        if (values.length > MAX_FILTER_VALUES) {
          errors.push({
            code: "tooManyValues",
            field: "groups",
            index,
            params: { max: MAX_FILTER_VALUES, filter: filterIndex + 1 },
          });
        }
        if (values.some((value) => value.length > max)) {
          errors.push({
            code,
            field: "groups",
            index,
            params: { max, filter: filterIndex + 1 },
          });
        }
      }
      if (
        filter.protocols.length > MAX_FILTER_VALUES ||
        filter.excludeProtocols.length > MAX_FILTER_VALUES
      ) {
        errors.push({
          code: "tooManyValues",
          field: "groups",
          index,
          params: { max: MAX_FILTER_VALUES, filter: filterIndex + 1 },
        });
      }
      if (filter.nameContains.trim().length > MAX_NAME_CONTAINS_CHARS) {
        errors.push({
          code: "nameContainsTooLong",
          field: "groups",
          index,
          params: { max: MAX_NAME_CONTAINS_CHARS, filter: filterIndex + 1 },
        });
      }
    });

    if (isAutoGroupKind(group.type)) {
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

/**
 * 预览可切换的导出格式：只有能表达订阅模板的格式（与后端
 * `subscription_template::TEMPLATE_FORMATS` 一致）。
 */
export const TEMPLATE_PREVIEW_FORMATS = [
  "mihomo",
  "clash",
  "stash",
  "surge",
  "surge-full",
  "singbox",
  "singbox-full",
] as const;

export type TemplatePreviewFormat = (typeof TEMPLATE_PREVIEW_FORMATS)[number];

/**
 * 模糊匹配导出格式：`sing-box` / `sing box full` / `Surge` / `Clash Meta`
 * 都能解析成后端注册表 id；无法识别时返回 `null`。
 */
export function resolvePreviewFormat(input: string): TemplatePreviewFormat | null {
  const normalized = input.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "") return "mihomo";
  if (
    (TEMPLATE_PREVIEW_FORMATS as readonly string[]).includes(normalized)
  ) {
    return normalized as TemplatePreviewFormat;
  }
  if (normalized.includes("sing")) {
    return normalized.includes("full") ? "singbox-full" : "singbox";
  }
  if (normalized.includes("surge")) {
    return normalized.includes("full") ? "surge-full" : "surge";
  }
  if (normalized.includes("stash")) return "stash";
  if (normalized.includes("mihomo") || normalized.includes("clash-meta")) {
    return "mihomo";
  }
  if (normalized.includes("clash")) return "clash";
  return null;
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
    if (filter.exclude_tags && filter.exclude_tags.length > 0) {
      parts.push(`!#${filter.exclude_tags.join("/")}`);
    }
    if (filter.exclude_regions && filter.exclude_regions.length > 0) {
      parts.push(`!@${filter.exclude_regions.join("/")}`);
    }
    if (filter.exclude_protocols && filter.exclude_protocols.length > 0) {
      parts.push(`!${filter.exclude_protocols.join("/")}`);
    }
    if (filter.name_contains) {
      parts.push(`~${filter.name_contains}`);
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
