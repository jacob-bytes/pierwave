//! MCP Streamable HTTP 入口：`POST /mcp`。
//!
//! 传输层只做三件事：认证（API Token，**必须是 admin scope**）、把 JSON-RPC
//! 消息交给 `pierwave-mcp` 的同一套工具实现、把结果按 JSON-RPC 形状返回。
//! 认证/限流的错误也是 JSON-RPC error（不是 HTML/纯文本），客户端可以按
//! JSON-RPC 统一处理。
//!
//! 工具实现复用 `crates/mcp/src/tools.rs`：这里只把主控现有的
//! `SqlitePool` 包成 `pierwave_mcp::Database`，**不在 master 里写任何 SQL**。

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use pierwave_mcp::protocol::PARSE_ERROR;
use pierwave_mcp::{Database, Server};

use crate::auth::{authenticate_api_token, bearer_token, ApiTokenAuthError};
use crate::state::AppState;

/// 实现自定义的 JSON-RPC 服务端错误码（-32000..=-32099 保留给实现）。
pub const UNAUTHORIZED: i64 = -32001;
pub const FORBIDDEN: i64 = -32003;
pub const RATE_LIMITED: i64 = -32004;
pub const METHOD_NOT_ALLOWED: i64 = -32005;

/// `POST /mcp`：单条 JSON-RPC 消息（initialize / tools/list / tools/call / ping）。
///
/// 通知没有 `id`，按 MCP 规范返回 202 + 空 body；请求返回 200 + JSON。
/// 无状态实现：不返回 `Mcp-Session-Id`，也不要求握手顺序。
pub async fn http(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Option<axum::extract::Extension<axum::extract::ConnectInfo<std::net::SocketAddr>>>,
    body: Bytes,
) -> Response {
    // 先解析一次只为拿到 id：认证失败时也要把同一个 id 带回 JSON-RPC error。
    let parsed = serde_json::from_slice::<Value>(&body);
    let id = parsed
        .as_ref()
        .ok()
        .and_then(|value| value.get("id").cloned())
        .unwrap_or(Value::Null);

    let Some(raw) = bearer_token(&headers) else {
        return error_response(
            StatusCode::UNAUTHORIZED,
            id,
            UNAUTHORIZED,
            "缺少 API Token / missing API token",
        );
    };
    if !raw.starts_with(pierwave_domain::repo::api_tokens::PREFIX) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            id,
            UNAUTHORIZED,
            "API Token 格式无效 / invalid API token format",
        );
    }

    // 与 REST 共用同一张「按 IP 的认证失败」表：`/mcp` 也是 Bearer 入口，
    // 不能成为绕过 IP 限流猜 token 的后门。生产有 ConnectInfo，测试里没有时按 XFF 取。
    //
    // T2：先做 token 校验。有效 Bearer 永远不被 IP 锁连坐，只有失败的认证
    // 尝试才吃 429（且不会继续累加、延长锁期）。
    let ip_key = crate::routes::auth::client_ip_with_peer(
        &headers,
        peer.map(|axum::extract::Extension(axum::extract::ConnectInfo(addr))| addr.ip()),
    )
    .map(|addr| addr.throttle_key());
    let existing_lock = ip_key
        .as_deref()
        .and_then(|key| state.ip_throttle.check(key).err());

    let principal = match authenticate_api_token(&state, raw).await {
        Ok(principal) => {
            // 成功认证清零该 IP 的失败计数。
            if let Some(key) = ip_key.as_deref() {
                state.ip_throttle.clear(key);
            }
            principal
        }
        Err(ApiTokenAuthError::Unauthorized) => {
            if let Some(retry_after) = existing_lock {
                let mut response = error_response(
                    StatusCode::TOO_MANY_REQUESTS,
                    id,
                    RATE_LIMITED,
                    "该 IP 认证失败次数过多，请稍后再试 / too many failed authentication attempts from this IP; try again later",
                );
                if let Ok(value) = axum::http::HeaderValue::from_str(&retry_after.to_string()) {
                    response
                        .headers_mut()
                        .insert(axum::http::header::RETRY_AFTER, value);
                }
                return response;
            }
            if let Some(key) = ip_key.as_deref() {
                state.ip_throttle.record_failure(key);
            }
            return error_response(
                StatusCode::UNAUTHORIZED,
                id,
                UNAUTHORIZED,
                "API Token 无效、已过期或已吊销 / invalid, expired or revoked API token",
            );
        }
        Err(ApiTokenAuthError::RateLimited(retry_after)) => {
            let mut response = error_response(
                StatusCode::TOO_MANY_REQUESTS,
                id,
                RATE_LIMITED,
                "API Token 请求过于频繁 / API token rate limit exceeded",
            );
            if let Ok(value) = axum::http::HeaderValue::from_str(&retry_after.to_string()) {
                response
                    .headers_mut()
                    .insert(axum::http::header::RETRY_AFTER, value);
            }
            return response;
        }
        Err(ApiTokenAuthError::Internal(error)) => {
            tracing::error!(error = %error, "MCP API Token 认证失败");
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                id,
                pierwave_mcp::protocol::INTERNAL_ERROR,
                "内部错误 / internal error",
            );
        }
    };

    // MCP 一律要求 admin：这 5 个工具虽然只读，但返回服务器地址、用户清单与
    // 链拓扑，和 REST 的敏感 GET 是同一份数据。read scope 只能走 REST 的
    // 非敏感 GET，否则 `/mcp` 就成了绕过敏感名单的后门。
    // scope 被手工改坏的 token 也按同一规则拒绝（不放宽到「猜它能读什么」）。
    if principal.scope != pierwave_domain::repo::api_tokens::SCOPE_ADMIN {
        return error_response_coded(
            StatusCode::FORBIDDEN,
            id,
            FORBIDDEN,
            Some("api_token.mcp_requires_admin"),
            "MCP 需要 admin scope 的 API Token（read scope 只能走 REST 的非敏感 GET） / MCP requires an admin-scoped API token (read scope is limited to non-sensitive REST GETs)",
        );
    }

    let message = match parsed {
        Ok(message) => message,
        Err(error) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                Value::Null,
                PARSE_ERROR,
                format!("解析错误 / Parse error: {error}"),
            );
        }
    };

    // 复用 stdio 服务端：工具目录、参数校验、错误码与结果形状完全一致。
    let server = Server::new(Database::from_pool(state.db.pool.clone()));
    match server.handle_message(message).await {
        // 通知（无 id）不产生 JSON-RPC 响应；Streamable HTTP 用 202 确认。
        None => StatusCode::ACCEPTED.into_response(),
        Some(response) => (StatusCode::OK, Json(response)).into_response(),
    }
}

/// `GET /mcp` / `DELETE /mcp`：本实现不提供服务端推送流与显式会话删除。
pub async fn method_not_allowed() -> Response {
    error_response(
        StatusCode::METHOD_NOT_ALLOWED,
        Value::Null,
        METHOD_NOT_ALLOWED,
        "只支持 POST /mcp / only POST is supported on /mcp",
    )
}

fn error_response(
    status: StatusCode,
    id: Value,
    code: i64,
    message: impl Into<String>,
) -> Response {
    error_response_coded(status, id, code, None, message)
}

/// 与 [`error_response`] 相同，额外在 `error.data.code` 里带稳定的应用错误码，
/// 客户端不必解析双语 message 才能区分「read scope 被拒」与其它 403。
fn error_response_coded(
    status: StatusCode,
    id: Value,
    code: i64,
    app_code: Option<&str>,
    message: impl Into<String>,
) -> Response {
    let mut error = json!({ "code": code, "message": message.into() });
    if let Some(app_code) = app_code {
        error["data"] = json!({ "code": app_code });
    }
    (
        status,
        Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": error
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::Request;
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::repo;
    use pierwave_domain::Db;

    async fn setup() -> (Router, AppState) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (app, state)
    }

    async fn token(state: &AppState, scope: &str) -> String {
        repo::api_tokens::create(&state.db.pool, "mcp-test", scope, None)
            .await
            .unwrap()
            .1
    }

    async fn post(app: &Router, bearer: Option<&str>, body: Value) -> (StatusCode, String, Value) {
        post_from(app, bearer, body, None).await
    }

    async fn post_from(
        app: &Router,
        bearer: Option<&str>,
        body: Value,
        xff: Option<&str>,
    ) -> (StatusCode, String, Value) {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/mcp")
            .header("content-type", "application/json");
        if let Some(token) = bearer {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        if let Some(ip) = xff {
            builder = builder.header("x-forwarded-for", ip);
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let text = String::from_utf8_lossy(&bytes).to_string();
        let value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or(Value::Null)
        };
        (status, text, value)
    }

    #[tokio::test]
    async fn initialize_and_tools_list_have_the_jsonrpc_shape() {
        let (app, state) = setup().await;
        let token = token(&state, "admin").await;

        let (status, _text, body) = post(
            &app,
            Some(&token),
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["jsonrpc"], "2.0");
        assert_eq!(body["id"], 1);
        assert_eq!(body["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(body["result"]["serverInfo"]["name"], "pierwave-mcp");
        assert_eq!(
            body["result"]["capabilities"]["tools"],
            json!({}),
            "只注册 tools 能力"
        );

        let (status, _text, body) = post(
            &app,
            Some(&token),
            json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let tools = body["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "list_servers",
                "list_users",
                "get_user_traffic",
                "list_chains",
                "get_status_summary"
            ],
            "只暴露 5 个只读工具，顺序稳定"
        );
        // schema 必须与真实参数一致：get_user_traffic 必填 username，days 为 1–90。
        let traffic = tools
            .iter()
            .find(|tool| tool["name"] == "get_user_traffic")
            .unwrap();
        assert_eq!(traffic["inputSchema"]["type"], "object");
        assert_eq!(traffic["inputSchema"]["required"], json!(["username"]));
        assert_eq!(traffic["inputSchema"]["properties"]["days"]["minimum"], 1);
        assert_eq!(traffic["inputSchema"]["properties"]["days"]["maximum"], 90);
        assert_eq!(traffic["inputSchema"]["additionalProperties"], false);
        for tool in tools {
            assert_eq!(tool["inputSchema"]["type"], "object", "{tool}");
            // 不允许出现任何写工具名。
            let name = tool["name"].as_str().unwrap();
            assert!(
                name.starts_with("list_") || name.starts_with("get_"),
                "只读工具命名应可辨认：{name}"
            );
        }
    }

    #[tokio::test]
    async fn tools_call_runs_the_shared_read_only_implementation() {
        let (app, state) = setup().await;
        let token = token(&state, "admin").await;

        let (status, _text, body) = post(
            &app,
            Some(&token),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": { "name": "list_servers", "arguments": {} }
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["jsonrpc"], "2.0");
        assert_eq!(body["id"], 3);
        let content = body["result"]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "text");
        let payload: Value = serde_json::from_str(content[0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(payload, json!({ "servers": [] }));

        // 缺少必填参数 → -32602，而不是 200 空结果。
        let (status, _text, body) = post(
            &app,
            Some(&token),
            json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": { "name": "get_user_traffic", "arguments": {} }
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["error"]["code"], -32602);

        // 未知工具 → -32602，并列出可用工具。
        let (status, _text, body) = post(
            &app,
            Some(&token),
            json!({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": { "name": "delete_everything", "arguments": {} }
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["error"]["code"], -32602);
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("list_servers"));
    }

    /// read scope 不能走 `/mcp`：MCP 工具返回服务器地址/用户清单/链拓扑，
    /// 与 REST 的敏感 GET 同名同级。错误必须是 JSON-RPC，并带稳定应用码。
    #[tokio::test]
    async fn read_scope_is_rejected_with_the_mcp_requires_admin_code() {
        let (app, state) = setup().await;
        let read = token(&state, "read").await;

        let (status, text, body) = post(
            &app,
            Some(&read),
            json!({"jsonrpc": "2.0", "id": 11, "method": "initialize", "params": {}}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!text.trim_start().starts_with('<'), "不能返回 HTML：{text}");
        assert_eq!(body["jsonrpc"], "2.0");
        assert_eq!(body["id"], 11);
        assert_eq!(body["error"]["code"], super::FORBIDDEN);
        assert_eq!(
            body["error"]["data"]["code"],
            "api_token.mcp_requires_admin"
        );
        assert!(
            body["error"]["message"].as_str().unwrap().contains(" / "),
            "{body}"
        );

        // tools/call 同样在传输层拒绝，绝不执行敏感工具。
        let (status, _text, body) = post(
            &app,
            Some(&read),
            json!({
                "jsonrpc": "2.0",
                "id": 12,
                "method": "tools/call",
                "params": { "name": "list_servers", "arguments": {} }
            }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            body["error"]["data"]["code"],
            "api_token.mcp_requires_admin"
        );
    }

    #[tokio::test]
    async fn missing_or_insufficient_token_returns_jsonrpc_errors_not_html() {
        let (app, state) = setup().await;
        let body = json!({"jsonrpc": "2.0", "id": 7, "method": "initialize"});

        let (status, text, body) = post(&app, None, body.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!text.trim_start().starts_with('<'), "不能返回 HTML：{text}");
        assert_eq!(body["jsonrpc"], "2.0");
        assert_eq!(body["id"], 7);
        assert_eq!(body["error"]["code"], super::UNAUTHORIZED);
        assert!(body["error"]["message"].as_str().unwrap().contains(" / "));

        // scope 被手工改成未知值：认证成功但 scope 不足 → 403 JSON-RPC。
        let weird = token(&state, "write").await;
        let (status, text, body) = post(&app, Some(&weird), body).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(!text.contains("<html"), "{text}");
        assert_eq!(body["error"]["code"], super::FORBIDDEN);
    }

    /// `/mcp` 与 REST 共用 IP 失败表：猜 token 到阈值后返回 JSON-RPC 形状的 429；
    /// 但合法 token 不被 IP 锁连坐（T2），且成功认证清零该 IP 的计数。
    #[tokio::test]
    async fn repeated_invalid_tokens_lock_the_ip_on_mcp() {
        let (app, state) = setup().await;
        let ip = "203.0.113.90";
        let admin_token = token(&state, "admin").await;
        let body = json!({"jsonrpc": "2.0", "id": 9, "method": "ping"});

        for _ in 0..crate::throttle::IP_MAX_FAILURES {
            let (status, _, parsed) =
                post_from(&app, Some("pwt_invalid-token"), body.clone(), Some(ip)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            assert_eq!(parsed["error"]["code"], super::UNAUTHORIZED);
        }

        let (status, text, parsed) =
            post_from(&app, Some("pwt_invalid-token"), body.clone(), Some(ip)).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert!(!text.trim_start().starts_with('<'), "不能返回 HTML：{text}");
        assert_eq!(parsed["error"]["code"], super::RATE_LIMITED);

        // 合法 token：即使该 IP 已被别人打到锁定，也必须正常返回。
        let (status, _, parsed) = post_from(&app, Some(&admin_token), body.clone(), Some(ip)).await;
        assert_eq!(status, StatusCode::OK, "合法 Bearer 不能被 IP 锁连坐");
        assert_eq!(parsed["id"], 9);

        // 成功认证清零后，坏 token 回到普通的 401。
        let (status, _, parsed) = post_from(&app, Some("pwt_invalid-token"), body, Some(ip)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(parsed["error"]["code"], super::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn notifications_are_acknowledged_with_202_and_get_is_method_not_allowed() {
        let (app, state) = setup().await;
        let token = token(&state, "admin").await;

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/mcp")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], super::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn malformed_json_returns_parse_error_in_jsonrpc_shape() {
        let (app, state) = setup().await;
        let token = token(&state, "admin").await;
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/mcp")
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from("{not json"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["jsonrpc"], "2.0");
        assert_eq!(body["id"], Value::Null);
        assert_eq!(body["error"]["code"], pierwave_mcp::protocol::PARSE_ERROR);
    }
}
