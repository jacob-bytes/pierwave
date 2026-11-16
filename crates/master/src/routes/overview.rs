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

    use pierwave_domain::repo::{
        nodes, packages, servers, sessions, traffic, user_packages, users,
    };
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
                subscription_template_id: None,
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

    async fn add_node(
        pool: &sqlx::SqlitePool,
        server_id: &str,
        tag: &str,
        protocol: &str,
    ) -> String {
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
                tags: Vec::new(),
                region: None,
            },
        )
        .await
        .unwrap()
        .id
    }

    async fn seed_node_traffic(
        pool: &sqlx::SqlitePool,
        day: &str,
        server_id: &str,
        node_tag: &str,
        uplink: i64,
        downlink: i64,
    ) {
        traffic::accumulate_node_daily(
            pool,
            day,
            server_id,
            traffic::NodeTrafficDelta {
                node_tag,
                user_id: "",
                uplink: uplink as u64,
                downlink: downlink as u64,
                weighted: (uplink + downlink) as u64,
            },
        )
        .await
        .unwrap();
    }

    async fn create_package(
        pool: &sqlx::SqlitePool,
        name: &str,
    ) -> pierwave_domain::models::Package {
        packages::create(
            pool,
            packages::NewPackage {
                name: name.into(),
                quota_bytes: Some(10_000),
                period_days: Some(30),
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,
                subscription_template_id: None,
                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap()
    }

    async fn bind_package(
        pool: &sqlx::SqlitePool,
        user_id: &str,
        package: &pierwave_domain::models::Package,
    ) -> String {
        user_packages::create(
            pool,
            user_id,
            user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            package,
        )
        .await
        .unwrap()
        .id
    }

    async fn add_user(pool: &sqlx::SqlitePool, username: &str) -> String {
        users::create(
            pool,
            users::NewUser {
                username: username.into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
            },
        )
        .await
        .unwrap()
        .id
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
        assert_eq!(
            keys,
            vec![
                "chains",
                "kpi",
                "package_split",
                "protocol_series",
                "protocols",
                "series",
                "top",
                "top_nodes",
                "top_users",
            ]
        );

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

        // 协议趋势：历史 `user@tag` 行按 tag 兜底归因；每天补 0、按下行降序。
        let protocol_series = body["protocol_series"].as_array().unwrap();
        assert_eq!(protocol_series.len(), 2);
        assert_eq!(protocol_series[0]["protocol"], "unknown");
        let unknown_days = protocol_series[0]["days"].as_array().unwrap();
        assert_eq!(unknown_days.len(), 7);
        assert_eq!(unknown_days.last().unwrap()["day"], today);
        assert_eq!(unknown_days.last().unwrap()["bytes"], 5);
        assert_eq!(protocol_series[1]["protocol"], "vless");
        assert_eq!(
            protocol_series[1]["days"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["bytes"],
            2
        );
        // 这个用例的流量 subject 都是历史格式，关联不到 users.id。
        assert!(body["top_users"].as_array().unwrap().is_empty());
        // 没有 traffic_node_daily 切片 / 套餐实例：两张新卡必须是空数组，不能补 0。
        assert!(body["top_nodes"].as_array().unwrap().is_empty());
        assert!(body["package_split"].as_array().unwrap().is_empty());

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
        assert!(
            top[0]["server_id"]
                .as_str()
                .is_some_and(|id| !id.is_empty()),
            "Top 行必须带服务器 id：{body}"
        );
        assert!(
            top[0]["rates"].as_array().unwrap().is_empty(),
            "没有采样时 rates 必须是空数组，不能补 0：{body}"
        );
    }

    /// 概览 Top 服务器的 sparkline 序列通过 HTTP 契约下发：
    /// 有采样时返回 `rates[]`，每点是 `{ ts, rx_bps, tx_bps }`。
    #[tokio::test]
    async fn overview_top_servers_carry_rate_series_points() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;

        let (server, _) = servers::create(pool, "香港-01", "10.0.0.1", "external")
            .await
            .unwrap();
        // 两次计数上报：建立基线 → 60 秒 +5 MB / +1 MB。
        let now = repo::now();
        repo::servers::update_net_counters(pool, &server.id, 1_000, 2_000, now)
            .await
            .unwrap();
        repo::servers::update_net_counters(
            pool,
            &server.id,
            1_000 + 5_000_000,
            2_000 + 1_000_000,
            now + 60,
        )
        .await
        .unwrap();
        // 采样调度器把当前速率抄进 server_samples。
        repo::server_samples::record_round(pool, now).await.unwrap();

        let (status, body) = request(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let rates = body["top"][0]["rates"].as_array().unwrap();
        assert_eq!(rates.len(), 1, "{body}");
        let point = &rates[0];
        assert_eq!(point["ts"], now - now.rem_euclid(300), "{body}");
        let rx = point["rx_bps"].as_f64().unwrap();
        let tx = point["tx_bps"].as_f64().unwrap();
        assert!((rx - 5_000_000.0 / 60.0).abs() < 1e-6, "{body}");
        assert!((tx - 1_000_000.0 / 60.0).abs() < 1e-6, "{body}");
    }

    /// Top 用户按 `traffic_daily.subject = users.id` 直接关联：subject 是纯
    /// user_id（不是 `user@tag`），归因失败的原始 email 不参与排名。
    #[tokio::test]
    async fn overview_top_users_uses_user_id_subjects() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;

        let bob = users::create(
            pool,
            users::NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
            },
        )
        .await
        .unwrap();
        let today = time::business_date(repo::now());
        traffic::accumulate_daily(pool, &today, "server-1", &bob.id, 100, 50, 150)
            .await
            .unwrap();
        traffic::accumulate_daily(pool, &today, "server-1", "ghost@node", 999, 999, 1998)
            .await
            .unwrap();
        // 窗口外的用户：7 天榜不该出现，90 天榜里应该出现。
        let carol = users::create(
            pool,
            users::NewUser {
                username: "carol".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
                subscription_template_id: None,
            },
        )
        .await
        .unwrap();
        let long_ago = time::business_date(repo::now() - 30 * 86_400);
        traffic::accumulate_daily(pool, &long_ago, "server-1", &carol.id, 500, 500, 1000)
            .await
            .unwrap();

        let (status, body) = request(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");

        let rows = body["top_users"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "原始 email 与窗口外用户都不能进榜");
        assert_eq!(rows[0]["user_id"], bob.id);
        assert_eq!(rows[0]["username"], "bob");
        assert_eq!(rows[0]["traffic_7d"], 150, "原始上下行之和");

        let (status, body) = request(&app, Some(&admin), "/api/v1/overview?days=90").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let rows = body["top_users"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["username"], "carol");
        assert_eq!(rows[0]["traffic_7d"], 1000);
    }

    /// 节点流量 Top：按 `traffic_node_daily` 的 `(server_id, node_tag)` 聚合，
    /// JOIN `nodes` / `servers` 补齐名称与协议；无流量、已删除节点都不补 0。
    #[tokio::test]
    async fn overview_top_nodes_aggregate_and_sort_without_filling_zero() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;

        let (hk, _) = servers::create(pool, "香港-01", "10.0.0.1", "external")
            .await
            .unwrap();
        let (jp, _) = servers::create(pool, "日本-01", "10.0.0.2", "external")
            .await
            .unwrap();
        let today = time::business_date(repo::now());

        let vless_hk = add_node(pool, &hk.id, "hk-vless", "vless").await;
        let trojan_hk = add_node(pool, &hk.id, "hk-trojan", "trojan").await;
        let vmess_jp = add_node(pool, &jp.id, "jp-vmess", "vmess").await;
        let vless_jp = add_node(pool, &jp.id, "jp-vless", "vless").await;
        // 有节点但窗口内没有流量：不能出现在 Top 里。
        add_node(pool, &hk.id, "hk-idle", "vless").await;

        seed_node_traffic(pool, &today, &hk.id, "hk-vless", 100, 50).await;
        seed_node_traffic(pool, &today, &hk.id, "hk-trojan", 200, 100).await;
        // 同一天同一节点分两个用户切片：必须合并后再排序。
        seed_node_traffic(pool, &today, &jp.id, "jp-vmess", 120, 80).await;
        seed_node_traffic(pool, &today, &jp.id, "jp-vless", 30, 20).await;
        // 已删除节点：JOIN 不到 nodes，不能进榜。
        let ghost = add_node(pool, &hk.id, "hk-ghost", "vless").await;
        seed_node_traffic(pool, &today, &hk.id, "hk-ghost", 9_999, 9_999).await;
        nodes::delete(pool, &ghost).await.unwrap();

        let (status, body) = request(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");

        let rows = body["top_nodes"].as_array().unwrap();
        assert_eq!(rows.len(), 4, "无流量节点与已删除节点都不进榜：{body}");
        assert_eq!(rows[0]["node_id"], trojan_hk);
        assert_eq!(rows[0]["name"], "hk-trojan");
        assert_eq!(rows[0]["protocol"], "trojan");
        assert_eq!(rows[0]["server_name"], "香港-01");
        assert_eq!(rows[0]["traffic_7d"], 300);
        assert_eq!(rows[1]["node_id"], vmess_jp);
        assert_eq!(rows[1]["traffic_7d"], 200);
        assert_eq!(rows[2]["node_id"], vless_hk);
        assert_eq!(rows[2]["traffic_7d"], 150);
        assert_eq!(rows[3]["node_id"], vless_jp);
        assert_eq!(rows[3]["traffic_7d"], 50);
        assert!(
            rows.iter()
                .all(|row| row["traffic_7d"].as_i64().unwrap() > 0),
            "不能为了凑数补 0：{body}"
        );

        // 窗口外（30 天前）的流量不计入 7 天榜。
        let long_ago = time::business_date(repo::now() - 30 * 86_400);
        seed_node_traffic(pool, &long_ago, &hk.id, "hk-vless", 10_000, 10_000).await;
        let (_, body) = request(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(body["top_nodes"][2]["traffic_7d"], 150, "{body}");
    }

    /// 套餐用量分布：`traffic_daily.subject` 按 user id 归到「当前套餐」；
    /// 一个用户多张卡时只归最近一条，避免同一份流量被重复计数。
    #[tokio::test]
    async fn overview_package_split_attributes_each_user_to_one_package() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;

        let month = create_package(pool, "月卡").await;
        let quarter = create_package(pool, "季卡").await;
        let today = time::business_date(repo::now());

        let alice = add_user(pool, "alice").await;
        let bob = add_user(pool, "bob").await;
        let carol = add_user(pool, "carol").await;
        let dave = add_user(pool, "dave").await;

        // alice 先买月卡、后换季卡：流量只算到季卡。
        bind_package(pool, &alice, &month).await;
        bind_package(pool, &alice, &quarter).await;
        bind_package(pool, &bob, &month).await;
        // carol 有月卡但窗口内没有流量：不能把月卡的 users 算成 2。
        bind_package(pool, &carol, &month).await;
        // dave 没有套餐：他的流量不能出现在任何套餐下。

        for (user, uplink, downlink) in [
            (&alice, 60, 40),
            (&bob, 300, 200),
            (&carol, 0, 0),
            (&dave, 999, 999),
        ] {
            traffic::accumulate_daily(
                pool,
                &today,
                "server-1",
                user,
                uplink,
                downlink,
                uplink + downlink,
            )
            .await
            .unwrap();
        }

        let (status, body) = request(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");

        let rows = body["package_split"].as_array().unwrap();
        assert_eq!(rows.len(), 2, "无流量的套餐不进榜：{body}");
        assert_eq!(rows[0]["package_id"], month.id);
        assert_eq!(rows[0]["name"], "月卡");
        assert_eq!(rows[0]["users"], 1, "只有真正有流量的 bob：{body}");
        assert_eq!(rows[0]["traffic_7d"], 500);
        assert_eq!(rows[1]["package_id"], quarter.id);
        assert_eq!(rows[1]["users"], 1);
        assert_eq!(rows[1]["traffic_7d"], 100);

        // 不同套餐的排序按流量降序，而不是按创建顺序。
        assert!(rows[0]["traffic_7d"].as_i64() > rows[1]["traffic_7d"].as_i64());
    }

    /// 两张新卡都有 5 条上限：第 6 名之后的真实数据直接截断，不补 0。
    #[tokio::test]
    async fn overview_top_nodes_and_packages_are_capped_at_five() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let (server, _) = servers::create(pool, "cap", "10.0.0.9", "external")
            .await
            .unwrap();
        let today = time::business_date(repo::now());

        for index in 0..6 {
            let tag = format!("node-{index}");
            add_node(pool, &server.id, &tag, "vless").await;
            seed_node_traffic(pool, &today, &server.id, &tag, (index + 1) as i64 * 10, 0).await;

            let package = create_package(pool, &format!("套餐-{index}")).await;
            let user = add_user(pool, &format!("user-{index}")).await;
            bind_package(pool, &user, &package).await;
            let traffic = (6 - index) as u64 * 100;
            traffic::accumulate_daily(pool, &today, "server-1", &user, traffic, 0, traffic)
                .await
                .unwrap();
        }

        let (status, body) = request(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");

        let nodes = body["top_nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 5);
        let node_traffic: Vec<i64> = nodes
            .iter()
            .map(|row| row["traffic_7d"].as_i64().unwrap())
            .collect();
        assert_eq!(node_traffic, vec![60, 50, 40, 30, 20]);

        let packages = body["package_split"].as_array().unwrap();
        assert_eq!(packages.len(), 5);
        let package_traffic: Vec<i64> = packages
            .iter()
            .map(|row| row["traffic_7d"].as_i64().unwrap())
            .collect();
        assert_eq!(package_traffic, vec![600, 500, 400, 300, 200]);
        assert!(
            packages.iter().all(|row| row["users"] == 1),
            "每张卡都只有一个用户：{body}"
        );
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
                subscription_template_id: None,
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
        assert!(body["protocol_series"].as_array().unwrap().is_empty());
        assert!(body["top"].as_array().unwrap().is_empty());
        assert!(body["top_users"].as_array().unwrap().is_empty());
        assert!(body["top_nodes"].as_array().unwrap().is_empty());
        assert!(body["package_split"].as_array().unwrap().is_empty());
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
                proxy_protocol: false,
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
                probe_attempts: None,
                probe_failures: None,
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
                proxy_protocol: false,
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
                proxy_protocol: false,
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
                proxy_protocol: false,
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
