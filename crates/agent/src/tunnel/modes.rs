//! 隧道安全模式：TLS 与 Noise/PSK 共存于同一监听端口。
//!
//! # 首字节分流
//!
//! 两种模式共享一个 TCP 监听：
//!
//! ```text
//! [0x01] TLS ClientHello（模式字节，TLS 记录紧随其后）
//! [0x02] Noise 握手消息 1（Noise 记录紧随其后）
//! ```
//!
//! 服务端先 `peek` 一个字节再决定交给 rustls 还是 `snow`，所以 TLS 路径的
//! 线协议只多了一个前置字节；为了兼容不带模式字节的旧客户端，首字节是
//! TLS record type（`0x16`）时同样按 TLS 处理。
//!
//! # Noise 套件
//!
//! `Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s`，即标准 `Noise_IK`（WireGuard
//! 同族）加 Noise 规范里的 `psk0` 修饰符（snow 的套件名写法是
//! `Noise_IKpsk0`，等价于 Noise 规范文档里的 `NoisePSK_IK`）。IK 的两次消息里带临时密钥
//! （`e`），会话密钥由 `ee/es/se` 混合出，**静态密钥只用于认证与静态 DH**，
//! 因此静态材料泄漏不会解密历史流量（前向保密来自临时密钥）。
//!
//! 静态密钥对与 PSK 都由 `hop_secret` 做 HMAC 派生：
//!
//! ```text
//! static_private = HMAC-SHA256(hop_secret, "pierwave/tunnel/noise/static-key/v1")
//! static_public  = X25519(static_private, basepoint)
//! psk            = HMAC-SHA256(hop_secret, "pierwave/tunnel/noise/psk/v1")
//! ```
//!
//! 两端用同一个 `hop_secret` 独立算出同一对静态密钥与同一个 PSK；HKDF 的
//! HMAC 标签的域分离保证静态私钥与 PSK 不能互相推导，也不与 TLS 的
//! `proof = HMAC(hop_secret, hop_id || timestamp)` 共用同一段密钥流。
//! X25519 私钥是 32 字节随机标量（内部会 clamp），任何 HMAC 输出都是合法
//! 私钥；公钥由 `snow` 的 25519 实现从私钥推导，不引入新依赖。
//!
//! # 重协商
//!
//! 客户端在连接存活超过 [`DEFAULT_REKEY_INTERVAL`] 后发起一次新的 IK
//! 握手（新的临时密钥 → 新的会话密钥），握手消息与数据记录复用同一条
//! TCP。重协商期间：
//!
//! * 客户端暂停「应用 → 网络」方向，旧数据在 duplex 缓冲里排队；
//! * 服务端读到握手记录后先回 msg2 再切换会话；
//! * 旧会话在切换前的数据都排在同方向握手消息之前（TCP 有序），因此不会
//!   出现「新会话读旧密文」；
//! * 握手失败（对端拒绝/超时/认证失败）时保留旧会话继续传输，只记录 warn。
//!
//! 记录格式（Noise 模式，模式字节之后）：
//!
//! ```text
//! [kind u8][len u32 BE][body]
//! kind = 0x00 握手消息（明文 Noise message）
//!        0x01 数据（Noise transport 密文）
//! ```
//!
//! 服务端用 hop 表逐项尝试 IK responder；只有能解开握手消息、且对端静态
//! 公钥与本地派生的公钥一致的 hop 才算认证通过。未知 hop 与错误 PSK 返回
//! 同一个可读错误，避免向未认证连接枚举 hop_id。

use std::fmt;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use anyhow::{anyhow, bail, Context as _, Result};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use snow::params::{DHChoice, NoiseParams};
use snow::resolvers::{CryptoResolver, DefaultResolver};
use snow::TransportState;
use tokio::io::{
    duplex, split, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf,
    ReadHalf, WriteHalf,
};
use tokio::net::TcpStream;
use tokio::time::{timeout, Instant};

/// TLS 模式的握手首字节。
pub const MODE_TLS: u8 = 0x01;
/// Noise 模式的握手首字节。
pub const MODE_NOISE: u8 = 0x02;
/// TLS record type `handshake`（ClientHello 的第一个字节）。
///
/// 只用于兼容不发送 [`MODE_TLS`] 前缀的旧客户端；新客户端一律先发模式字节。
pub const TLS_CLIENT_HELLO: u8 = 0x16;

/// Noise 套件：标准 IK + Noise 规范的 `psk0` 修饰符。
///
/// snow 0.9 的 base 类型只有 `Noise`，PSK 通过 handshake 修饰符表达，所以
/// 套件名是 `Noise_IKpsk0_...`（Noise 规范里的 `NoisePSK_IK_...`）。
pub const NOISE_SUITE: &str = "Noise_IKpsk0_25519_ChaChaPoly_BLAKE2s";

/// 默认重协商周期：10 分钟。
pub const DEFAULT_REKEY_INTERVAL: Duration = Duration::from_secs(10 * 60);
/// 测试允许把周期压到很短，但不允许 0（否则会无限重协商）。
pub const MIN_REKEY_INTERVAL: Duration = Duration::from_millis(10);
/// 单次重协商的预算；超过则放弃本次并继续用旧会话。
const REKEY_TIMEOUT: Duration = Duration::from_secs(10);

/// 静态私钥的 HMAC 标签（域分离；改标签等于换协议）。
const STATIC_KEY_LABEL: &[u8] = b"pierwave/tunnel/noise/static-key/v1";
/// PSK 的 HMAC 标签（与静态私钥分开，避免同一段密钥流被复用）。
const PSK_LABEL: &[u8] = b"pierwave/tunnel/noise/psk/v1";

/// Noise 握手消息缓冲：IK 的 msg1 约 96 字节、msg2 约 48 字节，512 足够。
const HANDSHAKE_BUF: usize = 512;
/// Noise 单条消息上限（含 16 字节 AEAD tag）。
const MAX_RECORD_BODY: usize = 65535;
/// 数据记录里明文的上限（也是 duplex 与泵缓冲的大小）。
const MAX_DATA_PLAINTEXT: usize = 16 * 1024;
/// Noise 的 AEAD tag 长度。
const TAG_LEN: usize = 16;
/// 模式字节之后每条记录的头：`[kind u8][len u32]`。
const RECORD_HEADER_LEN: usize = 5;
const KIND_HANDSHAKE: u8 = 0x00;
const KIND_DATA: u8 = 0x01;
/// 泵与应用之间的 duplex 缓冲。
const PUMP_BUFFER: usize = MAX_DATA_PLAINTEXT;

/// 隧道安全模式。默认 TLS，保持既有行为不变。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TunnelSecurity {
    /// 自有 CA 的 TLS（P16.1 已实现）。
    #[default]
    Tls,
    /// Noise IK + PSK：无证书，完全对称密钥。
    Noise,
}

impl fmt::Display for TunnelSecurity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Tls => "tls",
            Self::Noise => "noise",
        })
    }
}

/// 隧道底层字节流。TLS 与 Noise 都装箱成这个类型，上层不再区分。
pub trait AsyncStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T> AsyncStream for T where T: AsyncRead + AsyncWrite + Unpin + Send {}

/// 传输抽象：`TunnelServer` / `TunnelClient` 只认这个。
pub type BoxedStream = Box<dyn AsyncStream>;

/// 由 `hop_secret` 确定性派生的 Noise 静态材料。
///
/// 私钥与 PSK 都不出现在 `Debug` 里，避免日志泄漏。
#[derive(Clone)]
pub struct NoiseMaterial {
    private: [u8; 32],
    public: [u8; 32],
    psk: [u8; 32],
}

impl fmt::Debug for NoiseMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NoiseMaterial")
            .field("static_public", &self.public)
            .finish_non_exhaustive()
    }
}

impl NoiseMaterial {
    /// 从每跳预共享密钥派生静态密钥对与 PSK；两端独立计算结果相同。
    pub fn from_secret(hop_secret: &[u8]) -> Self {
        let private = hmac_sha256(hop_secret, STATIC_KEY_LABEL);
        let public = static_public_key(&private);
        let psk = hmac_sha256(hop_secret, PSK_LABEL);
        Self {
            private,
            public,
            psk,
        }
    }

    /// 派生出的 X25519 静态公钥。
    pub fn static_public(&self) -> [u8; 32] {
        self.public
    }
}

/// 服务端可接受的一个 hop：hop_id + 由它派生的 Noise 材料。
#[derive(Clone, Debug)]
pub struct NoiseHop {
    pub hop_id: String,
    pub material: NoiseMaterial,
}

impl NoiseHop {
    pub fn new(hop_id: impl Into<String>, hop_secret: &[u8]) -> Self {
        Self {
            hop_id: hop_id.into(),
            material: NoiseMaterial::from_secret(hop_secret),
        }
    }
}

fn hmac_sha256(key: &[u8], label: &[u8]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key)
        .expect("HMAC-SHA256 接受任意长度密钥 / HMAC accepts keys of any length");
    mac.update(label);
    let digest = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// 从 32 字节 X25519 私钥推导公钥。
///
/// 用 `snow` 自己解析 25519 实现，不额外引入 `x25519-dalek`；保证「客户端
/// 知道的服务器公钥」与握手内部使用的实现完全一致。
fn static_public_key(private: &[u8; 32]) -> [u8; 32] {
    let resolver = DefaultResolver;
    let mut dh = resolver
        .resolve_dh(&DHChoice::Curve25519)
        .expect("snow default resolver 必须提供 25519 / snow default resolver must provide 25519");
    dh.set(private);
    let mut public = [0u8; 32];
    public.copy_from_slice(dh.pubkey());
    public
}

fn noise_params() -> Result<NoiseParams> {
    NOISE_SUITE
        .parse()
        .map_err(|error| anyhow!("Noise 套件解析失败 / invalid Noise suite: {error}"))
}

fn initiator_handshake(material: &NoiseMaterial) -> Result<snow::HandshakeState> {
    snow::Builder::new(noise_params()?)
        .local_private_key(&material.private)
        .remote_public_key(&material.public)
        .psk(0, &material.psk)
        .build_initiator()
        .map_err(|error| {
            anyhow!("Noise 握手初始化失败 / failed to initialize Noise handshake: {error}")
        })
}

fn responder_handshake(material: &NoiseMaterial) -> Result<snow::HandshakeState> {
    snow::Builder::new(noise_params()?)
        .local_private_key(&material.private)
        .psk(0, &material.psk)
        .build_responder()
        .map_err(|error| {
            anyhow!("Noise 握手初始化失败 / failed to initialize Noise handshake: {error}")
        })
}

/// 客户端（IK initiator）握手；成功返回 transport 状态。
pub async fn client_handshake(
    stream: &mut TcpStream,
    material: &NoiseMaterial,
) -> Result<TransportState> {
    let mut handshake = initiator_handshake(material)?;

    let mut message = vec![0u8; HANDSHAKE_BUF];
    let len = handshake
        .write_message(&[], &mut message)
        .map_err(|error| {
            anyhow!("生成 Noise 握手消息失败 / failed to write Noise handshake message: {error}")
        })?;
    write_record(stream, KIND_HANDSHAKE, &message[..len])
        .await
        .context("发送 Noise 握手消息失败 / failed to send Noise handshake message")?;

    let (kind, body) = read_record_required(stream)
        .await
        .context("读取 Noise 握手应答失败 / failed to read Noise handshake response")?;
    if kind != KIND_HANDSHAKE {
        bail!(
            "Noise 模式收到非握手记录（kind={kind}）/ expected a Noise handshake record, got kind {kind}"
        );
    }

    let mut payload = vec![0u8; HANDSHAKE_BUF];
    handshake
        .read_message(&body, &mut payload)
        .map_err(|error| {
            anyhow!(
                "Noise 握手认证失败（PSK 不匹配或对端不是 Noise）/ Noise handshake authentication failed (PSK mismatch or peer is not Noise): {error}"
            )
        })?;
    let transport = handshake
        .into_transport_mode()
        .map_err(|error| anyhow!("Noise 握手未完成 / Noise handshake did not complete: {error}"))?;
    let expected = material.static_public();
    if transport.get_remote_static() != Some(&expected[..]) {
        bail!("Noise 对端静态密钥不匹配 / Noise peer static key does not match");
    }
    Ok(transport)
}

/// 服务端（IK responder）握手。
///
/// 握手消息里不携带 hop_id（IK 的 msg1 已被 PSK 加密），所以逐项尝试
/// `hops`。未知 hop 与错误 PSK 返回同一个错误，不向未认证连接泄漏 hop 列表。
pub async fn server_handshake(
    stream: &mut TcpStream,
    hops: &[NoiseHop],
) -> Result<(NoiseHop, TransportState)> {
    let (kind, body) = read_record_required(stream)
        .await
        .context("读取 Noise 握手消息失败 / failed to read Noise handshake message")?;
    if kind != KIND_HANDSHAKE {
        bail!(
            "Noise 模式收到非握手记录（kind={kind}）/ expected a Noise handshake record, got kind {kind}"
        );
    }

    let mut payload = vec![0u8; HANDSHAKE_BUF];
    let mut last_error: Option<String> = None;
    for hop in hops {
        let mut handshake = match responder_handshake(&hop.material) {
            Ok(handshake) => handshake,
            Err(error) => {
                last_error = Some(format!("{error:#}"));
                continue;
            }
        };
        match handshake.read_message(&body, &mut payload) {
            Ok(_) => {
                // PSK 通过后仍要求对端静态公钥与本地一致：两端必须用同一个
                // hop_secret 派生，拒绝「PSK 对但静态密钥对不上」的配置漂移。
                let expected = hop.material.static_public();
                if handshake.get_remote_static() != Some(&expected[..]) {
                    last_error = Some("对端静态密钥不匹配 / peer static key mismatch".into());
                    continue;
                }
                let mut message = vec![0u8; HANDSHAKE_BUF];
                let len = handshake.write_message(&[], &mut message).map_err(|error| {
                    anyhow!("生成 Noise 握手应答失败 / failed to write Noise handshake response: {error}")
                })?;
                write_record(stream, KIND_HANDSHAKE, &message[..len])
                    .await
                    .context("发送 Noise 握手应答失败 / failed to send Noise handshake response")?;
                let transport = handshake.into_transport_mode().map_err(|error| {
                    anyhow!("Noise 握手未完成 / Noise handshake did not complete: {error}")
                })?;
                return Ok((hop.clone(), transport));
            }
            // 错误 PSK / 未知 hop：换下一个候选继续试。
            Err(snow::Error::Decrypt) => {}
            Err(error) => last_error = Some(error.to_string()),
        }
    }

    let detail = last_error
        .map(|error| format!(": {error}"))
        .unwrap_or_default();
    bail!(
        "Noise 握手认证失败（未知 hop 或 PSK 不匹配）/ Noise handshake authentication failed (unknown hop or PSK mismatch){detail}"
    )
}

/// 已建立 Noise transport 的双向字节流。
///
/// 内部是一个 duplex 与一个后台泵任务；泵负责分片加密/解密、半关语义与
/// 周期性重协商。调用方只看到普通的 `AsyncRead + AsyncWrite`。
pub struct NoiseStream {
    inner: DuplexStream,
    rekey_count: Arc<AtomicU64>,
}

impl NoiseStream {
    /// 用已完成握手的 TCP 连接启动泵。
    ///
    /// `initiator = true` 时由本端周期发起重协商；响应端只被动处理。
    pub fn start(
        stream: TcpStream,
        transport: TransportState,
        material: NoiseMaterial,
        initiator: bool,
        rekey_interval: Duration,
    ) -> Self {
        let (app, pump_side) = duplex(PUMP_BUFFER);
        let rekey_count = Arc::new(AtomicU64::new(0));
        let counter = Arc::clone(&rekey_count);
        tokio::spawn(async move {
            pump(
                stream,
                pump_side,
                transport,
                material,
                initiator,
                rekey_interval,
                counter,
            )
            .await;
        });
        Self {
            inner: app,
            rekey_count,
        }
    }

    /// 把计数器交给连接所有者；装箱后仍可读取。
    pub fn rekey_count_handle(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.rekey_count)
    }
}

impl AsyncRead for NoiseStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for NoiseStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// Noise 泵：应用侧与网络侧之间的加解密、半关和重协商。
async fn pump(
    stream: TcpStream,
    app: DuplexStream,
    mut session: TransportState,
    material: NoiseMaterial,
    initiator: bool,
    rekey_interval: Duration,
    rekey_count: Arc<AtomicU64>,
) {
    let (mut net_read, mut net_write) = split(stream);
    let (mut app_read, mut app_writer) = split(app);
    let interval = rekey_interval.max(MIN_REKEY_INTERVAL);
    let mut rekey_at = Instant::now() + interval;
    let mut rekey_due = false;
    let mut app_open = true;
    let mut net_open = true;
    let mut plain = vec![0u8; MAX_DATA_PLAINTEXT];
    let mut cipher = vec![0u8; MAX_DATA_PLAINTEXT + TAG_LEN];
    let mut app_buf = vec![0u8; MAX_DATA_PLAINTEXT];

    loop {
        if !app_open && !net_open {
            break;
        }

        if initiator && rekey_due && app_open && net_open {
            rekey_due = false;
            match rekey_client(
                &mut net_read,
                &mut net_write,
                &mut session,
                &material,
                &mut app_writer,
            )
            .await
            {
                Ok(()) => {
                    let count = rekey_count.fetch_add(1, Ordering::Relaxed) + 1;
                    tracing::info!(
                        rekeys = count,
                        "Noise 会话重协商完成 / Noise session rekeyed"
                    );
                    rekey_at = Instant::now() + interval;
                }
                Err(error) => {
                    // 硬要求：重协商失败不能断开现有连接，旧会话继续用。
                    tracing::warn!(
                        %error,
                        "Noise 会话重协商失败，继续使用旧会话 / Noise rekey failed, keeping the old session"
                    );
                    rekey_at = Instant::now() + interval;
                }
            }
            continue;
        }

        tokio::select! {
            biased;

            _ = tokio::time::sleep_until(rekey_at), if initiator && app_open && net_open => {
                rekey_due = true;
            }

            record = read_record(&mut net_read), if net_open => {
                match record {
                    Ok(Some((KIND_DATA, body))) => {
                        if body.len() > MAX_DATA_PLAINTEXT + TAG_LEN {
                            tracing::error!(
                                len = body.len(),
                                "Noise 数据记录超限，断开连接 / Noise data record exceeds the limit, disconnecting"
                            );
                            let _ = app_writer.shutdown().await;
                            break;
                        }
                        match session.read_message(&body, &mut plain) {
                            Ok(read) => {
                                if app_writer.write_all(&plain[..read]).await.is_err() {
                                    app_open = false;
                                    let _ = net_write.shutdown().await;
                                }
                            }
                            Err(error) => {
                                tracing::warn!(%error, "Noise 数据解密失败，断开连接 / Noise decryption failed, disconnecting");
                                let _ = app_writer.shutdown().await;
                                break;
                            }
                        }
                    }
                    Ok(Some((KIND_HANDSHAKE, body))) => {
                        if initiator {
                            tracing::warn!(
                                "Noise 响应端收到了重协商请求，忽略 / initiator received an unexpected rekey request, ignoring"
                            );
                        } else {
                            match rekey_server(&mut net_write, &body, &material, &mut session).await {
                                Ok(()) => {
                                    let count = rekey_count.fetch_add(1, Ordering::Relaxed) + 1;
                                    tracing::info!(
                                        rekeys = count,
                                        "Noise 会话已按请求轮换 / Noise session rekeyed on request"
                                    );
                                }
                                Err(error) => {
                                    tracing::warn!(
                                        %error,
                                        "Noise 重协商失败，继续使用旧会话 / Noise rekey failed, keeping the old session"
                                    );
                                }
                            }
                        }
                    }
                    Ok(Some((kind, _))) => {
                        tracing::error!(
                            kind,
                            "Noise 记录类型非法，断开连接 / invalid Noise record kind, disconnecting"
                        );
                        let _ = app_writer.shutdown().await;
                        break;
                    }
                    Ok(None) => {
                        // 对端在记录边界关闭：把 EOF 传给应用侧，停止读网络。
                        let _ = app_writer.shutdown().await;
                        net_open = false;
                    }
                    Err(error) => {
                        tracing::debug!(%error, "Noise 网络读失败 / Noise network read failed");
                        let _ = app_writer.shutdown().await;
                        net_open = false;
                    }
                }
            }

            read = app_read.read(&mut app_buf), if app_open => {
                match read {
                    Ok(0) => {
                        // 应用侧半关：关网络写方向，继续把对端剩余数据读完。
                        app_open = false;
                        let _ = net_write.shutdown().await;
                    }
                    Ok(read) => {
                        let written = match session.write_message(&app_buf[..read], &mut cipher) {
                            Ok(written) => written,
                            Err(error) => {
                                tracing::warn!(%error, "Noise 数据加密失败，断开连接 / Noise encryption failed, disconnecting");
                                break;
                            }
                        };
                        if let Err(error) =
                            write_record(&mut net_write, KIND_DATA, &cipher[..written]).await
                        {
                            tracing::debug!(%error, "Noise 网络写失败 / Noise network write failed");
                            break;
                        }
                    }
                    Err(error) => {
                        tracing::debug!(%error, "Noise 应用侧读失败 / Noise application read failed");
                        app_open = false;
                        let _ = net_write.shutdown().await;
                    }
                }
            }
        }
    }
}

/// 客户端发起一次重协商；期间用旧会话继续解密对端数据。
async fn rekey_client(
    net_read: &mut ReadHalf<TcpStream>,
    net_write: &mut WriteHalf<TcpStream>,
    session: &mut TransportState,
    material: &NoiseMaterial,
    app_writer: &mut WriteHalf<DuplexStream>,
) -> Result<()> {
    let mut handshake = initiator_handshake(material)?;
    let mut message = vec![0u8; HANDSHAKE_BUF];
    let len = handshake
        .write_message(&[], &mut message)
        .map_err(|error| {
            anyhow!("生成 Noise 重协商消息失败 / failed to write Noise rekey message: {error}")
        })?;
    write_record(net_write, KIND_HANDSHAKE, &message[..len])
        .await
        .context("发送 Noise 重协商消息失败 / failed to send Noise rekey message")?;

    let deadline = Instant::now() + REKEY_TIMEOUT;
    let mut plain = vec![0u8; MAX_DATA_PLAINTEXT];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            bail!("Noise 重协商超时 / Noise rekey timed out");
        }
        let record = timeout(remaining, read_record(net_read))
            .await
            .map_err(|_| anyhow!("Noise 重协商超时 / Noise rekey timed out"))?
            .context("读取 Noise 重协商应答失败 / failed to read Noise rekey response")?;
        let Some((kind, body)) = record else {
            bail!("Noise 重协商期间连接关闭 / connection closed during Noise rekey");
        };
        match kind {
            KIND_HANDSHAKE => {
                handshake.read_message(&body, &mut plain).map_err(|error| {
                    anyhow!(
                        "Noise 重协商认证失败（PSK 不匹配或对端不是 Noise）/ Noise rekey authentication failed (PSK mismatch or peer is not Noise): {error}"
                    )
                })?;
                let transport = handshake.into_transport_mode().map_err(|error| {
                    anyhow!("Noise 重协商未完成 / Noise rekey did not complete: {error}")
                })?;
                *session = transport;
                return Ok(());
            }
            KIND_DATA => {
                if body.len() > MAX_DATA_PLAINTEXT + TAG_LEN {
                    bail!("Noise 重协商期间数据记录超限 / Noise data record exceeds the limit during rekey");
                }
                let read = session.read_message(&body, &mut plain).map_err(|error| {
                    anyhow!("Noise 重协商期间旧会话解密失败 / old session failed to decrypt during rekey: {error}")
                })?;
                app_writer
                    .write_all(&plain[..read])
                    .await
                    .context("写入 Noise 重协商期间的数据失败 / failed to write data during Noise rekey")?;
            }
            other => bail!(
                "Noise 重协商收到未知记录类型（kind={other}）/ unexpected record kind {other} during Noise rekey"
            ),
        }
    }
}

/// 服务端响应一次重协商：回 msg2 成功后立即切换到新会话。
async fn rekey_server(
    net_write: &mut WriteHalf<TcpStream>,
    body: &[u8],
    material: &NoiseMaterial,
    session: &mut TransportState,
) -> Result<()> {
    let mut handshake = responder_handshake(material)?;
    let mut payload = vec![0u8; HANDSHAKE_BUF];
    handshake
        .read_message(body, &mut payload)
        .map_err(|error| {
            anyhow!("Noise 重协商认证失败 / Noise rekey authentication failed: {error}")
        })?;
    let expected = material.static_public();
    if handshake.get_remote_static() != Some(&expected[..]) {
        bail!("Noise 重协商对端静态密钥不匹配 / Noise rekey peer static key mismatch");
    }

    let mut message = vec![0u8; HANDSHAKE_BUF];
    let len = handshake
        .write_message(&[], &mut message)
        .map_err(|error| {
            anyhow!("生成 Noise 重协商应答失败 / failed to write Noise rekey response: {error}")
        })?;
    write_record(net_write, KIND_HANDSHAKE, &message[..len])
        .await
        .context("发送 Noise 重协商应答失败 / failed to send Noise rekey response")?;

    let transport = handshake
        .into_transport_mode()
        .map_err(|error| anyhow!("Noise 重协商未完成 / Noise rekey did not complete: {error}"))?;
    *session = transport;
    Ok(())
}

async fn write_record<W>(writer: &mut W, kind: u8, body: &[u8]) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    if body.len() > MAX_RECORD_BODY {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Noise 记录超过 65535 字节 / Noise record exceeds 65535 bytes",
        ));
    }
    let mut header = [0u8; RECORD_HEADER_LEN];
    header[0] = kind;
    header[1..].copy_from_slice(&(body.len() as u32).to_be_bytes());
    writer.write_all(&header).await?;
    writer.write_all(body).await?;
    writer.flush().await
}

/// 读一条记录；`None` = 在记录边界干净 EOF。
async fn read_record<R>(reader: &mut R) -> io::Result<Option<(u8, Vec<u8>)>>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0u8; RECORD_HEADER_LEN];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
    if len > MAX_RECORD_BODY {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Noise 记录长度 {len} 超过上限 / Noise record length {len} exceeds the limit"),
        ));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    Ok(Some((header[0], body)))
}

async fn read_record_required<R>(reader: &mut R) -> io::Result<(u8, Vec<u8>)>
where
    R: AsyncRead + Unpin,
{
    read_record(reader).await?.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Noise 握手在记录边界前关闭 / Noise handshake closed before any record",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_derivation_is_deterministic_and_domain_separated() {
        let first = NoiseMaterial::from_secret(b"hop-secret");
        let second = NoiseMaterial::from_secret(b"hop-secret");
        let other = NoiseMaterial::from_secret(b"other-secret");

        assert_eq!(first.private, second.private);
        assert_eq!(first.public, second.public);
        assert_eq!(first.psk, second.psk);
        assert_ne!(first.public, other.public);
        assert_ne!(first.psk, other.psk);
        // 静态私钥与 PSK 不能相同（HMAC 标签做域分离）。
        assert_ne!(first.private, first.psk);
        // 公钥必须由私钥推导，而不是从 HMAC 直接截取。
        assert_eq!(first.public, static_public_key(&first.private));
    }

    #[test]
    fn mode_bytes_are_stable() {
        assert_eq!(MODE_TLS, 0x01);
        assert_eq!(MODE_NOISE, 0x02);
        assert_ne!(MODE_TLS, MODE_NOISE);
    }

    #[tokio::test]
    async fn record_roundtrip_and_limits() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        write_record(&mut client, KIND_DATA, b"hello")
            .await
            .unwrap();
        let (kind, body) = read_record_required(&mut server).await.unwrap();
        assert_eq!(kind, KIND_DATA);
        assert_eq!(body, b"hello");

        let mut header = [0u8; RECORD_HEADER_LEN];
        header[1..].copy_from_slice(&(MAX_RECORD_BODY as u32 + 1).to_be_bytes());
        tokio::io::AsyncWriteExt::write_all(&mut client, &header)
            .await
            .unwrap();
        let error = read_record(&mut server).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
