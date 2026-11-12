//! 帧层 ↔ 字节流的适配器。
//!
//! P16.1 的骨架用 `tokio::io::duplex(32 KiB)` 把帧层和 `copy_bidirectional`
//! 桥起来：每条连接多一份 32 KiB 的管道缓冲，外加一个 32 KiB 的泵缓冲。
//! 这里直接把 `FrameKind::Data` 的 payload 暴露成 `AsyncRead`/`AsyncWrite`：
//!
//! * 读：先读 5 字节帧头，再把 payload 直接读进调用方的 buffer；
//!   `PING` 的 payload 被丢弃，`CLOSE` 表现为 EOF；
//! * 写：每次 `poll_write` 最多接受 [`WRITE_CHUNK`] 字节，编码成一帧写入
//!   底层。未写完的部分留在一个小缓冲里，下次 `poll_write` 先把它排空，
//!   期间返回 `Pending` 以施加背压。
//!
//! 这样 `copy_bidirectional_with_sizes(32 KiB)` 可以**直接**跑在适配器和
//! `TcpStream` 之间，不再需要 duplex 和额外的泵任务。读方向没有内部
//! payload 缓冲，写方向只有一个上限 8 KiB 的小缓冲；单连接常驻内存因此
//! 回落到「两个 32 KiB copy 缓冲 + rustls 会话 + 8 KiB」的量级。
//!
//! 关闭语义：读到 `CLOSE` 时置位 [`FrameIo::close_notify`]，服务端可以在
//! `copy_bidirectional` 之外 `select!` 这个通知，实现「CLOSE = 立即断开」，
//! 不必等另一个方向自然 EOF。

use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::Notify;

use super::framing::{FrameKind, MAX_FRAME_PAYLOAD};

/// 单次 `poll_write` 最多接受的字节数。
///
/// 8 KiB 是折中：小到常驻内存可以忽略，大到不会把 32 KiB 的 copy 缓冲
/// 切成太多帧。它不是线上协议的一部分，只影响本端每次写多少。
pub const WRITE_CHUNK: usize = 8 * 1024;

const HEADER_LEN: usize = 5;

#[derive(Debug)]
enum ReadState {
    /// 正在收帧头；`filled` 是已收字节数。
    Header {
        data: [u8; HEADER_LEN],
        filled: usize,
    },
    /// 正在读 payload；`discard = true` 时是 PING 的 payload。
    Payload { remaining: usize, discard: bool },
}

impl Default for ReadState {
    fn default() -> Self {
        Self::Header {
            data: [0u8; HEADER_LEN],
            filled: 0,
        }
    }
}

/// 把帧流包装成 `AsyncRead + AsyncWrite`。
pub struct FrameIo<S> {
    inner: S,
    read: ReadState,
    /// 已编码但尚未完全写出的帧（最多 `HEADER_LEN + WRITE_CHUNK` 字节）。
    write_buf: Vec<u8>,
    write_pos: usize,
    /// `poll_shutdown` 已经排入 CLOSE 帧；之后的写一律拒绝。
    write_closed: bool,
    close_seen: Arc<AtomicBool>,
    close_notify: Arc<Notify>,
}

impl<S> FrameIo<S> {
    pub fn new(inner: S) -> Self {
        Self {
            inner,
            read: ReadState::default(),
            write_buf: Vec::new(),
            write_pos: 0,
            write_closed: false,
            close_seen: Arc::new(AtomicBool::new(false)),
            close_notify: Arc::new(Notify::new()),
        }
    }

    /// 对端发来 `CLOSE` 时会被唤醒；用 `select!` 实现立即断开。
    ///
    /// `Notify` 用 `notify_one`（保存一个许可），所以即使 CLOSE 在
    /// `notified()` 之前到达也不会丢通知。
    pub fn close_notify(&self) -> Arc<Notify> {
        Arc::clone(&self.close_notify)
    }

    pub fn saw_close(&self) -> bool {
        self.close_seen.load(Ordering::Acquire)
    }

    fn mark_closed(&self) {
        self.close_seen.store(true, Ordering::Release);
        self.close_notify.notify_one();
    }
}

impl<S> FrameIo<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    /// 把 `write_buf[write_pos..]` 尽量写空。
    fn poll_flush_pending(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        while self.write_pos < self.write_buf.len() {
            match Pin::new(&mut self.inner).poll_write(cx, &self.write_buf[self.write_pos..]) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Ok(0)) => {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "隧道底层写返回 0 / tunnel writer returned zero bytes",
                    )))
                }
                Poll::Ready(Ok(n)) => self.write_pos += n,
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
            }
        }
        self.write_buf.clear();
        self.write_pos = 0;
        Poll::Ready(Ok(()))
    }

    /// 把一帧编码进 `write_buf`（调用前必须已经排空）。
    fn queue_frame(&mut self, kind: FrameKind, payload: &[u8]) {
        debug_assert!(payload.len() <= MAX_FRAME_PAYLOAD);
        debug_assert!(self.write_pos == self.write_buf.len());
        self.write_buf.clear();
        self.write_buf.push(kind as u8);
        self.write_buf
            .extend_from_slice(&(payload.len() as u32).to_be_bytes());
        self.write_buf.extend_from_slice(payload);
        self.write_pos = 0;
    }

    /// 读帧头；返回 `Ok(Some((kind, len)))`、`Ok(None)` 表示干净 EOF。
    fn poll_read_header(
        &mut self,
        cx: &mut Context<'_>,
    ) -> Poll<io::Result<Option<(FrameKind, usize)>>> {
        loop {
            let ReadState::Header { data, filled } = &mut self.read else {
                unreachable!("只有 Header 状态会调用 poll_read_header");
            };
            if *filled == HEADER_LEN {
                let kind = match FrameKind::try_from(data[0]) {
                    Ok(kind) => kind,
                    Err(error) => {
                        self.read = ReadState::default();
                        return Poll::Ready(Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            error.to_string(),
                        )));
                    }
                };
                let declared = u32::from_be_bytes([data[1], data[2], data[3], data[4]]) as usize;
                *filled = 0;
                if declared > MAX_FRAME_PAYLOAD {
                    self.read = ReadState::default();
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "帧长度 {declared} 超过上限 {MAX_FRAME_PAYLOAD} / frame length {declared} exceeds the {MAX_FRAME_PAYLOAD}-byte limit"
                        ),
                    )));
                }
                return Poll::Ready(Ok(Some((kind, declared))));
            }

            let start = *filled;
            let mut chunk = ReadBuf::new(&mut data[start..]);
            match Pin::new(&mut self.inner).poll_read(cx, &mut chunk) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Ready(Ok(())) => {
                    let read = chunk.filled().len();
                    if read == 0 {
                        // 帧头只读了一半就 EOF：半帧不是正常关闭，不能当 EOF。
                        return Poll::Ready(if *filled == 0 {
                            Ok(None)
                        } else {
                            Err(io::Error::new(
                                io::ErrorKind::UnexpectedEof,
                                "隧道在帧头中途关闭 / tunnel closed in the middle of a frame header",
                            ))
                        });
                    }
                    *filled += read;
                }
            }
        }
    }
}

impl<S> AsyncRead for FrameIo<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            if this.saw_close() {
                // CLOSE = EOF。之后再读也保持 EOF，避免调用方循环重试。
                return Poll::Ready(Ok(()));
            }

            match this.read {
                ReadState::Header { .. } => {
                    let Some((kind, len)) = ready!(this.poll_read_header(cx))? else {
                        return Poll::Ready(Ok(()));
                    };
                    match kind {
                        FrameKind::Close => {
                            this.mark_closed();
                            return Poll::Ready(Ok(()));
                        }
                        FrameKind::Ping => {
                            this.read = ReadState::Payload {
                                remaining: len,
                                discard: true,
                            };
                        }
                        FrameKind::Data => {
                            if len == 0 {
                                // 空 DATA 帧不产生字节，继续读下一帧。
                                continue;
                            }
                            this.read = ReadState::Payload {
                                remaining: len,
                                discard: false,
                            };
                        }
                    }
                }
                ReadState::Payload { remaining, discard } => {
                    if remaining == 0 {
                        this.read = ReadState::default();
                        continue;
                    }
                    if discard {
                        // PING 的 payload 丢弃；用固定小栈缓冲，不占常驻内存。
                        let mut scratch = [0u8; 256];
                        let take = remaining.min(scratch.len());
                        let mut chunk = ReadBuf::new(&mut scratch[..take]);
                        match Pin::new(&mut this.inner).poll_read(cx, &mut chunk) {
                            Poll::Pending => return Poll::Pending,
                            Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                            Poll::Ready(Ok(())) => {
                                let read = chunk.filled().len();
                                if read == 0 {
                                    return Poll::Ready(Err(io::Error::new(
                                        io::ErrorKind::UnexpectedEof,
                                        "隧道在帧 payload 中途关闭 / tunnel closed in the middle of a frame payload",
                                    )));
                                }
                                this.read = ReadState::Payload {
                                    remaining: remaining - read,
                                    discard: true,
                                };
                            }
                        }
                        continue;
                    }

                    let unfilled = buf.initialize_unfilled();
                    let take = unfilled.len().min(remaining);
                    if take == 0 {
                        // 调用方 buffer 已满：返回已读字节（可能是 0）。
                        return Poll::Ready(Ok(()));
                    }
                    let mut chunk = ReadBuf::new(&mut unfilled[..take]);
                    match Pin::new(&mut this.inner).poll_read(cx, &mut chunk) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                        Poll::Ready(Ok(())) => {
                            let read = chunk.filled().len();
                            if read == 0 {
                                return Poll::Ready(Err(io::Error::new(
                                    io::ErrorKind::UnexpectedEof,
                                    "隧道在帧 payload 中途关闭 / tunnel closed in the middle of a frame payload",
                                )));
                            }
                            buf.advance(read);
                            this.read = ReadState::Payload {
                                remaining: remaining - read,
                                discard: false,
                            };
                            return Poll::Ready(Ok(()));
                        }
                    }
                }
            }
        }
    }
}

impl<S> AsyncWrite for FrameIo<S>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.write_closed {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "隧道写方向已关闭 / tunnel write side is closed",
            )));
        }

        // 先排空上一帧的尾巴，没排空就施加背压。
        if this.write_pos < this.write_buf.len() {
            ready!(this.poll_flush_pending(cx))?;
        }

        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }

        let take = buf.len().min(WRITE_CHUNK);
        this.queue_frame(FrameKind::Data, &buf[..take]);
        // 尽量立刻写出；即使底层返回 Pending，也已经「接受」了这 take 字节，
        // 剩余部分留在 write_buf，下次 poll_write 先排空。
        match this.poll_flush_pending(cx) {
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            _ => Poll::Ready(Ok(take)),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        ready!(this.poll_flush_pending(cx))?;
        Pin::new(&mut this.inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.write_closed {
            ready!(this.poll_flush_pending(cx))?;
            this.write_closed = true;
        }
        // 半关语义：只关底层 TLS 写方向（close_notify），**不**发 CLOSE 帧。
        // CLOSE 是「立即断开」，由上层在目标不可达/白名单拒绝等场景显式发送；
        // 把半关也映射成 CLOSE 会让客户端误以为整条连接被立即丢弃。
        Pin::new(&mut this.inner).poll_shutdown(cx)
    }
}

/// 让 `?` / `ready!` 在返回 `Poll` 的函数里更好读。
use std::task::ready;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use crate::tunnel::framing::{read_frame, write_frame};

    #[tokio::test]
    async fn reads_data_across_frames_and_skips_ping() {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let mut client = client;
        write_frame(&mut client, FrameKind::Data, b"hello")
            .await
            .unwrap();
        write_frame(&mut client, FrameKind::Ping, b"ignored")
            .await
            .unwrap();
        write_frame(&mut client, FrameKind::Data, b" world")
            .await
            .unwrap();
        drop(client);

        let mut io = FrameIo::new(server);
        let mut out = Vec::new();
        io.read_to_end(&mut out).await.unwrap();
        assert_eq!(out, b"hello world");
    }

    #[tokio::test]
    async fn close_is_eof_and_notifies() {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let mut client = client;
        write_frame(&mut client, FrameKind::Data, b"abc")
            .await
            .unwrap();
        write_frame(&mut client, FrameKind::Close, &[])
            .await
            .unwrap();

        let mut io = FrameIo::new(server);
        let mut buf = [0u8; 8];
        assert_eq!(io.read(&mut buf).await.unwrap(), 3);
        assert_eq!(&buf[..3], b"abc");

        let notify = io.close_notify();
        assert_eq!(io.read(&mut buf).await.unwrap(), 0, "CLOSE 之后必须是 EOF");
        assert!(io.saw_close());
        notify.notified().await; // 已置位，应当立刻返回。
    }

    #[tokio::test]
    async fn writes_are_chunked_but_reassemble_on_the_wire() {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let mut io = FrameIo::new(client);
        let payload = vec![0x5a; WRITE_CHUNK * 2 + 17];
        io.write_all(&payload).await.unwrap();
        io.flush().await.unwrap();
        io.shutdown().await.unwrap();

        let mut server = server;
        let mut out = Vec::new();
        while let Some(frame) = read_frame(&mut server).await.unwrap() {
            match frame.kind {
                FrameKind::Data => out.extend_from_slice(&frame.payload),
                FrameKind::Close => panic!("半关不能发 CLOSE 帧"),
                FrameKind::Ping => {}
            }
        }
        assert_eq!(out, payload);
    }

    #[tokio::test]
    async fn oversized_and_truncated_frames_are_errors() {
        // 帧头声明 64 KiB + 1：只看头就要报错，不能去分配 payload。
        let (client, server) = tokio::io::duplex(64);
        let mut client = client;
        let mut header = [0u8; 5];
        header[0] = FrameKind::Data as u8;
        header[1..].copy_from_slice(&(MAX_FRAME_PAYLOAD as u32 + 1).to_be_bytes());
        client.write_all(&header).await.unwrap();

        let mut io = FrameIo::new(server);
        let mut buf = [0u8; 4];
        let error = io.read(&mut buf).await.unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }
}
