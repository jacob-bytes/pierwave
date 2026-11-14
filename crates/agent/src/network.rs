//! 网卡采集：名称 + 本机 IP（v4 / v6，不含 CIDR）。
//!
//! 主控用这份列表做「限定从某块网卡出入流量」的校验与配置注入，所以地址必须
//! 是**裸 IP**：带 `/24` 写进 Xray 的 `listen` / `sendThrough` 会直接非法。
//!
//! 采集失败（权限、平台不支持、系统调用失败）不 panic：返回空数组并只记一次
//! warn。主控收到空数组会按「尚未上报」处理，绝不猜测地址。

use std::net::IpAddr;
use std::sync::Once;

use pierwave_proto::NetworkInterface;

/// 采集失败只提醒一次：心跳每 15 秒一次，失败时不能刷日志。
static WARN_ONCE: Once = Once::new();

/// 采集所有网卡。返回的地址保留操作系统顺序（通常是主地址在前），
/// 同名网卡的地址去重，不做 CIDR 拼接。
pub fn collect() -> std::io::Result<Vec<NetworkInterface>> {
    let interfaces = if_addrs::get_if_addrs()?;
    Ok(group_interfaces(
        interfaces
            .into_iter()
            .map(|interface| (interface.name, interface.addr.ip())),
    ))
}

/// 心跳路径用：失败降级为空数组 + 一次性 warn，绝不让采集失败打断心跳。
pub fn collect_or_warn() -> Vec<NetworkInterface> {
    match collect() {
        Ok(interfaces) => interfaces,
        Err(error) => {
            WARN_ONCE.call_once(|| {
                tracing::warn!(%error, "采集网卡列表失败，本轮心跳上报空数组");
            });
            Vec::new()
        }
    }
}

/// 把 `(网卡名, IP)` 扁平列表按网卡聚合，地址去重并保持首次出现顺序。
///
/// 抽成纯函数是为了能单测：真实 `getifaddrs` 的输出依赖运行环境。
fn group_interfaces(items: impl IntoIterator<Item = (String, IpAddr)>) -> Vec<NetworkInterface> {
    let mut grouped: Vec<NetworkInterface> = Vec::new();
    for (name, ip) in items {
        let address = ip.to_string();
        match grouped.iter_mut().find(|interface| interface.name == name) {
            Some(interface) => {
                if !interface.addresses.contains(&address) {
                    interface.addresses.push(address);
                }
            }
            None => grouped.push(NetworkInterface {
                name,
                addresses: vec![address],
            }),
        }
    }
    grouped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_addresses_by_name_and_dedupes() {
        let grouped = group_interfaces(vec![
            ("eth0".into(), "10.0.0.2".parse().unwrap()),
            ("eth0".into(), "2001:db8::2".parse().unwrap()),
            ("eth0".into(), "10.0.0.2".parse().unwrap()),
            ("lo".into(), "127.0.0.1".parse().unwrap()),
        ]);
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].name, "eth0");
        assert_eq!(grouped[0].addresses, vec!["10.0.0.2", "2001:db8::2"]);
        assert_eq!(grouped[1].name, "lo");
        assert_eq!(grouped[1].addresses, vec!["127.0.0.1"]);
    }

    /// 真实采集至少要满足主控的硬约束：地址是裸 IP、网卡名非空。
    #[test]
    fn real_collection_yields_bare_ip_addresses() {
        let interfaces = collect().expect("本机 getifaddrs 不应失败");
        for interface in &interfaces {
            assert!(!interface.name.is_empty());
            for address in &interface.addresses {
                assert!(!address.contains('/'), "线协议里地址不能带 CIDR：{address}");
                assert!(
                    address.parse::<IpAddr>().is_ok(),
                    "地址必须是 IP 字面量：{address}"
                );
            }
        }
    }
}
