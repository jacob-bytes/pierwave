//! `GET /api/v1/overview/chain-health?hours=24&bucket=900[&server_ids=...]`
//! （仅管理员）。
//!
//! 跨链时延聚合：一次读链拓扑（链 / 组 / 成员 3 条 SQL，不按链循环），
//! 一次取窗口时延样本（`forward_latency_samples` 的 `forward_id IN (...)`），
//! 一次取时间轴窗口内的 5 分钟探测桶（`forward_probe_samples` 的
//! `forward_id IN (...)`），剩下的归并全部在
//! [`pierwave_domain::chain_health`] 里做。查询次数与链数、成员数无关，
//! 没有 N+1。
//!
//! 丢包口径：链级 `loss_pct` 取最近 [`aggregate::CURRENT_WINDOW_SECS`]（2 小时，
//! 与 p50 的当前窗口一致）的 attempts/failures；`series[].loss_pct` 取该时间桶
//! 的同一批计数。两者都按各跳独立连乘 `1 - Π(1 - loss_i)`，`attempts = 0` 为
//! null；链级只有「部分段有数据」时才标 `loss_partial`。
//!
//! `server_ids` 与 `/api/v1/overview`、`/overview/server-health` **完全同语义**：
//! 不传 = 全部；空数组 = 空结果；未知 id 忽略并进 `warnings.unknown_ids`；
//! 非法 id 400；去重后上限 200。筛选保留「至少一个成员落在选中服务器」的链，
//! `summary` 只按这些链重算；链内的段仍然完整返回。
//!
//! 结果缓存 30 秒，key = `(hours, bucket, 规范化后的请求 server_ids)`；响应头
//! `X-Chain-Health-Cache: hit|miss`。口径细节见 `docs/CHAIN-HEALTH.md`。

use std::collections::HashSet;

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue};
use axum::Json;
use serde::Serialize;
use serde_json::{json, Value};

use pierwave_domain::chain_health as aggregate;
use pierwave_domain::models::ChainWithGroups;
use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::overview::{last_query_value, parse_server_ids, query_values, resolve_scope};

const DEFAULT_HOURS: i64 = 24;
const MAX_HOURS: i64 = 168;
const DEFAULT_BUCKET: i64 = 900;
const MIN_BUCKET: i64 = 300;
const MAX_BUCKET: i64 = 86_400;
const BUCKET_STEP: i64 = 300;

#[derive(Debug, Serialize)]
struct Scope {
    /// 实际命中库的服务器 id；不筛选时是空数组。
    server_ids: Vec<String>,
    servers_matched: i64,
    /// 请求是否带了 `server_ids`；空数组也算 true。
    filtered: bool,
}

#[derive(Debug, Serialize)]
struct Warnings {
    /// 合法但库里不存在的 id；被忽略，不参与筛选。
    unknown_ids: Vec<String>,
    /// 本应映射到「段」却失败的样本数（多成员目标却上报空目标、链改过成员
    /// 后的历史残留等）。最后一跳到链目标的预期探测不计入，它由
    /// `chains[].missing_hops` 表达。
    unmapped_forwards: i64,
}

#[derive(Debug, Serialize)]
struct ChainHealthResponse {
    generated_at: i64,
    hours: i64,
    bucket: i64,
    summary: aggregate::Summary,
    chains: Vec<aggregate::ChainHealth>,
    scope: Scope,
    warnings: Warnings,
}

/// 解析 `hours`：缺省/空白 = 24，非整数或越界 400。
fn parse_hours(raw: Option<&str>) -> AppResult<i64> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(DEFAULT_HOURS);
    };
    let hours = raw.parse::<i64>().map_err(|_| hours_invalid())?;
    if !(1..=MAX_HOURS).contains(&hours) {
        return Err(hours_invalid());
    }
    Ok(hours)
}

fn hours_invalid() -> AppError {
    AppError::coded(
        "query.chain_health_hours_invalid",
        Some(json!({ "min": 1, "max": MAX_HOURS, "default": DEFAULT_HOURS })),
        format!(
            "hours 必须是 1-{MAX_HOURS} 的整数（默认 {DEFAULT_HOURS}） / \
             hours must be an integer between 1 and {MAX_HOURS}"
        ),
    )
}

/// 解析 `bucket`：缺省 900；必须 300 的整数倍、在 300..=86400，且能整除
/// `hours*3600`，否则 400。与服务器态势同一组约束。
fn parse_bucket(raw: Option<&str>, hours: i64) -> AppResult<i64> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(DEFAULT_BUCKET);
    };
    let bucket = raw.parse::<i64>().map_err(|_| bucket_invalid())?;
    if !(MIN_BUCKET..=MAX_BUCKET).contains(&bucket)
        || bucket % BUCKET_STEP != 0
        || (hours * 3600) % bucket != 0
    {
        return Err(bucket_invalid());
    }
    Ok(bucket)
}

fn bucket_invalid() -> AppError {
    AppError::coded(
        "query.chain_health_bucket_invalid",
        Some(json!({
            "min": MIN_BUCKET,
            "max": MAX_BUCKET,
            "step": BUCKET_STEP,
            "default": DEFAULT_BUCKET,
            "rule": "bucket 必须能整除 hours*3600"
        })),
        format!(
            "bucket 必须是 {MIN_BUCKET}-{MAX_BUCKET} 之间 {BUCKET_STEP} 的倍数，\
             且能整除 hours*3600（默认 {DEFAULT_BUCKET}） / \
             bucket must be a multiple of {BUCKET_STEP} that divides hours*3600"
        ),
    )
}

pub async fn chain_health(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(params): Query<Vec<(String, String)>>,
) -> AppResult<(HeaderMap, Json<Value>)> {
    user.require_admin()?;
    let hours = parse_hours(last_query_value(&params, "hours"))?;
    let bucket = parse_bucket(last_query_value(&params, "bucket"), hours)?;
    let requested = parse_server_ids(&query_values(&params, "server_ids"))?;
    let scope = resolve_scope(&state.db.pool, requested).await?;
    // 与 server-health 一样把「命中的 + 未知的」完整请求集放进 key：
    // warnings / scope 和 body 一起缓存，只按命中 id 做 key 会吞掉未知 id。
    let cache_ids = scope.cache_ids();

    let (body, cache_hit) = match state.chain_health.get(hours, bucket, cache_ids.as_deref()) {
        Some(value) => (value, true),
        None => {
            let value = build_chain_health(
                &state,
                repo::now(),
                hours,
                bucket,
                scope.filter.as_ref(),
                scope.unknown_ids.clone(),
            )
            .await?;
            state
                .chain_health
                .put(hours, bucket, cache_ids.as_deref(), value.clone());
            (value, false)
        }
    };

    let mut headers = HeaderMap::new();
    headers.insert(header::VARY, HeaderValue::from_static("Cookie"));
    headers.insert(
        HeaderName::from_static("x-chain-health-cache"),
        HeaderValue::from_static(if cache_hit { "hit" } else { "miss" }),
    );
    Ok((headers, Json(body)))
}

async fn build_chain_health(
    state: &AppState,
    now: i64,
    hours: i64,
    bucket: i64,
    filter: Option<&repo::overview::ServerFilter>,
    unknown_ids: Vec<String>,
) -> AppResult<Value> {
    let pool = &state.db.pool;
    let topology = repo::chains::list_topology(pool).await?;
    let chains = filter_topology(topology, filter);
    let forward_ids = forward_ids(&chains);
    // 一次取「时间轴 + 24h 基线」覆盖到的全部样本；空链不查库。
    let since = aggregate::sample_window_start(now, hours, bucket);
    let samples = repo::latency::list_for_forwards(pool, &forward_ids, since).await?;
    // 丢包：取整个时间轴窗口内的 5 分钟探测桶，逐桶连乘给 series[]，
    // 其中落在当前窗口（2h）的桶再汇总成链级 loss_pct。
    let (probe_since, probe_until) = aggregate::series_window(now, hours, bucket);
    let probes =
        repo::chain_probe::buckets_for_forwards(pool, &forward_ids, probe_since, probe_until)
            .await?;
    let result = aggregate::aggregate(&chains, &samples, &probes, now, hours, bucket);

    let response = ChainHealthResponse {
        generated_at: now,
        hours,
        bucket,
        summary: result.summary,
        chains: result.chains,
        scope: Scope {
            server_ids: filter.map_or_else(Vec::new, |filter| filter.ids().to_vec()),
            servers_matched: filter.map_or(0, |filter| filter.len() as i64),
            filtered: filter.is_some(),
        },
        warnings: Warnings {
            unknown_ids,
            unmapped_forwards: result.unmapped_forwards,
        },
    };
    serde_json::to_value(response).map_err(|error| AppError::Internal(error.into()))
}

/// 保留「至少一个成员落在选中服务器」的链；不筛选时原样返回。
fn filter_topology(
    chains: Vec<ChainWithGroups>,
    filter: Option<&repo::overview::ServerFilter>,
) -> Vec<ChainWithGroups> {
    let Some(filter) = filter else {
        return chains;
    };
    let ids: HashSet<&str> = filter.ids().iter().map(String::as_str).collect();
    chains
        .into_iter()
        .filter(|chain| {
            chain
                .groups
                .iter()
                .flat_map(|group| group.members.iter())
                .any(|member| ids.contains(member.server_id.as_str()))
        })
        .collect()
}

/// 所有成员的 forward id（与 `DesiredForward` 的 id 规则一致）。
///
/// 排序去重后再进 SQL，缓存/日志/查询计划的参数顺序稳定；同一台服务器在
/// 同一条链里只能出现一次，但不同链可以复用同一台，所以这里按 id 去重。
fn forward_ids(chains: &[ChainWithGroups]) -> Vec<String> {
    let mut ids = Vec::new();
    for chain in chains {
        for group in &chain.groups {
            let member_count = group.members.len();
            for member in &group.members {
                ids.push(pierwave_domain::chains::forward_id(
                    &chain.chain.id,
                    group.group.seq,
                    &member.server_id,
                    member_count,
                ));
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, HeaderMap, Method, Request, StatusCode};
    use axum::Router;
    use serde_json::Value;
    use std::sync::atomic::{AtomicI64, Ordering};
    use tower::ServiceExt;

    use pierwave_domain::chains::forward_id;
    use pierwave_domain::repo::chain_probe;
    use pierwave_domain::repo::chains::{NewChain, NewChainGroup, NewChainGroupMember};
    use pierwave_domain::repo::{latency, servers, sessions, users};
    use pierwave_domain::Db;

    use crate::state::{AppState, ChainHealthCache, CHAIN_HEALTH_CACHE_TTL};

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
        let mut state = AppState::new(db, "web/dist");
        state.chain_health = ChainHealthCache::with_ttl(CHAIN_HEALTH_CACHE_TTL);
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

    async fn server(pool: &sqlx::SqlitePool, name: &str, address: &str) -> String {
        servers::create(pool, name, address, "external")
            .await
            .unwrap()
            .0
            .id
    }

    /// 建一条 `groups` 形态的链；每个成员分配全局互不冲突的监听端口。
    async fn chain(pool: &sqlx::SqlitePool, name: &str, groups: Vec<Vec<&str>>) -> String {
        static NEXT_PORT: AtomicI64 = AtomicI64::new(20_000);
        let groups = groups
            .into_iter()
            .enumerate()
            .map(|(seq, members)| {
                let members = members
                    .into_iter()
                    .enumerate()
                    .map(|(priority, server_id)| {
                        let listen_port = NEXT_PORT.fetch_add(1, Ordering::Relaxed);
                        NewChainGroupMember {
                            server_id: server_id.into(),
                            listen_port,
                            priority: priority as i64,
                            weight: 1,
                        }
                    })
                    .collect();
                NewChainGroup {
                    name: Some(format!("hop-{seq}")),
                    strategy: "round_robin".into(),
                    cert_id: None,
                    public_port: None,
                    use_internal_address: false,
                    members,
                }
            })
            .collect();
        repo::chains::create(
            pool,
            NewChain {
                name: name.into(),
                target_host: "target.example".into(),
                target_port: 443,
                enabled: true,
                engine: "native".into(),
                protocol: "tcp".into(),
                proxy_protocol: false,
                transport: "none".into(),
                tunnel_security: "tls".into(),
                groups,
            },
        )
        .await
        .unwrap()
        .chain
        .id
    }

    fn end_at(now: i64, bucket: i64) -> i64 {
        now - now.rem_euclid(bucket) + bucket
    }

    #[tokio::test]
    async fn chain_health_requires_admin() {
        let (app, state, _admin) = setup().await;
        let (status, _, _) = request(&app, None, "/api/v1/overview/chain-health").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

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
        let (status, _, body) = request(&app, Some(&cookie), "/api/v1/overview/chain-health").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "body: {body}");
    }

    #[tokio::test]
    async fn chain_health_maps_hops_series_and_the_missing_last_hop() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let chain_id = chain(pool, "港日链", vec![vec![&a], vec![&b]]).await;
        let now = repo::now();
        let end = end_at(now, 300);
        let ts = end - 60;
        latency::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), "", 17)
            .await
            .unwrap();
        // 最后一跳到链目标：必须计入 unmapped，不能伪装成第 2 段。
        latency::record_sample(pool, ts, &b, &forward_id(&chain_id, 1, &b, 1), "", 9)
            .await
            .unwrap();

        let (status, headers, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=300",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["hours"], 1);
        assert_eq!(body["bucket"], 300);
        assert_eq!(body["scope"]["filtered"], false);
        assert_eq!(body["scope"]["server_ids"], json!([]));
        assert_eq!(body["warnings"]["unknown_ids"], json!([]));
        assert_eq!(body["warnings"]["unmapped_forwards"], 0);
        assert_eq!(body["summary"]["total_chains"], 1);
        assert_eq!(body["chains"][0]["hops"], 2);
        assert_eq!(body["chains"][0]["missing_hops"], json!([2]));
        assert_eq!(body["chains"][0]["segments"].as_array().unwrap().len(), 1);
        assert_eq!(body["chains"][0]["segments"][0]["seq"], 1);
        assert_eq!(body["chains"][0]["segments"][0]["from"], "香港-01");
        assert_eq!(body["chains"][0]["segments"][0]["to"], "东京-01");
        assert_eq!(body["chains"][0]["segments"][0]["p50"], 17.0);
        // 没有探测样本：attempts = 0、loss_pct 为 null；整链无数据不标 partial。
        assert_eq!(body["chains"][0]["segments"][0]["attempts"], 0);
        assert_eq!(body["chains"][0]["segments"][0]["failures"], 0);
        assert_eq!(body["chains"][0]["segments"][0]["loss_pct"], Value::Null);
        assert_eq!(body["chains"][0]["loss_pct"], Value::Null);
        assert_eq!(
            body["chains"][0]["loss_samples"],
            json!({ "attempts": 0, "failures": 0 })
        );
        assert_eq!(body["chains"][0]["loss_partial"], false);
        assert_eq!(body["summary"]["loss_pct"], Value::Null);
        assert_eq!(body["summary"]["worst_loss"], Value::Null);
        assert_eq!(body["chains"][0]["series"].as_array().unwrap().len(), 12);
        assert_eq!(
            body["chains"][0]["series"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["p50"],
            17.0
        );
        assert_eq!(headers["x-chain-health-cache"], "miss");
    }

    #[tokio::test]
    async fn chain_health_server_filter_keeps_chains_with_a_selected_hop() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let c = server(pool, "大阪-01", "10.0.0.3").await;
        let ab = chain(pool, "港日链", vec![vec![&a], vec![&b]]).await;
        let cb = chain(pool, "阪日链", vec![vec![&c], vec![&b]]).await;
        let now = repo::now();
        let ts = end_at(now, 900) - 60;
        latency::record_sample(pool, ts, &a, &forward_id(&ab, 0, &a, 1), "", 10)
            .await
            .unwrap();
        latency::record_sample(pool, ts, &c, &forward_id(&cb, 0, &c, 1), "", 30)
            .await
            .unwrap();

        // 筛一台只出现在第一条链里的服务器。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            &format!("/api/v1/overview/chain-health?hours=1&bucket=900&server_ids={a}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["scope"]["filtered"], true);
        assert_eq!(body["scope"]["servers_matched"], 1);
        assert_eq!(body["scope"]["server_ids"], json!([a]));
        assert_eq!(body["summary"]["total_chains"], 1);
        assert_eq!(body["chains"][0]["name"], "港日链");

        // b 同时属于两条链：两条都保留。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            &format!("/api/v1/overview/chain-health?hours=1&bucket=900&server_ids={b}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["summary"]["total_chains"], 2);

        // 空数组 = 空结果，不是全站。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900&server_ids=",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["scope"]["filtered"], true);
        assert_eq!(body["summary"]["total_chains"], 0);
        assert!(body["chains"].as_array().unwrap().is_empty());

        // 未知 id：忽略并进 warnings，筛选结果为空。
        let unknown = "00000000-0000-4000-8000-000000000000";
        let (status, _, body) = request(
            &app,
            Some(&admin),
            &format!("/api/v1/overview/chain-health?hours=1&bucket=900&server_ids={a},{unknown}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["warnings"]["unknown_ids"], json!([unknown]));
        assert_eq!(body["summary"]["total_chains"], 1);

        // 非法 id → 400，而不是静默丢掉。
        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900&server_ids=not-a-uuid",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
        assert_eq!(body["code"], "query.server_ids_invalid");

        // 去重后上限 200：201 个不同 id 才 400。
        let mut ids: Vec<String> = (0..201)
            .map(|index| format!("00000000-0000-4000-8000-{index:012}"))
            .collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 201);
        let (status, _, body) = request(
            &app,
            Some(&admin),
            &format!(
                "/api/v1/overview/chain-health?hours=1&bucket=900&server_ids={}",
                ids.join(",")
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
        assert_eq!(body["code"], "query.server_ids_too_many");
    }

    #[tokio::test]
    async fn chain_health_rejects_bad_hours_and_bucket() {
        let (app, _state, admin) = setup().await;
        for (query, code) in [
            ("hours=0", "query.chain_health_hours_invalid"),
            ("hours=169", "query.chain_health_hours_invalid"),
            ("hours=abc", "query.chain_health_hours_invalid"),
            ("hours=1&bucket=0", "query.chain_health_bucket_invalid"),
            ("hours=1&bucket=301", "query.chain_health_bucket_invalid"),
            ("hours=1&bucket=4000", "query.chain_health_bucket_invalid"),
        ] {
            let (status, _, body) = request(
                &app,
                Some(&admin),
                &format!("/api/v1/overview/chain-health?{query}"),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
            assert_eq!(body["code"], code, "{query}: {body}");
        }
        // 默认值：hours=24、bucket=900。
        let (status, _, body) = request(&app, Some(&admin), "/api/v1/overview/chain-health").await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["hours"], 24);
        assert_eq!(body["bucket"], 900);
        assert_eq!(
            body["chains"].as_array().unwrap().len(),
            0,
            "没有链时是空数组"
        );
        assert_eq!(body["summary"]["total_chains"], 0);
        assert_eq!(body["summary"]["hop_p50_ms"], Value::Null);
    }

    #[tokio::test]
    async fn chain_health_cache_key_includes_hours_bucket_and_filter() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let chain_id = chain(pool, "港日链", vec![vec![&a], vec![&b]]).await;
        let ts = end_at(repo::now(), 900) - 60;
        latency::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), "", 12)
            .await
            .unwrap();

        let uri = "/api/v1/overview/chain-health?hours=1&bucket=900";
        let (status, headers, first) = request(&app, Some(&admin), uri).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["x-chain-health-cache"], "miss");
        let (status, headers, second) = request(&app, Some(&admin), uri).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["x-chain-health-cache"], "hit");
        assert_eq!(first, second, "命中时整份响应（含 generated_at）复用");

        for other in [
            "/api/v1/overview/chain-health?hours=2&bucket=900",
            "/api/v1/overview/chain-health?hours=1&bucket=300",
            &format!("/api/v1/overview/chain-health?hours=1&bucket=900&server_ids={a}"),
        ] {
            let (status, headers, _) = request(&app, Some(&admin), other).await;
            assert_eq!(status, StatusCode::OK, "{other}");
            assert_eq!(
                headers["x-chain-health-cache"], "miss",
                "{other} 必须与新 key 隔离"
            );
        }

        // 不筛选 / 筛选到空集 / 筛选一台 是三个不同的 key。
        let (_, headers, _) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900&server_ids=",
        )
        .await;
        assert_eq!(headers["x-chain-health-cache"], "miss");
    }

    /// 用 48 小时样本验证「单段变慢 → contribution_pct / diagnosis」；
    /// 与造数脚本的形态一致：最近 2h 第 2 段 +25ms，其余持平。
    #[tokio::test]
    async fn chain_health_reports_the_slow_segment_and_diagnosis() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let c = server(pool, "大阪-01", "10.0.0.3").await;
        let chain_id = chain(pool, "港日链", vec![vec![&a], vec![&b], vec![&c]]).await;
        let now = repo::now();
        let end = end_at(now, 900);
        let current_start = end - 2 * 3600;
        let baseline_start = current_start - 24 * 3600;
        let mut ts = baseline_start;
        while ts < end {
            latency::record_sample(pool, ts + 60, &a, &forward_id(&chain_id, 0, &a, 1), "", 20)
                .await
                .unwrap();
            let second = if ts >= current_start { 55 } else { 30 };
            latency::record_sample(
                pool,
                ts + 60,
                &b,
                &forward_id(&chain_id, 1, &b, 1),
                "",
                second,
            )
            .await
            .unwrap();
            ts += 900;
        }

        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=24&bucket=900",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let view = &body["chains"][0];
        assert_eq!(view["segments"][0]["p50"], 20.0);
        assert_eq!(view["segments"][1]["p50"], 55.0);
        assert_eq!(view["segments"][1]["delta_ms"], 25.0);
        assert_eq!(view["segments"][1]["contribution_pct"], 100);
        assert_eq!(view["diagnosis"]["kind"], "single_hop");
        assert_eq!(view["diagnosis"]["seq"], 2);
        assert_eq!(body["summary"]["slow_chains"], 1);
        assert_eq!(body["summary"]["hop_p50_ms"], 75);
        assert_eq!(body["summary"]["delta_ms"], 25);
        assert_eq!(body["summary"]["worst_hop"]["seq"], 2);
    }

    /// 每段的 attempts/failures → 单段比值 + 整链连乘；时延字段保持不变。
    #[tokio::test]
    async fn chain_health_reports_segment_and_compounded_chain_loss() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let c = server(pool, "大阪-01", "10.0.0.3").await;
        let chain_id = chain(pool, "港日链", vec![vec![&a], vec![&b], vec![&c]]).await;
        let now = repo::now();
        let end = end_at(now, 900);
        let ts = end - 60;

        // 时延回归：丢包字段不能影响 p50 / series。
        latency::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), "", 14)
            .await
            .unwrap();
        latency::record_sample(pool, ts, &b, &forward_id(&chain_id, 1, &b, 1), "", 21)
            .await
            .unwrap();
        // 当前窗口探测：两段各 240 次、2 次失败（0.8333%）。
        chain_probe::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), 240, 2)
            .await
            .unwrap();
        chain_probe::record_sample(pool, ts, &b, &forward_id(&chain_id, 1, &b, 1), 240, 2)
            .await
            .unwrap();
        // 最后一跳到链目标：全失败也不能算进任何段。
        chain_probe::record_sample(pool, ts, &c, &forward_id(&chain_id, 2, &c, 1), 240, 240)
            .await
            .unwrap();

        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let view = &body["chains"][0];
        assert_eq!(view["segments"][0]["p50"], 14.0, "时延字段不受影响");
        assert_eq!(view["segments"][1]["p50"], 21.0);
        assert_eq!(view["series"].as_array().unwrap().len(), 4);
        assert_eq!(view["segments"][0]["attempts"], 240);
        assert_eq!(view["segments"][0]["failures"], 2);
        assert_eq!(view["segments"][0]["loss_pct"], 0.8333);
        assert_eq!(view["segments"][1]["loss_pct"], 0.8333);
        // 1 - (1 - 2/240)² = 1.6597%，不是把两段相加的 1.6667%。
        assert_eq!(view["loss_pct"], 1.6597);
        assert_eq!(
            view["loss_samples"],
            json!({ "attempts": 480, "failures": 4 })
        );
        assert_eq!(view["loss_partial"], false);
        assert_eq!(body["summary"]["loss_pct"], 1.6597);
        assert_eq!(body["summary"]["worst_loss"]["chain_id"], chain_id);
        assert_eq!(body["summary"]["worst_loss"]["chain_name"], "港日链");
        assert_eq!(body["summary"]["worst_loss"]["loss_pct"], 1.6597);
    }

    /// `loss_partial` 只在「部分段有探测数据」时为 true；全无数据是 false。
    #[tokio::test]
    async fn chain_health_marks_loss_partial_only_for_partially_probed_chains() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let c = server(pool, "新加坡-01", "10.0.0.3").await;
        let d = server(pool, "大阪-01", "10.0.0.4").await;
        let chain_id = chain(pool, "四跳链", vec![vec![&a], vec![&b], vec![&c], vec![&d]]).await;
        let ts = end_at(repo::now(), 900) - 60;
        // 前两段各 1%、第三段完全没有探测。
        chain_probe::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), 100, 1)
            .await
            .unwrap();
        chain_probe::record_sample(pool, ts, &b, &forward_id(&chain_id, 1, &b, 1), 100, 1)
            .await
            .unwrap();

        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let view = &body["chains"][0];
        assert_eq!(view["segments"][0]["loss_pct"], 1.0);
        assert_eq!(view["segments"][1]["loss_pct"], 1.0);
        assert_eq!(view["segments"][2]["loss_pct"], Value::Null);
        assert_eq!(view["loss_pct"], 1.99);
        assert_eq!(view["loss_partial"], true);
        assert_eq!(
            view["loss_samples"],
            json!({ "attempts": 200, "failures": 2 })
        );
        assert_eq!(body["summary"]["loss_pct"], 1.99);
    }

    /// `series[].loss_pct` 是该时间桶的值，不是链级窗口值；无探测桶为 null。
    #[tokio::test]
    async fn chain_health_series_reports_per_bucket_loss() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let chain_id = chain(pool, "港日链", vec![vec![&a], vec![&b]]).await;
        let end = end_at(repo::now(), 900);
        let forward_id = forward_id(&chain_id, 0, &a, 1);

        // 三个有样本的桶：一个没有探测、一个 1%、一个 50%。
        for ts in [end - 3 * 900 + 60, end - 2 * 900 + 60, end - 900 + 60] {
            latency::record_sample(pool, ts, &a, &forward_id, "", 20)
                .await
                .unwrap();
        }
        chain_probe::record_sample(pool, end - 2 * 900 + 60, &a, &forward_id, 100, 1)
            .await
            .unwrap();
        chain_probe::record_sample(pool, end - 900 + 60, &a, &forward_id, 100, 50)
            .await
            .unwrap();

        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let series = body["chains"][0]["series"].as_array().unwrap();
        assert_eq!(series.len(), 4);
        assert!(series[0].is_null(), "没有时延样本的桶仍是 null");
        assert_eq!(series[1]["p50"], 20.0);
        assert_eq!(series[1]["loss_pct"], Value::Null, "该桶无探测");
        assert_eq!(series[2]["loss_pct"], 1.0);
        assert_eq!(series[3]["loss_pct"], 50.0);
        // 链级窗口值是两桶计数合并后的 25.5%，与逐桶值不同。
        assert_eq!(body["chains"][0]["loss_pct"], 25.5);
    }

    /// `server_ids` 筛选后，丢包汇总只算保留的链（不能把未选中的链算进 headline）。
    #[tokio::test]
    async fn chain_health_loss_only_counts_the_selected_chains() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let c = server(pool, "香港-02", "10.0.0.3").await;
        let d = server(pool, "大阪-01", "10.0.0.4").await;
        let ab = chain(pool, "甲链", vec![vec![&a], vec![&b]]).await;
        let cd = chain(pool, "乙链", vec![vec![&c], vec![&d]]).await;
        let ts = end_at(repo::now(), 900) - 60;
        chain_probe::record_sample(pool, ts, &a, &forward_id(&ab, 0, &a, 1), 100, 50)
            .await
            .unwrap();
        chain_probe::record_sample(pool, ts, &c, &forward_id(&cd, 0, &c, 1), 100, 1)
            .await
            .unwrap();

        let (status, _, body) = request(
            &app,
            Some(&admin),
            &format!("/api/v1/overview/chain-health?hours=1&bucket=900&server_ids={a}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["summary"]["total_chains"], 1);
        assert_eq!(body["chains"][0]["name"], "甲链");
        assert_eq!(body["summary"]["loss_pct"], 50.0);
        assert_eq!(body["summary"]["worst_loss"]["chain_id"], ab);
        // 未选中的乙链（1%）不能进入汇总。
        assert_eq!(body["chains"][0]["loss_pct"], 50.0);

        let (status, _, body) = request(
            &app,
            Some(&admin),
            &format!("/api/v1/overview/chain-health?hours=1&bucket=900&server_ids={d}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["summary"]["total_chains"], 1);
        assert_eq!(body["chains"][0]["name"], "乙链");
        assert_eq!(body["summary"]["loss_pct"], 1.0);
        assert_eq!(body["summary"]["worst_loss"]["chain_id"], cd);
    }
}
