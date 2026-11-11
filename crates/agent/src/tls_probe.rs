//! 加密链路的**真实** TLS 握手探针。
//!
//! 「端口能连上」不等于「链路能用」：realm 的 TLS 配置配错（证书过期、SNI 不匹配、
//! 自签或被中间人替换）时，监听仍然成功、TCP 仍然能建立，但握手在下一跳失败，
//! 面板只看到「监听中」而实际全断。这里用与 realm **完全相同的信任根**再握手一次，
//! 把失败原因变成稳定的错误码回报给主控。
//!
//! 信任根必须一致：realm 2.9.6 的 kaminari 客户端固定使用编译进二进制的
//! `webpki_roots::TLS_SERVER_ROOTS`，没有自定义 CA 选项。探针若改用系统根或
//! 自签根，就会出现「探针说通、realm 说不通」（或反过来），比没有探针更糟。
//! 因此这里只加载 Mozilla 根，且不提供任何覆盖入口。
//!
//! 探针只观测，不影响转发：realm 自己决定何时重连；失败只写状态。

use std::error::Error as _;
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use rustls::pki_types::ServerName;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

/// 一轮探测的总预算：TCP connect + TLS 握手。
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// 握手成功时**不产生**错误码；以下都是稳定短串，主控/前端负责翻译。
pub const TCP_CONNECT_FAILED: &str = "tcp_connect_failed";
pub const CERT_EXPIRED: &str = "cert_expired";
pub const UNKNOWN_ISSUER: &str = "unknown_issuer";
pub const NAME_MISMATCH: &str = "name_mismatch";
pub const HANDSHAKE_FAILED: &str = "handshake_failed";
pub const TIMEOUT: &str = "timeout";

/// 探针结果：`None` = 握手成功；`Some(code)` = 失败原因码。
///
/// 返回 `&'static str` 而不是拼字符串：这些码要跨版本稳定，UI 才有得翻译；
/// 也避免把 rustls 的 Debug 文本（含证书路径/内部状态）泄漏到主控。
pub type ProbeError = Option<&'static str>;

/// 一次带耗时的探针结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimedProbe {
    /// 与 [`probe_timed`] 相同的错误码；成功为 `None`。
    pub error: ProbeError,
    /// TCP connect + TLS 握手的毫秒数；失败为 `None`。
    ///
    /// 小于 1ms（本机回环）也向上取到 1ms：延迟字段不允许出现 0。
    pub latency_ms: Option<u32>,
}

impl TimedProbe {
    fn failed(error: &'static str) -> Self {
        Self {
            error: Some(error),
            latency_ms: None,
        }
    }
}

/// 对 `host:port` 做一次 TCP connect + TLS 握手，SNI 用 `sni`。
///
/// 总预算 [`PROBE_TIMEOUT`]（3 秒）。成功返回 `None`，失败返回稳定错误码；
/// 同时返回握手耗时（毫秒），失败时耗时为 `None`。成功后立即关闭连接
/// （探针不做任何业务 I/O）。
pub async fn probe_timed(host: &str, port: i64, sni: &str) -> TimedProbe {
    probe_timed_with_timeout(host, port, sni, PROBE_TIMEOUT).await
}

/// 同 [`probe_timed`]，但可指定总预算（测试用短超时）。
#[cfg(test)]
async fn probe_with_timeout(host: &str, port: i64, sni: &str, budget: Duration) -> ProbeError {
    probe_timed_with_timeout(host, port, sni, budget)
        .await
        .error
}

async fn probe_timed_with_timeout(
    host: &str,
    port: i64,
    sni: &str,
    budget: Duration,
) -> TimedProbe {
    match tokio::time::timeout(budget, probe_inner(host, port, sni)).await {
        Ok(result) => result,
        Err(_) => TimedProbe::failed(TIMEOUT),
    }
}

async fn probe_inner(host: &str, port: i64, sni: &str) -> TimedProbe {
    let Some(port) = u16::try_from(port).ok().filter(|port| *port != 0) else {
        return TimedProbe::failed(TCP_CONNECT_FAILED);
    };
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return TimedProbe::failed(TCP_CONNECT_FAILED);
    }
    let addresses = match tokio::net::lookup_host((host, port)).await {
        Ok(addresses) => addresses.collect::<Vec<SocketAddr>>(),
        Err(_) => return TimedProbe::failed(TCP_CONNECT_FAILED),
    };
    if addresses.is_empty() {
        return TimedProbe::failed(TCP_CONNECT_FAILED);
    }

    // SNI 必须与 realm 的 `ServerName::try_from(sni)` 一致（DNS 名，不含端口）。
    let Ok(server_name) = ServerName::try_from(sni.to_ascii_lowercase()) else {
        return TimedProbe::failed(NAME_MISMATCH);
    };
    let connector = TlsConnector::from(client_config());

    let mut last_connect_error = TCP_CONNECT_FAILED;
    for address in addresses {
        let started = Instant::now();
        let stream = match TcpStream::connect(address).await {
            Ok(stream) => stream,
            Err(error) => {
                last_connect_error = if error.kind() == io::ErrorKind::TimedOut {
                    TIMEOUT
                } else {
                    TCP_CONNECT_FAILED
                };
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        return match connector.connect(server_name.clone(), stream).await {
            Ok(mut tls) => {
                let millis = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
                // 握手成功就够了；立即关闭，不发送任何业务字节。
                let _ = tls.shutdown().await;
                TimedProbe {
                    error: None,
                    latency_ms: Some(millis.max(1)),
                }
            }
            Err(error) => TimedProbe::failed(classify_handshake_error(&error)),
        };
    }
    TimedProbe::failed(last_connect_error)
}

/// 与 realm/kaminari 相同的信任根：编译进二进制的 Mozilla 根，**只用这一份**。
static CLIENT_CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();

fn client_config() -> Arc<rustls::ClientConfig> {
    CLIENT_CONFIG
        .get_or_init(|| {
            let roots = rustls::RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            };
            // 不加 ALPN / 客户端证书：realm 的 TLS 客户端也是纯粹的 server-auth 握手。
            Arc::new(
                rustls::ClientConfig::builder()
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
            )
        })
        .clone()
}

/// 把 rustls 错误映射成稳定短串。
///
/// 只区分产品上能给出不同建议的几类；其它一律 `handshake_failed`，
/// 让用户去调 `realm_log_level = debug` 看 realm 的原始日志，而不是把内部
/// Debug 文本塞进面板。
pub fn map_rustls_error(error: &rustls::Error) -> &'static str {
    match error {
        rustls::Error::InvalidCertificate(certificate_error) => {
            map_certificate_error(certificate_error)
        }
        _ => HANDSHAKE_FAILED,
    }
}

fn map_certificate_error(error: &rustls::CertificateError) -> &'static str {
    use rustls::CertificateError as E;
    match error {
        E::Expired | E::ExpiredContext { .. } => CERT_EXPIRED,
        E::NotValidForName | E::NotValidForNameContext { .. } => NAME_MISMATCH,
        E::UnknownIssuer => UNKNOWN_ISSUER,
        _ => HANDSHAKE_FAILED,
    }
}

/// tokio-rustls 把握手错误包成 `io::Error`（inner 是 `rustls::Error`）：
/// 先降级到 rustls 错误再映射；纯 IO 错误按超时/其它分类。
pub fn classify_handshake_error(error: &io::Error) -> &'static str {
    if let Some(source) = error.get_ref() {
        if let Some(rustls_error) = source.downcast_ref::<rustls::Error>() {
            return map_rustls_error(rustls_error);
        }
    }
    let mut source = error.source();
    while let Some(cause) = source {
        if let Some(rustls_error) = cause.downcast_ref::<rustls::Error>() {
            return map_rustls_error(rustls_error);
        }
        source = cause.source();
    }
    if error.kind() == io::ErrorKind::TimedOut {
        TIMEOUT
    } else {
        HANDSHAKE_FAILED
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use rustls::CertificateError;
    use tokio::net::TcpListener;

    /// 与 realm 的信任根完全一致：一张**不在公网信任链里**的自签叶子证书
    /// （`CA:FALSE`，SAN `example.com`）。用它起本地监听，客户端必然报
    /// `unknown_issuer`。
    pub(crate) const TEST_CERT_PEM: &str = include_str!("../tests/fixtures/self-signed-leaf.pem");
    pub(crate) const TEST_KEY_PEM: &str =
        include_str!("../tests/fixtures/self-signed-leaf-key.pem");

    fn pem_der(pem: &str) -> Vec<u8> {
        use base64::Engine as _;
        let body: String = pem
            .lines()
            .filter(|line| !line.starts_with("-----"))
            .collect();
        base64::engine::general_purpose::STANDARD
            .decode(body)
            .expect("测试夹具必须是合法 PEM")
    }

    /// 起一个本地自签 TLS 监听，返回端口与后台任务句柄。
    ///
    /// 客户端握手失败后服务端 accept 也会失败，任务里忽略即可。
    pub(crate) async fn spawn_self_signed_server(
        cert_pem: &str,
        key_pem: &str,
    ) -> (u16, tokio::task::JoinHandle<()>) {
        let certificates = vec![CertificateDer::from(pem_der(cert_pem))];
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pem_der(key_pem)));
        let config = Arc::new(
            rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(certificates, key)
                .expect("测试证书与私钥必须匹配"),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let acceptor = tokio_rustls::TlsAcceptor::from(config);
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let _ = acceptor.accept(stream).await;
                });
            }
        });
        (port, task)
    }

    #[test]
    fn certificate_errors_map_to_stable_codes() {
        let expired = rustls::Error::InvalidCertificate(CertificateError::Expired);
        assert_eq!(map_rustls_error(&expired), CERT_EXPIRED);
        let expired_ctx = rustls::Error::InvalidCertificate(CertificateError::ExpiredContext {
            time: rustls::pki_types::UnixTime::since_unix_epoch(Duration::from_secs(1)),
            not_after: rustls::pki_types::UnixTime::since_unix_epoch(Duration::from_secs(0)),
        });
        assert_eq!(map_rustls_error(&expired_ctx), CERT_EXPIRED);

        let unknown_issuer = rustls::Error::InvalidCertificate(CertificateError::UnknownIssuer);
        assert_eq!(map_rustls_error(&unknown_issuer), UNKNOWN_ISSUER);

        let name_mismatch = rustls::Error::InvalidCertificate(CertificateError::NotValidForName);
        assert_eq!(map_rustls_error(&name_mismatch), NAME_MISMATCH);

        // 其它证书错误不单独造码：用户能做的事一样（换证书/看 realm 日志）。
        let bad_encoding = rustls::Error::InvalidCertificate(CertificateError::BadEncoding);
        assert_eq!(map_rustls_error(&bad_encoding), HANDSHAKE_FAILED);
        assert_eq!(
            map_rustls_error(&rustls::Error::AlertReceived(
                rustls::AlertDescription::HandshakeFailure
            )),
            HANDSHAKE_FAILED
        );
    }

    #[test]
    fn io_errors_unwrap_rustls_and_distinguish_timeout() {
        let wrapped = io::Error::other(rustls::Error::InvalidCertificate(
            CertificateError::UnknownIssuer,
        ));
        assert_eq!(
            classify_handshake_error(&wrapped),
            UNKNOWN_ISSUER,
            "tokio-rustls 把 rustls 错误包在 io::Error 里，必须解包"
        );

        let timed_out = io::Error::new(io::ErrorKind::TimedOut, "connect timed out");
        assert_eq!(classify_handshake_error(&timed_out), TIMEOUT);

        let reset = io::Error::new(io::ErrorKind::ConnectionReset, "reset");
        assert_eq!(classify_handshake_error(&reset), HANDSHAKE_FAILED);
    }

    #[tokio::test]
    async fn self_signed_listener_is_unknown_issuer() {
        let (port, task) = spawn_self_signed_server(TEST_CERT_PEM, TEST_KEY_PEM).await;
        let error = probe_with_timeout(
            "127.0.0.1",
            i64::from(port),
            "example.com",
            Duration::from_secs(3),
        )
        .await;
        task.abort();
        println!("self-signed TLS listener at 127.0.0.1:{port} -> {error:?}");
        assert_eq!(
            error,
            Some(UNKNOWN_ISSUER),
            "自签证书不在 Mozilla 根里，必须报 unknown_issuer（与 realm 一致）"
        );
    }

    #[tokio::test]
    async fn not_listening_is_tcp_connect_failed() {
        // 先拿一个端口再释放：连接必然被拒绝，且不是超时。
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let error = probe_with_timeout(
            "127.0.0.1",
            i64::from(port),
            "example.com",
            Duration::from_secs(1),
        )
        .await;
        assert_eq!(error, Some(TCP_CONNECT_FAILED));
    }

    #[tokio::test]
    async fn silent_listener_is_timeout() {
        // TCP 能连上但永远不回 ServerHello：握手阶段超时，必须与连接失败区分。
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            // 持有连接直到探针放弃。
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(stream);
        });
        let error = probe_with_timeout(
            "127.0.0.1",
            i64::from(port),
            "example.com",
            Duration::from_millis(300),
        )
        .await;
        task.abort();
        assert_eq!(error, Some(TIMEOUT));
    }

    /// 失败路径不能带耗时：`latency_ms = None`（不是 0）。
    #[tokio::test]
    async fn timed_probe_reports_no_latency_on_failure() {
        let result =
            probe_timed_with_timeout("127.0.0.1", 0, "example.com", Duration::from_millis(300))
                .await;
        assert_eq!(result.error, Some(TCP_CONNECT_FAILED));
        assert_eq!(result.latency_ms, None, "失败不能报告 0ms");
    }

    #[tokio::test]
    async fn invalid_targets_are_connect_failures() {
        assert_eq!(
            probe_with_timeout("", 443, "example.com", Duration::from_millis(300)).await,
            Some(TCP_CONNECT_FAILED)
        );
        assert_eq!(
            probe_with_timeout("127.0.0.1", 0, "example.com", Duration::from_millis(300)).await,
            Some(TCP_CONNECT_FAILED)
        );
        assert_eq!(
            probe_with_timeout(
                "127.0.0.1",
                65536,
                "example.com",
                Duration::from_millis(300)
            )
            .await,
            Some(TCP_CONNECT_FAILED),
            "非法端口不能被当成可达或超时"
        );
    }
}
