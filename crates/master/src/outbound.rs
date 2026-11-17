//! 出站 HTTP 响应体上限。
//!
//! 主控会用系统 `curl` 拉三类外部响应：GitHub Releases（JSON）、GitHub Release
//! 产物（Agent 二进制）与 WebDAV 的 PROPFIND（XML）。响应体大小完全由对端决定，
//! 不设上限就等于把「对端返回多少就分配多少」交给外部。
//!
//! **为什么是 16 MiB 而不是 8 MiB**：8 MiB 会直接切断现有 Agent 自升级——
//! v0.14.2 的 `pierwave-agent-x86_64-unknown-linux-musl` 已经是 8.76 MB，
//! 再留出增长空间后取 16 MiB。三类请求共用同一个上限，避免出现两套口径。
//!
//! 防护分两层：
//! 1. curl 侧加 `--max-filesize`：对端提供 `Content-Length` 时在下载前就拒绝；
//! 2. 读回后在 Rust 侧再检查一次：`--max-filesize` 对 chunked / 无长度响应不生效，
//!    所以最终仍以实际字节数为准（见各调用点）。

/// 单次出站 HTTP 响应体的硬上限（字节）。
pub const MAX_OUTBOUND_BODY_BYTES: u64 = 16 * 1024 * 1024;

/// 上限的 MiB 值，用于错误文案与 curl 参数。
pub const MAX_OUTBOUND_BODY_MIB: u64 = MAX_OUTBOUND_BODY_BYTES / (1024 * 1024);

/// 给 curl `--max-filesize` 的十进制参数。
pub fn max_filesize_arg() -> String {
    MAX_OUTBOUND_BODY_BYTES.to_string()
}

/// 已读到的响应体是否超限。
pub fn exceeded(len: u64) -> bool {
    len > MAX_OUTBOUND_BODY_BYTES
}

/// 超限错误（中英双语）；`detail` 是调用方补充的上下文。
pub fn too_large(detail: &str) -> String {
    format!(
        "{detail}：响应体超过 {MAX_OUTBOUND_BODY_MIB} MiB 上限 / {detail}: response body exceeds the {MAX_OUTBOUND_BODY_MIB} MiB limit"
    )
}
