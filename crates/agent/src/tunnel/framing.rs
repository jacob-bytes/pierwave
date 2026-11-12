//! 隧道帧格式与 SOCKS5 风格的目标地址。
//!
//! 帧：`[u8 kind][u32 len][payload]`，`len` 是大端。
//!
//! 首帧 DATA 的 payload 是 `ATYP + ADDR + PORT`（与 SOCKS5 相同），之后的
//! DATA 帧都是裸字节。首帧允许在地址后面直接跟一段初始数据（P16.1 的客户端
//! 不发，但协议保留这个位置，避免以后加「带首包连接」时改帧格式）。
//!
//! 64 KiB 是**硬上限**，超限直接断开而不是截断：两端对 len 的解释必须完全
//! 一致，否则一端按 64 KiB 解析、另一端继续发更大的帧时，后续帧头会被当成
//! 上一帧的 payload，协议直接错位。

use std::fmt;
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// 单个帧 payload 的上限：64 KiB。
pub const MAX_FRAME_PAYLOAD: usize = 64 * 1024;

const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;

/// 帧类型。线上值是稳定协议的一部分，不能重排。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameKind {
    /// 数据帧；首帧的 payload 以目标地址开头。
    Data = 0x01,
    /// 立即断开（不做半关、不排空），与 TCP FIN 的半关语义不同。
    Close = 0x02,
    /// 心跳；P16.1 的接收方直接忽略，不回包（回包会形成无尽 ping-pong）。
    Ping = 0x03,
}

impl TryFrom<u8> for FrameKind {
    type Error = FrameError;

    fn try_from(byte: u8) -> Result<Self, Self::Error> {
        match byte {
            0x01 => Ok(Self::Data),
            0x02 => Ok(Self::Close),
            0x03 => Ok(Self::Ping),
            other => Err(FrameError::UnknownKind(other)),
        }
    }
}

/// 一个完整的帧。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: FrameKind,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn data(payload: Vec<u8>) -> Self {
        Self {
            kind: FrameKind::Data,
            payload,
        }
    }

    pub fn close() -> Self {
        Self {
            kind: FrameKind::Close,
            payload: Vec::new(),
        }
    }

    pub fn ping() -> Self {
        Self {
            kind: FrameKind::Ping,
            payload: Vec::new(),
        }
    }
}

/// 帧层的错误。`TooLarge` 单独成类：调用方要按规范打 `error` 日志。
#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    TooLarge { len: u32 },
    UnknownKind(u8),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "帧 I/O 错误 / frame I/O error: {error}"),
            Self::TooLarge { len } => write!(
                f,
                "帧长度 {len} 超过上限 {MAX_FRAME_PAYLOAD} 字节 / frame length {len} exceeds the {MAX_FRAME_PAYLOAD}-byte limit"
            ),
            Self::UnknownKind(kind) => {
                write!(f, "未知帧类型 0x{kind:02x} / unknown frame kind 0x{kind:02x}")
            }
        }
    }
}

impl std::error::Error for FrameError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// 读一帧；对端干净关闭（TLS close_notify 或 TCP FIN）时返回 `Ok(None)`。
///
/// 读到一半就 EOF 视为 I/O 错误（`UnexpectedEof`），不能当正常关闭：
/// 半帧说明对端实现有问题，继续用这条连接会解析错位。
pub async fn read_frame<R>(reader: &mut R) -> Result<Option<Frame>, FrameError>
where
    R: AsyncRead + Unpin,
{
    let mut first = [0u8; 1];
    if reader.read(&mut first).await? == 0 {
        return Ok(None);
    }

    let mut len_bytes = [0u8; 4];
    reader.read_exact(&mut len_bytes).await?;
    let kind = FrameKind::try_from(first[0])?;
    let declared = u32::from_be_bytes(len_bytes);
    if declared as usize > MAX_FRAME_PAYLOAD {
        // 不读 payload，直接把连接交给上层断开。
        return Err(FrameError::TooLarge { len: declared });
    }

    let mut payload = vec![0u8; declared as usize];
    reader.read_exact(&mut payload).await?;
    Ok(Some(Frame { kind, payload }))
}

/// 写一帧并 flush。
///
/// P16.1 每帧都 flush：交互流量（SSH、游戏）对「攒批」不敏感，flush 才能保证
/// 小包立刻到达。批量合并留到有吞吐基准之后的优化项。
pub async fn write_frame<W>(writer: &mut W, kind: FrameKind, payload: &[u8]) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    if payload.len() > MAX_FRAME_PAYLOAD {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "单帧 {len} 字节超过上限 {MAX_FRAME_PAYLOAD} / payload of {len} bytes exceeds the {MAX_FRAME_PAYLOAD}-byte limit",
                len = payload.len()
            ),
        ));
    }

    let mut header = [0u8; 5];
    header[0] = kind as u8;
    header[1..].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    writer.write_all(&header).await?;
    writer.write_all(payload).await?;
    writer.flush().await
}

/// 首帧里的目标地址（SOCKS5 地址格式）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetAddr {
    /// IPv4 或 IPv6 字面量。
    Ip(SocketAddr),
    /// 域名；交给 `TcpStream::connect` 时由系统解析。
    Domain { host: String, port: u16 },
}

impl TargetAddr {
    /// 编码成首帧 payload。
    pub fn encode(&self) -> io::Result<Vec<u8>> {
        let mut out = Vec::new();
        match self {
            Self::Ip(SocketAddr::V4(addr)) => {
                out.push(ATYP_IPV4);
                out.extend_from_slice(&addr.ip().octets());
                out.extend_from_slice(&addr.port().to_be_bytes());
            }
            Self::Ip(SocketAddr::V6(addr)) => {
                out.push(ATYP_IPV6);
                out.extend_from_slice(&addr.ip().octets());
                out.extend_from_slice(&addr.port().to_be_bytes());
            }
            Self::Domain { host, port } => {
                let host = host.as_bytes();
                if host.is_empty() {
                    return Err(invalid("目标域名为空 / target domain is empty"));
                }
                if host.len() > u8::MAX as usize {
                    return Err(invalid(
                        "目标域名超过 255 字节 / target domain exceeds 255 bytes",
                    ));
                }
                out.push(ATYP_DOMAIN);
                out.push(host.len() as u8);
                out.extend_from_slice(host);
                out.extend_from_slice(&port.to_be_bytes());
            }
        }
        Ok(out)
    }

    /// 从首帧 payload 解出地址，并返回消耗的字节数。
    ///
    /// 返回 `(地址, 已消耗长度)`：调用方可以把地址之后的字节当作初始数据
    /// 写给目标，不必丢弃。
    pub fn decode_prefix(input: &[u8]) -> io::Result<(Self, usize)> {
        let atyp = *input.first().ok_or_else(|| {
            invalid("首帧缺少地址类型 / the first frame is missing the address type")
        })?;
        match atyp {
            ATYP_IPV4 => {
                let rest = take(input, 1, 6)?;
                let ip = Ipv4Addr::new(rest[0], rest[1], rest[2], rest[3]);
                let port = u16::from_be_bytes([rest[4], rest[5]]);
                Ok((Self::Ip(SocketAddr::from((ip, port))), 7))
            }
            ATYP_IPV6 => {
                let rest = take(input, 1, 18)?;
                let mut octets = [0u8; 16];
                octets.copy_from_slice(&rest[..16]);
                let port = u16::from_be_bytes([rest[16], rest[17]]);
                Ok((
                    Self::Ip(SocketAddr::from((Ipv6Addr::from(octets), port))),
                    19,
                ))
            }
            ATYP_DOMAIN => {
                let host_len = *input.get(1).ok_or_else(|| {
                    invalid("域名地址缺少长度字节 / the domain address is missing its length")
                })? as usize;
                if host_len == 0 {
                    return Err(invalid("目标域名为空 / target domain is empty"));
                }
                let rest = take(input, 2, host_len + 2)?;
                let host = std::str::from_utf8(&rest[..host_len]).map_err(|_| {
                    invalid("目标域名不是合法 UTF-8 / target domain is not valid UTF-8")
                })?;
                let port = u16::from_be_bytes([rest[host_len], rest[host_len + 1]]);
                Ok((
                    Self::Domain {
                        host: host.to_string(),
                        port,
                    },
                    2 + host_len + 2,
                ))
            }
            other => Err(invalid(format!(
                "未知地址类型 0x{other:02x} / unknown address type 0x{other:02x}"
            ))),
        }
    }
}

fn take(input: &[u8], offset: usize, len: usize) -> io::Result<&[u8]> {
    input
        .get(offset..offset + len)
        .ok_or_else(|| invalid("首帧地址被截断 / truncated target address in the first frame"))
}

fn invalid(message: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_kinds_roundtrip() {
        for kind in [FrameKind::Data, FrameKind::Close, FrameKind::Ping] {
            let mut wire = Vec::new();
            write_frame(&mut wire, kind, b"abc").await.unwrap();
            let frame = read_frame(&mut &wire[..]).await.unwrap().unwrap();
            assert_eq!(frame.kind, kind);
            assert_eq!(frame.payload, b"abc");
        }
        assert!(FrameKind::try_from(0x7f)
            .unwrap_err()
            .to_string()
            .contains("0x7f"));
    }

    #[tokio::test]
    async fn clean_eof_is_not_a_frame() {
        let mut empty: &[u8] = &[];
        assert!(read_frame(&mut empty).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn truncated_frame_is_an_error() {
        // 声明 4 字节 payload，后面只有 2 字节。
        let wire = [0x01u8, 0x00, 0x00, 0x00, 0x04, 0xaa, 0xbb];
        match read_frame(&mut &wire[..]).await {
            Err(FrameError::Io(error)) => {
                assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof)
            }
            other => panic!("期望半帧报错，实际 {other:?}"),
        }
    }

    #[tokio::test]
    async fn payload_limit_is_exactly_64_kib() {
        let payload = vec![0x5a; MAX_FRAME_PAYLOAD];
        let mut wire = Vec::new();
        write_frame(&mut wire, FrameKind::Data, &payload)
            .await
            .unwrap();
        let frame = read_frame(&mut &wire[..]).await.unwrap().unwrap();
        assert_eq!(frame.payload.len(), MAX_FRAME_PAYLOAD);

        // 65 KiB + 1：只要帧头就足以拒绝，服务端不会去读 payload。
        let oversized = [0x01u8, 0x00, 0x01, 0x00, 0x01];
        match read_frame(&mut &oversized[..]).await {
            Err(FrameError::TooLarge { len }) => assert_eq!(len, 65_537),
            other => panic!("超限帧必须拒绝，实际 {other:?}"),
        }

        let mut sink = Vec::new();
        let error = write_frame(
            &mut sink,
            FrameKind::Data,
            &vec![0u8; MAX_FRAME_PAYLOAD + 1],
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn addresses_roundtrip() {
        let addresses = [
            TargetAddr::Ip("203.0.113.7:8080".parse().unwrap()),
            TargetAddr::Ip("[2001:db8::1]:443".parse().unwrap()),
            TargetAddr::Domain {
                host: "example.internal".into(),
                port: 8443,
            },
        ];
        for address in addresses {
            let encoded = address.encode().unwrap();
            let (decoded, consumed) = TargetAddr::decode_prefix(&encoded).unwrap();
            assert_eq!(decoded, address);
            assert_eq!(consumed, encoded.len());
        }
    }

    #[test]
    fn first_frame_can_carry_initial_payload() {
        let address = TargetAddr::Domain {
            host: "example.internal".into(),
            port: 80,
        };
        let mut payload = address.encode().unwrap();
        let address_len = payload.len();
        payload.extend_from_slice(b"GET / HTTP/1.0\r\n\r\n");

        let (decoded, consumed) = TargetAddr::decode_prefix(&payload).unwrap();
        assert_eq!(decoded, address);
        assert_eq!(consumed, address_len);
        assert_eq!(&payload[consumed..], b"GET / HTTP/1.0\r\n\r\n");
    }

    #[test]
    fn malformed_addresses_are_rejected() {
        assert!(TargetAddr::decode_prefix(&[]).is_err());
        assert!(TargetAddr::decode_prefix(&[0x09, 1, 2, 3]).is_err());
        // 域名长度为 0。
        assert!(TargetAddr::decode_prefix(&[0x03, 0x00, 0x00, 0x50]).is_err());
        // 域名声明 5 字节，实际只有 2 字节。
        assert!(TargetAddr::decode_prefix(&[0x03, 0x05, b'a', b'b']).is_err());
        // IPv4 少一个端口字节。
        assert!(TargetAddr::decode_prefix(&[0x01, 127, 0, 0, 1, 0x1f]).is_err());
    }
}
