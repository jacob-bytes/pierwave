//! 服务器的「费用与到期」元数据（迁移 0061）。
//!
//! 这些列都是**可选展示数据**，只服务于公开探针页：填了就把价格与到期展示给
//! 所有人，不填就是 NULL。它们不参与鉴权、期望态下发、限速或用户计费——
//! 与 `metering`（流量加权）和套餐（用户计费）是两回事。
//!
//! 写路径用 [`BillingMeta::validated`] 严格校验（非法 = 400）；读路径用
//! [`BillingMeta::from_server`] 容错解析，旧的 / 手工改库的非法值按「未填写」
//! 处理，绝不让一行脏数据把公开页变成 500。
//!
//! 到期日与计费周期可以独立填写；价格与币种必须成对出现（同时有值或同时为空），
//! 否则公开页整组隐藏，管理员会以为「填了却没生效」。
//!
//! 计费周期（迁移 0067）由「数量 + 单位」两列组成：`billing_cycle_count`
//! （1..=1200，1200 个月 = 100 年）与 `billing_cycle_unit`
//! （`month` / `year` / `once`）。两列必须同时有值或同时为空；`once` 时数量
//! 固定为 1。旧列 `billing_cycle`（`monthly` / `yearly` / `once`）降级为
//! **只读派生镜像**，只用于兼容旧客户端与旧备份，不再接受作为新的输入源
//! （创建 / PATCH 仍接受旧字段并映射成 1 个对应单位，见 [`legacy_cycle_pair`]）。

use chrono::NaiveDate;
use serde_json::json;

use crate::error::DomainError;
use crate::models::Server;

/// 价格下界（含）：0 分。免费服务器可以填 0，和「未填写」不同。
pub const PRICE_CENTS_MIN: i64 = 0;
/// 价格上界（含）：999_999_999 分，即 9_999_999.99 元。
///
/// 需求是「小于 10 亿分」，写成含上界常量后校验用闭区间更不容易差一。
pub const PRICE_CENTS_MAX: i64 = 999_999_999;
/// 币种长度：ISO 4217 风格的 3 位大写字母。
pub const CURRENCY_LEN: usize = 3;
/// 旧版单值计费周期（迁移 0061）；只用于派生镜像与旧客户端输入。
pub const BILLING_CYCLES: [&str; 3] = ["monthly", "yearly", "once"];
/// 计费周期数量下界（含）：1 个月 / 1 年。
pub const BILLING_CYCLE_COUNT_MIN: i64 = 1;
/// 计费周期数量上界（含）：1200 个月 = 100 年。
pub const BILLING_CYCLE_COUNT_MAX: i64 = 1200;
/// 允许的计费周期单位；与迁移 0067 的注释一致。
pub const BILLING_CYCLE_UNITS: [&str; 3] = ["month", "year", "once"];
/// 到期日允许的最早日期（含）：1970-01-01。
pub const PAID_UNTIL_MIN: &str = "1970-01-01";
/// 到期日允许的最晚日期（含）：2100-12-31。
///
/// 上限不是业务规则，而是给前端日期控件 / 排序一个确定范围：`0000-01-01`
/// 或 `9999-12-31` 这类「格式合法但年份离谱」的值只会制造怪结果。
pub const PAID_UNTIL_MAX: &str = "2100-12-31";

/// 一台服务器的费用与到期（已规范化）。
///
/// `paid_until` / 计费周期可以独立为空；`price_cents` 与 `currency`
/// 必须同时有值或同时为空。计费周期的数量与单位也必须成对。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BillingMeta {
    /// `YYYY-MM-DD`；`None` = 未填写。
    pub paid_until: Option<String>,
    /// 价格（分）；`None` = 未填写。
    pub price_cents: Option<i64>,
    /// 3 位大写字母币种；`None` = 未填写。
    pub currency: Option<String>,
    /// 计费周期数量（1..=1200）；`None` = 未填写。
    pub billing_cycle_count: Option<i64>,
    /// 计费周期单位（`month` / `year` / `once`）；`None` = 未填写。
    pub billing_cycle_unit: Option<String>,
    /// 旧版单值计费周期，由 [`BillingMeta::billing_cycle_count`] 与
    /// [`BillingMeta::billing_cycle_unit`] 派生，永远不是独立输入。
    pub billing_cycle: Option<String>,
}

impl BillingMeta {
    /// 写路径校验：空白等于未填写，其余按字段规则校验。
    ///
    /// 到期日 / 计费周期可以独立填写；**价格与币种必须成对**（同时有值或同时
    /// 为空），计费周期的**数量与单位也必须成对**。只填一半会让前端整组隐藏，
    /// 管理员以为填了、公开页却不显示，所以宁可在写路径 400。
    ///
    /// 错误码（均为 400，`params` 含 `field` 与允许范围）：
    /// * `server.paid_until_invalid`：不是真实存在且落在
    ///   [`PAID_UNTIL_MIN`]..=[`PAID_UNTIL_MAX`] 的 `YYYY-MM-DD` 日期；
    /// * `server.price_cents_invalid`：负数或 >= 1_000_000_000；
    /// * `server.currency_invalid`：不是 3 位大写字母；
    /// * `server.billing_cycle_count_invalid`：不是
    ///   [`BILLING_CYCLE_COUNT_MIN`]..=[`BILLING_CYCLE_COUNT_MAX`] 的整数；
    /// * `server.billing_cycle_unit_invalid`：不在 [`BILLING_CYCLE_UNITS`] 里；
    /// * `server.billing_cycle_once_count_invalid`：单位是 `once` 但数量不是 1；
    /// * `server.billing_cycle_pair_incomplete`：数量与单位只填了其中一个，
    ///   `params.missing` 指明缺哪个（`billing_cycle_count` / `billing_cycle_unit`）；
    /// * `server.billing_pair_incomplete`：价格与币种只填了其中一个，
    ///   `params.missing` 指明缺哪个（`price_cents` / `currency`）。
    pub fn validated(
        paid_until: Option<&str>,
        price_cents: Option<i64>,
        currency: Option<&str>,
        billing_cycle_count: Option<i64>,
        billing_cycle_unit: Option<&str>,
    ) -> Result<Self, DomainError> {
        let (billing_cycle_count, billing_cycle_unit) =
            normalize_billing_cycle(billing_cycle_count, billing_cycle_unit)?;
        let mut meta = Self {
            paid_until: normalize_paid_until(paid_until)?,
            price_cents: validate_price(price_cents)?,
            currency: normalize_currency(currency)?,
            billing_cycle_count,
            billing_cycle_unit,
            billing_cycle: None,
        };
        meta.billing_cycle = meta.derived_legacy_cycle().map(str::to_owned);
        meta.validate_pair()?;
        Ok(meta)
    }

    /// 旧列 `billing_cycle` 的派生值。
    ///
    /// 与迁移 0067 的回填口径一致：`count=1 & month → monthly`、
    /// `count=1 & year → yearly`、`unit=once → once`，其它组合一律 `None`。
    /// 例如「3 个月」没有对应的旧值，旧客户端会看到 `null`——这正是派生列的
    /// 语义，不能为了好看编一个 `monthly` 出来。
    pub fn derived_legacy_cycle(&self) -> Option<&'static str> {
        derived_legacy_cycle(self.billing_cycle_count, self.billing_cycle_unit.as_deref())
    }

    /// 价格与币种必须同时有值或同时为空。
    fn validate_pair(&self) -> Result<(), DomainError> {
        if self.price_cents.is_some() == self.currency.is_some() {
            return Ok(());
        }
        let missing = if self.price_cents.is_none() {
            "price_cents"
        } else {
            "currency"
        };
        Err(DomainError::with_params(
            "server.billing_pair_incomplete",
            json!({ "missing": missing }),
            format!(
                "价格与币种必须同时填写或同时留空：缺少 {missing} / Price and currency must be provided together or both left empty: missing {missing}"
            ),
        ))
    }

    /// 读路径：从服务器行构造，非法/损坏的存量值按未填写处理。
    ///
    /// 这里刻意容错：输入可能是手工改库或旧版本写入的脏值。公开页只做展示，
    /// 宁可少显示一个字段，也不能让整个接口 500。日期同时按年份范围过滤
    /// （`0000-*` / `2101-*` 这类越界值也视为未填写）。
    ///
    /// 计费周期优先读新列；新列缺失或非法时**回退**到旧列 `billing_cycle`
    /// （映射成 1 个对应单位），这样即便有人绕过写路径、或用旧二进制写了旧列，
    /// 公开页也不会突然从「月付」变成「未填写」。回退只影响展示，不会写库。
    pub fn from_server(server: &Server) -> Self {
        let pair = sanitize_cycle_pair(
            server.billing_cycle_count,
            server.billing_cycle_unit.as_deref(),
        )
        .or_else(|| legacy_cycle_pair_lenient(server.billing_cycle.as_deref()));
        let (billing_cycle_count, billing_cycle_unit) = match pair {
            Some((count, unit)) => (Some(count), Some(unit.to_string())),
            None => (None, None),
        };
        let mut meta = Self {
            paid_until: server
                .paid_until
                .as_deref()
                .map(str::trim)
                .filter(|value| is_iso_date(value))
                .map(str::to_owned),
            price_cents: server
                .price_cents
                .filter(|price| (PRICE_CENTS_MIN..=PRICE_CENTS_MAX).contains(price)),
            currency: server
                .currency
                .as_deref()
                .map(str::trim)
                .filter(|value| is_currency(value))
                .map(str::to_owned),
            billing_cycle_count,
            billing_cycle_unit,
            billing_cycle: None,
        };
        meta.billing_cycle = meta.derived_legacy_cycle().map(str::to_owned);
        // 半对行（只有价格或只有币种）在展示层整体降级为「未填写」：显示
        // 「¥49.99」却没有币种、或「CNY」没有金额只会误导管理员。写路径已经
        // 成对写入，这里只兜住手工改库 / 旧版本留下的脏行。
        if meta.price_cents.is_some() != meta.currency.is_some() {
            meta.price_cents = None;
            meta.currency = None;
        }
        meta
    }

    /// 五个源字段是否都为空。创建时用它跳过一次无意义的 UPDATE。
    ///
    /// `billing_cycle` 是派生列，不参与判断。
    pub fn is_empty(&self) -> bool {
        self.paid_until.is_none()
            && self.price_cents.is_none()
            && self.currency.is_none()
            && self.billing_cycle_count.is_none()
            && self.billing_cycle_unit.is_none()
    }
}

/// 到期日：去首尾空白；空串 = 清空；否则必须是真实存在的 `YYYY-MM-DD`，
/// 且年份落在 [`PAID_UNTIL_MIN`]..=[`PAID_UNTIL_MAX`]。
fn normalize_paid_until(raw: Option<&str>) -> Result<Option<String>, DomainError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if is_iso_date(value) {
        return Ok(Some(value.to_string()));
    }
    Err(DomainError::with_params(
        "server.paid_until_invalid",
        json!({
            "field": "paid_until",
            "format": "YYYY-MM-DD",
            "min": PAID_UNTIL_MIN,
            "max": PAID_UNTIL_MAX,
            "value": value,
        }),
        format!(
            "到期日不合法：{value} 必须是 {PAID_UNTIL_MIN} 到 {PAID_UNTIL_MAX} 之间真实存在的 YYYY-MM-DD 日期（例如 2026-12-31），或留空 / Invalid paid-until date: {value} must be a real YYYY-MM-DD date between {PAID_UNTIL_MIN} and {PAID_UNTIL_MAX} (e.g. 2026-12-31), or leave it empty"
        ),
    ))
}

/// 价格（分）：0 <= price <= 999_999_999。
fn validate_price(price: Option<i64>) -> Result<Option<i64>, DomainError> {
    let Some(price) = price else {
        return Ok(None);
    };
    if (PRICE_CENTS_MIN..=PRICE_CENTS_MAX).contains(&price) {
        return Ok(Some(price));
    }
    Err(DomainError::with_params(
        "server.price_cents_invalid",
        json!({
            "field": "price_cents",
            "min": PRICE_CENTS_MIN,
            "max": PRICE_CENTS_MAX,
            "value": price,
        }),
        format!(
            "价格（分）不合法：{price} 超出 {PRICE_CENTS_MIN}-{PRICE_CENTS_MAX}（约 1000 万元），或留空 / Invalid price in cents: {price} is outside {PRICE_CENTS_MIN}-{PRICE_CENTS_MAX} (~10 million yuan), or leave it empty"
        ),
    ))
}

/// 币种：去首尾空白；空串 = 清空；否则必须是 3 位大写字母。
///
/// 与 `country_code` 一致：不接受小写，避免同一币种出现 `cny` / `CNY` 两种写法。
fn normalize_currency(raw: Option<&str>) -> Result<Option<String>, DomainError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if is_currency(value) {
        return Ok(Some(value.to_string()));
    }
    Err(DomainError::with_params(
        "server.currency_invalid",
        json!({
            "field": "currency",
            "length": CURRENCY_LEN,
            "pattern": "^[A-Z]{3}$",
            "value": value,
        }),
        format!(
            "币种不合法：{value} 必须是 {CURRENCY_LEN} 位大写字母（例如 CNY / USD / EUR），或留空 / Invalid currency: {value} must be a {CURRENCY_LEN}-letter uppercase code (e.g. CNY / USD / EUR), or leave it empty"
        ),
    ))
}

/// 计费周期（数量 + 单位）的写路径校验。
///
/// 两个字段必须同时有值或同时为空；数量是 1..=1200 的整数；单位只能是
/// [`BILLING_CYCLE_UNITS`] 之一；`once` 时数量固定为 1。
///
/// **`once` + 数量 > 1 选择「拒绝」而不是「静默归一为 1」**：静默改值会让管理员
/// 以为自己填的 3 生效了，实际上只扣一次；明确 400 才能让调用方修正输入。
fn normalize_billing_cycle(
    count: Option<i64>,
    unit: Option<&str>,
) -> Result<(Option<i64>, Option<String>), DomainError> {
    let unit = match unit {
        None => None,
        Some(raw) => {
            let value = raw.trim();
            if value.is_empty() {
                None
            } else if BILLING_CYCLE_UNITS.contains(&value) {
                Some(value.to_string())
            } else {
                return Err(DomainError::with_params(
                    "server.billing_cycle_unit_invalid",
                    json!({
                        "field": "billing_cycle_unit",
                        "allowed": BILLING_CYCLE_UNITS,
                        "value": value,
                    }),
                    format!(
                        "计费周期单位不合法：{value} 只能是 month / year / once，或留空 / Invalid billing cycle unit: {value} must be month, year or once, or leave it empty"
                    ),
                ));
            }
        }
    };
    match (count, unit) {
        (None, None) => Ok((None, None)),
        (Some(count), None) => Err(cycle_pair_incomplete("billing_cycle_unit", count)),
        (None, Some(unit)) => Err(cycle_pair_incomplete("billing_cycle_count", &unit)),
        (Some(count), Some(unit)) => {
            if !(BILLING_CYCLE_COUNT_MIN..=BILLING_CYCLE_COUNT_MAX).contains(&count) {
                return Err(DomainError::with_params(
                    "server.billing_cycle_count_invalid",
                    json!({
                        "field": "billing_cycle_count",
                        "min": BILLING_CYCLE_COUNT_MIN,
                        "max": BILLING_CYCLE_COUNT_MAX,
                        "value": count,
                    }),
                    format!(
                        "计费周期数量不合法：{count} 必须在 {BILLING_CYCLE_COUNT_MIN}-{BILLING_CYCLE_COUNT_MAX} 之间（1 个月到 1200 个月，即 100 年），或留空 / Invalid billing cycle count: {count} must be between {BILLING_CYCLE_COUNT_MIN} and {BILLING_CYCLE_COUNT_MAX} (1 month to 1200 months, i.e. 100 years), or leave it empty"
                    ),
                ));
            }
            if unit == "once" && count != 1 {
                return Err(DomainError::with_params(
                    "server.billing_cycle_once_count_invalid",
                    json!({
                        "field": "billing_cycle_count",
                        "unit": "once",
                        "allowed": [1],
                        "value": count,
                    }),
                    format!(
                        "一次性计费的周期数量必须是 1：当前为 {count} / A one-time billing cycle must use count 1: got {count}"
                    ),
                ));
            }
            Ok((Some(count), Some(unit)))
        }
    }
}

/// 数量与单位只填了一个时的稳定错误；`missing` 是缺少的那一列。
fn cycle_pair_incomplete<T: std::fmt::Display>(missing: &'static str, present: T) -> DomainError {
    DomainError::with_params(
        "server.billing_cycle_pair_incomplete",
        json!({
            "field": missing,
            "missing": missing,
            "present": present.to_string(),
        }),
        format!(
            "计费周期的数量与单位必须同时填写或同时留空：缺少 {missing} / Billing cycle count and unit must be provided together or both left empty: missing {missing}"
        ),
    )
}

/// 旧列 `billing_cycle` 的派生口径（与迁移 0067 的回填一致）。
fn derived_legacy_cycle(count: Option<i64>, unit: Option<&str>) -> Option<&'static str> {
    match (count, unit) {
        (_, Some("once")) => Some("once"),
        (Some(1), Some("month")) => Some("monthly"),
        (Some(1), Some("year")) => Some("yearly"),
        _ => None,
    }
}

/// 旧客户端 / 旧备份的 `billing_cycle` 输入映射：`monthly` → 1 个月、
/// `yearly` → 1 年、`once` → 一次性。
///
/// `None` / 空串 = 未填写；其它值报 `server.billing_cycle_invalid`（沿用 0061
/// 的错误码，旧前端词典不需要改）。新字段与旧字段同时出现时由调用方决定优先级。
pub fn legacy_cycle_pair(raw: Option<&str>) -> Result<Option<(i64, &'static str)>, DomainError> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    match value {
        "monthly" => Ok(Some((1, "month"))),
        "yearly" => Ok(Some((1, "year"))),
        "once" => Ok(Some((1, "once"))),
        _ => Err(DomainError::with_params(
            "server.billing_cycle_invalid",
            json!({
                "field": "billing_cycle",
                "allowed": BILLING_CYCLES,
                "value": value,
            }),
            format!(
                "计费周期不合法：{value} 只能是 monthly / yearly / once，或留空 / Invalid billing cycle: {value} must be monthly, yearly or once, or leave it empty"
            ),
        )),
    }
}

/// 读路径的旧列容错映射：未知值当作未填写，绝不 500。
fn legacy_cycle_pair_lenient(raw: Option<&str>) -> Option<(i64, &'static str)> {
    match raw.map(str::trim) {
        Some("monthly") => Some((1, "month")),
        Some("yearly") => Some((1, "year")),
        Some("once") => Some((1, "once")),
        _ => None,
    }
}

/// 读路径的新列容错解析：只有完整合法的一对才返回。
fn sanitize_cycle_pair(count: Option<i64>, unit: Option<&str>) -> Option<(i64, &'static str)> {
    let unit = match unit.map(str::trim) {
        Some("month") => "month",
        Some("year") => "year",
        Some("once") => "once",
        _ => return None,
    };
    let count = count?;
    if !(BILLING_CYCLE_COUNT_MIN..=BILLING_CYCLE_COUNT_MAX).contains(&count) {
        return None;
    }
    if unit == "once" && count != 1 {
        return None;
    }
    Some((count, unit))
}

/// 严格 `YYYY-MM-DD`、日期真实存在（拒绝 2026-02-30、2026-2-01），
/// 且年份落在 [`PAID_UNTIL_MIN`]..=[`PAID_UNTIL_MAX`]。
fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let ok = match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        };
        if !ok {
            return false;
        }
    }
    // 固定宽度 ISO 字符串按字典序比较等价于按日期比较；范围检查放在解析前，
    // 也顺便挡掉 `0000-01-01` 这类 chrono 能解析但业务不接受的年份。
    if !(PAID_UNTIL_MIN..=PAID_UNTIL_MAX).contains(&value) {
        return false;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

/// 恰好 3 位 ASCII 大写字母。
fn is_currency(value: &str) -> bool {
    value.len() == CURRENCY_LEN && value.bytes().all(|byte| byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server_with(
        paid_until: Option<&str>,
        price_cents: Option<i64>,
        currency: Option<&str>,
        billing_cycle_count: Option<i64>,
        billing_cycle_unit: Option<&str>,
        billing_cycle: Option<&str>,
    ) -> Server {
        // 只填和本模块相关的字段，其余用建库默认值等价物占位。
        Server {
            id: "s-1".into(),
            name: "hk-1".into(),
            address: "203.0.113.9".into(),
            token_hash: String::new(),
            xray_mode: "external".into(),
            status: "offline".into(),
            last_seen_at: None,
            config_version: 0,
            created_at: 0,
            agent_version: None,
            xray_running: None,
            nginx_running: None,
            load1: None,
            mem_used: None,
            mem_total: None,
            disk_used: None,
            disk_total: None,
            uptime_secs: None,
            latency_ms: None,
            net_rx_bps: None,
            net_tx_bps: None,
            net_rx_bytes: None,
            net_tx_bytes: None,
            health_at: None,
            allow_agent_upgrade: false,
            agent_target_version: None,
            arch: String::new(),
            protocol_version: None,
            os_name: None,
            os_version: None,
            virt: None,
            realm_available: None,
            realm_transport: None,
            nftables_available: None,
            tunnel_available: None,
            public_visible: true,
            country_code: None,
            group_name: None,
            paid_until: paid_until.map(str::to_owned),
            price_cents,
            currency: currency.map(str::to_owned),
            billing_cycle_count,
            billing_cycle_unit: billing_cycle_unit.map(str::to_owned),
            billing_cycle: billing_cycle.map(str::to_owned),
            port_start: None,
            port_end: None,
            port_allow_json: "[]".into(),
            internal_address: None,
            nic_name: None,
            interfaces_json: "[]".into(),
            interfaces_reported_at: None,
            apply_status: None,
            apply_error: None,
            apply_version: None,
            apply_at: None,
            apply_partial_json: None,
        }
    }

    #[test]
    fn accepts_a_complete_valid_set() {
        let meta = BillingMeta::validated(
            Some("2026-12-31"),
            Some(4999),
            Some("CNY"),
            Some(1),
            Some("month"),
        )
        .unwrap();
        assert_eq!(meta.paid_until.as_deref(), Some("2026-12-31"));
        assert_eq!(meta.price_cents, Some(4999));
        assert_eq!(meta.currency.as_deref(), Some("CNY"));
        assert_eq!(meta.billing_cycle_count, Some(1));
        assert_eq!(meta.billing_cycle_unit.as_deref(), Some("month"));
        assert_eq!(meta.billing_cycle.as_deref(), Some("monthly"));
        assert!(!meta.is_empty());
    }

    #[test]
    fn accepts_leap_day_and_price_bounds() {
        assert!(BillingMeta::validated(
            Some("2024-02-29"),
            Some(0),
            Some("USD"),
            Some(1),
            Some("once")
        )
        .is_ok());
        assert!(
            BillingMeta::validated(None, Some(PRICE_CENTS_MAX), Some("CNY"), None, None).is_ok(),
            "上界 999_999_999 必须合法"
        );
    }

    /// 数量 + 单位支持任意月数 / 年数；旧列只在 count=1 / once 时有值。
    #[test]
    fn accepts_quantities_and_derives_the_legacy_cycle() {
        for (count, unit, derived) in [
            (1, "month", Some("monthly")),
            (3, "month", None),
            (12, "month", None),
            (2, "year", None),
            (1, "year", Some("yearly")),
            (BILLING_CYCLE_COUNT_MAX, "month", None),
            (1, "once", Some("once")),
        ] {
            let meta = BillingMeta::validated(None, None, None, Some(count), Some(unit)).unwrap();
            assert_eq!(meta.billing_cycle_count, Some(count), "{count} {unit}");
            assert_eq!(
                meta.billing_cycle_unit.as_deref(),
                Some(unit),
                "{count} {unit}"
            );
            assert_eq!(
                meta.billing_cycle.as_deref(),
                derived,
                "{count} {unit} 的派生旧值"
            );
        }
    }

    /// 到期 / 周期可以独立填写；价格与币种、数量与单位必须成对（见下一个测试）。
    #[test]
    fn allows_partial_values_except_the_pairs() {
        let only_until =
            BillingMeta::validated(Some("2027-01-31"), None, None, None, None).unwrap();
        assert_eq!(only_until.paid_until.as_deref(), Some("2027-01-31"));
        assert_eq!(only_until.price_cents, None);
        assert_eq!(only_until.currency, None);
        assert_eq!(only_until.billing_cycle_count, None);

        let only_cycle = BillingMeta::validated(None, None, None, Some(12), Some("year")).unwrap();
        assert_eq!(only_cycle.billing_cycle.as_deref(), None);
        assert_eq!(only_cycle.billing_cycle_count, Some(12));

        let price_with_currency =
            BillingMeta::validated(Some("2027-01-31"), Some(1200), Some("CNY"), None, None)
                .unwrap();
        assert_eq!(price_with_currency.price_cents, Some(1200));
        assert_eq!(price_with_currency.currency.as_deref(), Some("CNY"));

        assert!(BillingMeta::validated(None, None, None, None, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rejects_negative_and_oversized_price_with_range_params() {
        for price in [-1, -999, PRICE_CENTS_MAX + 1, 1_000_000_000, i64::MAX] {
            let error = BillingMeta::validated(None, Some(price), None, None, None).unwrap_err();
            assert_eq!(error.code, "server.price_cents_invalid");
            assert_eq!(error.params["field"], "price_cents");
            assert_eq!(error.params["min"], PRICE_CENTS_MIN);
            assert_eq!(error.params["max"], PRICE_CENTS_MAX);
            assert_eq!(error.params["value"], price);
            assert!(error.message.contains("Invalid price in cents"), "{error}");
        }
    }

    #[test]
    fn rejects_non_three_letter_currency() {
        for currency in ["CN", "CNYY", "cny", "C1Y", "人民币", "C NY"] {
            let error = BillingMeta::validated(None, None, Some(currency), None, None).unwrap_err();
            assert_eq!(error.code, "server.currency_invalid", "{currency}");
            assert_eq!(error.params["field"], "currency");
            assert_eq!(error.params["length"], 3);
            assert!(error.message.contains("Invalid currency"), "{error}");
        }
        // 首尾空白会被去掉，大写三字母仍然合法（价格必须一起给）。
        let ok = BillingMeta::validated(None, Some(1200), Some(" CNY "), None, None).unwrap();
        assert_eq!(ok.currency.as_deref(), Some("CNY"));
    }

    /// 校验矩阵：缺一半、0、1201、非法单位、once + count > 1。
    #[test]
    fn rejects_invalid_cycle_matrix() {
        // 缺一半：两个字段必须同时有值或同时为空。
        for (count, unit, missing) in [
            (Some(3), None, "billing_cycle_unit"),
            (None, Some("month"), "billing_cycle_count"),
        ] {
            let error = BillingMeta::validated(None, None, None, count, unit).unwrap_err();
            assert_eq!(
                error.code, "server.billing_cycle_pair_incomplete",
                "{error}"
            );
            assert_eq!(error.params["field"], missing);
            assert_eq!(error.params["missing"], missing);
            assert!(
                error.message.contains("Invalid billing cycle")
                    || error.message.contains("Billing")
            );
        }

        // 数量越界：0 与 1201 都是 400，params 带 min / max。
        for count in [0, BILLING_CYCLE_COUNT_MAX + 1, -1] {
            let error =
                BillingMeta::validated(None, None, None, Some(count), Some("month")).unwrap_err();
            assert_eq!(error.code, "server.billing_cycle_count_invalid", "{count}");
            assert_eq!(error.params["field"], "billing_cycle_count");
            assert_eq!(error.params["min"], BILLING_CYCLE_COUNT_MIN);
            assert_eq!(error.params["max"], BILLING_CYCLE_COUNT_MAX);
            assert_eq!(error.params["value"], count);
            assert!(
                error.message.contains("Invalid billing cycle count"),
                "{error}"
            );
        }

        // 非法单位：params 带 allowed 白名单。
        for unit in ["weekly", "Monthly", "annual", "onces"] {
            let error = BillingMeta::validated(None, None, None, Some(1), Some(unit)).unwrap_err();
            assert_eq!(error.code, "server.billing_cycle_unit_invalid", "{unit}");
            assert_eq!(error.params["field"], "billing_cycle_unit");
            assert_eq!(error.params["allowed"], json!(BILLING_CYCLE_UNITS));
            assert!(
                error.message.contains("Invalid billing cycle unit"),
                "{error}"
            );
        }

        // once 的数量必须是 1：拒绝而不是静默归一，避免管理员以为 3 次生效。
        for count in [2, 3, BILLING_CYCLE_COUNT_MAX] {
            let error =
                BillingMeta::validated(None, None, None, Some(count), Some("once")).unwrap_err();
            assert_eq!(
                error.code, "server.billing_cycle_once_count_invalid",
                "{count}"
            );
            assert_eq!(error.params["field"], "billing_cycle_count");
            assert_eq!(error.params["unit"], "once");
            assert_eq!(error.params["allowed"], json!([1]));
            assert_eq!(error.params["value"], count);
            assert!(error.message.contains("must use count 1"), "{error}");
        }

        // 首尾空白会被去掉，合法值仍然合法。
        let ok = BillingMeta::validated(None, None, None, Some(2), Some(" year ")).unwrap();
        assert_eq!(ok.billing_cycle_unit.as_deref(), Some("year"));
    }

    /// 旧客户端字段：monthly / yearly / once 都映射成 1 个对应单位。
    #[test]
    fn legacy_cycle_input_maps_to_one_unit() {
        assert_eq!(
            legacy_cycle_pair(Some("monthly")).unwrap(),
            Some((1, "month"))
        );
        assert_eq!(
            legacy_cycle_pair(Some(" yearly ")).unwrap(),
            Some((1, "year"))
        );
        assert_eq!(legacy_cycle_pair(Some("once")).unwrap(), Some((1, "once")));
        assert_eq!(legacy_cycle_pair(None).unwrap(), None);
        assert_eq!(legacy_cycle_pair(Some("   ")).unwrap(), None);

        for cycle in ["weekly", "Monthly", "annual", "onces"] {
            let error = legacy_cycle_pair(Some(cycle)).unwrap_err();
            assert_eq!(error.code, "server.billing_cycle_invalid", "{cycle}");
            assert_eq!(error.params["field"], "billing_cycle");
            assert_eq!(error.params["allowed"], json!(BILLING_CYCLES));
        }
    }

    #[test]
    fn rejects_impossible_dates_and_non_iso_shapes() {
        for date in [
            "2026-02-30",
            "2026-13-01",
            "2026-2-01",
            "2026/01/01",
            "20260101",
        ] {
            let error = BillingMeta::validated(Some(date), None, None, None, None).unwrap_err();
            assert_eq!(error.code, "server.paid_until_invalid", "{date}");
            assert_eq!(error.params["field"], "paid_until");
            assert_eq!(error.params["format"], "YYYY-MM-DD");
        }
        // 空白等于未填写。
        assert!(BillingMeta::validated(Some("   "), None, None, None, None)
            .unwrap()
            .is_empty());
    }

    /// 到期日只接受 1970-01-01..=2100-12-31：0000 与 9999 这类「格式合法但
    /// 年份离谱」的值会让前端日期控件与排序出怪结果，必须在写路径拒绝。
    #[test]
    fn paid_until_is_limited_to_the_supported_year_range() {
        for date in [PAID_UNTIL_MIN, PAID_UNTIL_MAX] {
            let meta = BillingMeta::validated(Some(date), None, None, None, None).unwrap();
            assert_eq!(meta.paid_until.as_deref(), Some(date), "{date} 必须合法");
        }
        for date in ["1969-12-31", "2101-01-01", "0000-01-01", "9999-12-31"] {
            let error = BillingMeta::validated(Some(date), None, None, None, None).unwrap_err();
            assert_eq!(error.code, "server.paid_until_invalid", "{date}");
            assert_eq!(error.params["field"], "paid_until");
            assert_eq!(error.params["min"], PAID_UNTIL_MIN, "{date}");
            assert_eq!(error.params["max"], PAID_UNTIL_MAX, "{date}");
        }

        // 读路径同样按「未填写」处理越界存量值，公开页不会展示 9999 年。
        let dirty = server_with(Some("9999-12-31"), None, None, None, None, None);
        assert_eq!(BillingMeta::from_server(&dirty).paid_until, None);
    }

    /// 价格与币种必须成对：只填一半会被前端整组隐藏，管理员以为填了但公开页不显示。
    #[test]
    fn price_and_currency_must_be_provided_together() {
        let error = BillingMeta::validated(None, Some(1200), None, None, None).unwrap_err();
        assert_eq!(error.code, "server.billing_pair_incomplete");
        assert_eq!(error.params["missing"], "currency");
        assert!(error.message.contains("currency"), "{error}");

        let error = BillingMeta::validated(None, None, Some("CNY"), None, None).unwrap_err();
        assert_eq!(error.code, "server.billing_pair_incomplete");
        assert_eq!(error.params["missing"], "price_cents");
        assert!(error.message.contains("price_cents"), "{error}");

        // 0 分是有效价格，不是「未填写」：没有币种仍然不完整。
        let error = BillingMeta::validated(None, Some(0), None, None, None).unwrap_err();
        assert_eq!(error.params["missing"], "currency");

        // 成对填写合法；到期 / 周期仍可独立省略。
        let ok = BillingMeta::validated(None, Some(0), Some("USD"), None, None).unwrap();
        assert_eq!(ok.price_cents, Some(0));
        assert_eq!(ok.currency.as_deref(), Some("USD"));
        assert!(BillingMeta::validated(None, None, None, Some(1), Some("month")).is_ok());
    }

    /// 读路径：合法值原样保留，非法存量值逐字段降级为 None，不 panic。
    #[test]
    fn from_server_sanitizes_dirty_rows() {
        let dirty = server_with(
            Some("2026-02-30"),
            Some(-5),
            Some("cny"),
            Some(0),
            Some("week"),
            Some("weekly"),
        );
        assert_eq!(BillingMeta::from_server(&dirty), BillingMeta::default());

        let clean = server_with(
            Some("2026-12-31"),
            Some(0),
            Some("EUR"),
            Some(1),
            Some("year"),
            Some("yearly"),
        );
        assert_eq!(
            BillingMeta::from_server(&clean),
            BillingMeta {
                paid_until: Some("2026-12-31".into()),
                price_cents: Some(0),
                currency: Some("EUR".into()),
                billing_cycle_count: Some(1),
                billing_cycle_unit: Some("year".into()),
                billing_cycle: Some("yearly".into()),
            }
        );

        // 新列是 3 个月：旧列没有对应值，派生为 None（哪怕库里旧列还是旧值）。
        let three_months = server_with(None, None, None, Some(3), Some("month"), Some("monthly"));
        let meta = BillingMeta::from_server(&three_months);
        assert_eq!(meta.billing_cycle_count, Some(3));
        assert_eq!(meta.billing_cycle_unit.as_deref(), Some("month"));
        assert_eq!(meta.billing_cycle, None, "3 个月不能派生成 monthly");

        // 新列缺失（旧二进制 / 手工改库）时回退旧列，公开页不会突然变「未填写」。
        let legacy_only = server_with(None, None, None, None, None, Some("yearly"));
        let meta = BillingMeta::from_server(&legacy_only);
        assert_eq!(meta.billing_cycle_count, Some(1));
        assert_eq!(meta.billing_cycle_unit.as_deref(), Some("year"));
        assert_eq!(meta.billing_cycle.as_deref(), Some("yearly"));

        // 新列非法时也回退旧列（容错展示），但不会把非法值展示出去。
        let broken_pair = server_with(None, None, None, Some(0), Some("month"), Some("once"));
        let meta = BillingMeta::from_server(&broken_pair);
        assert_eq!(meta.billing_cycle_count, Some(1));
        assert_eq!(meta.billing_cycle_unit.as_deref(), Some("once"));

        // 只有一列脏不影响其它列；但价格/币种是成对的，丢掉一列后另一列也
        // 整体降级，避免展示「只有币种没有金额」的半对行。
        let mixed = server_with(None, Some(1_000_000_000), Some("USD"), None, None, None);
        let meta = BillingMeta::from_server(&mixed);
        assert_eq!(meta.price_cents, None);
        assert_eq!(meta.currency, None);

        // 手工改库留下的半对行（只有价格 / 只有币种）在读取时整组降级；
        // 只影响这两列，到期日仍可展示。
        for half in [
            server_with(Some("2026-12-31"), Some(4999), None, None, None, None),
            server_with(Some("2026-12-31"), None, Some("CNY"), None, None, None),
        ] {
            let meta = BillingMeta::from_server(&half);
            assert!(meta.price_cents.is_none(), "{meta:?}");
            assert!(meta.currency.is_none(), "{meta:?}");
            assert_eq!(
                meta.paid_until.as_deref(),
                Some("2026-12-31"),
                "半对行不能连累到期日"
            );
        }
    }
}
