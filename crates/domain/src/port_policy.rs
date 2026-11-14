//! 服务器的「允许端口集合」：节点端口与链的自动/手填端口共用同一套口径。
//!
//! 数据库三列（见迁移 0041）：
//! * `servers.port_start` / `servers.port_end`：闭区间，两列必须同时有值；
//! * `servers.port_allow_json`：区间之外额外允许的端口，JSON 数组文本。
//!
//! 允许集合 = `[port_start, port_end] ∪ port_allow`。三者都为空 = **不限制**，
//! 与迁移前的行为逐字节一致（节点端口仍可 1–65535，链仍从
//! [`crate::chains::PORT_POOL_START`]..=[`crate::chains::PORT_POOL_END`] 自动分配）。
//!
//! 写路径用 [`PortPolicy::validated`] 严格校验（区间非法 = 400）；读路径用
//! [`PortPolicy::from_server`] 容错解析，损坏的数据按「该列不存在」处理，
//! 不让一行脏数据把节点/链的写入全部卡死。

use std::collections::HashSet;

use serde_json::json;

use crate::error::DomainError;
use crate::models::Server;

/// 合法端口下界（含）。
pub const PORT_MIN: i64 = 1;
/// 合法端口上界（含）。
pub const PORT_MAX: i64 = 65_535;

/// 解析后的允许端口集合。
///
/// `start` / `end` 为 `None` 表示该侧不设边界；但写路径要求两列同时出现或
/// 同时为空（见 [`PortPolicy::validated`]）。读路径对历史/手工数据保留单边语义。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PortPolicy {
    pub start: Option<i64>,
    pub end: Option<i64>,
    /// 已去重升序的额外端口。
    pub allow: Vec<i64>,
}

impl PortPolicy {
    /// 写路径校验：区间两端必须同时填写或同时留空；端口都在 1–65535；
    /// 起始不大于结束；额外端口去重升序。
    ///
    /// 返回的错误码：
    /// * `server.port_range_invalid`：区间缺一边、越界或起始大于结束；
    /// * `server.port_allow_invalid`：额外端口越界。
    pub fn validated(
        start: Option<i64>,
        end: Option<i64>,
        allow: &[i64],
    ) -> Result<Self, DomainError> {
        match (start, end) {
            (None, None) => {}
            (Some(start), Some(end)) => {
                if !(PORT_MIN..=PORT_MAX).contains(&start) || !(PORT_MIN..=PORT_MAX).contains(&end)
                {
                    return Err(invalid_range(start, end));
                }
                if start > end {
                    return Err(invalid_range(start, end));
                }
            }
            // 只填一边：允许集合会变成开放区间（1..end / start..65535），
            // 语义含混且容易误开大段端口；写路径直接拒绝，要求两边一起填。
            (start, end) => return Err(invalid_range_opt(start, end)),
        }
        for port in allow {
            if !(PORT_MIN..=PORT_MAX).contains(port) {
                return Err(invalid_allow(*port));
            }
        }
        Ok(Self::from_parts(start, end, Some(allow)))
    }

    /// 读路径：从服务器行构造，容忍 NULL / 单边区间 / 损坏的 `port_allow_json`。
    pub fn from_server(server: &Server) -> Self {
        let allow = parse_allow_json_vec(&server.port_allow_json);
        Self::from_parts(server.port_start, server.port_end, Some(&allow))
    }

    /// 直接按「已解析的值」构造（读路径与测试用），只做去重升序、不校验范围。
    pub fn from_parts(start: Option<i64>, end: Option<i64>, allow: Option<&[i64]>) -> Self {
        let mut allow: Vec<i64> = allow
            .unwrap_or_default()
            .iter()
            .copied()
            .filter(|port| (PORT_MIN..=PORT_MAX).contains(port))
            .collect();
        allow.sort_unstable();
        allow.dedup();
        Self { start, end, allow }
    }

    /// 是否完全不限制（旧行为）。单边区间不算不限制。
    pub fn is_unrestricted(&self) -> bool {
        self.start.is_none() && self.end.is_none() && self.allow.is_empty()
    }

    /// 端口是否在允许集合内。非法端口（< 1 或 > 65535）一律 false。
    pub fn allows(&self, port: i64) -> bool {
        if !(PORT_MIN..=PORT_MAX).contains(&port) {
            return false;
        }
        if self.is_unrestricted() {
            return true;
        }
        if self.allow.binary_search(&port).is_ok() {
            return true;
        }
        // 只有额外端口、没有区间：不在 allow 里就是不允许。
        if self.start.is_none() && self.end.is_none() {
            return false;
        }
        // 单边（只可能来自手工改库）：缺的一侧不设边界；起止倒置则区间为空。
        let start = self.start.unwrap_or(PORT_MIN);
        let end = self.end.unwrap_or(PORT_MAX);
        (start..=end).contains(&port)
    }

    /// 写回库的规范 JSON：`[443,8443]`（升序、无空格）。
    pub fn allow_json(&self) -> String {
        serde_json::to_string(&self.allow).unwrap_or_else(|_| "[]".to_string())
    }

    /// 校验一个具体端口；不在允许集合内返回 `code` 对应的 400。
    ///
    /// `code` 由调用方区分场景：节点用 `node.port_not_allowed`，链用
    /// `chain.port_not_allowed`（两者文案与插值参数一致）。
    pub fn ensure_allowed(
        &self,
        code: &'static str,
        port: i64,
        server_name: &str,
    ) -> Result<(), DomainError> {
        if self.allows(port) {
            return Ok(());
        }
        Err(DomainError::with_params(
            code,
            json!({ "port": port, "server": server_name }),
            format!("端口 {port} 不在服务器「{server_name}」允许的范围内"),
        ))
    }

    /// 从允许集合里挑最小空闲端口。
    ///
    /// * 不限制时保持旧行为：固定池 `20000..=29999`，耗尽返回
    ///   `chain.port_pool_exhausted`（参数与旧版一致）；
    /// * 有限制时只在允许集合里挑（区间 ∪ 额外端口），耗尽返回
    ///   `chain.port_allowed_exhausted`。
    ///
    /// `occupied` 由仓储一次查出（独立转发 / 节点 / 其它链成员），调用方在
    /// 分配成功后必须立即把结果并入集合。
    pub fn allocate(
        &self,
        server_id: &str,
        server_name: &str,
        occupied: &HashSet<i64>,
    ) -> Result<i64, DomainError> {
        if self.is_unrestricted() {
            let (start, end) = (crate::chains::PORT_POOL_START, crate::chains::PORT_POOL_END);
            return (start..=end)
                .find(|port| !occupied.contains(port))
                .ok_or_else(|| {
                    DomainError::with_params(
                        "chain.port_pool_exhausted",
                        json!({
                            "server_id": server_id,
                            "pool_start": start,
                            "pool_end": end,
                        }),
                        format!(
                            "服务器（{server_id}）的自动分配端口池 {start}-{end} 已耗尽；请先释放端口，或为这一跳手动填写端口"
                        ),
                    )
                });
        }

        // 有限制：区间 ∪ 额外端口，升序挑最小空闲。单边区间按缺省侧开放。
        let mut candidates: Vec<i64> = Vec::new();
        if self.start.is_some() || self.end.is_some() {
            let start = self.start.unwrap_or(PORT_MIN);
            let end = self.end.unwrap_or(PORT_MAX);
            if start <= end {
                candidates.extend(start..=end);
            }
        }
        candidates.extend(self.allow.iter().copied());
        candidates.sort_unstable();
        candidates.dedup();

        candidates
            .into_iter()
            .find(|port| !occupied.contains(port))
            .ok_or_else(|| {
                DomainError::with_params(
                    "chain.port_allowed_exhausted",
                    json!({ "server_id": server_id, "server": server_name }),
                    format!(
                        "服务器「{server_name}」允许的端口都已占用；请先释放端口，或为该跳手动填写允许范围内的端口"
                    ),
                )
            })
    }
}

/// `port_allow_json` → 端口数组；损坏 / 非数组 / 非整数一律按空数组处理。
///
/// 这里刻意容错：读路径的输入可能是手工改库或旧版本写入的脏值，不能让它
/// 把节点/链的保存整体变成 500。写路径不会走到这里（先用 `validated` 校验）。
pub fn parse_allow_json_vec(raw: &str) -> Vec<i64> {
    let Ok(values) = serde_json::from_str::<Vec<i64>>(raw) else {
        return Vec::new();
    };
    let mut values: Vec<i64> = values
        .into_iter()
        .filter(|port| (PORT_MIN..=PORT_MAX).contains(port))
        .collect();
    values.sort_unstable();
    values.dedup();
    values
}

fn invalid_allow(port: i64) -> DomainError {
    DomainError::with_params(
        "server.port_allow_invalid",
        json!({ "port": port, "min": PORT_MIN, "max": PORT_MAX }),
        format!("额外允许的端口必须是 {PORT_MIN}-{PORT_MAX} 的整数"),
    )
}

fn invalid_range(start: i64, end: i64) -> DomainError {
    DomainError::with_params(
        "server.port_range_invalid",
        json!({ "start": start, "end": end, "min": PORT_MIN, "max": PORT_MAX }),
        format!("端口范围不合法：必须在 {PORT_MIN}-{PORT_MAX} 之间，且起始端口不大于结束端口"),
    )
}

fn invalid_range_opt(start: Option<i64>, end: Option<i64>) -> DomainError {
    DomainError::with_params(
        "server.port_range_invalid",
        json!({ "start": start, "end": end, "min": PORT_MIN, "max": PORT_MAX }),
        format!("端口范围不合法：起始与结束端口必须同时填写或同时留空（{PORT_MIN}-{PORT_MAX}）"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ports(values: &[i64]) -> HashSet<i64> {
        values.iter().copied().collect()
    }

    #[test]
    fn an_empty_policy_allows_every_valid_port() {
        let policy = PortPolicy::validated(None, None, &[]).unwrap();
        assert!(policy.is_unrestricted());
        for port in [PORT_MIN, 22, 443, 20_000, PORT_MAX] {
            assert!(policy.allows(port), "port {port}");
        }
        assert_eq!(policy.allow_json(), "[]");
    }

    #[test]
    fn range_is_inclusive_and_allow_can_extend_it() {
        let policy = PortPolicy::validated(Some(30_000), Some(31_000), &[443, 8443]).unwrap();
        assert!(!policy.is_unrestricted());
        for port in [30_000, 30_500, 31_000, 443, 8443] {
            assert!(policy.allows(port), "port {port}");
        }
        for port in [4430, 29_999, 31_001, 80] {
            assert!(!policy.allows(port), "port {port}");
        }
        assert_eq!(policy.allow, vec![443, 8443]);
        assert_eq!(policy.allow_json(), "[443,8443]");
    }

    #[test]
    fn allow_only_policy_whitelists_exactly_those_ports() {
        let policy = PortPolicy::validated(None, None, &[443, 8443]).unwrap();
        assert!(!policy.is_unrestricted());
        assert!(policy.allows(443));
        assert!(policy.allows(8443));
        assert!(!policy.allows(30000));
        assert!(!policy.allows(PORT_MIN));
        assert!(!policy.allows(PORT_MAX));
    }

    #[test]
    fn invalid_ports_are_rejected_even_without_a_policy() {
        let policy = PortPolicy::from_parts(None, None, None);
        for port in [0, -1, PORT_MAX + 1] {
            assert!(!policy.allows(port), "port {port}");
        }
    }

    #[test]
    fn write_validation_rejects_inverted_out_of_range_and_one_sided_ranges() {
        for (start, end) in [
            (Some(31_000), Some(30_000)),
            (Some(0), Some(100)),
            (Some(100), Some(70_000)),
            (Some(30_000), None),
            (None, Some(31_000)),
        ] {
            let error = PortPolicy::validated(start, end, &[]).unwrap_err();
            assert_eq!(error.code, "server.port_range_invalid", "{start:?}-{end:?}");
        }
    }

    #[test]
    fn write_validation_rejects_out_of_range_allow_entries() {
        for allow in [-1, 0, PORT_MAX + 1] {
            let error = PortPolicy::validated(None, None, &[allow]).unwrap_err();
            assert_eq!(error.code, "server.port_allow_invalid", "port {allow}");
        }
    }

    #[test]
    fn allow_entries_are_deduped_and_sorted_for_a_stable_json() {
        let policy = PortPolicy::validated(None, None, &[8443, 443, 8443, 80]).unwrap();
        assert_eq!(policy.allow, vec![80, 443, 8443]);
        assert_eq!(policy.allow_json(), "[80,443,8443]");
    }

    #[test]
    fn dirty_allow_json_is_read_as_empty_instead_of_panicking() {
        for raw in ["", "{}", "null", "[\"443\"]", "443"] {
            assert!(parse_allow_json_vec(raw).is_empty(), "raw={raw:?}");
        }
        assert_eq!(
            parse_allow_json_vec("[8443, 0, 65536, 443, 443]"),
            vec![443, 8443]
        );
    }

    #[test]
    fn one_sided_range_from_dirty_data_stays_open_on_the_missing_side() {
        let only_start = PortPolicy::from_parts(Some(30_000), None, None);
        assert!(only_start.allows(30_000));
        assert!(only_start.allows(PORT_MAX));
        assert!(!only_start.allows(29_999));

        let only_end = PortPolicy::from_parts(None, Some(31_000), None);
        assert!(only_end.allows(PORT_MIN));
        assert!(only_end.allows(31_000));
        assert!(!only_end.allows(31_001));
    }

    #[test]
    fn inverted_dirty_range_does_not_widen_access_but_allow_still_works() {
        let policy = PortPolicy::from_parts(Some(31_000), Some(30_000), Some(&[443]));
        assert!(!policy.allows(30_500));
        assert!(policy.allows(443));
    }

    #[test]
    fn ensure_allowed_reports_the_scenario_specific_code_and_params() {
        let policy = PortPolicy::validated(Some(30_000), Some(31_000), &[]).unwrap();
        policy
            .ensure_allowed("node.port_not_allowed", 30_001, "hk-1")
            .unwrap();

        let error = policy
            .ensure_allowed("node.port_not_allowed", 443, "hk-1")
            .unwrap_err();
        assert_eq!(error.code, "node.port_not_allowed");
        assert_eq!(error.params, json!({ "port": 443, "server": "hk-1" }));
        assert!(error.message.contains("443"), "{}", error.message);
        assert!(error.message.contains("hk-1"), "{}", error.message);

        let error = policy
            .ensure_allowed("chain.port_not_allowed", 443, "hk-1")
            .unwrap_err();
        assert_eq!(error.code, "chain.port_not_allowed");
    }

    #[test]
    fn unrestricted_allocation_keeps_the_legacy_pool() {
        let policy = PortPolicy::validated(None, None, &[]).unwrap();
        let occupied = ports(&[crate::chains::PORT_POOL_START]);
        assert_eq!(
            policy.allocate("srv-a", "hk-a", &occupied).unwrap(),
            crate::chains::PORT_POOL_START + 1
        );
    }

    #[test]
    fn restricted_allocation_only_picks_ports_inside_the_allowed_set() {
        let policy = PortPolicy::validated(Some(30_000), Some(30_002), &[443]).unwrap();
        assert_eq!(policy.allocate("srv-a", "hk-a", &ports(&[])).unwrap(), 443);
        assert_eq!(
            policy
                .allocate("srv-a", "hk-a", &ports(&[443, 30_000]))
                .unwrap(),
            30_001
        );
    }

    #[test]
    fn restricted_allocation_ignores_the_legacy_pool_and_reports_exhaustion() {
        let policy = PortPolicy::validated(None, None, &[443]).unwrap();
        // 20000 不在允许集合里，即使空闲也不能被分到。
        assert_eq!(policy.allocate("srv-a", "hk-a", &ports(&[])).unwrap(), 443);

        let error = policy
            .allocate("srv-a", "hk-a", &ports(&[443]))
            .unwrap_err();
        assert_eq!(error.code, "chain.port_allowed_exhausted");
        assert_eq!(
            error.params,
            json!({ "server_id": "srv-a", "server": "hk-a" })
        );
    }

    #[test]
    fn unrestricted_allocation_reports_the_legacy_pool_exhausted_code() {
        let policy = PortPolicy::validated(None, None, &[]).unwrap();
        let occupied: HashSet<i64> =
            (crate::chains::PORT_POOL_START..=crate::chains::PORT_POOL_END).collect();
        let error = policy.allocate("srv-a", "hk-a", &occupied).unwrap_err();
        assert_eq!(error.code, "chain.port_pool_exhausted");
        assert_eq!(error.params["pool_start"], crate::chains::PORT_POOL_START);
        assert_eq!(error.params["pool_end"], crate::chains::PORT_POOL_END);
        assert_eq!(error.params["server_id"], "srv-a");
    }
}
