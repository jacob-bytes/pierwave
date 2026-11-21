//! 探针公开页：`GET /api/v1/public/status`（无需登录）。
//!
//! 响应形状与 `docs/PLAN.md`「P10：探针公开页」一致，只读、只暴露白名单字段。
//! 采样聚合全部走 `pierwave_domain::repo::server_samples`，这里只负责把行拼成
//! 24 个小时桶 / 12 个 5 分钟迷你图桶并做 30 秒进程内缓存。
//!
//! `series` 是纯增量字段：窗口 60 分钟、12 个 5 分钟桶，缺桶补 `null`（不是 0）。
//! 口径见 `docs/PUBLIC-STATUS.md`。

use std::collections::{BTreeMap, HashMap};

use axum::extract::State;
use axum::Json;
use serde::Serialize;
use serde_json::Value;

use pierwave_domain::billing::BillingMeta;
use pierwave_domain::models::PublicSummary;
use pierwave_domain::repo;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const HOUR_SECS: i64 = 3_600;
const BUCKETS_24H: usize = 24;

/// 公开页迷你图窗口：60 分钟。
const SERIES_WINDOW_SECS: i64 = 3_600;
/// 迷你图桶宽：5 分钟，与采样粒度一致。
const SERIES_STEP_SECS: i64 = 300;
/// 12 个桶 × 5 分钟 = 60 分钟。
const SERIES_BUCKETS: usize = 12;

/// 单台服务器的公开行：字段即白名单，绝不包含地址、token、用户数、套餐、证书。
#[derive(Debug, Serialize)]
struct PublicServer {
    id: String,
    name: String,
    online: bool,
    xray_running: Option<bool>,
    load1: Option<f64>,
    mem_used: Option<i64>,
    mem_total: Option<i64>,
    disk_used: Option<i64>,
    disk_total: Option<i64>,
    uptime_secs: Option<i64>,
    last_seen: Option<i64>,
    /// 最近一次由两次心跳算出的当前速率（字节/秒）；没有可用数据（旧 Agent、
    /// 首次心跳、计数回绕被丢弃）为 null。前端显示 `—`，绝不显示 0。
    net_rx_bps: Option<f64>,
    /// 同 [`PublicServer::net_rx_bps`]，发送方向。
    net_tx_bps: Option<f64>,
    /// Agent 上报的**累计**接收字节（自开机以来，非 `lo` 网卡）。
    ///
    /// 取的是 `servers.net_rx_bytes` 基线列 —— 它就是最近一次心跳的累计值，
    /// 不是计费流量。服务器重启后计数会归零，所以页面标注「自开机以来」，
    /// 不把它说成「总流量」。
    net_rx_bytes: Option<i64>,
    /// 同 [`PublicServer::net_rx_bytes`]，发送方向。
    net_tx_bytes: Option<i64>,
    /// Agent 到公网探测目标的 TCP 握手 RTT（毫秒）；探测失败或旧 Agent 为 null。
    latency_ms: Option<i64>,
    /// 管理员填写的国家/地区代码（ISO 3166-1 alpha-2）；未填写为 null。
    country_code: Option<String>,
    /// 管理员填写的分组名；未分组为 null。公开页用它做分组筛选，分组名本来就在 `groups` 里出现过。
    group_name: Option<String>,
    /// 管理员填写的到期日（`YYYY-MM-DD`）；未填写或存量值非法为 null。
    ///
    /// 公开字段：填了就对所有人可见，所以文档明确提示「不想公开就不要填」。
    paid_until: Option<String>,
    /// 管理员填写的价格（分）；未填写或存量值非法为 null。
    price_cents: Option<i64>,
    /// 管理员填写的币种（3 位大写字母）；未填写或存量值非法为 null。
    currency: Option<String>,
    /// 管理员填写的计费周期（monthly / yearly / once）；未填写或存量值非法为 null。
    billing_cycle: Option<String>,
    /// Agent 上报的发行版名称；旧 Agent 或读不到为 null。
    os_name: Option<String>,
    /// Agent 上报的发行版版本；旧 Agent 或读不到为 null。
    os_version: Option<String>,
    /// Agent 上报的虚拟化类型；裸机或读不到为 null。
    virt: Option<String>,
    /// Agent 上报的 CPU 架构；旧 Agent 为空串。
    arch: String,
    /// 0..1；窗口内没有采样时为 null。
    uptime_24h: Option<f64>,
    /// 0..1；窗口内没有采样时为 null。
    uptime_7d: Option<f64>,
    /// 固定 24 个元素，从最早的小时到当前小时；没有采样的小时为 null。
    buckets_24h: Vec<Option<PublicBucket>>,
}

#[derive(Debug, Serialize)]
struct PublicBucket {
    ts: i64,
    online_ratio: f64,
}

#[derive(Debug, Serialize)]
struct PublicStatus {
    panel_name: String,
    generated_at: i64,
    summary: PublicSummary,
    servers: Vec<PublicServer>,
    /// 按 `servers.group_name` 聚合；未分组是 `name: null`，按名称升序。
    groups: Vec<PublicGroup>,
    /// 三张迷你图的历史序列（纯增量字段，旧客户端忽略）。
    series: PublicSeries,
}

/// 公开页三张迷你图的数据：固定 12 个 5 分钟桶，缺桶补 `null`。
#[derive(Debug, Serialize)]
struct PublicSeries {
    /// 窗口长度（秒），固定 3600。
    window_secs: i64,
    /// 桶宽（秒），固定 300，与 5 分钟采样一致。
    step_secs: i64,
    /// 桶起点，升序，长度固定 12。
    t: Vec<i64>,
    /// 每个桶内所有**在线**机器的接收速率之和（字节/秒）；
    /// 该桶没有在线采样、或在线样本全都没有速率时是 `null`，不是 0。
    rate_rx_bps: Vec<Option<f64>>,
    /// 同 [`PublicSeries::rate_rx_bps`]，发送方向。
    rate_tx_bps: Vec<Option<f64>>,
    /// 每个桶内在线机器延迟的算术平均（整数毫秒）；没有有效延迟时是 `null`。
    latency_ms: Vec<Option<i64>>,
}

/// 一个分组的公开聚合。`uptime_24h` 是组内各服务器可用率的算术平均；
/// 组内没有任何采样时是 `null`，不是 0。
#[derive(Debug, Serialize)]
struct PublicGroup {
    name: Option<String>,
    servers: i64,
    online: i64,
    uptime_24h: Option<f64>,
}

#[derive(Debug, Default)]
struct GroupAccumulator {
    servers: i64,
    online: i64,
    uptime_sum: f64,
    uptime_count: i64,
}

/// 24 个小时桶的起点，升序：`now` 所在小时及其之前 23 个小时。
fn hour_bucket_starts(now: i64) -> Vec<i64> {
    let current = now - now.rem_euclid(HOUR_SECS);
    (0..BUCKETS_24H)
        .rev()
        .map(|back| current - back as i64 * HOUR_SECS)
        .collect()
}

/// 12 个 5 分钟桶的起点，升序：`now` 所在桶及其之前 11 个桶。
///
/// 与 [`hour_bucket_starts`] 同一个约定：最后一个桶是**当前**桶（可能只过了一部分），
/// 因此 `now - 3600` 这类「刚好 60 分钟前」的采样会落在窗口外，不会挤进第一个桶。
fn series_bucket_starts(now: i64) -> Vec<i64> {
    let current = now - now.rem_euclid(SERIES_STEP_SECS);
    (0..SERIES_BUCKETS)
        .rev()
        .map(|back| current - back as i64 * SERIES_STEP_SECS)
        .collect()
}

pub async fn status(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let settings = crate::routes::settings::load(&state.db).await;
    if settings.public_status_enabled == 0 {
        return Err(AppError::not_found(
            "public_status.disabled",
            None,
            "公开状态页已关闭",
        ));
    }

    // 开关判断必须在缓存之前：关闭后即使有旧缓存也必须立刻 404。
    if let Some(cached) = state.public_status.get() {
        return Ok(Json(cached));
    }

    let now = repo::now();
    let summary = repo::stats::public_summary(&state.db.pool, now).await?;
    let servers = repo::servers::list(&state.db.pool).await?;

    let uptimes: HashMap<String, _> = repo::server_samples::uptime_all(&state.db.pool, now)
        .await?
        .into_iter()
        .map(|row| (row.server_id.clone(), row))
        .collect();

    let current_hour = now - now.rem_euclid(HOUR_SECS);
    let mut buckets: HashMap<String, HashMap<i64, f64>> = HashMap::new();
    for row in repo::server_samples::hourly_buckets(
        &state.db.pool,
        current_hour - (BUCKETS_24H as i64 - 1) * HOUR_SECS,
        current_hour + HOUR_SECS,
    )
    .await?
    {
        buckets
            .entry(row.server_id)
            .or_default()
            .insert(row.ts, row.online_ratio);
    }

    let starts = hour_bucket_starts(now);

    // 迷你图：一次 SQL 聚合整个 60 分钟窗口，缺桶补 null。
    let series_starts = series_bucket_starts(now);
    let mut series_rows: HashMap<i64, _> = HashMap::new();
    for row in repo::server_samples::series_buckets(
        &state.db.pool,
        series_starts[0],
        series_starts[SERIES_BUCKETS - 1] + SERIES_STEP_SECS,
    )
    .await?
    {
        series_rows.insert(row.ts, row);
    }
    let series = PublicSeries {
        window_secs: SERIES_WINDOW_SECS,
        step_secs: SERIES_STEP_SECS,
        t: series_starts.clone(),
        rate_rx_bps: series_starts
            .iter()
            .map(|ts| series_rows.get(ts).and_then(|row| row.rate_rx_bps))
            .collect(),
        rate_tx_bps: series_starts
            .iter()
            .map(|ts| series_rows.get(ts).and_then(|row| row.rate_tx_bps))
            .collect(),
        latency_ms: series_starts
            .iter()
            .map(|ts| series_rows.get(ts).and_then(|row| row.latency_ms))
            .collect(),
    };

    let mut group_accumulators: BTreeMap<Option<String>, GroupAccumulator> = BTreeMap::new();
    let servers = servers
        .into_iter()
        .map(|server| {
            let uptime = uptimes.get(&server.id);
            let uptime_24h = uptime.and_then(|row| row.uptime_24h);
            let group = group_accumulators
                .entry(server.group_name.clone())
                .or_default();
            group.servers += 1;
            if server.status == "online" {
                group.online += 1;
            }
            if let Some(value) = uptime_24h {
                group.uptime_sum += value;
                group.uptime_count += 1;
            }
            // 存量脏值（手工改库 / 旧版本）一律按未填写处理：公开页不能 500。
            let billing = BillingMeta::from_server(&server);
            let buckets_24h = starts
                .iter()
                .map(|ts| {
                    buckets
                        .get(&server.id)
                        .and_then(|by_hour| by_hour.get(ts))
                        .map(|online_ratio| PublicBucket {
                            ts: *ts,
                            online_ratio: *online_ratio,
                        })
                })
                .collect();
            PublicServer {
                id: server.id,
                name: server.name,
                online: server.status == "online",
                xray_running: server.xray_running,
                load1: server.load1,
                mem_used: server.mem_used,
                mem_total: server.mem_total,
                disk_used: server.disk_used,
                disk_total: server.disk_total,
                uptime_secs: server.uptime_secs,
                last_seen: server.last_seen_at,
                net_rx_bps: server.net_rx_bps,
                net_tx_bps: server.net_tx_bps,
                net_rx_bytes: server.net_rx_bytes,
                net_tx_bytes: server.net_tx_bytes,
                latency_ms: server.latency_ms,
                country_code: server.country_code.clone(),
                group_name: server.group_name.clone(),
                paid_until: billing.paid_until,
                price_cents: billing.price_cents,
                currency: billing.currency,
                billing_cycle: billing.billing_cycle,
                os_name: server.os_name,
                os_version: server.os_version,
                virt: server.virt,
                arch: server.arch,
                uptime_24h,
                uptime_7d: uptime.and_then(|row| row.uptime_7d),
                buckets_24h,
            }
        })
        .collect();

    // 具名分组按名称字典序升序；未分组（None）固定最后，与 Web 的分组排序一致。
    let mut groups: Vec<PublicGroup> = group_accumulators
        .into_iter()
        .map(|(name, group)| PublicGroup {
            name,
            servers: group.servers,
            online: group.online,
            uptime_24h: (group.uptime_count > 0)
                .then(|| group.uptime_sum / group.uptime_count as f64),
        })
        .collect();
    groups.sort_by(|a, b| match (&a.name, &b.name) {
        (Some(a), Some(b)) => a.cmp(b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    let response = PublicStatus {
        panel_name: settings.panel_name,
        generated_at: now,
        summary,
        servers,
        groups,
        series,
    };
    let value = serde_json::to_value(response)
        .map_err(|error| AppError::Internal(anyhow::Error::from(error)))?;
    state.public_status.put(value.clone());
    Ok(Json(value))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use pierwave_domain::models::Patch;
    use pierwave_domain::repo;
    use pierwave_domain::Db;

    use crate::state::AppState;

    async fn setup() -> (Router, AppState) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (app, state)
    }

    async fn get(app: &Router, uri: &str) -> (StatusCode, Value, String) {
        let request = Request::builder()
            .method(Method::GET)
            .uri(uri)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            String::from_utf8_lossy(&bytes).into_owned(),
        )
    }

    /// 测试里整组写入四列（仓储层三态版本的便捷包装）。
    async fn set_billing(
        pool: &sqlx::SqlitePool,
        id: &str,
        paid_until: Option<&str>,
        price_cents: Option<i64>,
        currency: Option<&str>,
        billing_cycle: Option<&str>,
    ) -> anyhow::Result<()> {
        repo::servers::set_billing(
            pool,
            id,
            Patch::Value(paid_until),
            Patch::Value(price_cents),
            Patch::Value(currency),
            Patch::Value(billing_cycle),
        )
        .await
    }

    async fn seed_server(state: &AppState, name: &str, address: &str) -> String {
        let (server, _token) = repo::servers::create(&state.db.pool, name, address, "external")
            .await
            .unwrap();
        server.id
    }

    async fn seed_grouped_server(
        state: &AppState,
        name: &str,
        address: &str,
        group: Option<&str>,
    ) -> String {
        let (server, _token) = repo::servers::create_with_country_and_group(
            &state.db.pool,
            name,
            address,
            "external",
            None,
            group,
        )
        .await
        .unwrap();
        server.id
    }

    /// 测试只建一台服务器；返回它，避免 helper 里再传一遍 id。
    async fn server_id(state: &AppState) -> String {
        repo::servers::list(&state.db.pool).await.unwrap()[0]
            .id
            .clone()
    }

    async fn set_online(state: &AppState, online: bool) {
        let id = server_id(state).await;
        if online {
            repo::servers::mark_online(&state.db.pool, &id)
                .await
                .unwrap();
        } else {
            repo::servers::mark_offline(&state.db.pool, &id)
                .await
                .unwrap();
        }
    }

    /// 迷你图固定 12 个桶、3 条等长数组，`t` 升序且步长 300。
    fn assert_series_shape(series: &Value) {
        assert_eq!(series["window_secs"], 3_600, "{series}");
        assert_eq!(series["step_secs"], 300, "{series}");
        let t = series["t"].as_array().unwrap();
        assert_eq!(t.len(), 12, "{series}");
        for pair in t.windows(2) {
            assert_eq!(
                pair[1].as_i64().unwrap() - pair[0].as_i64().unwrap(),
                300,
                "桶起点必须升序且步长 300：{series}"
            );
        }
        for key in ["rate_rx_bps", "rate_tx_bps", "latency_ms"] {
            assert_eq!(
                series[key].as_array().unwrap().len(),
                12,
                "{key} 的长度必须与 t 一致：{series}"
            );
        }
    }

    fn assert_no_forbidden_keys(value: &Value) {
        const FORBIDDEN: &[&str] = &[
            "address",
            "token",
            "token_hash",
            "username",
            "password",
            "password_hash",
            "short_code",
            "quota_bytes",
            "user_count",
            "users",
            "packages",
            "certificates",
        ];
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    assert!(
                        !FORBIDDEN.contains(&key.as_str()),
                        "公开响应出现了敏感键：{key}"
                    );
                    assert_no_forbidden_keys(child);
                }
            }
            Value::Array(items) => items.iter().for_each(assert_no_forbidden_keys),
            _ => {}
        }
    }

    #[tokio::test]
    async fn no_samples_means_null_uptime_and_all_null_buckets() {
        let (app, state) = setup().await;
        seed_server(&state, "edge-1", "203.0.113.9").await;

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        assert!(server["uptime_24h"].is_null(), "{body}");
        assert!(server["uptime_7d"].is_null(), "{body}");
        let buckets = server["buckets_24h"].as_array().unwrap();
        assert_eq!(buckets.len(), 24);
        assert!(
            buckets.iter().all(Value::is_null),
            "没有采样时所有桶都必须是 null：{body}"
        );
    }

    #[tokio::test]
    async fn heartbeat_os_info_and_country_are_visible_but_old_agents_stay_null() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;
        repo::servers::set_country_code(&state.db.pool, &id, Some("JP"))
            .await
            .unwrap();
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                arch: "x86_64".into(),
                os_name: Some("Debian GNU/Linux".into()),
                os_version: Some("12".into()),
                virt: Some("kvm".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        assert_eq!(server["country_code"], "JP");
        assert_eq!(server["os_name"], "Debian GNU/Linux");
        assert_eq!(server["os_version"], "12");
        assert_eq!(server["virt"], "kvm");
        assert_eq!(server["arch"], "x86_64");

        // 旧 Agent 没有这些字段：公开接口必须是 null，而不是空串或 0。
        state.public_status.clear();
        repo::servers::set_country_code(&state.db.pool, &id, None)
            .await
            .unwrap();
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        assert!(server["country_code"].is_null(), "{body}");
        assert!(server["os_name"].is_null(), "{body}");
        assert!(server["os_version"].is_null(), "{body}");
        assert!(server["virt"].is_null(), "{body}");
        assert_eq!(server["arch"], "", "旧 Agent 的 arch 是空串");
    }

    #[tokio::test]
    async fn heartbeat_latency_is_visible_and_old_agent_stays_null() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;

        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(23),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["servers"][0]["latency_ms"], 23);

        // 旧 Agent 的默认快照没有延迟：公开接口必须是 null，不能是 0。
        state.public_status.clear();
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            body["servers"][0]["latency_ms"].is_null(),
            "没有探测结果时必须是 null：{body}"
        );
    }

    #[tokio::test]
    async fn samples_record_latency_and_null_does_not_break_aggregation() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;
        let now = repo::now();

        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(42),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::server_samples::record_round(&state.db.pool, now - 300)
            .await
            .unwrap();

        // 下一轮探测失败：采样里的 latency 是 NULL，但可用率聚合照常工作。
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        repo::server_samples::record_round(&state.db.pool, now)
            .await
            .unwrap();

        let samples = repo::server_samples::list(&state.db.pool, &id, now - 3_600)
            .await
            .unwrap();
        assert_eq!(samples.len(), 2, "两轮采样都应落库");
        assert_eq!(samples[0].latency_ms, Some(42));
        assert_eq!(samples[1].latency_ms, None);

        let uptime = repo::server_samples::uptime_all(&state.db.pool, now)
            .await
            .unwrap();
        assert_eq!(uptime.len(), 1);
        assert_eq!(uptime[0].server_id, id);

        state.public_status.clear();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            body["servers"][0]["uptime_24h"].is_number(),
            "latency 为 null 不应影响可用率聚合：{body}"
        );
        assert!(body["servers"][0]["latency_ms"].is_null(), "{body}");
    }

    #[tokio::test]
    async fn half_online_samples_produce_half_uptime() {
        let (app, state) = setup().await;
        seed_server(&state, "edge-1", "203.0.113.9").await;
        let now = repo::now();

        for i in 0..24 {
            set_online(&state, i % 2 == 0).await;
            repo::server_samples::record_round(&state.db.pool, now - i * 300)
                .await
                .unwrap();
        }

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let uptime = body["servers"][0]["uptime_24h"].as_f64().unwrap();
        assert!((uptime - 0.5).abs() < 1e-9, "uptime_24h = {uptime}");
        let uptime_7d = body["servers"][0]["uptime_7d"].as_f64().unwrap();
        assert!((uptime_7d - 0.5).abs() < 1e-9, "uptime_7d = {uptime_7d}");
    }

    #[tokio::test]
    async fn buckets_aggregate_by_hour_and_fill_missing_with_null() {
        let (app, state) = setup().await;
        seed_server(&state, "edge-1", "203.0.113.9").await;
        let now = repo::now();
        let current_hour = now - now.rem_euclid(3_600);
        let target = current_hour - 3_600;

        set_online(&state, true).await;
        repo::server_samples::record_round(&state.db.pool, target)
            .await
            .unwrap();
        set_online(&state, false).await;
        repo::server_samples::record_round(&state.db.pool, target + 300)
            .await
            .unwrap();

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let buckets = body["servers"][0]["buckets_24h"].as_array().unwrap();
        assert_eq!(buckets.len(), 24);
        assert_eq!(buckets[22]["ts"], target, "倒数第二个桶是上一个整点");
        assert_eq!(buckets[22]["online_ratio"], 0.5);
        for (index, bucket) in buckets.iter().enumerate() {
            if index != 22 {
                assert!(bucket.is_null(), "第 {index} 个桶应为 null：{body}");
            }
        }
    }

    /// 空库：`series` 仍有 12 个升序桶起点，三条序列全是 null（不是 0）。
    #[tokio::test]
    async fn series_is_twelve_null_buckets_without_samples() {
        let (app, state) = setup().await;

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let series = &body["series"];
        assert_series_shape(series);
        let generated_at = body["generated_at"].as_i64().unwrap();
        let current = generated_at - generated_at.rem_euclid(300);
        let t = series["t"].as_array().unwrap();
        assert_eq!(
            t[11].as_i64().unwrap(),
            current,
            "最后一个桶是当前 5 分钟桶"
        );
        assert_eq!(t[0].as_i64().unwrap(), current - 11 * 300);
        for key in ["rate_rx_bps", "rate_tx_bps", "latency_ms"] {
            assert!(
                series[key].as_array().unwrap().iter().all(Value::is_null),
                "空库时 {key} 必须全是 null：{body}"
            );
        }

        // 有服务器但从未采样：同样是 null，不是 0。
        state.public_status.clear();
        seed_server(&state, "edge-1", "203.0.113.9").await;
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        for key in ["rate_rx_bps", "rate_tx_bps", "latency_ms"] {
            assert!(
                body["series"][key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(Value::is_null),
                "从未采样时 {key} 必须全是 null：{body}"
            );
        }
    }

    /// 部分服务器有数据：速率只求和在线样本、NULL 不参与；延迟取在线均值；
    /// 离线样本不计入（否则会画出「离线机器仍在跑流量」）。
    #[tokio::test]
    async fn series_sums_online_rates_and_averages_latency_with_null_gaps() {
        let (app, state) = setup().await;
        let a = seed_server(&state, "edge-a", "203.0.113.1").await;
        let b = seed_server(&state, "edge-b", "203.0.113.2").await;
        let now = repo::now();
        let current = now - now.rem_euclid(300);

        // A：两轮心跳算出 1000 B/s 接收、500 B/s 发送；延迟 20ms。
        repo::servers::update_health(
            &state.db.pool,
            &a,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(20),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::servers::update_net_counters(&state.db.pool, &a, 1_000, 2_000, current - 60)
            .await
            .unwrap();
        repo::servers::update_net_counters(&state.db.pool, &a, 61_000, 32_000, current)
            .await
            .unwrap();

        // B：只有第一份累计基线（没有速率，旧 Agent 式）+ 延迟 40ms。
        repo::servers::update_health(
            &state.db.pool,
            &b,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(40),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::servers::update_net_counters(&state.db.pool, &b, 5_000, 6_000, current)
            .await
            .unwrap();

        // 当前桶：两台都在线；A 有速率，B 没有 → SUM 忽略 B 的 NULL。
        repo::server_samples::record_round(&state.db.pool, current)
            .await
            .unwrap();

        // 上一个桶：B 已离线，只有 A 参与。
        repo::servers::mark_offline(&state.db.pool, &b)
            .await
            .unwrap();
        repo::server_samples::record_round(&state.db.pool, current - 300)
            .await
            .unwrap();

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let series = &body["series"];
        assert_series_shape(series);
        let t = series["t"].as_array().unwrap();
        assert_eq!(t[11].as_i64().unwrap(), current);
        assert_eq!(t[10].as_i64().unwrap(), current - 300);

        assert_eq!(series["rate_rx_bps"][10].as_f64().unwrap(), 1_000.0);
        assert_eq!(series["rate_tx_bps"][10].as_f64().unwrap(), 500.0);
        assert_eq!(
            series["latency_ms"][10].as_i64().unwrap(),
            20,
            "离线服务器不参与延迟均值：{body}"
        );
        assert_eq!(
            series["rate_rx_bps"][11].as_f64().unwrap(),
            1_000.0,
            "B 没有速率时不应变成 0，也不应拉低总和：{body}"
        );
        assert_eq!(series["rate_tx_bps"][11].as_f64().unwrap(), 500.0);
        assert_eq!(
            series["latency_ms"][11].as_i64().unwrap(),
            30,
            "在线两台 (20 + 40) / 2 = 30：{body}"
        );

        for index in 0..10 {
            for key in ["rate_rx_bps", "rate_tx_bps", "latency_ms"] {
                assert!(
                    series[key][index].is_null(),
                    "第 {index} 个桶的 {key} 应补 null，不能补 0：{body}"
                );
            }
        }
    }

    /// 窗口边界：刚好 60 分钟前的采样对齐后落在第一个桶之前，必须被排除。
    #[tokio::test]
    async fn series_window_excludes_a_sample_exactly_sixty_minutes_old() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;
        let now = repo::now();
        let current = now - now.rem_euclid(300);

        // 刚好 60 分钟前：对齐到 current - 3600，即 t[0] - 300，窗口外。
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(99),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::server_samples::record_round(&state.db.pool, now - 3_600)
            .await
            .unwrap();

        // 窗口第一个桶（current - 3300）有数据。
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(10),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::server_samples::record_round(&state.db.pool, current - 3_300)
            .await
            .unwrap();

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let series = &body["series"];
        assert_eq!(series["t"][0].as_i64().unwrap(), current - 3_300);
        assert_eq!(series["latency_ms"][0].as_i64().unwrap(), 10);
        for (index, value) in series["latency_ms"].as_array().unwrap().iter().enumerate() {
            assert_ne!(
                value.as_i64(),
                Some(99),
                "第 {index} 个桶混进了刚好 60 分钟前的采样：{body}"
            );
        }
        for index in 1..12 {
            assert!(
                series["latency_ms"][index].is_null(),
                "第 {index} 个桶没有采样，必须是 null：{body}"
            );
        }
    }

    /// 30 秒缓存命中时 `series` 与首次响应完全一致（含长度与 null 缺口）。
    #[tokio::test]
    async fn series_is_cached_with_the_same_shape() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(25),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let (_, first, _) = get(&app, "/api/v1/public/status").await;
        assert!(first["series"]["latency_ms"]
            .as_array()
            .unwrap()
            .iter()
            .all(Value::is_null));

        // 缓存期内写入采样：命中缓存的响应必须原样带上首次的 series。
        repo::server_samples::record_round(&state.db.pool, repo::now())
            .await
            .unwrap();
        let (_, cached, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(cached["generated_at"], first["generated_at"]);
        assert_eq!(
            cached["series"], first["series"],
            "缓存命中时 series 必须与首次响应完全一致"
        );

        state.public_status.clear();
        let (_, fresh, _) = get(&app, "/api/v1/public/status").await;
        assert!(
            fresh["series"]["latency_ms"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value.as_i64() == Some(25)),
            "清缓存后应读到新采样：{fresh}"
        );
    }

    /// 旧 Agent / 无网卡计数：采样里的速率与延迟都是 NULL，序列必须是 null，绝不是 0。
    #[tokio::test]
    async fn old_agent_without_net_counters_writes_null_not_zero() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot::default(),
        )
        .await
        .unwrap();
        repo::server_samples::record_round(&state.db.pool, repo::now())
            .await
            .unwrap();

        // 先确认落库的就是 NULL（不是 0）——这是序列 null 的来源。
        let samples = repo::server_samples::list(&state.db.pool, &id, repo::now() - 600)
            .await
            .unwrap();
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].rx_bps, None);
        assert_eq!(samples[0].tx_bps, None);
        assert_eq!(samples[0].latency_ms, None);

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let series = &body["series"];
        assert_series_shape(series);
        for key in ["rate_rx_bps", "rate_tx_bps", "latency_ms"] {
            for value in series[key].as_array().unwrap() {
                assert!(
                    value.is_null(),
                    "旧 Agent 没有数据时 {key} 必须是 null，不能写 0：{body}"
                );
            }
        }
    }

    #[tokio::test]
    async fn response_never_contains_address_or_other_sensitive_keys() {
        let (app, state) = setup().await;
        let server_id = seed_server(&state, "edge-1", "203.0.113.9").await;
        repo::nodes::create(
            &state.db.pool,
            &server_id,
            repo::nodes::NewNode {
                tag: Some("vless-1".into()),
                name: "香港-01".into(),
                protocol: "vless".into(),
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
        .unwrap();

        let (status, body, raw) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(
            !raw.contains("203.0.113.9"),
            "公开响应不应包含服务器地址：{raw}"
        );
        assert_no_forbidden_keys(&body);

        let server_keys: Vec<&str> = body["servers"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut expected = vec![
            "id",
            "name",
            "online",
            "xray_running",
            "load1",
            "mem_used",
            "mem_total",
            "disk_used",
            "disk_total",
            "uptime_secs",
            "last_seen",
            "net_rx_bps",
            "net_tx_bps",
            "net_rx_bytes",
            "net_tx_bytes",
            "latency_ms",
            "country_code",
            "group_name",
            "paid_until",
            "price_cents",
            "currency",
            "billing_cycle",
            "os_name",
            "os_version",
            "virt",
            "arch",
            "uptime_24h",
            "uptime_7d",
            "buckets_24h",
        ];
        expected.sort_unstable();
        let mut actual = server_keys.clone();
        actual.sort_unstable();
        assert_eq!(actual, expected, "服务器行必须严格是白名单字段");
        assert_eq!(body["summary"]["nodes_total"], 1);

        // 迷你图只暴露三条序列 + 窗口元数据，不能顺手带出别的东西。
        let mut series_keys: Vec<&str> = body["series"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        series_keys.sort_unstable();
        assert_eq!(
            series_keys,
            vec![
                "latency_ms",
                "rate_rx_bps",
                "rate_tx_bps",
                "step_secs",
                "t",
                "window_secs",
            ],
            "series 字段必须是白名单"
        );
    }

    /// 分组聚合：未分组归到 `name: null`，分组按名称升序，可用率是组内均值。
    #[tokio::test]
    async fn groups_aggregate_counts_and_uptime_sorted_by_name() {
        let (app, state) = setup().await;
        let b1 = seed_grouped_server(&state, "b-1", "203.0.113.1", Some("b-group")).await;
        let b2 = seed_grouped_server(&state, "b-2", "203.0.113.2", Some("b-group")).await;
        let a1 = seed_grouped_server(&state, "a-1", "203.0.113.3", Some("a-group")).await;
        let ungrouped = seed_grouped_server(&state, "u-1", "203.0.113.4", None).await;

        // 两轮采样：b-1 两轮在线（1.0），b-2 第一轮在线、第二轮离线（0.5），
        // b-group 的 24h 均值 = (1.0 + 0.5) / 2 = 0.75。
        repo::servers::mark_online(&state.db.pool, &b1)
            .await
            .unwrap();
        repo::servers::mark_online(&state.db.pool, &b2)
            .await
            .unwrap();
        repo::servers::mark_online(&state.db.pool, &a1)
            .await
            .unwrap();
        repo::servers::mark_online(&state.db.pool, &ungrouped)
            .await
            .unwrap();
        let now = repo::now();
        repo::server_samples::record_round(&state.db.pool, now - 300)
            .await
            .unwrap();

        repo::servers::mark_offline(&state.db.pool, &b2)
            .await
            .unwrap();
        repo::server_samples::record_round(&state.db.pool, now)
            .await
            .unwrap();

        // 采样之后才建组：这个组从未有过采样，用于验证 uptime_24h = null。
        let empty = seed_grouped_server(&state, "c-1", "203.0.113.5", Some("c-group")).await;
        repo::servers::mark_offline(&state.db.pool, &empty)
            .await
            .unwrap();

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let groups = body["groups"].as_array().unwrap();
        let names: Vec<Option<&str>> = groups.iter().map(|group| group["name"].as_str()).collect();
        assert_eq!(
            names,
            vec![Some("a-group"), Some("b-group"), Some("c-group"), None],
            "具名分组按名称升序，未分组固定最后：{body}"
        );

        let a = &groups[0];
        assert_eq!(a["servers"], 1);
        assert_eq!(a["online"], 1);
        assert!((a["uptime_24h"].as_f64().unwrap() - 1.0).abs() < 1e-9);

        let b = &groups[1];
        assert_eq!(b["servers"], 2);
        assert_eq!(b["online"], 1, "b-2 已离线");
        assert!(
            (b["uptime_24h"].as_f64().unwrap() - 0.75).abs() < 1e-9,
            "{b}"
        );

        // 从未采样过的组：servers 照常计数，uptime_24h 必须是 null 而不是 0。
        let c = &groups[2];
        assert_eq!(c["servers"], 1);
        assert_eq!(c["online"], 0);
        assert!(c["uptime_24h"].is_null(), "{c}");

        let ungrouped_row = &groups[3];
        assert!(ungrouped_row["name"].is_null());
        assert_eq!(ungrouped_row["servers"], 1);
        assert_eq!(ungrouped_row["online"], 1);
        assert!((ungrouped_row["uptime_24h"].as_f64().unwrap() - 1.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn disabled_switch_returns_404_even_without_login() {
        let (app, state) = setup().await;
        seed_server(&state, "edge-1", "203.0.113.9").await;
        repo::settings::set(&state.db.pool, "public_status_enabled", "0")
            .await
            .unwrap();

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["code"], "public_status.disabled");

        repo::settings::set(&state.db.pool, "public_status_enabled", "1")
            .await
            .unwrap();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    /// 这条单独测：不带任何 Cookie 也必须 200，公开接口不能被登录态依赖。
    #[tokio::test]
    async fn public_status_is_accessible_without_login() {
        let (app, state) = setup().await;
        seed_server(&state, "edge-1", "203.0.113.9").await;

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["summary"]["servers_total"], 1);
    }

    #[tokio::test]
    async fn result_is_cached_for_thirty_seconds() {
        let (app, state) = setup().await;
        seed_server(&state, "edge-1", "203.0.113.9").await;

        let (_, first, _) = get(&app, "/api/v1/public/status").await;
        seed_server(&state, "edge-2", "203.0.113.10").await;
        let (_, cached, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(cached["summary"]["servers_total"], 1, "30 秒内应复用缓存");
        assert_eq!(cached["generated_at"], first["generated_at"]);

        state.public_status.clear();
        let (_, fresh, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(fresh["summary"]["servers_total"], 2);
    }

    /// 公开页的实时速率与累计流量：第一次心跳只有累计基线（速率 null），
    /// 第二次心跳才算得出速率；累计值直接复用同一份心跳计数。
    #[tokio::test]
    async fn public_status_exposes_current_rate_and_cumulative_bytes() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;

        // 第一次上报：只建立基线，速率必须是 null（不能是 0）。
        repo::servers::update_net_counters(&state.db.pool, &id, 1_000, 2_000, 1_000)
            .await
            .unwrap();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        assert!(server["net_rx_bps"].is_null(), "{body}");
        assert!(server["net_tx_bps"].is_null(), "{body}");
        assert_eq!(server["net_rx_bytes"], 1_000);
        assert_eq!(server["net_tx_bytes"], 2_000);

        // 第二次上报：60 秒 +12.3 MB / +1.2 MB → 205000 / 20000 B/s。
        state.public_status.clear();
        repo::servers::update_net_counters(
            &state.db.pool,
            &id,
            1_000 + 12_300_000,
            2_000 + 1_200_000,
            1_060,
        )
        .await
        .unwrap();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        let rx = server["net_rx_bps"].as_f64().unwrap();
        let tx = server["net_tx_bps"].as_f64().unwrap();
        assert!((rx - 205_000.0).abs() < 1e-6, "{body}");
        assert!((tx - 20_000.0).abs() < 1e-6, "{body}");
        assert_eq!(server["net_rx_bytes"], 12_301_000);
        assert_eq!(server["net_tx_bytes"], 1_202_000);
    }

    /// 没有心跳数据（旧 Agent / 从未连过）时四个字段都是 null，绝不写 0。
    #[tokio::test]
    async fn public_status_net_fields_are_null_without_agent_data() {
        let (app, state) = setup().await;
        seed_server(&state, "edge-1", "203.0.113.9").await;

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        for key in ["net_rx_bps", "net_tx_bps", "net_rx_bytes", "net_tx_bytes"] {
            assert!(server[key].is_null(), "{key} 必须是 null：{body}");
            assert_ne!(server[key], 0, "{key} 不能被写成 0：{body}");
        }
    }

    /// 费用与到期：填了公开可见、没填是 null、非法存量值降级为 null 且不 panic。
    #[tokio::test]
    async fn public_status_exposes_billing_and_sanitizes_dirty_values() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;

        // 没填：四个字段都是 null，不是空串或 0。
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        for key in ["paid_until", "price_cents", "currency", "billing_cycle"] {
            assert!(server[key].is_null(), "{key} 必须是 null：{body}");
        }

        // 管理员填写后公开可见。
        state.public_status.clear();
        set_billing(
            &state.db.pool,
            &id,
            Some("2026-12-31"),
            Some(4999),
            Some("CNY"),
            Some("monthly"),
        )
        .await
        .unwrap();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        assert_eq!(server["paid_until"], "2026-12-31");
        assert_eq!(server["price_cents"], 4999);
        assert_eq!(server["currency"], "CNY");
        assert_eq!(server["billing_cycle"], "monthly");

        // 直接改库塞进非法值（模拟手工改库 / 旧版本脏数据）：接口仍然 200，
        // 非法字段逐个降级为 null，绝不能 panic 或整个 500。
        state.public_status.clear();
        set_billing(
            &state.db.pool,
            &id,
            Some("2026-02-30"),
            Some(-1),
            Some("cny"),
            Some("weekly"),
        )
        .await
        .unwrap();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        for key in ["paid_until", "price_cents", "currency", "billing_cycle"] {
            assert!(server[key].is_null(), "{key} 的脏值必须降级为 null：{body}");
        }

        // 混合：一列脏、一列合法，合法的那列照常展示。
        state.public_status.clear();
        set_billing(
            &state.db.pool,
            &id,
            None,
            Some(1_000_000_000),
            Some("EUR"),
            None,
        )
        .await
        .unwrap();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        assert!(server["paid_until"].is_null(), "{body}");
        assert!(server["price_cents"].is_null(), "{body}");
        assert_eq!(server["currency"], "EUR");
        assert!(server["billing_cycle"].is_null(), "{body}");
    }

    /// 迁移 0062：一次性修复历史脏数据。
    ///
    /// 0061 的四个列没有 CHECK，手工改库可以把 TEXT 塞进 `price_cents`（INTEGER
    /// 亲和性转换失败时按 TEXT 存），也可以写入越界价格 / 坏币种。这类行会让
    /// `Server::from_row` 解码失败，公开页与管理端列表全部 500，管理员无法自救。
    /// 0062 把「类型被写坏」与「值域非法」的列都置 NULL；修复后两个读接口都
    /// 必须 200 且字段为 null。
    #[tokio::test]
    async fn migration_0062_repairs_dirty_billing_columns_for_public_and_admin_reads() {
        use axum::http::header;
        use pierwave_domain::{Db, MIGRATOR};

        let db = Db::connect("sqlite::memory:").await.unwrap();
        // 停在 0061：模拟一个「已经升级到 0061、但被手工改坏」的库。
        for migration in MIGRATOR.iter().filter(|m| m.version <= 61) {
            sqlx::raw_sql(&migration.sql)
                .execute(&db.pool)
                .await
                .unwrap_or_else(|error| panic!("执行迁移 {} 失败：{error}", migration.version));
        }

        let admin = repo::users::create(
            &db.pool,
            repo::users::NewUser {
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
        let (token, _) = repo::sessions::create(&db.pool, &admin.id, 3_600, None)
            .await
            .unwrap();
        let (broken, _) = repo::servers::create(&db.pool, "edge-broken", "203.0.113.9", "external")
            .await
            .unwrap();
        let (out_of_range, _) =
            repo::servers::create(&db.pool, "edge-range", "203.0.113.10", "external")
                .await
                .unwrap();
        let (clean, _) = repo::servers::create(&db.pool, "edge-clean", "203.0.113.11", "external")
            .await
            .unwrap();

        // 三种脏法：TEXT 进 INTEGER 列（'abc' 无法按数值存储）、整数越界 + 坏币种、
        // 到期日被写成整数。合法行必须原样保留，迁移不能把好数据一起清掉。
        sqlx::query(
            "UPDATE servers
                SET price_cents = 'abc',
                    paid_until = 12345,
                    currency = 'cny',
                    billing_cycle = 'weekly'
              WHERE id = ?",
        )
        .bind(&broken.id)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE servers
                SET price_cents = 1000000000,
                    paid_until = '2026-13-01',
                    currency = 'CN',
                    billing_cycle = 'annual'
              WHERE id = ?",
        )
        .bind(&out_of_range.id)
        .execute(&db.pool)
        .await
        .unwrap();
        set_billing(
            &db.pool,
            &clean.id,
            Some("2026-12-31"),
            Some(4999),
            Some("CNY"),
            Some("monthly"),
        )
        .await
        .unwrap();

        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());

        // 修复前：`price_cents` 解码失败 → 500。这正是「整页 500、无法自救」。
        let (status, _, raw) = get(&app, "/api/v1/public/status").await;
        assert_eq!(
            status,
            StatusCode::INTERNAL_SERVER_ERROR,
            "脏列在修复前必须让读接口失败（本测试的前提）：{raw}"
        );

        let migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == 62)
            .expect("必须存在 0062 数据修复迁移");
        sqlx::raw_sql(&migration.sql)
            .execute(&state.db.pool)
            .await
            .unwrap();
        // 文档承诺可重复执行：再跑一次不能把合法行改坏。
        sqlx::raw_sql(&migration.sql)
            .execute(&state.db.pool)
            .await
            .unwrap();

        // 公开页：200，脏行四个字段全部降级为 null，合法行原样保留。
        let (status, body, raw) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{raw}");
        let by_name = |name: &str| -> &Value {
            body["servers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["name"] == name)
                .unwrap_or_else(|| panic!("公开页缺少服务器 {name}：{body}"))
        };
        for name in ["edge-broken", "edge-range"] {
            for key in ["paid_until", "price_cents", "currency", "billing_cycle"] {
                assert!(
                    by_name(name)[key].is_null(),
                    "{name}.{key} 的脏值必须被迁移清成 NULL：{body}"
                );
            }
        }
        let clean = by_name("edge-clean");
        assert_eq!(clean["paid_until"], "2026-12-31", "{body}");
        assert_eq!(clean["price_cents"], 4999, "{body}");
        assert_eq!(clean["currency"], "CNY", "{body}");
        assert_eq!(clean["billing_cycle"], "monthly", "{body}");

        // 管理端列表：同样 200，脏行为 null、合法行保留。
        let request = Request::builder()
            .method(Method::GET)
            .uri("/api/v1/servers")
            .header(
                header::COOKIE,
                format!("{}={token}", crate::auth::SESSION_COOKIE),
            )
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            status,
            StatusCode::OK,
            "迁移后管理端列表必须可读：{}",
            String::from_utf8_lossy(&bytes)
        );
        let by_name = |name: &str| -> &Value {
            body["items"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["name"] == name)
                .unwrap_or_else(|| panic!("管理端列表缺少服务器 {name}：{body}"))
        };
        for name in ["edge-broken", "edge-range"] {
            for key in ["paid_until", "price_cents", "currency", "billing_cycle"] {
                assert!(
                    by_name(name)[key].is_null(),
                    "{name}.{key} 的脏值必须被迁移清成 NULL：{body}"
                );
            }
        }
        assert_eq!(by_name("edge-clean")["price_cents"], 4999, "{body}");
    }
}
