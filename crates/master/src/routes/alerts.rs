//! 告警测试接口：`POST /api/v1/alerts/test`（管理员）。
//!
//! 只负责鉴权与响应装配；渠道选择、投递与结果汇总在 [`crate::alerts`]。

use axum::extract::State;
use axum::Json;
use serde_json::Value;

use crate::auth::CurrentUser;
use crate::error::AppResult;
use crate::state::AppState;

pub async fn test(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let report = crate::alerts::test_delivery(&state).await;
    Ok(Json(report.as_json()))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::json;
    use tower::ServiceExt;

    use pierwave_domain::{repo, Db};

    use super::*;
    use crate::alerts::{Alerts, Channel, RecordingTransport};

    async fn setup() -> (Router, AppState, String, String, Arc<RecordingTransport>) {
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
        let transport = Arc::new(RecordingTransport::default());
        let mut state = AppState::new(db, "web/dist");
        state.alerts = Alerts::new(transport.clone());
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={admin_token}", crate::auth::SESSION_COOKIE),
            format!("{}={bob_token}", crate::auth::SESSION_COOKIE),
            transport,
        )
    }

    async fn post(app: &Router, cookie: Option<&str>) -> (StatusCode, Value) {
        let mut builder = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/alerts/test");
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
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, body)
    }

    #[tokio::test]
    async fn without_channels_the_endpoint_explains_why() {
        let (app, _state, admin, _bob, transport) = setup().await;

        let (status, body) = post(&app, Some(&admin)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["configured"], 0);
        assert_eq!(body["results"].as_array().unwrap().len(), 0);
        assert!(
            body["message"].as_str().unwrap().contains("未配置"),
            "{body}"
        );
        assert!(transport.sent().is_empty(), "没有渠道时不能调用投递");
    }

    #[tokio::test]
    async fn configured_channels_are_called_and_results_reported() {
        let (app, state, admin, _bob, transport) = setup().await;
        for (key, value) in [
            ("telegram_bot_token", "123456:ABC"),
            ("telegram_chat_id", "-1001"),
            ("webhook_url", "https://example.test/hook"),
        ] {
            repo::settings::set(&state.db.pool, key, value)
                .await
                .unwrap();
        }
        transport.fail(Channel::Webhook);

        let (status, body) = post(&app, Some(&admin)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["configured"], 2);
        assert!(body["message"].is_null(), "有渠道时不返回提示");

        let results = body["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        let telegram = results
            .iter()
            .find(|result| result["channel"] == "telegram")
            .unwrap();
        assert_eq!(telegram["ok"], true);
        let webhook = results
            .iter()
            .find(|result| result["channel"] == "webhook")
            .unwrap();
        assert_eq!(webhook["ok"], false);
        assert!(webhook["error"].as_str().unwrap().contains("模拟投递失败"));

        let sent = transport.sent();
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|item| item.kind == "test"));
        assert!(sent[0].at > 0);
    }

    #[tokio::test]
    async fn alerts_test_requires_admin() {
        let (app, _state, _admin, bob, transport) = setup().await;

        let (status, body) = post(&app, Some(&bob)).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["error"], "权限不足");

        let (status, _) = post(&app, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(transport.sent().is_empty());
    }

    // 保证测试本身不依赖真实网络：即使配置了渠道，也只走 RecordingTransport。
    #[test]
    fn json_shape_matches_frontend_expectations() {
        let report = crate::alerts::TestReport {
            configured: 1,
            results: vec![crate::alerts::ChannelResult {
                channel: Channel::Webhook,
                ok: true,
                error: None,
            }],
            message: None,
        };
        let body = report.as_json();
        assert_eq!(body["configured"], 1);
        assert_eq!(body["results"][0]["channel"], "webhook");
        assert_eq!(body["results"][0]["ok"], true);
        assert_eq!(body["results"][0]["error"], json!(null));
    }
}
