//! 订阅模板：声明式代理组（`subscription_templates.groups_json`）。
//!
//! 设计约束（见 `docs/SUBSCRIBE.md` §6）：
//!
//! - **声明式，不允许脚本**：模板只是一组筛选条件，落库前过 [`normalize_groups`]，
//!   未知字段在反序列化阶段就被 `deny_unknown_fields` 拒绝；
//! - **filter 内 AND，filter 间 OR**：一个 filter 的 tags/regions/protocols 必须同时命中，
//!   节点命中任意一个 filter 就算命中该组；
//! - **顺序稳定**：组成员始终按节点在订阅里的原始顺序拼接去重，不按筛选条件重排；
//! - **空组跳过**：Clash/mihomo 会拒绝 `proxies: []` 的组，命中 0 个节点的组直接不生成，
//!   并在 [`GroupPlan::warnings`] 里说明；所有组都空时由调用方回落硬编码分组。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::subscribe::SubNode;

/// 模板里一个代理组的类型。
///
/// 四种都在 Clash / mihomo / Stash 里有稳定表达；Surge 与 sing-box 的表达能力
/// 见 [`group_capabilities`]，无法表达的组合由 [`plan_for_format`] 跳过并 warning。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GroupKind {
    #[serde(rename = "select")]
    Select,
    #[serde(rename = "url-test")]
    UrlTest,
    #[serde(rename = "fallback")]
    Fallback,
    #[serde(rename = "load-balance")]
    LoadBalance,
}

impl GroupKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GroupKind::Select => "select",
            GroupKind::UrlTest => "url-test",
            GroupKind::Fallback => "fallback",
            GroupKind::LoadBalance => "load-balance",
        }
    }

    /// 自动测速类组：成员全是节点，命中 0 个节点必须跳过（客户端不接受空组）。
    ///
    /// `select` 不在其中：它可以只靠自动选择组或 `DIRECT` 存活。
    pub fn is_auto(self) -> bool {
        matches!(
            self,
            GroupKind::UrlTest | GroupKind::Fallback | GroupKind::LoadBalance
        )
    }
}

/// `load-balance` 的负载均衡策略；缺省 `round-robin`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum LoadBalanceStrategy {
    #[default]
    #[serde(rename = "round-robin")]
    RoundRobin,
    #[serde(rename = "consistent-hashing")]
    ConsistentHashing,
}

impl LoadBalanceStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            LoadBalanceStrategy::RoundRobin => "round-robin",
            LoadBalanceStrategy::ConsistentHashing => "consistent-hashing",
        }
    }
}

/// 一个筛选条件。
///
/// 包含条件（`tags` / `regions` / `protocols` / `name_contains`）之间是 **AND**；
/// 排除条件（`exclude_*`）**优先于**包含条件：任何一条排除命中，节点就不进该组。
/// 所有数组「空 = 不限制」，空条件 `{}` 仍表示全部节点。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupFilter {
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub regions: Vec<String>,
    #[serde(default)]
    pub protocols: Vec<String>,
    #[serde(default)]
    pub exclude_tags: Vec<String>,
    #[serde(default)]
    pub exclude_regions: Vec<String>,
    #[serde(default)]
    pub exclude_protocols: Vec<String>,
    /// 节点名的大小写不敏感子串匹配；**不是正则**（避免性能与注入问题）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_contains: Option<String>,
}

impl GroupFilter {
    fn name_needle(&self) -> Option<&str> {
        self.name_contains
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    /// 空 filter（`{}`）= 命中全部节点。
    pub fn is_empty(&self) -> bool {
        self.tags.is_empty()
            && self.regions.is_empty()
            && self.protocols.is_empty()
            && self.exclude_tags.is_empty()
            && self.exclude_regions.is_empty()
            && self.exclude_protocols.is_empty()
            && self.name_needle().is_none()
    }

    /// 排除条件优先：命中任意一条排除就整条 filter 不命中。
    fn excluded(&self, node: &SubNode) -> bool {
        self.exclude_tags
            .iter()
            .any(|tag| node.tags.iter().any(|item| item == tag))
            || self.exclude_regions.iter().any(|region| {
                node.region
                    .as_deref()
                    .is_some_and(|item| item.eq_ignore_ascii_case(region))
            })
            || self
                .exclude_protocols
                .iter()
                .any(|protocol| node.protocol.eq_ignore_ascii_case(protocol))
    }

    /// filter 内条件全部满足才算命中（AND），排除条件优先。
    pub fn matches(&self, node: &SubNode) -> bool {
        if self.excluded(node) {
            return false;
        }
        if self.is_empty() {
            return true;
        }
        // 空维度 = 不限制；非空维度必须命中（同一 filter 内 AND）。
        let tags_ok = self.tags.is_empty()
            || self
                .tags
                .iter()
                .any(|tag| node.tags.iter().any(|item| item == tag));
        let regions_ok = self.regions.is_empty()
            || self.regions.iter().any(|region| {
                node.region
                    .as_deref()
                    .is_some_and(|item| item.eq_ignore_ascii_case(region))
            });
        let protocols_ok = self.protocols.is_empty()
            || self
                .protocols
                .iter()
                .any(|protocol| node.protocol.eq_ignore_ascii_case(protocol));
        // 子串匹配用 Unicode 小写：ASCII 大小写与全角/半角之外的非 ASCII 也不区分大小写。
        let name_ok = match self.name_needle() {
            Some(needle) => node.name.to_lowercase().contains(&needle.to_lowercase()),
            None => true,
        };
        tags_ok && regions_ok && protocols_ok && name_ok
    }
}

/// 模板里的一个代理组。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubscriptionGroup {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: GroupKind,
    /// 至少一个；`[{}]` = 全部节点。
    pub filters: Vec<GroupFilter>,
    /// 仅 `select` 有意义：是否把模板里的自动选择组放在成员第一位。
    #[serde(default)]
    pub include_auto: bool,
    /// 自动测速类组（`url-test` / `fallback` / `load-balance`）的测速间隔（秒），缺省 300。
    /// `select` 会把它清空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<u32>,
    /// 仅 `load-balance` 有意义：负载均衡策略，缺省 `round-robin`。
    /// 其它组类型会把它清空，避免落库后语义含糊。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<LoadBalanceStrategy>,
}

/// 校验失败的机器可读描述；master 直接翻成带 code 的 400。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateProblem {
    pub code: &'static str,
    pub params: Value,
    /// 中文兜底文案；前端按 code + params 做双语。
    pub message: String,
}

impl TemplateProblem {
    fn new(code: &'static str, params: Value, message: String) -> Self {
        Self {
            code,
            params,
            message,
        }
    }
}

/// 单个组名上限（Unicode 字符）。
pub const MAX_GROUP_NAME_CHARS: usize = 32;
/// 每个模板最多多少个组。
pub const MAX_GROUPS: usize = 16;
/// 每个组最多多少个 filter。
pub const MAX_FILTERS_PER_GROUP: usize = 8;
/// filter 里每个数组最多多少项。
pub const MAX_FILTER_VALUES: usize = 16;
/// 单个标签在模板条件里的上限（与节点标签一致）。
pub const MAX_TAG_CHARS: usize = 24;
/// 单个地区在模板条件里的上限（与节点 region 一致）。
pub const MAX_REGION_CHARS: usize = 8;
/// `name_contains` 子串长度上限：只做子串，不做正则。
pub const MAX_NAME_CONTAINS_CHARS: usize = 64;
/// 自动测速类组的测速间隔范围（秒）。
pub const MIN_INTERVAL_SECS: u32 = 10;
pub const MAX_INTERVAL_SECS: u32 = 86_400;

const PROTOCOLS: &[&str] = &["vless", "vmess", "trojan", "ss"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilterValueKind {
    Tag,
    Region,
    Protocol,
}

/// filter 里一个数组的规范化：trim、去空、去重、协议小写并校验。
fn normalize_filter_values(
    group: &str,
    field: &'static str,
    values: &[String],
    kind: FilterValueKind,
) -> Result<Vec<String>, TemplateProblem> {
    if values.len() > MAX_FILTER_VALUES {
        return Err(TemplateProblem::new(
            "subscription_template.too_many_values",
            serde_json::json!({ "name": group, "field": field, "max": MAX_FILTER_VALUES }),
            format!("代理组「{group}」的筛选条件 {field} 最多 {MAX_FILTER_VALUES} 项"),
        ));
    }
    let mut out: Vec<String> = Vec::with_capacity(values.len());
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let value = match kind {
            FilterValueKind::Protocol => value.to_ascii_lowercase(),
            FilterValueKind::Tag | FilterValueKind::Region => value.to_string(),
        };
        if kind == FilterValueKind::Protocol && !PROTOCOLS.contains(&value.as_str()) {
            return Err(TemplateProblem::new(
                "subscription_template.filter_protocol_invalid",
                serde_json::json!({ "name": group, "protocol": value, "allowed": PROTOCOLS }),
                format!(
                    "代理组「{group}」的协议条件不支持 {value}（可选：{}）",
                    PROTOCOLS.join(" / ")
                ),
            ));
        }
        let max = match kind {
            FilterValueKind::Tag => Some(MAX_TAG_CHARS),
            FilterValueKind::Region => Some(MAX_REGION_CHARS),
            FilterValueKind::Protocol => None,
        };
        if let Some(max) = max {
            if value.chars().count() > max {
                let label = match kind {
                    FilterValueKind::Tag => "标签",
                    FilterValueKind::Region => "地区",
                    FilterValueKind::Protocol => "协议",
                };
                return Err(TemplateProblem::new(
                    "subscription_template.filter_value_too_long",
                    serde_json::json!({ "name": group, "field": field, "max": max }),
                    format!("代理组「{group}」的{label}条件超过 {max} 个字符"),
                ));
            }
        }
        // 协议先小写再去重：`VLESS` 与 `vless` 是同一个条件。
        if !out.iter().any(|item| item == &value) {
            out.push(value);
        }
    }
    Ok(out)
}

/// 逐字段 trim / 去重 / 校验；返回的就是落库与渲染共用的规范形态。
///
/// 校验顺序与前端表单一致：组名 → 组类型自带的字段 → filter 数量 → filter 内容。
pub fn normalize_groups(
    groups: &[SubscriptionGroup],
) -> Result<Vec<SubscriptionGroup>, TemplateProblem> {
    if groups.is_empty() {
        return Err(TemplateProblem::new(
            "subscription_template.groups_empty",
            Value::Null,
            "至少需要一个代理组".to_string(),
        ));
    }
    if groups.len() > MAX_GROUPS {
        return Err(TemplateProblem::new(
            "subscription_template.too_many_groups",
            serde_json::json!({ "max": MAX_GROUPS }),
            format!("代理组最多 {MAX_GROUPS} 个"),
        ));
    }

    let mut normalized = Vec::with_capacity(groups.len());
    let mut seen_names: Vec<String> = Vec::new();
    for (index, group) in groups.iter().enumerate() {
        let name = group.name.trim();
        if name.is_empty() {
            return Err(TemplateProblem::new(
                "subscription_template.group_name_required",
                serde_json::json!({ "index": index + 1 }),
                format!("第 {} 个代理组的名称不能为空", index + 1),
            ));
        }
        if name.chars().count() > MAX_GROUP_NAME_CHARS {
            return Err(TemplateProblem::new(
                "subscription_template.group_name_too_long",
                serde_json::json!({ "index": index + 1, "max": MAX_GROUP_NAME_CHARS }),
                format!(
                    "第 {} 个代理组名称超过 {MAX_GROUP_NAME_CHARS} 个字符",
                    index + 1
                ),
            ));
        }
        if seen_names.iter().any(|item| item == name) {
            return Err(TemplateProblem::new(
                "subscription_template.group_name_taken",
                serde_json::json!({ "name": name }),
                format!("代理组名称「{name}」重复"),
            ));
        }
        seen_names.push(name.to_string());

        if group.filters.is_empty() {
            return Err(TemplateProblem::new(
                "subscription_template.filters_empty",
                serde_json::json!({ "name": name }),
                format!("代理组「{name}」至少需要一个筛选条件（空条件 {{}} 表示全部节点）"),
            ));
        }
        if group.filters.len() > MAX_FILTERS_PER_GROUP {
            return Err(TemplateProblem::new(
                "subscription_template.too_many_filters",
                serde_json::json!({ "name": name, "max": MAX_FILTERS_PER_GROUP }),
                format!("代理组「{name}」最多 {MAX_FILTERS_PER_GROUP} 个筛选条件"),
            ));
        }
        if group.include_auto && group.kind != GroupKind::Select {
            return Err(TemplateProblem::new(
                "subscription_template.include_auto_select_only",
                serde_json::json!({ "name": name }),
                format!("代理组「{name}」只有 select 类型可以用 include_auto"),
            ));
        }

        let mut filters = Vec::with_capacity(group.filters.len());
        for filter in &group.filters {
            let tags = normalize_filter_values(name, "tags", &filter.tags, FilterValueKind::Tag)?;
            let regions =
                normalize_filter_values(name, "regions", &filter.regions, FilterValueKind::Region)?;
            let protocols = normalize_filter_values(
                name,
                "protocols",
                &filter.protocols,
                FilterValueKind::Protocol,
            )?;
            let exclude_tags = normalize_filter_values(
                name,
                "exclude_tags",
                &filter.exclude_tags,
                FilterValueKind::Tag,
            )?;
            let exclude_regions = normalize_filter_values(
                name,
                "exclude_regions",
                &filter.exclude_regions,
                FilterValueKind::Region,
            )?;
            let exclude_protocols = normalize_filter_values(
                name,
                "exclude_protocols",
                &filter.exclude_protocols,
                FilterValueKind::Protocol,
            )?;
            let name_contains = match filter
                .name_contains
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                Some(value) => {
                    if value.chars().count() > MAX_NAME_CONTAINS_CHARS {
                        return Err(TemplateProblem::new(
                            "subscription_template.filter_value_too_long",
                            serde_json::json!({
                                "name": name,
                                "field": "name_contains",
                                "max": MAX_NAME_CONTAINS_CHARS,
                            }),
                            format!(
                                "代理组「{name}」的节点名子串条件超过 {MAX_NAME_CONTAINS_CHARS} 个字符"
                            ),
                        ));
                    }
                    Some(value.to_string())
                }
                None => None,
            };
            filters.push(GroupFilter {
                tags,
                regions,
                protocols,
                exclude_tags,
                exclude_regions,
                exclude_protocols,
                name_contains,
            });
        }

        if let Some(interval) = group.interval {
            if !(MIN_INTERVAL_SECS..=MAX_INTERVAL_SECS).contains(&interval) {
                return Err(TemplateProblem::new(
                    "subscription_template.interval_invalid",
                    serde_json::json!({
                        "name": name,
                        "min": MIN_INTERVAL_SECS,
                        "max": MAX_INTERVAL_SECS,
                    }),
                    format!(
                        "代理组「{name}」的测速间隔必须在 {MIN_INTERVAL_SECS}-{MAX_INTERVAL_SECS} 秒之间"
                    ),
                ));
            }
        }

        normalized.push(SubscriptionGroup {
            name: name.to_string(),
            kind: group.kind,
            filters,
            include_auto: group.include_auto,
            // select 不写 interval，避免落库后语义含糊；自动测速类组保留。
            interval: if group.kind.is_auto() {
                group.interval
            } else {
                None
            },
            // 只有 load-balance 有策略；缺省显式落成 round-robin，其它类型清空。
            strategy: if group.kind == GroupKind::LoadBalance {
                Some(group.strategy.unwrap_or_default())
            } else {
                None
            },
        });
    }

    // 兜底规则始终指向一个 select 组；一个都没有时提示，但不算错误
    // （纯 url-test 模板仍可用，渲染层会把策略指向第一个组）。
    Ok(normalized)
}

/// 渲染计划里的一个组；成员已按节点原始顺序去重。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedGroup {
    pub name: String,
    pub kind: GroupKind,
    /// 命中该组的节点名（原始顺序）。
    pub node_members: Vec<String>,
    /// `select` 的完整成员（含自动选择组名与 `DIRECT`）。
    pub members: Vec<String>,
    pub interval: Option<u32>,
    /// 仅 `load-balance`：负载均衡策略。
    pub strategy: Option<LoadBalanceStrategy>,
    /// 仅 `select`：是否把自动组放在成员第一位。
    ///
    /// [`plan_for_format`] 需要它来**按目标格式**重新挑选自动组：模板里的自动组
    /// 可能被该格式跳过（例如 Surfboard 表达不了 `load-balance`），此时直接照抄
    /// [`Self::members`] 会引用一个不存在的组。
    pub include_auto: bool,
}

/// 一次渲染的分组计划。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GroupPlan {
    pub groups: Vec<PlannedGroup>,
    /// 面向管理员的中英双语提示（预览接口原样返回）。
    pub warnings: Vec<String>,
}

impl GroupPlan {
    pub fn is_empty(&self) -> bool {
        self.groups.is_empty()
    }

    /// 兜底规则要指向的策略名：第一个存活的 select 组；没有 select 时取第一个组。
    ///
    /// 这样规则永远不会引用一个不存在的组（纯 url-test 模板也不会让整份配置失效）。
    pub fn policy_target(&self) -> Option<&str> {
        self.groups
            .iter()
            .find(|group| group.kind == GroupKind::Select)
            .or_else(|| self.groups.first())
            .map(|group| group.name.as_str())
    }
}

fn matching_nodes(group: &SubscriptionGroup, nodes: &[SubNode]) -> Vec<String> {
    // filter 之间 OR，节点顺序保持订阅里的原始顺序；同名节点只保留一次。
    let mut members: Vec<String> = Vec::new();
    for node in nodes {
        if group.filters.iter().any(|filter| filter.matches(node))
            && !members.iter().any(|name| name == &node.name)
        {
            members.push(node.name.clone());
        }
    }
    members
}

/// 把模板 + 节点落成可渲染的分组计划。
///
/// 规则：
/// 1. 先算每个组命中的节点；自动测速类组（`url-test` / `fallback` / `load-balance`）
///    命中 0 个 → 跳过并 warning；
/// 2. `select` 的成员 = 自动组（若 `include_auto` 且存在存活的自动组）
///    + 命中节点 + `DIRECT`；命中 0 个节点且没有自动组 → 跳过并 warning；
/// 3. 所有组都跳过 → `groups` 为空，调用方回落硬编码分组。
///
/// 自动组的挑选顺序是 **url-test > fallback > load-balance**，同一类型内按模板声明
/// 顺序取第一个存活的组。旧模板只有 url-test，所以行为与第一轮完全一致。
pub fn plan_groups(groups: &[SubscriptionGroup], nodes: &[SubNode]) -> GroupPlan {
    let mut warnings = Vec::new();

    let mut survivors: Vec<Option<Vec<String>>> = Vec::with_capacity(groups.len());
    for group in groups {
        let matched = matching_nodes(group, nodes);
        match group.kind {
            kind if kind.is_auto() && matched.is_empty() => {
                warnings.push(format!(
                    "代理组「{}」没有命中任何节点，已跳过 / Group \"{}\" matched no nodes and was skipped",
                    group.name, group.name
                ));
                survivors.push(None);
            }
            _ => survivors.push(Some(matched)),
        }
    }

    // 自动组：按 url-test > fallback > load-balance 的优先级，取第一个存活的组。
    // 旧模板（只有 url-test）行为不变；fallback / load-balance 只在前者不存在时兜底。
    let auto_name = [
        GroupKind::UrlTest,
        GroupKind::Fallback,
        GroupKind::LoadBalance,
    ]
    .iter()
    .find_map(|kind| {
        groups
            .iter()
            .zip(&survivors)
            .find(|(group, matched)| group.kind == *kind && matched.is_some())
            .map(|(group, _)| group.name.clone())
    });

    let mut planned = Vec::new();
    for (index, group) in groups.iter().enumerate() {
        let Some(matched) = survivors[index].clone() else {
            continue;
        };
        match group.kind {
            GroupKind::UrlTest | GroupKind::Fallback | GroupKind::LoadBalance => {
                planned.push(PlannedGroup {
                    name: group.name.clone(),
                    kind: group.kind,
                    members: matched.clone(),
                    node_members: matched,
                    interval: group.interval,
                    strategy: group.strategy,
                    include_auto: false,
                });
            }
            GroupKind::Select => {
                let mut members = Vec::new();
                if group.include_auto {
                    match &auto_name {
                        Some(auto) => members.push(auto.clone()),
                        None => warnings.push(format!(
                            "代理组「{}」开启了 include_auto，但模板里没有命中节点的 url-test / fallback / load-balance 组 / Group \"{}\" has include_auto but no url-test / fallback / load-balance group matched any node",
                            group.name, group.name
                        )),
                    }
                }
                if matched.is_empty() && members.is_empty() {
                    warnings.push(format!(
                        "代理组「{}」没有命中任何节点，已跳过 / Group \"{}\" matched no nodes and was skipped",
                        group.name, group.name
                    ));
                    continue;
                }
                members.extend(matched.iter().cloned());
                members.push("DIRECT".to_string());
                planned.push(PlannedGroup {
                    name: group.name.clone(),
                    kind: group.kind,
                    members,
                    node_members: matched,
                    interval: None,
                    strategy: None,
                    include_auto: group.include_auto,
                });
            }
        }
    }

    if planned.is_empty() && !groups.is_empty() {
        warnings.push(
            "模板里没有任何组命中节点，已回落到内置分组 / No group matched any node; falling back to the built-in groups"
                .to_string(),
        );
    }

    GroupPlan {
        groups: planned,
        warnings,
    }
}

/// 某个导出格式能表达哪些代理组。
///
/// `select` / `url-test` 在所有模板感知的格式里都成立，所以只需要描述
/// `fallback` / `load-balance` 的差异：
///
/// | 格式 | fallback | load-balance | consistent-hashing |
/// |---|---|---|---|
/// | clash / mihomo / stash | ✅ | ✅ | ✅ |
/// | surge / surge-full / egern | ✅ | ✅（仅 round-robin） | ❌ 跳过并 warning |
/// | surfboard | ✅ | ❌ 只有随机分配，无法表达轮询/哈希 | ❌ 跳过并 warning |
/// | loon | ✅ | ✅（仅 round-robin，`algorithm=Round-Robin`） | ❌ 跳过并 warning |
/// | singbox / singbox-full | ✅ | ⚠️ 用 urltest 近似（warning） | ⚠️ 近似 |
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupCapabilities {
    pub fallback: bool,
    pub load_balance: bool,
    pub load_balance_consistent_hashing: bool,
    /// 没有原生 load-balance 时是否允许用 urltest 近似（sing-box）。
    pub load_balance_as_url_test: bool,
}

/// 支持订阅模板的导出格式（其余格式保持原行为：忽略模板）。
///
/// 顺序只追加不插队：400 文案与前端格式下拉都按这个顺序展示。
pub const TEMPLATE_FORMATS: &[&str] = &[
    "clash",
    "mihomo",
    "stash",
    "surge",
    "surge-full",
    "singbox",
    "singbox-full",
    // 第三轮接入的 Surge 家族与 Loon。
    "surfboard",
    "loon",
    "egern",
];

pub fn is_template_format(format: &str) -> bool {
    TEMPLATE_FORMATS
        .iter()
        .any(|item| item.eq_ignore_ascii_case(format.trim()))
}

pub fn group_capabilities(format: &str) -> GroupCapabilities {
    match format.trim().to_ascii_lowercase().as_str() {
        "clash" | "mihomo" | "stash" => GroupCapabilities {
            fallback: true,
            load_balance: true,
            load_balance_consistent_hashing: true,
            load_balance_as_url_test: false,
        },
        "surge" | "surge-full" | "egern" => GroupCapabilities {
            fallback: true,
            load_balance: true,
            // Surge 的 load-balance 是轮询，没有 strategy 字段；Egern 复用同一份
            // Surge 兼容 profile，能力边界与 Surge 相同。
            load_balance_consistent_hashing: false,
            load_balance_as_url_test: false,
        },
        "surfboard" => GroupCapabilities {
            fallback: true,
            // Surfboard 的 load-balance 只有随机分配，语法里没有 url / interval /
            // strategy，既不是轮询也不是一致性哈希，所以整类跳过而不是假装支持。
            load_balance: false,
            load_balance_consistent_hashing: false,
            load_balance_as_url_test: false,
        },
        "loon" => GroupCapabilities {
            fallback: true,
            // Loon 支持 load-balance，但算法只有 Random / PCC / Round-Robin；
            // 轮询可以精确表达，一致性哈希没有对应算法。
            load_balance: true,
            load_balance_consistent_hashing: false,
            load_balance_as_url_test: false,
        },
        "singbox" | "singbox-full" => GroupCapabilities {
            fallback: true,
            load_balance: true,
            load_balance_consistent_hashing: true,
            load_balance_as_url_test: true,
        },
        // 不认识 / 不支持模板的格式：不做过滤，由渲染器忽略模板（行为不变）。
        _ => GroupCapabilities {
            fallback: true,
            load_balance: true,
            load_balance_consistent_hashing: true,
            load_balance_as_url_test: false,
        },
    }
}

fn group_supported(group: &PlannedGroup, capabilities: GroupCapabilities) -> bool {
    match group.kind {
        GroupKind::Select | GroupKind::UrlTest => true,
        GroupKind::Fallback => capabilities.fallback,
        GroupKind::LoadBalance => {
            capabilities.load_balance
                && (capabilities.load_balance_consistent_hashing
                    || group.strategy != Some(LoadBalanceStrategy::ConsistentHashing))
        }
    }
}

/// 目标格式里第一个存活的自动组，优先级 url-test > fallback > load-balance。
///
/// 与 [`plan_groups`] 同一套语义，只是把「能否在目标格式里表达」也算进「存活」：
/// `include_auto` 的成员引用必须指向真正会输出的组，否则客户端会看到未知策略。
fn surviving_auto_name(plan: &GroupPlan, capabilities: GroupCapabilities) -> Option<String> {
    [
        GroupKind::UrlTest,
        GroupKind::Fallback,
        GroupKind::LoadBalance,
    ]
    .iter()
    .find_map(|kind| {
        plan.groups
            .iter()
            .find(|group| group.kind == *kind && group_supported(group, capabilities))
            .map(|group| group.name.clone())
    })
}

/// 把计划裁剪成目标格式真正能表达的分组；不能表达的组跳过并给出 warning。
///
/// 渲染器与预览接口共用这一个函数：预览里看到的 warning 就是渲染时跳过的组，
/// 不会出现「预览说跳过了、实际却输出了」的偏差。
///
/// `select` 的 `include_auto` 成员会**按目标格式重新挑选**：模板里的自动组可能被
/// 这个格式跳过（例如 Surfboard 表达不了 `load-balance`），照抄原成员会引用一个
/// 不存在的组；重新挑选保证成员的每个引用都真实存在。
pub fn plan_for_format(plan: &GroupPlan, format: &str) -> GroupPlan {
    let capabilities = group_capabilities(format);
    let auto_name = surviving_auto_name(plan, capabilities);
    let mut filtered = GroupPlan {
        groups: Vec::with_capacity(plan.groups.len()),
        warnings: plan.warnings.clone(),
    };
    for group in &plan.groups {
        if !group_supported(group, capabilities) {
            filtered.warnings.push(format!(
                "代理组「{}」的类型 {} 无法在 {} 中表达，已跳过 / Group \"{}\" of type {} cannot be expressed in {}; skipped",
                group.name,
                group.kind.as_str(),
                format,
                group.name,
                group.kind.as_str(),
                format,
            ));
            continue;
        }
        if group.kind == GroupKind::LoadBalance && capabilities.load_balance_as_url_test {
            filtered.warnings.push(format!(
                "代理组「{}」是 load-balance，{} 没有该组类型，已用 urltest 近似 / Group \"{}\" is load-balance, which {} cannot express; approximated with urltest",
                group.name, format, group.name, format,
            ));
        }
        if group.kind != GroupKind::Select || !group.include_auto {
            filtered.groups.push(group.clone());
            continue;
        }

        // `select` + `include_auto`：重建成员，只引用目标格式真正会输出的自动组。
        let planned_auto = plan
            .groups
            .iter()
            .find(|candidate| {
                candidate.kind.is_auto()
                    && group.members.iter().any(|member| member == &candidate.name)
            })
            .map(|candidate| candidate.name.clone());
        let mut fixed = group.clone();
        fixed.members.clear();
        match (&auto_name, &planned_auto) {
            (Some(auto), _) => fixed.members.push(auto.clone()),
            (None, Some(dropped)) => filtered.warnings.push(format!(
                "代理组「{}」的自动组「{}」无法在 {} 中表达，已从成员里移除 / The auto group \"{}\" of group \"{}\" cannot be expressed in {}; removed from its members",
                group.name, dropped, format, dropped, group.name, format,
            )),
            // 计划本身就没有自动组：plan_groups 已经给过 include_auto 的 warning。
            (None, None) => {}
        }
        fixed.members.extend(fixed.node_members.iter().cloned());
        fixed.members.push("DIRECT".to_string());
        filtered.groups.push(fixed);
    }
    if filtered.groups.is_empty() && !plan.groups.is_empty() {
        filtered.warnings.push(format!(
            "模板里没有任何组能在 {} 中表达，已回落到内置分组 / No template group can be expressed in {}; falling back to the built-in groups",
            format, format,
        ));
    }
    filtered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(name: &str, protocol: &str, tags: &[&str], region: Option<&str>) -> SubNode {
        SubNode {
            name: name.to_string(),
            protocol: protocol.to_string(),
            server: "203.0.113.10".to_string(),
            port: 443,
            public_port: None,
            transport: "tcp".to_string(),
            security: "none".to_string(),
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            region: region.map(str::to_string),
            params: Default::default(),
        }
    }

    fn nodes() -> Vec<SubNode> {
        vec![
            node("香港-1", "vless", &["香港", "中转"], Some("HK")),
            node("香港-2", "trojan", &["香港"], Some("HK")),
            node("日本-1", "vless", &["日本"], Some("JP")),
            node("美国-1", "ss", &[], Some("US")),
        ]
    }

    fn filter(tags: &[&str], regions: &[&str], protocols: &[&str]) -> GroupFilter {
        GroupFilter {
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
            regions: regions.iter().map(|region| region.to_string()).collect(),
            protocols: protocols.iter().map(|item| item.to_string()).collect(),
            ..Default::default()
        }
    }

    fn group(name: &str, kind: GroupKind, filters: Vec<GroupFilter>) -> SubscriptionGroup {
        SubscriptionGroup {
            name: name.into(),
            kind,
            filters,
            include_auto: false,
            interval: None,
            strategy: None,
        }
    }

    fn load_balance(name: &str, strategy: Option<LoadBalanceStrategy>) -> SubscriptionGroup {
        SubscriptionGroup {
            name: name.into(),
            kind: GroupKind::LoadBalance,
            filters: vec![filter(&[], &[], &[])],
            include_auto: false,
            interval: None,
            strategy,
        }
    }

    #[test]
    fn filter_matches_tags_regions_and_protocols() {
        let nodes = nodes();
        assert!(filter(&["香港"], &[], &[]).matches(&nodes[0]));
        assert!(!filter(&["香港"], &[], &[]).matches(&nodes[3]));
        assert!(filter(&[], &["HK"], &[]).matches(&nodes[1]));
        // 地区大小写不敏感（HK / hk）。
        assert!(filter(&[], &["hk"], &[]).matches(&nodes[0]));
        assert!(filter(&[], &[], &["vless"]).matches(&nodes[0]));
        assert!(!filter(&[], &[], &["vless"]).matches(&nodes[1]));
        // 空 filter 命中全部。
        assert!(GroupFilter::default().matches(&nodes[3]));
    }

    #[test]
    fn conditions_inside_a_filter_are_and() {
        let nodes = nodes();
        let both = filter(&["香港"], &["HK"], &["vless"]);
        assert!(both.matches(&nodes[0]));
        // 标签命中但协议不命中 → 整体不命中。
        assert!(!both.matches(&nodes[1]));
        assert!(!filter(&["日本"], &["HK"], &[]).matches(&nodes[2]));
    }

    #[test]
    fn exclusions_take_priority_over_includes_inside_one_filter() {
        let nodes = nodes();
        // 包含「香港」但排除标签「中转」→ 香港-1 出局，香港-2 仍在。
        let exclude_tag = GroupFilter {
            tags: vec!["香港".into()],
            exclude_tags: vec!["中转".into()],
            ..Default::default()
        };
        assert!(!exclude_tag.matches(&nodes[0]));
        assert!(exclude_tag.matches(&nodes[1]));

        // 排除地区大小写不敏感，且优先于包含地区。
        let exclude_region = GroupFilter {
            regions: vec!["HK".into()],
            exclude_regions: vec!["hk".into()],
            ..Default::default()
        };
        assert!(!exclude_region.matches(&nodes[0]));
        assert!(!exclude_region.matches(&nodes[1]));

        // 排除协议同样大小写不敏感。
        let exclude_protocol = GroupFilter {
            protocols: vec!["vless".into()],
            exclude_protocols: vec!["VLESS".into()],
            ..Default::default()
        };
        assert!(!exclude_protocol.matches(&nodes[0]));
        assert!(!exclude_protocol.matches(&nodes[2]));

        // 只有排除条件时：全部节点减去被排除的那些（仍然不是 `{}`）。
        let exclude_only = GroupFilter {
            exclude_tags: vec!["香港".into()],
            ..Default::default()
        };
        assert!(!exclude_only.is_empty());
        assert!(!exclude_only.matches(&nodes[0]));
        assert!(!exclude_only.matches(&nodes[1]));
        assert!(exclude_only.matches(&nodes[2]));
    }

    #[test]
    fn name_contains_is_a_case_insensitive_substring_not_a_regex() {
        let hk = node("HK-01 香港", "vless", &[], Some("HK"));
        let jp = node("JP-01 日本", "vless", &[], Some("JP"));
        let dotted = node("a.*b-节点", "vless", &[], None);

        let lower = GroupFilter {
            name_contains: Some("hk".into()),
            ..Default::default()
        };
        assert!(lower.matches(&hk), "小写 needle 应命中大写节点名");
        assert!(!lower.matches(&jp));

        let upper = GroupFilter {
            name_contains: Some("HK".into()),
            ..Default::default()
        };
        assert!(upper.matches(&hk));

        // 子串而不是前缀：`-01` 命中中间位置。
        let middle = GroupFilter {
            name_contains: Some("-01".into()),
            ..Default::default()
        };
        assert!(middle.matches(&hk));
        // 中文子串同样按普通子串处理。
        assert!(GroupFilter {
            name_contains: Some("香港".into()),
            ..Default::default()
        }
        .matches(&hk));

        // 不是正则：`.*` 只匹配名字里真的出现「.*」的节点。
        let regex_like = GroupFilter {
            name_contains: Some(".*".into()),
            ..Default::default()
        };
        assert!(!regex_like.matches(&hk), "`.*` 不能被当成正则");
        assert!(regex_like.matches(&dotted));
    }

    #[test]
    fn filters_are_or_and_members_keep_node_order_without_duplicates() {
        let nodes = nodes();
        let group = SubscriptionGroup {
            name: "节点选择".into(),
            kind: GroupKind::Select,
            filters: vec![
                filter(&[], &["HK"], &[]),
                filter(&["日本"], &[], &[]),
                GroupFilter::default(),
            ],
            include_auto: false,
            interval: None,
            strategy: None,
        };
        let plan = plan_groups(&[group], &nodes);
        assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
        assert_eq!(
            plan.groups[0].node_members,
            vec!["香港-1", "香港-2", "日本-1", "美国-1"]
        );
        assert_eq!(
            plan.groups[0].members,
            vec!["香港-1", "香港-2", "日本-1", "美国-1", "DIRECT"]
        );
        assert_eq!(plan.policy_target(), Some("节点选择"));
    }

    #[test]
    fn select_prepends_the_first_surviving_url_test_group() {
        let nodes = nodes();
        let auto = SubscriptionGroup {
            name: "自动选择".into(),
            kind: GroupKind::UrlTest,
            filters: vec![filter(&[], &["HK"], &[])],
            include_auto: false,
            interval: Some(120),
            strategy: None,
        };
        let select = SubscriptionGroup {
            name: "节点选择".into(),
            kind: GroupKind::Select,
            filters: vec![filter(&["日本"], &[], &[])],
            include_auto: true,
            interval: None,
            strategy: None,
        };
        let plan = plan_groups(&[select, auto], &nodes);
        assert_eq!(plan.groups[0].name, "节点选择");
        assert_eq!(
            plan.groups[0].members,
            vec!["自动选择", "日本-1", "DIRECT"],
            "自动选择组必须排在成员第一位"
        );
        assert_eq!(plan.groups[1].interval, Some(120));
        assert_eq!(plan.groups[1].members, vec!["香港-1", "香港-2"]);
    }

    #[test]
    fn new_group_kinds_plan_members_interval_and_strategy() {
        let nodes = nodes();
        let groups = vec![
            group(
                "故障转移",
                GroupKind::Fallback,
                vec![filter(&[], &["HK"], &[])],
            ),
            SubscriptionGroup {
                interval: Some(60),
                ..load_balance("负载均衡", Some(LoadBalanceStrategy::ConsistentHashing))
            },
            group(
                "空备用",
                GroupKind::Fallback,
                vec![filter(&["韩国"], &[], &[])],
            ),
        ];
        let plan = plan_groups(&groups, &nodes);
        assert_eq!(plan.groups.len(), 2, "{:?}", plan.warnings);
        assert_eq!(plan.groups[0].kind, GroupKind::Fallback);
        assert_eq!(plan.groups[0].members, vec!["香港-1", "香港-2"]);
        assert_eq!(plan.groups[1].kind, GroupKind::LoadBalance);
        assert_eq!(
            plan.groups[1].strategy,
            Some(LoadBalanceStrategy::ConsistentHashing)
        );
        assert_eq!(plan.groups[1].interval, Some(60));
        assert!(
            plan.warnings
                .iter()
                .any(|warning| warning.contains("空备用")),
            "空 fallback 组必须跳过并 warning：{:?}",
            plan.warnings
        );
    }

    #[test]
    fn empty_auto_groups_are_skipped_with_a_warning() {
        let nodes = nodes();
        let empty = SubscriptionGroup {
            name: "韩国".into(),
            kind: GroupKind::UrlTest,
            filters: vec![filter(&["韩国"], &[], &[])],
            include_auto: false,
            interval: None,
            strategy: None,
        };
        let select = SubscriptionGroup {
            name: "节点选择".into(),
            kind: GroupKind::Select,
            filters: vec![filter(&["香港"], &[], &[])],
            include_auto: false,
            interval: None,
            strategy: None,
        };
        let plan = plan_groups(&[empty, select], &nodes);
        assert_eq!(plan.groups.len(), 1);
        assert_eq!(plan.groups[0].name, "节点选择");
        assert_eq!(plan.warnings.len(), 1);
        assert!(plan.warnings[0].contains("韩国"), "{:?}", plan.warnings);
    }

    #[test]
    fn all_groups_empty_falls_back_with_a_warning() {
        let nodes = nodes();
        let groups = vec![group(
            "韩国",
            GroupKind::Select,
            vec![filter(&["韩国"], &[], &[])],
        )];
        let plan = plan_groups(&groups, &nodes);
        assert!(plan.is_empty());
        assert_eq!(plan.policy_target(), None);
        assert_eq!(plan.warnings.len(), 2, "{:?}", plan.warnings);
        assert!(plan.warnings[1].contains("回落"), "{:?}", plan.warnings);

        // 没有节点时同样回落，而不是生成空组。
        let plan = plan_groups(
            &[group(
                "全部",
                GroupKind::UrlTest,
                vec![GroupFilter::default()],
            )],
            &[],
        );
        assert!(plan.is_empty());
    }

    #[test]
    fn include_auto_without_url_test_group_warns_but_keeps_the_select() {
        let nodes = nodes();
        let select = SubscriptionGroup {
            name: "节点选择".into(),
            kind: GroupKind::Select,
            filters: vec![filter(&["香港"], &[], &[])],
            include_auto: true,
            interval: None,
            strategy: None,
        };
        let plan = plan_groups(&[select], &nodes);
        assert_eq!(plan.groups[0].members, vec!["香港-1", "香港-2", "DIRECT"]);
        assert!(
            plan.warnings
                .iter()
                .any(|warning| warning.contains("include_auto")),
            "{:?}",
            plan.warnings
        );
    }

    #[test]
    fn select_hit_only_direct_is_skipped() {
        let nodes = nodes();
        let select = group("韩国", GroupKind::Select, vec![filter(&["韩国"], &[], &[])]);
        let plan = plan_groups(&[select], &nodes);
        assert!(plan.is_empty());
    }

    #[test]
    fn normalize_trim_dedupe_and_validate() {
        let groups = vec![SubscriptionGroup {
            name: "  节点选择 ".into(),
            kind: GroupKind::Select,
            filters: vec![GroupFilter {
                tags: vec![" 香港 ".into(), "香港".into(), "".into()],
                regions: vec![" HK ".into()],
                protocols: vec!["VLESS".into(), "vless".into()],
                ..Default::default()
            }],
            include_auto: false,
            interval: Some(120),
            strategy: Some(LoadBalanceStrategy::ConsistentHashing),
        }];
        let normalized = normalize_groups(&groups).unwrap();
        assert_eq!(normalized[0].name, "节点选择");
        assert_eq!(normalized[0].filters[0].tags, vec!["香港"]);
        assert_eq!(normalized[0].filters[0].regions, vec!["HK"]);
        assert_eq!(normalized[0].filters[0].protocols, vec!["vless"]);
        // select 不保留 interval / strategy。
        assert_eq!(normalized[0].interval, None);
        assert_eq!(normalized[0].strategy, None);

        let mut bad = groups.clone();
        bad[0].name = " ".into();
        assert_eq!(
            normalize_groups(&bad).unwrap_err().code,
            "subscription_template.group_name_required"
        );

        let mut bad = groups.clone();
        bad[0].filters.clear();
        assert_eq!(
            normalize_groups(&bad).unwrap_err().code,
            "subscription_template.filters_empty"
        );

        let mut bad = groups.clone();
        bad[0].filters[0].protocols = vec!["kcp".into()];
        assert_eq!(
            normalize_groups(&bad).unwrap_err().code,
            "subscription_template.filter_protocol_invalid"
        );

        let mut bad = groups.clone();
        bad[0].name = "x".repeat(MAX_GROUP_NAME_CHARS + 1);
        assert_eq!(
            normalize_groups(&bad).unwrap_err().code,
            "subscription_template.group_name_too_long"
        );

        let mut bad = groups.clone();
        bad[0].interval = Some(5);
        assert_eq!(
            normalize_groups(&bad).unwrap_err().code,
            "subscription_template.interval_invalid"
        );

        let mut bad = groups.clone();
        bad[0].include_auto = true;
        bad[0].name = "选择".into();
        // select + include_auto 合法；换成 url-test 才非法。
        assert!(normalize_groups(&bad).is_ok());
        bad[0].kind = GroupKind::UrlTest;
        assert_eq!(
            normalize_groups(&bad).unwrap_err().code,
            "subscription_template.include_auto_select_only"
        );
    }

    #[test]
    fn normalize_excludes_name_contains_and_strategy() {
        let groups = vec![SubscriptionGroup {
            name: " 负载 ".into(),
            kind: GroupKind::LoadBalance,
            filters: vec![GroupFilter {
                exclude_tags: vec![" 中转 ".into(), "中转".into(), "".into()],
                exclude_regions: vec![" us ".into()],
                exclude_protocols: vec!["VLESS".into(), "ss".into()],
                name_contains: Some("  HK ".into()),
                ..Default::default()
            }],
            include_auto: false,
            interval: Some(120),
            strategy: None,
        }];
        let normalized = normalize_groups(&groups).unwrap();
        assert_eq!(normalized[0].name, "负载");
        assert_eq!(normalized[0].filters[0].exclude_tags, vec!["中转"]);
        assert_eq!(normalized[0].filters[0].exclude_regions, vec!["us"]);
        assert_eq!(
            normalized[0].filters[0].exclude_protocols,
            vec!["vless", "ss"]
        );
        assert_eq!(
            normalized[0].filters[0].name_contains.as_deref(),
            Some("HK")
        );
        // load-balance 保留 interval，strategy 缺省落成 round-robin。
        assert_eq!(normalized[0].interval, Some(120));
        assert_eq!(
            normalized[0].strategy,
            Some(LoadBalanceStrategy::RoundRobin)
        );

        // fallback 也属于自动测速类组，保留 interval；strategy 清空。
        let fallback = SubscriptionGroup {
            name: "备用".into(),
            filters: vec![GroupFilter::default()],
            interval: Some(30),
            strategy: Some(LoadBalanceStrategy::ConsistentHashing),
            ..group("备用", GroupKind::Fallback, vec![])
        };
        let normalized = normalize_groups(&[fallback]).unwrap();
        assert_eq!(normalized[0].interval, Some(30));
        assert_eq!(normalized[0].strategy, None);

        // 排除协议同样校验白名单。
        let bad = SubscriptionGroup {
            filters: vec![GroupFilter {
                exclude_protocols: vec!["kcp".into()],
                ..Default::default()
            }],
            ..group("坏", GroupKind::Select, vec![])
        };
        assert_eq!(
            normalize_groups(&[bad]).unwrap_err().code,
            "subscription_template.filter_protocol_invalid"
        );

        // name_contains 有长度上限。
        let bad = SubscriptionGroup {
            filters: vec![GroupFilter {
                name_contains: Some("x".repeat(MAX_NAME_CONTAINS_CHARS + 1)),
                ..Default::default()
            }],
            ..group("坏", GroupKind::Select, vec![])
        };
        let error = normalize_groups(&[bad]).unwrap_err();
        assert_eq!(error.code, "subscription_template.filter_value_too_long");
        assert_eq!(error.params["field"], "name_contains");
    }

    /// 第一轮写进库里的 `groups_json` 没有新字段，必须按默认值继续可用。
    #[test]
    fn legacy_groups_json_deserializes_with_defaults() {
        let legacy = r#"[
            {"name":"节点选择","type":"select","filters":[{"tags":["香港"]}],"include_auto":true},
            {"name":"自动选择","type":"url-test","filters":[{}],"interval":120}
        ]"#;
        let groups: Vec<SubscriptionGroup> = serde_json::from_str(legacy).unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].filters[0].tags, vec!["香港"]);
        assert!(groups[0].filters[0].exclude_tags.is_empty());
        assert!(groups[0].filters[0].exclude_regions.is_empty());
        assert!(groups[0].filters[0].exclude_protocols.is_empty());
        assert!(groups[0].filters[0].name_contains.is_none());
        assert_eq!(groups[0].strategy, None);
        assert_eq!(groups[1].interval, Some(120));
        // 旧模板原样再次规范化后语义不变。
        let normalized = normalize_groups(&groups).unwrap();
        assert_eq!(normalized, groups);

        // 新字段可以正常反序列化并回写。
        let extended = r#"[
            {"name":"负载","type":"load-balance","strategy":"consistent-hashing",
             "filters":[{"exclude_regions":["US"],"name_contains":"HK"}]}
        ]"#;
        let groups: Vec<SubscriptionGroup> = serde_json::from_str(extended).unwrap();
        assert_eq!(
            groups[0].strategy,
            Some(LoadBalanceStrategy::ConsistentHashing)
        );
        assert_eq!(groups[0].filters[0].exclude_regions, vec!["US"]);
        assert_eq!(groups[0].filters[0].name_contains.as_deref(), Some("HK"));
        let encoded = serde_json::to_string(&normalize_groups(&groups).unwrap()).unwrap();
        assert!(
            encoded.contains("\"strategy\":\"consistent-hashing\""),
            "{encoded}"
        );
    }

    #[test]
    fn plan_for_format_skips_or_approximates_what_a_client_cannot_express() {
        let nodes = nodes();
        let groups = vec![
            group(
                "故障转移",
                GroupKind::Fallback,
                vec![filter(&[], &["HK"], &[])],
            ),
            load_balance("负载均衡", Some(LoadBalanceStrategy::ConsistentHashing)),
        ];
        let plan = plan_groups(&groups, &nodes);

        // Clash / mihomo / Stash 四种组都原生支持。
        for format in ["clash", "mihomo", "stash"] {
            let filtered = plan_for_format(&plan, format);
            assert_eq!(filtered.groups.len(), 2, "{format}");
            assert_eq!(filtered.warnings, plan.warnings, "{format}");
            assert!(
                filtered
                    .warnings
                    .iter()
                    .all(|warning| !warning.contains("urltest")),
                "{format} 不应出现近似 warning"
            );
        }

        // Surge 的 load-balance 没有 strategy 字段：consistent-hashing 无法表达 → 跳过。
        let surge = plan_for_format(&plan, "surge");
        assert_eq!(surge.groups.len(), 1);
        assert_eq!(surge.groups[0].name, "故障转移");
        assert!(
            surge.warnings.iter().any(|warning| {
                warning.contains("负载均衡")
                    && warning.contains("load-balance")
                    && warning.contains("surge")
            }),
            "{:?}",
            surge.warnings
        );

        // round-robin 的 load-balance 在 Surge 里可以表达。
        let round_robin = plan_groups(
            &[load_balance("轮询", Some(LoadBalanceStrategy::RoundRobin))],
            &nodes,
        );
        assert_eq!(plan_for_format(&round_robin, "surge").groups.len(), 1);

        // sing-box 没有 load-balance：保留组并用 urltest 近似，同时 warning。
        let singbox = plan_for_format(&plan, "singbox");
        assert_eq!(singbox.groups.len(), 2);
        assert!(
            singbox
                .warnings
                .iter()
                .any(|warning| warning.contains("urltest")),
            "{:?}",
            singbox.warnings
        );

        // 唯一一个组被跳过时必须回落，并说明原因。
        let only_load_balance = plan_groups(
            &[load_balance(
                "只有负载均衡",
                Some(LoadBalanceStrategy::ConsistentHashing),
            )],
            &nodes,
        );
        let filtered = plan_for_format(&only_load_balance, "surge");
        assert!(filtered.is_empty());
        assert!(
            filtered
                .warnings
                .iter()
                .any(|warning| warning.contains("回落到内置分组")),
            "{:?}",
            filtered.warnings
        );
    }

    #[test]
    fn include_auto_prefers_url_test_then_fallback_then_load_balance() {
        let nodes = nodes();
        let select = SubscriptionGroup {
            name: "节点选择".into(),
            kind: GroupKind::Select,
            filters: vec![filter(&["香港"], &[], &[])],
            include_auto: true,
            interval: None,
            strategy: None,
        };
        let auto = |name: &str, kind: GroupKind| SubscriptionGroup {
            name: name.into(),
            kind,
            filters: vec![GroupFilter::default()],
            include_auto: false,
            interval: None,
            strategy: None,
        };

        // 三类自动组都在 → 永远优先 url-test，与声明顺序无关。
        let plan = plan_groups(
            &[
                select.clone(),
                auto("负载均衡", GroupKind::LoadBalance),
                auto("故障转移", GroupKind::Fallback),
                auto("自动选择", GroupKind::UrlTest),
            ],
            &nodes,
        );
        assert_eq!(
            plan.groups[0].members,
            vec!["自动选择", "香港-1", "香港-2", "DIRECT"],
            "url-test 必须优先于 fallback / load-balance"
        );

        // 没有 url-test → fallback 接棒。
        let plan = plan_groups(
            &[
                select.clone(),
                auto("负载均衡", GroupKind::LoadBalance),
                auto("故障转移", GroupKind::Fallback),
            ],
            &nodes,
        );
        assert_eq!(plan.groups[0].members[0], "故障转移", "{:?}", plan.warnings);

        // 只有 load-balance → 用它兜底。
        let plan = plan_groups(&[select, auto("负载均衡", GroupKind::LoadBalance)], &nodes);
        assert_eq!(plan.groups[0].members[0], "负载均衡", "{:?}", plan.warnings);
    }

    /// 自动组被目标格式跳过时，`select` 的成员必须跟着剔除，不能留下悬空引用。
    #[test]
    fn plan_for_format_reselects_include_auto_per_format() {
        let nodes = nodes();
        let select = SubscriptionGroup {
            name: "节点选择".into(),
            kind: GroupKind::Select,
            filters: vec![filter(&["香港"], &[], &[])],
            include_auto: true,
            interval: None,
            strategy: None,
        };
        let load_balance = SubscriptionGroup {
            name: "负载均衡".into(),
            kind: GroupKind::LoadBalance,
            filters: vec![GroupFilter::default()],
            include_auto: false,
            interval: None,
            strategy: Some(LoadBalanceStrategy::RoundRobin),
        };
        let plan = plan_groups(&[select.clone(), load_balance.clone()], &nodes);
        assert_eq!(plan.groups[0].members[0], "负载均衡");

        // Clash / Loon 能表达轮询 load-balance：自动组成员保留。
        for format in ["clash", "mihomo", "stash", "loon"] {
            let filtered = plan_for_format(&plan, format);
            assert_eq!(filtered.groups[0].members[0], "负载均衡", "{format}");
        }

        // Surfboard 表达不了 load-balance：组被跳过，select 的成员必须同步移除。
        let filtered = plan_for_format(&plan, "surfboard");
        assert_eq!(filtered.groups.len(), 1, "{:?}", filtered.groups);
        assert_eq!(
            filtered.groups[0].members,
            vec!["香港-1", "香港-2", "DIRECT"],
            "悬空的自动组引用会让客户端报未知策略"
        );
        assert_eq!(filtered.warnings.len(), plan.warnings.len() + 2);
        assert!(
            filtered
                .warnings
                .iter()
                .any(|warning| warning.contains("自动组") && warning.contains("surfboard")),
            "{:?}",
            filtered.warnings
        );

        // 有 url-test 时不会被 fallback / load-balance 的跳过影响。
        let with_url_test = SubscriptionGroup {
            name: "自动选择".into(),
            kind: GroupKind::UrlTest,
            filters: vec![GroupFilter::default()],
            include_auto: false,
            interval: None,
            strategy: None,
        };
        let plan = plan_groups(&[select, load_balance, with_url_test], &nodes);
        let filtered = plan_for_format(&plan, "surfboard");
        assert_eq!(filtered.groups[0].members[0], "自动选择");
        assert!(
            filtered.warnings.iter().any(|warning| {
                warning.contains("负载均衡") && warning.contains("已跳过")
            }),
            "{:?}",
            filtered.warnings
        );
    }

    #[test]
    fn round_three_formats_declare_their_real_capabilities() {
        for format in ["surfboard", "loon", "egern"] {
            assert!(is_template_format(format), "{format} 必须支持订阅模板");
        }
        // Egern 复用 Surge 兼容 profile，能力边界必须与 Surge 一致。
        assert_eq!(
            group_capabilities("egern"),
            group_capabilities("surge"),
            "egern 与 surge 表达同一份 profile"
        );
        assert!(!group_capabilities("egern").load_balance_consistent_hashing);
        // Loon 只有 Random / PCC / Round-Robin。
        assert!(group_capabilities("loon").load_balance);
        assert!(!group_capabilities("loon").load_balance_consistent_hashing);
        // Surfboard 的 load-balance 只有随机分配，整类跳过。
        assert!(!group_capabilities("surfboard").load_balance);
        assert!(group_capabilities("surfboard").fallback);
    }

    #[test]
    fn duplicate_group_names_are_rejected() {
        let group = group("节点选择", GroupKind::Select, vec![GroupFilter::default()]);
        let error = normalize_groups(&[group.clone(), group]).unwrap_err();
        assert_eq!(error.code, "subscription_template.group_name_taken");
    }
}
