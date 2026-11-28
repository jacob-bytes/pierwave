//! `GET /api/v1/overview/chain-health?hours=24&bucket=900[&server_ids=...]`
//! （仅管理员）。
//!
//! 跨链时延聚合：链拓扑与最近探测共 4 条 SQL（链 / 组 / 成员 3 条，加
//! `forward_status` 的 `forward_id, targets_json` 1 条；都按 `IN (...)` 或
//! 全量读，不按链循环，最近探测的 id 列表为空时直接跳过），另加一次窗口
//! 时延样本（`forward_latency_samples` 的 `forward_id IN (...)`）与一次
//! 时间轴窗口内的 5 分钟探测桶（`forward_probe_samples` 的
//! `forward_id IN (...)`）。剩下的归并全部在
//! [`pierwave_domain::chain_health`] 里做。
//! 查询次数与链数、成员数无关，没有 N+1。`entry` / `exit`、逐段
//! `segments[].series`、`segments[].members`（段源组成员明细）与
//! `nodes[].active_server_id` 也全部由同一批结果内存归并，不新增 SQL；
//! 成员明细的 `p50_ms` / `loss_pct` 与段级同一个当前窗口，按成员自己的
//! forward 规则聚合，没有样本时为 null。
//!
//! `targets[].active`（协议 30）只对 failover / lowest_latency 有值：同一
//! forward 至多一个 `Some(true)`，`None`（旧 Agent / 非单一选中策略）表示
//! 未知。拓扑视图从入口代表成员逐跳沿这个「当前选中」走出当前通路，写成
//! `nodes[].active_server_id`；入口组与链目标恒为 null，缺记录 / 无 active /
//! 选中项不在本组 / 上一跳成员不在线时，从该跳起全部 null。
//!
//! 丢包口径：链级 `loss_pct` 取最近 [`aggregate::CURRENT_WINDOW_SECS`]（2 小时，
//! 与 p50 的当前窗口一致）的 attempts/failures；`series[].loss_pct` 取该时间桶
//! 的同一批计数。两者都按各跳独立连乘 `1 - Π(1 - loss_i)`，`attempts = 0` 为
//! null；链级只有「部分段有数据」时才标 `loss_partial`。
//!
//! 最后一跳（最后一组 → 链目标）与中间段同形：只有 `engine = native &&
//! protocol = tcp` 的 forward 会被 Agent 探测（`target_health_loop`），这类
//! 链的归一逻辑不变；realm / nftables / tunnel / udp / both 的最后一跳永远
//! 没有样本，用 `chains[].last_hop = { measurable, reason }` 显式标注，并且
//! 不参与 `series` 齐全判定 / 当前整体值 / `missing_hops` / `status.no_samples`
//! （这类链是 `unknown` / `unmeasurable`）。`chains[].nodes` 额外给出拓扑节点
//! （每个组的**全部**成员 + 链目标，组级 `status` 取最差成员），`entry` /
//! `exit` 保留；
//! `chains[].status` 把节点状态与数据质量合成为 `ok` / `degraded` /
//! `blocked`（优先级见领域层 `ChainStatus`）：按**跳**判断，任一必需跳
//! **没有在线成员**（全部离线 / 空组）才 `blocked`，多成员组只掉一部分成员
//! 只是 `degraded`（链路仍可用，容量下降）。
//!
//! `server_ids` 与 `/api/v1/overview`、`/overview/server-health` **完全同语义**：
//! 不传 = 全部；空数组 = 空结果；未知 id 忽略并进 `warnings.unknown_ids`；
//! 非法 id 400；去重后上限 200。筛选保留「至少一个成员落在选中服务器」的链，
//! `summary` 只按这些链重算；链内的段仍然完整返回。
//!
//! 结果缓存 30 秒，key = `(hours, bucket, (命中的 server_ids, 未知的
//! server_ids))`：同一个 id 从「未知」变成「存在」必须 miss；响应头
//! `X-Chain-Health-Cache: hit|miss`。口径细节见 `docs/CHAIN-HEALTH.md`。

use std::collections::{HashMap, HashSet};

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
    /// 本应映射到「段」却失败的样本数（多成员目标却上报空目标、最后一跳却
    /// 带非空目标、链改过成员后的历史残留等）。最后一跳用空目标上报是
    /// **预期**格式，不计入这里。
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
    // 与 server-health 一样把「命中的」与「未知的」分开放进 key：
    // warnings / scope 和 body 一起缓存，合并成一个集合会让「X 未知」与
    // 「X 存在」共用 key，X 出现后仍返回旧响应。
    let cache_key = scope.cache_key();

    let (body, cache_hit) = match state.chain_health.get(hours, bucket, cache_key.as_ref()) {
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
                .put(hours, bucket, cache_key.as_ref(), value.clone());
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
    // 最近一轮心跳的逐目标探测（协议 30 的 `active` 也在这段 JSON 里），
    // 供 `nodes[].active_server_id` 沿当前选中走通路。空 id 列表不查库。
    let latest_targets = latest_target_map(pool, &forward_ids).await?;
    let result = aggregate::aggregate(
        &chains,
        &samples,
        &probes,
        &latest_targets,
        now,
        hours,
        bucket,
    );

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

/// 按 forward id 读最近一轮心跳里的逐目标探测 JSON 并解析。
///
/// 仓储只负责取 `targets_json`；解析放在这里，失败（历史脏数据 / 手改库）
/// 只记 warn 并当「没有数据」处理，绝不让整个 chain-health 500。
async fn latest_target_map(
    pool: &sqlx::SqlitePool,
    forward_ids: &[String],
) -> AppResult<HashMap<String, Vec<aggregate::TargetProbeRow>>> {
    if forward_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = repo::forwards::latest_targets(pool, forward_ids).await?;
    let mut latest = HashMap::with_capacity(rows.len());
    for row in rows {
        let Some(raw) = row.targets_json.as_deref() else {
            continue;
        };
        match serde_json::from_str::<Vec<aggregate::TargetProbeRow>>(raw) {
            Ok(probes) => {
                latest.insert(row.forward_id, probes);
            }
            Err(error) => tracing::warn!(
                forward_id = %row.forward_id,
                %error,
                "解析 forward_status.targets_json 失败，按无数据处理"
            ),
        }
    }
    Ok(latest)
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
        chain_with_entry_port(pool, name, groups, None).await
    }

    /// 同 [`chain`]，但入口组可指定展示用 `public_port`。
    async fn chain_with_entry_port(
        pool: &sqlx::SqlitePool,
        name: &str,
        groups: Vec<Vec<&str>>,
        entry_public_port: Option<i64>,
    ) -> String {
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
                    public_port: if seq == 0 { entry_public_port } else { None },
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

    /// 取一条链里某台成员实际落库的 `listen_port`，用于断言终点端口。
    async fn listen_port_of(pool: &sqlx::SqlitePool, chain_id: &str, server_id: &str) -> i64 {
        repo::chains::find_by_id(pool, chain_id)
            .await
            .unwrap()
            .unwrap()
            .groups
            .iter()
            .flat_map(|group| group.members.iter())
            .find(|member| member.server_id == server_id)
            .expect("成员必须存在")
            .listen_port
    }

    /// 建一条可按组指定选路策略的链（用于 strategy / active 的 HTTP 用例）。
    async fn chain_with_strategies(
        pool: &sqlx::SqlitePool,
        name: &str,
        groups: Vec<(Vec<&str>, &str)>,
    ) -> String {
        static NEXT_PORT: AtomicI64 = AtomicI64::new(30_000);
        let groups = groups
            .into_iter()
            .enumerate()
            .map(|(seq, (members, strategy))| {
                let members = members
                    .into_iter()
                    .enumerate()
                    .map(|(priority, server_id)| NewChainGroupMember {
                        server_id: server_id.into(),
                        listen_port: NEXT_PORT.fetch_add(1, Ordering::Relaxed),
                        priority: priority as i64,
                        weight: 1,
                    })
                    .collect();
                NewChainGroup {
                    name: Some(format!("hop-{seq}")),
                    strategy: strategy.into(),
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

    /// 写一条心跳探测缓存：`(server_id, ok, latency_ms, active)`。
    async fn save_probes(
        state: &AppState,
        server_id: &str,
        forward_id: &str,
        probes: &[(&str, bool, Option<u32>, Option<bool>)],
    ) {
        repo::forwards::save_status(
            &state.db.pool,
            server_id,
            &[repo::forwards::NewForwardStatus {
                forward_id: forward_id.to_string(),
                listening: true,
                error: String::new(),
                target_ok: Some(probes.iter().any(|(_, ok, _, _)| *ok)),
                target_error: None,
                targets: probes
                    .iter()
                    .map(
                        |(server_id, ok, latency_ms, active)| repo::forwards::NewTargetProbe {
                            server_id: (*server_id).to_string(),
                            ok: *ok,
                            latency_ms: *latency_ms,
                            active: *active,
                        },
                    )
                    .collect(),
                traffic_in: None,
                traffic_out: None,
                probe_attempts: None,
                probe_failures: None,
            }],
        )
        .await
        .unwrap();
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
    async fn chain_health_maps_hops_the_final_hop_and_topology_nodes() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        servers::mark_online(pool, &a).await.unwrap();
        let chain_id = chain(pool, "港日链", vec![vec![&a], vec![&b]]).await;
        let now = repo::now();
        let end = end_at(now, 300);
        let ts = end - 60;
        latency::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), "", 17)
            .await
            .unwrap();
        // 最后一跳到链目标：空目标样本归到最后一跳，不是 unmapped。
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
        // 有最后一跳样本：不能再说这一跳缺失。
        assert_eq!(body["chains"][0]["missing_hops"], json!([]));
        let segments = body["chains"][0]["segments"].as_array().unwrap();
        assert_eq!(segments.len(), 2, "2 组 = 2 段（含最后一跳）");
        assert_eq!(segments[0]["seq"], 1);
        assert_eq!(segments[0]["from"], "香港-01");
        assert_eq!(segments[0]["to"], "东京-01");
        assert_eq!(segments[0]["p50"], 17.0);
        assert_eq!(segments[1]["seq"], 2);
        assert_eq!(segments[1]["from"], "东京-01");
        assert_eq!(segments[1]["to"], "链目标");
        assert_eq!(segments[1]["p50"], 9.0);
        // 单成员段也返回一个元素的 `members`；成员来自段源组，状态原样透传
        // （东京-01 未标记在线 → offline），单成员段 active 恒 false。
        assert_eq!(
            segments[0]["members"],
            json!([{
                "server_id": a, "name": "香港-01", "status": "online",
                "p50_ms": 17.0, "loss_pct": Value::Null,
                "attempts": 0, "failures": 0, "active": false,
            }])
        );
        assert_eq!(
            segments[1]["members"],
            json!([{
                "server_id": b, "name": "东京-01", "status": "offline",
                "p50_ms": 9.0, "loss_pct": Value::Null,
                "attempts": 0, "failures": 0, "active": false,
            }])
        );
        // 没有探测样本：attempts = 0、loss_pct 为 null；整链无数据不标 partial。
        for segment in segments {
            assert_eq!(segment["attempts"], 0);
            assert_eq!(segment["failures"], 0);
            assert_eq!(segment["loss_pct"], Value::Null);
        }
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
            26.0,
            "整体 p50 含最后一跳"
        );
        // nodes：首组 source、末组 hop、链目标 target（server_id/status 为 null）。
        // 组节点带全部成员与组级最差状态；`name` 优先用组名（这里由 helper 设成
        // hop-N），`server_id` 仍是代表成员。
        let nodes = body["chains"][0]["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[0]["seq"], 0);
        assert_eq!(nodes[0]["server_id"], a);
        assert_eq!(nodes[0]["name"], "hop-0");
        assert_eq!(nodes[0]["role"], "source");
        assert_eq!(nodes[0]["status"], "online");
        assert_eq!(nodes[0]["member_count"], 1);
        assert_eq!(
            nodes[0]["members"],
            json!([{ "server_id": a, "name": "香港-01", "status": "online" }])
        );
        assert_eq!(nodes[1]["seq"], 1);
        assert_eq!(nodes[1]["server_id"], b);
        assert_eq!(nodes[1]["name"], "hop-1");
        assert_eq!(nodes[1]["role"], "hop");
        assert_eq!(nodes[1]["status"], "offline");
        assert_eq!(nodes[1]["member_count"], 1);
        assert_eq!(
            nodes[1]["members"],
            json!([{ "server_id": b, "name": "东京-01", "status": "offline" }])
        );
        assert_eq!(nodes[2]["seq"], 2);
        assert_eq!(nodes[2]["server_id"], Value::Null);
        assert_eq!(nodes[2]["name"], "链目标");
        assert_eq!(nodes[2]["role"], "target");
        assert_eq!(nodes[2]["status"], Value::Null);
        assert_eq!(nodes[2]["member_count"], 0);
        assert_eq!(nodes[2]["members"], json!([]));
        // 既有 entry / exit 字段保留。
        assert_eq!(body["chains"][0]["entry"]["server_id"], a);
        assert_eq!(body["chains"][0]["exit"]["server_id"], b);
        assert_eq!(headers["x-chain-health-cache"], "miss");
    }

    /// 链级可用性：节点离线 → blocked 并点名；无样本 → degraded/no_samples；
    /// 节点在线、当前数据完整 → ok。链目标节点（status 为 null）不参与判定。
    #[tokio::test]
    async fn chain_health_reports_the_chain_availability_status() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let c = server(pool, "大阪-01", "10.0.0.3").await;
        let d = server(pool, "新加坡-01", "10.0.0.4").await;
        servers::mark_online(pool, &a).await.unwrap();
        servers::mark_online(pool, &c).await.unwrap();
        servers::mark_online(pool, &d).await.unwrap();
        // b 不标记在线：默认就是 offline。
        chain(pool, "港日链", vec![vec![&a], vec![&b]]).await;
        chain(pool, "港新链", vec![vec![&c], vec![&d]]).await;
        let ok = chain(pool, "港新直达", vec![vec![&a], vec![&c]]).await;
        let ts = end_at(repo::now(), 900) - 60;
        latency::record_sample(pool, ts, &a, &forward_id(&ok, 0, &a, 1), "", 12)
            .await
            .unwrap();
        latency::record_sample(pool, ts, &c, &forward_id(&ok, 1, &c, 1), "", 8)
            .await
            .unwrap();

        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let chains = body["chains"].as_array().unwrap();
        let find = |name: &str| {
            chains
                .iter()
                .find(|chain| chain["name"] == name)
                .unwrap_or_else(|| panic!("缺少链 {name}：{body}"))
        };

        let blocked = find("港日链");
        assert_eq!(blocked["status"]["kind"], "blocked");
        assert_eq!(blocked["status"]["cause"], "node_offline");
        assert_eq!(blocked["status"]["node"]["seq"], 1);
        assert_eq!(blocked["status"]["node"]["name"], "东京-01");
        assert_eq!(blocked["status"]["node"]["member_name"], "东京-01");

        let degraded = find("港新链");
        assert_eq!(degraded["status"]["kind"], "degraded");
        assert_eq!(degraded["status"]["cause"], "no_samples");
        assert_eq!(degraded["status"]["node"], Value::Null);

        let healthy = find("港新直达");
        assert_eq!(healthy["status"]["kind"], "ok");
        assert_eq!(healthy["status"]["cause"], Value::Null);
        assert_eq!(healthy["status"]["node"], Value::Null);
        // target 节点 status 恒为 null，不能把链判成 degraded。
        let nodes = healthy["nodes"].as_array().unwrap();
        assert_eq!(nodes.last().unwrap()["role"], "target");
        assert_eq!(nodes.last().unwrap()["status"], Value::Null);
        // 既有字段回归：blocked 链没有样本，missing_hops 仍按原口径给出最后一跳。
        assert_eq!(blocked["missing_hops"], json!([2]));
    }

    /// 起点/终点：入口端口用 `public_port`，终点用成员 `listen_port`；
    /// 逐段 `series` 与链级同长，缺桶 null、无探测 loss null。
    #[tokio::test]
    async fn chain_health_exposes_entry_exit_and_per_segment_series() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "203.0.113.11").await;
        let b = server(pool, "东京-01", "198.51.100.21").await;
        let c = server(pool, "大阪-01", "198.51.100.23").await;
        let chain_id = chain_with_entry_port(
            pool,
            "港日链",
            vec![vec![&a], vec![&b], vec![&c]],
            Some(40001),
        )
        .await;
        let end = end_at(repo::now(), 900);
        let ts = end - 60;
        // 第 1 段 16ms / 2/240；第 2 段 58ms / 24/240；最后一跳 5ms / 0/240。
        latency::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), "", 16)
            .await
            .unwrap();
        latency::record_sample(pool, ts, &b, &forward_id(&chain_id, 1, &b, 1), "", 58)
            .await
            .unwrap();
        latency::record_sample(pool, ts, &c, &forward_id(&chain_id, 2, &c, 1), "", 5)
            .await
            .unwrap();
        chain_probe::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), 240, 2)
            .await
            .unwrap();
        chain_probe::record_sample(pool, ts, &b, &forward_id(&chain_id, 1, &b, 1), 240, 24)
            .await
            .unwrap();
        chain_probe::record_sample(pool, ts, &c, &forward_id(&chain_id, 2, &c, 1), 240, 0)
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

        assert_eq!(view["entry"]["server_id"], a);
        assert_eq!(view["entry"]["server_name"], "香港-01");
        assert_eq!(view["entry"]["address"], "203.0.113.11:40001");
        assert_eq!(view["entry"]["ip"], "203.0.113.11");
        assert_eq!(view["entry"]["port"], 40001);
        assert!(
            view["entry"].get("address_source").is_none(),
            "正常公网地址不带 address_source：{view}"
        );
        let exit_port = listen_port_of(pool, &chain_id, &c).await;
        assert_eq!(view["exit"]["server_id"], c);
        assert_eq!(view["exit"]["server_name"], "大阪-01");
        assert_eq!(
            view["exit"]["address"],
            format!("198.51.100.23:{exit_port}")
        );
        assert_eq!(view["exit"]["port"], exit_port);

        let segments = view["segments"].as_array().unwrap();
        let chain_series_len = view["series"].as_array().unwrap().len();
        assert_eq!(chain_series_len, 4);
        assert_eq!(segments.len(), 3, "3 组 = 3 段（含最后一跳）");
        assert_eq!(view["missing_hops"], json!([]));
        for segment in segments {
            assert_eq!(
                segment["series"].as_array().unwrap().len(),
                chain_series_len,
                "段 {} 的序列必须与链级同长",
                segment["seq"]
            );
        }
        let first = &segments[0]["series"][3];
        assert_eq!(first["ts"], end - 900);
        assert_eq!(first["p50"], 16.0);
        assert_eq!(first["loss_pct"], 0.8333);
        assert!(segments[0]["series"][2].is_null(), "没有样本的桶是 null");
        let second = &segments[1]["series"][3];
        assert_eq!(second["p50"], 58.0);
        assert_eq!(second["loss_pct"], 10.0);
        assert!(
            segments[1]["series"][2].is_null(),
            "该段没有时延样本时整桶 null"
        );
        let last = &segments[2]["series"][3];
        assert_eq!(last["p50"], 5.0);
        assert_eq!(last["loss_pct"], 0.0);
        assert!(segments[2]["series"][2].is_null());

        // 既有字段回归：逐段/整链时延与丢包口径不变（只是多了最后一跳）。
        assert_eq!(segments[0]["p50"], 16.0);
        assert_eq!(segments[1]["p50"], 58.0);
        assert_eq!(segments[2]["p50"], 5.0);
        assert_eq!(segments[2]["seq"], 3);
        assert_eq!(segments[2]["to"], "链目标");
        assert_eq!(segments[0]["attempts"], 240);
        assert_eq!(segments[0]["failures"], 2);
        assert_eq!(segments[0]["loss_pct"], 0.8333);
        assert_eq!(segments[1]["loss_pct"], 10.0);
        assert_eq!(segments[2]["attempts"], 240);
        assert_eq!(segments[2]["failures"], 0);
        assert_eq!(segments[2]["loss_pct"], 0.0);
        assert_eq!(view["loss_pct"], 10.75);
        assert_eq!(
            view["loss_samples"],
            json!({ "attempts": 720, "failures": 26 })
        );
        assert_eq!(view["series"][3]["p50"], 79.0);
        assert_eq!(view["series"][3]["samples"], 3);
    }

    /// 多成员组：起点/终点都按 `(priority, server_id)` 选第一台。
    #[tokio::test]
    async fn chain_health_multi_member_endpoints_use_priority_order() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "203.0.113.11").await;
        let b = server(pool, "东京-01", "198.51.100.21").await;
        let c = server(pool, "东京-02", "198.51.100.22").await;
        let chain_id = chain(pool, "港日多路径", vec![vec![&a], vec![&b, &c]]).await;
        let exit_port = listen_port_of(pool, &chain_id, &b).await;

        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let view = &body["chains"][0];
        assert_eq!(view["estimated"], true);
        assert_eq!(view["entry"]["server_id"], a);
        assert_eq!(
            view["exit"]["server_id"], b,
            "priority 0 的成员是终点，不受插入顺序影响"
        );
        assert_eq!(
            view["exit"]["address"],
            format!("198.51.100.21:{exit_port}")
        );
        // nodes：多成员组展开全部成员（顺序 = priority 0 的 b、1 的 c），
        // `server_id` 仍是代表成员；组级 status 取最差成员。
        let nodes = view["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 3);
        assert_eq!(nodes[1]["server_id"], b);
        assert_eq!(nodes[1]["role"], "hop");
        assert_eq!(nodes[1]["member_count"], 2);
        assert_eq!(
            nodes[1]["members"],
            json!([
                { "server_id": b, "name": "东京-01", "status": "offline" },
                { "server_id": c, "name": "东京-02", "status": "offline" },
            ])
        );
        assert_eq!(nodes[1]["status"], "offline", "两台都离线 → 组级 offline");
        assert_eq!(nodes[2]["role"], "target");
        assert_eq!(nodes[2]["server_id"], Value::Null);
        assert_eq!(nodes[2]["status"], Value::Null);
        assert_eq!(nodes[2]["member_count"], 0);
        assert_eq!(nodes[2]["members"], json!([]));
        assert_eq!(view["missing_hops"], json!([2]));
        assert_eq!(view["segments"].as_array().unwrap().len(), 2);
        // 段成员明细与 nodes 同序、同 status；轮询策略不标 active。
        let hop_members = view["segments"][1]["members"].as_array().unwrap();
        assert_eq!(hop_members.len(), 2);
        assert_eq!(
            hop_members
                .iter()
                .map(|member| &member["server_id"])
                .collect::<Vec<_>>(),
            nodes[1]["members"]
                .as_array()
                .unwrap()
                .iter()
                .map(|member| &member["server_id"])
                .collect::<Vec<_>>()
        );
        for member in hop_members {
            assert_eq!(member["status"], "offline");
            assert_eq!(member["p50_ms"], Value::Null);
            assert_eq!(member["active"], false, "轮询段全 false");
        }
        assert_eq!(view["segments"][0]["members"].as_array().unwrap().len(), 1);
        assert_eq!(view["segments"][0]["members"][0]["active"], false);
    }

    /// 多成员组的第二台成员离线：只是容量下降，链仍可用 → `degraded` /
    /// `node_offline`，并点名该成员（不是代表成员）。
    #[tokio::test]
    async fn chain_health_degrades_when_the_second_member_of_a_group_is_offline() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "203.0.113.11").await;
        let b = server(pool, "东京-01", "198.51.100.21").await;
        let c = server(pool, "东京-02", "198.51.100.22").await;
        servers::mark_online(pool, &a).await.unwrap();
        servers::mark_online(pool, &b).await.unwrap();
        // c 不标记在线：默认 offline。
        let chain_id = chain(pool, "港日多路径", vec![vec![&a], vec![&b, &c]]).await;
        let ts = end_at(repo::now(), 900) - 60;
        // 在线成员的样本完整：blocked 不能是因为缺样本。
        latency::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), &b, 10)
            .await
            .unwrap();
        latency::record_sample(pool, ts, &b, &forward_id(&chain_id, 1, &b, 2), "", 5)
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
        assert_eq!(view["missing_hops"], json!([]), "在线成员的数据完整");
        assert_eq!(
            view["status"]["kind"], "degraded",
            "多成员组只掉一台，链路仍然可用"
        );
        assert_eq!(view["status"]["cause"], "node_offline");
        assert_eq!(view["status"]["node"]["seq"], 1);
        assert_eq!(view["status"]["node"]["name"], "东京-02");
        assert_eq!(view["status"]["node"]["member_name"], "东京-02");
        let nodes = view["nodes"].as_array().unwrap();
        assert_eq!(nodes[1]["status"], "offline", "组级状态取最差成员");
        assert_eq!(nodes[1]["member_count"], 2);
        assert_eq!(nodes[1]["members"][0]["status"], "online");
        assert_eq!(nodes[1]["members"][1]["status"], "offline");
    }

    /// 多成员组的两台全部离线：这一跳没有在线成员 → 链 `blocked`。
    #[tokio::test]
    async fn chain_health_blocks_when_every_member_of_a_group_is_offline() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "203.0.113.11").await;
        let b = server(pool, "东京-01", "198.51.100.21").await;
        let c = server(pool, "东京-02", "198.51.100.22").await;
        servers::mark_online(pool, &a).await.unwrap();
        // b / c 都不标记在线：默认 offline。
        let chain_id = chain(pool, "港日多路径", vec![vec![&a], vec![&b, &c]]).await;
        let ts = end_at(repo::now(), 900) - 60;
        // 在线入口的样本齐全：blocked 不能是因为缺样本。
        latency::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), &b, 10)
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
        assert_eq!(view["status"]["kind"], "blocked");
        assert_eq!(view["status"]["cause"], "node_offline");
        assert_eq!(view["status"]["node"]["seq"], 1);
        assert_eq!(view["status"]["node"]["member_name"], "东京-01");
    }

    /// 筛选命中中转服务器时链被保留，但起点/终点仍是原链的第一/最后一组。
    #[tokio::test]
    async fn chain_health_filter_keeps_the_original_entry_and_exit() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "203.0.113.11").await;
        let b = server(pool, "东京-01", "198.51.100.21").await;
        let c = server(pool, "大阪-01", "198.51.100.23").await;
        let chain_id = chain_with_entry_port(
            pool,
            "港日链",
            vec![vec![&a], vec![&b], vec![&c]],
            Some(40002),
        )
        .await;
        let exit_port = listen_port_of(pool, &chain_id, &c).await;

        let (status, _, body) = request(
            &app,
            Some(&admin),
            &format!("/api/v1/overview/chain-health?hours=1&bucket=900&server_ids={b}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["scope"]["filtered"], true);
        assert_eq!(body["summary"]["total_chains"], 1);
        let view = &body["chains"][0];
        assert_eq!(view["entry"]["server_id"], a);
        assert_eq!(view["entry"]["address"], "203.0.113.11:40002");
        assert_eq!(view["exit"]["server_id"], c);
        assert_eq!(
            view["exit"]["address"],
            format!("198.51.100.23:{exit_port}")
        );
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
            // 最后一跳稳定 10ms，不制造增量。
            latency::record_sample(pool, ts + 60, &c, &forward_id(&chain_id, 2, &c, 1), "", 10)
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
        assert_eq!(view["segments"][2]["p50"], 10.0);
        assert_eq!(view["segments"][2]["contribution_pct"], 0);
        assert_eq!(view["diagnosis"]["kind"], "single_hop");
        assert_eq!(view["diagnosis"]["seq"], 2);
        assert_eq!(body["summary"]["slow_chains"], 1);
        assert_eq!(body["summary"]["hop_p50_ms"], 85);
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
        // 最后一跳到链目标：独立成段，24/240 = 10% 必须计入整链连乘，
        // 但不能混进前两段（各自仍是 2/240）。
        chain_probe::record_sample(pool, ts, &c, &forward_id(&chain_id, 2, &c, 1), 240, 24)
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
        assert_eq!(view["segments"][2]["loss_pct"], 10.0, "最后一跳独立计算");
        // 1 - (1 - 2/240)² × 0.9 = 11.4937%，不是把三段相加的 11.6667%。
        assert_eq!(view["loss_pct"], 11.4937);
        assert_eq!(
            view["loss_samples"],
            json!({ "attempts": 720, "failures": 28 })
        );
        assert_eq!(view["loss_partial"], false);
        assert_eq!(body["summary"]["loss_pct"], 11.4937);
        assert_eq!(body["summary"]["worst_loss"]["chain_id"], chain_id);
        assert_eq!(body["summary"]["worst_loss"]["chain_name"], "港日链");
        assert_eq!(body["summary"]["worst_loss"]["loss_pct"], 11.4937);
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
        let first_forward = forward_id(&chain_id, 0, &a, 1);

        // 三个有样本的桶：一个没有探测、一个 1%、一个 50%。
        // 最后一跳每个桶都有时延（没有探测），整桶才齐全。
        for ts in [end - 3 * 900 + 60, end - 2 * 900 + 60, end - 900 + 60] {
            latency::record_sample(pool, ts, &a, &first_forward, "", 20)
                .await
                .unwrap();
            latency::record_sample(pool, ts, &b, &forward_id(&chain_id, 1, &b, 1), "", 10)
                .await
                .unwrap();
        }
        chain_probe::record_sample(pool, end - 2 * 900 + 60, &a, &first_forward, 100, 1)
            .await
            .unwrap();
        chain_probe::record_sample(pool, end - 900 + 60, &a, &first_forward, 100, 50)
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
        assert_eq!(series[1]["p50"], 30.0);
        assert_eq!(series[1]["loss_pct"], Value::Null, "该桶无探测");
        assert_eq!(series[2]["loss_pct"], 1.0);
        assert_eq!(series[3]["loss_pct"], 50.0);
        // 链级窗口值是两桶计数合并后的 25.5%，与逐桶值不同。
        assert_eq!(body["chains"][0]["loss_pct"], 25.5);
        // 最后一跳没有探测：逐段是 null，整链只覆盖第 1 段 → partial。
        assert_eq!(body["chains"][0]["segments"][1]["loss_pct"], Value::Null);
        assert_eq!(body["chains"][0]["loss_partial"], true);
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

    /// 建一条指定引擎 / 协议的链（用于不可测最后一跳的回归）。
    async fn chain_with_runtime(
        pool: &sqlx::SqlitePool,
        name: &str,
        groups: Vec<Vec<&str>>,
        engine: &str,
        protocol: &str,
    ) -> String {
        static NEXT_PORT: AtomicI64 = AtomicI64::new(24_000);
        let groups = groups
            .into_iter()
            .enumerate()
            .map(|(seq, members)| NewChainGroup {
                name: Some(format!("hop-{seq}")),
                strategy: "round_robin".into(),
                cert_id: None,
                public_port: None,
                use_internal_address: false,
                members: members
                    .into_iter()
                    .enumerate()
                    .map(|(priority, server_id)| NewChainGroupMember {
                        server_id: server_id.into(),
                        listen_port: NEXT_PORT.fetch_add(1, Ordering::Relaxed),
                        priority: priority as i64,
                        weight: 1,
                    })
                    .collect(),
            })
            .collect();
        repo::chains::create(
            pool,
            NewChain {
                name: name.into(),
                target_host: "target.example".into(),
                target_port: 443,
                enabled: true,
                engine: engine.into(),
                protocol: protocol.into(),
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

    /// B1 + B2：Agent 不探测的链（realm / nftables / tunnel / udp / both）
    /// 最后一跳标 `measurable: false`、不拖空 `series`、不进 `missing_hops`，
    /// 状态是 `unknown` / `unmeasurable` 而不是 `degraded` / `no_samples`；
    /// native + tcp 的最后一跳仍然可测（回归）。
    #[tokio::test]
    async fn chain_health_marks_unprobeable_chains_instead_of_no_samples() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        servers::mark_online(pool, &a).await.unwrap();
        servers::mark_online(pool, &b).await.unwrap();

        let cases = [
            ("realm-tcp", "realm", "tcp", "engine_unsupported"),
            ("nftables-tcp", "nftables", "tcp", "engine_unsupported"),
            ("tunnel-tcp", "tunnel", "tcp", "engine_unsupported"),
            ("native-udp", "native", "udp", "protocol_unsupported"),
            ("native-both", "native", "both", "protocol_unsupported"),
        ];
        let mut ids = Vec::new();
        for (name, engine, protocol, _) in cases {
            ids.push((
                name,
                chain_with_runtime(pool, name, vec![vec![&a], vec![&b]], engine, protocol).await,
            ));
        }
        // native + tcp：最后一跳仍应参与（回归）。
        let measurable = chain_with_runtime(
            pool,
            "native-tcp",
            vec![vec![&a], vec![&b]],
            "native",
            "tcp",
        )
        .await;

        let ts = end_at(repo::now(), 900) - 60;
        for (name, chain_id) in &ids {
            // 只写中间段：最后一跳按引擎 / 协议不会产生样本。
            latency::record_sample(pool, ts, &a, &forward_id(chain_id, 0, &a, 1), &b, 20)
                .await
                .unwrap_or_else(|error| panic!("{name}: {error}"));
        }
        latency::record_sample(pool, ts, &a, &forward_id(&measurable, 0, &a, 1), &b, 20)
            .await
            .unwrap();
        latency::record_sample(pool, ts, &b, &forward_id(&measurable, 1, &b, 1), "", 10)
            .await
            .unwrap();

        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let chains = body["chains"].as_array().unwrap();
        let find = |name: &str| {
            chains
                .iter()
                .find(|chain| chain["name"] == name)
                .unwrap_or_else(|| panic!("缺少链 {name}：{body}"))
        };

        for (name, _, _, reason) in cases {
            let view = find(name);
            assert_eq!(view["hops"], 2, "{name}");
            assert_eq!(view["last_hop"]["measurable"], false, "{name}");
            assert_eq!(view["last_hop"]["reason"], reason, "{name}");
            assert_eq!(view["missing_hops"], json!([]), "{name}：不可测不是缺失");
            assert_eq!(view["status"]["kind"], "unknown", "{name}");
            assert_eq!(view["status"]["cause"], "unmeasurable", "{name}");
            assert_eq!(
                view["series"].as_array().unwrap().last().unwrap()["p50"],
                20.0,
                "{name}：曲线不能被不可测的最后一跳拖空"
            );
            assert_eq!(view["segments"].as_array().unwrap().len(), 2, "{name}");
        }

        let view = find("native-tcp");
        assert_eq!(view["last_hop"]["measurable"], true);
        assert_eq!(view["last_hop"]["reason"], Value::Null);
        assert_eq!(view["missing_hops"], json!([]));
        assert_eq!(view["status"]["kind"], "ok");
        assert_eq!(
            view["series"].as_array().unwrap().last().unwrap()["p50"],
            30.0
        );
    }

    /// 响应里的 `nodes[].strategy` 取组策略（入口 / 目标为 null），
    /// `active_server_id` 从入口代表成员沿心跳 `active=true` 逐跳走出；
    /// 缓存与 `server_ids` 筛选的行为不变。
    #[tokio::test]
    async fn chain_health_reports_node_strategy_and_active_path() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let c = server(pool, "东京-02", "10.0.0.3").await;
        let d = server(pool, "大阪-01", "10.0.0.4").await;
        for id in [&a, &b, &c, &d] {
            servers::mark_online(pool, id).await.unwrap();
        }
        let chain_id = chain_with_strategies(
            pool,
            "港日多路径",
            vec![
                (vec![&a], "round_robin"),
                (vec![&b, &c], "failover"),
                (vec![&d], "failover"),
            ],
        )
        .await;
        // 入口 → 第 1 跳选中 c；c → 第 2 跳选中 d。
        save_probes(
            &state,
            &a,
            &forward_id(&chain_id, 0, &a, 1),
            &[
                (b.as_str(), true, Some(12), Some(false)),
                (c.as_str(), true, Some(23), Some(true)),
            ],
        )
        .await;
        save_probes(
            &state,
            &c,
            &forward_id(&chain_id, 1, &c, 2),
            &[(d.as_str(), true, Some(4), Some(true))],
        )
        .await;
        let uri = "/api/v1/overview/chain-health?hours=1&bucket=900";
        let (status, headers, body) = request(&app, Some(&admin), uri).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(headers["x-chain-health-cache"], "miss");
        let nodes = body["chains"][0]["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 4);
        assert_eq!(nodes[0]["strategy"], Value::Null, "入口组没有选路策略");
        assert_eq!(nodes[0]["active_server_id"], Value::Null);
        assert_eq!(nodes[1]["strategy"], "failover");
        assert_eq!(nodes[1]["active_server_id"], c);
        assert_eq!(nodes[2]["strategy"], "failover");
        assert_eq!(nodes[2]["active_server_id"], d);
        assert_eq!(nodes[3]["strategy"], Value::Null);
        assert_eq!(nodes[3]["active_server_id"], Value::Null, "链目标恒为 null");

        // 缓存语义不变：同一个 key 第二次命中，整份响应复用。
        let (status, headers, second) = request(&app, Some(&admin), uri).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers["x-chain-health-cache"], "hit");
        assert_eq!(second, body);

        // 筛选语义不变：按成员 c 命中整条链，active 仍按整条链算。
        let (status, headers, filtered) =
            request(&app, Some(&admin), &format!("{uri}&server_ids={c}")).await;
        assert_eq!(status, StatusCode::OK, "body: {filtered}");
        assert_eq!(headers["x-chain-health-cache"], "miss", "筛选是不同 key");
        assert_eq!(filtered["summary"]["total_chains"], 1);
        assert_eq!(filtered["chains"][0]["nodes"][1]["active_server_id"], c);
        assert_eq!(filtered["chains"][0]["nodes"][2]["active_server_id"], d);
    }

    /// 逐段成员明细（`segments[].members`）：成员来自段源组、顺序与
    /// `nodes[].members` 一致；`p50_ms` / `loss_pct` 按成员自己的 forward
    /// 聚合（与段级同一当前窗口），没有样本为 null；failover 只把当前成员
    /// 标成 active，单成员段恒 false；离线成员的 status 原样透传。
    /// 段级聚合口径（p50 取成员池中位数、计数相加）不变。
    #[tokio::test]
    async fn chain_health_exposes_per_segment_member_details() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "203.0.113.11").await;
        let b = server(pool, "东京-01", "198.51.100.21").await;
        let c = server(pool, "东京-02", "198.51.100.22").await;
        let d = server(pool, "东京-03", "198.51.100.23").await;
        servers::mark_online(pool, &a).await.unwrap();
        servers::mark_online(pool, &b).await.unwrap();
        servers::mark_online(pool, &c).await.unwrap();
        // d 不标记在线：默认 offline，用来验证成员 status 透传与缺样本 null。
        let chain_id = chain_with_strategies(
            pool,
            "港日三路",
            vec![(vec![&a], "round_robin"), (vec![&b, &c, &d], "failover")],
        )
        .await;
        let end = end_at(repo::now(), 900);
        let ts = end - 60;
        // 单成员入口段：a 的 forward 指向 b；三成员段：b / c 各有自己的
        // forward，d 没有时延样本。
        latency::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), &b, 20)
            .await
            .unwrap();
        latency::record_sample(pool, ts, &b, &forward_id(&chain_id, 1, &b, 3), "", 10)
            .await
            .unwrap();
        latency::record_sample(pool, ts, &c, &forward_id(&chain_id, 1, &c, 3), "", 30)
            .await
            .unwrap();
        chain_probe::record_sample(pool, ts, &a, &forward_id(&chain_id, 0, &a, 1), 100, 0)
            .await
            .unwrap();
        chain_probe::record_sample(pool, ts, &b, &forward_id(&chain_id, 1, &b, 3), 100, 1)
            .await
            .unwrap();
        chain_probe::record_sample(pool, ts, &c, &forward_id(&chain_id, 1, &c, 3), 100, 4)
            .await
            .unwrap();
        // 入口规则把 c 标成当前选中（b 未选中、d 离线）。
        save_probes(
            &state,
            &a,
            &forward_id(&chain_id, 0, &a, 1),
            &[
                (b.as_str(), true, Some(12), Some(false)),
                (c.as_str(), true, Some(23), Some(true)),
                (d.as_str(), false, None, Some(false)),
            ],
        )
        .await;

        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let view = &body["chains"][0];
        let segments = view["segments"].as_array().unwrap();
        assert_eq!(segments.len(), 2);

        // 单成员段也返回一个元素的数组。
        assert_eq!(
            segments[0]["members"],
            json!([{
                "server_id": a, "name": "香港-01", "status": "online",
                "p50_ms": 20.0, "loss_pct": 0.0,
                "attempts": 100, "failures": 0, "active": false,
            }])
        );

        let members = segments[1]["members"].as_array().unwrap();
        assert_eq!(members.len(), 3);
        // 顺序与 nodes[].members 一致（priority, server_id）。
        assert_eq!(
            members
                .iter()
                .map(|member| &member["server_id"])
                .collect::<Vec<_>>(),
            view["nodes"][1]["members"]
                .as_array()
                .unwrap()
                .iter()
                .map(|member| &member["server_id"])
                .collect::<Vec<_>>()
        );
        assert_eq!(members[0]["server_id"], b);
        assert_eq!(members[0]["name"], "东京-01");
        assert_eq!(members[0]["status"], "online");
        assert_eq!(members[0]["p50_ms"], 10.0);
        assert_eq!(members[0]["loss_pct"], 1.0);
        assert_eq!(members[0]["attempts"], 100);
        assert_eq!(members[0]["failures"], 1);
        assert_eq!(members[0]["active"], false);
        assert_eq!(members[1]["server_id"], c);
        assert_eq!(members[1]["p50_ms"], 30.0);
        assert_eq!(members[1]["loss_pct"], 4.0);
        assert_eq!(members[1]["active"], true, "failover 的当前成员");
        assert_eq!(members[2]["server_id"], d);
        assert_eq!(members[2]["status"], "offline");
        assert_eq!(members[2]["p50_ms"], Value::Null);
        assert_eq!(members[2]["loss_pct"], Value::Null);
        assert_eq!(members[2]["attempts"], 0);
        assert_eq!(members[2]["active"], false);

        // 段级口径不变：成员样本一起取中位数、计数相加。
        assert_eq!(segments[1]["p50"], 20.0, "10 / 30 的中位数");
        assert_eq!(segments[1]["attempts"], 200);
        assert_eq!(segments[1]["failures"], 5);
        assert_eq!(segments[1]["loss_pct"], 2.5);
        // 既有节点断言回归。
        assert_eq!(view["nodes"][1]["member_count"], 3);
        assert_eq!(view["nodes"][1]["active_server_id"], c);
    }

    /// 上一跳通路成员离线：该跳之后的 active 全部中断，但已确定的成员保留。
    #[tokio::test]
    async fn chain_health_active_path_stops_after_an_offline_member() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let c = server(pool, "东京-02", "10.0.0.3").await;
        let d = server(pool, "大阪-01", "10.0.0.4").await;
        servers::mark_online(pool, &a).await.unwrap();
        servers::mark_online(pool, &b).await.unwrap();
        servers::mark_online(pool, &d).await.unwrap();
        // c 保持默认 offline，但仍被入口选中过。
        let chain_id = chain_with_strategies(
            pool,
            "离线中断",
            vec![
                (vec![&a], "round_robin"),
                (vec![&b, &c], "failover"),
                (vec![&d], "failover"),
            ],
        )
        .await;
        save_probes(
            &state,
            &a,
            &forward_id(&chain_id, 0, &a, 1),
            &[
                (b.as_str(), true, Some(12), Some(false)),
                (c.as_str(), true, Some(23), Some(true)),
            ],
        )
        .await;
        save_probes(
            &state,
            &c,
            &forward_id(&chain_id, 1, &c, 2),
            &[(d.as_str(), true, Some(4), Some(true))],
        )
        .await;

        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        let nodes = body["chains"][0]["nodes"].as_array().unwrap();
        assert_eq!(nodes[1]["active_server_id"], c, "被选中的离线成员仍可见");
        assert_eq!(
            nodes[2]["active_server_id"],
            Value::Null,
            "离线后不能继续走"
        );
    }

    /// 旧 Agent 的 JSON 没有 active 键：落库保持旧格式，响应该跳为 null，
    /// 不能因为缺字段报错。
    #[tokio::test]
    async fn chain_health_reads_legacy_probe_json_without_active() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let c = server(pool, "东京-02", "10.0.0.3").await;
        servers::mark_online(pool, &a).await.unwrap();
        let chain_id = chain_with_strategies(
            pool,
            "旧 Agent",
            vec![(vec![&a], "round_robin"), (vec![&b, &c], "failover")],
        )
        .await;
        let entry = forward_id(&chain_id, 0, &a, 1);
        save_probes(
            &state,
            &a,
            &entry,
            &[
                (b.as_str(), true, Some(12), None),
                (c.as_str(), true, Some(23), None),
            ],
        )
        .await;
        // 与协议 29 完全一致的旧格式：没有 active 键。
        let rows = repo::forwards::latest_targets(pool, &[entry])
            .await
            .unwrap();
        let raw = rows[0].targets_json.as_deref().expect("targets 必须落库");
        assert!(!raw.contains("active"), "旧 Agent 格式不能多出新键：{raw}");

        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(
            body["chains"][0]["nodes"][1]["active_server_id"],
            Value::Null
        );
    }

    /// `targets_json` 是坏 JSON：只影响该跳（以及之后）的 active，接口仍然 200。
    #[tokio::test]
    async fn chain_health_treats_invalid_probe_json_as_no_data() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let b = server(pool, "东京-01", "10.0.0.2").await;
        let c = server(pool, "东京-02", "10.0.0.3").await;
        let d = server(pool, "大阪-01", "10.0.0.4").await;
        for id in [&a, &b, &c, &d] {
            servers::mark_online(pool, id).await.unwrap();
        }
        let chain_id = chain_with_strategies(
            pool,
            "坏 JSON",
            vec![
                (vec![&a], "round_robin"),
                (vec![&b, &c], "failover"),
                (vec![&d], "failover"),
            ],
        )
        .await;
        save_probes(
            &state,
            &a,
            &forward_id(&chain_id, 0, &a, 1),
            &[
                (b.as_str(), true, Some(12), Some(false)),
                (c.as_str(), true, Some(23), Some(true)),
            ],
        )
        .await;
        let bad_forward = forward_id(&chain_id, 1, &c, 2);
        save_probes(
            &state,
            &c,
            &bad_forward,
            &[(d.as_str(), true, Some(4), Some(true))],
        )
        .await;
        // 模拟历史脏数据 / 手改库：仓储的正常写路径不会产生坏 JSON。
        sqlx::query("UPDATE forward_status SET targets_json = ? WHERE forward_id = ?")
            .bind("{not json")
            .bind(&bad_forward)
            .execute(pool)
            .await
            .unwrap();

        let (status, _, body) = request(
            &app,
            Some(&admin),
            "/api/v1/overview/chain-health?hours=1&bucket=900",
        )
        .await;
        assert_eq!(status, StatusCode::OK, "坏 JSON 不能让接口 500：{body}");
        let nodes = body["chains"][0]["nodes"].as_array().unwrap();
        assert_eq!(nodes[1]["active_server_id"], c, "上一跳记录仍然有效");
        assert_eq!(nodes[2]["active_server_id"], Value::Null, "坏数据当无数据");
    }

    /// B7：缓存 key 分开存「命中的」与「未知的」——同一个 id 从存在变成
    /// 未知必须 miss，不能命中「它还存在」的旧响应。
    #[tokio::test]
    async fn chain_health_cache_distinguishes_matched_and_unknown_ids() {
        let (app, state, admin) = setup().await;
        let pool = &state.db.pool;
        let a = server(pool, "香港-01", "10.0.0.1").await;
        let uri = format!("/api/v1/overview/chain-health?hours=1&bucket=900&server_ids={a}");

        let (status, headers, body) = request(&app, Some(&admin), &uri).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(headers["x-chain-health-cache"], "miss");
        assert_eq!(body["scope"]["server_ids"], json!([a]));
        assert_eq!(body["warnings"]["unknown_ids"], json!([]));

        // 删除服务器：同一个 id 变成未知。key 若只按合并后的 id 集合，
        // 第二次会命中旧条目（scope 里还有它、也没有 warning）。
        assert!(repo::servers::delete(pool, &a).await.unwrap());
        let (status, headers, body) = request(&app, Some(&admin), &uri).await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(
            headers["x-chain-health-cache"], "miss",
            "「X 存在」与「X 未知」必须是不同 key"
        );
        assert_eq!(body["scope"]["server_ids"], json!([]));
        assert_eq!(body["warnings"]["unknown_ids"], json!([a]));
    }
}
