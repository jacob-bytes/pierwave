//! 概览聚合：`GET /api/v1/overview?days=7`（管理员）。
//!
//! 一个请求替代概览页原来并行的 4 个请求（KPI / 趋势 / 节点 / 链路），
//! 避免每块卡片各自 loading。SQL 全在 `pierwave_domain::repo::overview`；
//! 这里只做 `days` 解析与把仓储结果序列化成 JSON。
//!
//! 与旧接口的差异：`days` 非法（非整数或不在 1..=90）一律 400，错误码沿用
//! `query.*` 风格，而不是像 `/stats/traffic` 那样夹到边界。

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DEFAULT_DAYS: i64 = 7;
const MAX_DAYS: i64 = 90;

#[derive(Deserialize)]
pub struct OverviewQuery {
    /// 天数；缺省 7，给值必须落在 1..=90。
    pub days: Option<String>,
}

pub async fn overview(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<OverviewQuery>,
) -> AppResult<Json<repo::overview::OverviewSnapshot>> {
    user.require_admin()?;
    let days = parse_days(query.days.as_deref())?;
    let snapshot = repo::overview::snapshot(&state.db.pool, repo::now(), days).await?;
    Ok(Json(snapshot))
}

fn parse_days(raw: Option<&str>) -> AppResult<i64> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_DAYS);
    };
    let days = raw.trim().parse::<i64>().map_err(|_| days_invalid())?;
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(days_invalid());
    }
    Ok(days)
}

fn days_invalid() -> AppError {
    AppError::coded(
        "query.days_invalid",
        Some(json!({ "min": 1, "max": MAX_DAYS })),
        format!("days 必须是 1-{MAX_DAYS} 的整数"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use pierwave_domain::repo::{nodes, servers, sessions, traffic, users};
    use pierwave_domain::time;
    use pierwave_domain::Db;

    use crate::state::AppState;

    async fn setup() -> (Router, AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = users::create(
            &db.pool,
            users::NewUser {
                username: "admin".into(),
                password: "devpass".into(),
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = sessions::create(&db.pool, &admin.id, 3600, None)
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

    async fn request(app: &Router, cookie: Option<&str>, uri: &str) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
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

    async fn add_node(pool: &sqlx::SqlitePool, server_id: &str, tag: &str, protocol: &str) {
        nodes::create(
            pool,
            server_id,
            nodes::NewNode {
                tag: Some(tag.into()),
                name: tag.into(),
                protocol: protocol.into(),
                transport: "tcp".into(),
                security: "none".into(),
                port: 443,
                config_json: "{}".into(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn overview_returns_the_full_contract_in_one_response() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;

        let (server, _) = servers::create(pool, "香港-01", "10.0.0.1", "external")
            .await
            .unwrap();
        servers::mark_online(pool, &server.id).await.unwrap();
        add_node(pool, &server.id, "hk-vless", "vless").await;
        add_node(pool, &server.id, "hk-trojan", "trojan").await;

        let owner = users::find_by_username(pool, "admin")
            .await
            .unwrap()
            .unwrap();
        let today = time::business_date(repo::now());
        traffic::accumulate_daily(
            pool,
            &today,
            &server.id,
            &format!("{}@hk-vless", owner.id),
            1,
            2,
            3,
        )
        .await
        .unwrap();
        // 已删除节点的流量：归入 unknown。
        traffic::accumulate_daily(pool, &today, &server.id, "ghost@deleted", 5, 5, 10)
            .await
            .unwrap();

        let (status, body) = request(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");

        // 顶层字段名就是前端契约，不能改。
        let mut keys: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["chains", "kpi", "protocols", "series", "top"]);

        assert_eq!(body["kpi"]["servers_online"], 1);
        assert_eq!(body["kpi"]["servers_total"], 1);
        assert_eq!(body["kpi"]["nodes"], 2);
        assert_eq!(
            body["kpi"]["traffic_today"], 13,
            "KPI 用 weighted，含已删节点那 10"
        );
        assert_eq!(body["kpi"]["traffic_month"], 13);
        assert_eq!(body["kpi"]["uptime_24h"], 0.0, "没有采样时为 0");

        assert_eq!(body["series"].as_array().unwrap().len(), 7);
        let last = body["series"].as_array().unwrap().last().unwrap();
        assert_eq!(last["day"], today);
        assert_eq!(last["uplink"], 6);
        assert_eq!(last["downlink"], 7);
        assert!(
            last.get("weighted").is_none(),
            "契约里 series 没有 weighted"
        );

        let protocols = body["protocols"].as_array().unwrap();
        assert_eq!(protocols.len(), 3);
        assert_eq!(protocols[0]["protocol"], "unknown");
        assert_eq!(protocols[0]["nodes"], 0);
        assert_eq!(protocols[0]["traffic_7d"], 10);
        assert_eq!(protocols[1]["protocol"], "vless");
        assert_eq!(protocols[1]["nodes"], 1);
        assert_eq!(protocols[1]["traffic_7d"], 3);
        assert_eq!(protocols[2]["protocol"], "trojan");
        assert_eq!(protocols[2]["nodes"], 1);
        assert_eq!(protocols[2]["traffic_7d"], 0);

        assert_eq!(body["chains"]["total"], 0);
        assert_eq!(body["chains"]["degraded"], 0);
        assert_eq!(body["chains"]["blocked"], 0);
        assert_eq!(body["chains"]["forwards_total"], 0);
        assert_eq!(body["chains"]["forwards_failing"], 0);
        assert_eq!(body["chains"]["handshake_failures"], 0);

        let top = body["top"].as_array().unwrap();
        assert_eq!(top.len(), 1);
        assert_eq!(top[0]["kind"], "server");
        assert_eq!(top[0]["name"], "香港-01");
        assert_eq!(top[0]["traffic_7d"], 13);
        assert_eq!(top[0]["online"], true);
        assert!(top[0]["load1"].is_null());
    }

    #[tokio::test]
    async fn overview_days_defaults_to_seven_and_accepts_the_full_range() {
        let (app, _state, admin) = setup().await;

        let (status, body) = request(&app, Some(&admin), "/api/v1/overview").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["series"].as_array().unwrap().len(), 7);

        for (days, expected) in [("1", 1), ("90", 90)] {
            let uri = format!("/api/v1/overview?days={days}");
            let (status, body) = request(&app, Some(&admin), &uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}: {body}");
            assert_eq!(body["series"].as_array().unwrap().len(), expected);
        }
    }

    #[tokio::test]
    async fn overview_rejects_out_of_range_or_non_numeric_days_with_400() {
        let (app, _state, admin) = setup().await;

        for days in ["0", "91", "-1", "abc", "7.5", ""] {
            let uri = format!("/api/v1/overview?days={days}");
            let (status, body) = request(&app, Some(&admin), &uri).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {body}");
            assert_eq!(body["code"], "query.days_invalid", "{uri}: {body}");
            assert!(body["error"].as_str().unwrap().contains("days"));
        }
    }

    #[tokio::test]
    async fn overview_requires_admin() {
        let (app, state, _admin) = setup().await;

        let (status, body) = request(&app, None, "/api/v1/overview").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "body: {body}");

        let plain = users::create(
            &state.db.pool,
            users::NewUser {
                username: "plain".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = sessions::create(&state.db.pool, &plain.id, 3600, None)
            .await
            .unwrap();
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);
        let (status, body) = request(&app, Some(&cookie), "/api/v1/overview").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "body: {body}");
    }

    /// 空库不能 panic：数组为空、数字为 0，`series` 仍然补齐 7 天。
    #[tokio::test]
    async fn overview_is_safe_on_an_empty_database() {
        let (app, _state, admin) = setup().await;

        let (status, body) = request(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["kpi"]["servers_online"], 0);
        assert_eq!(body["kpi"]["servers_total"], 0);
        assert_eq!(body["kpi"]["nodes"], 0);
        assert_eq!(body["kpi"]["traffic_today"], 0);
        assert_eq!(body["kpi"]["traffic_month"], 0);
        assert_eq!(body["kpi"]["uptime_24h"], 0.0);
        assert_eq!(body["series"].as_array().unwrap().len(), 7);
        assert!(body["protocols"].as_array().unwrap().is_empty());
        assert!(body["top"].as_array().unwrap().is_empty());
        assert_eq!(body["chains"]["total"], 0);
        assert_eq!(body["chains"]["handshake_failures"], 0);
    }

    /// 这些表在概览里只读：接口不应写任何数据。
    #[tokio::test]
    async fn overview_is_read_only() {
        let (app, state, admin) = setup().await;
        let before = servers::list(&state.db.pool).await.unwrap().len();
        let before_users = users::count(&state.db.pool).await.unwrap();
        let before_nodes = nodes::count(&state.db.pool).await.unwrap();

        let (status, body) = request(&app, Some(&admin), "/api/v1/overview").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");

        assert_eq!(servers::list(&state.db.pool).await.unwrap().len(), before);
        assert_eq!(users::count(&state.db.pool).await.unwrap(), before_users);
        assert_eq!(nodes::count(&state.db.pool).await.unwrap(), before_nodes);
    }
}
