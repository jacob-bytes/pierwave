//! 汇率缓存：`settings.fx_rates` 的解析、校验与过期判断。
//!
//! 上游 `https://open.er-api.com/v6/latest/CNY` 返回的是「1 CNY = x 外币」，
//! 成本视图要的是「1 外币 = 多少 CNY」，所以这里统一**存反过来的值**。
//! 所有网络请求都在 master（`crate::fx`）里，本模块不依赖 HTTP，只做纯逻辑，
//! 因此越界、缺币种、非 https、过期这些边界都能用单元测试覆盖。
//!
//! English: pure parsing/validation/staleness logic for the `fx_rates` setting.
//! The upstream API returns foreign units per 1 CNY; this module stores and
//! exposes CNY per foreign unit. Networking lives in `pierwave-master`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `settings` 表里的键名。
pub const FX_RATES_KEY: &str = "fx_rates";

/// 成本视图的基准币种：只折算成 CNY。
pub const BASE_CURRENCY: &str = "CNY";

/// 上游来源标识，写进缓存值里便于排障。
pub const SOURCE_OPEN_ER_API: &str = "open.er-api.com";

/// 管理员手动覆盖时的来源标识（不冒充上游）。
pub const SOURCE_MANUAL: &str = "manual";

/// 公共免 key 接口；只允许 https。
pub const API_URL: &str = "https://open.er-api.com/v6/latest/CNY";

/// 缓存有效期：超过 24 小时才重新抓取。
pub const REFRESH_SECS: i64 = 24 * 60 * 60;

/// 调度器检查粒度：每 6 小时看一次是否过期（不重新抓）。
pub const CHECK_INTERVAL_SECS: i64 = 6 * 60 * 60;

/// 汇率（CNY per 1 foreign unit）的合法范围。上游给的是反向报价，
/// 这里对「报价」与「反算后的汇率」都做同一个范围校验。
pub const MIN_RATE: f64 = 0.0001;
pub const MAX_RATE: f64 = 10_000.0;

/// 成本视图当前用到的币种；缺任何一个都视为响应不完整，保留旧缓存。
///
/// 其它币种照常保存（前端按「汇率表里没有就不计入」展示），但不再要求存在。
pub const REQUIRED_CURRENCIES: [&str; 3] = ["USD", "EUR", "JPY"];

/// 缓存值：`settings.fx_rates` 的 JSON 形状。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FxRates {
    /// 固定为 [`BASE_CURRENCY`]。
    pub base: String,
    /// 币种（三位大写）→ 1 单位外币折合多少 CNY。
    pub rates: BTreeMap<String, f64>,
    /// 抓取/覆盖时间（Unix 秒）；过期判断只看它。
    pub fetched_at: i64,
    /// 上游域名或 [`SOURCE_MANUAL`]。
    pub source: String,
}

/// 汇率抓取/校验失败；`code()` 是稳定标识，日志与 HTTP 错误都用它。
#[derive(Debug, Clone, PartialEq)]
pub enum FxError {
    /// 地址不是 https，或含空白/控制字符。
    NotHttps,
    /// 响应不是合法 JSON。
    InvalidJson,
    /// JSON 顶层/字段形状不对。
    InvalidShape(&'static str),
    /// 上游响应缺少成本视图需要的币种。
    MissingCurrency(&'static str),
    /// 币种代码不是三位大写字母。
    InvalidCurrency(String),
    /// 报价不是有限数字。
    InvalidRate(String),
    /// 报价或反算后的汇率越界。
    RateOutOfRange { currency: String, value: f64 },
    /// curl 超时（退出码 28）。
    Timeout,
    /// 网络/进程失败。
    Network(String),
    /// 非 2xx。
    Http(u16),
}

impl FxError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotHttps => "fx.not_https",
            Self::InvalidJson => "fx.invalid_json",
            Self::InvalidShape(_) => "fx.invalid_shape",
            Self::MissingCurrency(_) => "fx.missing_currency",
            Self::InvalidCurrency(_) => "fx.invalid_currency",
            Self::InvalidRate(_) => "fx.invalid_rate",
            Self::RateOutOfRange { .. } => "fx.rate_out_of_range",
            Self::Timeout => "fx.timeout",
            Self::Network(_) => "fx.network",
            Self::Http(_) => "fx.http",
        }
    }

    /// 可读原因；只用于日志与管理员接口，不包含响应正文。
    pub fn message(&self) -> String {
        match self {
            Self::NotHttps => {
                "汇率源必须是 https 地址 / the FX source must be an https URL".to_string()
            }
            Self::InvalidJson => "汇率响应不是合法 JSON / the FX response is not valid JSON".into(),
            Self::InvalidShape(field) => {
                format!("汇率响应形状不合法（{field}）/ malformed FX response ({field})")
            }
            Self::MissingCurrency(code) => {
                format!("汇率响应缺少币种 {code} / the FX response is missing {code}")
            }
            Self::InvalidCurrency(code) => {
                format!("币种代码不合法：{code} / invalid currency code: {code}")
            }
            Self::InvalidRate(code) => {
                format!("币种 {code} 的汇率不是有限数字 / rate for {code} is not a finite number")
            }
            Self::RateOutOfRange { currency, value } => format!(
                "币种 {currency} 的汇率 {value} 越界（允许 {MIN_RATE}..{MAX_RATE}） / \
                 rate for {currency} is out of range ({MIN_RATE}..{MAX_RATE})"
            ),
            Self::Timeout => "汇率抓取超时 / the FX request timed out".to_string(),
            Self::Network(detail) => {
                format!("汇率抓取失败：{detail} / FX request failed: {detail}")
            }
            Self::Http(status) => {
                format!("汇率接口返回 HTTP {status} / the FX API returned HTTP {status}")
            }
        }
    }
}

/// 校验汇率源地址：只接受 `https://host...`。
///
/// 生产地址是常量；这个函数存在是为了让「非 https 必须拒绝」可测试，
/// 也防止以后把地址改成可配置时悄悄允许明文 http。
pub fn validate_api_url(url: &str) -> Result<(), FxError> {
    if url.is_empty()
        || url
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(FxError::NotHttps);
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return Err(FxError::NotHttps);
    };
    if rest.is_empty() || rest.starts_with('/') {
        return Err(FxError::NotHttps);
    }
    Ok(())
}

impl FxRates {
    /// 解析上游响应，并把「1 CNY = x 外币」反算成「1 外币 = y CNY」。
    ///
    /// * 只接受 `result = "success"` 与 `base_code = "CNY"` 的响应；
    /// * 每个报价必须是有限数字且落在 [`MIN_RATE`]..=[`MAX_RATE`]，
    ///   反算后的汇率同样必须在范围内；
    /// * 缺少 [`REQUIRED_CURRENCIES`] 任一币种即失败，调用方保留旧值。
    pub fn from_api(raw: &str, now: i64) -> Result<Self, FxError> {
        let value: Value = serde_json::from_str(raw).map_err(|_| FxError::InvalidJson)?;
        let object = value.as_object().ok_or(FxError::InvalidShape("root"))?;
        if let Some(result) = object.get("result") {
            if result.as_str() != Some("success") {
                return Err(FxError::InvalidShape("result"));
            }
        }
        if object.get("base_code").and_then(Value::as_str) != Some(BASE_CURRENCY) {
            return Err(FxError::InvalidShape("base_code"));
        }
        let rates = object
            .get("rates")
            .and_then(Value::as_object)
            .ok_or(FxError::InvalidShape("rates"))?;

        let mut converted = BTreeMap::new();
        for (code, quote) in rates {
            let required = REQUIRED_CURRENCIES.contains(&code.as_str());
            // 上游真实响应里有 IRR 这类极端报价（反算后约 26 万 CNY），
            // 整轮拒绝会让自动汇率永远失败。处理规则：
            // * 必需币种（USD/EUR/JPY）越界/非数字 → 整轮失败，保留旧值；
            // * 其它币种越界/非数字/代码不合法 → 直接丢弃，不进入缓存。
            let Ok(currency) = validate_currency(code) else {
                continue;
            };
            let Some(quote) = quote.as_f64().filter(|value| value.is_finite()) else {
                if required {
                    return Err(FxError::InvalidRate(currency));
                }
                continue;
            };
            match invert_quote(&currency, quote) {
                Ok(rate) => {
                    converted.insert(currency, rate);
                }
                Err(error) => {
                    if required {
                        return Err(error);
                    }
                }
            }
        }
        Self::validated(
            BASE_CURRENCY.to_string(),
            converted,
            now,
            SOURCE_OPEN_ER_API.to_string(),
        )
    }

    /// 解析库里的存量值；形状/范围不合法返回 `None`（调用方按未配置处理）。
    pub fn from_stored(raw: &str) -> Option<Self> {
        let parsed: FxRates = serde_json::from_str(raw).ok()?;
        Self::validated(parsed.base, parsed.rates, parsed.fetched_at, parsed.source).ok()
    }

    /// 管理员手动覆盖：接受对象或 JSON 字符串，时间戳与来源由服务端重写。
    ///
    /// `fetched_at` 取 `now`、`source` 固定为 [`SOURCE_MANUAL`]：手动覆盖等同于
    /// 一次成功抓取，之后 24 小时内自动任务不会覆盖它；满 24 小时自动任务
    /// 仍会按周期抓取并覆盖（见 `docs/FX-AND-SERVER-HEALTH.md`）。
    pub fn from_manual(value: &Value, now: i64) -> Result<Self, FxError> {
        let value = match value {
            Value::String(raw) => serde_json::from_str(raw).map_err(|_| FxError::InvalidJson)?,
            other => other.clone(),
        };
        let object = value.as_object().ok_or(FxError::InvalidShape("root"))?;
        if object.get("base").and_then(Value::as_str) != Some(BASE_CURRENCY) {
            return Err(FxError::InvalidShape("base"));
        }
        let rates = object
            .get("rates")
            .and_then(Value::as_object)
            .ok_or(FxError::InvalidShape("rates"))?;
        let mut converted = BTreeMap::new();
        for (code, rate) in rates {
            let currency = validate_currency(code)?;
            let rate = rate
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| FxError::InvalidRate(currency.clone()))?;
            validate_rate_range(&currency, rate)?;
            converted.insert(currency, rate);
        }
        Self::validated(
            BASE_CURRENCY.to_string(),
            converted,
            now,
            SOURCE_MANUAL.to_string(),
        )
    }

    /// 序列化回 `settings.fx_rates`；只由校验过的有限数值构造，不会失败。
    pub fn to_stored(&self) -> String {
        serde_json::to_string(self).expect("FxRates 只包含可序列化的有限数值")
    }

    fn validated(
        base: String,
        rates: BTreeMap<String, f64>,
        fetched_at: i64,
        source: String,
    ) -> Result<Self, FxError> {
        if base != BASE_CURRENCY {
            return Err(FxError::InvalidShape("base"));
        }
        if rates.is_empty() {
            return Err(FxError::InvalidShape("rates"));
        }
        if fetched_at <= 0 {
            return Err(FxError::InvalidShape("fetched_at"));
        }
        if source.trim().is_empty() {
            return Err(FxError::InvalidShape("source"));
        }
        for code in REQUIRED_CURRENCIES {
            if !rates.contains_key(code) {
                return Err(FxError::MissingCurrency(code));
            }
        }
        for (code, rate) in &rates {
            validate_currency(code)?;
            if !rate.is_finite() {
                return Err(FxError::InvalidRate(code.clone()));
            }
            validate_rate_range(code, *rate)?;
        }
        Ok(Self {
            base,
            rates,
            fetched_at,
            source,
        })
    }
}

/// 缓存是否到期：缺失、时间戳非法或超过 [`REFRESH_SECS`] 才需要真正抓取。
///
/// 正好 24 小时不算「超过」；时钟回拨（时间戳在未来）也不重抓，避免刷接口。
pub fn is_due(existing: Option<&FxRates>, now: i64) -> bool {
    let Some(existing) = existing else {
        return true;
    };
    if existing.fetched_at <= 0 {
        return true;
    }
    now.saturating_sub(existing.fetched_at) > REFRESH_SECS
}

fn validate_currency(code: &str) -> Result<String, FxError> {
    let valid = code.len() == 3 && code.chars().all(|character| character.is_ascii_uppercase());
    if valid {
        Ok(code.to_string())
    } else {
        Err(FxError::InvalidCurrency(code.to_string()))
    }
}

/// 校验上游报价，并反算成 CNY per 外币。
fn invert_quote(currency: &str, quote: f64) -> Result<f64, FxError> {
    if !(MIN_RATE..=MAX_RATE).contains(&quote) {
        return Err(FxError::RateOutOfRange {
            currency: currency.to_string(),
            value: quote,
        });
    }
    let rate = 1.0 / quote;
    validate_rate_range(currency, rate)?;
    Ok(rate)
}

fn validate_rate_range(currency: &str, rate: f64) -> Result<(), FxError> {
    if (MIN_RATE..=MAX_RATE).contains(&rate) {
        Ok(())
    } else {
        Err(FxError::RateOutOfRange {
            currency: currency.to_string(),
            value: rate,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_RESPONSE: &str = r#"{
        "result": "success",
        "provider": "https://www.exchangerate-api.com",
        "documentation": "https://www.exchangerate-api.com/docs/free",
        "terms_of_use": "https://www.exchangerate-api.com/terms",
        "time_last_update_unix": 1763600000,
        "time_last_update_utc": "Thu, 20 Nov 2025 00:00:01 +0000",
        "time_next_update_unix": 1763686400,
        "time_eol_unix": 0,
        "base_code": "CNY",
        "rates": {
            "USD": 0.139,
            "EUR": 0.128,
            "JPY": 21.5,
            "GBP": 0.11
        }
    }"#;

    fn approx(left: f64, right: f64) {
        assert!((left - right).abs() < 1e-9, "expected {right}, got {left}");
    }

    #[test]
    fn real_response_shape_is_inverted_into_cny_rates() {
        let rates = FxRates::from_api(REAL_RESPONSE, 1_763_700_000).unwrap();
        assert_eq!(rates.base, "CNY");
        assert_eq!(rates.fetched_at, 1_763_700_000);
        assert_eq!(rates.source, SOURCE_OPEN_ER_API);
        approx(rates.rates["USD"], 1.0 / 0.139);
        approx(rates.rates["EUR"], 1.0 / 0.128);
        approx(rates.rates["JPY"], 1.0 / 21.5);
        approx(rates.rates["GBP"], 1.0 / 0.11);
        assert_eq!(
            rates.rates.keys().cloned().collect::<Vec<_>>(),
            vec!["EUR", "GBP", "JPY", "USD"],
            "BTreeMap 让序列化顺序稳定"
        );
    }

    #[test]
    fn out_of_range_quotes_are_rejected() {
        for quote in ["0.00001", "100000", "0", "-1"] {
            let raw = format!(
                r#"{{"result":"success","base_code":"CNY","rates":{{"USD":{quote},"EUR":0.12,"JPY":20}}}}"#
            );
            let error = FxRates::from_api(&raw, 1_763_700_000).unwrap_err();
            assert_eq!(error.code(), "fx.rate_out_of_range", "quote={quote}");
        }
    }

    /// 真实上游会带 IRR（1 CNY = 262554.719182 IRR），这类非必需币种必须被
    /// 丢弃，而不是让整轮抓取失败；必需币种越界仍然整轮失败。
    #[test]
    fn out_of_range_non_required_currencies_are_dropped_not_fatal() {
        let raw = r#"{
            "result": "success",
            "base_code": "CNY",
            "rates": {
                "USD": 0.149403,
                "EUR": 0.136285,
                "JPY": 23.762728,
                "IRR": 262554.719182,
                "XXX": 0
            }
        }"#;
        let rates = FxRates::from_api(raw, 1_763_700_000).unwrap();
        assert_eq!(
            rates.rates.keys().cloned().collect::<Vec<_>>(),
            vec!["EUR", "JPY", "USD"],
            "极端非必需币种不能拖垮整轮抓取"
        );
        assert!(!rates.rates.contains_key("IRR"));

        // 必需币种越界仍然整轮失败。
        let raw = r#"{"result":"success","base_code":"CNY",
                      "rates":{"USD":0.0000001,"EUR":0.128,"JPY":21.5}}"#;
        assert_eq!(
            FxRates::from_api(raw, 1_763_700_000).unwrap_err().code(),
            "fx.rate_out_of_range"
        );
    }

    #[test]
    fn missing_required_currency_is_rejected() {
        for missing in REQUIRED_CURRENCIES {
            let mut rates = serde_json::json!({"USD": 0.139, "EUR": 0.128, "JPY": 21.5});
            rates.as_object_mut().unwrap().remove(missing);
            let raw = serde_json::json!({
                "result": "success",
                "base_code": "CNY",
                "rates": rates,
            })
            .to_string();
            let error = FxRates::from_api(&raw, 1_763_700_000).unwrap_err();
            assert_eq!(error.code(), "fx.missing_currency", "missing={missing}");
            assert!(error.message().contains(missing));
        }
    }

    #[test]
    fn non_success_or_non_cny_bases_are_rejected() {
        for raw in [
            r#"{"result":"error","base_code":"CNY","rates":{"USD":0.139,"EUR":0.12,"JPY":20}}"#,
            r#"{"result":"success","base_code":"USD","rates":{"USD":0.139,"EUR":0.12,"JPY":20}}"#,
            r#"{"result":"success","base_code":"CNY","rates":[]}"#,
            r#"{"result":"success","base_code":"CNY"}"#,
        ] {
            let error = FxRates::from_api(raw, 1_763_700_000).unwrap_err();
            assert_eq!(error.code(), "fx.invalid_shape", "raw={raw}");
        }
    }

    #[test]
    fn malformed_json_is_rejected() {
        for raw in ["", "not json", "[]", "null"] {
            let error = FxRates::from_api(raw, 1_763_700_000).unwrap_err();
            assert!(
                matches!(error, FxError::InvalidJson | FxError::InvalidShape(_)),
                "raw={raw} error={error:?}"
            );
        }
    }

    #[test]
    fn only_https_sources_are_allowed() {
        assert!(validate_api_url(API_URL).is_ok());
        assert!(validate_api_url("https://example.com/v6/latest/CNY").is_ok());
        for url in [
            "http://open.er-api.com/v6/latest/CNY",
            "ftp://open.er-api.com/v6/latest/CNY",
            "open.er-api.com/v6/latest/CNY",
            "https://",
            " https://example.com",
            "https://exa mple.com",
            "",
        ] {
            assert_eq!(
                validate_api_url(url).unwrap_err().code(),
                "fx.not_https",
                "url={url}"
            );
        }
    }

    #[test]
    fn due_rules_cover_missing_fresh_exact_and_expired() {
        let now = 1_763_700_000;
        assert!(is_due(None, now), "缺失时必须抓");
        let fresh = FxRates::from_api(REAL_RESPONSE, now - 60).unwrap();
        assert!(!is_due(Some(&fresh), now), "刚抓过不重抓");
        let almost = FxRates::from_api(REAL_RESPONSE, now - REFRESH_SECS).unwrap();
        assert!(
            !is_due(Some(&almost), now),
            "正好 24 小时不算「超过」，下一轮再抓"
        );
        let expired = FxRates::from_api(REAL_RESPONSE, now - REFRESH_SECS - 1).unwrap();
        assert!(is_due(Some(&expired), now), "超过 24 小时必须抓");
        let future = FxRates::from_api(REAL_RESPONSE, now + 3_600).unwrap();
        assert!(!is_due(Some(&future), now), "时钟回拨不能变成抓取风暴");
    }

    #[test]
    fn stored_json_round_trips() {
        let rates = FxRates::from_api(REAL_RESPONSE, 1_763_700_000).unwrap();
        let stored = rates.to_stored();
        let parsed = FxRates::from_stored(&stored).expect("存量值必须能读回");
        assert_eq!(parsed, rates);
        assert!(stored.contains(r#""base":"CNY""#));
        assert!(stored.contains(r#""source":"open.er-api.com""#));

        for broken in [
            "",
            "{}",
            r#"{"base":"CNY","rates":{},"fetched_at":1,"source":"x"}"#,
            r#"{"base":"CNY","rates":{"USD":0,"EUR":7.8,"JPY":0.048},"fetched_at":1,"source":"x"}"#,
            r#"{"base":"CNY","rates":{"USD":7.2,"EUR":7.8,"JPY":0.048},"fetched_at":0,"source":"x"}"#,
        ] {
            assert!(FxRates::from_stored(broken).is_none(), "broken={broken}");
        }
    }

    #[test]
    fn manual_override_rewrites_timestamp_and_source() {
        let value = serde_json::json!({
            "base": "CNY",
            "rates": {"USD": 7.2, "EUR": 7.8, "JPY": 0.048},
            "fetched_at": 1,
            "source": "open.er-api.com"
        });
        let rates = FxRates::from_manual(&value, 1_763_700_000).unwrap();
        assert_eq!(rates.fetched_at, 1_763_700_000);
        assert_eq!(rates.source, SOURCE_MANUAL);
        approx(rates.rates["USD"], 7.2);

        // 也接受 JSON 字符串（GET 就是这么回显的）。
        let as_string = Value::String(value.to_string());
        assert_eq!(
            FxRates::from_manual(&as_string, 1_763_700_000).unwrap(),
            rates
        );
    }

    #[test]
    fn manual_override_rejects_the_same_bad_values_as_stored_data() {
        for value in [
            serde_json::json!({"base": "USD", "rates": {"USD": 7.2, "EUR": 7.8, "JPY": 0.048}}),
            serde_json::json!({"base": "CNY", "rates": {"USD": 7.2, "EUR": 7.8}}),
            serde_json::json!({"base": "CNY", "rates": {"USD": 0.0, "EUR": 7.8, "JPY": 0.048}}),
            serde_json::json!({"base": "CNY", "rates": {"usd": 7.2, "EUR": 7.8, "JPY": 0.048}}),
            serde_json::json!({"base": "CNY"}),
            serde_json::json!(null),
        ] {
            assert!(
                FxRates::from_manual(&value, 1_763_700_000).is_err(),
                "value={value}"
            );
        }
    }
}
