//! 迁移 0059 的回归测试：关键查询必须走索引，不允许再出现全表扫描。
//!
//! 这里直接跑 `EXPLAIN QUERY PLAN`。断言只覆盖「真实查询 + 真正该走索引」的
//! 组合；像 `COUNT(*)`、`servers` 这种小表本来就该扫，不会被误判。
//!
//! English: regression test for migration 0059. It runs `EXPLAIN QUERY PLAN`
//! for the real queries and asserts they use an index instead of a table scan.
//! Small-table `COUNT(*)` style scans are intentionally not covered.

use sqlx::SqlitePool;

use pierwave_domain::Db;

/// 跑一条 `EXPLAIN QUERY PLAN`，把 detail 列按顺序取出来。
async fn plan(pool: &SqlitePool, sql: &str) -> Vec<String> {
    let rows: Vec<(i64, i64, i64, String)> = sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
        .fetch_all(pool)
        .await
        .unwrap_or_else(|error| panic!("EXPLAIN 失败：{error}\nSQL: {sql}"));
    rows.into_iter().map(|(_, _, _, detail)| detail).collect()
}

/// 至少有一行计划是 `SEARCH ... USING INDEX <index>`。
async fn assert_uses_index(pool: &SqlitePool, sql: &str, index: &str) {
    let details = plan(pool, sql).await;
    let joined = details.join("\n");
    assert!(
        details
            .iter()
            .any(|detail| detail.starts_with("SEARCH") && detail.contains(index)),
        "查询没有走索引 {index}：\n{joined}\nSQL: {sql}"
    );
    assert_no_full_table_scan(&details, sql);
}

/// 计划里出现指定索引，且没有「SCAN <table>」式整表扫描。
///
/// 用于 `GROUP BY` 走覆盖索引前缀的场景：SQLite 报告的是
/// `SCAN <table> USING INDEX ...`，仍然按索引扫描，不是全表扫描。
async fn assert_plan_uses_index(pool: &SqlitePool, sql: &str, index: &str) {
    let details = plan(pool, sql).await;
    let joined = details.join("\n");
    assert!(
        details.iter().any(|detail| detail.contains(index)),
        "查询计划没有使用索引 {index}：\n{joined}\nSQL: {sql}"
    );
    assert_no_full_table_scan(&details, sql);
}

/// 不允许出现「SCAN <table>」这种整表扫描；`SCAN <table> USING INDEX` 是按索引
/// 顺序扫描（例如全局列表按 created_at 排序），不算整表扫描。
fn assert_no_full_table_scan(details: &[String], sql: &str) {
    for detail in details {
        let table_scan = detail.starts_with("SCAN ") && !detail.contains("USING");
        assert!(!table_scan, "仍有全表扫描：{detail}\nSQL: {sql}");
    }
}

async fn setup() -> SqlitePool {
    let db = Db::connect("sqlite::memory:").await.unwrap();
    db.migrate().await.unwrap();
    let pool = db.pool;

    sqlx::query(
        "INSERT INTO servers (id, name, address, token_hash, created_at)
         VALUES ('s1', 'hk-1', '10.0.0.1', 't1', 100),
                ('s2', 'jp-1', '10.0.0.2', 't2', 101)",
    )
    .execute(&pool)
    .await
    .unwrap();

    for (id, server_id, tag, created_at) in [
        ("n1", "s1", "hk-vless", 200_i64),
        ("n2", "s2", "jp-vmess", 201),
    ] {
        sqlx::query(
            "INSERT INTO nodes
                (id, server_id, tag, name, protocol, transport, security, port,
                 config_json, enabled, created_at)
             VALUES (?, ?, ?, ?, 'vless', 'tcp', 'none', 443, '{}', 1, ?)",
        )
        .bind(id)
        .bind(server_id)
        .bind(tag)
        .bind(tag)
        .bind(created_at)
        .execute(&pool)
        .await
        .unwrap();
    }

    for (id, username, code, created_at) in
        [("u1", "alice", "sc1", 300_i64), ("u2", "bob", "sc2", 301)]
    {
        sqlx::query(
            "INSERT INTO users
                (id, username, password_hash, role, status, short_code,
                 quota_bytes, used_bytes, created_at, updated_at)
             VALUES (?, ?, 'x', 'user', 'active', ?, NULL, 0, ?, ?)",
        )
        .bind(id)
        .bind(username)
        .bind(code)
        .bind(created_at)
        .bind(created_at)
        .execute(&pool)
        .await
        .unwrap();
    }

    sqlx::query(
        "INSERT INTO sessions
            (id, user_id, token_hash, expires_at, created_at, user_agent, ip, last_seen_at)
         VALUES ('sess1', 'u1', 'th1', 900, 300, 'bench', '10.0.0.9', 300)",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO audit_log (id, actor_id, action, target, detail, created_at)
         VALUES ('a1', 'u1', 'auth.login', 'u1', '{}', 400),
                ('a2', 'u1', 'user.update', 'u1', '{}', 401)",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO traffic_daily (day, server_id, subject, uplink, downlink, weighted)
         VALUES ('2026-01-01', 's1', 'u1', 1, 2, 3),
                ('2026-01-02', 's2', 'u2', 4, 5, 6)",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO traffic_node_daily
            (day, server_id, node_tag, user_id, uplink, downlink, weighted)
         VALUES ('2026-01-01', 's1', 'hk-vless', 'u1', 1, 2, 3)",
    )
    .execute(&pool)
    .await
    .unwrap();

    sqlx::query(
        "INSERT INTO forward_traffic_daily (day, forward_id, user_id, bytes, weighted)
         VALUES ('2026-01-01', 'f1', 'u1', 10, 20)",
    )
    .execute(&pool)
    .await
    .unwrap();

    // 不跑 ANALYZE：主控自己也不跑，SQLite 会按默认基数估算并优先用索引；
    // 这里只塞了几行数据，ANALYZE 反而会让规划器认为「全表扫更快」。
    pool
}

#[tokio::test]
async fn overview_subject_queries_use_the_subject_index() {
    let pool = setup().await;

    // stats::subject_totals：只有 subject 条件，没有 day 前缀。
    assert_uses_index(
        &pool,
        "SELECT COALESCE(SUM(weighted), 0) FROM traffic_daily WHERE subject = 'u1'",
        "idx_traffic_daily_subject_day",
    )
    .await;

    // stats::traffic_trend_for_subject：subject + 日期窗口。
    assert_uses_index(
        &pool,
        "SELECT day, COALESCE(SUM(uplink), 0)
         FROM traffic_daily
         WHERE day >= '2026-01-01' AND day <= '2026-01-31' AND subject = 'u1'
         GROUP BY day",
        "idx_traffic_daily_subject_day",
    )
    .await;
}

#[tokio::test]
async fn top_servers_join_uses_the_server_day_index() {
    let pool = setup().await;
    // overview::top_servers：每台服务器按 (server_id, day) 取窗口内流量。
    assert_uses_index(
        &pool,
        "SELECT s.id, COALESCE(SUM(t.uplink + t.downlink), 0)
         FROM servers s
         LEFT JOIN traffic_daily t
           ON t.server_id = s.id AND t.day >= '2026-01-01' AND t.day <= '2026-01-31'
         GROUP BY s.id, s.name, s.load1, s.status, s.created_at
         ORDER BY 2 DESC, s.created_at ASC, s.id ASC
         LIMIT 5",
        "idx_traffic_daily_server_day",
    )
    .await;
}

#[tokio::test]
async fn node_traffic_with_server_filter_uses_the_server_day_index() {
    let pool = setup().await;
    assert_uses_index(
        &pool,
        "SELECT t.day, COALESCE(SUM(t.uplink), 0)
         FROM traffic_node_daily t
         WHERE t.day >= '2026-01-01' AND t.day <= '2026-01-31'
           AND t.server_id = 's1'
         GROUP BY t.day",
        "idx_traffic_node_daily_server_day",
    )
    .await;
}

#[tokio::test]
async fn recent_logins_uses_the_actor_action_index() {
    let pool = setup().await;
    // 用户端「最近登录」：actor_id + action + 时间倒序。
    assert_uses_index(
        &pool,
        "SELECT id, detail, created_at
         FROM audit_log
         WHERE actor_id = 'u1' AND action = 'auth.login'
         ORDER BY created_at DESC, id DESC
         LIMIT 10",
        "idx_audit_log_actor_action_created",
    )
    .await;
}

#[tokio::test]
async fn session_purge_uses_the_expires_at_index() {
    let pool = setup().await;
    assert_uses_index(
        &pool,
        "DELETE FROM sessions WHERE expires_at < 900",
        "idx_sessions_expires_at",
    )
    .await;
}

#[tokio::test]
async fn paginated_lists_use_their_ordering_indexes() {
    let pool = setup().await;

    // nodes::list_page：服务器内分页，按 (server_id, created_at) 排序。
    assert_uses_index(
        &pool,
        "SELECT * FROM nodes
         WHERE server_id = 's1'
         ORDER BY created_at ASC, rowid ASC",
        "idx_nodes_server_created",
    )
    .await;

    // users::list_with_query：按 created_at 倒序取前 N 条，避免整表排序。
    let details = plan(
        &pool,
        "SELECT * FROM users ORDER BY created_at DESC, rowid DESC LIMIT 200",
    )
    .await;
    let joined = details.join("\n");
    assert!(
        details
            .iter()
            .any(|detail| detail.contains("idx_users_created_at")),
        "用户分页没有走 idx_users_created_at：\n{joined}"
    );
    assert!(
        !details.iter().any(|detail| detail.contains("TEMP B-TREE")),
        "用户分页不应再临时排序：\n{joined}"
    );
    assert_no_full_table_scan(&details, "SELECT * FROM users ORDER BY ...");
}

#[tokio::test]
async fn forward_traffic_user_filter_uses_the_existing_user_index() {
    let pool = setup().await;
    // 优化后的 summary：user 条件不再是 `(? IS NULL OR user_id = ?)`，索引可用。
    assert_uses_index(
        &pool,
        "SELECT COALESCE(SUM(bytes), 0)
         FROM forward_traffic_daily
         WHERE day >= '2026-01-01' AND day <= '2026-01-31' AND user_id = 'u1'",
        "idx_forward_traffic_daily_user",
    )
    .await;
}

#[tokio::test]
async fn legacy_combos_are_already_covered_by_the_primary_keys() {
    let pool = setup().await;

    // traffic_daily(day, server_id, subject) 的主键前缀就是 (day, ...)。
    assert_uses_index(
        &pool,
        "SELECT COALESCE(SUM(weighted), 0) FROM traffic_daily
         WHERE day >= '2026-01-01' AND day <= '2026-01-31'",
        "sqlite_autoindex_traffic_daily_1",
    )
    .await;

    // forward_traffic_daily(day, forward_id) 的主键。
    assert_uses_index(
        &pool,
        "SELECT COALESCE(SUM(bytes), 0) FROM forward_traffic_daily
         WHERE day = '2026-01-01' AND forward_id = 'f1'",
        "sqlite_autoindex_forward_traffic_daily_1",
    )
    .await;

    // server_samples(server_id, ts) 的主键。
    assert_uses_index(
        &pool,
        "SELECT server_id, AVG(online) FROM server_samples
         WHERE server_id = 's1' AND ts >= 1 AND ts <= 2
         GROUP BY server_id",
        "sqlite_autoindex_server_samples_1",
    )
    .await;

    // audit_log(created_at, id) 的既有索引（迁移 0019）。
    assert_uses_index(
        &pool,
        "SELECT id FROM audit_log WHERE created_at >= 1 AND created_at <= 2",
        "idx_audit_log_created_at_id",
    )
    .await;
}

/// 公开节点详情页的两条聚合都必须走 `idx_server_samples_ts(ts)`：
/// 一次按 `server_id, UTC+8 日`，一次按 `server_id, 小时`，不按服务器循环。
#[tokio::test]
async fn public_status_detail_aggregates_use_the_sample_time_index() {
    let pool = setup().await;

    // buckets_7d：GROUP BY server_id, date(ts + 28800, 'unixepoch')。
    assert_uses_index(
        &pool,
        "SELECT server_id,
                date(ts + 28800, 'unixepoch') AS day,
                AVG(online) AS online_ratio,
                COUNT(*) AS samples
         FROM server_samples
         WHERE ts >= 1 AND ts <= 2
         GROUP BY server_id, date(ts + 28800, 'unixepoch')",
        "idx_server_samples_ts",
    )
    .await;

    // series_24h + 中断计数：GROUP BY server_id, (ts / 3600) * 3600。
    assert_uses_index(
        &pool,
        "SELECT server_id,
                (ts / 3600) * 3600 AS ts,
                AVG(CASE WHEN online = 1 THEN rx_bps END) AS rate_rx_bps,
                AVG(CASE WHEN online = 1 THEN tx_bps END) AS rate_tx_bps,
                CAST(ROUND(AVG(CASE WHEN online = 1 THEN latency_ms END)) AS INTEGER) AS latency_ms,
                SUM(CASE WHEN online = 0 THEN 1 ELSE 0 END) AS outage_samples
         FROM server_samples
         WHERE ts >= 1 AND ts <= 2
         GROUP BY server_id, (ts / 3600) * 3600",
        "idx_server_samples_ts",
    )
    .await;
}

/// `inbound_count` 的计数走 `nodes(server_id)` 前缀索引，不是整表全扫。
#[tokio::test]
async fn inbound_counts_use_the_nodes_server_index() {
    let pool = setup().await;
    assert_plan_uses_index(
        &pool,
        "SELECT server_id, COUNT(*) AS inbound_count
         FROM nodes
         WHERE enabled = 1
         GROUP BY server_id",
        "idx_nodes_server_created",
    )
    .await;
}
