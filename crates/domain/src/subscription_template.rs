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

/// 模板里一个代理组的类型。只有这两种在 Clash / mihomo 里有稳定表达。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GroupKind {
    #[serde(rename = "select")]
    Select,
    #[serde(rename = "url-test")]
    UrlTest,
}

impl GroupKind {
    pub fn as_str(self) -> &'static str {
        match self {
            GroupKind::Select => "select",
            GroupKind::UrlTest => "url-test",
        }
    }
}

/// 一个筛选条件。三个数组都是「空 = 不限制」，彼此之间是 **AND**。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupFilter {
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub regions: Vec<String>,
    #[serde(default)]
    pub protocols: Vec<String>,
}

impl GroupFilter {
    /// 空 filter（`{}`）= 命中全部节点。
    pub fn is_empty(&self) -> bool {
        self.tags.is_empty() && self.regions.is_empty() && self.protocols.is_empty()
    }

    /// filter 内条件全部满足才算命中（AND）。
    pub fn matches(&self, node: &SubNode) -> bool {
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
        tags_ok && regions_ok && protocols_ok
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
    /// 仅 `url-test` 有意义：测速间隔（秒），缺省 300。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<u32>,
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
/// url-test 的测速间隔范围（秒）。
pub const MIN_INTERVAL_SECS: u32 = 10;
pub const MAX_INTERVAL_SECS: u32 = 86_400;

const PROTOCOLS: &[&str] = &["vless", "vmess", "trojan", "ss"];

fn trim_dedupe(values: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(values.len());
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if !out.iter().any(|item| item == value) {
            out.push(value.to_string());
        }
    }
    out
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
            for (field, values) in [
                ("tags", &filter.tags),
                ("regions", &filter.regions),
                ("protocols", &filter.protocols),
            ] {
                if values.len() > MAX_FILTER_VALUES {
                    return Err(TemplateProblem::new(
                        "subscription_template.too_many_values",
                        serde_json::json!({ "name": name, "field": field, "max": MAX_FILTER_VALUES }),
                        format!("代理组「{name}」的筛选条件 {field} 最多 {MAX_FILTER_VALUES} 项"),
                    ));
                }
            }
            for tag in filter
                .tags
                .iter()
                .map(|tag| tag.trim())
                .filter(|tag| !tag.is_empty())
            {
                if tag.chars().count() > MAX_TAG_CHARS {
                    return Err(TemplateProblem::new(
                        "subscription_template.filter_value_too_long",
                        serde_json::json!({ "name": name, "field": "tags", "max": MAX_TAG_CHARS }),
                        format!("代理组「{name}」的标签条件超过 {MAX_TAG_CHARS} 个字符"),
                    ));
                }
            }
            for region in filter
                .regions
                .iter()
                .map(|region| region.trim())
                .filter(|region| !region.is_empty())
            {
                if region.chars().count() > MAX_REGION_CHARS {
                    return Err(TemplateProblem::new(
                        "subscription_template.filter_value_too_long",
                        serde_json::json!({ "name": name, "field": "regions", "max": MAX_REGION_CHARS }),
                        format!("代理组「{name}」的地区条件超过 {MAX_REGION_CHARS} 个字符"),
                    ));
                }
            }
            for protocol in &filter.protocols {
                let protocol = protocol.trim().to_ascii_lowercase();
                if !PROTOCOLS.contains(&protocol.as_str()) {
                    return Err(TemplateProblem::new(
                        "subscription_template.filter_protocol_invalid",
                        serde_json::json!({ "name": name, "protocol": protocol, "allowed": PROTOCOLS }),
                        format!(
                            "代理组「{name}」的协议条件不支持 {protocol}（可选：{}）",
                            PROTOCOLS.join(" / ")
                        ),
                    ));
                }
            }
            // 协议先小写再去重：`VLESS` 与 `vless` 是同一个条件。
            let mut protocols: Vec<String> = Vec::new();
            for protocol in &filter.protocols {
                let protocol = protocol.trim().to_ascii_lowercase();
                if !protocol.is_empty() && !protocols.contains(&protocol) {
                    protocols.push(protocol);
                }
            }
            filters.push(GroupFilter {
                tags: trim_dedupe(&filter.tags),
                regions: trim_dedupe(&filter.regions),
                protocols,
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
            // select 不写 interval，避免落库后语义含糊。
            interval: if group.kind == GroupKind::UrlTest {
                group.interval
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
/// 1. 先算每个组命中的节点；`url-test` 命中 0 个 → 跳过并 warning；
/// 2. `select` 的成员 = 自动选择组（若 `include_auto` 且存在存活的 url-test 组）
///    + 命中节点 + `DIRECT`；命中 0 个节点且没有自动选择组 → 跳过并 warning；
/// 3. 所有组都跳过 → `groups` 为空，调用方回落硬编码分组。
pub fn plan_groups(groups: &[SubscriptionGroup], nodes: &[SubNode]) -> GroupPlan {
    let mut warnings = Vec::new();

    // 自动选择组 = 模板里第一个存活的 url-test 组。
    let mut survivors: Vec<Option<Vec<String>>> = Vec::with_capacity(groups.len());
    for group in groups {
        let matched = matching_nodes(group, nodes);
        match group.kind {
            GroupKind::UrlTest if matched.is_empty() => {
                warnings.push(format!(
                    "代理组「{}」没有命中任何节点，已跳过 / Group \"{}\" matched no nodes and was skipped",
                    group.name, group.name
                ));
                survivors.push(None);
            }
            _ => survivors.push(Some(matched)),
        }
    }

    let auto_name = groups
        .iter()
        .zip(&survivors)
        .find(|(group, matched)| group.kind == GroupKind::UrlTest && matched.is_some())
        .map(|(group, _)| group.name.clone());

    let mut planned = Vec::new();
    for (index, group) in groups.iter().enumerate() {
        let Some(matched) = survivors[index].clone() else {
            continue;
        };
        match group.kind {
            GroupKind::UrlTest => planned.push(PlannedGroup {
                name: group.name.clone(),
                kind: group.kind,
                members: matched.clone(),
                node_members: matched,
                interval: group.interval,
            }),
            GroupKind::Select => {
                let mut members = Vec::new();
                if group.include_auto {
                    match &auto_name {
                        Some(auto) => members.push(auto.clone()),
                        None => warnings.push(format!(
                            "代理组「{}」开启了 include_auto，但模板里没有命中节点的 url-test 组 / Group \"{}\" has include_auto but no url-test group matched any node",
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
        };
        let select = SubscriptionGroup {
            name: "节点选择".into(),
            kind: GroupKind::Select,
            filters: vec![filter(&["日本"], &[], &[])],
            include_auto: true,
            interval: None,
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
    fn empty_groups_are_skipped_with_a_warning() {
        let nodes = nodes();
        let empty = SubscriptionGroup {
            name: "韩国".into(),
            kind: GroupKind::UrlTest,
            filters: vec![filter(&["韩国"], &[], &[])],
            include_auto: false,
            interval: None,
        };
        let select = SubscriptionGroup {
            name: "节点选择".into(),
            kind: GroupKind::Select,
            filters: vec![filter(&["香港"], &[], &[])],
            include_auto: false,
            interval: None,
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
        let groups = vec![SubscriptionGroup {
            name: "韩国".into(),
            kind: GroupKind::Select,
            filters: vec![filter(&["韩国"], &[], &[])],
            include_auto: false,
            interval: None,
        }];
        let plan = plan_groups(&groups, &nodes);
        assert!(plan.is_empty());
        assert_eq!(plan.policy_target(), None);
        assert_eq!(plan.warnings.len(), 2, "{:?}", plan.warnings);
        assert!(plan.warnings[1].contains("回落"), "{:?}", plan.warnings);

        // 没有节点时同样回落，而不是生成空组。
        let plan = plan_groups(
            &[SubscriptionGroup {
                name: "全部".into(),
                kind: GroupKind::UrlTest,
                filters: vec![GroupFilter::default()],
                include_auto: false,
                interval: None,
            }],
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
        let select = SubscriptionGroup {
            name: "韩国".into(),
            kind: GroupKind::Select,
            filters: vec![filter(&["韩国"], &[], &[])],
            include_auto: false,
            interval: None,
        };
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
            }],
            include_auto: false,
            interval: Some(120),
        }];
        let normalized = normalize_groups(&groups).unwrap();
        assert_eq!(normalized[0].name, "节点选择");
        assert_eq!(normalized[0].filters[0].tags, vec!["香港"]);
        assert_eq!(normalized[0].filters[0].regions, vec!["HK"]);
        assert_eq!(normalized[0].filters[0].protocols, vec!["vless"]);
        // select 不保留 interval。
        assert_eq!(normalized[0].interval, None);

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
    fn duplicate_group_names_are_rejected() {
        let group = SubscriptionGroup {
            name: "节点选择".into(),
            kind: GroupKind::Select,
            filters: vec![GroupFilter::default()],
            include_auto: false,
            interval: None,
        };
        let error = normalize_groups(&[group.clone(), group]).unwrap_err();
        assert_eq!(error.code, "subscription_template.group_name_taken");
    }
}
