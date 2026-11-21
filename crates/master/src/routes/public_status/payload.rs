//! 公开状态页 1000 台服务器时的响应体积 / 耗时回归。
//!
//! 背景：列表接口曾经把每台服务器的 `series_24h`（24 个整点桶 + 3 条 24 项数组）
//! 一起返回，1000 台时单单这一项就接近整份响应的一半。趋势数据已经拆到
//! `GET /api/v1/public/status/{id}`，列表只保留列表页真正渲染的字段。
//!
//! 这个测试造一个临时库（内存 SQLite），1000 台服务器，每台：
//! * 24 个 `buckets_24h` 小时桶；
//! * 24 个 `series_24h` 整点桶（详情接口）；
//! * 7 个自然日桶（`buckets_7d`）；
//!
//! 然后测量列表 / 详情的未压缩体积、gzip 后体积与冷缓存耗时，并把数字打进
//! 输出（`cargo test ... -- --nocapture`）。断言只看**回归阈值**：列表体积
//! 每台 ≤ [`LIST_BYTES_PER_SERVER_MAX`]，且列表**不再包含** `series_24h`。
//!
//! English: regression budget for the public status payload with 1000 servers.
//! The per-server 24h series used to double the list payload; it now lives on the
//! detail endpoint. The test measures raw and gzip sizes plus cold-cache latency,
//! prints them, and asserts the list byte budget and the absence of `series_24h`.

use std::io::Write;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use serde_json::Value;
use tower::ServiceExt;

use pierwave_domain::repo;
use pierwave_domain::Db;

use crate::state::AppState;

/// 服务器数量：需求给定的规模。
const SERVERS: i64 = 1000;

/// 列表每台服务器的体积上限（未压缩）。
///
/// 需求给的阈值是 1.2 KB/台，但那是在**没有** 24 个小时桶 + 7 个自然日桶 +
/// 34 个白名单字段的前提下估的；拆掉 `series_24h` 后实测约 2.0 KB/台，
/// 其中固定结构（24 × `{ts, online_ratio}` + 7 × `{day, online_ratio, samples}`）
/// 就占了 1.3 KB 以上，往下压只能砍字段/砍桶——那会破坏已验收的展示。
///
/// 因此按需求里「或你实测的合理阈值」取实测值 + 约 10% 余量：2.2 KB/台。
/// `docs/PUBLIC-STATUS.md` 记录了拆前/拆后、压缩前后的完整数字。
const LIST_BYTES_PER_SERVER_MAX: usize = 2200;

async fn setup() -> (Router, AppState) {
    let db = Db::connect("sqlite::memory:").await.unwrap();
    db.migrate().await.unwrap();
    let state = AppState::new(db, "web/dist");
    let app = crate::app::router(state.clone());
    (app, state)
}

/// 造 1000 台服务器 + 每台 24 个小时采样 + 5 个更早自然日的采样。
///
/// 字段都填成「最宽」的合法值（UUID、中文名、分组、费用四列齐全），这样测到的
/// 是上界而不是空库的乐观值。采样非 NULL，序列画满而不是补 `null` 断点。
async fn seed(state: &AppState) {
    let now = repo::now();
    let hour = now - now.rem_euclid(3_600);

    sqlx::query(
        "WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i < ?)
         INSERT INTO servers
            (id, name, address, token_hash, xray_mode, status, created_at,
             country_code, group_name, os_name, os_version, virt, arch,
             load1, mem_used, mem_total, disk_used, disk_total, uptime_secs,
             last_seen_at, latency_ms, net_rx_bytes, net_tx_bytes,
             net_rx_bps, net_tx_bps, paid_until, price_cents, currency, billing_cycle)
         SELECT printf('%08x-0000-4000-8000-%012x',
                       (i * 2654435761) % 4294967296, i * 7919 + 17),
                printf('香港-节点-%04d', i),
                printf('10.%d.%d.1', i / 250, i % 250),
                printf('hash-%04d', i),
                'external',
                CASE WHEN i % 10 = 0 THEN 'offline' ELSE 'online' END,
                ? - i * 86400,
                CASE i % 3 WHEN 0 THEN 'HK' WHEN 1 THEN 'JP' ELSE NULL END,
                CASE i % 4 WHEN 0 THEN 'premium' WHEN 1 THEN 'standard' ELSE NULL END,
                'Debian GNU/Linux', '12', 'kvm', 'x86_64',
                0.42, 1073741824, 4294967296, 10737418240, 107374182400,
                1234567, ? - 30, 28, 123456789012, 98765432109,
                1048576.5, 262144.25,
                '2026-12-31', 4999, 'CNY', 'monthly'
         FROM seq",
    )
    .bind(SERVERS - 1)
    .bind(now)
    .bind(now)
    .execute(&state.db.pool)
    .await
    .unwrap();

    // 每小时两条采样（整点 + 半点）：`buckets_24h` 的 online_ratio 会出现
    // 0 / 0.5 / 1 三种值，而不是清一色的 1.0（否则 gzip 会把整段压没）。
    sqlx::query(
        "WITH RECURSIVE hours(h) AS (SELECT 0 UNION ALL SELECT h+1 FROM hours WHERE h < 23)
         INSERT INTO server_samples
            (server_id, ts, online, load1, mem_used, mem_total, disk_used, disk_total,
             latency_ms, rx_bps, tx_bps)
         SELECT s.id,
                ? - h * 3600 + off,
                CASE WHEN (s.rowid + h + off / 1800) % 13 = 0 THEN 0 ELSE 1 END,
                0.42, 1073741824, 4294967296, 10737418240, 107374182400,
                20 + (h % 7) + (s.rowid % 11),
                1048576.5 + h * 1234.25 + (s.rowid % 97) * 7919.125,
                262144.25 + h * 456.5 + (s.rowid % 89) * 3571.75
         FROM servers s CROSS JOIN hours
         CROSS JOIN (SELECT 0 AS off UNION ALL SELECT 1800)",
    )
    .bind(hour)
    .execute(&state.db.pool)
    .await
    .unwrap();

    // 更早的 5 个自然日各一条采样：buckets_7d 的 7 个桶全部有数据。
    sqlx::query(
        "WITH RECURSIVE days(d) AS (SELECT 2 UNION ALL SELECT d+1 FROM days WHERE d < 6)
         INSERT INTO server_samples
            (server_id, ts, online, load1, mem_used, mem_total, disk_used, disk_total,
             latency_ms, rx_bps, tx_bps)
         SELECT s.id, ? - d * 86400, 1,
                0.42, 1073741824, 4294967296, 10737418240, 107374182400,
                20 + d + (s.rowid % 11),
                1048576.5 + d * 1234.25 + (s.rowid % 97) * 7919.125,
                262144.25 + d * 456.5 + (s.rowid % 89) * 3571.75
         FROM servers s CROSS JOIN days",
    )
    .bind(hour)
    .execute(&state.db.pool)
    .await
    .unwrap();
}

/// gzip 后的字节数（与 `CompressionLayer` 的 gzip 编码同一类输出）。
fn gzip_len(bytes: &[u8]) -> usize {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap().len()
}

async fn get(app: &Router, uri: &str) -> (StatusCode, Vec<u8>) {
    let request = Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 64 * 1024 * 1024)
        .await
        .unwrap()
        .to_vec();
    (status, bytes)
}

/// 冷缓存跑 `runs` 次，返回（耗时列表，响应体字节）。
async fn measure(
    app: &Router,
    state: &AppState,
    uri: &str,
    runs: usize,
) -> (Vec<Duration>, Vec<u8>) {
    let mut durations = Vec::with_capacity(runs);
    let mut last = Vec::new();
    for _ in 0..runs {
        // 每次清缓存，测的是真实聚合 + 序列化，而不是命中缓存的空转。
        state.public_status.clear();
        let started = Instant::now();
        let (status, bytes) = get(app, uri).await;
        durations.push(started.elapsed());
        assert_eq!(status, StatusCode::OK, "{} 应返回 200", uri);
        last = bytes;
    }
    (durations, last)
}

fn format_bytes(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.2} MB", bytes as f64 / 1024.0 / 1024.0)
    } else {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    }
}

#[tokio::test]
async fn list_and_detail_payload_fit_the_budget_with_1000_servers() {
    let (app, state) = setup().await;
    seed(&state).await;

    let started = Instant::now();
    let (durations, raw) = measure(&app, &state, "/api/v1/public/status", 3).await;
    let cold = started.elapsed();
    let list: Value = serde_json::from_slice(&raw).unwrap();
    let servers = list["servers"].as_array().unwrap();
    assert_eq!(servers.len(), SERVERS as usize, "必须返回 1000 台");

    let raw_len = raw.len();
    let gzip = gzip_len(&raw);
    println!(
        "[public-status][list] servers={} raw={} ({:.0} B/server) gzip={} ({:.0} B/server) \
         ratio={:.1}% cold_runs={:?} total_cold={:?}",
        servers.len(),
        format_bytes(raw_len),
        raw_len as f64 / SERVERS as f64,
        format_bytes(gzip),
        gzip as f64 / SERVERS as f64,
        gzip as f64 * 100.0 / raw_len as f64,
        durations,
        cold,
    );

    // 列表不再携带逐台趋势；字段拆到详情接口。
    assert!(
        servers
            .iter()
            .all(|server| server.get("series_24h").is_none()),
        "列表接口不能返回 series_24h（1000 台时它占近一半体积）"
    );
    // 其它字段一个都不能少：拆的只有 series_24h。
    for key in [
        "id",
        "name",
        "online",
        "buckets_24h",
        "buckets_7d",
        "outage_minutes_24h",
        "net_rx_bps",
        "paid_until",
    ] {
        assert!(
            servers[0].get(key).is_some(),
            "列表行缺少既有字段 {key}：{}",
            servers[0]
        );
    }

    let per_server = raw_len / SERVERS as usize;
    assert!(
        per_server <= LIST_BYTES_PER_SERVER_MAX,
        "列表体积回归：{per_server} B/台 > {LIST_BYTES_PER_SERVER_MAX} B/台（总体 {}）",
        format_bytes(raw_len)
    );

    // 详情接口：同一台服务器的完整形状 + 24h 趋势。
    let id = servers[0]["id"].as_str().unwrap().to_string();
    let uri = format!("/api/v1/public/status/{id}");
    let (detail_durations, detail_raw) = measure(&app, &state, &uri, 3).await;
    let detail: Value = serde_json::from_slice(&detail_raw).unwrap();
    let detail_gzip = gzip_len(&detail_raw);
    println!(
        "[public-status][detail] server={} raw={} gzip={} ratio={:.1}% cold_runs={:?}",
        id,
        format_bytes(detail_raw.len()),
        format_bytes(detail_gzip),
        detail_gzip as f64 * 100.0 / detail_raw.len() as f64,
        detail_durations,
    );

    assert_eq!(detail["server"]["id"], id.as_str(), "{detail}");
    let series = &detail["series_24h"];
    assert_eq!(series["window_secs"], 86_400, "{detail}");
    assert_eq!(series["step_secs"], 3_600, "{detail}");
    for key in ["t", "rate_rx_bps", "rate_tx_bps", "latency_ms"] {
        assert_eq!(
            series[key].as_array().unwrap().len(),
            24,
            "详情 {key} 必须固定 24 项：{detail}"
        );
    }
    assert!(
        series["t"].as_array().unwrap().iter().any(|ts| ts.is_i64()),
        "{detail}"
    );
    // `server` 与列表行完全同形：详情不额外多字段，也不漏字段。
    let mut detail_keys: Vec<&str> = detail["server"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let mut list_keys: Vec<&str> = servers[0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    detail_keys.sort_unstable();
    list_keys.sort_unstable();
    assert_eq!(detail_keys, list_keys, "详情 server 必须与列表行同形");

    // 缓存命中：30 秒内重复请求不再聚合，耗时应该显著低于冷缓存。
    // 上面测详情时缓存已经被填好，这里取两次：第一次可能是详情刚写下的快照，
    // 第二次一定是同一份缓存，两次响应必须逐字节一致。
    let (status, first_warm) = get(&app, "/api/v1/public/status").await;
    assert_eq!(status, StatusCode::OK);
    let started = Instant::now();
    let (status, cached) = get(&app, "/api/v1/public/status").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cached, first_warm, "缓存命中必须返回同一份列表");
    println!(
        "[public-status][list] warm cache={:?} (cold first run {:?})",
        started.elapsed(),
        durations[0]
    );
}
