//! MCP 2024-11-05 JSON-RPC 2.0 framing and dispatch.

use serde_json::{json, Map, Value};

use crate::db::Database;
use crate::tools::{self, CallError};
use crate::{PROTOCOL_VERSION, SERVER_NAME, SERVER_VERSION};

/// JSON-RPC standard error codes.
pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

/// stdio 单行上限（1 MiB，含行尾换行符）。
///
/// 与 Agent WebSocket 的消息上限一致。没有上限时，客户端可以发一行无限长的
/// JSON 让进程把内存吃光；读入前先按字节上限截断才是真的保护。
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// [`read_limited_line`] 的结果。
enum LineOutcome {
    /// 一行完整内容（可能为空行，由调用方决定忽略）。
    Line(Vec<u8>),
    /// 该行超过上限；剩余字节已经被读掉并丢弃，流已重新对齐到下一行。
    TooLong,
    /// stdin 已到 EOF。
    Eof,
}

/// 从 `reader` 读一行，最多保留 `limit` 字节。
///
/// 超限时**继续读到换行并丢弃**，让下一条消息仍能按行解析；调用方据此回一条
/// `-32700` 错误后继续服务，而不是退出进程——一条超大的通知不该杀死长期运行的
/// MCP 服务。因为这一行无法解析，响应里的 `id` 只能是 `null`。
async fn read_limited_line<R>(reader: &mut R, limit: usize) -> std::io::Result<LineOutcome>
where
    R: tokio::io::AsyncBufRead + Unpin,
{
    use tokio::io::AsyncBufReadExt;

    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if too_long {
                return Ok(LineOutcome::TooLong);
            }
            if line.is_empty() {
                return Ok(LineOutcome::Eof);
            }
            // EOF 前的最后一行没有换行符：与 `read_line` 一样返回它。
            return Ok(LineOutcome::Line(line));
        }

        let (chunk_len, found_newline) = match available.iter().position(|byte| *byte == b'\n') {
            Some(index) => (index + 1, true),
            None => (available.len(), false),
        };

        if !too_long {
            if line.len() + chunk_len > limit {
                // 不保留前缀：超限行不会被当成请求处理，留着只是浪费内存。
                too_long = true;
                line = Vec::new();
            } else {
                line.extend_from_slice(&available[..chunk_len]);
            }
        }
        reader.consume(chunk_len);

        if found_newline {
            return Ok(if too_long {
                LineOutcome::TooLong
            } else {
                LineOutcome::Line(line)
            });
        }
    }
}

/// A stdio MCP server bound to a read-only database.
pub struct Server {
    db: Database,
}

impl Server {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    pub fn database(&self) -> &Database {
        &self.db
    }

    /// Handle one input line. Returns `None` for notifications and blank lines.
    pub async fn handle_line(&self, line: &str) -> Option<Value> {
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(message) => self.handle_message(message).await,
            Err(error) => Some(error_response(
                Value::Null,
                PARSE_ERROR,
                format!("解析错误 / Parse error: {error}"),
            )),
        }
    }

    /// Handle one already-parsed JSON-RPC message.
    ///
    /// Notifications (objects without an `id`) are ignored, as required by the
    /// MCP stdio transport. This includes `notifications/initialized` and
    /// `notifications/cancelled`.
    pub async fn handle_message(&self, message: Value) -> Option<Value> {
        let Value::Object(object) = message else {
            return Some(error_response(
                Value::Null,
                INVALID_REQUEST,
                "无效请求 / Invalid Request: expected a JSON object".into(),
            ));
        };
        let id = object.get("id").cloned()?;
        if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Some(error_response(
                id,
                INVALID_REQUEST,
                "无效请求 / Invalid Request: jsonrpc must be \"2.0\"".into(),
            ));
        }
        let Some(method) = object.get("method").and_then(Value::as_str) else {
            return Some(error_response(
                id,
                INVALID_REQUEST,
                "无效请求 / Invalid Request: missing method".into(),
            ));
        };
        // MCP notifications never carry a request id, but ignore them even if a
        // client illegally includes one: they must not produce a response.
        if method.starts_with("notifications/") {
            return None;
        }

        match method {
            "initialize" => Some(success(id, initialize_result())),
            "ping" => Some(success(id, json!({}))),
            "tools/list" => Some(success(id, json!({ "tools": tools::definitions() }))),
            "tools/call" => Some(self.call_tool(id, object.get("params")).await),
            other => Some(error_response(
                id,
                METHOD_NOT_FOUND,
                format!("未知方法 / method not found: {other}"),
            )),
        }
    }

    async fn call_tool(&self, id: Value, params: Option<&Value>) -> Value {
        let Some(params) = params.and_then(Value::as_object) else {
            return error_response(
                id,
                INVALID_PARAMS,
                "参数错误 / Invalid params: params must be an object".into(),
            );
        };
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return error_response(
                id,
                INVALID_PARAMS,
                "参数错误 / Invalid params: missing tool name".into(),
            );
        };

        let empty = Map::new();
        let arguments = match params.get("arguments") {
            None | Some(Value::Null) => &empty,
            Some(Value::Object(arguments)) => arguments,
            Some(_) => {
                return error_response(
                    id,
                    INVALID_PARAMS,
                    "参数错误 / Invalid params: arguments must be an object".into(),
                );
            }
        };

        match tools::call(&self.db, name, arguments).await {
            Ok(value) => {
                let text = serde_json::to_string(&value)
                    .expect("serializing a serde_json::Value cannot fail");
                success(
                    id,
                    json!({
                        "content": [{ "type": "text", "text": text }]
                    }),
                )
            }
            Err(CallError::InvalidParams(message)) => error_response(id, INVALID_PARAMS, message),
            // 查询细节（SQL、表名、列名、路径）只进日志，绝不回传给客户端：
            // MCP 客户端可能是第三方模型，错误文本会被原样展示。
            Err(CallError::Internal(error)) => {
                tracing::error!(
                    tool = name,
                    error = %format!("{error:#}"),
                    "MCP 工具执行失败"
                );
                error_response(id, INTERNAL_ERROR, "查询失败 / query failed".into())
            }
        }
    }
}

/// Run the stdio loop until EOF. Logs must go to stderr; stdout is protocol-only.
pub async fn serve_stdio(db: Database) -> anyhow::Result<()> {
    use tokio::io::{AsyncWriteExt, BufReader};

    let mut reader = BufReader::new(tokio::io::stdin());
    let mut stdout = tokio::io::stdout();
    let server = Server::new(db);

    loop {
        let response = match read_limited_line(&mut reader, MAX_LINE_BYTES).await? {
            LineOutcome::Eof => break,
            LineOutcome::TooLong => {
                tracing::warn!(
                    limit = MAX_LINE_BYTES,
                    "MCP stdio 请求行超过上限，已丢弃该行"
                );
                error_response(
                    Value::Null,
                    PARSE_ERROR,
                    format!(
                        "请求行超过 1 MiB（{MAX_LINE_BYTES} 字节）上限 / \
                         request line exceeds the 1 MiB ({MAX_LINE_BYTES}-byte) limit"
                    ),
                )
            }
            LineOutcome::Line(bytes) => {
                let line = String::from_utf8(bytes).map_err(|error| {
                    anyhow::anyhow!("MCP stdio 输入不是合法 UTF-8 / invalid UTF-8 input: {error}")
                })?;
                match server.handle_line(&line).await {
                    Some(response) => response,
                    None => continue,
                }
            }
        };

        let mut payload = serde_json::to_vec(&response)?;
        payload.push(b'\n');
        stdout.write_all(&payload).await?;
        stdout.flush().await?;
    }
    Ok(())
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            "tools": {}
        },
        "serverInfo": {
            "name": SERVER_NAME,
            "version": SERVER_VERSION
        }
    })
}

fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error_response(id: Value, code: i64, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}
