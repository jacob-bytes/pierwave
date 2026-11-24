//! 「转发链模板」洞察：`/api/v1/overview/chain-templates` 与
//! `/api/v1/overview/chain-templates/{id}?hours=24`（仅管理员）。
//!
//! 列表页回答「每个模板被多少条链 / 多少个用户在用、当前能不能用、走什么
//! 策略 / 目标」，详情页回答「真实链怎么走、实际路径的边有多快 / 丢多少包、
//! 哪些候选没被用到、用户增长曲线」。详情的 `nodes` / `edges` 只来自真实链的
//! 拓扑，模板只提供候选与名称；模板与链不一致时 `template.stale` 标记。
//! 聚合规则全部在
//! [`pierwave_domain::chain_template_insight`]；这里只做鉴权、参数校验、
//! 固定次数取数、30 秒缓存与 JSON 包装。
//!
//! 查询次数固定，与模板 / 链 / 成员数量无关：
//!
//! 列表：模板 1 → 链拓扑 3（链 / 组 / 成员 JOIN 服务器）→ 服务器状态 1。
//! 详情：模板 1 → 链拓扑 3 → 服务器状态 1 → 用户名字 1 →
//! `forward_latency_samples` 1 → `forward_probe_samples` 1。样本只在详情页
//! 且只覆盖当前 2h 窗口；链一多也是 `forward_id IN (...)` 一次查完，没有 N+1。
//!
//! 缓存 30 秒，key = `(template_id, hours)`；列表固定 `(None, 0)`。响应头
//! `X-Chain-Templates-Cache: hit|miss`。口径见
//! [`docs/CHAIN-TEMPLATE-INSIGHT.md`](../../../docs/CHAIN-TEMPLATE-INSIGHT.md)。

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue};
use axum::Json;
use serde::Serialize;
use serde_json::{json, Value};

use pierwave_domain::chain_health;
use pierwave_domain::chain_template_insight as insight;
use pierwave_domain::models::ChainWithGroups;
use pierwave_domain::repo;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::overview::last_query_value;

const DEFAULT_HOURS: i64 = 24;
const HOURS_24: i64 = 24;
const HOURS_168: i64 = 168;

#[derive(Debug, Serialize)]
struct ListResponse {
    generated_at: i64,
    items: Vec<insight::TemplateListItem>,
}

#[derive(Debug, Serialize)]
struct DetailResponse {
    generated_at: i64,
    #[serde(flatten)]
    detail: insight::TemplateDetail,
}

/// `hours` 只接受 24 / 168：详情页的曲线就是「最近一天 / 最近一周」两个
/// 粒度，传别的值更像拼错参数，直接 400 而不是悄悄取最近值。
fn parse_hours(raw: Option<&str>) -> AppResult<i64> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(DEFAULT_HOURS);
    };
    match raw.parse::<i64>() {
        Ok(HOURS_24) => Ok(HOURS_24),
        Ok(HOURS_168) => Ok(HOURS_168),
        _ => Err(AppError::coded(
            "query.chain_templates_hours_invalid",
            Some(json!({ "allowed": [HOURS_24, HOURS_168], "default": DEFAULT_HOURS })),
            format!(
                "hours 只能是 {HOURS_24} 或 {HOURS_168}（默认 {DEFAULT_HOURS}） / \
                 hours must be {HOURS_24} or {HOURS_168}"
            ),
        )),
    }
}

fn cache_headers(hit: bool) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(header::VARY, HeaderValue::from_static("Cookie"));
    headers.insert(
        HeaderName::from_static("x-chain-templates-cache"),
        HeaderValue::from_static(if hit { "hit" } else { "miss" }),
    );
    headers
}

/// 服务器名称 + 状态快照：模板候选成员可能不落在任何一条链里，不能只靠
/// 链拓扑里的 `servers` 行。
async fn server_states(state: &AppState) -> AppResult<HashMap<String, insight::ServerState>> {
    Ok(repo::servers::list(&state.db.pool)
        .await?
        .into_iter()
        .map(|server| {
            (
                server.id,
                insight::ServerState {
                    name: server.name,
                    status: server.status,
                },
            )
        })
        .collect())
}

fn owner_ids(chains: &[&ChainWithGroups]) -> Vec<String> {
    let mut owners: Vec<String> = chains
        .iter()
        .filter_map(|chain| chain.chain.owner_user_id.clone())
        .filter(|owner| !owner.is_empty())
        .collect();
    owners.sort_unstable();
    owners.dedup();
    owners
}

async fn user_names(state: &AppState, ids: &[String]) -> AppResult<HashMap<String, String>> {
    Ok(repo::users::names_by_ids(&state.db.pool, ids).await?)
}

/// 该模板的链推导出的全部 forward id：单成员组是 `chain-<id>-<seq>`，多成员
/// 组是 `chain-<id>-<seq>-<server_id>`，与 chain-health 完全同一套规则。
fn template_forward_ids(chains: &[ChainWithGroups], template_id: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for chain in chains {
        if chain.chain.template_id.as_deref() != Some(template_id) {
            continue;
        }
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

async fn build_list(state: &AppState, now: i64) -> AppResult<Value> {
    let templates = repo::chain_templates::list(&state.db.pool).await?;
    let chains = repo::chains::list_topology(&state.db.pool).await?;
    let servers = server_states(state).await?;
    let response = ListResponse {
        generated_at: now,
        items: insight::list(&templates, &chains, &servers),
    };
    serde_json::to_value(response).map_err(|error| AppError::Internal(error.into()))
}

pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<(HeaderMap, Json<Value>)> {
    user.require_admin()?;
    let (body, cache_hit) = match state.chain_template_insight.get(None, 0) {
        Some(value) => (value, true),
        None => {
            let value = build_list(&state, repo::now()).await?;
            state.chain_template_insight.put(None, 0, value.clone());
            (value, false)
        }
    };
    Ok((cache_headers(cache_hit), Json(body)))
}

async fn build_detail(
    state: &AppState,
    template_id: &str,
    hours: i64,
    now: i64,
) -> AppResult<Option<Value>> {
    let pool = &state.db.pool;
    let Some(template) = repo::chain_templates::find_by_id(pool, template_id).await? else {
        return Ok(None);
    };
    let chains = repo::chains::list_topology(pool).await?;
    let relevant: Vec<&ChainWithGroups> = chains
        .iter()
        .filter(|chain| chain.chain.template_id.as_deref() == Some(template_id))
        .collect();
    let servers = server_states(state).await?;
    let users = user_names(state, &owner_ids(&relevant)).await?;

    // 边 p50 / 丢包与 chain-health 同口径：最近 2 小时。hours 只影响增长曲线，
    // 不让 168h 的中位数把最近的事故稀释掉。
    let forward_ids = template_forward_ids(&chains, template_id);
    let since = now - chain_health::CURRENT_WINDOW_SECS;
    let samples = repo::latency::list_for_forwards(pool, &forward_ids, since).await?;
    let probes = repo::chain_probe::totals_for_forwards(pool, &forward_ids, since, now + 1).await?;

    let detail = insight::detail(
        &template,
        &chains,
        &servers,
        &users,
        insight::EdgeData {
            samples: &samples,
            probes: &probes,
        },
        now,
        hours,
    );
    let response = DetailResponse {
        generated_at: now,
        detail,
    };
    Ok(Some(
        serde_json::to_value(response).map_err(|error| AppError::Internal(error.into()))?,
    ))
}

pub async fn detail(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(params): Query<Vec<(String, String)>>,
) -> AppResult<(HeaderMap, Json<Value>)> {
    user.require_admin()?;
    let hours = parse_hours(last_query_value(&params, "hours"))?;
    let (body, cache_hit) = match state.chain_template_insight.get(Some(&id), hours) {
        Some(value) => (value, true),
        None => {
            let value = build_detail(&state, &id, hours, repo::now())
                .await?
                .ok_or_else(|| {
                    AppError::not_found(
                        "chain_template.not_found",
                        Some(json!({ "id": &id })),
                        "链模板不存在 / chain template not found",
                    )
                })?;
            state
                .chain_template_insight
                .put(Some(&id), hours, value.clone());
            (value, false)
        }
    };
    Ok((cache_headers(cache_hit), Json(body)))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicI64, Ordering};

    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::Router;
    use pierwave_domain::models::ChainTemplateGroup;
    use pierwave_domain::repo::chains::{NewChain, NewChainGroup, NewChainGroupMember};
    use pierwave_domain::repo::{chain_probe, latency, servers, sessions, users};
    use pierwave_domain::Db;
    use tower::ServiceExt;

    use crate::state::ChainTemplateInsightCache;

    struct Fixture {
        app: Router,
        state: AppState,
        admin_cookie: String,
        admin_id: String,
    }

    async fn setup() -> Fixture {
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
        state.chain_template_insight =
            ChainTemplateInsightCache::with_ttl(crate::state::CHAIN_TEMPLATE_INSIGHT_CACHE_TTL);
        let app = crate::app::router(state.clone());
        Fixture {
            app,
            state,
            admin_cookie: format!("{}={token}", crate::auth::SESSION_COOKIE),
            admin_id: admin.id,
        }
    }

    async fn make_user(f: &Fixture, username: &str) -> (String, String) {
        let user = users::create(
            &f.state.db.pool,
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
        .unwrap();
        let (token, _) = sessions::create(&f.state.db.pool, &user.id, 3600, None)
            .await
            .unwrap();
        (user.id, format!("{}={token}", crate::auth::SESSION_COOKIE))
    }

    async fn make_server(f: &Fixture, name: &str, online: bool) -> String {
        let (server, _) = servers::create(&f.state.db.pool, name, "10.0.0.1", "external")
            .await
            .unwrap();
        if online {
            servers::mark_online(&f.state.db.pool, &server.id)
                .await
                .unwrap();
        }
        server.id
    }

    async fn make_template(
        f: &Fixture,
        name: &str,
        enabled: bool,
        groups: &[(&str, &[&str])],
    ) -> String {
        let groups: Vec<ChainTemplateGroup> = groups
            .iter()
            .enumerate()
            .map(|(seq, (strategy, server_ids))| ChainTemplateGroup {
                seq: seq as i64,
                strategy: (*strategy).into(),
                server_ids: server_ids.iter().map(|id| (*id).to_string()).collect(),
            })
            .collect();
        let groups =
            pierwave_domain::chain_templates::normalize_groups(groups).expect("模板组必须合法");
        repo::chain_templates::create(
            &f.state.db.pool,
            repo::chain_templates::NewChainTemplate {
                name: name.into(),
                engine: "native".into(),
                security: "tls".into(),
                transport: "none".into(),
                protocol: "tcp".into(),
                groups_json: serde_json::to_string(&groups).unwrap(),
                enabled,
            },
        )
        .await
        .unwrap()
        .id
    }

    fn next_port() -> i64 {
        static NEXT: AtomicI64 = AtomicI64::new(30_000);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    async fn make_chain(
        f: &Fixture,
        template_id: &str,
        owner: Option<&str>,
        target: (&str, i64),
        groups: &[(&str, &[&str])],
    ) -> String {
        let groups: Vec<NewChainGroup> = groups
            .iter()
            .map(|(strategy, server_ids)| NewChainGroup {
                name: None,
                strategy: (*strategy).into(),
                cert_id: None,
                public_port: None,
                use_internal_address: false,
                members: server_ids
                    .iter()
                    .enumerate()
                    .map(|(priority, server_id)| NewChainGroupMember {
                        server_id: (*server_id).into(),
                        listen_port: next_port(),
                        priority: priority as i64,
                        weight: 1,
                    })
                    .collect(),
            })
            .collect();
        let input = NewChain {
            name: format!("chain-{}", next_port()),
            target_host: target.0.into(),
            target_port: target.1,
            enabled: true,
            engine: "native".into(),
            protocol: "tcp".into(),
            proxy_protocol: false,
            transport: "none".into(),
            tunnel_security: "tls".into(),
            groups,
        };
        let mut tx = repo::WriteTx::begin(&f.state.db.pool).await.unwrap();
        let id = repo::chains::create_in(&mut tx, input, Some(template_id), owner, None)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        id
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
        let bytes = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, headers, value)
    }

    fn cache_header(headers: &HeaderMap) -> &str {
        headers
            .get("x-chain-templates-cache")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
    }

    #[tokio::test]
    async fn list_aggregates_chains_users_status_strategies_and_targets() {
        let f = setup().await;
        let (u1, _) = make_user(&f, "u1").await;
        let (u2, _) = make_user(&f, "u2").await;
        let s1 = make_server(&f, "香港-01", true).await;
        let s2 = make_server(&f, "东京-01", true).await;
        let s3 = make_server(&f, "大阪-01", false).await;
        let tpl = make_template(
            &f,
            "港日双路",
            true,
            &[("ip_hashed", &[&s1, &s2]), ("failover", &[&s3])],
        )
        .await;
        // 管理员链：owner 为空，不计入 users；用户 u1 两条链、u2 一条。
        make_chain(
            &f,
            &tpl,
            None,
            ("1.1.1.1", 443),
            &[("ip_hashed", &[&s1]), ("failover", &[&s3])],
        )
        .await;
        make_chain(
            &f,
            &tpl,
            Some(&u1),
            ("1.1.1.1", 443),
            &[("ip_hashed", &[&s1]), ("failover", &[&s3])],
        )
        .await;
        make_chain(
            &f,
            &tpl,
            Some(&u1),
            ("2.2.2.2", 8443),
            &[("ip_hashed", &[&s1]), ("failover", &[&s3])],
        )
        .await;
        make_chain(
            &f,
            &tpl,
            Some(&u2),
            ("2.2.2.2", 8443),
            &[("ip_hashed", &[&s2]), ("failover", &[&s3])],
        )
        .await;

        let (status, headers, body) = request(
            &f.app,
            Some(&f.admin_cookie),
            "/api/v1/overview/chain-templates",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cache_header(&headers), "miss");
        let item = &body["items"][0];
        assert_eq!(item["id"], tpl);
        assert_eq!(item["name"], "港日双路");
        assert_eq!(item["hops"], 2);
        assert_eq!(item["enabled"], true);
        assert_eq!(item["chains"], 4);
        assert_eq!(item["users"], 2, "管理员链 owner 为空，不计入 users");
        assert_eq!(item["status"]["kind"], "blocked");
        assert_eq!(item["status"]["cause"], "member_offline");
        assert_eq!(item["strategies"][0]["strategy"], "ip_hashed");
        assert_eq!(item["strategies"][0]["chains"], 4);
        assert_eq!(item["targets"][0]["host"], "1.1.1.1");
        assert_eq!(item["targets"][0]["chains"], 2);
        assert_eq!(item["targets"][1]["host"], "2.2.2.2");
        assert_eq!(item["targets"][1]["chains"], 2);
    }

    #[tokio::test]
    async fn detail_lists_all_candidates_and_aggregates_real_edges() {
        let f = setup().await;
        let (u1, _) = make_user(&f, "u1").await;
        let (u2, _) = make_user(&f, "u2").await;
        let s1 = make_server(&f, "香港-01", true).await;
        let s2 = make_server(&f, "东京-01", true).await;
        let s3 = make_server(&f, "大阪-01", false).await;
        let tpl = make_template(
            &f,
            "港日双路",
            true,
            &[("ip_hashed", &[&s1, &s2]), ("failover", &[&s3])],
        )
        .await;
        let admin_chain = make_chain(
            &f,
            &tpl,
            None,
            ("1.1.1.1", 443),
            &[("ip_hashed", &[&s1]), ("failover", &[&s3])],
        )
        .await;
        let u1_chain = make_chain(
            &f,
            &tpl,
            Some(&u1),
            ("1.1.1.1", 443),
            &[("ip_hashed", &[&s1]), ("failover", &[&s3])],
        )
        .await;
        make_chain(
            &f,
            &tpl,
            Some(&u1),
            ("2.2.2.2", 8443),
            &[("ip_hashed", &[&s2]), ("failover", &[&s3])],
        )
        .await;
        make_chain(
            &f,
            &tpl,
            Some(&u2),
            ("2.2.2.2", 8443),
            &[("ip_hashed", &[&s2]), ("failover", &[&s3])],
        )
        .await;

        // 给 s1 → s3 的两条链造当前窗口样本：中位数 15ms，探测 2/200 = 1%。
        let now = repo::now();
        for (chain_id, latency_ms) in [(&admin_chain, 10_i64), (&u1_chain, 20)] {
            let forward_id = pierwave_domain::chains::forward_id(chain_id, 0, &s1, 1);
            latency::record_sample(
                &f.state.db.pool,
                now - 60,
                &s1,
                &forward_id,
                &s3,
                latency_ms,
            )
            .await
            .unwrap();
            chain_probe::record_sample(&f.state.db.pool, now - 60, &s1, &forward_id, 100, 1)
                .await
                .unwrap();
        }

        let (status, headers, body) = request(
            &f.app,
            Some(&f.admin_cookie),
            &format!("/api/v1/overview/chain-templates/{tpl}?hours=24"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cache_header(&headers), "miss");
        assert_eq!(body["template"]["hops"], 2);
        assert_eq!(body["template"]["id"], tpl);

        // 真实链用到的两个入口成员都要出现（顺序 = (priority, server_id)，
        // 不能按模板候选顺序或插入顺序断言）。
        assert_eq!(body["nodes"][0]["role"], "source");
        let source_members = body["nodes"][0]["members"].as_array().unwrap();
        assert_eq!(source_members.len(), 2);
        let tokyo = source_members
            .iter()
            .find(|member| member["name"] == "东京-01")
            .expect("东京-01 是真实链的入口成员");
        assert_eq!(tokyo["chains"], 2);
        assert_eq!(body["nodes"][1]["role"], "hop");
        assert_eq!(body["nodes"][2]["role"], "target");
        assert_eq!(body["nodes"][2]["seq"], 2);
        assert_eq!(body["nodes"][2]["members"].as_array().unwrap().len(), 2);

        let s1_edge = body["edges"]
            .as_array()
            .unwrap()
            .iter()
            .find(|edge| edge["seq"] == 1 && edge["from"]["member"] == "香港-01")
            .cloned()
            .unwrap();
        assert_eq!(s1_edge["chains"], 2, "管理员链 + u1 链");
        assert_eq!(s1_edge["users"], 1, "只有 u1 有 owner");
        assert_eq!(s1_edge["p50_ms"], 15.0);
        assert_eq!(s1_edge["loss_pct"], 1.0);

        assert_eq!(body["targets"].as_array().unwrap().len(), 2);
        assert_eq!(body["targets"][0]["chains"], 2);
        assert_eq!(body["users"].as_array().unwrap().len(), 2);
        assert_eq!(body["strategies"][0]["strategy"], "ip_hashed");
        assert_eq!(body["strategies"][0]["chains"], 4);
        assert_eq!(body["strategies"][0]["users"], 2);
        let series = body["series"].as_array().unwrap();
        assert_eq!(series.len(), 96);
        assert_eq!(series.last().unwrap()["chains"], 4);
        assert_eq!(series.last().unwrap()["users"], 2);
    }

    #[tokio::test]
    async fn statuses_cover_disabled_offline_partial_and_missing_members() {
        let f = setup().await;
        let online = make_server(&f, "在线", true).await;
        let offline = make_server(&f, "离线", false).await;
        let partial = make_template(
            &f,
            "部分离线",
            true,
            &[("round_robin", &[&online]), ("round_robin", &[&offline])],
        )
        .await;
        let all_offline = make_template(&f, "全离线", true, &[("round_robin", &[&offline])]).await;
        let disabled = make_template(&f, "停用", false, &[("round_robin", &[&online])]).await;
        // 手工落一个没有组的模板：读路径必须容错成 degraded，而不是 500。
        let empty = repo::chain_templates::create(
            &f.state.db.pool,
            repo::chain_templates::NewChainTemplate {
                name: "无成员".into(),
                engine: "native".into(),
                security: "tls".into(),
                transport: "none".into(),
                protocol: "tcp".into(),
                groups_json: "[]".into(),
                enabled: true,
            },
        )
        .await
        .unwrap()
        .id;

        let (status, _, body) = request(
            &f.app,
            Some(&f.admin_cookie),
            "/api/v1/overview/chain-templates",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let items = body["items"].as_array().unwrap();
        let by_id = |id: &str| items.iter().find(|item| item["id"] == id).unwrap();
        assert_eq!(by_id(&partial)["status"]["kind"], "blocked");
        assert_eq!(by_id(&partial)["status"]["cause"], "member_offline");
        assert_eq!(by_id(&all_offline)["status"]["kind"], "blocked");
        assert_eq!(by_id(&all_offline)["status"]["cause"], "member_offline");
        assert_eq!(by_id(&disabled)["status"]["kind"], "blocked");
        assert_eq!(by_id(&disabled)["status"]["cause"], "disabled");
        assert_eq!(by_id(&empty)["status"]["kind"], "degraded");
        assert!(by_id(&empty)["status"]["cause"].is_null());

        // 停用模板的详情仍然可读，只是状态 blocked/disabled。
        let (status, _, body) = request(
            &f.app,
            Some(&f.admin_cookie),
            &format!("/api/v1/overview/chain-templates/{disabled}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["template"]["id"], disabled);

        // 无组模板的详情也不能 500：nodes / edges 为空，series 仍补齐。
        let (status, _, body) = request(
            &f.app,
            Some(&f.admin_cookie),
            &format!("/api/v1/overview/chain-templates/{empty}"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["template"]["hops"], 0);
        assert_eq!(body["nodes"].as_array().unwrap().len(), 0);
        assert_eq!(body["edges"].as_array().unwrap().len(), 0);
        assert_eq!(body["series"].as_array().unwrap().len(), 96);
    }

    #[tokio::test]
    async fn templates_sharing_a_server_do_not_leak_counts() {
        let f = setup().await;
        let (u1, _) = make_user(&f, "u1").await;
        let shared = make_server(&f, "共享-01", true).await;
        let t1 = make_template(&f, "模板一", true, &[("round_robin", &[&shared])]).await;
        let t2 = make_template(&f, "模板二", true, &[("round_robin", &[&shared])]).await;
        make_chain(
            &f,
            &t1,
            Some(&u1),
            ("1.1.1.1", 443),
            &[("round_robin", &[&shared])],
        )
        .await;
        make_chain(
            &f,
            &t1,
            Some(&u1),
            ("1.1.1.1", 443),
            &[("round_robin", &[&shared])],
        )
        .await;
        make_chain(
            &f,
            &t2,
            Some(&u1),
            ("1.1.1.1", 443),
            &[("round_robin", &[&shared])],
        )
        .await;

        let (_, _, body) = request(
            &f.app,
            Some(&f.admin_cookie),
            "/api/v1/overview/chain-templates",
        )
        .await;
        let items = body["items"].as_array().unwrap();
        let one = items.iter().find(|item| item["id"] == t1).unwrap();
        let two = items.iter().find(|item| item["id"] == t2).unwrap();
        assert_eq!(one["chains"], 2);
        assert_eq!(one["users"], 1);
        assert_eq!(two["chains"], 1);
        assert_eq!(two["users"], 1);
    }

    #[tokio::test]
    async fn a_template_without_chains_returns_zeroed_series_and_no_targets() {
        let f = setup().await;
        let server = make_server(&f, "香港-01", true).await;
        let tpl = make_template(&f, "空模板", true, &[("round_robin", &[&server])]).await;
        let (status, _, body) = request(
            &f.app,
            Some(&f.admin_cookie),
            &format!("/api/v1/overview/chain-templates/{tpl}?hours=24"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["targets"].as_array().unwrap().len(), 0);
        assert_eq!(body["edges"].as_array().unwrap().len(), 0);
        assert_eq!(body["users"].as_array().unwrap().len(), 0);
        let series = body["series"].as_array().unwrap();
        assert_eq!(series.len(), 96);
        assert!(series
            .iter()
            .all(|point| point["chains"] == 0 && point["users"] == 0));

        let (status, _, body) = request(
            &f.app,
            Some(&f.admin_cookie),
            &format!("/api/v1/overview/chain-templates/{tpl}?hours=168"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["series"].as_array().unwrap().len(), 672);
    }

    #[tokio::test]
    async fn rejects_non_admins_missing_templates_and_bad_hours() {
        let f = setup().await;
        let (_, user_cookie) = make_user(&f, "normal").await;
        let server = make_server(&f, "香港-01", true).await;
        let tpl = make_template(&f, "模板", true, &[("round_robin", &[&server])]).await;
        let detail = format!("/api/v1/overview/chain-templates/{tpl}");

        let (status, _, _) = request(&f.app, None, "/api/v1/overview/chain-templates").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = request(
            &f.app,
            Some(&user_cookie),
            "/api/v1/overview/chain-templates",
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, _) = request(&f.app, Some(&user_cookie), &detail).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        let (status, _, body) = request(
            &f.app,
            Some(&f.admin_cookie),
            "/api/v1/overview/chain-templates/not-a-template",
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "chain_template.not_found");

        for hours in ["12", "0", "-24", "abc", "1.5"] {
            let (status, _, body) = request(
                &f.app,
                Some(&f.admin_cookie),
                &format!("{detail}?hours={hours}"),
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "hours={hours}");
            assert_eq!(body["code"], "query.chain_templates_hours_invalid");
        }
        // 缺省 / 空字符串 = 24h。
        for uri in [
            detail.clone(),
            format!("{detail}?hours="),
            format!("{detail}?hours=24"),
            format!("{detail}?hours=168"),
        ] {
            let (status, _, _) = request(&f.app, Some(&f.admin_cookie), &uri).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
        }
    }

    #[tokio::test]
    async fn list_and_detail_are_cached_for_thirty_seconds() {
        let f = setup().await;
        let server = make_server(&f, "香港-01", true).await;
        let tpl = make_template(&f, "模板", true, &[("round_robin", &[&server])]).await;
        let list_uri = "/api/v1/overview/chain-templates";

        let (_, headers, _) = request(&f.app, Some(&f.admin_cookie), list_uri).await;
        assert_eq!(cache_header(&headers), "miss");
        let (_, headers, _) = request(&f.app, Some(&f.admin_cookie), list_uri).await;
        assert_eq!(cache_header(&headers), "hit");

        let uri = format!("/api/v1/overview/chain-templates/{tpl}");
        let (_, headers, _) = request(&f.app, Some(&f.admin_cookie), &uri).await;
        assert_eq!(cache_header(&headers), "miss");
        let (_, headers, _) = request(&f.app, Some(&f.admin_cookie), &uri).await;
        assert_eq!(cache_header(&headers), "hit");
        let (_, headers, _) =
            request(&f.app, Some(&f.admin_cookie), &format!("{uri}?hours=168")).await;
        assert_eq!(cache_header(&headers), "miss", "hours 不同必须 miss");
    }

    #[tokio::test]
    async fn admin_chains_are_not_counted_as_users() {
        let f = setup().await;
        let server = make_server(&f, "香港-01", true).await;
        let tpl = make_template(&f, "模板", true, &[("round_robin", &[&server])]).await;
        make_chain(
            &f,
            &tpl,
            None,
            ("1.1.1.1", 443),
            &[("round_robin", &[&server])],
        )
        .await;
        let (_, _, body) = request(
            &f.app,
            Some(&f.admin_cookie),
            &format!("/api/v1/overview/chain-templates/{tpl}"),
        )
        .await;
        assert_eq!(body["users"].as_array().unwrap().len(), 0);
        let (_, _, list) = request(
            &f.app,
            Some(&f.admin_cookie),
            "/api/v1/overview/chain-templates",
        )
        .await;
        assert_eq!(list["items"][0]["chains"], 1);
        assert_eq!(list["items"][0]["users"], 0);
        assert_eq!(body["users"].as_array().unwrap().len(), 0);
        assert_eq!(body["strategies"].as_array().unwrap().len(), 1);
        assert_eq!(body["strategies"][0]["users"], 0);
        // 管理员 id 只用于确认 fixture 本身可用，不泄漏到用户统计里。
        assert!(!f.admin_id.is_empty());
    }

    /// B3 + B4 + B5：模板改成 1 跳后，详情仍按**真实链**画 2 跳；`stale`
    /// 为 true 且给出原因；新增候选进 `unused_candidates`；`series` 声明按
    /// 当前存在的链回填，最后一个点是当前未完成桶。
    #[tokio::test]
    async fn detail_follows_the_real_chain_after_the_template_is_edited() {
        let f = setup().await;
        let s1 = make_server(&f, "香港-01", true).await;
        let s2 = make_server(&f, "东京-01", true).await;
        let s3 = make_server(&f, "大阪-01", true).await;
        // 旧模板 2 跳；链按 2 跳创建。
        let tpl = make_template(
            &f,
            "港日双路",
            true,
            &[("round_robin", &[&s1]), ("round_robin", &[&s2])],
        )
        .await;
        make_chain(
            &f,
            &tpl,
            None,
            ("1.1.1.1", 443),
            &[("round_robin", &[&s1]), ("round_robin", &[&s2])],
        )
        .await;

        // 模板改成 1 跳，并把 s3 加成新候选。
        let edited: Vec<ChainTemplateGroup> =
            pierwave_domain::chain_templates::normalize_groups(vec![ChainTemplateGroup {
                seq: 0,
                strategy: "round_robin".into(),
                server_ids: vec![s1.clone(), s3.clone()],
            }])
            .unwrap();
        repo::chain_templates::update(
            &f.state.db.pool,
            &tpl,
            repo::chain_templates::UpdateChainTemplate {
                groups_json: Some(serde_json::to_string(&edited).unwrap()),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .expect("模板必须存在");

        let (status, _, body) = request(
            &f.app,
            Some(&f.admin_cookie),
            &format!("/api/v1/overview/chain-templates/{tpl}?hours=24"),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "body: {body}");
        assert_eq!(body["template"]["hops"], 1, "模板定义仍然是 1 跳");
        assert_eq!(body["template"]["stale"], true);
        let reason = body["template"]["stale_reason"].as_str().unwrap();
        assert!(reason.contains("跳数"), "reason={reason}");

        // nodes 跟随真实链：0 / 1 两个组 + target(seq 2)，计数不归零。
        let nodes = body["nodes"].as_array().unwrap();
        assert_eq!(nodes.len(), 3, "nodes 不能被模板跳数截断：{nodes:?}");
        assert_eq!(nodes[0]["seq"], 0);
        assert_eq!(nodes[0]["role"], "source");
        assert_eq!(nodes[0]["members"][0]["server_id"], s1);
        assert_eq!(nodes[0]["members"][0]["chains"], 1);
        assert_eq!(nodes[1]["seq"], 1);
        assert_eq!(nodes[1]["role"], "hop");
        assert_eq!(nodes[1]["members"][0]["server_id"], s2);
        assert_eq!(nodes[1]["members"][0]["chains"], 1);
        assert_eq!(nodes[2]["seq"], 2);
        assert_eq!(nodes[2]["role"], "target");

        // 新增候选 s3 没有被任何链用到：单独列出，不混进 nodes。
        assert_eq!(
            body["unused_candidates"],
            json!([{ "seq": 0, "server_id": s3, "name": "大阪-01", "status": "online" }])
        );
        assert!(nodes
            .iter()
            .flat_map(|node| node["members"].as_array().unwrap())
            .all(|member| member["server_id"] != s3));

        // B4：口径显式声明「按当前存在的链回填」。
        assert_eq!(body["series_basis"], "existing_chains");

        // B5：最后一个点 = 当前未完成桶（ts 向下对齐 15 分钟）。
        let generated_at = body["generated_at"].as_i64().unwrap();
        let series = body["series"].as_array().unwrap();
        assert_eq!(
            series.last().unwrap()["ts"].as_i64().unwrap(),
            generated_at - generated_at.rem_euclid(900)
        );
        assert_eq!(
            series.last().unwrap()["chains"],
            1,
            "刚创建的链必须计入当前桶"
        );
    }
}
