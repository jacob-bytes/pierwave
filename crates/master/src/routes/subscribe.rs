//! 公开订阅端点：`GET /api/v1/sub/{short_code}`。
//!
//! 短码不是密钥，但泄漏等于送人流量，所以这里只按短码精确匹配；
//! 用户不存在、被禁用、短码写错一律 404，不暴露「这个人存在」。

use std::collections::HashSet;

use axum::extract::{Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, USER_AGENT};
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;
use sqlx::SqlitePool;

use pierwave_domain::models::User;
use pierwave_domain::subscribe::{self, SubContext, SubNode, TrafficInfo};
use pierwave_domain::{credentials, repo};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct SubscribeQuery {
    /// `clash` / `uri`；缺省时按 UA 嗅探。
    pub target: Option<String>,
    /// 规则模板 id；缺省时用 `is_default = 1` 的模板。
    pub rule: Option<String>,
}

pub async fn get(
    State(state): State<AppState>,
    Path(short_code): Path<String>,
    Query(query): Query<SubscribeQuery>,
    headers: HeaderMap,
) -> AppResult<Response> {
    // 不存在与禁用共用 404，避免枚举订阅短码。
    let Some(user) = repo::users::find_by_short_code(&state.db.pool, &short_code).await? else {
        return Err(AppError::not_found(
            "subscribe.not_found",
            None,
            "资源不存在",
        ));
    };
    // 禁用与不存在共用同一个 code：不能通过错误码枚举出「短码存在但被禁用」。
    if user.status != "active" {
        return Err(AppError::not_found(
            "subscribe.not_found",
            None,
            "资源不存在",
        ));
    }

    // 规则模板与节点无关，先解析：指定的模板不存在要 404，即使 target=uri 也一样。
    let effective_rules = rules_for(&state.db.pool, &user, query.rule.as_deref()).await?;

    let secret = credentials::master_secret(&state.db.pool).await?;
    let mut nodes = Vec::new();
    // 没有可用套餐、或套餐范围里一个节点都没有的用户仍然 200，但 proxies 为空
    // （与「未绑定套餐」的 FAQ 语义一致）。可见节点集合直接复用下发配置的
    // `authorization::eligible_pairs`，套餐节点范围不会在订阅端再写一遍。
    let allowed = repo::authorization::eligible_node_ids_for_user(&state.db.pool, &user.id).await?;
    for row in repo::nodes::list_enabled_with_server(&state.db.pool).await? {
        if !allowed.contains(&row.node.id) {
            continue;
        }
        // 缺字段/脏片段的节点在这里被跳过并记 warn，订阅本身照常渲染。
        if let Some(node) = SubNode::from_node(&row.node, &row.server_address, &user.id, &secret) {
            nodes.push(node);
        }
    }
    dedupe_names(&mut nodes);

    let traffic = traffic_for(&state.db.pool, &user).await?;
    let ctx = SubContext {
        nodes: &nodes,
        user_label: &user.username,
        traffic: Some(traffic),
        rules: &effective_rules.rules,
    };

    let user_agent = headers
        .get(USER_AGENT)
        .and_then(|value| value.to_str().ok());
    let exporter =
        subscribe::select_exporter(query.target.as_deref(), user_agent).ok_or_else(|| {
            let target = query.target.as_deref().unwrap_or_default().trim();
            AppError::coded(
                "subscribe.format_unsupported",
                Some(json!({
                    "target": target,
                    "supported": subscribe::exporter_ids(),
                })),
                format!(
                    "不支持的订阅格式：{target}（当前支持：{}）",
                    subscribe::exporter_ids().join(" / ")
                ),
            )
        })?;
    let body = exporter.render(&ctx)?;

    let mut response = body.into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static(exporter.content_type()),
    );
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));

    if let Some(traffic) = &ctx.traffic {
        let userinfo = traffic.userinfo_header();
        if let Ok(value) = HeaderValue::from_str(&userinfo) {
            response_headers.insert(HeaderName::from_static("subscription-userinfo"), value);
        }
    }

    Ok(response)
}

/// 订阅规则的五级解析：
///
/// 1. `?rule=<id>`（最高优先级，临时覆盖）
/// 2. `users.rule_template_id`
/// 3. 当前套餐（最近一次绑定的未过期实例）的 `packages.rule_template_id`
/// 4. `is_default = 1`
/// 5. 内置两条规则
///
/// 指定了不存在的模板直接 404：静默回落到默认会让用户以为自定义规则生效了。
/// 2–4 级的绑定指向不存在的模板时视为未绑定继续回落，**不报错**。
async fn rules_for(
    pool: &SqlitePool,
    user: &User,
    rule: Option<&str>,
) -> AppResult<subscribe::EffectiveRules> {
    let template = match rule.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => Some(
            repo::rule_templates::find_by_id(pool, id)
                .await?
                .ok_or_else(|| {
                    AppError::not_found("rule_template.not_found", None, "资源不存在")
                })?,
        ),
        None => {
            repo::rule_templates::resolve_for_user(pool, &user.id, user.rule_template_id.as_deref())
                .await?
        }
    };
    Ok(subscribe::effective_rules(template))
}

/// 流量/额度/到期信息。拆不出上下行，`used_bytes` 记到 download 上。
async fn traffic_for(pool: &SqlitePool, user: &User) -> AppResult<TrafficInfo> {
    let packages = repo::user_packages::list_views_by_user(pool, &user.id).await?;
    let expire = packages
        .iter()
        .filter(|item| item.status == "active")
        .filter_map(|item| item.expires_at)
        .max();

    Ok(TrafficInfo {
        upload: 0,
        download: user.used_bytes.max(0) as u64,
        total: user.quota_bytes.and_then(|quota| u64::try_from(quota).ok()),
        expire,
    })
}

/// 节点名只在 `(server_id, tag)` 内唯一，而 Clash 的 proxies 名必须全局唯一：
/// 跨服务器重名时按出现顺序追加 ` (2)`、` (3)`，否则整份配置会被客户端判为非法。
fn dedupe_names(nodes: &mut [SubNode]) {
    let mut used: HashSet<String> = HashSet::new();
    for node in nodes.iter_mut() {
        if used.insert(node.name.clone()) {
            continue;
        }
        let base = node.name.clone();
        let mut index = 2;
        loop {
            let candidate = format!("{base} ({index})");
            if used.insert(candidate.clone()) {
                node.name = candidate;
                break;
            }
            index += 1;
        }
        tracing::warn!(name = %base, "订阅内节点重名，已追加序号");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::Router;
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde_json::json;
    use tower::ServiceExt;

    use pierwave_domain::models::Patch;
    use pierwave_domain::repo::rule_templates::{NewRuleTemplate, UpdateRuleTemplate};
    use pierwave_domain::repo::users::NewUser;
    use pierwave_domain::repo::{nodes::NewNode, packages, rule_templates, servers, user_packages};
    use pierwave_domain::Db;

    const ADDRESS: &str = "203.0.113.10";

    async fn setup() -> (Router, AppState, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();

        let user = repo::users::create(
            &db.pool,
            NewUser {
                username: "alice".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: Some(10_000),
                rule_template_id: None,
            },
        )
        .await
        .unwrap();

        // 有套餐实例的用户才会导出节点。
        let package = packages::create(
            &db.pool,
            packages::NewPackage {
                name: "月卡".into(),
                quota_bytes: Some(10_000),
                period_days: Some(30),
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,

                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        user_packages::create(
            &db.pool,
            &user.id,
            user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap();

        let (server, _token) = servers::create(&db.pool, "hk-1", ADDRESS, "external")
            .await
            .unwrap();

        repo::nodes::create(
            &db.pool,
            &server.id,
            NewNode {
                tag: Some("hk-reality".into()),
                name: "香港-REALITY".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "reality".into(),
                port: 443,
                config_json: json!({
                    "settings": {"clients": [], "decryption": "none"},
                    "stream": {
                        "network": "tcp",
                        "security": "reality",
                        "realitySettings": {
                            "serverNames": ["www.example.com"],
                            "publicKey": "public-key-abc",
                            "shortIds": ["abcd1234"]
                        }
                    }
                })
                .to_string(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();

        repo::nodes::create(
            &db.pool,
            &server.id,
            NewNode {
                tag: Some("jp-trojan".into()),
                name: "日本-WS-TLS".into(),
                protocol: "trojan".into(),
                transport: "ws".into(),
                security: "tls".into(),
                port: 8443,
                config_json: json!({
                    "settings": {"clients": []},
                    "stream": {
                        "network": "ws",
                        "security": "tls",
                        "tlsSettings": {"serverName": "jp.example.com"},
                        "wsSettings": {"path": "/ws", "headers": {"Host": "cdn.example.com"}}
                    }
                })
                .to_string(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();

        // 禁用节点不能出现在订阅里。
        repo::nodes::create(
            &db.pool,
            &server.id,
            NewNode {
                tag: Some("disabled".into()),
                name: "禁用节点".into(),
                protocol: "trojan".into(),
                transport: "ws".into(),
                security: "tls".into(),
                port: 9443,
                config_json: json!({}).to_string(),
                enabled: false,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();

        let short_code = user.short_code.clone();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (app, state, short_code)
    }

    async fn get(
        app: &Router,
        uri: &str,
        user_agent: Option<&str>,
    ) -> (StatusCode, HeaderMap, String) {
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(user_agent) = user_agent {
            builder = builder.header(header::USER_AGENT, user_agent);
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
        (status, headers, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
        headers.get(name).and_then(|value| value.to_str().ok())
    }

    #[tokio::test]
    async fn clash_subscription_has_nodes_groups_and_headers() {
        let (app, _state, short_code) = setup().await;

        let (status, headers, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;

        assert_eq!(status, StatusCode::OK);
        assert!(header_str(&headers, "content-type")
            .unwrap()
            .contains("yaml"));
        assert_eq!(header_str(&headers, "cache-control"), Some("no-store"));

        let userinfo = header_str(&headers, "subscription-userinfo").expect("必须有流量头");
        assert!(userinfo.contains("upload=0"), "unexpected: {userinfo}");
        assert!(userinfo.contains("download=0"), "unexpected: {userinfo}");
        assert!(userinfo.contains("total=10000"), "unexpected: {userinfo}");
        assert!(
            !userinfo.contains("expire="),
            "无套餐时应省略 expire：{userinfo}"
        );

        assert!(body.contains("proxies:"), "缺少 proxies 段");
        assert!(body.contains("香港-REALITY"), "缺少节点名");
        assert!(body.contains("日本-WS-TLS"), "缺少节点名");
        assert!(body.contains("reality-opts:"), "缺少 reality 配置");
        assert!(body.contains("ws-opts:"), "缺少 ws 配置");
        // 兼容性：迁移里默认模板的内容必须让 rules 段与旧版写死的完全一致。
        assert!(
            body.contains("rules:\n  - \"GEOIP,CN,DIRECT\"\n  - \"MATCH,PROXY\"\n"),
            "默认规则必须与升级前逐字节一致：{body}"
        );
        assert!(!body.contains("禁用节点"), "禁用节点不应导出");
    }

    #[tokio::test]
    async fn user_without_active_package_gets_empty_proxies() {
        let (app, state, _short_code) = setup().await;

        let no_package = repo::users::create(
            &state.db.pool,
            NewUser {
                username: "bob".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();

        let (status, headers, body) = get(
            &app,
            &format!("/api/v1/sub/{}", no_package.short_code),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK, "无套餐不是错误：{body}");
        assert!(header_str(&headers, "content-type")
            .unwrap()
            .contains("yaml"));
        assert!(body.contains("proxies: []"), "应返回空 proxies：{body}");
        assert!(!body.contains("香港-REALITY"));
        assert!(!body.contains("日本-WS-TLS"));

        // 有套餐实例但已过期 → 同样无资格。
        let expired = repo::users::create(
            &state.db.pool,
            NewUser {
                username: "carol".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let package = packages::list(&state.db.pool).await.unwrap().remove(0);
        user_packages::create(
            &state.db.pool,
            &expired.id,
            user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: Some(1),
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap();

        let (status, _headers, body) =
            get(&app, &format!("/api/v1/sub/{}", expired.short_code), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("proxies: []"), "过期套餐不应导出节点：{body}");
    }

    #[tokio::test]
    async fn exhausted_package_is_not_eligible_for_subscription() {
        let (app, state, _short_code) = setup().await;

        let user = repo::users::create(
            &state.db.pool,
            NewUser {
                username: "exhausted-user".into(),
                password: "password123".into(),
                role: "user".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let package = packages::list(&state.db.pool).await.unwrap().remove(0);
        let item = user_packages::create(
            &state.db.pool,
            &user.id,
            user_packages::NewUserPackage {
                package_id: package.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &package,
        )
        .await
        .unwrap();
        repo::user_packages::set_used_bytes(&state.db.pool, &item.id, package.quota_bytes.unwrap())
            .await
            .unwrap();

        // 用尽与过期、禁用共用同一套 is_usable 口径，订阅端不应再导出节点。
        let (status, _headers, body) =
            get(&app, &format!("/api/v1/sub/{}", user.short_code), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("proxies: []"), "用尽套餐不应导出节点：{body}");
    }

    #[tokio::test]
    async fn unsupported_target_is_400_with_supported_formats() {
        let (app, _state, short_code) = setup().await;

        // hiddify 未注册；egern 已注册，不能再拿它当「未知格式」的样本。
        let (status, _headers, body) = get(
            &app,
            &format!("/api/v1/sub/{short_code}?target=hiddify"),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        let error = body.as_str();
        assert!(error.contains("hiddify"), "unexpected: {error}");
        // 注册表顺序稳定：不能因为换成 HashMap 而让 400 文案顺序漂移。
        assert!(
            error.contains(
                "clash / stash / surge / egern / surfboard / loon / qx / singbox / uri / shadowrocket / v2ray"
            ),
            "supported 列表顺序不稳定: {error}"
        );
        for supported in [
            "clash",
            "stash",
            "surge",
            "egern",
            "loon",
            "qx",
            "surfboard",
            "singbox",
            "shadowrocket",
            "uri",
            "v2ray",
        ] {
            assert!(error.contains(supported), "缺少格式 {supported}: {error}");
        }
    }

    #[tokio::test]
    async fn target_and_user_agent_pick_the_exporter() {
        let (app, _state, short_code) = setup().await;

        let (status, headers, body) =
            get(&app, &format!("/api/v1/sub/{short_code}?target=uri"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(header_str(&headers, "content-type")
            .unwrap()
            .contains("text/plain"));
        let lines: Vec<&str> = body.lines().filter(|line| !line.is_empty()).collect();
        assert_eq!(lines.len(), 2, "两个启用节点应各占一行：{body}");
        assert!(lines[0].starts_with("vless://"));
        assert!(lines[1].starts_with("trojan://"));

        // ?target=egern：Surge 兼容 profile + Egern 文件头，Content-Type 与 Surge 一致。
        let (status, headers, body) = get(
            &app,
            &format!("/api/v1/sub/{short_code}?target=egern"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            header_str(&headers, "content-type"),
            Some("text/plain; charset=utf-8")
        );
        assert!(body.starts_with("#!MANAGED-CONFIG\n"), "{body}");
        assert!(body.contains("[Proxy]"), "{body}");
        assert!(body.contains("[Rule]"), "{body}");

        // UA 嗅探：Egern 自带 UA 也选 egern。
        let (status, _headers, body) = get(
            &app,
            &format!("/api/v1/sub/{short_code}"),
            Some("Egern/1.0 CFNetwork"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.starts_with("#!MANAGED-CONFIG\n"), "{body}");

        // UA 嗅探：Shadowrocket 得到 base64 的 URI 列表。
        let (status, headers, body) = get(
            &app,
            &format!("/api/v1/sub/{short_code}"),
            Some("Shadowrocket/2.2.0 CFNetwork"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(header_str(&headers, "content-type")
            .unwrap()
            .contains("text/plain"));
        let decoded = STANDARD
            .decode(body.trim())
            .expect("Shadowrocket 订阅必须是 base64");
        assert!(String::from_utf8(decoded).unwrap().starts_with("vless://"));

        // clash UA 得到 YAML。
        let (status, _headers, body) = get(
            &app,
            &format!("/api/v1/sub/{short_code}"),
            Some("clash-verge/1.5.0 mihomo"),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("proxy-groups:"));
    }

    #[tokio::test]
    async fn unknown_short_code_and_disabled_user_are_404() {
        let (app, state, short_code) = setup().await;

        let (status, _headers, _body) = get(&app, "/api/v1/sub/does-not-exist", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        repo::users::update(
            &state.db.pool,
            &repo::users::find_by_short_code(&state.db.pool, &short_code)
                .await
                .unwrap()
                .unwrap()
                .id,
            repo::users::UpdateUser {
                status: Some("disabled".into()),
                quota_bytes: Patch::Missing,
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let (status, _headers, _body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn duplicate_node_names_across_servers_are_made_unique() {
        let (app, state, short_code) = setup().await;

        // 第二台服务器上放一个和第一台同名的节点。
        let (server, _token) = servers::create(&state.db.pool, "jp-1", "198.51.100.7", "external")
            .await
            .unwrap();
        repo::nodes::create(
            &state.db.pool,
            &server.id,
            NewNode {
                tag: Some("hk-reality".into()),
                name: "香港-REALITY".into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "tls".into(),
                port: 443,
                config_json: json!({
                    "settings": {"clients": []},
                    "stream": {"network": "tcp", "security": "tls", "tlsSettings": {"serverName": "a.com"}}
                })
                .to_string(),
                enabled: true,
                cert_id: None,
                bandwidth_kbps: None,
            },
        )
        .await
        .unwrap();

        let (status, _headers, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("\"香港-REALITY (2)\""));
    }

    #[tokio::test]
    async fn package_node_scope_filters_subscription_nodes() {
        let (app, state, short_code) = setup().await;

        // 未设范围 → 两个启用节点都导出。
        let (status, _headers, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("香港-REALITY"));
        assert!(body.contains("日本-WS-TLS"));

        let package = packages::list(&state.db.pool).await.unwrap().remove(0);
        let server = servers::list(&state.db.pool).await.unwrap().remove(0);
        let nodes = repo::nodes::list_enabled_by_server(&state.db.pool, &server.id)
            .await
            .unwrap();
        let first = nodes[0].id.clone();

        // 只绑第一个节点 → 订阅里不再出现第二个。
        packages::update(
            &state.db.pool,
            &package.id,
            packages::UpdatePackage {
                node_ids: Patch::Value(vec![first]),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let (status, _headers, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("香港-REALITY"));
        assert!(!body.contains("日本-WS-TLS"), "范围外节点不应导出：{body}");

        // 范围改成空数组 → 有可用套餐也返回空 proxies。
        packages::update(
            &state.db.pool,
            &package.id,
            packages::UpdatePackage {
                node_ids: Patch::Value(Vec::new()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let (status, _headers, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("proxies: []"),
            "空范围应返回空 proxies：{body}"
        );
        assert!(!body.contains("香港-REALITY"));
    }

    /// 账户总额度用尽后，即使套餐实例还有额度，订阅也必须为空。
    #[tokio::test]
    async fn total_quota_exhaustion_empties_subscription() {
        let (app, state, short_code) = setup().await;

        let (status, _, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            !body.contains("proxies: []"),
            "总额度充足时应导出节点：{body}"
        );

        // 把用户推到总额度上限（setup 里 quota_bytes = 10_000）
        let user = repo::users::find_by_username(&state.db.pool, "alice")
            .await
            .unwrap()
            .unwrap();
        repo::users::add_used_bytes(&state.db.pool, &user.id, 10_000)
            .await
            .unwrap();

        let (status, _, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK, "断流不是错误态");
        assert!(
            body.contains("proxies: []"),
            "超出总额度后订阅应为空：{body}"
        );
    }

    async fn create_template(
        state: &AppState,
        name: &str,
        rules: &[&str],
        is_default: bool,
    ) -> String {
        rule_templates::create(
            &state.db.pool,
            NewRuleTemplate {
                name: name.into(),
                description: String::new(),
                rules: rules.iter().map(|rule| rule.to_string()).collect(),
                is_default,
            },
        )
        .await
        .unwrap()
        .id
    }

    /// 把模板绑到用户级（第二条优先级）。
    async fn bind_user(state: &AppState, user_id: &str, template_id: &str) {
        repo::users::update(
            &state.db.pool,
            user_id,
            repo::users::UpdateUser {
                rule_template_id: Patch::Value(template_id.to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    /// 把模板绑到套餐级（第三条优先级）。
    async fn bind_package(state: &AppState, package_id: &str, template_id: &str) {
        packages::update(
            &state.db.pool,
            package_id,
            packages::UpdatePackage {
                rule_template_id: Patch::Value(template_id.to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    async fn only_package(state: &AppState) -> pierwave_domain::models::Package {
        packages::list(&state.db.pool).await.unwrap().remove(0)
    }

    async fn user_by_name(state: &AppState, username: &str) -> User {
        repo::users::find_by_username(&state.db.pool, username)
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn rule_query_overrides_user_binding() {
        let (app, state, short_code) = setup().await;
        let alice = user_by_name(&state, "alice").await;
        let user_template = create_template(
            &state,
            "用户级",
            &["DOMAIN-SUFFIX,user.example,DIRECT", "MATCH,DIRECT"],
            false,
        )
        .await;
        let query_template = create_template(
            &state,
            "链接级",
            &["DOMAIN-SUFFIX,query.example,PROXY", "MATCH,PROXY"],
            false,
        )
        .await;
        bind_user(&state, &alice.id, &user_template).await;

        // 不传 ?rule= 时用户绑定生效。
        let (_, _, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert!(
            body.contains("DOMAIN-SUFFIX,user.example,DIRECT"),
            "用户绑定应生效：{body}"
        );

        // ?rule= 仍然压过用户绑定。
        let (status, _, body) = get(
            &app,
            &format!("/api/v1/sub/{short_code}?rule={query_template}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("DOMAIN-SUFFIX,query.example,PROXY"),
            "?rule= 应压过用户绑定：{body}"
        );
        assert!(
            !body.contains("DOMAIN-SUFFIX,user.example,DIRECT"),
            "用户绑定不应同时出现：{body}"
        );
    }

    #[tokio::test]
    async fn user_binding_overrides_package_binding() {
        let (app, state, short_code) = setup().await;
        let alice = user_by_name(&state, "alice").await;
        let package = only_package(&state).await;
        let user_template = create_template(
            &state,
            "用户级",
            &["DOMAIN-SUFFIX,user.example,DIRECT", "MATCH,DIRECT"],
            false,
        )
        .await;
        let package_template = create_template(
            &state,
            "套餐级",
            &["DOMAIN-SUFFIX,package.example,PROXY", "MATCH,PROXY"],
            false,
        )
        .await;
        bind_package(&state, &package.id, &package_template).await;
        bind_user(&state, &alice.id, &user_template).await;

        let (status, _, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("DOMAIN-SUFFIX,user.example,DIRECT"),
            "用户绑定应压过套餐绑定：{body}"
        );
        assert!(
            !body.contains("DOMAIN-SUFFIX,package.example,PROXY"),
            "套餐绑定不应生效：{body}"
        );
    }

    #[tokio::test]
    async fn package_binding_overrides_global_default() {
        let (app, state, short_code) = setup().await;
        let package = only_package(&state).await;
        let package_template = create_template(
            &state,
            "套餐级",
            &["DOMAIN-SUFFIX,package.example,PROXY", "MATCH,PROXY"],
            false,
        )
        .await;
        bind_package(&state, &package.id, &package_template).await;

        let (status, _, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("DOMAIN-SUFFIX,package.example,PROXY"),
            "套餐绑定应压过全局默认：{body}"
        );
        assert!(
            !body.contains("GEOIP,CN,DIRECT"),
            "迁移自带的全局默认不应生效：{body}"
        );
    }

    #[tokio::test]
    async fn current_package_uses_latest_unexpired_instance() {
        let (app, state, short_code) = setup().await;
        let alice = user_by_name(&state, "alice").await;

        let first = only_package(&state).await;
        let first_template = create_template(
            &state,
            "旧套餐",
            &["DOMAIN-SUFFIX,old.example,DIRECT", "MATCH,DIRECT"],
            false,
        )
        .await;
        bind_package(&state, &first.id, &first_template).await;

        // 新实例已过期：不能盖掉仍未过期的旧实例。
        let expired = packages::create(
            &state.db.pool,
            packages::NewPackage {
                name: "过期套餐".into(),
                quota_bytes: Some(10_000),
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,
                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        let expired_template = create_template(
            &state,
            "过期套餐模板",
            &["DOMAIN-SUFFIX,expired.example,PROXY", "MATCH,PROXY"],
            false,
        )
        .await;
        bind_package(&state, &expired.id, &expired_template).await;
        user_packages::create(
            &state.db.pool,
            &alice.id,
            user_packages::NewUserPackage {
                package_id: expired.id.clone(),
                quota_override: None,
                expires_at: Some(1),
                reset_day: None,
            },
            &expired,
        )
        .await
        .unwrap();

        let (status, _, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("DOMAIN-SUFFIX,old.example,DIRECT"),
            "过期实例不应成为当前套餐：{body}"
        );
        assert!(
            !body.contains("DOMAIN-SUFFIX,expired.example,PROXY"),
            "过期实例的模板不应生效：{body}"
        );

        // 再来一个未过期的新实例：同优先级下取最新一条。
        let newest = packages::create(
            &state.db.pool,
            packages::NewPackage {
                name: "新套餐".into(),
                quota_bytes: Some(10_000),
                period_days: None,
                direction: "both".into(),
                node_ratio: 1.0,
                rule_template_id: None,
                speed_limit_kbps: None,
                node_ids: None,
            },
        )
        .await
        .unwrap();
        let newest_template = create_template(
            &state,
            "新套餐模板",
            &["DOMAIN-SUFFIX,new.example,PROXY", "MATCH,PROXY"],
            false,
        )
        .await;
        bind_package(&state, &newest.id, &newest_template).await;
        user_packages::create(
            &state.db.pool,
            &alice.id,
            user_packages::NewUserPackage {
                package_id: newest.id.clone(),
                quota_override: None,
                expires_at: None,
                reset_day: None,
            },
            &newest,
        )
        .await
        .unwrap();

        let (status, _, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("DOMAIN-SUFFIX,new.example,PROXY"),
            "多个未过期实例应取最新一条：{body}"
        );
        assert!(
            !body.contains("DOMAIN-SUFFIX,old.example,DIRECT"),
            "旧实例不应再生效：{body}"
        );
    }

    #[tokio::test]
    async fn deleted_template_binding_falls_back_without_error() {
        let (app, state, short_code) = setup().await;
        let alice = user_by_name(&state, "alice").await;
        let package = only_package(&state).await;
        let template = create_template(
            &state,
            "将被删除",
            &["DOMAIN-SUFFIX,gone.example,DIRECT", "MATCH,DIRECT"],
            false,
        )
        .await;
        bind_user(&state, &alice.id, &template).await;
        bind_package(&state, &package.id, &template).await;

        assert_eq!(
            rule_templates::delete(&state.db.pool, &template)
                .await
                .unwrap(),
            repo::rule_templates::DeleteOutcome::Deleted
        );

        // 外键 ON DELETE SET NULL 把两级绑定都清空，订阅回落而不是 502/404。
        let alice_after = repo::users::find_by_id(&state.db.pool, &alice.id)
            .await
            .unwrap();
        assert!(
            alice_after.rule_template_id.is_none(),
            "删除模板后用户绑定应被 SET NULL"
        );
        let package_after = packages::find_by_id(&state.db.pool, &package.id)
            .await
            .unwrap()
            .unwrap();
        assert!(
            package_after.rule_template_id.is_none(),
            "删除模板后套餐绑定应被 SET NULL"
        );

        let (status, _, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK, "绑定失效不应报错：{body}");
        assert!(
            body.contains("GEOIP,CN,DIRECT"),
            "删除模板后应回落到全局默认：{body}"
        );
        assert!(
            !body.contains("DOMAIN-SUFFIX,gone.example,DIRECT"),
            "被删模板的规则不应出现：{body}"
        );
    }

    #[tokio::test]
    async fn default_rule_template_drives_subscription_rules() {
        let (app, state, short_code) = setup().await;
        create_template(
            &state,
            "国内直连",
            &["DOMAIN-SUFFIX,corp.example,DIRECT", "MATCH,DIRECT"],
            true,
        )
        .await;

        let (status, _headers, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("  - \"DOMAIN-SUFFIX,corp.example,DIRECT\"\n  - \"MATCH,DIRECT\"\n"),
            "默认模板的规则应写进 YAML：{body}"
        );
        assert!(
            !body.contains("GEOIP,CN,DIRECT"),
            "旧的默认规则不应再出现：{body}"
        );
        assert!(!body.contains("MATCH,PROXY"), "旧的兜底不应再出现：{body}");
    }

    #[tokio::test]
    async fn rule_query_overrides_default_and_uri_export_is_unaffected() {
        let (app, state, short_code) = setup().await;
        let rule_id = create_template(
            &state,
            "只走直连",
            &["DOMAIN-SUFFIX,example.com,DIRECT", "MATCH,DIRECT"],
            false,
        )
        .await;

        let (status, _headers, body) = get(
            &app,
            &format!("/api/v1/sub/{short_code}?rule={rule_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("  - \"DOMAIN-SUFFIX,example.com,DIRECT\"\n  - \"MATCH,DIRECT\"\n"),
            "?rule= 指定的模板应生效：{body}"
        );

        // 规则模板只影响 clash；URI 列表仍是每节点一行。
        let (status, headers, body) = get(
            &app,
            &format!("/api/v1/sub/{short_code}?target=uri&rule={rule_id}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(header_str(&headers, "content-type")
            .unwrap()
            .contains("text/plain"));
        let lines: Vec<&str> = body.lines().filter(|line| !line.is_empty()).collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("vless://"));
        assert!(!body.contains("rules:"), "URI 导出不应出现 YAML：{body}");
    }

    #[tokio::test]
    async fn unknown_rule_template_is_404() {
        let (app, _state, short_code) = setup().await;
        let (status, _headers, _body) = get(
            &app,
            &format!("/api/v1/sub/{short_code}?rule=does-not-exist"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn missing_default_template_falls_back_to_builtin_rules() {
        let (app, state, short_code) = setup().await;
        let seeded = rule_templates::find_default(&state.db.pool)
            .await
            .unwrap()
            .expect("迁移应带默认模板");
        rule_templates::update(
            &state.db.pool,
            &seeded.id,
            UpdateRuleTemplate {
                is_default: Some(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let (status, _headers, body) = get(&app, &format!("/api/v1/sub/{short_code}"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            body.contains("rules:\n  - \"GEOIP,CN,DIRECT\"\n  - \"MATCH,PROXY\"\n"),
            "没有默认模板时应回落到内置规则：{body}"
        );
    }
}
