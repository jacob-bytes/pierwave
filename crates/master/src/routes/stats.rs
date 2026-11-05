//! 管理端统计：概览卡片与流量趋势。
//!
//! 两个接口都只读聚合结果，SQL 全在 `mmrust_domain::repo::stats` 里；
//! 契约见 `docs/PLAN.md`「P3：概览与订阅」。

use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use mmrust_domain::models::Overview;
use mmrust_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DEFAULT_TRAFFIC_DAYS: i64 = 7;
const MAX_TRAFFIC_DAYS: i64 = 90;

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
            AppError::BadRequest(format!("days 必须是 1-{MAX_TRAFFIC_DAYS} 的整数"))
        })?,
    };
    let days = days.clamp(1, MAX_TRAFFIC_DAYS);
    let points = repo::stats::traffic_trend(&state.db.pool, repo::now(), days).await?;
    Ok(Json(json!({ "days": points })))
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use mmrust_domain::repo::{packages, servers, traffic, user_packages, users};
    use mmrust_domain::time;
    use mmrust_domain::Db;

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
}
