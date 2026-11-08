//! End-to-end tests for the read-only MCP server.
//!
//! Each test builds a real SQLite file from the migrations in
//! `crates/domain/migrations`, seeds a few rows, closes the writable pool and
//! then reopens the file through the same read-only path used in production.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Utc;
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

use pierwave_mcp::db::{business_date, business_month_bounds};
use pierwave_mcp::{Database, Server};

/// Existing schema, applied in order. `raw_sql` runs each file as a script.
static MIGRATIONS: &[&str] = &[
    include_str!("../../domain/migrations/0001_init.sql"),
    include_str!("../../domain/migrations/0002_settings.sql"),
    include_str!("../../domain/migrations/0003_user_package_reset.sql"),
    include_str!("../../domain/migrations/0004_enforcement.sql"),
    include_str!("../../domain/migrations/0005_enforcement_restore.sql"),
    include_str!("../../domain/migrations/0006_certificates.sql"),
    include_str!("../../domain/migrations/0007_server_health.sql"),
    include_str!("../../domain/migrations/0008_package_nodes.sql"),
    include_str!("../../domain/migrations/0009_traffic_node_daily.sql"),
    include_str!("../../domain/migrations/0010_rule_templates.sql"),
    include_str!("../../domain/migrations/0011_drop_embedded_xray.sql"),
    include_str!("../../domain/migrations/0012_outbounds_routing.sql"),
    include_str!("../../domain/migrations/0013_agent_upgrade.sql"),
    include_str!("../../domain/migrations/0014_agent_arch.sql"),
    include_str!("../../domain/migrations/0015_upgrade_stability.sql"),
    include_str!("../../domain/migrations/0016_upgrade_batches.sql"),
    include_str!("../../domain/migrations/0017_rule_template_binding.sql"),
    include_str!("../../domain/migrations/0018_server_samples.sql"),
    include_str!("../../domain/migrations/0019_audit_log_cursor_index.sql"),
    include_str!("../../domain/migrations/0020_latency.sql"),
    include_str!("../../domain/migrations/0021_rate_limit.sql"),
    include_str!("../../domain/migrations/0022_forwards.sql"),
    include_str!("../../domain/migrations/0023_chains.sql"),
    include_str!("../../domain/migrations/0024_forward_target_health.sql"),
    include_str!("../../domain/migrations/0025_me_subscription.sql"),
    include_str!("../../domain/migrations/0026_chain_groups.sql"),
];

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is after 1970")
            .as_nanos();
        let unique = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "pierwave-mcp-test-{}-{nanos}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    fn db_path(&self) -> PathBuf {
        self.path.join("pierwave.db")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

struct Fixture {
    dir: TempDir,
    path: PathBuf,
    pool: SqlitePool,
}

impl Fixture {
    async fn new() -> Self {
        let dir = TempDir::new();
        let path = dir.db_path();
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("open writable fixture database");
        for migration in MIGRATIONS {
            sqlx::raw_sql(migration)
                .execute(&pool)
                .await
                .expect("apply migration");
        }
        Self { dir, path, pool }
    }

    async fn into_database(self) -> (TempDir, Database) {
        let Fixture { dir, path, pool } = self;
        pool.close().await;
        let database = Database::open_read_only(&path)
            .await
            .expect("open fixture read-only");
        (dir, database)
    }

    async fn into_server(self) -> (TempDir, Server) {
        let (dir, database) = self.into_database().await;
        (dir, Server::new(database))
    }
}

async fn seed_server(
    pool: &SqlitePool,
    id: &str,
    name: &str,
    status: &str,
    xray_running: Option<i64>,
    load1: Option<f64>,
    latency_ms: Option<i64>,
) {
    sqlx::query(
        "INSERT INTO servers
            (id, name, address, token_hash, status, last_seen_at, xray_running, load1,
             mem_used, mem_total, disk_used, disk_total, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(format!("{name}.example.com"))
    .bind(format!("token-hash-{id}"))
    .bind(status)
    .bind(if status == "online" {
        Some(1_700_000_000_i64)
    } else {
        None
    })
    .bind(xray_running)
    .bind(load1)
    .bind(Some(1024_i64))
    .bind(Some(4096_i64))
    .bind(Some(2048_i64))
    .bind(Some(8192_i64))
    .bind(latency_ms)
    .bind(1_700_000_000_i64)
    .execute(pool)
    .await
    .expect("insert server");
}

async fn seed_user(pool: &SqlitePool, id: &str, username: &str, status: &str) {
    sqlx::query(
        "INSERT INTO users
            (id, username, password_hash, role, status, short_code, quota_bytes, used_bytes,
             short_code_updated_at, created_at, updated_at)
         VALUES (?, ?, ?, 'user', ?, ?, NULL, 0, 0, ?, ?)",
    )
    .bind(id)
    .bind(username)
    .bind("password-hash")
    .bind(status)
    .bind(format!("code-{id}"))
    .bind(1_700_000_000_i64)
    .bind(1_700_000_000_i64)
    .execute(pool)
    .await
    .expect("insert user");
}

async fn seed_package(pool: &SqlitePool, id: &str, name: &str, quota_bytes: Option<i64>) {
    sqlx::query(
        "INSERT INTO packages
            (id, name, quota_bytes, period_days, direction, node_ratio, created_at)
         VALUES (?, ?, ?, NULL, 'both', 1.0, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(quota_bytes)
    .bind(1_700_000_000_i64)
    .execute(pool)
    .await
    .expect("insert package");
}

async fn seed_user_package(
    pool: &SqlitePool,
    id: &str,
    user_id: &str,
    package_id: &str,
    used_bytes: i64,
    expires_at: Option<i64>,
    status: &str,
) {
    sqlx::query(
        "INSERT INTO user_packages
            (id, user_id, package_id, quota_override, used_bytes, direction, node_ratio,
             expires_at, reset_day, status, created_at)
         VALUES (?, ?, ?, NULL, ?, 'both', 1.0, ?, NULL, ?, ?)",
    )
    .bind(id)
    .bind(user_id)
    .bind(package_id)
    .bind(used_bytes)
    .bind(expires_at)
    .bind(status)
    .bind(1_700_000_000_i64)
    .execute(pool)
    .await
    .expect("insert user package");
}

async fn seed_node(pool: &SqlitePool, id: &str, server_id: &str, tag: &str, enabled: i64) {
    sqlx::query(
        "INSERT INTO nodes
            (id, server_id, tag, name, protocol, transport, security, port, config_json,
             enabled, created_at)
         VALUES (?, ?, ?, ?, 'vless', 'tcp', 'none', 443, '{}', ?, ?)",
    )
    .bind(id)
    .bind(server_id)
    .bind(tag)
    .bind(tag)
    .bind(enabled)
    .bind(1_700_000_000_i64)
    .execute(pool)
    .await
    .expect("insert node");
}

async fn seed_traffic(
    pool: &SqlitePool,
    day: &str,
    server_id: &str,
    subject: &str,
    uplink: i64,
    downlink: i64,
    weighted: i64,
) {
    sqlx::query(
        "INSERT INTO traffic_daily (day, server_id, subject, uplink, downlink, weighted)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(day)
    .bind(server_id)
    .bind(subject)
    .bind(uplink)
    .bind(downlink)
    .bind(weighted)
    .execute(pool)
    .await
    .expect("insert traffic row");
}

async fn seed_chain(pool: &SqlitePool, id: &str, name: &str) {
    sqlx::query(
        "INSERT INTO chains
            (id, name, target_host, target_port, enabled, created_at, updated_at)
         VALUES (?, ?, 'target.example.com', 443, 1, ?, ?)",
    )
    .bind(id)
    .bind(name)
    .bind(1_700_000_000_i64)
    .bind(1_700_000_000_i64)
    .execute(pool)
    .await
    .expect("insert chain");
}

async fn seed_chain_group(pool: &SqlitePool, id: &str, chain_id: &str, seq: i64, strategy: &str) {
    sqlx::query(
        "INSERT INTO chain_groups (id, chain_id, seq, name, strategy)
         VALUES (?, ?, ?, NULL, ?)",
    )
    .bind(id)
    .bind(chain_id)
    .bind(seq)
    .bind(strategy)
    .execute(pool)
    .await
    .expect("insert chain group");
}

async fn seed_chain_member(
    pool: &SqlitePool,
    group_id: &str,
    server_id: &str,
    listen_port: i64,
    priority: i64,
) {
    sqlx::query(
        "INSERT INTO chain_group_members (group_id, server_id, listen_port, priority, weight)
         VALUES (?, ?, ?, ?, 1)",
    )
    .bind(group_id)
    .bind(server_id)
    .bind(listen_port)
    .bind(priority)
    .execute(pool)
    .await
    .expect("insert chain member");
}

async fn seed_forward_status(
    pool: &SqlitePool,
    server_id: &str,
    forward_id: &str,
    listening: i64,
    target_ok: Option<i64>,
    target_fail_count: i64,
    error: &str,
) {
    sqlx::query(
        "INSERT INTO forward_status
            (server_id, forward_id, listening, error, updated_at, target_ok, target_fail_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(server_id)
    .bind(forward_id)
    .bind(listening)
    .bind(error)
    .bind(1_700_000_000_i64)
    .bind(target_ok)
    .bind(target_fail_count)
    .execute(pool)
    .await
    .expect("insert forward status");
}

async fn request(server: &Server, method: &str, params: Value) -> Value {
    server
        .handle_message(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }))
        .await
        .expect("request should produce a response")
}

async fn tool_text(server: &Server, name: &str, arguments: Value) -> Value {
    let response = request(
        server,
        "tools/call",
        json!({ "name": name, "arguments": arguments }),
    )
    .await;
    assert!(
        response.get("error").is_none(),
        "unexpected tool error: {response}"
    );
    assert_eq!(response["result"]["content"][0]["type"], "text");
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("tools/call returns text content");
    serde_json::from_str(text).expect("tool text is valid JSON")
}

#[tokio::test]
async fn initialize_returns_protocol_version_and_server_info() {
    let fixture = Fixture::new().await;
    let (_dir, server) = fixture.into_server().await;

    let response = request(
        &server,
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "test-client", "version": "1.0" }
        }),
    )
    .await;

    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["id"], json!(1));
    assert_eq!(response["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(response["result"]["capabilities"]["tools"], json!({}));
    assert_eq!(response["result"]["serverInfo"]["name"], "pierwave-mcp");
    assert!(response["result"]["serverInfo"]["version"]
        .as_str()
        .is_some_and(|version| !version.is_empty()));
}

#[tokio::test]
async fn tools_list_has_five_tools_with_input_schemas() {
    let fixture = Fixture::new().await;
    let (_dir, server) = fixture.into_server().await;

    let response = request(&server, "tools/list", json!({})).await;
    let tools = response["result"]["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 5);

    let names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name"))
        .collect();
    assert_eq!(
        names,
        vec![
            "list_servers",
            "list_users",
            "get_user_traffic",
            "list_chains",
            "get_status_summary"
        ]
    );

    for tool in tools {
        assert_eq!(
            tool["inputSchema"]["type"], "object",
            "{} must have an object inputSchema",
            tool["name"]
        );
        assert!(
            tool["inputSchema"]["properties"].is_object(),
            "{} must have inputSchema.properties",
            tool["name"]
        );
    }

    let traffic = tools
        .iter()
        .find(|tool| tool["name"] == "get_user_traffic")
        .expect("get_user_traffic tool");
    assert_eq!(
        traffic["inputSchema"]["properties"]["username"]["type"],
        "string"
    );
    assert_eq!(
        traffic["inputSchema"]["properties"]["days"]["type"],
        "integer"
    );
    assert_eq!(traffic["inputSchema"]["required"], json!(["username"]));
}

#[tokio::test]
async fn list_servers_returns_health_fields() {
    let fixture = Fixture::new().await;
    seed_server(
        &fixture.pool,
        "s1",
        "hk-1",
        "online",
        Some(1),
        Some(0.5),
        Some(12),
    )
    .await;
    seed_server(&fixture.pool, "s2", "jp-1", "offline", None, None, None).await;
    let (_dir, server) = fixture.into_server().await;

    let body = tool_text(&server, "list_servers", json!({})).await;
    let servers = body["servers"].as_array().expect("servers array");
    assert_eq!(servers.len(), 2);

    assert_eq!(servers[0]["id"], "s1");
    assert_eq!(servers[0]["name"], "hk-1");
    assert_eq!(servers[0]["address"], "hk-1.example.com");
    assert_eq!(servers[0]["online"], true);
    assert_eq!(servers[0]["xray_running"], true);
    assert_eq!(servers[0]["load1"], 0.5);
    assert_eq!(servers[0]["mem"]["used"], 1024);
    assert_eq!(servers[0]["mem"]["total"], 4096);
    assert_eq!(servers[0]["disk"]["used"], 2048);
    assert_eq!(servers[0]["disk"]["total"], 8192);
    assert_eq!(servers[0]["mem_used"], 1024);
    assert_eq!(servers[0]["mem_total"], 4096);
    assert_eq!(servers[0]["disk_used"], 2048);
    assert_eq!(servers[0]["disk_total"], 8192);
    assert_eq!(servers[0]["latency_ms"], 12);
    assert_eq!(servers[0]["last_seen"], 1_700_000_000_i64);

    assert_eq!(servers[1]["online"], false);
    assert_eq!(servers[1]["xray_running"], Value::Null);
    assert_eq!(servers[1]["latency_ms"], Value::Null);

    // `arguments` may be omitted for no-argument tools.
    let response = request(&server, "tools/call", json!({ "name": "list_servers" })).await;
    assert!(response.get("error").is_none(), "unexpected: {response}");
}

#[tokio::test]
async fn list_users_returns_package_rows_and_account_rows() {
    let fixture = Fixture::new().await;
    seed_user(&fixture.pool, "u1", "alice", "active").await;
    seed_user(&fixture.pool, "u2", "bob", "active").await;
    seed_user(&fixture.pool, "u3", "carol", "active").await;
    seed_package(&fixture.pool, "p1", "基础套餐", Some(1000)).await;
    seed_user_package(
        &fixture.pool,
        "up1",
        "u1",
        "p1",
        400,
        Some(9_999_999_999),
        "active",
    )
    .await;
    seed_user_package(
        &fixture.pool,
        "up3",
        "u3",
        "p1",
        1000,
        Some(9_999_999_999),
        "active",
    )
    .await;
    let (_dir, server) = fixture.into_server().await;

    let body = tool_text(&server, "list_users", json!({})).await;
    let users = body["users"].as_array().expect("users array");
    assert_eq!(users.len(), 3);

    assert_eq!(users[0]["username"], "alice");
    assert_eq!(users[0]["package"], "基础套餐");
    assert_eq!(users[0]["used_bytes"], 400);
    assert_eq!(users[0]["limit_bytes"], 1000);
    assert_eq!(users[0]["expires_at"], 9_999_999_999_i64);
    assert_eq!(users[0]["status"], "active");

    assert_eq!(users[1]["username"], "bob");
    assert_eq!(users[1]["package"], Value::Null);
    assert_eq!(users[1]["used_bytes"], 0);
    assert_eq!(users[1]["limit_bytes"], Value::Null);
    assert_eq!(users[1]["status"], "active");

    assert_eq!(users[2]["username"], "carol");
    assert_eq!(users[2]["used_bytes"], 1000);
    assert_eq!(users[2]["status"], "exhausted");
}

#[tokio::test]
async fn get_user_traffic_fills_missing_days() {
    let fixture = Fixture::new().await;
    seed_user(&fixture.pool, "u1", "alice", "active").await;
    let now = Utc::now().timestamp();
    let today = business_date(now);
    let yesterday = business_date(now - 86_400);
    let two_days_ago = business_date(now - 2 * 86_400);
    seed_traffic(&fixture.pool, &today, "s1", "u1", 10, 20, 30).await;
    seed_traffic(&fixture.pool, &yesterday, "s1", "u1", 1, 2, 3).await;
    let (_dir, server) = fixture.into_server().await;

    let body = tool_text(
        &server,
        "get_user_traffic",
        json!({ "username": "alice", "days": 3 }),
    )
    .await;
    assert_eq!(body["username"], "alice");
    assert_eq!(body["days"], 3);

    let daily = body["daily"].as_array().expect("daily array");
    assert_eq!(daily.len(), 3);
    assert_eq!(daily[0]["date"], two_days_ago);
    assert_eq!(daily[0]["uplink"], 0);
    assert_eq!(daily[0]["downlink"], 0);
    assert_eq!(daily[0]["weighted"], 0);
    assert_eq!(daily[1]["date"], yesterday);
    assert_eq!(daily[1]["uplink"], 1);
    assert_eq!(daily[1]["downlink"], 2);
    assert_eq!(daily[1]["weighted"], 3);
    assert_eq!(daily[2]["date"], today);
    assert_eq!(daily[2]["uplink"], 10);
    assert_eq!(daily[2]["downlink"], 20);
    assert_eq!(daily[2]["weighted"], 30);
}

#[tokio::test]
async fn list_chains_reports_groups_members_and_degradation() {
    let fixture = Fixture::new().await;
    seed_server(&fixture.pool, "s1", "hk-a", "online", Some(1), None, None).await;
    seed_server(&fixture.pool, "s2", "hk-b", "online", Some(1), None, None).await;
    seed_server(&fixture.pool, "s3", "jp-c", "online", Some(1), None, None).await;
    seed_chain(&fixture.pool, "c1", "入口链").await;
    seed_chain_group(&fixture.pool, "g1", "c1", 0, "failover").await;
    seed_chain_group(&fixture.pool, "g2", "c1", 1, "round_robin").await;
    seed_chain_member(&fixture.pool, "g1", "s1", 9001, 0).await;
    seed_chain_member(&fixture.pool, "g1", "s2", 9002, 1).await;
    seed_chain_member(&fixture.pool, "g2", "s3", 9003, 0).await;
    seed_forward_status(&fixture.pool, "s1", "chain-c1-0-s1", 1, Some(1), 0, "").await;
    seed_forward_status(
        &fixture.pool,
        "s2",
        "chain-c1-0-s2",
        1,
        Some(0),
        2,
        "connect timeout",
    )
    .await;
    seed_forward_status(&fixture.pool, "s3", "chain-c1-1", 1, Some(1), 0, "").await;
    let (_dir, server) = fixture.into_server().await;

    let body = tool_text(&server, "list_chains", json!({})).await;
    let chains = body["chains"].as_array().expect("chains array");
    assert_eq!(chains.len(), 1);
    let chain = &chains[0];
    assert_eq!(chain["name"], "入口链");
    assert_eq!(chain["group_count"], 2);
    assert_eq!(chain["member_count"], 3);
    assert_eq!(chain["degraded"], true);

    let groups = chain["groups"].as_array().expect("groups array");
    assert_eq!(groups.len(), 2);
    assert_eq!(groups[0]["strategy"], "failover");
    assert_eq!(groups[0]["member_count"], 2);
    assert_eq!(groups[0]["degraded"], true);
    assert_eq!(groups[0]["members"][0]["server_name"], "hk-a");
    assert_eq!(groups[0]["members"][0]["listening"], true);
    assert_eq!(groups[0]["members"][0]["target_ok"], true);
    assert_eq!(groups[0]["members"][0]["degraded"], false);
    assert_eq!(groups[0]["members"][1]["degraded"], true);
    assert_eq!(groups[0]["members"][1]["error"], "connect timeout");
    assert_eq!(groups[1]["member_count"], 1);
    assert_eq!(groups[1]["degraded"], false);
    assert_eq!(groups[1]["members"][0]["forward_id"], "chain-c1-1");
    assert_eq!(groups[1]["members"][0]["listening"], true);
}

#[tokio::test]
async fn status_summary_reports_online_nodes_and_traffic() {
    let fixture = Fixture::new().await;
    seed_server(&fixture.pool, "s1", "hk-1", "online", Some(1), None, None).await;
    seed_server(&fixture.pool, "s2", "jp-2", "online", Some(1), None, None).await;
    seed_server(&fixture.pool, "s3", "us-3", "offline", None, None, None).await;
    seed_node(&fixture.pool, "n1", "s1", "hk", 1).await;
    seed_node(&fixture.pool, "n2", "s2", "jp", 0).await;

    let now = Utc::now().timestamp();
    let today = business_date(now);
    let (month_start, _) = business_month_bounds(now);
    seed_traffic(&fixture.pool, &today, "s1", "u1", 10, 20, 100).await;
    seed_traffic(&fixture.pool, &month_start, "s1", "u2", 5, 5, 50).await;
    let (_dir, server) = fixture.into_server().await;

    let body = tool_text(&server, "get_status_summary", json!({})).await;
    assert_eq!(body["servers"]["total"], 3);
    assert_eq!(body["servers"]["online"], 2);
    assert_eq!(body["nodes"]["total"], 2);
    assert_eq!(body["nodes"]["enabled"], 1);
    let expected_today = if month_start == today { 150 } else { 100 };
    assert_eq!(body["traffic"]["today_bytes"], expected_today);
    assert_eq!(body["traffic"]["month_bytes"], 150);
}

#[tokio::test]
async fn errors_have_correct_jsonrpc_codes() {
    let fixture = Fixture::new().await;
    let (_dir, server) = fixture.into_server().await;

    let unknown_tool = request(
        &server,
        "tools/call",
        json!({ "name": "delete_everything", "arguments": {} }),
    )
    .await;
    assert_eq!(unknown_tool["error"]["code"], -32602);
    assert!(unknown_tool["error"]["message"]
        .as_str()
        .expect("error message")
        .contains("unknown tool"));

    let unknown_method = request(&server, "does/not/exist", json!({})).await;
    assert_eq!(unknown_method["error"]["code"], -32601);

    let parse_error = server
        .handle_line("{not json")
        .await
        .expect("parse error produces a response");
    assert_eq!(parse_error["error"]["code"], -32700);
    assert_eq!(parse_error["id"], Value::Null);

    let invalid_request = server
        .handle_line("[]")
        .await
        .expect("invalid request produces a response");
    assert_eq!(invalid_request["error"]["code"], -32600);

    let missing_name = request(&server, "tools/call", json!({ "arguments": {} })).await;
    assert_eq!(missing_name["error"]["code"], -32602);

    let bad_arguments = request(
        &server,
        "tools/call",
        json!({ "name": "list_servers", "arguments": [] }),
    )
    .await;
    assert_eq!(bad_arguments["error"]["code"], -32602);

    let unknown_user = request(
        &server,
        "tools/call",
        json!({ "name": "get_user_traffic", "arguments": { "username": "nobody" } }),
    )
    .await;
    assert_eq!(unknown_user["error"]["code"], -32602);
}

#[tokio::test]
async fn notifications_are_ignored() {
    let fixture = Fixture::new().await;
    let (_dir, server) = fixture.into_server().await;

    assert!(server
        .handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
        .await
        .is_none());
    assert!(server
        .handle_line(r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{}}"#)
        .await
        .is_none());
    // Some clients illegally include an id on notifications; still no response.
    assert!(server
        .handle_line(r#"{"jsonrpc":"2.0","id":9,"method":"notifications/initialized"}"#)
        .await
        .is_none());
}

#[tokio::test]
async fn read_only_connection_rejects_writes() {
    let fixture = Fixture::new().await;
    seed_user(&fixture.pool, "u1", "alice", "active").await;
    let (_dir, database) = fixture.into_database().await;

    let error = sqlx::query(
        "INSERT INTO users
            (id, username, password_hash, role, status, short_code, used_bytes, created_at, updated_at)
         VALUES ('u2', 'bob', 'x', 'user', 'active', 'code-u2', 0, 0, 0)",
    )
    .execute(database.pool())
    .await
    .expect_err("write must fail on a read-only connection");
    let message = error.to_string().to_ascii_lowercase();
    assert!(
        message.contains("readonly")
            || message.contains("read-only")
            || message.contains("read only"),
        "unexpected SQLite error: {error}"
    );
}

#[tokio::test]
async fn missing_database_has_clear_error() {
    let dir = TempDir::new();
    let path = dir.db_path();
    let error = Database::open_read_only(&path)
        .await
        .err()
        .expect("a missing file must fail");
    let message = error.to_string();
    assert!(message.contains("只读") || message.contains("read-only"));
    assert!(message.contains(&path.display().to_string()));
}

#[test]
fn db_module_contains_no_write_sql() {
    let source = include_str!("../src/db.rs").to_ascii_uppercase();
    for keyword in [
        "INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER ", "CREATE ",
    ] {
        assert!(
            !source.contains(keyword),
            "src/db.rs must stay SELECT-only, found {keyword}"
        );
    }
}
