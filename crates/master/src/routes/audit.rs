//! 审计日志读取：管理员专用，按 `(created_at, id)` 倒序做稳定游标分页。
//!
//! `detail` 在库里是 JSON 文本，对外直接返回解析后的对象，前端不用二次 parse。
//!
//! 查询参数：
//! - `limit`：1..=500，默认 100；
//! - `before`：上一页返回的 `next_before`（记录 id），也接受 Unix 秒时间戳；
//! - `action`：动作前缀，逗号分隔表示多个前缀（OR）；
//! - `actor` / `target`：操作者用户名 / 目标 id 的子串匹配（`%`、`_` 已转义）。
//!
//! 只传 `limit` 时排第一页、不带任何筛选，与旧行为一致。

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DEFAULT_LIMIT: i64 = 100;
const MAX_LIMIT: i64 = 500;
/// 游标里允许出现的字符：UUID（字母数字 + 连字符）足够，也挡住奇怪的输入。
const MAX_CURSOR_LEN: usize = 64;

#[derive(Deserialize)]
pub struct AuditQuery {
    /// 手写解析成字符串：非法整数也要回中文 400，而不是 axum 的纯文本拒绝。
    pub limit: Option<String>,
    /// 稳定游标：上一页最后一条的 id，或者 Unix 秒时间戳。
    pub before: Option<String>,
    /// 动作前缀；逗号分隔表示多个前缀（OR），如 `settings,password,config.apply`。
    pub action: Option<String>,
    /// 操作者用户名子串。
    pub actor: Option<String>,
    /// 目标 id / 固定名字串。
    pub target: Option<String>,
}

/// 解析后的 `before`：数字是时间戳，其它合法字符串按 id 去库里还原时间戳。
enum RawCursor {
    Timestamp(i64),
    Id(String),
}

fn cursor_invalid() -> AppError {
    AppError::coded("query.cursor_invalid", None, "before 游标无效")
}

fn parse_cursor(raw: &str) -> AppResult<RawCursor> {
    if raw.chars().all(|ch| ch.is_ascii_digit()) {
        return raw
            .parse::<i64>()
            .ok()
            .filter(|ts| *ts > 0)
            .map(RawCursor::Timestamp)
            .ok_or_else(cursor_invalid);
    }
    if raw.len() > MAX_CURSOR_LEN
        || !raw
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err(cursor_invalid());
    }
    Ok(RawCursor::Id(raw.to_string()))
}

/// 逗号分隔的前缀 → 去空去空格后的列表；空串等价于不过滤。
fn action_prefixes(raw: Option<String>) -> Vec<String> {
    raw.map(|raw| {
        raw.split(',')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}

/// 文本筛选：首尾空白去掉，空串等价于不过滤。
fn text_filter(raw: Option<String>) -> Option<String> {
    raw.map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<AuditQuery>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let limit = match query.limit.as_deref() {
        None => DEFAULT_LIMIT,
        Some(raw) => raw.parse::<i64>().map_err(|_| {
            AppError::coded(
                "query.limit_invalid",
                Some(json!({ "max": MAX_LIMIT })),
                "limit 必须是整数",
            )
        })?,
    };
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(AppError::coded(
            "query.limit_out_of_range",
            Some(json!({ "min": 1, "max": MAX_LIMIT })),
            format!("limit 必须在 1-{MAX_LIMIT} 之间"),
        ));
    }

    let before = match query
        .before
        .as_deref()
        .map(str::trim)
        .filter(|raw| !raw.is_empty())
    {
        None => None,
        Some(raw) => Some(match parse_cursor(raw)? {
            RawCursor::Timestamp(created_at) => repo::audit::Cursor {
                created_at,
                id: None,
            },
            RawCursor::Id(id) => {
                let created_at = repo::audit::find_created_at(&state.db.pool, &id)
                    .await?
                    .ok_or_else(cursor_invalid)?;
                repo::audit::Cursor {
                    created_at,
                    id: Some(id),
                }
            }
        }),
    };

    let filter = repo::audit::Filter {
        action_prefixes: action_prefixes(query.action),
        actor: text_filter(query.actor),
        target: text_filter(query.target),
    };
    let page = repo::audit::page(&state.db.pool, &filter, before.as_ref(), limit).await?;
    Ok(Json(
        json!({ "items": page.items, "next_before": page.next_before }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::repo::nodes::{self, NewNode};
    use pierwave_domain::repo::users::{self, NewUser};
    use pierwave_domain::Db;

    async fn setup() -> (Router, AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = users::create(
            &db.pool,
            NewUser {
                username: "admin".into(),
                password: "devpass".into(),
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
        )
    }

    async fn request(
        app: &Router,
        cookie: Option<&str>,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let body = match body {
            Some(body) => {
                builder = builder.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, value)
    }

    async fn audit_items(app: &Router, admin: &str) -> Vec<Value> {
        let (status, body) = request(app, Some(admin), Method::GET, "/api/v1/audit", None).await;
        assert_eq!(status, StatusCode::OK, "读审计失败：{body}");
        body["items"].as_array().unwrap().clone()
    }

    fn find_action<'a>(items: &'a [Value], action: &str) -> &'a Value {
        items
            .iter()
            .find(|item| item["action"] == action)
            .unwrap_or_else(|| panic!("没有 {action} 记录：{items:?}"))
    }

    /// 按原始查询串读审计；`query` 为空表示不带任何参数。
    async fn get_audit(app: &Router, admin: &str, query: &str) -> (StatusCode, Value) {
        let uri = if query.is_empty() {
            "/api/v1/audit".to_string()
        } else {
            format!("/api/v1/audit?{query}")
        };
        request(app, Some(admin), Method::GET, &uri, None).await
    }

    /// 绕过 HTTP 直接落一条审计，便于在测试里造任意数量的数据。
    async fn insert_audit(
        state: &AppState,
        actor_id: Option<&str>,
        action: &str,
        target: Option<&str>,
    ) {
        repo::audit::record(
            &state.db.pool,
            actor_id,
            action,
            target,
            &json!({ "seed": action }),
        )
        .await
        .unwrap();
    }

    async fn list_actions(app: &Router, admin: &str, query: &str) -> Vec<String> {
        let (status, body) = get_audit(app, admin, query).await;
        assert_eq!(status, StatusCode::OK, "query={query}: {body}");
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["action"].as_str().unwrap().to_string())
            .collect()
    }

    async fn list_targets(app: &Router, admin: &str, query: &str) -> Vec<String> {
        let (status, body) = get_audit(app, admin, query).await;
        assert_eq!(status, StatusCode::OK, "query={query}: {body}");
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["target"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[tokio::test]
    async fn user_create_is_audited_with_actor_name() {
        let (app, _state, admin) = setup().await;

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/users",
            Some(json!({"username": "alice", "password": "password123"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let alice_id = body["user"]["id"].as_str().unwrap();

        let items = audit_items(&app, &admin).await;
        let entry = find_action(&items, "user.create");
        assert_eq!(entry["target"], alice_id);
        assert_eq!(entry["actor_name"], "admin");
        assert_eq!(entry["detail"]["username"], "alice");
        assert_eq!(entry["detail"]["role"], "user");
        assert!(
            entry["detail"].get("password").is_none(),
            "detail 不能出现密码"
        );
    }

    #[tokio::test]
    async fn package_scope_change_is_recorded_in_detail() {
        let (app, state, admin) = setup().await;

        // 两个节点：套餐范围只能引用真实存在的节点。
        let (server, _token) = repo::servers::create(&state.db.pool, "s1", "10.0.0.1", "external")
            .await
            .unwrap();
        let mut node_ids = Vec::new();
        for (tag, port) in [("n1", 10001), ("n2", 10002)] {
            let node = nodes::create(
                &state.db.pool,
                &server.id,
                NewNode {
                    tag: Some(tag.into()),
                    name: tag.into(),
                    protocol: "trojan".into(),
                    transport: "tcp".into(),
                    security: "none".into(),
                    port,
                    public_port: None,
                    config_json: "{}".into(),
                    enabled: true,
                    cert_id: None,
                    bandwidth_kbps: None,
                },
            )
            .await
            .unwrap();
            node_ids.push(node.id);
        }

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/packages",
            Some(json!({"name": "月卡", "quota_bytes": 1000})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let package_id = body["package"]["id"].as_str().unwrap().to_string();
        assert_eq!(body["package"]["node_scope"], "all");

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/packages/{package_id}"),
            Some(json!({"node_ids": node_ids})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["package"]["node_scope"], "custom");

        let items = audit_items(&app, &admin).await;
        let entry = find_action(&items, "package.update");
        assert_eq!(entry["target"], package_id);
        let scope = &entry["detail"]["node_scope"];
        assert_eq!(scope["from"], "all", "detail: {entry}");
        assert_eq!(scope["to"], "custom", "detail: {entry}");
        assert_eq!(entry["detail"]["node_count"]["to"], 2);
    }

    #[tokio::test]
    async fn server_delete_is_audited() {
        let (app, _state, admin) = setup().await;

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/servers",
            Some(json!({"name": "待删服务器", "address": "10.0.0.9"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let server_id = body["server"]["id"].as_str().unwrap().to_string();

        let (status, _) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/servers/{server_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let items = audit_items(&app, &admin).await;
        let entry = find_action(&items, "server.delete");
        assert_eq!(entry["target"], server_id);
        assert_eq!(entry["detail"]["name"], "待删服务器");
    }

    #[tokio::test]
    async fn audit_endpoint_guards_limit_and_order() {
        let (app, state, admin) = setup().await;

        // 普通用户 → 403。
        let bob = users::create(
            &state.db.pool,
            NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&state.db.pool, &bob.id, 3600, None)
            .await
            .unwrap();
        let bob_cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);
        let (status, body) =
            request(&app, Some(&bob_cookie), Method::GET, "/api/v1/audit", None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");

        // 未登录 → 401。
        let (status, _) = request(&app, None, Method::GET, "/api/v1/audit", None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        // limit 越界 / 非整数 → 400 + 中文。
        for raw in ["0", "501", "-1", "abc"] {
            let (status, body) = request(
                &app,
                Some(&admin),
                Method::GET,
                &format!("/api/v1/audit?limit={raw}"),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "limit={raw}");
            let error = body["error"].as_str().unwrap();
            assert!(!error.is_empty(), "limit={raw}");
            assert!(error.contains("limit"), "错误信息应说明 limit：{error}");
        }

        // 边界值 1 / 500 可用。
        for raw in ["1", "500"] {
            let (status, _) = request(
                &app,
                Some(&admin),
                Method::GET,
                &format!("/api/v1/audit?limit={raw}"),
                None,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "limit={raw}");
        }

        // 连续三次写操作：最新一条排在最前，整体时间戳非递增。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::POST,
            "/api/v1/users",
            Some(json!({"username": "charlie", "password": "password123"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let charlie_id = body["user"]["id"].as_str().unwrap().to_string();
        let (status, _) = request(
            &app,
            Some(&admin),
            Method::PATCH,
            &format!("/api/v1/users/{charlie_id}"),
            Some(json!({"status": "disabled"})),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = request(
            &app,
            Some(&admin),
            Method::DELETE,
            &format!("/api/v1/users/{charlie_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        let items = audit_items(&app, &admin).await;
        assert_eq!(items[0]["action"], "user.delete", "最新记录应在最前");
        assert!(items.len() >= 3);
        let timestamps: Vec<i64> = items
            .iter()
            .map(|item| item["created_at"].as_i64().unwrap())
            .collect();
        assert!(
            timestamps.windows(2).all(|pair| pair[0] >= pair[1]),
            "created_at 应按时间倒序：{timestamps:?}"
        );
    }

    /// 30 条、每页 10 条：三页并集等于全集且无重复，最后一页 `next_before` 为 null。
    #[tokio::test]
    async fn cursor_pagination_covers_all_rows_exactly_once() {
        let (app, state, admin) = setup().await;
        for index in 0..30 {
            insert_audit(
                &state,
                None,
                "user.create",
                Some(&format!("target-{index:02}")),
            )
            .await;
        }

        // 一次取完作为基准；分页结果必须与它逐条一致。
        let (status, body) = get_audit(&app, &admin, "limit=500").await;
        assert_eq!(status, StatusCode::OK);
        let all: Vec<String> = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(all.len(), 30);

        let mut collected: Vec<String> = Vec::new();
        let mut before: Option<String> = None;
        let mut page = 0;
        loop {
            let query = match &before {
                Some(before) => format!("limit=10&before={before}"),
                None => "limit=10".to_string(),
            };
            let (status, body) = get_audit(&app, &admin, &query).await;
            assert_eq!(status, StatusCode::OK, "page {page}: {body}");
            let items = body["items"].as_array().unwrap();
            assert_eq!(items.len(), 10, "page {page} 应有 10 条");
            collected.extend(
                items
                    .iter()
                    .map(|item| item["id"].as_str().unwrap().to_string()),
            );
            page += 1;
            match body["next_before"].as_str() {
                Some(next) => before = Some(next.to_string()),
                None => break,
            }
            assert!(page < 10, "翻页没有终止");
        }

        assert_eq!(page, 3, "30 条每页 10 条应正好翻 3 页");
        assert_eq!(collected, all, "三页并集必须等于全集且顺序一致（不重不漏）");
        let unique: std::collections::HashSet<&String> = collected.iter().collect();
        assert_eq!(unique.len(), 30, "分页结果不能有重复");
    }

    /// `action` 是前缀匹配；逗号分隔的多个前缀按 OR 合并（前端「系统」分类用）。
    #[tokio::test]
    async fn action_filter_matches_prefixes_and_comma_lists() {
        let (app, state, admin) = setup().await;
        for action in [
            "user.create",
            "user.update",
            "user_package.bind",
            "package.create",
            "settings.update",
            "password.change",
            "config.apply",
            "server.create",
        ] {
            insert_audit(&state, None, action, None).await;
        }

        let mut user_dot = list_actions(&app, &admin, "action=user.").await;
        user_dot.sort();
        assert_eq!(
            user_dot,
            ["user.create", "user.update"],
            "user. 只应命中 user.*，不能命中 user_package.*"
        );

        let mut user_prefix = list_actions(&app, &admin, "action=user").await;
        user_prefix.sort();
        assert_eq!(
            user_prefix,
            ["user.create", "user.update", "user_package.bind"],
            "user 前缀应同时命中 user_package.*"
        );

        let mut system = list_actions(&app, &admin, "action=settings,password,config.apply").await;
        system.sort();
        assert_eq!(
            system,
            ["config.apply", "password.change", "settings.update"],
            "逗号分隔的多个前缀应按 OR 生效"
        );

        assert!(
            list_actions(&app, &admin, "action=nope").await.is_empty(),
            "不匹配的前缀应返回空列表"
        );
    }

    /// `actor` / `target` 是服务端子串匹配；`%`、`_` 必须按字面量处理。
    #[tokio::test]
    async fn actor_and_target_filters_are_escaped_substrings() {
        let (app, state, admin) = setup().await;
        let admin_id = users::find_by_username(&state.db.pool, "admin")
            .await
            .unwrap()
            .expect("setup 已创建 admin")
            .id;
        let bob = users::create(
            &state.db.pool,
            NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();

        insert_audit(&state, Some(&admin_id), "user.create", Some("alpha-42")).await;
        insert_audit(&state, Some(&bob.id), "user.update", Some("beta-42")).await;
        insert_audit(&state, Some(&admin_id), "user.delete", Some("100%_done")).await;
        insert_audit(&state, Some(&admin_id), "user.delete", Some("axb")).await;
        insert_audit(&state, Some(&admin_id), "user.delete", Some("a_b")).await;

        let mut by_actor = list_targets(&app, &admin, "actor=adm").await;
        by_actor.sort();
        assert_eq!(
            by_actor,
            ["100%_done", "a_b", "alpha-42", "axb"],
            "actor 应匹配用户名子串"
        );

        assert_eq!(
            list_targets(&app, &admin, "actor=bo").await,
            ["beta-42"],
            "actor 子串应命中 bob"
        );

        let mut target_42 = list_targets(&app, &admin, "target=42").await;
        target_42.sort();
        assert_eq!(target_42, ["alpha-42", "beta-42"]);

        assert_eq!(
            list_targets(&app, &admin, "target=%25").await,
            ["100%_done"],
            "% 必须转义，否则会命中全部记录"
        );
        assert_eq!(
            {
                let mut hits = list_targets(&app, &admin, "target=_").await;
                hits.sort();
                hits
            },
            ["100%_done", "a_b"],
            "_ 必须转义，不能当成单字符通配符（这两条都含字面量下划线，axb 不含）"
        );

        // 两个条件同时给出时是 AND：admin 的 alpha-42 命中，bob 的 beta-42 不命中。
        assert_eq!(
            list_targets(&app, &admin, "actor=adm&target=42").await,
            ["alpha-42"]
        );
    }

    /// 非法游标 → 400 + 稳定错误码；合法 id / 时间戳游标 → 200。
    #[tokio::test]
    async fn invalid_cursor_returns_coded_bad_request() {
        let (app, state, admin) = setup().await;
        insert_audit(&state, None, "user.create", Some("cursor-target")).await;
        insert_audit(&state, None, "user.update", Some("cursor-target-2")).await;

        let overlong = "a".repeat(MAX_CURSOR_LEN + 1);
        let cases = [
            "before=not-a-cursor".to_string(),
            "before=00000000-0000-0000-0000-000000000000".to_string(),
            "before=-1".to_string(),
            "before=0".to_string(),
            "before=bad%20cursor".to_string(),
            format!("before={overlong}"),
        ];
        for query in cases {
            let (status, body) = get_audit(&app, &admin, &query).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "query={query}: {body}");
            assert_eq!(
                body["code"], "query.cursor_invalid",
                "query={query} 应返回稳定错误码"
            );
            assert!(
                body["error"].as_str().is_some_and(|text| !text.is_empty()),
                "query={query} 应带中文兜底文案"
            );
        }

        // 合法游标：上一页的 next_before（id）。
        let (status, body) = get_audit(&app, &admin, "limit=1").await;
        assert_eq!(status, StatusCode::OK);
        let next = body["next_before"].as_str().unwrap();
        let (status, body) = get_audit(&app, &admin, &format!("before={next}")).await;
        assert_eq!(status, StatusCode::OK, "合法 id 游标应可用：{body}");

        // 合法游标：Unix 秒时间戳（`1` 早于所有数据，结果为空但仍 200）。
        let (status, body) = get_audit(&app, &admin, "before=1").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["items"].as_array().unwrap().is_empty());
        assert!(body["next_before"].is_null());
    }

    /// 只传 `limit` 时保持旧行为：取最新 N 条、新的在前，并额外给出翻页游标。
    #[tokio::test]
    async fn limit_only_keeps_legacy_newest_first_behaviour() {
        let (app, state, admin) = setup().await;
        for action in ["user.create", "user.update", "user.delete"] {
            insert_audit(&state, None, action, None).await;
        }

        let (status, body) = get_audit(&app, &admin, "limit=2").await;
        assert_eq!(status, StatusCode::OK);
        let actions: Vec<&str> = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["action"].as_str().unwrap())
            .collect();
        assert_eq!(
            actions,
            ["user.delete", "user.update"],
            "只传 limit 时仍取最新 N 条"
        );
        assert!(body["next_before"].is_string(), "还有更早记录时应返回游标");

        let (status, body) = get_audit(&app, &admin, "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["items"].as_array().unwrap().len(), 3);
        assert!(body["next_before"].is_null(), "全部取完时游标为 null");
    }
}
