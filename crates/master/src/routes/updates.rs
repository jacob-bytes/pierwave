//! 版本更新接口：查询当前状态与手动触发检测（均仅管理员）。
//!
//! * `GET  /api/v1/updates`        —— 读库 + 心跳聚合，**不**访问外网；
//! * `POST /api/v1/updates/check`  —— 立即请求一次 GitHub Releases。
//!
//! 检测失败不返回 5xx：错误原因写在响应体的 `master.error` 里，前端照常
//! 展示「上次检测」与上一次成功的最新版本。只有数据库写失败才是 500。

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::auth::CurrentUser;
use crate::error::AppResult;
use crate::state::AppState;

/// `GET /api/v1/updates`：管理员查看 master 与 Agent 的版本状态。
pub async fn get(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    Ok(Json(crate::updates::view(&state).await?))
}

/// `POST /api/v1/updates/check`：立即检测一次（不受间隔设置限制）。
pub async fn check(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let check = crate::updates::check_now(&state).await?;
    // 审计只记结果摘要；错误原因已经在接口响应里，避免把长文本塞进审计。
    crate::audit::record(
        &state,
        &user.0,
        "updates.check",
        "updates",
        json!({
            "latest": check.latest_version,
            "update_available": pierwave_domain::updates::has_update(
                Some(&check.latest_version),
                crate::updates::current_version(),
            ),
            "failed": !check.error.is_empty(),
        }),
    )
    .await;
    Ok(Json(crate::updates::view(&state).await?))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use pierwave_domain::{repo, updates, Db};

    use crate::alerts::{Alerts, RecordingTransport};
    use crate::state::AppState;
    use crate::updates::{StaticFetcher, UpdateService};

    fn release_json(version: &str) -> String {
        format!(
            r#"{{"tag_name":"v{version}","html_url":"https://github.com/jacob-bytes/pierwave/releases/tag/v{version}","published_at":"2026-11-20T10:00:00Z"}}"#
        )
    }

    async fn setup(
        replies: Vec<Result<String, updates::UpdateError>>,
    ) -> (Router, AppState, String, String) {
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
        let bob = repo::users::create(
            &db.pool,
            repo::users::NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (admin_token, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
            .await
            .unwrap();
        let (bob_token, _) = repo::sessions::create(&db.pool, &bob.id, 3600, None)
            .await
            .unwrap();
        let mut state = AppState::new(db, "web/dist");
        state.alerts = Alerts::new(Arc::new(RecordingTransport::default()));
        state.updates = UpdateService::new(Arc::new(StaticFetcher::new(replies)));
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={admin_token}", crate::auth::SESSION_COOKIE),
            format!("{}={bob_token}", crate::auth::SESSION_COOKIE),
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
        let body = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, body)
    }

    async fn seed_server(state: &AppState, name: &str, version: Option<&str>) {
        let (server, _token) = repo::servers::create(&state.db.pool, name, "10.0.0.1", "external")
            .await
            .unwrap();
        if let Some(version) = version {
            repo::servers::update_health(
                &state.db.pool,
                &server.id,
                version,
                &repo::servers::HealthSnapshot::default(),
            )
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn admin_sees_master_and_agent_versions_without_the_network() {
        // 空队列 = 任何 fetch 都会报错；GET 只读库，不该触发检测。
        let (app, state, admin, _bob) = setup(Vec::new()).await;
        seed_server(&state, "hk-1", Some("0.11.3")).await;
        seed_server(&state, "hk-2", Some("0.11.3")).await;
        seed_server(&state, "hk-3", Some("0.11.1")).await;
        seed_server(&state, "hk-4", None).await;

        let (status, body) = request(&app, Some(&admin), Method::GET, "/api/v1/updates").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["master"]["current"], crate::updates::current_version());
        assert_eq!(body["master"]["latest"], Value::Null);
        assert_eq!(body["master"]["update_available"], false);
        assert_eq!(body["master"]["checked_at"], Value::Null);
        assert_eq!(body["master"]["error"], Value::Null);
        assert_eq!(body["agents"]["current_protocol"], 25);
        assert_eq!(body["agents"]["min_supported"], 16);
        assert_eq!(
            body["agents"]["versions"],
            serde_json::json!([
                { "version": "0.11.3", "count": 2 },
                { "version": "0.11.1", "count": 1 },
            ]),
            "从未上报的服务器不计入版本分布"
        );
    }

    #[tokio::test]
    async fn manual_check_runs_and_returns_the_new_version() {
        let (app, _state, admin, _bob) = setup(vec![Ok(release_json("0.12.0"))]).await;

        let (status, body) =
            request(&app, Some(&admin), Method::POST, "/api/v1/updates/check").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["master"]["latest"], "0.12.0");
        assert_eq!(body["master"]["update_available"], true);
        assert_eq!(
            body["master"]["release_url"],
            "https://github.com/jacob-bytes/pierwave/releases/tag/v0.12.0"
        );
        assert_eq!(body["master"]["released_at"], 1_795_168_800);
        assert!(body["master"]["checked_at"].as_i64().unwrap() > 0);
        assert_eq!(body["master"]["error"], Value::Null);

        // 再 GET 一次：结果已经落库，不需要再联网。
        let (status, again) = request(&app, Some(&admin), Method::GET, "/api/v1/updates").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(again["master"], body["master"]);
    }

    #[tokio::test]
    async fn a_failed_manual_check_keeps_the_previous_version_and_explains_why() {
        let (app, _state, admin, _bob) = setup(vec![
            Ok(release_json("0.12.0")),
            Err(updates::UpdateError::Timeout),
        ])
        .await;

        request(&app, Some(&admin), Method::POST, "/api/v1/updates/check").await;
        let (status, body) =
            request(&app, Some(&admin), Method::POST, "/api/v1/updates/check").await;
        assert_eq!(status, StatusCode::OK, "检测失败不能变成 500：{body}");
        assert_eq!(body["master"]["latest"], "0.12.0", "保留上一次成功值");
        assert_eq!(body["master"]["update_available"], true);
        let error = body["master"]["error"].as_str().unwrap();
        assert!(error.contains("超时"), "{error}");
        assert!(error.contains("timed out"), "{error}");
    }

    #[tokio::test]
    async fn non_admins_get_403_on_both_endpoints() {
        let (app, _state, _admin, bob) = setup(vec![Ok(release_json("0.12.0"))]).await;

        let (status, _) = request(&app, Some(&bob), Method::GET, "/api/v1/updates").await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, body) = request(&app, Some(&bob), Method::POST, "/api/v1/updates/check").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }

    #[tokio::test]
    async fn anonymous_requests_are_unauthorized() {
        let (app, _state, _admin, _bob) = setup(Vec::new()).await;
        let (status, _) = request(&app, None, Method::GET, "/api/v1/updates").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = request(&app, None, Method::POST, "/api/v1/updates/check").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
}
