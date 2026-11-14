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
                public_port: None,
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

    const TEST_CERT_PEM: &str = include_str!("../../../domain/tests/fixtures/test-cert.pem");
    const TEST_KEY_PEM: &str = include_str!("../../../domain/tests/fixtures/test-key.pem");
    const EXPIRED_CERT_PEM: &str =
        include_str!("../../../domain/tests/fixtures/test-expired-cert.pem");
    const EXPIRED_KEY_PEM: &str =
        include_str!("../../../domain/tests/fixtures/test-expired-key.pem");

    async fn set_capabilities(
        pool: &sqlx::SqlitePool,
        server_id: &str,
        realm_transport: Option<bool>,
        nftables_available: Option<bool>,
    ) {
        servers::update_health(
            pool,
            server_id,
            "0.8.0",
            &servers::HealthSnapshot {
                realm_transport,
                nftables_available,
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    async fn add_certificate(
        pool: &sqlx::SqlitePool,
        name: &str,
        cert_pem: &str,
        key_pem: &str,
        not_after: i64,
    ) -> String {
        repo::certificates::create(
            pool,
            repo::certificates::NewCertificate {
                name: name.into(),
                domains: vec!["example.com".into()],
                cert_pem: cert_pem.into(),
                key_pem: key_pem.into(),
                not_before: 1_577_836_800,
                not_after,
            },
        )
        .await
        .unwrap()
        .id
    }

    fn one_group(
        server_id: &str,
        listen_port: i64,
        cert_id: Option<String>,
    ) -> Vec<repo::chains::NewChainGroup> {
        vec![repo::chains::NewChainGroup {
            name: None,
            strategy: "round_robin".into(),
            cert_id,
            public_port: None,
            use_internal_address: false,
            members: vec![repo::chains::NewChainGroupMember {
                server_id: server_id.into(),
                listen_port,
                priority: 0,
                weight: 1,
            }],
        }]
    }

    /// 概览的 `chains.blocked` 必须与链列表里带 `blocked_reason` 的条数逐一对齐。
    ///
    /// 三种容易分叉的情况各造一次：证书过期、nftables 能力不足、`listening = 0`。
    /// 前两者是配置层面的 blocked，两处都应计数；`listening = 0` 是运行态健康，
    /// 两处都不应计入（旧概览 SQL 会把它算成 blocked，这正是本次修掉的偏差）。
    #[tokio::test]
    async fn overview_blocked_matches_chain_list_for_cert_capability_and_listen_failure() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;

        async fn counts(app: &Router, cookie: &str) -> (i64, usize) {
            let (status, overview) = request(app, Some(cookie), "/api/v1/overview?days=7").await;
            assert_eq!(status, StatusCode::OK, "overview: {overview}");
            let (status, list) = request(app, Some(cookie), "/api/v1/chains").await;
            assert_eq!(status, StatusCode::OK, "chains: {list}");
            let blocked_items = list["items"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item.get("blocked_reason").is_some())
                .count();
            (
                overview["chains"]["blocked"].as_i64().unwrap(),
                blocked_items,
            )
        }

        // 无链：两处都为 0，且不能因为空表出错。
        assert_eq!(counts(&app, &admin).await, (0, 0), "无链时应为 0");

        let (a, _) = servers::create(pool, "a", "10.0.0.1", "external")
            .await
            .unwrap();
        let (b, _) = servers::create(pool, "b", "10.0.0.2", "external")
            .await
            .unwrap();
        let (c, _) = servers::create(pool, "c", "10.0.0.3", "external")
            .await
            .unwrap();
        set_capabilities(pool, &a.id, Some(true), Some(true)).await;
        set_capabilities(pool, &b.id, Some(true), Some(true)).await;
        set_capabilities(pool, &c.id, Some(false), Some(false)).await;

        // 仅仅 listening=0 的明文链：运行态不健康，但不是配置层面的 blocked。
        let plain = repo::chains::create(
            pool,
            repo::chains::NewChain {
                name: "listen-failed".into(),
                target_host: "1.1.1.1".into(),
                target_port: 443,
                enabled: true,
                engine: "native".into(),
                protocol: "tcp".into(),
                transport: "none".into(),
                tunnel_security: "tls".into(),
                groups: one_group(&a.id, 9001, None),
            },
        )
        .await
        .unwrap();
        repo::forwards::save_status(
            pool,
            &a.id,
            &[repo::forwards::NewForwardStatus {
                forward_id: pierwave_domain::chains::forward_id(&plain.chain.id, 0, &a.id, 1),
                listening: false,
                error: "监听 9001 失败".into(),
                target_ok: None,
                target_error: None,
                targets: Vec::new(),
                traffic_in: None,
                traffic_out: None,
            }],
        )
        .await
        .unwrap();
        assert_eq!(
            counts(&app, &admin).await,
            (0, 0),
            "listening=0 不应被算进 blocked（概览与列表都不算）"
        );

        // 证书过期：整链无法下发，两处都计 1。
        let expired_cert = add_certificate(
            pool,
            "expired",
            EXPIRED_CERT_PEM,
            EXPIRED_KEY_PEM,
            1_609_459_200,
        )
        .await;
        let expired = repo::chains::create(
            pool,
            repo::chains::NewChain {
                name: "expired-cert".into(),
                target_host: "1.1.1.1".into(),
                target_port: 443,
                enabled: true,
                engine: "realm".into(),
                protocol: "tcp".into(),
                transport: "tls".into(),
                tunnel_security: "tls".into(),
                groups: vec![
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: None,
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: a.id.clone(),
                            listen_port: 9006,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: Some(expired_cert.clone()),
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: b.id.clone(),
                            listen_port: 9007,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                ],
            },
        )
        .await
        .unwrap();
        assert_eq!(
            counts(&app, &admin).await,
            (1, 1),
            "过期证书：概览计数与链列表 blocked 条数必须一致"
        );

        // nftables 能力不足：整链无法下发，两处都计 2。
        let nft = repo::chains::create(
            pool,
            repo::chains::NewChain {
                name: "nft-capability".into(),
                target_host: "1.1.1.1".into(),
                target_port: 443,
                enabled: true,
                engine: "nftables".into(),
                protocol: "tcp".into(),
                transport: "none".into(),
                tunnel_security: "tls".into(),
                groups: one_group(&c.id, 9003, None),
            },
        )
        .await
        .unwrap();

        let (overview_blocked, list_blocked) = counts(&app, &admin).await;
        assert_eq!(
            (overview_blocked, list_blocked),
            (2, 2),
            "过期证书 + 能力不足：两处都计 2，listening=0 不额外计入"
        );

        // 证书有效且能力满足的加密链：不进 blocked，两处计数都不变。
        let valid_cert =
            add_certificate(pool, "valid", TEST_CERT_PEM, TEST_KEY_PEM, 2_109_208_713).await;
        repo::chains::create(
            pool,
            repo::chains::NewChain {
                name: "healthy-tls".into(),
                target_host: "1.1.1.1".into(),
                target_port: 443,
                enabled: true,
                engine: "realm".into(),
                protocol: "tcp".into(),
                transport: "tls".into(),
                tunnel_security: "tls".into(),
                groups: vec![
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: None,
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: a.id.clone(),
                            listen_port: 9004,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                    repo::chains::NewChainGroup {
                        name: None,
                        strategy: "round_robin".into(),
                        cert_id: Some(valid_cert),
                        public_port: None,
                        use_internal_address: false,
                        members: vec![repo::chains::NewChainGroupMember {
                            server_id: b.id.clone(),
                            listen_port: 9005,
                            priority: 0,
                            weight: 1,
                        }],
                    },
                ],
            },
        )
        .await
        .unwrap();
        assert_eq!(
            counts(&app, &admin).await,
            (2, 2),
            "证书有效的加密链不应被计入 blocked"
        );

        // 两种 blocked 原因也要保持原样（文案/错误码属于验收过的契约）。
        let (_, list) = request(&app, Some(&admin), "/api/v1/chains").await;
        let items = list["items"].as_array().unwrap();
        let expired_view = items
            .iter()
            .find(|item| item["id"] == json!(expired.chain.id))
            .unwrap();
        assert_eq!(expired_view["blocked_code"], "chain.tls_cert_expired");
        assert!(expired_view["blocked_reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("已过期")));
        let nft_view = items
            .iter()
            .find(|item| item["id"] == json!(nft.chain.id))
            .unwrap();
        assert_eq!(nft_view["blocked_code"], "chain.nftables_unavailable");
        assert!(nft_view["blocked_reason"]
            .as_str()
            .is_some_and(|reason| reason.contains("nft")));
    }
}
