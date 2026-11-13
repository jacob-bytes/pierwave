//! 探针公开页：`GET /api/v1/public/status`（无需登录）。
//!
//! 响应形状与 `docs/PLAN.md`「P10：探针公开页」一致，只读、只暴露白名单字段。
//! 采样聚合全部走 `pierwave_domain::repo::server_samples`，这里只负责把行拼成
//! 24 个小时桶并做 30 秒进程内缓存。

use std::collections::{BTreeMap, HashMap};

use axum::extract::State;
use axum::Json;
use serde::Serialize;
use serde_json::Value;

use pierwave_domain::models::PublicSummary;
use pierwave_domain::repo;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const HOUR_SECS: i64 = 3_600;
const BUCKETS_24H: usize = 24;

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
    /// Agent 到公网探测目标的 TCP 握手 RTT（毫秒）；探测失败或旧 Agent 为 null。
    latency_ms: Option<i64>,
    /// 管理员填写的国家/地区代码（ISO 3166-1 alpha-2）；未填写为 null。
    country_code: Option<String>,
    /// 管理员填写的分组名；未分组为 null。公开页用它做分组筛选，分组名本来就在 `groups` 里出现过。
    group_name: Option<String>,
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

pub async fn status(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let settings = crate::routes::settings::load(&state.db.pool).await;
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
                latency_ms: server.latency_ms,
                country_code: server.country_code.clone(),
                group_name: server.group_name.clone(),
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
                config_json: "{}".into(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
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
            "latency_ms",
            "country_code",
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
}
