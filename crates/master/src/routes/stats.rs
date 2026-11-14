//! 管理端统计：概览卡片、流量趋势与节点维度流量明细。
//!
//! 所有接口都只读聚合结果，SQL 全在 `pierwave_domain::repo::stats` 里；
//! 契约见 `docs/PLAN.md`「P2：节点维度流量明细」。

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use pierwave_domain::models::Overview;
use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DEFAULT_TRAFFIC_DAYS: i64 = 7;
const MAX_TRAFFIC_DAYS: i64 = 90;

const DEFAULT_NODE_DAYS: i64 = 30;
const DEFAULT_TOP_USERS: i64 = 10;
const MAX_TOP_USERS: i64 = 50;

pub async fn overview(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Overview>> {
    user.require_admin()?;
    let overview = repo::stats::overview(&state.db.pool, repo::now()).await?;
    Ok(Json(overview))
}

#[derive(Deserialize)]
pub struct TrafficQuery {
    /// 天数；缺省 7，超出 1..=90 时夹到边界。
    pub days: Option<String>,
}

pub async fn traffic(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<TrafficQuery>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;

    let days = match query.days.as_deref() {
        None => DEFAULT_TRAFFIC_DAYS,
        Some(raw) => raw.trim().parse::<i64>().map_err(|_| {
            AppError::coded(
                "stats.days_invalid",
                Some(json!({ "min": 1, "max": MAX_TRAFFIC_DAYS })),
                format!("days 必须是 1-{MAX_TRAFFIC_DAYS} 的整数"),
            )
        })?,
    };
    let days = days.clamp(1, MAX_TRAFFIC_DAYS);
    let points = repo::stats::traffic_trend(&state.db.pool, repo::now(), days).await?;
    Ok(Json(json!({ "days": points })))
}

/// `days` 严格校验：缺省用默认值，给值就必须落在 1..=90，非法一律 400。
///
/// 与旧 `/stats/traffic` 的「夹到边界」不同：节点接口把越界视为非法参数，
/// 避免调用方以为拿到的是自己要的天数。
fn parse_days(raw: Option<&str>, default: i64) -> AppResult<i64> {
    let Some(raw) = raw else {
        return Ok(default);
    };
    let days = raw.trim().parse::<i64>().map_err(|_| {
        AppError::coded(
            "stats.days_invalid",
            Some(json!({ "min": 1, "max": MAX_TRAFFIC_DAYS })),
            format!("days 必须是 1-{MAX_TRAFFIC_DAYS} 的整数"),
        )
    })?;
    if !(1..=MAX_TRAFFIC_DAYS).contains(&days) {
        return Err(AppError::coded(
            "stats.days_invalid",
            Some(json!({ "min": 1, "max": MAX_TRAFFIC_DAYS })),
            format!("days 必须在 1-{MAX_TRAFFIC_DAYS} 之间"),
        ));
    }
    Ok(days)
}

fn parse_top(raw: Option<&str>) -> AppResult<i64> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_TOP_USERS);
    };
    let top = raw.trim().parse::<i64>().map_err(|_| {
        AppError::coded(
            "stats.top_invalid",
            Some(json!({ "min": 1, "max": MAX_TOP_USERS })),
            format!("top 必须是 1-{MAX_TOP_USERS} 的整数"),
        )
    })?;
    if !(1..=MAX_TOP_USERS).contains(&top) {
        return Err(AppError::coded(
            "stats.top_invalid",
            Some(json!({ "min": 1, "max": MAX_TOP_USERS })),
            format!("top 必须在 1-{MAX_TOP_USERS} 之间"),
        ));
    }
    Ok(top)
}

#[derive(Deserialize)]
pub struct NodeTrafficQuery {
    pub days: Option<String>,
    /// 可选：只看某台服务器上的节点。
    pub server_id: Option<String>,
}

/// `GET /api/v1/stats/nodes`：节点维度流量，按加权值降序。
pub async fn nodes(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<NodeTrafficQuery>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let days = parse_days(query.days.as_deref(), DEFAULT_TRAFFIC_DAYS)?;
    let server_id = query
        .server_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let items = repo::stats::node_traffic(&state.db.pool, repo::now(), days, server_id).await?;
    Ok(Json(json!({ "items": items })))
}

#[derive(Deserialize)]
pub struct NodeDetailQuery {
    pub days: Option<String>,
    pub top: Option<String>,
}

/// `GET /api/v1/stats/nodes/{node_id}`：节点日趋势 + Top N 用户。
pub async fn node_detail(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(node_id): Path<String>,
    Query(query): Query<NodeDetailQuery>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let days = parse_days(query.days.as_deref(), DEFAULT_NODE_DAYS)?;
    let top = parse_top(query.top.as_deref())?;
    let Some((node, points, users)) =
        repo::stats::node_traffic_detail(&state.db.pool, &node_id, repo::now(), days, top).await?
    else {
        return Err(AppError::not_found("node.not_found", None, "资源不存在"));
    };
    Ok(Json(
        json!({ "node": node, "days": points, "users": users }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use pierwave_domain::repo::{nodes, packages, servers, traffic, user_packages, users};
    use pierwave_domain::time;
    use pierwave_domain::Db;

    async fn setup() -> (Router, AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let admin = repo::users::create(
            &db.pool,
            repo::users::NewUser {
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
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
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

    fn at(rfc3339: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .timestamp()
    }

    #[tokio::test]
    async fn overview_counts_each_metric_from_aggregate_queries() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;

        // 2 台服务器，1 台在线。
        let (online, _) = servers::create(pool, "hk-1", "10.0.0.1", "external")
            .await
            .unwrap();
        servers::mark_online(pool, &online.id).await.unwrap();
        servers::create(pool, "jp-1", "10.0.0.2", "external")
            .await
            .unwrap();

        // 2 个用户（admin + bob），bob 禁用 → active = 1。
        let owner = users::find_by_username(pool, "admin")
            .await
            .unwrap()
            .unwrap();
        let bob = users::create(
            pool,
            users::NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        users::update(
            pool,
            &bob.id,
            users::UpdateUser {
                status: Some("disabled".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        // 1 个套餐模板、2 个实例：一个已过期、一个刚用尽。
        let package = packages::create(
            pool,
            packages::NewPackage {
                name: "月卡".into(),
                quota_bytes: Some(1000),
                period_days: Some(30),
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,

                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        let now = repo::now();
        user_packages::create(
            pool,
            &owner.id,
            user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: Some(now - 60),
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap();
        let exhausted = user_packages::create(
            pool,
            &owner.id,
            user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap();
        user_packages::set_used_bytes(pool, &exhausted.id, 1000)
            .await
            .unwrap();

        // 今天一条、上个月一条：today/month 都只能计入今天那条。
        let today = time::business_date(now);
        let last_month = time::business_date(now - 32 * 86_400);
        traffic::accumulate_daily(pool, &today, &online.id, &owner.id, 100, 50, 150)
            .await
            .unwrap();
        traffic::accumulate_daily(
            pool,
            &last_month,
            &online.id,
            &owner.id,
            9_999,
            9_999,
            9_999,
        )
        .await
        .unwrap();

        let (status, body) =
            request(&app, Some(&admin), Method::GET, "/api/v1/stats/overview").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(
            body,
            json!({
                "servers": {"total": 2, "online": 1},
                "users": {"total": 2, "active": 1},
                "packages": {"total": 1, "instances": 2},
                "traffic": {"today_bytes": 150, "month_bytes": 150},
                "alerts": {
                    "expired_instances": 1,
                    "exhausted_instances": 1,
                    "offline_servers": 1,
                    "expiring_certs": 0
                }
            })
        );
    }

    #[tokio::test]
    async fn stats_require_admin() {
        let (app, state, _admin) = setup().await;

        for uri in ["/api/v1/stats/overview", "/api/v1/stats/traffic?days=7"] {
            let (status, body) = request(&app, None, Method::GET, uri).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}: {body}");
        }

        let user = repo::users::create(
            &state.db.pool,
            repo::users::NewUser {
                username: "plain".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&state.db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);

        for uri in ["/api/v1/stats/overview", "/api/v1/stats/traffic?days=7"] {
            let (status, body) = request(&app, Some(&cookie), Method::GET, uri).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
            assert!(!body["error"].as_str().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn traffic_trend_fills_missing_days_in_ascending_order() {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let now = at("2026-11-15T12:00:00+08:00");

        traffic::accumulate_daily(&db.pool, "2026-11-15", "s1", "alice", 10, 20, 30)
            .await
            .unwrap();
        traffic::accumulate_daily(&db.pool, "2026-11-11", "s1", "alice", 1, 2, 3)
            .await
            .unwrap();
        // 窗口外（7 天从 11-09 起）的数据不能被带进来。
        traffic::accumulate_daily(&db.pool, "2026-10-31", "s1", "alice", 99, 99, 99)
            .await
            .unwrap();

        let points = repo::stats::traffic_trend(&db.pool, now, 7).await.unwrap();
        let dates: Vec<&str> = points.iter().map(|point| point.date.as_str()).collect();
        assert_eq!(
            dates,
            [
                "2026-11-09",
                "2026-11-10",
                "2026-11-11",
                "2026-11-12",
                "2026-11-13",
                "2026-11-14",
                "2026-11-15"
            ]
        );
        // 缺失日期补 0，不是跳过。
        assert_eq!(
            (points[0].uplink, points[0].downlink, points[0].weighted),
            (0, 0, 0)
        );
        assert_eq!(
            (points[2].uplink, points[2].downlink, points[2].weighted),
            (1, 2, 3)
        );
        assert_eq!(
            (points[6].uplink, points[6].downlink, points[6].weighted),
            (10, 20, 30)
        );

        // 仓储层也夹参数：0 → 1 天，过大 → 90 天。
        assert_eq!(
            repo::stats::traffic_trend(&db.pool, now, 0)
                .await
                .unwrap()
                .len(),
            1
        );
        let capped = repo::stats::traffic_trend(&db.pool, now, 1000)
            .await
            .unwrap();
        assert_eq!(capped.len(), 90);
        assert_eq!(capped[89].date, "2026-11-15");
        assert_eq!(capped[0].date, "2026-08-18");
    }

    #[tokio::test]
    async fn traffic_days_clamped_and_invalid_rejected() {
        let (app, _state, admin) = setup().await;

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/stats/traffic?days=1000",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["days"].as_array().unwrap().len(), 90);

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/stats/traffic?days=0",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["days"].as_array().unwrap().len(), 1);

        // 缺省 7 天。
        let (status, body) =
            request(&app, Some(&admin), Method::GET, "/api/v1/stats/traffic").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["days"].as_array().unwrap().len(), 7);

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/stats/traffic?days=abc",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("days"));
    }

    async fn add_node(
        pool: &sqlx::SqlitePool,
        server_id: &str,
        tag: &str,
        name: &str,
    ) -> pierwave_domain::models::Node {
        nodes::create(
            pool,
            server_id,
            nodes::NewNode {
                tag: Some(tag.into()),
                name: name.into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "none".into(),
                port: 443,
                public_port: None,
                config_json: "{}".into(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap()
    }

    /// 测试播种：`bytes = (uplink, downlink, weighted)`。
    async fn seed(
        pool: &sqlx::SqlitePool,
        day: &str,
        server_id: &str,
        node_tag: &str,
        user_id: &str,
        bytes: (u64, u64, u64),
    ) {
        traffic::accumulate_node_daily(
            pool,
            day,
            server_id,
            traffic::NodeTrafficDelta {
                node_tag,
                user_id,
                uplink: bytes.0,
                downlink: bytes.1,
                weighted: bytes.2,
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn node_traffic_lists_each_node_sorted_by_weighted() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;

        let (server, _) = servers::create(pool, "hk-1", "10.0.0.1", "external")
            .await
            .unwrap();
        let low = add_node(pool, &server.id, "hk-low", "香港-低").await;
        let high = add_node(pool, &server.id, "hk-high", "香港-高").await;

        let today = time::business_date(time::now());
        seed(pool, &today, &server.id, &low.tag, "u-low", (100, 50, 150)).await;
        seed(
            pool,
            &today,
            &server.id,
            &high.tag,
            "u-high",
            (200, 100, 300),
        )
        .await;

        // 另一台服务器的节点：不过滤时出现，带 server_id 时消失。
        let (other, _) = servers::create(pool, "jp-1", "10.0.0.2", "external")
            .await
            .unwrap();
        let other_node = add_node(pool, &other.id, "jp-node", "日本").await;
        seed(
            pool,
            &today,
            &other.id,
            &other_node.tag,
            "u-jp",
            (900, 90, 990),
        )
        .await;

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/stats/nodes?days=7",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["node_id"], other_node.id);
        assert_eq!(items[1]["node_id"], high.id);
        assert_eq!(items[2]["node_id"], low.id);

        let uri = format!("/api/v1/stats/nodes?days=7&server_id={}", server.id);
        let (status, body) = request(&app, Some(&admin), Method::GET, &uri).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        let high_row = &items[0];
        assert_eq!(high_row["node_id"], high.id);
        assert_eq!(high_row["node_tag"], "hk-high");
        assert_eq!(high_row["name"], "香港-高");
        assert_eq!(high_row["server_id"], server.id);
        assert_eq!(high_row["server_name"], "hk-1");
        assert_eq!(high_row["protocol"], "vless");
        assert_eq!(high_row["transport"], "tcp");
        assert_eq!(high_row["security"], "none");
        assert_eq!(
            (
                high_row["uplink"].as_i64(),
                high_row["downlink"].as_i64(),
                high_row["weighted"].as_i64(),
            ),
            (Some(200), Some(100), Some(300))
        );
        assert_eq!(high_row["today_bytes"], 300);
        assert_eq!(high_row["month_bytes"], 300);
        assert_eq!(items[1]["weighted"], 150);
    }

    #[tokio::test]
    async fn node_detail_fills_days_and_limits_top_users() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let (server, _) = servers::create(pool, "hk-1", "10.0.0.1", "external")
            .await
            .unwrap();
        let node = add_node(pool, &server.id, "hk-1", "香港").await;

        let mut ids = Vec::new();
        for username in ["alice", "bob", "carol"] {
            let user = users::create(
                pool,
                users::NewUser {
                    username: username.into(),
                    password: "password123".into(),
                    role: "user".into(),
                    quota_bytes: None,
                    rule_template_id: None,
                },
            )
            .await
            .unwrap();
            ids.push(user.id);
        }
        let (alice, bob, carol) = (&ids[0], &ids[1], &ids[2]);

        let now = time::now();
        let today = time::business_date(now);
        let two_days_ago = time::business_date(now - 2 * 86_400);
        seed(pool, &today, &server.id, &node.tag, alice, (10, 5, 30)).await;
        seed(pool, &today, &server.id, &node.tag, bob, (100, 50, 300)).await;
        seed(
            pool,
            &two_days_ago,
            &server.id,
            &node.tag,
            carol,
            (7, 3, 14),
        )
        .await;
        // 无法归因：计入节点总量，但不进用户明细。
        seed(pool, &today, &server.id, &node.tag, "", (1000, 1000, 50)).await;

        let uri = format!("/api/v1/stats/nodes/{}?days=3&top=2", node.id);
        let (status, body) = request(&app, Some(&admin), Method::GET, &uri).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");

        let node_json = &body["node"];
        assert_eq!(node_json["node_id"], node.id);
        assert_eq!(node_json["node_tag"], "hk-1");
        assert_eq!(node_json["name"], "香港");
        assert_eq!(node_json["server_id"], server.id);
        assert_eq!(node_json["server_name"], "hk-1");
        assert_eq!(node_json["uplink"], 1117);
        assert_eq!(node_json["downlink"], 1058);
        assert_eq!(node_json["weighted"], 394);
        assert_eq!(node_json["today_bytes"], 380);

        // 本月口径覆盖窗口以外的本月数据；测试跨月时按实际月份边界算期望值。
        let (month_start, month_end) = time::business_month_bounds(now);
        let mut expected_month = 380;
        if two_days_ago >= month_start && two_days_ago <= month_end {
            expected_month += 14;
        }
        assert_eq!(node_json["month_bytes"], expected_month);

        let days = body["days"].as_array().unwrap();
        assert_eq!(days.len(), 3);
        assert_eq!(days[0]["date"], two_days_ago);
        assert_eq!(days[1]["date"], time::business_date(now - 86_400));
        assert_eq!(days[2]["date"], today);
        assert_eq!(days[0]["weighted"], 14);
        assert_eq!(days[1]["weighted"], 0, "缺失日必须补 0");
        assert_eq!(days[1]["uplink"], 0);
        assert_eq!(days[2]["weighted"], 380);
        assert_eq!(days[2]["uplink"], 1110);
        assert_eq!(days[2]["downlink"], 1055);

        // Top 用户按 weighted 降序，`user_id = ''` 不出现。
        let top_users = body["users"].as_array().unwrap();
        assert_eq!(top_users.len(), 2);
        assert_eq!(top_users[0]["user_id"], *bob);
        assert_eq!(top_users[0]["username"], "bob");
        assert_eq!(top_users[0]["weighted"], 300);
        assert_eq!(top_users[1]["user_id"], *alice);
        assert_eq!(top_users[1]["weighted"], 30);

        // top 生效：只要第一名。
        let uri = format!("/api/v1/stats/nodes/{}?days=3&top=1", node.id);
        let (status, body) = request(&app, Some(&admin), Method::GET, &uri).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let top_users = body["users"].as_array().unwrap();
        assert_eq!(top_users.len(), 1);
        assert_eq!(top_users[0]["username"], "bob");
    }

    #[tokio::test]
    async fn node_stats_require_admin_and_validate_params() {
        let (app, state, admin) = setup().await;
        let (server, _) = servers::create(&state.db.pool, "hk-1", "10.0.0.1", "external")
            .await
            .unwrap();
        let node = add_node(&state.db.pool, &server.id, "hk-1", "香港").await;

        let (status, body) = request(&app, None, Method::GET, "/api/v1/stats/nodes").await;
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
        let (token, _) = repo::sessions::create(&state.db.pool, &plain.id, 3600, None)
            .await
            .unwrap();
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);
        for uri in [
            "/api/v1/stats/nodes".to_string(),
            format!("/api/v1/stats/nodes/{}", node.id),
        ] {
            let (status, body) = request(&app, Some(&cookie), Method::GET, &uri).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
        }

        for uri in [
            "/api/v1/stats/nodes?days=0",
            "/api/v1/stats/nodes?days=91",
            "/api/v1/stats/nodes?days=abc",
            "/api/v1/stats/nodes?days=-1",
        ] {
            let (status, body) = request(&app, Some(&admin), Method::GET, uri).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {body}");
            assert!(body["error"].as_str().unwrap().contains("days"));
        }

        for uri in [
            format!("/api/v1/stats/nodes/{}?top=0", node.id),
            format!("/api/v1/stats/nodes/{}?top=51", node.id),
            format!("/api/v1/stats/nodes/{}?top=abc", node.id),
            format!("/api/v1/stats/nodes/{}?days=0", node.id),
        ] {
            let (status, body) = request(&app, Some(&admin), Method::GET, &uri).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {body}");
            let message = body["error"].as_str().unwrap();
            assert!(
                message.contains("days") || message.contains("top"),
                "{uri}: {message}"
            );
        }

        let (status, body) = request(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/stats/nodes/no-such-node",
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "body: {body}");
    }

    #[tokio::test]
    async fn deleted_node_keeps_traffic_rows_but_disappears_from_views() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let (server, _) = servers::create(pool, "hk-1", "10.0.0.1", "external")
            .await
            .unwrap();
        let node = add_node(pool, &server.id, "hk-1", "香港").await;
        let today = time::business_date(time::now());
        seed(pool, &today, &server.id, &node.tag, "u1", (100, 50, 150)).await;

        assert!(nodes::delete(pool, &node.id).await.unwrap());

        // 历史账本不跟着节点删除：表上没有指向 nodes 的外键。
        let kept = traffic::find_node_daily(pool, &today, &server.id, &node.tag, "u1")
            .await
            .unwrap()
            .expect("节点删除后流量记录仍应保留");
        assert_eq!(kept.weighted, 150);

        // 但 JOIN 不到节点，列表里不再出现；详情 404。
        let (status, body) = request(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/stats/nodes?days=7",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["items"].as_array().unwrap().len(), 0);

        let uri = format!("/api/v1/stats/nodes/{}", node.id);
        let (status, body) = request(&app, Some(&admin), Method::GET, &uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "body: {body}");
    }

    #[tokio::test]
    async fn node_traffic_month_and_today_are_not_limited_to_window() {
        let (_app, state, _admin) = setup().await;
        let pool = &state.db.pool;
        let (server, _) = servers::create(pool, "hk-1", "10.0.0.1", "external")
            .await
            .unwrap();
        let node = add_node(pool, &server.id, "hk-1", "香港").await;
        let now = at("2026-11-20T12:00:00+08:00");

        // 窗口 3 天 = 11-18..11-20；11-05 在本月但窗口外，10-31 在上个月。
        for (day, uplink, downlink, weighted) in [
            ("2026-11-20", 10, 5, 10),
            ("2026-11-18", 20, 10, 20),
            ("2026-11-05", 30, 15, 30),
            ("2026-10-31", 40, 20, 40),
        ] {
            seed(
                pool,
                day,
                &server.id,
                &node.tag,
                "u1",
                (uplink, downlink, weighted),
            )
            .await;
        }

        let rows = repo::stats::node_traffic(pool, now, 3, None).await.unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(
            (row.uplink, row.downlink, row.weighted),
            (30, 15, 30),
            "窗口只算 11-18..11-20"
        );
        assert_eq!(row.today_bytes, 10);
        assert_eq!(row.month_bytes, 60, "本月 = 11-20 + 11-18 + 11-05");

        let (detail, days, users) = repo::stats::node_traffic_detail(pool, &node.id, now, 3, 10)
            .await
            .unwrap()
            .expect("节点存在");
        assert_eq!(detail.weighted, 30);
        assert_eq!(detail.today_bytes, 10);
        assert_eq!(detail.month_bytes, 60);
        assert_eq!(days.len(), 3);
        assert_eq!(days[0].date, "2026-11-18");
        assert_eq!(days[1].date, "2026-11-19");
        assert_eq!(days[1].weighted, 0);
        assert_eq!(days[2].date, "2026-11-20");
        assert_eq!(days[2].weighted, 10);
        assert_eq!(users.len(), 1);
        assert_eq!(users[0].user_id, "u1");
        assert_eq!(users[0].username, "u1", "用户已删时用 id 兜底");
        assert_eq!(users[0].weighted, 30);
    }
}
