//! MCP tool catalog and dispatch.
//!
//! Every tool is a read-only query; there is no tool that can change panel
//! state, start jobs or send commands. All SQL is in [`crate::db`].

use serde_json::{json, Map, Value};

use crate::db::Database;

/// A tool call failed. Protocol layer maps these to JSON-RPC errors.
#[derive(Debug)]
pub enum CallError {
    /// Bad tool arguments (or an unknown tool name) -> JSON-RPC `-32602`.
    InvalidParams(String),
    /// Database/query failure -> JSON-RPC `-32603`.
    Internal(anyhow::Error),
}

/// The five tools exposed over MCP.
pub fn definitions() -> Vec<Value> {
    vec![
        definition(
            "list_servers",
            "List servers with online state, Xray process state, load, memory, disk and latency. / \
             列出服务器在线状态、Xray 状态、负载、内存、磁盘与延迟。",
            empty_schema(),
        ),
        definition(
            "list_users",
            "List users and their package instances with usage, quota, expiry and computed status. / \
             列出用户与套餐实例的用量、额度、到期时间与计算后的状态。",
            empty_schema(),
        ),
        definition(
            "get_user_traffic",
            "Daily upload/download traffic for one user over the last N days (UTC+8). / \
             查询单个用户最近 N 天的每日上下行流量（UTC+8 自然日）。",
            json!({
                "type": "object",
                "properties": {
                    "username": {
                        "type": "string",
                        "description": "用户名 / Username"
                    },
                    "days": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 90,
                        "default": 7,
                        "description": "最近天数，默认 7 / Number of days, default 7"
                    }
                },
                "required": ["username"],
                "additionalProperties": false
            }),
        ),
        definition(
            "list_chains",
            "List forwarding chains with group/member counts and per-member health. / \
             列出转发链的组数、成员数以及每个成员的监听/目标可达/降级状态。",
            empty_schema(),
        ),
        definition(
            "get_status_summary",
            "Panel summary: online servers, node count, today's and this month's traffic. / \
             面板概览：服务器在线数、节点数、今日与本月流量。",
            empty_schema(),
        ),
    ]
}

/// Dispatch a `tools/call` request.
pub async fn call(
    db: &Database,
    name: &str,
    arguments: &Map<String, Value>,
) -> Result<Value, CallError> {
    match name {
        "list_servers" => db.list_servers().await.map_err(CallError::Internal),
        "list_users" => db.list_users().await.map_err(CallError::Internal),
        "get_user_traffic" => {
            let username = arguments
                .get("username")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|username| !username.is_empty())
                .ok_or_else(|| {
                    CallError::InvalidParams(
                        "缺少必填参数 username / missing required parameter `username`".into(),
                    )
                })?;
            let days = match arguments.get("days") {
                None | Some(Value::Null) => 7,
                Some(value) => value.as_i64().ok_or_else(|| {
                    CallError::InvalidParams(
                        "参数 days 必须是整数 / `days` must be an integer".into(),
                    )
                })?,
            };
            if !(1..=90).contains(&days) {
                return Err(CallError::InvalidParams(
                    "参数 days 必须在 1-90 之间 / `days` must be between 1 and 90".into(),
                ));
            }
            match db.user_traffic(username, days).await {
                Ok(Some(value)) => Ok(value),
                Ok(None) => Err(CallError::InvalidParams(format!(
                    "用户不存在 / unknown username: {username}"
                ))),
                Err(error) => Err(CallError::Internal(error)),
            }
        }
        "list_chains" => db.list_chains().await.map_err(CallError::Internal),
        "get_status_summary" => db.status_summary().await.map_err(CallError::Internal),
        other => {
            let available = definitions()
                .iter()
                .filter_map(|tool| tool["name"].as_str())
                .collect::<Vec<_>>()
                .join(", ");
            Err(CallError::InvalidParams(format!(
                "未知工具 / unknown tool: {other}。可用工具 / available tools: {available}"
            )))
        }
    }
}

fn definition(name: &str, description: &str, input_schema: Value) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": input_schema,
    })
}

fn empty_schema() -> Value {
    json!({ "type": "object", "properties": {} })
}
