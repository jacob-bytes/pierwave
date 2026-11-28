//! 网卡采集：名称 + 本机 IP（v4 / v6，不含 CIDR）。
//!
//! 主控用这份列表做「限定从某块网卡出入流量」的校验与配置注入，所以地址必须
//! 是**裸 IP**：带 `/24` 写进 Xray 的 `listen` / `sendThrough` 会直接非法。
//!
//! 采集失败（权限、平台不支持、系统调用失败）不 panic：返回空数组并只记一次
//! warn。主控收到空数组会按「尚未上报」处理，绝不猜测地址。
//!
//! 另外提供流量计数采集（`/proc/net/dev`）：「当前网速」是两次心跳的差值，
//! 主控侧算速率；这里只负责读**累计字节**。读不到（macOS 等）返回 `None`，
//! 心跳照常上报，主控显示 `—`。

use std::net::IpAddr;
use std::sync::Once;

use pierwave_proto::NetworkInterface;

/// 采集失败只提醒一次：心跳每 15 秒一次，失败时不能刷日志。
static WARN_ONCE: Once = Once::new();

/// Linux 的网卡累计计数器来源。macOS 没有这个文件。
const PROC_NET_DEV: &str = "/proc/net/dev";

/// 汇总后的网卡累计字节数（只算非 `lo` 网卡）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct NetCounters {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

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

/// 读取本机所有非回环网卡的累计收发字节。
///
/// 返回 `None` 的三种情况（都不影响心跳）：
/// * 平台没有 `/proc/net/dev`（macOS 等）—— 这是预期行为，不记日志；
/// * 文件存在但读失败（权限等）；
/// * 内容无法解析（内核格式变化 / 空文件）。
///
/// 注意：这是**自内核启动以来**的累计值，重启会让计数回绕；主控侧的差分
/// 逻辑必须丢弃回绕那一次（见主控侧 `crates/domain/src/telemetry.rs`；Agent
/// 不依赖 `pierwave-domain`，这里只作为文档引用）。
pub fn collect_net_counters() -> Option<NetCounters> {
    match std::fs::read_to_string(PROC_NET_DEV) {
        Ok(raw) => parse_proc_net_dev(&raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            WARN_ONCE.call_once(|| {
                tracing::warn!(%error, "读取 /proc/net/dev 失败，本轮心跳不带上网速");
            });
            None
        }
    }
}

/// 解析 `/proc/net/dev`，汇总所有非 `lo` 网卡的 rx/tx 字节。
///
/// 格式（内核固定两行表头，之后每行 `iface: rx_bytes ... tx_bytes ...`）：
/// ```text
/// Inter-|   Receive                                                |  Transmit
///  face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets ...
///     lo: 123456    1000    0    0    0     0          0         0   123456    1000 ...
///   eth0: 9876543   5000    0    0    0     0          0         0  1234567    4000 ...
/// ```
///
/// `lo` 是本机回环：主控展示的「网速」是机器对外的收发，把回环算进去会
/// 让本机服务间通信虚增流量（而且 127.0.0.1 的 rx 和 tx 基本相等）。
fn parse_proc_net_dev(raw: &str) -> Option<NetCounters> {
    let mut counters = NetCounters::default();
    let mut parsed_any = false;

    for line in raw.lines() {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || name == "lo" {
            continue;
        }
        let mut fields = rest.split_whitespace();
        let Some(rx) = fields.next().and_then(|value| value.parse::<u64>().ok()) else {
            continue;
        };
        // 接收方向共 8 列，发送字节是第 9 列（下标 8）。
        let Some(tx) = fields.nth(7).and_then(|value| value.parse::<u64>().ok()) else {
            continue;
        };
        counters.rx_bytes = counters.rx_bytes.saturating_add(rx);
        counters.tx_bytes = counters.tx_bytes.saturating_add(tx);
        parsed_any = true;
    }

    parsed_any.then_some(counters)
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

    const SAMPLE: &str = "Inter-|   Receive                                                |  Transmit\n \
                           face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n \
                              lo: 111111    2222    0    0    0     0          0         0   111111    2222    0    0    0     0       0          0\n \
                            eth0: 9876543   5000    0    0    0     0          0         0  1234567    4000    0    0    0     0       0          0\n \
                           wlan0:  1000     10    0    0    0     0          0         0     2000      20    0    0    0     0       0          0\n";

    #[test]
    fn parses_proc_net_dev_and_skips_loopback() {
        let counters = parse_proc_net_dev(SAMPLE).unwrap();
        assert_eq!(
            counters.rx_bytes,
            9_876_543 + 1_000,
            "汇总所有非 lo 网卡的接收字节"
        );
        assert_eq!(
            counters.tx_bytes,
            1_234_567 + 2_000,
            "汇总所有非 lo 网卡的发送字节"
        );
    }

    #[test]
    fn proc_net_dev_without_usable_rows_is_none() {
        assert_eq!(
            parse_proc_net_dev(""),
            None,
            "空文件不能当成「0 字节」，主控会显示 0"
        );
        assert_eq!(
            parse_proc_net_dev(
                "Inter-|   Receive |  Transmit\n face |bytes|bytes\n  lo: 10 0 0 0 0 0 0 0 10 0 0 0 0 0 0 0\n"
            ),
            None,
            "只有回环时没有可上报的对公网卡"
        );
        // 列数不足的行直接跳过；至少有一行可用才算解析成功。
        assert_eq!(
            parse_proc_net_dev("face |bytes\n eth0: 12 34\n"),
            None,
            "列数不足不能瞎猜发送字节"
        );
    }

    /// macOS / 无 `/proc/net/dev` 的环境必须安静地返回 None，而不是 panic。
    #[test]
    fn missing_proc_file_returns_none() {
        if std::path::Path::new(PROC_NET_DEV).exists() {
            // Linux 测试机上只验证真实采集不 panic；具体数值随流量变化，不断言。
            let counters = collect_net_counters();
            assert!(
                counters.is_some(),
                "有 /proc/net/dev 的机器应当能采到计数器"
            );
        } else {
            assert_eq!(collect_net_counters(), None);
        }
    }
}
