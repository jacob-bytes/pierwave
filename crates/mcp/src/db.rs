//! Read-only access to the PierWave SQLite database.
//!
//! **All SQL in this crate lives in this module and is `SELECT`-only.**
//! The connection itself is opened with `SQLITE_OPEN_READONLY` (the typed
//! equivalent of `?mode=ro`) and additionally gets `PRAGMA query_only = ON`,
//! so a bug here cannot turn into a write.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context};
use chrono::{DateTime, Datelike, Days, FixedOffset, NaiveDate, Utc};
use serde_json::{json, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

/// UTC+8 offset used for business days, matching `docs/PLAN.md`.
const BUSINESS_UTC_OFFSET_SECS: i64 = 8 * 60 * 60;

/// Consecutive target failures before a chain member is reported as degraded.
///
/// Mirrors `pierwave_domain::chains::DEGRADED_AFTER_FAILURES` (2). The value is
/// duplicated on purpose: MCP must not depend on domain code.
const DEGRADED_AFTER_FAILURES: i64 = 2;

/// A read-only handle to the panel database.
#[derive(Clone)]
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    /// Open an existing SQLite file in read-only mode.
    ///
    /// This is the typed equivalent of `sqlite://<path>?mode=ro`:
    /// `read_only(true)` sets `SQLITE_OPEN_READONLY`, and
    /// `create_if_missing(false)` makes a missing file a startup error instead
    /// of silently creating an empty database.
    pub async fn open_read_only(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref();
        if !path.exists() {
            bail!(
                "无法以只读模式打开数据库：{path} 不存在。请用 --db <path> 或环境变量 PIERWAVE_DB 指定主控数据库。\n\
                 Failed to open database in read-only mode: {path} does not exist. \
                 Pass --db <path> or set PIERWAVE_DB.",
                path = path.display()
            );
        }
        if !path.is_file() {
            bail!(
                "无法以只读模式打开数据库：{path} 不是普通文件。\n\
                 Failed to open database in read-only mode: {path} is not a regular file.",
                path = path.display()
            );
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .read_only(true) // ?mode=ro
            .create_if_missing(false)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));

        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .with_context(|| {
                format!(
                    "只读打开 SQLite 失败 / failed to open SQLite read-only: {}",
                    path.display()
                )
            })?;

        // Defence in depth: even if the open flags were wrong, this connection
        // refuses every write. The read-only open flag is the real guarantee;
        // this pragma also covers any future code that swaps the options.
        sqlx::query("PRAGMA query_only = ON")
            .execute(&pool)
            .await
            .with_context(|| {
                format!(
                    "设置只读保护失败 / failed to enable query_only: {}",
                    path.display()
                )
            })?;

        Ok(Self { pool })
    }

    /// The underlying read-only pool (used by tests to prove writes fail).
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// `list_servers`: every server plus its last heartbeat snapshot.
    pub async fn list_servers(&self) -> anyhow::Result<Value> {
        #[derive(sqlx::FromRow)]
        struct ServerRow {
            id: String,
            name: String,
            address: String,
            status: String,
            xray_running: Option<i64>,
            load1: Option<f64>,
            mem_used: Option<i64>,
            mem_total: Option<i64>,
            disk_used: Option<i64>,
            disk_total: Option<i64>,
            latency_ms: Option<i64>,
            last_seen_at: Option<i64>,
        }

        let rows = sqlx::query_as::<_, ServerRow>(
            "SELECT id, name, address, status, xray_running, load1,
                    mem_used, mem_total, disk_used, disk_total, latency_ms, last_seen_at
             FROM servers
             ORDER BY created_at ASC, rowid ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        let servers: Vec<Value> = rows
            .into_iter()
            .map(|row| {
                json!({
                    "id": row.id,
                    "name": row.name,
                    "address": row.address,
                    "online": row.status == "online",
                    "xray_running": row.xray_running.map(|value| value != 0),
                    "load1": row.load1,
                    "mem": { "used": row.mem_used, "total": row.mem_total },
                    "disk": { "used": row.disk_used, "total": row.disk_total },
                    "mem_used": row.mem_used,
                    "mem_total": row.mem_total,
                    "disk_used": row.disk_used,
                    "disk_total": row.disk_total,
                    "latency_ms": row.latency_ms,
                    "last_seen": row.last_seen_at,
                })
            })
            .collect();

        Ok(json!({ "servers": servers }))
    }

    /// `list_users`: one row per package instance, plus one row per account
    /// that has no package instances yet.
    ///
    /// `status` is computed with the same precedence as the panel:
    /// `disabled` > `expired` > `exhausted` > `active`.
    pub async fn list_users(&self) -> anyhow::Result<Value> {
        #[derive(sqlx::FromRow)]
        struct UserRow {
            user_id: String,
            username: String,
            role: String,
            user_status: String,
            user_used_bytes: i64,
            user_quota_bytes: Option<i64>,
            package_instance_id: Option<String>,
            package_name: Option<String>,
            package_used_bytes: Option<i64>,
            package_limit_bytes: Option<i64>,
            expires_at: Option<i64>,
            package_raw_status: Option<String>,
        }

        let rows = sqlx::query_as::<_, UserRow>(
            "SELECT u.id AS user_id,
                    u.username,
                    u.role,
                    u.status AS user_status,
                    u.used_bytes AS user_used_bytes,
                    u.quota_bytes AS user_quota_bytes,
                    up.id AS package_instance_id,
                    p.name AS package_name,
                    up.used_bytes AS package_used_bytes,
                    COALESCE(up.quota_override, p.quota_bytes) AS package_limit_bytes,
                    up.expires_at,
                    up.status AS package_raw_status
             FROM users u
             LEFT JOIN user_packages up ON up.user_id = u.id
             LEFT JOIN packages p ON p.id = up.package_id
             ORDER BY u.username ASC, u.created_at ASC, up.created_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        let now = Utc::now().timestamp();
        let users: Vec<Value> = rows
            .into_iter()
            .map(|row| {
                let (package, used_bytes, limit_bytes, expires_at, status) =
                    if row.package_instance_id.is_some() {
                        let used = row.package_used_bytes.unwrap_or(0);
                        let status = package_status(
                            row.package_raw_status.as_deref().unwrap_or("active"),
                            row.expires_at,
                            row.package_limit_bytes,
                            used,
                            now,
                        );
                        (
                            row.package_name,
                            used,
                            row.package_limit_bytes,
                            row.expires_at,
                            status.to_string(),
                        )
                    } else {
                        (
                            None,
                            row.user_used_bytes,
                            row.user_quota_bytes,
                            None,
                            row.user_status.clone(),
                        )
                    };

                json!({
                    "user_id": row.user_id,
                    "username": row.username,
                    "role": row.role,
                    "package": package,
                    "used_bytes": used_bytes,
                    "limit_bytes": limit_bytes,
                    "expires_at": expires_at,
                    "status": status,
                })
            })
            .collect();

        Ok(json!({ "users": users }))
    }

    /// `get_user_traffic`: daily up/down/weighted bytes for one username.
    ///
    /// Missing days are filled with zeros so clients can draw a continuous
    /// chart. Dates are UTC+8 business days, matching `traffic_daily.day`.
    pub async fn user_traffic(&self, username: &str, days: i64) -> anyhow::Result<Option<Value>> {
        let user: Option<(String, String)> =
            sqlx::query_as("SELECT id, username FROM users WHERE username = ?")
                .bind(username)
                .fetch_optional(&self.pool)
                .await?;
        let Some((user_id, username)) = user else {
            return Ok(None);
        };

        let days = days.clamp(1, 90);
        let (start, _) = day_window(Utc::now().timestamp(), days);
        let end = start
            .checked_add_days(Days::new((days - 1) as u64))
            .unwrap_or(start);

        let rows = sqlx::query_as::<_, TrafficRow>(
            "SELECT day,
                    COALESCE(SUM(uplink), 0) AS uplink,
                    COALESCE(SUM(downlink), 0) AS downlink,
                    COALESCE(SUM(weighted), 0) AS weighted
             FROM traffic_daily
             WHERE subject = ? AND day >= ? AND day <= ?
             GROUP BY day
             ORDER BY day ASC",
        )
        .bind(&user_id)
        .bind(start.format("%Y-%m-%d").to_string())
        .bind(end.format("%Y-%m-%d").to_string())
        .fetch_all(&self.pool)
        .await?;

        Ok(Some(json!({
            "username": username,
            "days": days,
            "daily": fill_days(start, days, rows),
        })))
    }

    /// `get_status_summary`: online servers, node count and traffic totals.
    pub async fn status_summary(&self) -> anyhow::Result<Value> {
        let now = Utc::now().timestamp();
        let (servers_total, servers_online): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END), 0)
             FROM servers",
        )
        .fetch_one(&self.pool)
        .await?;

        let (nodes_total, nodes_enabled): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0)
             FROM nodes",
        )
        .fetch_one(&self.pool)
        .await?;

        let today = business_date(now);
        let (month_start, month_end) = business_month_bounds(now);
        let today_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(weighted), 0) FROM traffic_daily WHERE day = ?",
        )
        .bind(&today)
        .fetch_one(&self.pool)
        .await?;
        let month_bytes: i64 = sqlx::query_scalar(
            "SELECT COALESCE(SUM(weighted), 0) FROM traffic_daily
             WHERE day >= ? AND day <= ?",
        )
        .bind(&month_start)
        .bind(&month_end)
        .fetch_one(&self.pool)
        .await?;

        Ok(json!({
            "generated_at": now,
            "servers": { "total": servers_total, "online": servers_online },
            "nodes": { "total": nodes_total, "enabled": nodes_enabled },
            "traffic": { "today_bytes": today_bytes, "month_bytes": month_bytes },
        }))
    }

    /// `list_chains`: chain configuration plus per-group/per-member health.
    ///
    /// Health is read from `forward_status`, which the master refreshes from
    /// agent heartbeats. A member is degraded after two consecutive
    /// `target_ok = false` reports (same rule as the panel).
    pub async fn list_chains(&self) -> anyhow::Result<Value> {
        #[derive(sqlx::FromRow)]
        struct ChainRow {
            id: String,
            name: String,
            target_host: String,
            target_port: i64,
            enabled: i64,
            created_at: i64,
            updated_at: i64,
        }

        #[derive(sqlx::FromRow)]
        struct GroupRow {
            id: String,
            chain_id: String,
            seq: i64,
            name: Option<String>,
            strategy: String,
        }

        #[derive(sqlx::FromRow)]
        struct MemberRow {
            group_id: String,
            server_id: String,
            server_name: String,
            listen_port: i64,
            priority: i64,
            weight: i64,
        }

        #[derive(sqlx::FromRow)]
        struct StatusRow {
            server_id: String,
            forward_id: String,
            listening: i64,
            target_ok: Option<i64>,
            target_fail_count: i64,
            error: String,
            updated_at: i64,
        }

        let chains = sqlx::query_as::<_, ChainRow>(
            "SELECT id, name, target_host, target_port, enabled, created_at, updated_at
             FROM chains
             ORDER BY created_at ASC, rowid ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        let groups = sqlx::query_as::<_, GroupRow>(
            "SELECT id, chain_id, seq, name, strategy
             FROM chain_groups
             ORDER BY chain_id ASC, seq ASC, rowid ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        let members = sqlx::query_as::<_, MemberRow>(
            "SELECT m.group_id, m.server_id, s.name AS server_name,
                    m.listen_port, m.priority, m.weight
             FROM chain_group_members m
             JOIN servers s ON s.id = m.server_id
             ORDER BY m.group_id ASC, m.priority ASC, m.rowid ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        let statuses = sqlx::query_as::<_, StatusRow>(
            "SELECT server_id, forward_id, listening, target_ok,
                    target_fail_count, error, updated_at
             FROM forward_status",
        )
        .fetch_all(&self.pool)
        .await?;

        let mut groups_by_chain: HashMap<String, Vec<GroupRow>> = HashMap::new();
        for group in groups {
            groups_by_chain
                .entry(group.chain_id.clone())
                .or_default()
                .push(group);
        }
        let mut members_by_group: HashMap<String, Vec<MemberRow>> = HashMap::new();
        for member in members {
            members_by_group
                .entry(member.group_id.clone())
                .or_default()
                .push(member);
        }
        let status_by_key: HashMap<(String, String), StatusRow> = statuses
            .into_iter()
            .map(|status| {
                (
                    (status.server_id.clone(), status.forward_id.clone()),
                    status,
                )
            })
            .collect();

        let mut chain_views = Vec::with_capacity(chains.len());
        for chain in chains {
            let chain_groups = groups_by_chain.remove(&chain.id).unwrap_or_default();
            let mut group_views = Vec::with_capacity(chain_groups.len());
            let mut member_total = 0_i64;
            let mut chain_degraded = false;

            for group in &chain_groups {
                let group_members = members_by_group.remove(&group.id).unwrap_or_default();
                let member_count = group_members.len();
                member_total += member_count as i64;

                let mut member_views = Vec::with_capacity(member_count);
                let mut group_degraded = false;
                for member in &group_members {
                    let forward_id =
                        chain_forward_id(&chain.id, group.seq, &member.server_id, member_count);
                    let status = status_by_key.get(&(member.server_id.clone(), forward_id.clone()));
                    let degraded = status
                        .is_some_and(|status| status.target_fail_count >= DEGRADED_AFTER_FAILURES);
                    group_degraded |= degraded;

                    member_views.push(json!({
                        "server_id": member.server_id,
                        "server_name": member.server_name,
                        "listen_port": member.listen_port,
                        "priority": member.priority,
                        "weight": member.weight,
                        "forward_id": forward_id,
                        // None = no heartbeat for this forward yet.
                        "listening": status.map(|status| status.listening != 0),
                        "target_ok": status.and_then(|status| status.target_ok.map(|value| value != 0)),
                        "degraded": degraded,
                        "error": status.map(|status| status.error.as_str()).unwrap_or(""),
                        "updated_at": status.map(|status| status.updated_at),
                    }));
                }
                chain_degraded |= group_degraded;

                group_views.push(json!({
                    "id": group.id,
                    "seq": group.seq,
                    "name": group.name,
                    "strategy": group.strategy,
                    "member_count": member_count,
                    "degraded": group_degraded,
                    "members": member_views,
                }));
            }

            chain_views.push(json!({
                "id": chain.id,
                "name": chain.name,
                "enabled": chain.enabled != 0,
                "target_host": chain.target_host,
                "target_port": chain.target_port,
                "group_count": chain_groups.len(),
                "member_count": member_total,
                "degraded": chain_degraded,
                "groups": group_views,
                "created_at": chain.created_at,
                "updated_at": chain.updated_at,
            }));
        }

        Ok(json!({ "chains": chain_views }))
    }
}

/// Compute a package-instance status using the panel's precedence.
fn package_status(
    raw_status: &str,
    expires_at: Option<i64>,
    limit_bytes: Option<i64>,
    used_bytes: i64,
    now: i64,
) -> &'static str {
    if raw_status != "active" {
        return "disabled";
    }
    if expires_at.is_some_and(|expires_at| expires_at <= now) {
        return "expired";
    }
    // 0 means "explicitly unlimited"; only a positive quota can be exhausted.
    if limit_bytes.is_some_and(|quota| quota > 0 && used_bytes >= quota) {
        return "exhausted";
    }
    "active"
}

/// Fill missing dates in `[start, start + days)` with zeros.
fn fill_days(start: NaiveDate, days: i64, rows: Vec<TrafficRow>) -> Vec<Value> {
    let mut by_day: HashMap<String, (i64, i64, i64)> = rows
        .into_iter()
        .map(|row| (row.day, (row.uplink, row.downlink, row.weighted)))
        .collect();

    let mut points = Vec::with_capacity(days as usize);
    for offset in 0..days {
        let date = start
            .checked_add_days(Days::new(offset as u64))
            .unwrap_or(start);
        let key = date.format("%Y-%m-%d").to_string();
        let (uplink, downlink, weighted) = by_day.remove(&key).unwrap_or((0, 0, 0));
        points.push(json!({
            "date": key,
            "uplink": uplink,
            "downlink": downlink,
            "weighted": weighted,
        }));
    }
    points
}

#[derive(sqlx::FromRow)]
struct TrafficRow {
    day: String,
    uplink: i64,
    downlink: i64,
    weighted: i64,
}

/// `(start, today)` for a UTC+8 window of `days` calendar days, inclusive.
fn day_window(now: i64, days: i64) -> (NaiveDate, NaiveDate) {
    let today = business_today(now);
    let days = days.clamp(1, 90);
    let start = today
        .checked_sub_days(Days::new((days - 1) as u64))
        .unwrap_or(today);
    (start, today)
}

fn business_offset() -> FixedOffset {
    FixedOffset::east_opt(BUSINESS_UTC_OFFSET_SECS as i32).expect("UTC+8 offset is valid")
}

/// The UTC+8 calendar date of a Unix timestamp, formatted `YYYY-MM-DD`.
pub fn business_date(ts: i64) -> String {
    business_today(ts).format("%Y-%m-%d").to_string()
}

/// First and last day of the UTC+8 calendar month containing `ts`.
pub fn business_month_bounds(ts: i64) -> (String, String) {
    let today = business_today(ts);
    let first = NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
        .expect("first day of a real month is valid");
    let (next_year, next_month) = if today.month() == 12 {
        (today.year() + 1, 1)
    } else {
        (today.year(), today.month() + 1)
    };
    let next_first = NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .expect("first day of a real month is valid");
    let last = next_first - Days::new(1);
    (
        first.format("%Y-%m-%d").to_string(),
        last.format("%Y-%m-%d").to_string(),
    )
}

fn business_today(ts: i64) -> NaiveDate {
    DateTime::from_timestamp(ts, 0)
        .unwrap_or_else(|| DateTime::from_timestamp(0, 0).expect("epoch is valid"))
        .with_timezone(&business_offset())
        .date_naive()
}

/// `chain-<id>-<seq>` for single-member groups, `chain-<id>-<seq>-<server>` otherwise.
///
/// This is the id the master derives in `derive_forwards`; heartbeat status rows
/// are keyed by it. Keep the two implementations in sync.
fn chain_forward_id(chain_id: &str, seq: i64, server_id: &str, member_count: usize) -> String {
    if member_count <= 1 {
        format!("chain-{chain_id}-{seq}")
    } else {
        format!("chain-{chain_id}-{seq}-{server_id}")
    }
}
