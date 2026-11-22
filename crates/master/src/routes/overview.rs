//! 概览聚合：`GET /api/v1/overview?days=7`（管理员）。
//!
//! 一个请求替代概览页原来并行的 4 个请求（KPI / 趋势 / 节点 / 链路），
//! 避免每块卡片各自 loading。SQL 全在 `pierwave_domain::repo::overview`；
//! 这里只做 `days` 解析与把仓储结果序列化成 JSON。
//!
//! 与旧接口的差异：`days` 非法（非整数或不在 1..=90）一律 400，错误码沿用
//! `query.*` 风格，而不是像 `/stats/traffic` 那样夹到边界。

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const DEFAULT_DAYS: i64 = 7;
const MAX_DAYS: i64 = 90;

/// 服务器态势的窗口上限：采样只保留 7 天，再大也查不到数据。
const HEALTH_MAX_HOURS: i64 = 168;
const HEALTH_DEFAULT_HOURS: i64 = 24;
/// 桶宽：最小 5 分钟（采样粒度），最大 1 天，必须是 5 分钟的整数倍。
const HEALTH_MIN_BUCKET: i64 = 300;
const HEALTH_MAX_BUCKET: i64 = 86_400;
const HEALTH_BUCKET_STEP: i64 = 300;
const HEALTH_DEFAULT_BUCKET: i64 = 3600;
/// 「异常服务器」阈值：24h 可用率低于 90%，或 24h 内最坏磁盘占用达到 90%。
const ABNORMAL_ONLINE_RATIO: f64 = 0.9;
const ABNORMAL_DISK_RATIO: f64 = 0.9;

#[derive(Deserialize)]
pub struct OverviewQuery {
    /// 天数；缺省 7，给值必须落在 1..=90。
    pub days: Option<String>,
}

pub async fn overview(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<OverviewQuery>,
) -> AppResult<(HeaderMap, Json<repo::overview::OverviewSnapshot>)> {
    user.require_admin()?;
    let days = parse_days(query.days.as_deref())?;
    let now = repo::now();
    let pool = &state.db.pool;

    // 流量派生的部分走 12 秒短缓存：key 只有 `days`，计费入账不主动失效，
    // 因此生产里持续上报也不会让缓存永远 miss。代价是最多 12 秒陈旧，
    // 计费/账单仍直接读原始账本。
    let (traffic, cache_hit) = match state.overview_traffic.get(days) {
        Some(traffic) => (traffic, true),
        None => {
            let traffic = repo::overview::traffic_snapshot(pool, now, days).await?;
            state.overview_traffic.put(days, traffic.clone());
            (traffic, false)
        }
    };
    let snapshot = repo::overview::compose(pool, now, days, traffic).await?;

    let mut headers = HeaderMap::new();
    // 响应是管理员专属且 /api/ 已带 no-store；`Vary: Cookie` 是给共享缓存
    // 的防御性提示，避免将来去掉 no-store 后把某个管理员的响应发给别人。
    headers.insert(header::VARY, HeaderValue::from_static("Cookie"));
    headers.insert(
        HeaderName::from_static("x-overview-cache"),
        HeaderValue::from_static(if cache_hit { "hit" } else { "miss" }),
    );
    Ok((headers, Json(snapshot)))
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

#[derive(Debug, Deserialize)]
pub struct ServerHealthQuery {
    /// 故意接成字符串：`hours=abc` 要返回带 code 的 400，而不是 axum 的纯文本。
    pub hours: Option<String>,
    pub bucket: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct ServerHealthSummary {
    /// 24h 全局可用率（按采样数加权）；窗口内没有采样时是 null，不是 0。
    online_ratio_24h: Option<f64>,
    /// 24h 可用率 < 90% 或最坏磁盘 >= 90% 的服务器数；没有采样的服务器不计。
    abnormal_servers: i64,
    /// 24h 内单次采样的最坏磁盘占用比；没有有效分母时是 null。
    worst_disk_ratio: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct ServerHealthBucketView {
    ts: i64,
    /// 该桶多数采样在线（`online_samples * 2 >= samples`，平局算在线）。
    online: bool,
    load1: f64,
    mem_ratio: Option<f64>,
    disk_ratio: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct ServerHealthServer {
    id: String,
    name: String,
    /// 请求窗口内的可用率；没有采样时是 null。
    online_ratio: Option<f64>,
    /// 固定长度 = `hours * 3600 / bucket`；没有采样的桶是 null。
    buckets: Vec<Option<ServerHealthBucketView>>,
}

#[derive(Debug, Clone, Serialize)]
struct ServerHealthResponse {
    generated_at: i64,
    hours: i64,
    bucket: i64,
    summary: ServerHealthSummary,
    servers: Vec<ServerHealthServer>,
}

/// `GET /api/v1/overview/server-health?hours=168&bucket=3600`（仅管理员）。
///
/// 聚合口径：
/// * 桶内 `online` 用**多数**（`AVG(online) >= 0.5`，平局算在线）；5 分钟采样下
///   平局只可能是偶数个采样，偏向在线与「可用率分母包含离线时段」的直觉一致；
/// * `load1/mem_ratio/disk_ratio` 取桶内平均；分母为 0 的采样不参与 mem/disk 平均；
/// * 没有采样的桶返回 `null`（不是 0）：0 会被前端画成「一切正常」；
/// * 一台服务器的 `buckets` 长度固定等于 `hours * 3600 / bucket`，空桶补 null；
/// * 24h 汇总独立于请求窗口：`hours=1` 时也能得到真实的 24h 可用率；
/// * 结果缓存 30 秒（key = `(hours, bucket)`），避免多管理员刷新时重复扫 7 天采样。
pub async fn server_health(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<ServerHealthQuery>,
) -> AppResult<(HeaderMap, Json<Value>)> {
    user.require_admin()?;
    let hours = parse_health_hours(query.hours.as_deref())?;
    let bucket = parse_health_bucket(query.bucket.as_deref(), hours)?;

    let (body, cache_hit) = match state.server_health.get(hours, bucket) {
        Some(value) => (value, true),
        None => {
            let value = build_server_health(&state, repo::now(), hours, bucket).await?;
            state.server_health.put(hours, bucket, value.clone());
            (value, false)
        }
    };

    let mut headers = HeaderMap::new();
    headers.insert(header::VARY, HeaderValue::from_static("Cookie"));
    headers.insert(
        HeaderName::from_static("x-server-health-cache"),
        HeaderValue::from_static(if cache_hit { "hit" } else { "miss" }),
    );
    Ok((headers, Json(body)))
}

async fn build_server_health(
    state: &AppState,
    now: i64,
    hours: i64,
    bucket: i64,
) -> AppResult<Value> {
    let pool = &state.db.pool;
    let count = hours * 3600 / bucket;
    let current = now - now.rem_euclid(bucket);
    let end = current + bucket;
    let start = end - count * bucket;

    // 两条查询都是「跨服务器一次 GROUP BY」：一条 24h 汇总，一条请求窗口的桶。
    // 不按服务器循环，服务器数增长时查询次数不变。
    let summary_rows = repo::server_samples::health_summary(pool, now - 86_400, now).await?;
    let bucket_rows = repo::server_samples::health_buckets(pool, start, end, bucket).await?;

    let mut total_samples = 0_i64;
    let mut total_online = 0_i64;
    let mut worst_disk_ratio: Option<f64> = None;
    let mut abnormal_servers = 0_i64;
    for row in &summary_rows {
        total_samples += row.samples;
        total_online += row.online_samples;
        if let Some(ratio) = row.worst_disk_ratio {
            worst_disk_ratio = Some(worst_disk_ratio.map_or(ratio, |worst| worst.max(ratio)));
        }
        let online_ratio = row.online_samples as f64 / row.samples.max(1) as f64;
        if online_ratio < ABNORMAL_ONLINE_RATIO
            || row
                .worst_disk_ratio
                .is_some_and(|ratio| ratio >= ABNORMAL_DISK_RATIO)
        {
            abnormal_servers += 1;
        }
    }

    let mut buckets_by_server: HashMap<String, Vec<Option<ServerHealthBucketView>>> =
        HashMap::new();
    let mut samples_by_server: HashMap<String, (i64, i64)> = HashMap::new();
    for row in bucket_rows {
        let index = (row.ts - start) / bucket;
        if !(0..count).contains(&index) {
            // 窗口边界外的行（理论上不会出现）不补进数组，避免下标越界。
            continue;
        }
        let sample_totals = samples_by_server
            .entry(row.server_id.clone())
            .or_insert((0, 0));
        sample_totals.0 += row.samples;
        sample_totals.1 += row.online_samples;
        let bucket = ServerHealthBucketView {
            ts: row.ts,
            online: row.online_samples * 2 >= row.samples,
            load1: row.load1,
            mem_ratio: row.mem_ratio,
            disk_ratio: row.disk_ratio,
        };
        buckets_by_server
            .entry(row.server_id)
            .or_insert_with(|| vec![None; count as usize])[index as usize] = Some(bucket);
    }

    let servers = repo::servers::list(pool)
        .await?
        .into_iter()
        .map(|server| {
            let (samples, online_samples) =
                samples_by_server.get(&server.id).copied().unwrap_or((0, 0));
            ServerHealthServer {
                id: server.id.clone(),
                name: server.name,
                online_ratio: (samples > 0).then(|| online_samples as f64 / samples as f64),
                buckets: buckets_by_server
                    .remove(&server.id)
                    .unwrap_or_else(|| vec![None; count as usize]),
            }
        })
        .collect();

    let response = ServerHealthResponse {
        generated_at: now,
        hours,
        bucket,
        summary: ServerHealthSummary {
            online_ratio_24h: (total_samples > 0)
                .then(|| total_online as f64 / total_samples as f64),
            abnormal_servers,
            worst_disk_ratio,
        },
        servers,
    };
    Ok(serde_json::to_value(response).unwrap_or(Value::Null))
}

fn parse_health_hours(raw: Option<&str>) -> AppResult<i64> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(HEALTH_DEFAULT_HOURS);
    };
    let hours = raw.parse::<i64>().map_err(|_| hours_invalid())?;
    if !(1..=HEALTH_MAX_HOURS).contains(&hours) {
        return Err(hours_invalid());
    }
    Ok(hours)
}

fn hours_invalid() -> AppError {
    AppError::coded(
        "query.server_health_hours_invalid",
        Some(json!({ "min": 1, "max": HEALTH_MAX_HOURS, "default": HEALTH_DEFAULT_HOURS })),
        format!(
            "hours 必须是 1-{HEALTH_MAX_HOURS} 的整数（默认 {HEALTH_DEFAULT_HOURS}） / \
             hours must be an integer between 1 and {HEALTH_MAX_HOURS}"
        ),
    )
}

fn parse_health_bucket(raw: Option<&str>, hours: i64) -> AppResult<i64> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(HEALTH_DEFAULT_BUCKET);
    };
    let bucket = raw.parse::<i64>().map_err(|_| bucket_invalid())?;
    if !(HEALTH_MIN_BUCKET..=HEALTH_MAX_BUCKET).contains(&bucket)
        || bucket % HEALTH_BUCKET_STEP != 0
        || (hours * 3600) % bucket != 0
    {
        return Err(bucket_invalid());
    }
    Ok(bucket)
}

fn bucket_invalid() -> AppError {
    AppError::coded(
        "query.server_health_bucket_invalid",
        Some(json!({
            "min": HEALTH_MIN_BUCKET,
            "max": HEALTH_MAX_BUCKET,
            "step": HEALTH_BUCKET_STEP,
            "default": HEALTH_DEFAULT_BUCKET,
            "rule": "bucket 必须能整除 hours*3600"
        })),
        format!(
            "bucket 必须是 {HEALTH_MIN_BUCKET}-{HEALTH_MAX_BUCKET} 之间 {HEALTH_BUCKET_STEP} 的倍数，\
             且能整除 hours*3600（默认 {HEALTH_DEFAULT_BUCKET}） / \
             bucket must be a multiple of {HEALTH_BUCKET_STEP} that divides hours*3600"
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, HeaderMap, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use tower::ServiceExt;

    use pierwave_domain::repo::{
        nodes, packages, servers, sessions, traffic, user_packages, users,
    };
    use pierwave_domain::time;
    use pierwave_domain::Db;

    use crate::state::{AppState, OverviewTrafficCache, OVERVIEW_TRAFFIC_CACHE_TTL};

    async fn setup() -> (Router, AppState, String) {
        setup_with("sqlite::memory:", OVERVIEW_TRAFFIC_CACHE_TTL).await
    }

    /// 指定数据库 URL 与概览缓存 TTL：真实写入场景用文件库 + 短 TTL，
    /// 避免 SQLite 共享内存库的并发锁干扰。
    async fn setup_with(db_url: &str, cache_ttl: Duration) -> (Router, AppState, String) {
        let db = Db::connect(db_url).await.unwrap();
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
        let mut state = AppState::new(db, "web/dist");
        state.overview_traffic = OverviewTrafficCache::with_ttl(cache_ttl);
        let app = crate::app::router(state.clone());
        (
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
        )
    }

    async fn request(app: &Router, cookie: Option<&str>, uri: &str) -> (StatusCode, Value) {
        let (status, _headers, value) = request_full(app, cookie, uri).await;
        (status, value)
    }

    /// 与 [`request`] 相同，但把响应头也带回来：缓存命中/失效测试要看
    /// `X-Overview-Cache`，不能只看 body。
    async fn request_full(
        app: &Router,
        cookie: Option<&str>,
        uri: &str,
    ) -> (StatusCode, HeaderMap, Value) {
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
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, headers, value)
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

    /// 概览缓存是 TTL 语义：计费入账不参与 key，最多陈旧一个 TTL；
    /// 只有管理员动作（恢复备份等）调用 `clear()` 才立即失效。
    ///
    /// 非流量部分不经过缓存，因此这里只断言 `kpi.traffic_today` 与
    /// `X-Overview-Cache`，避免把两条路径混在一起。
    #[tokio::test]
    async fn overview_traffic_snapshot_is_ttl_cached_and_clear_invalidates_it() {
        let (app, state, admin) = setup_with("sqlite::memory:", Duration::from_secs(1)).await;
        let today = time::business_date(repo::now());

        let (status, headers, body) =
            request_full(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(
            headers
                .get("x-overview-cache")
                .and_then(|value| value.to_str().ok()),
            Some("miss"),
            "第一次请求必须是冷查询"
        );
        assert_eq!(body["kpi"]["traffic_today"], 0);

        let (status, headers, body) =
            request_full(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(
            headers
                .get("x-overview-cache")
                .and_then(|value| value.to_str().ok()),
            Some("hit"),
            "第二次请求必须命中缓存"
        );
        assert_eq!(
            headers
                .get(axum::http::header::VARY)
                .and_then(|value| value.to_str().ok()),
            Some("Cookie"),
            "响应必须带 Vary: Cookie"
        );

        // 计费入账只写账本/日汇总，不主动清缓存：TTL 内仍命中，数字是旧的。
        repo::traffic::accumulate_daily(&state.db.pool, &today, "server-1", "u-1", 10, 20, 30)
            .await
            .unwrap();
        let (status, headers, body) =
            request_full(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(
            headers
                .get("x-overview-cache")
                .and_then(|value| value.to_str().ok()),
            Some("hit"),
            "TTL 内写流量不应让缓存失效"
        );
        assert_eq!(
            body["kpi"]["traffic_today"], 0,
            "TTL 内允许旧数字；账本本身已是 30"
        );

        // 管理员动作显式 clear：下一次请求立刻重建并看到新数字。
        state.overview_traffic.clear();
        let (status, headers, body) =
            request_full(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(
            headers
                .get("x-overview-cache")
                .and_then(|value| value.to_str().ok()),
            Some("miss"),
            "clear 之后必须 miss"
        );
        assert_eq!(body["kpi"]["traffic_today"], 30);

        // TTL 过期后自动重建。
        tokio::time::sleep(Duration::from_millis(1_100)).await;
        let (status, headers, body) =
            request_full(&app, Some(&admin), "/api/v1/overview?days=7").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(
            headers
                .get("x-overview-cache")
                .and_then(|value| value.to_str().ok()),
            Some("miss"),
            "超过 TTL 必须 miss"
        );
        assert_eq!(body["kpi"]["traffic_today"], 30);

        // 不同 days 用不同的缓存 key，不能把 7 天的结果当成 90 天返回。
        let (_, headers, body) = request_full(&app, Some(&admin), "/api/v1/overview?days=90").await;
        assert_eq!(
            headers
                .get("x-overview-cache")
                .and_then(|value| value.to_str().ok()),
            Some("miss"),
            "days 不同必须重建"
        );
        assert_eq!(body["series"].as_array().unwrap().len(), 90);
    }

    /// 真实写入场景：后台每 200ms 写一次 `traffic_daily`，同时连续请求概览 50 次。
    ///
    /// 旧策略把 `generation` 放进 key：每次写入代际都变，所以几乎每次都 miss。
    /// 新策略 key 只有 `days` + TTL：写入不失效，命中率应该 >= 80%。
    /// 请求间隔 250ms，整体跨过 12 秒 TTL，因此会包含至少一次正常的 TTL 重建。
    #[tokio::test]
    async fn overview_cache_holds_up_under_continuous_billing_writes() {
        let dir = std::env::temp_dir().join(format!(
            "pierwave-overview-cache-writes-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("db.sqlite");
        let db_url = format!("sqlite://{}?mode=rwc", db_path.display());
        let (app, state, admin) = setup_with(&db_url, OVERVIEW_TRAFFIC_CACHE_TTL).await;

        let stop = Arc::new(AtomicBool::new(false));
        let writer = tokio::spawn({
            let pool = state.db.pool.clone();
            let stop = stop.clone();
            let today = time::business_date(repo::now());
            async move {
                let mut writes = 0u64;
                while !stop.load(Ordering::SeqCst) {
                    traffic::accumulate_daily(&pool, &today, "server-1", "bench-writer", 1, 1, 2)
                        .await
                        .expect("后台写入 traffic_daily 失败");
                    writes += 1;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                writes
            }
        });

        // 旧策略的缓存实例：完全相同的 lookup 逻辑，只是 key 带 generation。
        let legacy = OverviewTrafficCache::with_ttl(OVERVIEW_TRAFFIC_CACHE_TTL);
        let mut new_hits = 0u32;
        let mut legacy_hits = 0u32;

        for _ in 0..50 {
            let (status, headers, _) =
                request_full(&app, Some(&admin), "/api/v1/overview?days=7").await;
            assert_eq!(status, StatusCode::OK);
            if headers
                .get("x-overview-cache")
                .and_then(|value| value.to_str().ok())
                == Some("hit")
            {
                new_hits += 1;
            }

            let generation = repo::traffic_rollup::generation(&state.db.pool)
                .await
                .unwrap();
            if legacy.get_generation_keyed(7, generation).is_none() {
                let snapshot = repo::overview::traffic_snapshot(&state.db.pool, repo::now(), 7)
                    .await
                    .unwrap();
                legacy.put_generation_keyed(7, generation, snapshot);
            } else {
                legacy_hits += 1;
            }

            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        stop.store(true, Ordering::SeqCst);
        let writes = writer.await.unwrap();
        println!(
            "持续写入场景：后台写入 {writes} 次，TTL-only 命中 {new_hits}/50，\
             generation-keyed 命中 {legacy_hits}/50"
        );

        assert!(
            writes >= 20,
            "后台 200ms 写入在 12.5 秒内应至少 20 次，实际 {writes}"
        );
        assert!(
            new_hits >= 40,
            "TTL-only 缓存在持续写入下命中率应 >= 80%，实际 {new_hits}/50"
        );
        assert!(
            legacy_hits <= 2,
            "generation 作为 key 时持续写入下命中率应接近 0，实际 {legacy_hits}/50"
        );

        drop(app);
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 服务器态势：GET /api/v1/overview/server-health ----

    /// 一台服务器的样本：先写健康字段（`update_health` 会把状态置 online），
    /// 再按需要改成 offline，最后让采样器抄进 `server_samples`。
    async fn seed_health_sample(
        pool: &sqlx::SqlitePool,
        server_id: &str,
        ts: i64,
        online: bool,
        load1: f64,
        mem: (i64, i64),
        disk: (i64, i64),
    ) {
        servers::update_health(
            pool,
            server_id,
            "1.0.0",
            &servers::HealthSnapshot {
                load1,
                mem_used: mem.0,
                mem_total: mem.1,
                disk_used: disk.0,
                disk_total: disk.1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        if online {
            servers::mark_online(pool, server_id).await.unwrap();
        } else {
            servers::mark_offline(pool, server_id).await.unwrap();
        }
        repo::server_samples::record_round(pool, ts).await.unwrap();
    }

    fn hour_before(now: i64, hours: i64) -> i64 {
        let current = now - now.rem_euclid(3600);
        current - hours * 3600
    }

    #[tokio::test]
    async fn server_health_empty_database_is_all_null_not_zero() {
        let (app, state, admin) = setup().await;

        let (status, _, body) = request_full(
            &app,
            Some(&admin),
            "/api/v1/overview/server-health?hours=24&bucket=3600",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["hours"], 24);
        assert_eq!(body["bucket"], 3600);
        assert!(body["generated_at"].as_i64().unwrap() > 0);
        assert!(body["summary"]["online_ratio_24h"].is_null(), "{body}");
        assert!(body["summary"]["worst_disk_ratio"].is_null(), "{body}");
        assert_eq!(body["summary"]["abnormal_servers"], 0);
        assert!(body["servers"].as_array().unwrap().is_empty());

        // 有服务器但从未采样：buckets 仍然固定长度、全部 null。
        let (server, _) = servers::create(&state.db.pool, "香港-01", "10.0.0.1", "external")
            .await
            .unwrap();
        let (status, _, body) = request_full(
            &app,
            Some(&admin),
            "/api/v1/overview/server-health?hours=168&bucket=3600",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let rows = body["servers"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], server.id);
        assert_eq!(rows[0]["name"], "香港-01");
        assert!(rows[0]["online_ratio"].is_null());
        let buckets = rows[0]["buckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 168, "buckets 长度固定 = hours");
        assert!(
            buckets.iter().all(Value::is_null),
            "没有采样必须是 null，不能是 0"
        );
    }

    #[tokio::test]
    async fn server_health_aggregates_partial_samples_and_applies_the_online_threshold() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let now = repo::now();
        let (server, _) = servers::create(pool, "香港-01", "10.0.0.1", "external")
            .await
            .unwrap();

        // 上一个小时：1 在线 + 1 离线 = 0.5，平局算在线。
        let tie_hour = hour_before(now, 2);
        seed_health_sample(
            pool,
            &server.id,
            tie_hour + 300,
            true,
            1.0,
            (50, 100),
            (20, 100),
        )
        .await;
        seed_health_sample(
            pool,
            &server.id,
            tie_hour + 600,
            false,
            3.0,
            (25, 100),
            (40, 100),
        )
        .await;
        // 当前小时之前一小时：1 在线 + 2 离线 = 0.333，判离线。
        let down_hour = hour_before(now, 1);
        seed_health_sample(
            pool,
            &server.id,
            down_hour + 300,
            true,
            2.0,
            (30, 100),
            (60, 100),
        )
        .await;
        seed_health_sample(
            pool,
            &server.id,
            down_hour + 600,
            false,
            2.0,
            (0, 0),
            (0, 0),
        )
        .await;
        seed_health_sample(
            pool,
            &server.id,
            down_hour + 900,
            false,
            2.0,
            (40, 100),
            (80, 100),
        )
        .await;

        let (status, _, body) = request_full(
            &app,
            Some(&admin),
            "/api/v1/overview/server-health?hours=24&bucket=3600",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let row = &body["servers"][0];
        let buckets = row["buckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 24);

        // 当前小时（最后一项）没有采样 = null；我们种的是倒数第 3、2 项。
        assert!(buckets[23].is_null(), "{body}");
        let tie = &buckets[21];
        assert_eq!(tie["online"], true, "0.5 平局算在线：{body}");
        assert!((tie["load1"].as_f64().unwrap() - 2.0).abs() < 1e-9);
        assert!((tie["mem_ratio"].as_f64().unwrap() - 0.375).abs() < 1e-9);
        assert!((tie["disk_ratio"].as_f64().unwrap() - 0.30).abs() < 1e-9);

        let down = &buckets[22];
        assert_eq!(down["online"], false, "1/3 在线必须判离线：{body}");
        assert!(
            (down["mem_ratio"].as_f64().unwrap() - 0.35).abs() < 1e-9,
            "分母为 0 的采样不参与平均：{body}"
        );

        // 窗口可用率 = 2 在线 / 5 采样。
        assert!((row["online_ratio"].as_f64().unwrap() - 0.4).abs() < 1e-9);
        assert!((body["summary"]["online_ratio_24h"].as_f64().unwrap() - 0.4).abs() < 1e-9);
        assert_eq!(
            body["summary"]["abnormal_servers"], 1,
            "可用率 40% < 90%，必须计入异常"
        );
        assert!((body["summary"]["worst_disk_ratio"].as_f64().unwrap() - 0.8).abs() < 1e-9);

        // hours=168 时同一批样本落在固定 168 项数组的末尾三格。
        let (status, _, body) = request_full(
            &app,
            Some(&admin),
            "/api/v1/overview/server-health?hours=168&bucket=3600",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let buckets = body["servers"][0]["buckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 168);
        assert_eq!(buckets[165]["online"], true);
        assert_eq!(buckets[166]["online"], false);
        assert!(buckets[167].is_null());
    }

    #[tokio::test]
    async fn server_health_bucket_length_follows_hours_and_bucket_width() {
        let (app, state, admin) = setup().await;
        servers::create(&state.db.pool, "香港-01", "10.0.0.1", "external")
            .await
            .unwrap();

        for (hours, bucket, expected) in [
            (24, 3600, 24),
            (168, 3600, 168),
            (168, 86_400, 7),
            (1, 1800, 2),
            (1, 300, 12),
        ] {
            let uri = format!("/api/v1/overview/server-health?hours={hours}&bucket={bucket}");
            let (status, _, body) = request_full(&app, Some(&admin), &uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}: {body}");
            assert_eq!(body["hours"], hours, "{uri}");
            assert_eq!(body["bucket"], bucket, "{uri}");
            let buckets = body["servers"][0]["buckets"].as_array().unwrap();
            assert_eq!(
                buckets.len(),
                expected,
                "{uri}: buckets 长度 = hours*3600/bucket"
            );
            assert!(
                buckets.iter().all(Value::is_null),
                "{uri}: 没有采样必须为 null"
            );
        }
    }

    #[tokio::test]
    async fn server_health_rejects_out_of_range_parameters_with_400() {
        let (app, _state, admin) = setup().await;

        for (query, code) in [
            ("hours=0", "query.server_health_hours_invalid"),
            ("hours=169", "query.server_health_hours_invalid"),
            ("hours=-1", "query.server_health_hours_invalid"),
            ("hours=abc", "query.server_health_hours_invalid"),
            ("hours=1.5", "query.server_health_hours_invalid"),
            ("bucket=0", "query.server_health_bucket_invalid"),
            ("bucket=123", "query.server_health_bucket_invalid"),
            ("bucket=90000", "query.server_health_bucket_invalid"),
            // 7200 不能整除 1 小时的窗口。
            ("hours=1&bucket=7200", "query.server_health_bucket_invalid"),
            ("hours=24&bucket=abc", "query.server_health_bucket_invalid"),
        ] {
            let uri = format!("/api/v1/overview/server-health?{query}");
            let (status, _, body) = request_full(&app, Some(&admin), &uri).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}: {body}");
            assert_eq!(body["code"], code, "{uri}: {body}");
        }
    }

    #[tokio::test]
    async fn server_health_requires_admin() {
        let (app, state, _admin) = setup().await;

        let (status, _, body) = request_full(&app, None, "/api/v1/overview/server-health").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "body: {body}");

        let plain = add_user(&state.db.pool, "plain").await;
        let (token, _) = sessions::create(&state.db.pool, &plain, 3600, None)
            .await
            .unwrap();
        let cookie = format!("{}={token}", crate::auth::SESSION_COOKIE);
        let (status, _, body) = request_full(
            &app,
            Some(&cookie),
            "/api/v1/overview/server-health?hours=24",
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "body: {body}");
    }

    #[tokio::test]
    async fn server_health_is_cached_for_30_seconds_per_parameter_pair() {
        let (app, state, admin) = setup().await;

        let (status, headers, body) = request_full(
            &app,
            Some(&admin),
            "/api/v1/overview/server-health?hours=24&bucket=3600",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(
            headers
                .get("x-server-health-cache")
                .and_then(|value| value.to_str().ok()),
            Some("miss")
        );
        assert_eq!(
            headers
                .get(header::VARY)
                .and_then(|value| value.to_str().ok()),
            Some("Cookie")
        );

        // 同参数第二次必须命中；缓存的是整份 body，连 generated_at 都一致。
        let (status, headers, cached) = request_full(
            &app,
            Some(&admin),
            "/api/v1/overview/server-health?hours=24&bucket=3600",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers
                .get("x-server-health-cache")
                .and_then(|value| value.to_str().ok()),
            Some("hit")
        );
        assert_eq!(cached, body);

        // 不同 hours 是不同的 key，必须重新聚合。
        let (status, headers, _) = request_full(
            &app,
            Some(&admin),
            "/api/v1/overview/server-health?hours=168&bucket=3600",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers
                .get("x-server-health-cache")
                .and_then(|value| value.to_str().ok()),
            Some("miss")
        );

        assert_eq!(state.server_health.stats(), (1, 2), "1 次命中、2 次未命中");
    }
}
