//! 隧道握手：ClientHello / ServerHello 编解码、HMAC proof 与重放缓存。
//!
//! ```text
//! ClientHello { version: 1, hop_id, timestamp_secs, proof }
//! ServerHello { version: 1, ok, reason? }
//! proof = HMAC-SHA256(hop_secret, hop_id || timestamp_secs)
//! ```
//!
//! `hop_secret` 是每跳预共享的 32 字节密钥；`timestamp_secs` 是客户端当前
//! Unix 秒。服务端只接受 ±300 秒窗口内的 proof，并把验证通过的 proof 放进
//! 最近缓存，窗口内第二次出现即拒绝。
//!
//! 已知取舍：proof 只由 `(hop_secret, hop_id, 秒级时间戳)` 决定，同一秒内
//! 重连会得到相同 proof，被重放缓存拒绝。P16.1 的客户端失败后应退避到下一秒
//! 重试；加随机 nonce 会改 ClientHello 布局，留到 P16.2 与 Noise 一起做。
//!
//! 线上布局（大端）：
//!
//! ```text
//! ClientHello: [0x01][version u8][hop_len u16][hop_id][timestamp u64][proof 32B]
//! ServerHello: [0x02][version u8][ok u8][reason_len u8][reason]
//! ```
//!
//! `version` 精确匹配、不向下兼容；失败一律 fail-closed。

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// 隧道握手版本。改线上布局必须同时加一，旧版本直接拒绝。
pub const PROTOCOL_VERSION: u8 = 1;

/// 允许的时钟偏差：±300 秒（与 docs/PLAN.md 的 ±5 分钟一致）。
pub const CLOCK_SKEW: Duration = Duration::from_secs(300);

/// hop_id 上限；255 是为了和 u16 长度字段、UTF-8 站点标识留出余量。
const MAX_HOP_ID_LEN: usize = 255;
const MAX_REASON_LEN: usize = 255;
const PROOF_LEN: usize = 32;
const MSG_CLIENT_HELLO: u8 = 0x01;
const MSG_SERVER_HELLO: u8 = 0x02;

/// 重放缓存容量上限。正常规模下（每跳每秒最多几次重连）远达不到；
/// 达到后淘汰最旧的一条，保证内存有界。
const REPLAY_CACHE_CAPACITY: usize = 8192;

/// 当前 Unix 秒。测试通过显式传 timestamp 覆盖，不走全局时钟。
pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// `proof = HMAC-SHA256(hop_secret, hop_id || timestamp_secs)`。
pub fn compute_proof(hop_secret: &[u8], hop_id: &str, timestamp_secs: u64) -> [u8; PROOF_LEN] {
    let mut mac = Hmac::<Sha256>::new_from_slice(hop_secret)
        .expect("HMAC-SHA256 接受任意长度密钥 / HMAC accepts keys of any length");
    mac.update(hop_id.as_bytes());
    mac.update(&timestamp_secs.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let mut proof = [0u8; PROOF_LEN];
    proof.copy_from_slice(&digest);
    proof
}

/// 常量时间校验 proof（`Mac::verify_slice` 内部不提前返回）。
pub fn verify_proof(
    hop_secret: &[u8],
    hop_id: &str,
    timestamp_secs: u64,
    proof: &[u8; PROOF_LEN],
) -> bool {
    let mut mac = Hmac::<Sha256>::new_from_slice(hop_secret)
        .expect("HMAC-SHA256 接受任意长度密钥 / HMAC accepts keys of any length");
    mac.update(hop_id.as_bytes());
    mac.update(&timestamp_secs.to_be_bytes());
    mac.verify_slice(proof).is_ok()
}

/// 时间戳窗口校验（与 proof 分离，方便单独测试边界）。
pub fn check_timestamp(timestamp_secs: u64, now_secs: u64) -> Result<(), HandshakeError> {
    let skew = now_secs.abs_diff(timestamp_secs);
    if skew > CLOCK_SKEW.as_secs() {
        Err(HandshakeError::Expired { skew_secs: skew })
    } else {
        Ok(())
    }
}

/// 客户端第一条消息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientHello {
    pub version: u8,
    pub hop_id: String,
    pub timestamp_secs: u64,
    pub proof: [u8; PROOF_LEN],
}

impl ClientHello {
    /// 用给定 secret 和 timestamp 现算 proof。
    pub fn new(hop_secret: &[u8], hop_id: impl Into<String>, timestamp_secs: u64) -> Self {
        let hop_id = hop_id.into();
        let proof = compute_proof(hop_secret, &hop_id, timestamp_secs);
        Self {
            version: PROTOCOL_VERSION,
            hop_id,
            timestamp_secs,
            proof,
        }
    }

    pub fn verify(&self, hop_secret: &[u8]) -> bool {
        self.version == PROTOCOL_VERSION
            && verify_proof(hop_secret, &self.hop_id, self.timestamp_secs, &self.proof)
    }

    pub async fn write<W>(&self, writer: &mut W) -> io::Result<()>
    where
        W: AsyncWrite + Unpin,
    {
        let hop = self.hop_id.as_bytes();
        if hop.is_empty() || hop.len() > MAX_HOP_ID_LEN {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "hop_id 长度非法 / invalid hop_id length",
            ));
        }

        let mut wire = Vec::with_capacity(2 + 2 + hop.len() + 8 + PROOF_LEN);
        wire.push(MSG_CLIENT_HELLO);
        wire.push(self.version);
        wire.extend_from_slice(&(hop.len() as u16).to_be_bytes());
        wire.extend_from_slice(hop);
        wire.extend_from_slice(&self.timestamp_secs.to_be_bytes());
        wire.extend_from_slice(&self.proof);
        writer.write_all(&wire).await?;
        writer.flush().await
    }

    pub async fn read<R>(reader: &mut R) -> Result<Self, HandshakeError>
    where
        R: AsyncRead + Unpin,
    {
        let mut head = [0u8; 4];
        reader.read_exact(&mut head).await?;
        if head[0] != MSG_CLIENT_HELLO {
            return Err(HandshakeError::Malformed(
                "首条消息不是 ClientHello / the first message is not ClientHello",
            ));
        }
        let version = head[1];
        let hop_len = u16::from_be_bytes([head[2], head[3]]) as usize;
        if hop_len == 0 || hop_len > MAX_HOP_ID_LEN {
            return Err(HandshakeError::Malformed(
                "ClientHello 的 hop_id 长度非法 / invalid hop_id length in ClientHello",
            ));
        }

        let mut hop = vec![0u8; hop_len];
        reader.read_exact(&mut hop).await?;
        let hop_id = String::from_utf8(hop).map_err(|_| {
            HandshakeError::Malformed("hop_id 不是合法 UTF-8 / hop_id is not valid UTF-8")
        })?;

        let mut timestamp = [0u8; 8];
        reader.read_exact(&mut timestamp).await?;
        let mut proof = [0u8; PROOF_LEN];
        reader.read_exact(&mut proof).await?;

        Ok(Self {
            version,
            hop_id,
            timestamp_secs: u64::from_be_bytes(timestamp),
            proof,
        })
    }
}

/// 服务端对 ClientHello 的应答；`ok = false` 时 `reason` 是给客户端看的
/// 双语短句（不带内部状态/密钥）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerHello {
    pub version: u8,
    pub ok: bool,
    pub reason: Option<String>,
}

impl ServerHello {
    pub fn accept() -> Self {
        Self {
            version: PROTOCOL_VERSION,
            ok: true,
            reason: None,
        }
    }

    pub fn reject(reason: impl Into<String>) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            ok: false,
            reason: Some(reason.into()),
        }
    }

    pub async fn write<W>(&self, writer: &mut W) -> io::Result<()>
    where
        W: AsyncWrite + Unpin,
    {
        let reason = self.reason.as_deref().unwrap_or("").as_bytes();
        if reason.len() > MAX_REASON_LEN {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "握手拒绝原因超过 255 字节 / handshake rejection reason exceeds 255 bytes",
            ));
        }

        let mut wire = Vec::with_capacity(4 + reason.len());
        wire.push(MSG_SERVER_HELLO);
        wire.push(self.version);
        wire.push(u8::from(self.ok));
        wire.push(reason.len() as u8);
        wire.extend_from_slice(reason);
        writer.write_all(&wire).await?;
        writer.flush().await
    }

    pub async fn read<R>(reader: &mut R) -> Result<Self, HandshakeError>
    where
        R: AsyncRead + Unpin,
    {
        let mut head = [0u8; 4];
        reader.read_exact(&mut head).await?;
        if head[0] != MSG_SERVER_HELLO {
            return Err(HandshakeError::Malformed(
                "首条应答不是 ServerHello / the first reply is not ServerHello",
            ));
        }
        let version = head[1];
        let ok = match head[2] {
            0 => false,
            1 => true,
            _ => {
                return Err(HandshakeError::Malformed(
                    "ServerHello 的 ok 字段非法 / invalid ok byte in ServerHello",
                ))
            }
        };
        let reason_len = head[3] as usize;
        let mut reason = vec![0u8; reason_len];
        reader.read_exact(&mut reason).await?;
        let reason = if reason.is_empty() {
            None
        } else {
            Some(String::from_utf8(reason).map_err(|_| {
                HandshakeError::Malformed(
                    "ServerHello 的 reason 不是合法 UTF-8 / reason in ServerHello is not valid UTF-8",
                )
            })?)
        };
        Ok(Self {
            version,
            ok,
            reason,
        })
    }
}

/// 握手错误。区分到能给出不同处置（重试 / 换密钥 / 报配置错误）的粒度，
/// 文案同时给中文与英文。
#[derive(Debug)]
pub enum HandshakeError {
    Io(io::Error),
    Malformed(&'static str),
    UnsupportedVersion(u8),
    UnknownHop,
    BadProof,
    Expired { skew_secs: u64 },
    Replayed,
}

impl fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "握手 I/O 错误 / handshake I/O error: {error}"),
            Self::Malformed(detail) => write!(f, "握手消息格式错误 / malformed handshake: {detail}"),
            Self::UnsupportedVersion(version) => write!(
                f,
                "不支持的隧道版本 {version}（需要 {PROTOCOL_VERSION}）/ unsupported tunnel version {version} (expected {PROTOCOL_VERSION})"
            ),
            Self::UnknownHop => write!(
                f,
                "未知 hop_id（该跳没有预共享密钥）/ unknown hop_id (no pre-shared secret for this hop)"
            ),
            Self::BadProof => write!(
                f,
                "proof 校验失败（hop_secret 不匹配）/ proof verification failed (hop_secret mismatch)"
            ),
            Self::Expired { skew_secs } => write!(
                f,
                "时间戳超出 ±{}s 窗口（偏差 {skew_secs}s）/ timestamp outside the ±{}s window (skew {skew_secs}s)",
                CLOCK_SKEW.as_secs(),
                CLOCK_SKEW.as_secs()
            ),
            Self::Replayed => write!(
                f,
                "proof 已使用过（重放）/ proof has already been used (replay)"
            ),
        }
    }
}

impl std::error::Error for HandshakeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for HandshakeError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// 最近 proof 缓存，按服务端本地时间过期。
///
/// `ttl = 2 × CLOCK_SKEW`：proof 超过窗口后本来就会被时间戳校验拒绝，
/// 缓存留到那时即可；用 `Instant` 而不是客户端时间戳，避免客户端改本地
/// 时钟影响缓存生命周期。
#[derive(Debug)]
pub struct ReplayCache {
    seen: HashMap<[u8; PROOF_LEN], Instant>,
    ttl: Duration,
    capacity: usize,
}

impl Default for ReplayCache {
    fn default() -> Self {
        Self::new()
    }
}

impl ReplayCache {
    pub fn new() -> Self {
        Self {
            seen: HashMap::new(),
            ttl: CLOCK_SKEW * 2,
            capacity: REPLAY_CACHE_CAPACITY,
        }
    }

    /// 验证通过后调用：第一次插入返回 `Ok`，窗口内重复返回 `Replayed`。
    ///
    /// 调用方必须先校验 HMAC，再调用这里——否则任何未认证的字节都能
    /// 往缓存里塞条目。
    pub fn check_and_insert(
        &mut self,
        proof: [u8; PROOF_LEN],
        now: Instant,
    ) -> Result<(), HandshakeError> {
        self.seen
            .retain(|_, seen| now.saturating_duration_since(*seen) < self.ttl);

        if self.seen.contains_key(&proof) {
            return Err(HandshakeError::Replayed);
        }

        if self.seen.len() >= self.capacity {
            if let Some(oldest) = self
                .seen
                .iter()
                .min_by_key(|(_, seen)| **seen)
                .map(|(proof, _)| *proof)
            {
                self.seen.remove(&oldest);
            }
        }

        self.seen.insert(proof, now);
        Ok(())
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.seen.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"secret";

    #[test]
    fn proof_matches_the_documented_construction() {
        // 与 Python hmac.new(secret, b"hop-1" + ts.to_bytes(8, "big"), sha256)
        // 对齐；改布局（顺序/端序/分隔符）会让这个向量失败。
        let proof = compute_proof(SECRET, "hop-1", 1_700_000_000);
        assert_eq!(
            hex::encode(proof),
            "2b482cbf8b34e4fb15127e36c02de8af515ac8d3656768e2a623c9b3b4013315"
        );
        assert!(verify_proof(SECRET, "hop-1", 1_700_000_000, &proof));
        assert!(!verify_proof(SECRET, "hop-2", 1_700_000_000, &proof));
        assert!(!verify_proof(SECRET, "hop-1", 1_700_000_001, &proof));
        assert!(!verify_proof(b"other", "hop-1", 1_700_000_000, &proof));

        let mut flipped = proof;
        flipped[0] ^= 0x01;
        assert!(!verify_proof(SECRET, "hop-1", 1_700_000_000, &flipped));
    }

    #[test]
    fn timestamp_window_is_inclusive_at_300_seconds() {
        let now = 1_700_000_000;
        assert!(check_timestamp(now, now).is_ok());
        assert!(check_timestamp(now - 300, now).is_ok());
        assert!(check_timestamp(now + 300, now).is_ok());
        assert!(check_timestamp(now - 301, now).is_err());
        assert!(check_timestamp(now + 301, now).is_err());
        assert!(check_timestamp(0, now).is_err());
    }

    #[test]
    fn expired_error_reports_the_skew() {
        let error = check_timestamp(1_700_000_000 - 400, 1_700_000_000).unwrap_err();
        let text = error.to_string();
        assert!(text.contains("400"), "{text}");
        assert!(text.contains("时间戳"), "{text}");
        assert!(text.contains("timestamp"), "{text}");
    }

    #[tokio::test]
    async fn client_and_server_hello_roundtrip() {
        let hello = ClientHello::new(SECRET, "hop-1", 1_700_000_000);
        let mut wire = Vec::new();
        hello.write(&mut wire).await.unwrap();
        assert_eq!(ClientHello::read(&mut &wire[..]).await.unwrap(), hello);
        assert!(hello.verify(SECRET));
        assert!(!hello.verify(b"wrong"));

        for reply in [
            ServerHello::accept(),
            ServerHello::reject("拒绝 / rejected"),
        ] {
            let mut wire = Vec::new();
            reply.write(&mut wire).await.unwrap();
            assert_eq!(ServerHello::read(&mut &wire[..]).await.unwrap(), reply);
        }
    }

    #[tokio::test]
    async fn malformed_hellos_are_rejected() {
        // 首字节不是 ClientHello。
        let mut wire = vec![0x09u8, 0x01, 0x00, 0x05];
        wire.extend_from_slice(b"hop-1");
        wire.extend_from_slice(&[0u8; 40]);
        assert!(matches!(
            ClientHello::read(&mut &wire[..]).await,
            Err(HandshakeError::Malformed(_))
        ));

        // hop_id 长度为 0。
        let wire = [0x01u8, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0];
        assert!(matches!(
            ClientHello::read(&mut &wire[..]).await,
            Err(HandshakeError::Malformed(_))
        ));

        // 截断的 ClientHello 是 I/O 错误，不是「正常关闭」。
        let mut wire = Vec::new();
        ClientHello::new(SECRET, "hop-1", 1)
            .write(&mut wire)
            .await
            .unwrap();
        wire.truncate(wire.len() - 1);
        assert!(matches!(
            ClientHello::read(&mut &wire[..]).await,
            Err(HandshakeError::Io(_))
        ));
    }

    #[test]
    fn replay_cache_rejects_the_second_use_and_expires_old_entries() {
        let mut cache = ReplayCache::new();
        let now = Instant::now();
        let proof = compute_proof(SECRET, "hop-1", 1_700_000_000);

        assert!(cache.check_and_insert(proof, now).is_ok());
        assert_eq!(cache.len(), 1);
        assert!(matches!(
            cache.check_and_insert(proof, now + Duration::from_secs(1)),
            Err(HandshakeError::Replayed)
        ));

        // 另一个 proof 不受影响。
        let other = compute_proof(SECRET, "hop-1", 1_700_000_001);
        assert!(cache.check_and_insert(other, now).is_ok());
        assert_eq!(cache.len(), 2);

        // 超过 2 × CLOCK_SKEW 后旧条目被清掉，同一 proof 可再次插入（此时
        // 时间戳校验会先拒绝它，缓存只负责窗口内的重放）。
        let later = now + CLOCK_SKEW * 2 + Duration::from_secs(1);
        assert!(cache.check_and_insert(proof, later).is_ok());
        assert_eq!(cache.len(), 1);
    }
}
