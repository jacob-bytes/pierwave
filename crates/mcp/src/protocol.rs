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
            Err(CallError::Internal(error)) => error_response(
                id,
                INTERNAL_ERROR,
                format!("内部错误 / internal error: {error:#}"),
            ),
        }
    }
}

/// Run the stdio loop until EOF. Logs must go to stderr; stdout is protocol-only.
pub async fn serve_stdio(db: Database) -> anyhow::Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let mut reader = BufReader::new(tokio::io::stdin());
    let mut stdout = tokio::io::stdout();
    let server = Server::new(db);
    let mut line = String::new();

    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            break;
        }
        if let Some(response) = server.handle_line(&line).await {
            let mut payload = serde_json::to_vec(&response)?;
            payload.push(b'\n');
            stdout.write_all(&payload).await?;
            stdout.flush().await?;
        }
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
