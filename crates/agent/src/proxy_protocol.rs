//! PROXY protocol v2 头构造（HAProxy PROXY protocol，binary 模式）。
//!
//! 入口 Agent 在连上目标后、转发第一个字节前写一次头，让落地（Xray / Web /
//! 游戏服务器）看到真实的客户端地址。**必须由用户显式开启**：不认这个头的
//! 服务端会把它当成垃圾数据，连接直接失败。
//!
//! 只实现 v2 / PROXY 命令 / TCP over IPv4 或 IPv6，不实现 LOCAL / UNIX / UDP：
//! UDP 转发在写路径就被拒绝（UDP 没有「首包前」这个位置）。
//!
//! 线路格式（大端）：
//!
//! ```text
//! 12B signature  \r\n\r\n\0\r\nQUIT\n
//! 1B  version+command  0x21
//! 1B  family+protocol  0x11 (AF_INET + STREAM) / 0x21 (AF_INET6 + STREAM)
//! 2B  address length   12 (v4) / 36 (v6)
//! 4B/16B source address
//! 4B/16B destination address
//! 2B source port
//! 2B destination port
//! ```

use std::io;
use std::net::{IpAddr, SocketAddr};

/// v2 固定签名。
pub const V2_SIGNATURE: [u8; 12] = *b"\r\n\r\n\0\r\nQUIT\n";
/// version 2（高 4 位）+ PROXY 命令（低 4 位）。
pub const V2_VERSION_COMMAND_PROXY: u8 = 0x21;
/// AF_INET + SOCK_STREAM。
pub const V2_FAMILY_TCP4: u8 = 0x11;
/// AF_INET6 + SOCK_STREAM。
pub const V2_FAMILY_TCP6: u8 = 0x21;

/// 构造一个 v2 PROXY 头。
///
/// `source` 是入口连接的 peer（真实客户端），`destination` 是实际连上的目标
/// 地址（用 `TcpStream::peer_addr()`，因此域名也已经是解析后的 IP）。
///
/// 两个地址的族不一致时（例如客户端 IPv6、目标 IPv4），把 IPv4 一侧映射成
/// IPv4-mapped IPv6 后统一发 TCP6：PROXY v2 的 family 只有一个，混合族无法
/// 原样表达；映射后落地仍能拿回原始 IPv4 地址，且不会丢掉来源。
pub fn v2_header(source: SocketAddr, destination: SocketAddr) -> io::Result<Vec<u8>> {
    let (source_ip, destination_ip) = (source.ip(), destination.ip());
    // 只有「源 + 目的都是 IPv4」时才发 TCP4；其它情况（含混合族）统一发
    // TCP6，IPv4 一侧映射成 IPv4-mapped IPv6。
    let tcp4 = source_ip.is_ipv4() && destination_ip.is_ipv4();

    let mut header = Vec::with_capacity(52);
    header.extend_from_slice(&V2_SIGNATURE);
    header.push(V2_VERSION_COMMAND_PROXY);
    header.push(if tcp4 { V2_FAMILY_TCP4 } else { V2_FAMILY_TCP6 });
    if tcp4 {
        header.extend_from_slice(&12u16.to_be_bytes());
        header.extend_from_slice(&ipv4_octets(source_ip)?);
        header.extend_from_slice(&ipv4_octets(destination_ip)?);
    } else {
        header.extend_from_slice(&36u16.to_be_bytes());
        header.extend_from_slice(&ipv6_octets(source_ip));
        header.extend_from_slice(&ipv6_octets(destination_ip));
    }
    header.extend_from_slice(&source.port().to_be_bytes());
    header.extend_from_slice(&destination.port().to_be_bytes());
    Ok(header)
}

fn ipv4_octets(ip: IpAddr) -> io::Result<[u8; 4]> {
    match ip {
        IpAddr::V4(v4) => Ok(v4.octets()),
        IpAddr::V6(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "PROXY protocol v2: 期望 IPv4 地址",
        )),
    }
}

fn ipv6_octets(ip: IpAddr) -> [u8; 16] {
    match ip {
        IpAddr::V4(v4) => v4.to_ipv6_mapped().octets(),
        IpAddr::V6(v6) => v6.octets(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// 精确字节：IPv4 + TCP，源 192.0.2.1:12345 → 目标 198.51.100.7:443。
    #[test]
    fn ipv4_header_is_byte_exact() {
        let source: SocketAddr = "192.0.2.1:12345".parse().unwrap();
        let destination: SocketAddr = "198.51.100.7:443".parse().unwrap();
        let header = v2_header(source, destination).unwrap();
        assert_eq!(header.len(), 28, "16 字节固定前缀 + 12 字节地址");
        assert_eq!(
            hex(&header),
            "0d 0a 0d 0a 00 0d 0a 51 55 49 54 0a 21 11 00 0c \
             c0 00 02 01 c6 33 64 07 30 39 01 bb"
        );
        assert_eq!(&header[..12], &V2_SIGNATURE);
        assert_eq!(header[12], 0x21, "version 2 + PROXY");
        assert_eq!(header[13], 0x11, "AF_INET + STREAM");
    }

    /// 精确字节：IPv6 + TCP，源 2001:db8::1:23456 → 目标 2001:db8::2:8443。
    #[test]
    fn ipv6_header_is_byte_exact() {
        let source: SocketAddr = "[2001:db8::1]:23456".parse().unwrap();
        let destination: SocketAddr = "[2001:db8::2]:8443".parse().unwrap();
        let header = v2_header(source, destination).unwrap();
        assert_eq!(header.len(), 52, "16 字节固定前缀 + 36 字节地址");
        let expected = "0d 0a 0d 0a 00 0d 0a 51 55 49 54 0a 21 21 00 24 \
             20 01 0d b8 00 00 00 00 00 00 00 00 00 00 00 01 \
             20 01 0d b8 00 00 00 00 00 00 00 00 00 00 00 02 \
             5b a0 20 fb";
        assert_eq!(hex(&header), expected);
        assert_eq!(header[13], 0x21, "AF_INET6 + STREAM");
    }

    /// 混合地址族：统一映射成 IPv4-mapped IPv6，family=TCP6，来源不丢。
    #[test]
    fn mixed_families_map_to_ipv6() {
        let source: SocketAddr = "192.0.2.1:12345".parse().unwrap();
        let destination: SocketAddr = "[2001:db8::2]:443".parse().unwrap();
        let header = v2_header(source, destination).unwrap();
        assert_eq!(header[13], V2_FAMILY_TCP6);
        assert_eq!(header.len(), 52);
        // 源地址是 ::ffff:192.0.2.1。
        assert_eq!(
            &header[16..32],
            &[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 0, 2, 1]
        );
    }

    #[test]
    fn constants_match_spec() {
        assert_eq!(V2_SIGNATURE, *b"\r\n\r\n\0\r\nQUIT\n");
        assert_eq!(V2_VERSION_COMMAND_PROXY, 0x21);
        assert_eq!(V2_FAMILY_TCP4, 0x11);
        assert_eq!(V2_FAMILY_TCP6, 0x21);
    }
}
