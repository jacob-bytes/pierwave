//! 探针公开页（无需登录）：
//!
//! * `GET /api/v1/public/status`：列表 + 全站迷你图 + 分组；
//! * `GET /api/v1/public/status/{id}`：单台服务器的完整行 + 24h 逐小时趋势。
//!
//! 响应形状与 `docs/PLAN.md`「P10：探针公开页」一致，只读、只暴露白名单字段。
//! 采样聚合全部走 `pierwave_domain::repo::server_samples`，这里只负责把行拼成
//! 24 个小时桶 / 12 个 5 分钟迷你图桶 / 7 个自然日桶并做 30 秒进程内缓存。
//!
//! **列表不返回 `series_24h`**：1000 台服务器时这项占列表体积近一半，趋势已经
//! 拆到详情接口，列表只保留列表页真正渲染的字段。详情响应的 `server` 与列表行
//! 完全同形，趋势放在顶层 `series_24h`；两者来自同一次聚合与同一份 30 秒缓存。
//!
//! `series` 是纯增量字段：窗口 60 分钟、12 个 5 分钟桶，缺桶补 `null`（不是 0）。
//! 每台服务器上的 `outage_minutes_24h` / `buckets_7d` / `first_seen_at` /
//! `inbound_count` 也是纯增量字段，旧客户端忽略即可。
//! 口径见 `docs/PUBLIC-STATUS.md`。

use std::collections::{BTreeMap, HashMap, HashSet};

use axum::extract::{Path, State};
use axum::Json;
use serde::Serialize;
use serde_json::{json, Value};

use pierwave_domain::billing::BillingMeta;
use pierwave_domain::models::{PublicSummary, ServerDailyBucket, ServerHourlySeriesBucket};
use pierwave_domain::repo;
use pierwave_domain::time;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, PublicStatusSnapshot};

const HOUR_SECS: i64 = 3_600;
const BUCKETS_24H: usize = 24;
/// 一天的秒数。
const DAY_SECS: i64 = 86_400;
/// 公开节点详情页的自然日桶数：固定 7 天。
const BUCKETS_7D: usize = 7;

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
    /// 管理员填写的计费周期数量（1..=1200）；未填写或存量值非法为 null。
    billing_cycle_count: Option<i64>,
    /// 管理员填写的计费周期单位（month / year / once）；未填写或存量值非法为 null。
    billing_cycle_unit: Option<String>,
    /// 旧版单值计费周期（monthly / yearly / once），由数量 + 单位派生。
    ///
    /// 只为旧客户端保留：`3 个月` / `2 年` 没有对应的旧值，这里就是 `null`。
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
    /// 最近 24h 内 `online = 0` 的采样分钟数之和（采样粒度 5 分钟）。
    ///
    /// **没有任何采样时是 null，不是 0**：0 代表「有采样且全程在线」，
    /// null 代表「未知」，两者不能混用。
    outage_minutes_24h: Option<i64>,
    /// 首次记录时间（`servers.created_at`，Unix 秒）；0 / 未知为 null。
    first_seen_at: Option<i64>,
    /// 该服务器上启用的入站数量；没有节点是 0。
    ///
    /// 公开字段只暴露**数量**，不含协议 / 端口 / tag / 地址 / 配置。
    inbound_count: i64,
    /// 固定 7 个 UTC+8 自然日，从最早到最新；无样本的日 `online_ratio` 为 null。
    ///
    /// **不含** `series_24h`：逐小时趋势只出现在详情接口
    /// `GET /api/v1/public/status/{id}`，列表接口返回它会让 1000 台规模下的
    /// 响应体积接近翻倍。
    buckets_7d: Vec<PublicDailyBucket>,
}

/// 一个 UTC+8 自然日的公开可用率桶。
#[derive(Debug, Serialize)]
struct PublicDailyBucket {
    /// `YYYY-MM-DD`（UTC+8，与 `traffic` 日账本同口径）。
    day: String,
    /// 当天 `AVG(online)`，0..1；当天没有任何采样时是 null（不是 0）。
    online_ratio: Option<f64>,
    /// 当天采样行数；没有采样是 0。
    samples: i64,
}

/// 单台服务器最近 24h 的逐小时趋势。
///
/// 形状与全局 `series` 相同（`t` + 三条等长数组），口径也一致：只统计该小时
/// `online = 1` 的采样，速率取 `AVG`、延迟取 `ROUND(AVG)`，没有在线采样的小时
/// 补 `null`。离线采样带的是掉线前最后一帧，不能画进趋势。
#[derive(Debug, Serialize)]
struct PublicServerSeries {
    /// 窗口长度（秒），固定 86400。
    window_secs: i64,
    /// 桶宽（秒），固定 3600（整点）。
    step_secs: i64,
    /// 24 个桶起点，升序；最后一个桶是当前小时。
    t: Vec<i64>,
    /// 该小时**在线**采样的 `AVG(rx_bps)`；没有在线采样时是 null，绝不是 0。
    rate_rx_bps: Vec<Option<f64>>,
    /// 同 [`PublicServerSeries::rate_rx_bps`]，发送方向。
    rate_tx_bps: Vec<Option<f64>>,
    /// 该小时在线采样的 `ROUND(AVG(latency_ms))`；没有有效延迟时是 null。
    latency_ms: Vec<Option<i64>>,
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
    /// 管理员是否整体隐藏了费用与到期（`settings.public_billing_visible = 0`）。
    ///
    /// `true` 时 `paid_until` / `price_cents` / `currency` /
    /// `billing_cycle_count` / `billing_cycle_unit` / `billing_cycle`
    /// 一律是 `null`，读者必须靠这个字段区分「不公开」与「没配置」；
    /// `false` 时这些字段的 `null` 只表示管理员没填。
    billing_hidden: bool,
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

/// 最近 7 个 UTC+8 自然日的日期（`YYYY-MM-DD`），升序：今天及之前 6 天。
///
/// 自然日按 UTC+8 切分，与 `traffic_daily.day` 口径一致；不做 UTC 日期，
/// 否则东八区凌晨的样本会记到前一天。
fn day_bucket_dates(now: i64) -> Vec<String> {
    let today = time::business_day(now);
    (0..BUCKETS_7D)
        .rev()
        .map(|back| time::business_date(time::business_day_start(today - back as i64)))
        .collect()
}

/// `servers.created_at` 为 0 / 负数（未知或手工改库）时公开 null，不编造时间。
fn first_seen_at(created_at: i64) -> Option<i64> {
    (created_at > 0).then_some(created_at)
}

/// 一条 `online = 0` 采样代表的中断分钟数（采样粒度 5 分钟）。
fn outage_minutes(samples: i64) -> i64 {
    samples * repo::server_samples::SAMPLE_INTERVAL_SECS / 60
}

/// 公开页总开关关闭时的统一 404：列表与详情语义一致。
fn disabled_error() -> AppError {
    AppError::not_found("public_status.disabled", None, "公开状态页已关闭")
}

/// 未知 id，或服务器存在但被白名单隐藏。
///
/// 两种情况**必须**返回同一个 404：否则读者可以用详情接口枚举出被隐藏服务器的
/// id 是否存在，白名单就形同虚设。`params.id` 原样回传请求里的 id，便于客户端
/// 定位自己请求了哪一台。
fn not_found_error(id: &str) -> AppError {
    AppError::not_found(
        "public_status.not_found",
        Some(json!({ "id": id })),
        format!("公开状态页没有这台服务器 / No such server on the public status page: {id}"),
    )
}

pub async fn status(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let settings = crate::routes::settings::load(&state.db).await;
    if settings.public_status_enabled == 0 {
        return Err(disabled_error());
    }

    // 开关判断必须在缓存之前：关闭后即使有旧缓存也必须立刻 404。
    // 缓存未命中时走单飞重建：同一时刻只有一个请求真的聚合，其余等同一结果
    // （见 `PublicStatusCache::get_or_build`）。
    let snapshot = state
        .public_status
        .get_or_build(|| build_snapshot(&state, &settings))
        .await?;
    Ok(Json(snapshot.list))
}

/// 单台服务器的公开详情：`{ server, series_24h }`。
///
/// `server` 与列表行**完全同形**（同一份 JSON），趋势单独放在顶层，方便前端把
/// 详情页的列表字段与趋势分别复用。未知 id 与被隐藏的服务器一律 404
/// `public_status.not_found`；页面关闭时是 404 `public_status.disabled`。
///
/// 缓存与列表共用：详情请求先看列表快照，未命中就做一次与列表相同的聚合再
/// 缓存。详情不会单独维护一份会过期的趋势缓存。冷启动 / 过期瞬间的并发详情
/// 请求同样走单飞，不会各自扫一遍采样表。
pub async fn detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let settings = crate::routes::settings::load(&state.db).await;
    if settings.public_status_enabled == 0 {
        return Err(disabled_error());
    }

    let snapshot = state
        .public_status
        .get_or_build(|| build_snapshot(&state, &settings))
        .await?;

    let server = snapshot
        .list
        .get("servers")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter()
                .find(|row| row.get("id").and_then(Value::as_str) == Some(id.as_str()))
        })
        .cloned();
    let (Some(server), Some(series)) = (server, snapshot.series.get(&id).cloned()) else {
        return Err(not_found_error(&id));
    };
    Ok(Json(json!({ "server": server, "series_24h": series })))
}

/// 一次聚合出「列表响应 + 每台服务器的 24h 趋势」，两者一起缓存。
///
/// 除了 `series_24h` 的位置，聚合逻辑与拆分前完全一致：所有查询仍是跨服务器
/// 的一条 SQL + 内存映射，没有 N+1。
async fn build_snapshot(
    state: &AppState,
    settings: &crate::routes::settings::Settings,
) -> AppResult<PublicStatusSnapshot> {
    let now = repo::now();
    let billing_hidden = settings.public_billing_visible == 0;
    let summary = repo::stats::public_summary(&state.db.pool, now).await?;
    // 白名单：只有 public_visible = 1 的服务器进入公开响应。汇总与 series
    // 在仓储层用同一个条件过滤，groups 由这里的可见集合累加，三处不会错位。
    let servers = repo::servers::list(&state.db.pool)
        .await?
        .into_iter()
        .filter(|server| server.public_visible)
        .collect::<Vec<_>>();

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

    // 7 天可用率：一次 `GROUP BY server_id, UTC+8 日`，空日子在内存里补 null。
    // 窗口从 6 天前的 UTC+8 00:00 到现在，正好覆盖 7 个自然日（含今天）。
    let day_dates = day_bucket_dates(now);
    let week_start = time::business_day_start(time::business_day(now) - (BUCKETS_7D as i64 - 1));
    let mut daily: HashMap<String, HashMap<String, ServerDailyBucket>> = HashMap::new();
    for row in repo::server_samples::daily_buckets_all(&state.db.pool, week_start, now).await? {
        daily
            .entry(row.server_id.clone())
            .or_default()
            .insert(row.day.clone(), row);
    }

    // 每台服务器的 24h 逐小时趋势 + 中断采样数：同一条 `GROUP BY server_id, 小时`
    // 查询同时算出「仅在线采样」的趋势与「online = 0」计数，不再为中断单独扫
    // 一遍样本表；离线采样的残留速率/延迟不进入趋势（与全局 `series` 同口径）。
    let mut detail: HashMap<String, HashMap<i64, ServerHourlySeriesBucket>> = HashMap::new();
    let mut outage_samples: HashMap<String, i64> = HashMap::new();
    for row in repo::server_samples::hourly_series_all(&state.db.pool, now - DAY_SECS, now).await? {
        *outage_samples.entry(row.server_id.clone()).or_default() += row.outage_samples;
        detail
            .entry(row.server_id.clone())
            .or_default()
            .insert(row.ts, row);
    }

    // 入站数量：一次 `GROUP BY server_id` 查完所有服务器（没有 N+1）。
    let inbound_counts: HashMap<String, i64> =
        repo::nodes::enabled_counts_by_server(&state.db.pool)
            .await?
            .into_iter()
            .map(|row| (row.server_id, row.inbound_count))
            .collect();

    let mut group_accumulators: BTreeMap<Option<String>, GroupAccumulator> = BTreeMap::new();
    // 趋势从列表行里拿出来，稍后单独序列化成详情接口的 `series_24h`。
    let mut series_24h_rows: Vec<(String, PublicServerSeries)> = Vec::with_capacity(servers.len());
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
            // 7 天桶固定 7 项；查询只返回有采样的日子，这里按日期补 null。
            let day_rows = daily.get(&server.id);
            let buckets_7d = day_dates
                .iter()
                .map(|day| {
                    let row = day_rows.and_then(|rows| rows.get(day));
                    PublicDailyBucket {
                        day: day.clone(),
                        online_ratio: row.and_then(|row| row.online_ratio),
                        samples: row.map(|row| row.samples).unwrap_or(0),
                    }
                })
                .collect();
            // 24h 逐小时趋势：固定 24 项，空小时补 null（不是 0）。
            let detail_rows = detail.get(&server.id);
            let series_24h = PublicServerSeries {
                window_secs: DAY_SECS,
                step_secs: HOUR_SECS,
                t: starts.clone(),
                rate_rx_bps: starts
                    .iter()
                    .map(|ts| {
                        detail_rows
                            .and_then(|rows| rows.get(ts))
                            .and_then(|row| row.rate_rx_bps)
                    })
                    .collect(),
                rate_tx_bps: starts
                    .iter()
                    .map(|ts| {
                        detail_rows
                            .and_then(|rows| rows.get(ts))
                            .and_then(|row| row.rate_tx_bps)
                    })
                    .collect(),
                latency_ms: starts
                    .iter()
                    .map(|ts| {
                        detail_rows
                            .and_then(|rows| rows.get(ts))
                            .and_then(|row| row.latency_ms)
                    })
                    .collect(),
            };
            // 与列表分开返回：列表不再带 `series_24h`，这里把同一份聚合留给详情接口。
            series_24h_rows.push((server.id.clone(), series_24h));
            // 没有任何采样 = null（未知）；有采样 = 实际中断分钟数（可能是 0）。
            let outage_minutes_24h = outage_samples
                .get(&server.id)
                .map(|samples| outage_minutes(*samples));
            let first_seen_at = first_seen_at(server.created_at);
            let inbound_count = inbound_counts.get(&server.id).copied().unwrap_or(0);
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
                paid_until: if billing_hidden {
                    None
                } else {
                    billing.paid_until
                },
                price_cents: if billing_hidden {
                    None
                } else {
                    billing.price_cents
                },
                currency: if billing_hidden {
                    None
                } else {
                    billing.currency
                },
                billing_cycle_count: if billing_hidden {
                    None
                } else {
                    billing.billing_cycle_count
                },
                billing_cycle_unit: if billing_hidden {
                    None
                } else {
                    billing.billing_cycle_unit
                },
                billing_cycle: if billing_hidden {
                    None
                } else {
                    billing.billing_cycle
                },
                os_name: server.os_name,
                os_version: server.os_version,
                virt: server.virt,
                arch: server.arch,
                uptime_24h,
                uptime_7d: uptime.and_then(|row| row.uptime_7d),
                buckets_24h,
                outage_minutes_24h,
                first_seen_at,
                inbound_count,
                buckets_7d,
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
        panel_name: settings.panel_name.clone(),
        generated_at: now,
        billing_hidden,
        summary,
        servers,
        groups,
        series,
    };
    let list = serde_json::to_value(response)
        .map_err(|error| AppError::Internal(anyhow::Error::from(error)))?;
    let mut series_by_server = HashMap::with_capacity(series_24h_rows.len());
    for (server_id, value) in series_24h_rows {
        let value = serde_json::to_value(value)
            .map_err(|error| AppError::Internal(anyhow::Error::from(error)))?;
        series_by_server.insert(server_id, value);
    }
    Ok(PublicStatusSnapshot {
        list,
        series: series_by_server,
    })
}

/// 管理端：列出所有服务器及其公开可见性，供白名单面板做批量勾选。
///
/// `GET /api/v1/public-status/servers`，仅管理员。按名称升序，便于前端直接渲染。
pub async fn admin_servers(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let mut servers = repo::servers::list(&state.db.pool).await?;
    // 名称可能重复：再用 id 兜底，保证每次响应顺序稳定。
    servers.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    let items = servers
        .iter()
        .map(|server| {
            json!({
                "id": server.id,
                "name": server.name,
                "online": server.status == "online",
                "public_visible": server.public_visible,
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "items": items })))
}

/// 管理端：用白名单整体替换公开可见集合（仅管理员）。
///
/// body `{ "ids": ["..."] }`：列出的服务器设为可见，其余全部隐藏；空数组 =
/// 全部隐藏。未知 id 整单 400，不做部分成功。审计只记可见/隐藏数量的前后值，
/// 不落完整 id 列表（服务器多时会把审计表撑爆）。
pub async fn replace_servers(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<Value>,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let Some(raw_ids) = body.get("ids").and_then(Value::as_array) else {
        return Err(AppError::coded(
            "public_status.ids_invalid",
            None,
            "ids 必须是字符串数组 / ids must be an array of strings",
        ));
    };
    let mut ids: Vec<String> = Vec::new();
    for item in raw_ids {
        let Some(raw) = item.as_str() else {
            return Err(AppError::coded(
                "public_status.ids_invalid",
                None,
                "ids 必须是字符串数组 / ids must be an array of strings",
            ));
        };
        let id = raw.trim();
        if !ids.iter().any(|existing| existing == id) {
            ids.push(id.to_string());
        }
    }

    let before = repo::servers::list(&state.db.pool).await?;
    let before_visible = before.iter().filter(|server| server.public_visible).count() as i64;
    let before_hidden = before.len() as i64 - before_visible;
    let known: HashSet<&str> = before.iter().map(|server| server.id.as_str()).collect();
    let unknown = ids
        .iter()
        .filter(|id| !known.contains(id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(AppError::coded(
            "public_status.unknown_servers",
            Some(json!({ "ids": unknown })),
            format!(
                "未知的服务器 id：{} / Unknown server id(s): {}",
                unknown.join(", "),
                unknown.join(", ")
            ),
        ));
    }

    let (visible, hidden) = repo::servers::replace_public_visible(&state.db.pool, &ids).await?;
    state.public_status.clear();
    let changes = crate::audit::diff(vec![
        ("visible", json!(before_visible), json!(visible)),
        ("hidden", json!(before_hidden), json!(hidden)),
    ]);
    crate::audit::record(
        &state,
        &user.0,
        "settings.public_status_servers",
        "settings",
        json!({ "changes": changes }),
    )
    .await;
    Ok(Json(json!({ "visible": visible, "hidden": hidden })))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::Router;
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use pierwave_domain::models::Patch;
    use pierwave_domain::repo;
    use pierwave_domain::time;
    use pierwave_domain::Db;

    use super::{day_bucket_dates, first_seen_at, outage_minutes};
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

    /// 详情接口：`GET /api/v1/public/status/{id}`，返回状态码与解析后的 JSON。
    async fn get_detail(app: &Router, id: &str) -> (StatusCode, Value) {
        let (status, body, _) = get(app, &format!("/api/v1/public/status/{id}")).await;
        (status, body)
    }

    /// 管理端请求：带 Cookie，可选 JSON body；返回状态码与解析后的 JSON。
    async fn send(
        app: &Router,
        cookie: Option<&str>,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header("cookie", cookie);
        }
        let body = match body {
            Some(body) => {
                builder = builder.header("content-type", "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        let response = app
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// 带一个管理员与一个普通用户 Cookie 的环境（白名单端点鉴权用）。
    async fn admin_setup() -> (Router, AppState, String, String) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let mut cookies = Vec::new();
        for (username, role, password) in [
            ("admin", "admin", "devpass"),
            ("bob", "user", "password123"),
        ] {
            let user = repo::users::create(
                &db.pool,
                repo::users::NewUser {
                    username: username.into(),
                    password: password.into(),
                    role: role.into(),
                    quota_bytes: None,
                    rule_template_id: None,
                    subscription_template_id: None,
                },
            )
            .await
            .unwrap();
            let (token, _) = repo::sessions::create(&db.pool, &user.id, 3_600, None)
                .await
                .unwrap();
            cookies.push(format!("{}={token}", crate::auth::SESSION_COOKIE));
        }
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        let bob = cookies.pop().unwrap();
        let admin = cookies.pop().unwrap();
        (app, state, admin, bob)
    }

    /// 测试里整组写入费用列（仓储层三态版本的便捷包装）。
    ///
    /// 计费周期按新口径传数量 + 单位，旧列由 [`BillingMeta::derived_legacy_cycle`]
    /// 派生后一起写，模拟真实写路径；需要构造「旧列有值、新列为空」的脏行时
    /// 直接写 SQL。
    async fn set_billing(
        pool: &sqlx::SqlitePool,
        id: &str,
        paid_until: Option<&str>,
        price_cents: Option<i64>,
        currency: Option<&str>,
        billing_cycle_count: Option<i64>,
        billing_cycle_unit: Option<&str>,
    ) -> anyhow::Result<()> {
        let derived = pierwave_domain::billing::BillingMeta::validated(
            None,
            None,
            None,
            billing_cycle_count,
            billing_cycle_unit,
        )?
        .billing_cycle;
        repo::servers::set_billing(
            pool,
            id,
            Patch::Value(paid_until),
            Patch::Value(price_cents),
            Patch::Value(currency),
            Patch::Value(billing_cycle_count),
            Patch::Value(billing_cycle_unit),
            Patch::Value(derived.as_deref()),
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

    /// 在指定服务器上建一个入站节点；`enabled` 控制是否计入 `inbound_count`。
    async fn seed_node(state: &AppState, server_id: &str, tag: &str, enabled: bool) {
        repo::nodes::create(
            &state.db.pool,
            server_id,
            repo::nodes::NewNode {
                tag: Some(tag.into()),
                name: tag.into(),
                protocol: "vless".into(),
                transport: "tcp".into(),
                security: "none".into(),
                port: 443,
                public_port: None,
                config_json: "{}".into(),
                enabled,
                cert_id: None,
                bandwidth_kbps: None,
                tags: Vec::new(),
                region: None,
            },
        )
        .await
        .unwrap();
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

    /// 24h 逐小时趋势固定 24 个桶、3 条等长数组，`t` 升序且步长 3600。
    fn assert_detail_series_shape(series: &Value) {
        assert_eq!(series["window_secs"], 86_400, "{series}");
        assert_eq!(series["step_secs"], 3_600, "{series}");
        let t = series["t"].as_array().unwrap();
        assert_eq!(t.len(), 24, "{series}");
        for pair in t.windows(2) {
            assert_eq!(
                pair[1].as_i64().unwrap() - pair[0].as_i64().unwrap(),
                3_600,
                "桶起点必须升序且步长 3600：{series}"
            );
        }
        for key in ["rate_rx_bps", "rate_tx_bps", "latency_ms"] {
            assert_eq!(
                series[key].as_array().unwrap().len(),
                24,
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

    /// 空数据：中断是 null（不是 0）、7 天桶全 null、24h 趋势全 null、
    /// 入站数量是 0、首次记录来自 `servers.created_at`。
    #[tokio::test]
    async fn detail_fields_are_null_or_zero_without_samples() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];

        assert!(
            server["outage_minutes_24h"].is_null(),
            "没有采样时中断分钟数必须是 null，不能伪造 0：{body}"
        );
        assert_eq!(server["inbound_count"], 0, "{body}");
        let created_at = repo::servers::find_by_id(&state.db.pool, &id)
            .await
            .unwrap()
            .created_at;
        assert_eq!(server["first_seen_at"], created_at, "首次记录取 created_at");

        let generated_at = body["generated_at"].as_i64().unwrap();
        let days = server["buckets_7d"].as_array().unwrap();
        assert_eq!(days.len(), 7, "buckets_7d 必须固定 7 项：{body}");
        let expected_days = day_bucket_dates(generated_at);
        let actual_days: Vec<&str> = days
            .iter()
            .map(|day| day["day"].as_str().unwrap())
            .collect();
        assert_eq!(
            actual_days,
            expected_days.iter().map(String::as_str).collect::<Vec<_>>(),
            "7 个自然日必须升序且以今天结尾：{body}"
        );
        for day in days {
            assert!(
                day["online_ratio"].is_null(),
                "空日子的 online_ratio 必须是 null：{body}"
            );
            assert_eq!(day["samples"], 0, "{body}");
        }

        // 列表不再带趋势；详情接口固定 24 个 null 桶（不是 0）。
        assert!(
            server.get("series_24h").is_none(),
            "列表不能返回 series_24h：{body}"
        );
        let (status, detail) = get_detail(&app, &id).await;
        assert_eq!(status, StatusCode::OK, "{detail}");
        let series = &detail["series_24h"];
        assert_detail_series_shape(series);
        let current = generated_at - generated_at.rem_euclid(3_600);
        assert_eq!(
            series["t"][23].as_i64().unwrap(),
            current,
            "最后一个桶是当前小时：{detail}"
        );
        for key in ["rate_rx_bps", "rate_tx_bps", "latency_ms"] {
            assert!(
                series[key].as_array().unwrap().iter().all(Value::is_null),
                "空数据时 {key} 必须全是 null：{detail}"
            );
        }
    }

    /// 中断分钟数：每条 `online = 0` 的 5 分钟采样算 5 分钟；全程在线是 0，
    /// 与「没有采样」的 null 严格区分。
    #[tokio::test]
    async fn outage_minutes_count_offline_samples_at_five_minute_granularity() {
        let (app, state) = setup().await;
        let a = seed_server(&state, "edge-a", "203.0.113.1").await;
        let b = seed_server(&state, "edge-b", "203.0.113.2").await;
        let now = repo::now();

        // 两台都先在线：B 用作「全程在线 → 0 分钟」的对照。
        repo::servers::mark_online(&state.db.pool, &a)
            .await
            .unwrap();
        repo::servers::mark_online(&state.db.pool, &b)
            .await
            .unwrap();
        repo::server_samples::record_round(&state.db.pool, now)
            .await
            .unwrap();

        // A 连续 3 轮离线，每轮 5 分钟 → 15 分钟。
        repo::servers::mark_offline(&state.db.pool, &a)
            .await
            .unwrap();
        for minutes_ago in [5, 10, 15] {
            repo::server_samples::record_round(&state.db.pool, now - minutes_ago * 60)
                .await
                .unwrap();
        }

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let by_id = |id: &str| -> &Value {
            body["servers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == id)
                .unwrap_or_else(|| panic!("缺少服务器 {id}：{body}"))
        };
        assert_eq!(
            by_id(&a)["outage_minutes_24h"],
            15,
            "3 条离线采样 × 5 分钟 = 15：{body}"
        );
        assert_eq!(
            by_id(&b)["outage_minutes_24h"],
            0,
            "全程在线的服务器必须是 0，而不是 null：{body}"
        );
    }

    /// 7 天桶按 UTC+8 自然日切分：UTC+8 午夜前的 5 分钟落在前一天，午夜的
    /// 那一条落在当天。采样时间戳是 UTC，边界换算不能按 UTC 切。
    #[tokio::test]
    async fn buckets_7d_split_at_utc8_midnight() {
        let (app, state) = setup().await;
        seed_server(&state, "edge-1", "203.0.113.9").await;
        let now = repo::now();
        let today_start = time::business_day_start(time::business_day(now));

        // 昨天 UTC+8 23:55 在线，今天 UTC+8 00:00 离线。
        set_online(&state, true).await;
        repo::server_samples::record_round(&state.db.pool, today_start - 300)
            .await
            .unwrap();
        set_online(&state, false).await;
        repo::server_samples::record_round(&state.db.pool, today_start)
            .await
            .unwrap();

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let days = body["servers"][0]["buckets_7d"].as_array().unwrap();
        assert_eq!(days.len(), 7);

        let today = &days[6];
        assert_eq!(
            today["day"],
            time::business_date(today_start),
            "最后一项是 UTC+8 今天：{body}"
        );
        assert_eq!(today["samples"], 1, "{body}");
        assert_eq!(
            today["online_ratio"], 0.0,
            "UTC+8 午夜那条离线采样必须落在今天：{body}"
        );

        let yesterday = &days[5];
        assert_eq!(
            yesterday["day"],
            time::business_date(today_start - 300),
            "UTC+8 午夜前 5 分钟属于前一天：{body}"
        );
        assert_eq!(yesterday["samples"], 1, "{body}");
        assert_eq!(
            yesterday["online_ratio"], 1.0,
            "前一天 23:55 的在线采样必须留在前一天：{body}"
        );

        // 其余 5 天没有采样：online_ratio 为 null，samples 为 0。
        for day in &days[..5] {
            assert!(day["online_ratio"].is_null(), "{body}");
            assert_eq!(day["samples"], 0, "{body}");
        }
    }

    /// 24h 逐小时趋势：速率取小时均值（跳过 NULL）、延迟四舍五入、空小时是
    /// null 断点；同一个小时内的多条采样必须聚合成一个桶。
    #[tokio::test]
    async fn series_24h_averages_rates_and_latency_with_null_gaps() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;
        let now = repo::now();
        let current_hour = now - now.rem_euclid(3_600);
        let target = current_hour - 3 * 3_600;

        // 目标小时两条采样：1000 / 3000 B/s，延迟 20 / 30 → 均值 2000 / 25。
        repo::servers::mark_online(&state.db.pool, &id)
            .await
            .unwrap();
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(20),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::servers::update_net_counters(&state.db.pool, &id, 0, 0, target - 120)
            .await
            .unwrap();
        repo::servers::update_net_counters(&state.db.pool, &id, 60_000, 60_000, target - 60)
            .await
            .unwrap();
        repo::server_samples::record_round(&state.db.pool, target)
            .await
            .unwrap();

        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(30),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::servers::update_net_counters(&state.db.pool, &id, 240_000, 240_000, target)
            .await
            .unwrap();
        repo::server_samples::record_round(&state.db.pool, target + 300)
            .await
            .unwrap();

        // 当前小时：2000 B/s、延迟 40。
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(40),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::servers::update_net_counters(&state.db.pool, &id, 360_000, 360_000, target + 60)
            .await
            .unwrap();
        repo::server_samples::record_round(&state.db.pool, now)
            .await
            .unwrap();

        let (status, list, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{list}");
        assert!(
            list["servers"][0].get("series_24h").is_none(),
            "列表不能返回逐小时趋势：{list}"
        );
        let (status, body) = get_detail(&app, &id).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let series = &body["series_24h"];
        assert_detail_series_shape(series);
        let t = series["t"].as_array().unwrap();
        assert_eq!(t[23].as_i64().unwrap(), current_hour);
        assert_eq!(t[20].as_i64().unwrap(), target, "目标小时是倒数第 4 个桶");

        assert_eq!(series["rate_rx_bps"][20].as_f64().unwrap(), 2_000.0);
        assert_eq!(series["rate_tx_bps"][20].as_f64().unwrap(), 2_000.0);
        assert_eq!(
            series["latency_ms"][20].as_i64().unwrap(),
            25,
            "20 与 30 的均值四舍五入是 25：{body}"
        );
        assert_eq!(series["rate_rx_bps"][23].as_f64().unwrap(), 2_000.0);
        assert_eq!(series["latency_ms"][23].as_i64().unwrap(), 40);

        for index in (0..24).filter(|index| *index != 20 && *index != 23) {
            for key in ["rate_rx_bps", "rate_tx_bps", "latency_ms"] {
                assert!(
                    series[key][index].is_null(),
                    "第 {index} 个桶的 {key} 没有采样，必须是 null 断点：{body}"
                );
            }
        }
        assert_eq!(list["servers"][0]["outage_minutes_24h"], 0);
    }

    /// 离线采样不参与 `series_24h` 的速率 / 延迟（与全局 `series` 同口径）：
    ///
    /// * 同一小时里「在线 1000 B/s + 离线残留 9000 B/s」→ 该小时仍是 1000；
    /// * 只有离线采样的小时 → 三条序列都是 `null`，不能沿用掉线前的旧值；
    /// * `outage_minutes_24h` 照旧统计 `online = 0`，不受此口径影响。
    #[tokio::test]
    async fn series_24h_ignores_offline_samples_even_with_stale_values() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;
        let now = repo::now();
        let current_hour = now - now.rem_euclid(3_600);
        let mixed_hour = current_hour - 3 * 3_600;
        let offline_only_hour = current_hour - 5 * 3_600;

        // 目标小时先写一条在线采样：1000 B/s、延迟 20ms。
        repo::servers::mark_online(&state.db.pool, &id)
            .await
            .unwrap();
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(20),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::servers::update_net_counters(&state.db.pool, &id, 0, 0, mixed_hour - 120)
            .await
            .unwrap();
        repo::servers::update_net_counters(&state.db.pool, &id, 60_000, 60_000, mixed_hour - 60)
            .await
            .unwrap();
        repo::server_samples::record_round(&state.db.pool, mixed_hour)
            .await
            .unwrap();

        // 掉线后同一小时再写一条：`record_round` 会把掉线前的 9000 B/s / 90ms
        // 残留值一起抄进采样行（online = 0）。注意 `update_health` 会把状态改回
        // online，所以先写健康值，最后再标离线。
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(90),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::servers::update_net_counters(&state.db.pool, &id, 600_000, 600_000, mixed_hour)
            .await
            .unwrap();
        repo::servers::mark_offline(&state.db.pool, &id)
            .await
            .unwrap();
        repo::server_samples::record_round(&state.db.pool, mixed_hour + 300)
            .await
            .unwrap();
        // 另一个小时只有这一条离线采样。
        repo::server_samples::record_round(&state.db.pool, offline_only_hour)
            .await
            .unwrap();

        // 前提确认：离线采样行确实带着非 NULL 的残留速率与延迟。
        let samples = repo::server_samples::list(&state.db.pool, &id, offline_only_hour)
            .await
            .unwrap();
        let stale = samples
            .iter()
            .find(|sample| sample.ts == mixed_hour + 300)
            .expect("离线采样应已落库");
        assert!(!stale.online, "这一行必须是离线采样：{stale:?}");
        assert!(
            stale.rx_bps.is_some() && stale.latency_ms.is_some(),
            "测试前提：离线行带着掉线前的残留值：{stale:?}"
        );

        let (status, list, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{list}");
        let (status, body) = get_detail(&app, &id).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let series = &body["series_24h"];
        assert_detail_series_shape(series);
        let t = series["t"].as_array().unwrap();
        assert_eq!(t[20].as_i64().unwrap(), mixed_hour);
        assert_eq!(t[18].as_i64().unwrap(), offline_only_hour);

        // 混合小时：离线残留值被排除，只剩在线采样的 1000 B/s / 20ms。
        assert_eq!(
            series["rate_rx_bps"][20].as_f64().unwrap(),
            1_000.0,
            "离线采样的 9000 B/s 不能拉高该小时均值：{body}"
        );
        assert_eq!(series["rate_tx_bps"][20].as_f64().unwrap(), 1_000.0);
        assert_eq!(
            series["latency_ms"][20].as_i64().unwrap(),
            20,
            "离线采样的 90ms 不能进入延迟均值：{body}"
        );

        // 只有离线采样的小时：整个桶是 null 断点，不能沿用 9000 B/s / 90ms。
        for key in ["rate_rx_bps", "rate_tx_bps", "latency_ms"] {
            assert!(
                series[key][18].is_null(),
                "只有离线采样的小时 {key} 必须是 null，不能沿用旧值：{body}"
            );
        }

        // 中断口径不变：两条离线采样 × 5 分钟。
        assert_eq!(list["servers"][0]["outage_minutes_24h"], 10);
    }

    /// 旧 Agent 的采样没有速率 / 延迟（落库是 NULL）：24h 趋势必须是 null，
    /// 不能是 0；中断计数仍是 0（采样存在且在线）。
    #[tokio::test]
    async fn old_agent_keeps_series_24h_null_not_zero() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;
        repo::servers::mark_online(&state.db.pool, &id)
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
        repo::server_samples::record_round(&state.db.pool, repo::now())
            .await
            .unwrap();

        let (status, list, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{list}");
        let (status, body) = get_detail(&app, &id).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let series = &body["series_24h"];
        assert_detail_series_shape(series);
        for key in ["rate_rx_bps", "rate_tx_bps", "latency_ms"] {
            for value in series[key].as_array().unwrap() {
                assert!(
                    value.is_null(),
                    "旧 Agent 没有 {key} 数据时必须返回 null，不能写 0：{body}"
                );
            }
        }
        // 有采样且在线：中断是 0（不是 null），可与旧 Agent 的 null 趋势区分。
        assert_eq!(list["servers"][0]["outage_minutes_24h"], 0);
        // 当天的可用率来自同一条采样：1.0 / 1 条。
        let today = &list["servers"][0]["buckets_7d"][6];
        assert_eq!(today["online_ratio"], 1.0, "{list}");
        assert_eq!(today["samples"], 1, "{list}");
    }

    /// `inbound_count` 只数 `enabled = 1` 的节点，按服务器分别计数；
    /// 入站的 tag / 协议 / 端口不能出现在公开响应里。
    #[tokio::test]
    async fn inbound_count_counts_only_enabled_nodes_per_server() {
        let (app, state) = setup().await;
        let a = seed_server(&state, "edge-a", "203.0.113.1").await;
        let b = seed_server(&state, "edge-b", "203.0.113.2").await;

        seed_node(&state, &a, "a-enabled-1", true).await;
        seed_node(&state, &a, "a-enabled-2", true).await;
        seed_node(&state, &a, "a-disabled", false).await;
        seed_node(&state, &b, "b-enabled-1", true).await;

        let (status, body, raw) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let by_id = |id: &str| -> &Value {
            body["servers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["id"] == id)
                .unwrap_or_else(|| panic!("缺少服务器 {id}：{body}"))
        };
        assert_eq!(by_id(&a)["inbound_count"], 2, "停用节点不计入：{body}");
        assert_eq!(by_id(&b)["inbound_count"], 1, "{body}");
        assert!(
            !raw.contains("a-enabled-1") && !raw.contains("vless"),
            "公开响应不应出现入站 tag / 协议：{raw}"
        );
    }

    /// 30 秒缓存：命中缓存的 5 个新增字段与首次响应完全一致（含 null 缺口）。
    #[tokio::test]
    async fn detail_fields_are_cached_with_the_same_shape() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;

        let (_, first, _) = get(&app, "/api/v1/public/status").await;
        assert!(first["servers"][0]["outage_minutes_24h"].is_null());
        let (status, first_detail) = get_detail(&app, &id).await;
        assert_eq!(status, StatusCode::OK, "{first_detail}");
        assert!(
            first_detail["series_24h"]["latency_ms"]
                .as_array()
                .unwrap()
                .iter()
                .all(Value::is_null),
            "首次详情的趋势必须全是 null 缺口：{first_detail}"
        );

        // 缓存期内建节点 + 写采样：列表与详情命中同一份缓存，必须原样返回首次结果。
        seed_node(&state, &id, "edge-vless", true).await;
        // 先写一条离线采样（服务器默认离线）：清缓存后 `outage_minutes_24h = 5`。
        repo::server_samples::record_round(&state.db.pool, repo::now() - 600)
            .await
            .unwrap();
        // 再上线并写当前小时：详情趋势拿到 33ms。
        repo::servers::update_health(
            &state.db.pool,
            &id,
            "0.1.0",
            &repo::servers::HealthSnapshot {
                latency_ms: Some(33),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        repo::server_samples::record_round(&state.db.pool, repo::now())
            .await
            .unwrap();
        let (_, cached, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(cached["generated_at"], first["generated_at"]);
        for key in [
            "outage_minutes_24h",
            "first_seen_at",
            "inbound_count",
            "buckets_7d",
        ] {
            assert_eq!(
                cached["servers"][0][key], first["servers"][0][key],
                "缓存命中时 {key} 必须与首次响应一致"
            );
        }
        let (status, cached_detail) = get_detail(&app, &id).await;
        assert_eq!(status, StatusCode::OK, "{cached_detail}");
        assert_eq!(
            cached_detail, first_detail,
            "详情与列表共用 30 秒缓存：命中时必须与首次响应完全一致"
        );
        assert_eq!(
            cached_detail["server"], cached["servers"][0],
            "详情的 server 必须与列表行同形同值"
        );

        // 清缓存后读到新数据：离线采样 5 分钟、入站 1 个、趋势拿到 33ms。
        state.public_status.clear();
        let (_, fresh, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(fresh["servers"][0]["outage_minutes_24h"], 5);
        assert_eq!(fresh["servers"][0]["inbound_count"], 1);
        let (_, fresh_detail) = get_detail(&app, &id).await;
        assert!(
            fresh_detail["series_24h"]["latency_ms"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value.as_i64() == Some(33)),
            "清缓存后详情必须读到新采样：{fresh_detail}"
        );
    }

    /// `first_seen_at`：0 / 负数（未知或手工改库）输出 null，不编造 1970 时间。
    #[test]
    fn first_seen_at_treats_unknown_timestamps_as_null() {
        assert_eq!(first_seen_at(0), None);
        assert_eq!(first_seen_at(-1), None);
        assert_eq!(first_seen_at(1_763_000_000), Some(1_763_000_000));
    }

    /// 7 个自然日桶的日期按 UTC+8 切分，升序且以今天结尾。
    #[test]
    fn day_bucket_dates_are_seven_utc8_days_ending_today() {
        // 2024-01-01 16:00:00 UTC = 2024-01-02 00:00:00 UTC+8
        let days = day_bucket_dates(1_704_067_200 + 16 * 3_600);
        assert_eq!(days.len(), 7);
        assert_eq!(days[6], "2024-01-02");
        assert_eq!(days[0], "2023-12-27");
        // UTC 2024-01-01 15:59:59 仍属于 UTC+8 的 2024-01-01。
        let just_before = day_bucket_dates(1_704_067_200 + 16 * 3_600 - 1);
        assert_eq!(just_before[6], "2024-01-01");
    }

    /// 每条离线采样固定代表 5 分钟。
    #[test]
    fn outage_minutes_are_five_minutes_per_sample() {
        assert_eq!(outage_minutes(0), 0);
        assert_eq!(outage_minutes(1), 5);
        assert_eq!(outage_minutes(36), 180);
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
            "billing_cycle_count",
            "billing_cycle_unit",
            "billing_cycle",
            "os_name",
            "os_version",
            "virt",
            "arch",
            "uptime_24h",
            "uptime_7d",
            "buckets_24h",
            "outage_minutes_24h",
            "first_seen_at",
            "inbound_count",
            "buckets_7d",
        ];
        expected.sort_unstable();
        let mut actual = server_keys.clone();
        actual.sort_unstable();
        assert_eq!(actual, expected, "服务器行必须严格是白名单字段");
        assert_eq!(body["summary"]["nodes_total"], 1);

        // 新增的嵌套结构也必须是白名单：数量 + 趋势，不带任何拓扑细节。
        let mut daily_keys: Vec<&str> = body["servers"][0]["buckets_7d"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        daily_keys.sort_unstable();
        assert_eq!(
            daily_keys,
            vec!["day", "online_ratio", "samples"],
            "buckets_7d 只能暴露日期、可用率与样本数"
        );

        // 趋势只在详情接口出现；它的字段同样必须是白名单。
        assert!(
            body["servers"][0].get("series_24h").is_none(),
            "列表不能返回 series_24h：{body}"
        );
        let (status, detail) = get_detail(&app, &server_id).await;
        assert_eq!(status, StatusCode::OK, "{detail}");
        assert!(
            !detail.to_string().contains("203.0.113.9"),
            "详情响应不应包含服务器地址：{detail}"
        );
        assert_no_forbidden_keys(&detail);
        let mut detail_keys: Vec<&str> = detail["series_24h"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        detail_keys.sort_unstable();
        assert_eq!(
            detail_keys,
            vec![
                "latency_ms",
                "rate_rx_bps",
                "rate_tx_bps",
                "step_secs",
                "t",
                "window_secs",
            ],
            "series_24h 字段必须是白名单"
        );

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

    /// 详情接口的 404 语义：未知 id、被隐藏的服务器、页面关闭，三者互不混淆。
    ///
    /// 「被隐藏」必须与「不存在」返回**完全一样的** 404：否则读者可以用详情
    /// 接口枚举出隐藏服务器的 id，白名单就形同虚设。
    #[tokio::test]
    async fn detail_returns_404_for_unknown_and_hidden_servers() {
        let (app, state) = setup().await;
        let visible = seed_server(&state, "edge-1", "203.0.113.9").await;
        let hidden = seed_server(&state, "edge-2", "203.0.113.10").await;
        repo::servers::set_public_visible(&state.db.pool, &hidden, false)
            .await
            .unwrap();

        // 可见服务器：`server`（与列表同形）+ 顶层 `series_24h`。
        let (status, body) = get_detail(&app, &visible).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["server"]["id"], visible.as_str(), "{body}");
        assert!(body["series_24h"].is_object(), "{body}");
        assert_eq!(body["series_24h"]["window_secs"], 86_400, "{body}");

        // 未知 id：404 + public_status.not_found + params.id。
        let (status, body) = get_detail(&app, "does-not-exist").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["code"], "public_status.not_found", "{body}");
        assert_eq!(body["params"]["id"], "does-not-exist", "{body}");

        // 被隐藏的服务器：与未知 id 同一个错误码与形状，不泄漏它存在。
        let (status, hidden_body) = get_detail(&app, &hidden).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{hidden_body}");
        assert_eq!(
            hidden_body["code"], "public_status.not_found",
            "{hidden_body}"
        );
        assert_eq!(
            hidden_body["params"]["id"],
            hidden.as_str(),
            "{hidden_body}"
        );
        assert!(
            !hidden_body.to_string().contains("edge-2"),
            "404 不能回显被隐藏服务器的名字：{hidden_body}"
        );

        // 页面关闭：与 id 是否存在无关，统一 public_status.disabled。
        repo::settings::set(&state.db.pool, "public_status_enabled", "0")
            .await
            .unwrap();
        for id in [&visible, &hidden, "does-not-exist"] {
            let (status, body) = get_detail(&app, id).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
            assert_eq!(body["code"], "public_status.disabled", "{body}");
        }
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
        for key in [
            "paid_until",
            "price_cents",
            "currency",
            "billing_cycle_count",
            "billing_cycle_unit",
            "billing_cycle",
        ] {
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
            Some(1),
            Some("month"),
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
        sqlx::query(
            "UPDATE servers
                SET paid_until = '2026-02-30',
                    price_cents = -1,
                    currency = 'cny',
                    billing_cycle_count = 0,
                    billing_cycle_unit = 'week',
                    billing_cycle = 'weekly'
              WHERE id = ?",
        )
        .bind(&id)
        .execute(&state.db.pool)
        .await
        .unwrap();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        for key in [
            "paid_until",
            "price_cents",
            "currency",
            "billing_cycle_count",
            "billing_cycle_unit",
            "billing_cycle",
        ] {
            assert!(server[key].is_null(), "{key} 的脏值必须降级为 null：{body}");
        }

        // 混合：价格非法、币种合法。价格与币种是成对的，读路径整体降级，
        // 不能只展示「EUR」却没有金额。
        state.public_status.clear();
        set_billing(
            &state.db.pool,
            &id,
            None,
            Some(1_000_000_000),
            Some("EUR"),
            None,
            None,
        )
        .await
        .unwrap();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let server = &body["servers"][0];
        assert!(server["paid_until"].is_null(), "{body}");
        assert!(server["price_cents"].is_null(), "{body}");
        assert!(
            server["currency"].is_null(),
            "价格与币种必须整组成对降级：{body}"
        );
        assert!(server["billing_cycle"].is_null(), "{body}");
    }

    /// 公开页同样返回「数量 + 单位」，旧列 `billing_cycle` 保持旧语义：
    /// 1 个月 → monthly；3 个月 → null（没有对应旧值）。
    #[tokio::test]
    async fn public_status_returns_cycle_pair_and_derives_the_legacy_field() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-cycle", "203.0.113.9").await;
        set_billing(
            &state.db.pool,
            &id,
            None,
            None,
            None,
            Some(3),
            Some("month"),
        )
        .await
        .unwrap();

        let (status, body, raw) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{raw}");
        let server = &body["servers"][0];
        assert_eq!(server["billing_cycle_count"], 3, "{body}");
        assert_eq!(server["billing_cycle_unit"], "month", "{body}");
        assert!(
            server["billing_cycle"].is_null(),
            "3 个月没有旧值对应，必须是 null：{body}"
        );

        // 旧数据：库里只有旧列（新列为空）时公开页仍按 1 个对应单位展示，
        // 不能因为升级后新列为空就把「年付」变成「未填写」。
        sqlx::query(
            "UPDATE servers
                SET billing_cycle_count = NULL,
                    billing_cycle_unit = NULL,
                    billing_cycle = 'yearly'
              WHERE id = ?",
        )
        .bind(&id)
        .execute(&state.db.pool)
        .await
        .unwrap();
        state.public_status.clear();
        let (status, body, raw) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{raw}");
        let server = &body["servers"][0];
        assert_eq!(server["billing_cycle_count"], 1, "{body}");
        assert_eq!(server["billing_cycle_unit"], "year", "{body}");
        assert_eq!(server["billing_cycle"], "yearly", "{body}");

        // 隐藏时三个字段一起为 null（与其它费用字段同口径）。
        repo::settings::set(&state.db.pool, "public_billing_visible", "0")
            .await
            .unwrap();
        state.public_status.clear();
        let (status, body, raw) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{raw}");
        assert_eq!(body["billing_hidden"], true, "{body}");
        for key in [
            "paid_until",
            "price_cents",
            "currency",
            "billing_cycle_count",
            "billing_cycle_unit",
            "billing_cycle",
        ] {
            assert!(body["servers"][0][key].is_null(), "{key} 必须隐藏：{body}");
        }
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
        // 仓储层的 `Server` 现在包含 0064 的 `public_visible`；本测试只关心
        // 费用列的修复，先把这一列补上，否则 `repo::servers::create` 读不回行。
        let visibility = MIGRATOR
            .iter()
            .find(|migration| migration.version == 64)
            .expect("必须存在 0064 公开可见性迁移");
        sqlx::raw_sql(&visibility.sql)
            .execute(&db.pool)
            .await
            .unwrap();
        // `Server` 还包含 0067 的两个计费周期列；本测试的迁移脚本只修旧列，
        // 先把列加上，否则 `repo::servers::create` 读不回行。
        let cycle = MIGRATOR
            .iter()
            .find(|migration| migration.version == 67)
            .expect("必须存在 0067 计费周期数量 + 单位迁移");
        sqlx::raw_sql(&cycle.sql).execute(&db.pool).await.unwrap();

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
            Some(1),
            Some("month"),
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

        // 公开页：200，脏行的费用字段全部降级为 null，合法行原样保留。
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
            for key in [
                "paid_until",
                "price_cents",
                "currency",
                "billing_cycle_count",
                "billing_cycle_unit",
                "billing_cycle",
            ] {
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
            for key in [
                "paid_until",
                "price_cents",
                "currency",
                "billing_cycle_count",
                "billing_cycle_unit",
                "billing_cycle",
            ] {
                assert!(
                    by_name(name)[key].is_null(),
                    "{name}.{key} 的脏值必须被迁移清成 NULL：{body}"
                );
            }
        }
        assert_eq!(by_name("edge-clean")["price_cents"], 4999, "{body}");
    }

    /// 迁移 0065：历史「只有价格没币种」/「只有币种没价格」的行。
    ///
    /// 0061 的四列没有成对约束，0062 只修类型 / 值域，也不管成对。单边行会让
    /// 公开页显示「有价格没币种」或「有币种没价格」——读者既没法理解也没法
    /// 校验。0065 把单边行整组清成 NULL，成对行原样保留，并且可以重复执行。
    #[tokio::test]
    async fn migration_0065_clears_unpaired_billing_rows() {
        use pierwave_domain::{Db, MIGRATOR};

        let db = Db::connect("sqlite::memory:").await.unwrap();
        // 停在 0064：模拟「库里还留着历史单边行」的升级现场。
        for migration in MIGRATOR.iter().filter(|m| m.version <= 64) {
            sqlx::raw_sql(&migration.sql)
                .execute(&db.pool)
                .await
                .unwrap_or_else(|error| panic!("执行迁移 {} 失败：{error}", migration.version));
        }
        // `Server` 还包含 0067 的两个计费周期列，创建行前必须先加列。
        let cycle = MIGRATOR
            .iter()
            .find(|migration| migration.version == 67)
            .expect("必须存在 0067 计费周期数量 + 单位迁移");
        sqlx::raw_sql(&cycle.sql).execute(&db.pool).await.unwrap();

        let (price_only, _) =
            repo::servers::create(&db.pool, "price-only", "203.0.113.1", "external")
                .await
                .unwrap();
        let (currency_only, _) =
            repo::servers::create(&db.pool, "currency-only", "203.0.113.2", "external")
                .await
                .unwrap();
        let (paired, _) = repo::servers::create(&db.pool, "paired", "203.0.113.3", "external")
            .await
            .unwrap();
        repo::servers::create(&db.pool, "neither", "203.0.113.4", "external")
            .await
            .unwrap();

        // 写路径会拒绝单边组合（`server.billing_pair_incomplete`），所以这里用
        // 直写 SQL 模拟旧版本 / 手工改库留下的历史行。到期日与周期是另外两列，
        // 迁移 0065 不能顺手把它们也清掉。
        sqlx::query(
            "UPDATE servers SET price_cents = 4999, paid_until = '2026-06-30',
                    billing_cycle = 'yearly'
              WHERE id = ?",
        )
        .bind(&price_only.id)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query("UPDATE servers SET currency = 'CNY' WHERE id = ?")
            .bind(&currency_only.id)
            .execute(&db.pool)
            .await
            .unwrap();
        set_billing(
            &db.pool,
            &paired.id,
            Some("2026-12-31"),
            Some(4999),
            Some("CNY"),
            Some(1),
            Some("month"),
        )
        .await
        .unwrap();

        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        let by_name = |body: &Value, name: &str| -> Value {
            body["servers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|row| row["name"] == name)
                .unwrap_or_else(|| panic!("公开页缺少服务器 {name}：{body}"))
                .clone()
        };

        // 读路径（B16）对半对行整组降级：即使 0065 还没跑，公开页也不会暴露
        // 「只有价格」或「只有币种」的半对行；库里的脏值仍在，由迁移清理。
        let (status, body, raw) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{raw}");
        let before_price_only = by_name(&body, "price-only");
        assert!(before_price_only["price_cents"].is_null(), "{body}");
        assert!(before_price_only["currency"].is_null(), "{body}");
        let before_currency_only = by_name(&body, "currency-only");
        assert!(before_currency_only["price_cents"].is_null(), "{body}");
        assert!(before_currency_only["currency"].is_null(), "{body}");
        let raw_price: Option<i64> =
            sqlx::query_scalar("SELECT price_cents FROM servers WHERE id = ?")
                .bind(&price_only.id)
                .fetch_one(&state.db.pool)
                .await
                .unwrap();
        assert_eq!(raw_price, Some(4999), "迁移前库里的半对行仍然存在");

        // 修复：单边行整组清空；重复执行一次验证幂等。
        let migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == 65)
            .expect("必须存在 0065 费用成对修复迁移");
        for _ in 0..2 {
            sqlx::raw_sql(&migration.sql)
                .execute(&state.db.pool)
                .await
                .unwrap();
        }
        state.public_status.clear();

        let (status, body, raw) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{raw}");
        for name in ["price-only", "currency-only"] {
            let row = by_name(&body, name);
            assert!(row["price_cents"].is_null(), "{name}: {body}");
            assert!(row["currency"].is_null(), "{name}: {body}");
        }
        let cleared_price: Option<i64> =
            sqlx::query_scalar("SELECT price_cents FROM servers WHERE id = ?")
                .bind(&price_only.id)
                .fetch_one(&state.db.pool)
                .await
                .unwrap();
        assert!(cleared_price.is_none(), "迁移后 price_cents 必须清空");
        let cleared_currency: Option<String> =
            sqlx::query_scalar("SELECT currency FROM servers WHERE id = ?")
                .bind(&currency_only.id)
                .fetch_one(&state.db.pool)
                .await
                .unwrap();
        assert!(cleared_currency.is_none(), "迁移后 currency 必须清空");
        // 只清价格与币种，同行的到期日 / 周期不受影响。
        let price_only = by_name(&body, "price-only");
        assert_eq!(price_only["paid_until"], "2026-06-30", "{body}");
        assert_eq!(price_only["billing_cycle"], "yearly", "{body}");

        // 成对的行原样保留；两列都为空的行保持为空。
        let paired_row = by_name(&body, "paired");
        assert_eq!(paired_row["price_cents"], 4999, "{body}");
        assert_eq!(paired_row["currency"], "CNY", "{body}");
        assert_eq!(paired_row["paid_until"], "2026-12-31", "{body}");
        assert_eq!(paired_row["billing_cycle"], "monthly", "{body}");
        let neither_row = by_name(&body, "neither");
        assert!(neither_row["price_cents"].is_null(), "{body}");
        assert!(neither_row["currency"].is_null(), "{body}");
    }

    // ---- 公开状态页白名单 / 费用可见性（0064） ----

    /// 默认公开：没有设置 `public_billing_visible` 时 `billing_hidden = false`，
    /// 费用字段照常返回；设为 "0" 后所有费用字段 null 且 `billing_hidden = true`。
    #[tokio::test]
    async fn billing_visibility_hides_four_fields_and_sets_billing_hidden() {
        let (app, state) = setup().await;
        let id = seed_server(&state, "edge-1", "203.0.113.9").await;
        set_billing(
            &state.db.pool,
            &id,
            Some("2026-12-31"),
            Some(4999),
            Some("CNY"),
            Some(1),
            Some("month"),
        )
        .await
        .unwrap();

        // 兼容旧行为：没有这个键 = 公开。
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["billing_hidden"], false, "{body}");
        assert_eq!(body["servers"][0]["price_cents"], 4999, "{body}");

        // 隐藏：费用字段全部 null，billing_hidden 明确告诉读者「不是没配置」。
        repo::settings::set(&state.db.pool, "public_billing_visible", "0")
            .await
            .unwrap();
        state.public_status.clear();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["billing_hidden"], true, "{body}");
        for key in [
            "paid_until",
            "price_cents",
            "currency",
            "billing_cycle_count",
            "billing_cycle_unit",
            "billing_cycle",
        ] {
            assert!(body["servers"][0][key].is_null(), "{key} 必须隐藏：{body}");
        }

        // 改回公开：字段恢复，标记为 false。
        repo::settings::set(&state.db.pool, "public_billing_visible", "1")
            .await
            .unwrap();
        state.public_status.clear();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["billing_hidden"], false, "{body}");
        assert_eq!(body["servers"][0]["paid_until"], "2026-12-31", "{body}");
        assert_eq!(body["servers"][0]["price_cents"], 4999, "{body}");
        assert_eq!(body["servers"][0]["currency"], "CNY", "{body}");
        assert_eq!(body["servers"][0]["billing_cycle_count"], 1, "{body}");
        assert_eq!(body["servers"][0]["billing_cycle_unit"], "month", "{body}");
        assert_eq!(body["servers"][0]["billing_cycle"], "monthly", "{body}");
    }

    /// 白名单必须同时作用于 servers / groups / summary / series，不能只藏列表：
    /// 隐藏服务器的分组计数、汇总数字与全站速率都不能泄漏它的存在。
    #[tokio::test]
    async fn hidden_server_disappears_from_servers_groups_summary_and_series() {
        let (app, state) = setup().await;
        let a = seed_grouped_server(&state, "a-1", "203.0.113.1", Some("shared")).await;
        let b = seed_grouped_server(&state, "b-1", "203.0.113.2", Some("shared")).await;
        let c = seed_grouped_server(&state, "c-1", "203.0.113.3", Some("other")).await;
        for (id, tag) in [(&a, "a"), (&b, "b"), (&c, "c")] {
            seed_node(&state, id, tag, true).await;
            repo::servers::mark_online(&state.db.pool, id)
                .await
                .unwrap();
        }
        repo::servers::set_public_visible(&state.db.pool, &b, false)
            .await
            .unwrap();

        // 可见服务器 1000 B/s，隐藏服务器 5000 B/s：全站汇总只能算可见的。
        let now = repo::now();
        let current = now - now.rem_euclid(300);
        for (id, rx_per_sec, tx_per_sec) in [(&a, 1_000, 500), (&b, 5_000, 2_500)] {
            repo::servers::update_net_counters(
                &state.db.pool,
                id,
                1_000,
                2_000,
                current.saturating_sub(60),
            )
            .await
            .unwrap();
            repo::servers::update_net_counters(
                &state.db.pool,
                id,
                1_000 + rx_per_sec * 60,
                2_000 + tx_per_sec * 60,
                current,
            )
            .await
            .unwrap();
        }
        repo::server_samples::record_round(&state.db.pool, now)
            .await
            .unwrap();

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let ids: Vec<&str> = body["servers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 2, "只返回可见服务器：{body}");
        assert!(
            ids.contains(&a.as_str()) && ids.contains(&c.as_str()),
            "{body}"
        );
        assert!(!ids.contains(&b.as_str()), "隐藏服务器不能出现：{body}");

        // groups：shared 组从 2 台变 1 台，不能出现「组里 2 台、列表 1 台」。
        let groups = body["groups"].as_array().unwrap();
        let shared = groups
            .iter()
            .find(|group| group["name"] == "shared")
            .unwrap();
        assert_eq!(shared["servers"], 1, "分组计数只算可见服务器：{body}");
        assert_eq!(shared["online"], 1, "{body}");
        let other = groups
            .iter()
            .find(|group| group["name"] == "other")
            .unwrap();
        assert_eq!(other["servers"], 1, "{body}");

        // summary：服务器数 / 在线数 / 节点数都按可见集合重算。
        assert_eq!(body["summary"]["servers_total"], 2, "{body}");
        assert_eq!(body["summary"]["servers_online"], 2, "{body}");
        assert_eq!(
            body["summary"]["nodes_total"], 2,
            "隐藏服务器的节点不能再计入：{body}"
        );

        // series：隐藏服务器的速率不能进入全站汇总（1000，不是 6000）。
        assert_eq!(body["series"]["rate_rx_bps"][11], 1_000.0, "{body}");
        assert_eq!(body["series"]["rate_tx_bps"][11], 500.0, "{body}");

        // 隐藏到一台不剩：列表、分组、汇总都为「空」，不是报错。
        repo::servers::set_public_visible(&state.db.pool, &a, false)
            .await
            .unwrap();
        repo::servers::set_public_visible(&state.db.pool, &c, false)
            .await
            .unwrap();
        state.public_status.clear();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["servers"].as_array().unwrap().len(), 0, "{body}");
        assert_eq!(body["groups"].as_array().unwrap().len(), 0, "{body}");
        assert_eq!(body["summary"]["servers_total"], 0, "{body}");
        assert_eq!(body["summary"]["nodes_total"], 0, "{body}");
        assert!(
            body["series"]["rate_rx_bps"]
                .as_array()
                .unwrap()
                .iter()
                .all(Value::is_null),
            "没有任何可见服务器时 series 必须是 null：{body}"
        );
    }

    /// `summary.traffic_today` / `traffic_month` 是**账号级流量**：白名单隐藏
    /// 服务器只影响服务器清单 / 分组 / 全站速率，**不会**让这两个数字变小。
    ///
    /// 这条口径写进了 `docs/PUBLIC-STATUS.md`，用测试钉住，防止有人把它「顺手
    /// 修成」只算可见服务器——那会让管理员一隐藏服务器，历史总量就突然变小。
    #[tokio::test]
    async fn traffic_totals_are_account_level_and_ignore_the_whitelist() {
        let (app, state) = setup().await;
        let visible = seed_server(&state, "edge-visible", "203.0.113.1").await;
        let hidden = seed_server(&state, "edge-hidden", "203.0.113.2").await;
        let today = time::business_date(repo::now());

        repo::traffic::accumulate_daily(&state.db.pool, &today, &visible, "alice", 10, 10, 100)
            .await
            .unwrap();
        repo::traffic::accumulate_daily(&state.db.pool, &today, &hidden, "bob", 10, 10, 200)
            .await
            .unwrap();

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["summary"]["servers_total"], 2, "{body}");
        assert_eq!(body["summary"]["traffic_today"], 300, "{body}");
        assert_eq!(body["summary"]["traffic_month"], 300, "{body}");

        // 隐藏其中一台：清单变小，但账号级流量保持 300。
        repo::servers::set_public_visible(&state.db.pool, &hidden, false)
            .await
            .unwrap();
        state.public_status.clear();
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["summary"]["servers_total"], 1, "{body}");
        assert!(
            !body["servers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["id"] == hidden.as_str()),
            "隐藏的服务器不能出现在列表里：{body}"
        );
        assert_eq!(
            body["summary"]["traffic_today"], 300,
            "账号级流量不能因为隐藏服务器而变小：{body}"
        );
        assert_eq!(
            body["summary"]["traffic_month"], 300,
            "账号级流量不能因为隐藏服务器而变小：{body}"
        );
    }

    /// 白名单批量端点：往返、空数组全部隐藏、未知 id 整单 400、非管理员 403、
    /// 审计只记数量前后值（不落 id 列表）。
    #[tokio::test]
    async fn public_status_servers_endpoint_round_trips_and_validates() {
        let (app, state, admin, bob) = admin_setup().await;
        let a = seed_grouped_server(&state, "a-1", "203.0.113.1", Some("g")).await;
        let b = seed_grouped_server(&state, "b-1", "203.0.113.2", None).await;
        repo::servers::mark_online(&state.db.pool, &a)
            .await
            .unwrap();

        // GET：按名称升序，字段形状固定，默认全部可见。
        let (status, body) = send(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/public-status/servers",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let items = body["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "{body}");
        assert_eq!(items[0]["name"], "a-1", "{body}");
        assert_eq!(items[0]["id"], a, "{body}");
        assert_eq!(items[0]["online"], true, "{body}");
        assert_eq!(items[0]["public_visible"], true, "{body}");
        assert_eq!(items[1]["name"], "b-1", "{body}");
        assert_eq!(items[1]["online"], false, "{body}");

        // PUT：只放开 a-1 → b-1 隐藏。
        let (status, body) = send(
            &app,
            Some(&admin),
            Method::PUT,
            "/api/v1/public-status/servers",
            Some(json!({ "ids": [a] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({ "visible": 1, "hidden": 1 }), "{body}");

        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["servers"].as_array().unwrap().len(), 1, "{body}");
        assert_eq!(body["servers"][0]["id"], a, "{body}");

        // 审计：只记可见 / 隐藏数量的前后值，不落完整 id 列表。
        let page = repo::audit::page(
            &state.db.pool,
            &repo::audit::Filter {
                action_prefixes: vec!["settings.public_status_servers".into()],
                ..Default::default()
            },
            None,
            10,
        )
        .await
        .unwrap();
        assert_eq!(page.items.len(), 1, "白名单变更必须写审计");
        let detail = page.items[0].detail.as_ref().unwrap();
        assert_eq!(detail["changes"]["visible"]["from"], 2, "{detail}");
        assert_eq!(detail["changes"]["visible"]["to"], 1, "{detail}");
        assert_eq!(detail["changes"]["hidden"]["from"], 0, "{detail}");
        assert_eq!(detail["changes"]["hidden"]["to"], 1, "{detail}");
        let rendered = detail.to_string();
        assert!(
            !rendered.contains(&a) && !rendered.contains(&b),
            "审计不能记录 id 列表：{rendered}"
        );

        // 空数组 = 全部隐藏。
        let (status, body) = send(
            &app,
            Some(&admin),
            Method::PUT,
            "/api/v1/public-status/servers",
            Some(json!({ "ids": [] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({ "visible": 0, "hidden": 2 }), "{body}");
        let (status, body, _) = get(&app, "/api/v1/public/status").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["servers"].as_array().unwrap().len(), 0, "{body}");

        // 未知 id：整单 400，且不做部分成功（a-1 仍然隐藏）。
        let (status, body) = send(
            &app,
            Some(&admin),
            Method::PUT,
            "/api/v1/public-status/servers",
            Some(json!({ "ids": [a, "does-not-exist"] })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "public_status.unknown_servers", "{body}");
        assert_eq!(body["params"]["ids"], json!(["does-not-exist"]), "{body}");
        let (_, body) = send(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/public-status/servers",
            None,
        )
        .await;
        assert!(
            body["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["public_visible"] == false),
            "未知 id 的请求不能部分生效：{body}"
        );

        // 非管理员：GET / PUT 都是 403，且不改数据。
        for (method, payload) in [
            (Method::GET, None),
            (Method::PUT, Some(json!({ "ids": [a, b] }))),
        ] {
            let (status, body) = send(
                &app,
                Some(&bob),
                method,
                "/api/v1/public-status/servers",
                payload,
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        }
        let (_, body) = send(
            &app,
            Some(&admin),
            Method::GET,
            "/api/v1/public-status/servers",
            None,
        )
        .await;
        assert!(
            body["items"]
                .as_array()
                .unwrap()
                .iter()
                .all(|item| item["public_visible"] == false),
            "非管理员不能改白名单：{body}"
        );
    }

    /// T1：白名单审计只记可见 / 隐藏数量的前后值。
    ///
    /// 这条动作本身不接收设置值，但它是「会写审计」的管理动作之一；这里先在
    /// 设置表里放进带 canary 的凭据，再执行白名单替换，确保 detail 既不带
    /// 明文、也不带 `enc:v1:` 密文，且连服务器 id 都不落。
    #[tokio::test]
    async fn public_status_audit_detail_has_counts_but_no_secret_values() {
        let (app, state, admin, _bob) = admin_setup().await;
        let canaries = [
            ("webhook_url", "https://hooks.example/T0KEN-canary"),
            ("backup_webdav_password", "pass-canary"),
            ("telegram_bot_token", "tok-canary"),
        ];
        for (key, value) in canaries {
            repo::settings::set(
                &state.db.pool,
                key,
                &pierwave_domain::secret_box::encrypt_setting(state.db.secret_key(), value),
            )
            .await
            .unwrap();
        }

        let a = seed_server(&state, "a-1", "203.0.113.1").await;
        let b = seed_server(&state, "b-1", "203.0.113.2").await;
        let (status, body) = send(
            &app,
            Some(&admin),
            Method::PUT,
            "/api/v1/public-status/servers",
            Some(json!({ "ids": [a] })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body, json!({ "visible": 1, "hidden": 1 }), "{body}");

        let page = repo::audit::page(
            &state.db.pool,
            &repo::audit::Filter {
                action_prefixes: vec!["settings.public_status_servers".into()],
                ..Default::default()
            },
            None,
            10,
        )
        .await
        .unwrap();
        assert_eq!(page.items.len(), 1, "白名单变更必须写审计");
        let detail = page.items[0].detail.as_ref().expect("必须带 detail");
        assert_eq!(
            detail,
            &json!({
                "changes": {
                    "visible": { "from": 2, "to": 1 },
                    "hidden": { "from": 0, "to": 1 },
                }
            }),
            "detail 只能是数量前后值"
        );
        let rendered = detail.to_string();
        for (_, canary) in canaries {
            assert!(!rendered.contains(canary), "审计泄露了明文：{rendered}");
        }
        assert!(
            !rendered.contains("enc:v1:"),
            "审计混入了可逆密文：{rendered}"
        );
        assert!(
            !rendered.contains(&a) && !rendered.contains(&b),
            "审计不能出现服务器 id：{rendered}"
        );
    }
}

/// 1000 台规模下的响应体积 / 耗时回归（见文件头注释）。
#[cfg(test)]
mod payload;
