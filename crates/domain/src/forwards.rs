//! 单跳转发规则的纯逻辑校验（协议模式见 [`crate::protocol`]）。
//!
//! 这里只做「不查库」的字段校验；端口是否与节点/其它转发冲突依赖服务器上的
//! 现有数据，放在 master 的 `routes::forwards` 里查仓储后判断。
//!
//! 保留端口写死：API 入站固定监听 10085，SSH 默认 22。两者都不能被转发占用，
//! 否则 Agent 一旦监听成功就会顶掉主控或远程登录。

use std::collections::BTreeSet;

use serde_json::json;

use crate::error::DomainError;

/// 转发监听端口的合法范围。
pub const PORT_MIN: i64 = 1;
pub const PORT_MAX: i64 = 65535;

/// 目标地址最大字符数。
pub const TARGET_HOST_MAX_CHARS: usize = 255;

/// 规则名最大字符数（列表/审计里展示用）。
pub const NAME_MAX_CHARS: usize = 64;

/// 不允许被转发监听的端口：`10085` = API 入站，`22` = SSHD。
pub const RESERVED_PORTS: &[i64] = &[22, 10085];

/// 独立单跳转发下发时的 id 前缀。
///
/// 存储层主键仍是裸 UUID；下发前加前缀是为了和链推导出的
/// `chain-<chain_id>-<seq>` 在同一个 `DesiredState.forwards` 列表里不会撞 id。
pub const DESIRED_ID_PREFIX: &str = "fwd-";

/// 独立单跳转发在期望态里的稳定 id：`fwd-<uuid>`。
pub fn desired_id(forward_id: &str) -> String {
    format!("{DESIRED_ID_PREFIX}{forward_id}")
}

/// API 入站的固定端口；与 `xray::build_config` 里的 api inbound 保持一致。
pub const API_PORT: i64 = 10085;

/// SSHD 默认端口。
pub const SSHD_PORT: i64 = 22;

pub fn is_reserved_port(port: i64) -> bool {
    RESERVED_PORTS.contains(&port)
}

fn validate_port(port: i64, code: &'static str, label: &str) -> Result<(), DomainError> {
    if (PORT_MIN..=PORT_MAX).contains(&port) {
        Ok(())
    } else {
        Err(DomainError::with_params(
            code,
            json!({ "min": PORT_MIN, "max": PORT_MAX }),
            format!("{label}必须在 {PORT_MIN}-{PORT_MAX} 之间（当前 {port}）"),
        ))
    }
}

/// 监听端口范围校验（1..=65535）。
pub fn validate_listen_port(port: i64) -> Result<(), DomainError> {
    validate_port(port, "forward.listen_port_invalid", "监听端口")
}

/// 目标端口范围校验（1..=65535）。
pub fn validate_target_port(port: i64) -> Result<(), DomainError> {
    validate_port(port, "forward.target_port_invalid", "目标端口")
}

/// 黑名单端口：API（10085）与 SSHD（22）。
pub fn ensure_port_not_reserved(port: i64) -> Result<(), DomainError> {
    if is_reserved_port(port) {
        return Err(DomainError::with_params(
            "forward.port_reserved",
            json!({ "port": port }),
            format!("端口 {port} 是保留端口（API {API_PORT} / SSH {SSHD_PORT}），不能用于转发"),
        ));
    }
    Ok(())
}

/// 目标地址：去首尾空白后不能为空，且不超过 255 个字符。
pub fn normalize_target_host(raw: &str) -> Result<String, DomainError> {
    let host = raw.trim();
    if host.is_empty() {
        return Err(DomainError::new(
            "forward.target_host_required",
            "目标地址不能为空",
        ));
    }
    if host.chars().count() > TARGET_HOST_MAX_CHARS {
        return Err(DomainError::with_params(
            "forward.target_host_too_long",
            json!({ "max": TARGET_HOST_MAX_CHARS }),
            format!("目标地址最多 {TARGET_HOST_MAX_CHARS} 个字符"),
        ));
    }
    Ok(host.to_string())
}

/// 规则名：去首尾空白后不能为空，且不超过 64 个字符。
pub fn normalize_name(raw: &str) -> Result<String, DomainError> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(DomainError::new(
            "forward.name_required",
            "转发名称不能为空",
        ));
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(DomainError::with_params(
            "forward.name_too_long",
            json!({ "max": NAME_MAX_CHARS }),
            format!("转发名称最多 {NAME_MAX_CHARS} 个字符"),
        ));
    }
    Ok(name.to_string())
}

/// 自连放大检查：目标指向「本机 + 与本规则相同的端口」时会形成无限回环。
///
/// `0.0.0.0` 监听意味着本机所有地址都可连，所以把通配地址与回环地址视为同一台机器；
/// 这是字符串级判断（不做 DNS 解析），能挡住最常见的手误，解析型自连由 Agent 侧日志暴露。
pub fn ensure_not_self_loop(
    listen_host: &str,
    listen_port: i64,
    target_host: &str,
    target_port: i64,
) -> Result<(), DomainError> {
    if listen_port != target_port {
        return Ok(());
    }
    let wildcard = matches!(listen_host.trim(), "0.0.0.0" | "[::]" | "::" | "");
    if wildcard && is_loopback_host(target_host) {
        return Err(DomainError::with_params(
            "forward.self_loop",
            json!({ "port": listen_port }),
            format!(
                "目标指向本机同一端口 {listen_port}，会形成自连回环；请填写实际落地地址或换一个目标端口"
            ),
        ));
    }
    Ok(())
}

/// 目标地址是否是本机回环（不解析 DNS，只认最常见的几种写法）。
///
/// 自动分配端口时用它决定是否要避开目标端口，避免刚分到的监听端口
/// 立刻被 [`ensure_not_self_loop`] 判成自连。
pub fn is_loopback_host(host: &str) -> bool {
    matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "127.0.0.1" | "localhost" | "::1" | "[::1]"
    )
}

/// 自助转发的生效额度快照（迁移 0044）。
///
/// 由 master 在每次写入前从库里现算，**不做缓存**：管理员改套餐后立即生效。
/// `server_ids` 已升序去重。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ForwardAllowance {
    /// 生效中套餐里最大的 `forward_limit`；无套餐 / 全部为 0 时是 0。
    pub limit: i64,
    /// 允许落地的服务器并集。
    pub server_ids: Vec<String>,
}

impl ForwardAllowance {
    /// `grants` 只应包含**生效中**的套餐：`(forward_limit, 服务器白名单)`。
    ///
    /// 白名单只合并 `forward_limit > 0` 的套餐：不发放条数的套餐不应该
    /// 顺带把服务器放行（否则「限额 0 + 白名单」会让用户能借用别的套餐的额度
    /// 落到一台本不该开放的服务器上）。
    pub fn from_grants(grants: &[(i64, Vec<String>)]) -> Self {
        let limit = grants.iter().map(|(limit, _)| *limit).max().unwrap_or(0);
        let mut server_ids = BTreeSet::new();
        for (grant_limit, servers) in grants {
            if *grant_limit <= 0 {
                continue;
            }
            server_ids.extend(servers.iter().filter(|id| !id.is_empty()).cloned());
        }
        Self {
            limit,
            server_ids: server_ids.into_iter().collect(),
        }
    }

    /// 是否允许在该服务器上创建转发。
    ///
    /// 白名单只有几台服务器，线性比较足够；不依赖「调用方一定按升序构造」，
    /// 避免以后手工构造 `ForwardAllowance` 时静默漏判。
    pub fn allows_server(&self, server_id: &str) -> bool {
        self.server_ids.iter().any(|id| id == server_id)
    }
}

/// 自动给用户创建的转发起一个名字（用户不需要填名称）。
///
/// 取 `目标地址:目标端口`，超出名称上限时按字符截断；名称只用于管理端
/// 列表与审计展示，不参与任何路由判断。
pub fn default_owner_name(target_host: &str, target_port: i64) -> String {
    let suffix = format!(":{target_port}");
    let budget = NAME_MAX_CHARS.saturating_sub(suffix.chars().count());
    let host: String = target_host.trim().chars().take(budget).collect();
    format!("{host}{suffix}")
}

/// 用户视角的入口地址：`服务器地址:自动分配端口`。
///
/// 服务器地址按「主机名 / IPv4 / 未加方括号的 IPv6」处理；IPv6 会补方括号，
/// 保证前端可以直接展示或复制进客户端。
pub fn entry_address(address: &str, port: i64) -> String {
    let address = address.trim();
    let host = if address.starts_with('[') || address.matches(':').count() < 2 {
        address.to_string()
    } else {
        format!("[{address}]")
    };
    format!("{host}:{port}")
}

/// 转发流量采样差值（只在这里定义一次，主控落库与单测共用）。
///
/// Agent 上报的是**累计字节**，主控每轮用 `current - last` 求增量：
///
/// * 正常递增：`current - last`；
/// * 计数器重置（Agent 重启 / 规则重建）：`current < last` 时取 `current`，
///   不回退、不记负数——否则一次重启会把套餐用量扣成负数；
/// * 两边都做非负钳制：数据库里的 `last` 理论上是非负的，脏数据也不能让
///   「回退」伪装成一次巨额增量。
pub fn traffic_delta(last: i64, current: i64) -> i64 {
    let last = last.max(0);
    let current = current.max(0);
    if current < last {
        current
    } else {
        current - last
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listen_and_target_ports_are_range_checked() {
        assert!(validate_listen_port(1).is_ok());
        assert!(validate_listen_port(65535).is_ok());
        for bad in [0, -1, 65536] {
            let error = validate_listen_port(bad).unwrap_err();
            assert_eq!(error.code, "forward.listen_port_invalid", "bad={bad}");
            assert!(error.message.contains("1-65535"), "{}", error.message);
        }

        assert!(validate_target_port(443).is_ok());
        for bad in [0, 65536] {
            let error = validate_target_port(bad).unwrap_err();
            assert_eq!(error.code, "forward.target_port_invalid", "bad={bad}");
        }
    }

    #[test]
    fn self_loop_is_rejected() {
        let error = ensure_not_self_loop("0.0.0.0", 8443, "127.0.0.1", 8443).unwrap_err();
        assert_eq!(error.code, "forward.self_loop");
        // 端口不同、目标是外网地址、监听在具体地址上，都不算自连
        assert!(ensure_not_self_loop("0.0.0.0", 8443, "127.0.0.1", 443).is_ok());
        assert!(ensure_not_self_loop("0.0.0.0", 8443, "10.0.0.8", 8443).is_ok());
        assert!(ensure_not_self_loop("10.0.0.2", 8443, "127.0.0.1", 8443).is_ok());
    }

    #[test]
    fn api_and_sshd_ports_are_reserved() {
        for port in [22, 10085] {
            let error = ensure_port_not_reserved(port).unwrap_err();
            assert_eq!(error.code, "forward.port_reserved");
            assert_eq!(error.params, json!({ "port": port }));
            assert!(error.message.contains("保留端口"), "{}", error.message);
        }
        assert!(ensure_port_not_reserved(2222).is_ok(), "只黑名单 22 本身");
        assert!(is_reserved_port(API_PORT));
        assert!(is_reserved_port(SSHD_PORT));
    }

    #[test]
    fn target_host_is_trimmed_and_length_checked() {
        assert_eq!(
            normalize_target_host("  10.0.0.8 ").unwrap(),
            "10.0.0.8",
            "首尾空白必须去掉"
        );
        assert_eq!(
            normalize_target_host(&"a".repeat(TARGET_HOST_MAX_CHARS)).unwrap(),
            "a".repeat(TARGET_HOST_MAX_CHARS)
        );

        let empty = normalize_target_host("   ").unwrap_err();
        assert_eq!(empty.code, "forward.target_host_required");

        let too_long = normalize_target_host(&"a".repeat(TARGET_HOST_MAX_CHARS + 1)).unwrap_err();
        assert_eq!(too_long.code, "forward.target_host_too_long");
        assert_eq!(too_long.params, json!({ "max": TARGET_HOST_MAX_CHARS }));
    }

    #[test]
    fn desired_ids_are_prefixed_and_stable() {
        assert_eq!(desired_id("abc"), "fwd-abc");
        assert!(desired_id("abc").starts_with(DESIRED_ID_PREFIX));
        assert_ne!(
            desired_id("abc"),
            crate::chains::forward_id("abc", 0, "srv-a", 1),
            "独立转发与链推导的 id 前缀必须不同"
        );
    }

    #[test]
    fn name_is_required_and_bounded() {
        assert_eq!(normalize_name(" 香港中转 ").unwrap(), "香港中转");
        assert_eq!(
            normalize_name(&"a".repeat(NAME_MAX_CHARS)).unwrap(),
            "a".repeat(NAME_MAX_CHARS)
        );
        assert_eq!(
            normalize_name("\t ").unwrap_err().code,
            "forward.name_required"
        );
        assert_eq!(
            normalize_name(&"a".repeat(NAME_MAX_CHARS + 1))
                .unwrap_err()
                .code,
            "forward.name_too_long"
        );
    }

    #[test]
    fn allowance_takes_the_max_limit_and_unions_whitelists() {
        // 多套餐取最大值，白名单取并集（升序去重）。
        let allowance = ForwardAllowance::from_grants(&[
            (2, vec!["srv-b".into(), "srv-a".into()]),
            (5, vec!["srv-c".into(), "srv-a".into()]),
            (1, vec!["srv-z".into()]),
        ]);
        assert_eq!(allowance.limit, 5);
        assert_eq!(
            allowance.server_ids,
            vec!["srv-a", "srv-b", "srv-c", "srv-z"]
        );
        assert!(allowance.allows_server("srv-b"));
        assert!(!allowance.allows_server("srv-x"));

        // 没有套餐 / 全部 limit = 0：条数为 0，且没有任何服务器被放行。
        let none = ForwardAllowance::from_grants(&[]);
        assert_eq!(none, ForwardAllowance::default());
        assert!(!none.allows_server("srv-a"));

        let zero = ForwardAllowance::from_grants(&[(0, vec!["srv-a".into()])]);
        assert_eq!(zero.limit, 0);
        assert!(
            zero.server_ids.is_empty(),
            "限额 0 的套餐不能顺带放行服务器"
        );
        assert!(!zero.allows_server("srv-a"));

        // 过滤空 id，避免空串被当成一台服务器。
        let dirty = ForwardAllowance::from_grants(&[(1, vec![String::new(), "srv-a".into()])]);
        assert_eq!(dirty.server_ids, vec!["srv-a"]);
    }

    #[test]
    fn entry_address_brackets_ipv6_and_keeps_hosts_plain() {
        assert_eq!(entry_address("203.0.113.7", 20000), "203.0.113.7:20000");
        assert_eq!(
            entry_address(" hk.example.com ", 8443),
            "hk.example.com:8443"
        );
        assert_eq!(entry_address("2001:db8::1", 20000), "[2001:db8::1]:20000");
        assert_eq!(entry_address("[2001:db8::1]", 20000), "[2001:db8::1]:20000");
    }

    #[test]
    fn default_owner_name_uses_target_and_is_truncated() {
        assert_eq!(default_owner_name(" 10.0.0.8 ", 443), "10.0.0.8:443");
        let long = default_owner_name(&"a".repeat(TARGET_HOST_MAX_CHARS), 443);
        assert_eq!(long.chars().count(), NAME_MAX_CHARS);
        assert!(long.ends_with("443"), "截断后至少保留端口：{long}");
    }

    #[test]
    fn loopback_hosts_are_recognized() {
        for host in ["127.0.0.1", " localhost ", "::1", "[::1]"] {
            assert!(is_loopback_host(host), "host={host}");
        }
        for host in ["10.0.0.8", "example.com", "0.0.0.0"] {
            assert!(!is_loopback_host(host), "host={host}");
        }
    }

    #[test]
    fn traffic_delta_accumulates_increments() {
        // 首次采样：last = 0、current = 100 → 计 100。
        assert_eq!(traffic_delta(0, 100), 100);
        // 增量采样：last = 100、current = 250 → 计 150。
        assert_eq!(traffic_delta(100, 250), 150);
        // 没有新流量：计 0。
        assert_eq!(traffic_delta(250, 250), 0);
        // 进程刚启动、还没跑流量：计 0。
        assert_eq!(traffic_delta(0, 0), 0);
    }

    #[test]
    fn traffic_delta_treats_counter_reset_as_current() {
        // 计数器重置：last = 250、current = 30 → 计 30（不是 -220）。
        assert_eq!(traffic_delta(250, 30), 30);
        // 恰好归零：本轮计 0，下一轮从新基线开始。
        assert_eq!(traffic_delta(250, 0), 0);
        // 脏的负 last 不能放大增量。
        assert_eq!(traffic_delta(-100, 30), 30);
        // 脏的负 current 按 0 处理，绝不产生负数。
        assert_eq!(traffic_delta(100, -5), 0);
    }
}
