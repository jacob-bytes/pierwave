//! 自动汇率：后台抓取 `open.er-api.com` 并缓存到 `settings.fx_rates`。
//!
//! 三个必须遵守的约束（所有者要求）：
//!
//! 1. **绝不阻塞请求/启动**：抓取只在后台任务里跑，`GET /settings` 永远只读缓存；
//! 2. **失败保留旧值**：网络/解析/范围任何一步失败都只 `warn`，不覆盖已有汇率；
//! 3. **测试不联网**：生产用系统 `curl`（与版本检测/告警同一套取舍，不新增 HTTP
//!    客户端依赖），测试注入 [`StaticFetcher`] 或假 curl 脚本。
//!
//! 调度节奏：启动后立即跑一轮（缺失或超过 24h 才真抓），之后每 6 小时检查一次。
//! 手动覆盖（`PATCH /settings`）与自动抓取共用一把异步锁，保证「先到先得」：
//! 手动写入后 24 小时内自动任务不会覆盖；满 24 小时后仍按周期抓取并覆盖。
//! 详见 `docs/FX-AND-SERVER-HEALTH.md`。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use pierwave_domain::fx::{self, FxError, FxRates};
use pierwave_domain::{repo, time};

use crate::state::AppState;

/// 调度器检查间隔：6 小时看一次是否超过 24h。
pub const CHECK_INTERVAL: Duration = Duration::from_secs(fx::CHECK_INTERVAL_SECS as u64);

/// curl 的硬超时：接口正常几百毫秒，5 秒足够覆盖慢网。
const FETCH_MAX_TIME_SECS: &str = "5";
const FETCH_CONNECT_TIME_SECS: &str = "5";

pub type FxFetchFuture<'a> = Pin<Box<dyn Future<Output = Result<String, FxError>> + Send + 'a>>;

/// 抓取汇率响应原文的抽象；测试注入固定响应，绝不联网。
pub trait FxFetcher: Send + Sync {
    fn fetch<'a>(&'a self) -> FxFetchFuture<'a>;
}

/// 生产实现：系统 `curl`，只允许 https，带 5 秒超时与响应体上限。
#[derive(Debug, Clone)]
pub struct CurlFxFetcher {
    pub url: String,
    /// curl 可执行文件；生产固定是 `curl`，测试注入假脚本。
    pub program: String,
}

impl Default for CurlFxFetcher {
    fn default() -> Self {
        Self {
            url: fx::API_URL.to_string(),
            program: "curl".to_string(),
        }
    }
}

impl FxFetcher for CurlFxFetcher {
    fn fetch<'a>(&'a self) -> FxFetchFuture<'a> {
        Box::pin(async move {
            fx::validate_api_url(&self.url)?;
            fetch_over_curl(&self.program, &self.url).await
        })
    }
}

async fn fetch_over_curl(program: &str, url: &str) -> Result<String, FxError> {
    let user_agent = format!("pierwave-master/{}", env!("CARGO_PKG_VERSION"));
    let max_filesize = crate::outbound::max_filesize_arg();
    // `-w '\n%{http_code}'`：body 写 stdout，最后一行追加 HTTP 状态码。
    // `--proto =https`：即使调用方传了别的 scheme，curl 也会拒绝。
    let output = tokio::process::Command::new(program)
        .args([
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--connect-timeout",
            FETCH_CONNECT_TIME_SECS,
            "--max-time",
            FETCH_MAX_TIME_SECS,
            "--max-filesize",
            &max_filesize,
            "-H",
            "Accept: application/json",
            "-H",
            &format!("User-Agent: {user_agent}"),
            "-o",
            "-",
            "-w",
            "\n%{http_code}",
            url,
        ])
        .output()
        .await
        .map_err(|error| FxError::Network(truncate(&format!("无法执行 curl：{error}"))))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        // curl 28 = operation timeout（--max-time 触发）。
        if output.status.code() == Some(28) {
            return Err(FxError::Timeout);
        }
        // curl 63 = CURLE_FILESIZE_EXCEEDED（--max-filesize 触发）。
        if output.status.code() == Some(63) {
            return Err(FxError::Network(crate::outbound::too_large("汇率响应过大")));
        }
        let detail = if stderr.is_empty() {
            format!("curl 退出码 {:?}", output.status.code())
        } else {
            truncate(stderr)
        };
        return Err(FxError::Network(detail));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let (body, status) = match stdout.rsplit_once('\n') {
        Some((body, status)) => {
            if crate::outbound::exceeded(body.len() as u64) {
                return Err(FxError::Network(crate::outbound::too_large("汇率响应过大")));
            }
            (body.to_string(), status.trim().parse::<u16>().ok())
        }
        None => {
            if crate::outbound::exceeded(stdout.len() as u64) {
                return Err(FxError::Network(crate::outbound::too_large("汇率响应过大")));
            }
            (stdout.to_string(), None)
        }
    };
    match status {
        Some(status) if (200..300).contains(&status) => Ok(body),
        Some(status) => Err(FxError::Http(status)),
        None => Err(FxError::Network(
            "curl 没有返回 HTTP 状态码 / curl returned no HTTP status".to_string(),
        )),
    }
}

fn truncate(value: &str) -> String {
    value.trim().chars().take(200).collect()
}

/// 一轮抓取的结果；日志与测试都靠它区分状态。
#[derive(Debug, Clone, PartialEq)]
pub enum FxRound {
    /// 缺失/过期判断为「还没到 24h」，没有发起网络请求。
    NotDue,
    /// 抓取、校验并写库成功。
    Refreshed { fetched_at: i64, currencies: usize },
    /// 失败；旧缓存保持不变。`message` 只用于日志，不含响应正文。
    Failed(String),
}

/// 汇率抓取服务：可注入的 fetcher + 串行化手动覆盖/自动抓取的异步锁。
#[derive(Clone)]
pub struct FxService {
    fetcher: Arc<dyn FxFetcher>,
    /// 手动覆盖与自动抓取共用：保证「谁先写入谁生效」的可解释顺序。
    ///
    /// 自动抓取在持锁期间完成「读缓存 → 判断过期 → 联网 → 写库」，手动覆盖
    /// 在持锁期间完成写库，因此不存在「手动刚覆盖、旧抓取结果又把它盖回去」。
    lock: Arc<tokio::sync::Mutex<()>>,
}

impl Default for FxService {
    fn default() -> Self {
        Self::new(Arc::new(CurlFxFetcher::default()))
    }
}

impl FxService {
    pub fn new(fetcher: Arc<dyn FxFetcher>) -> Self {
        Self {
            fetcher,
            lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    /// 拿锁：自动抓取与手动覆盖都用它串行化。
    pub async fn lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.lock.lock().await
    }
}

/// 执行一轮：缺失或超过 24h 才真正抓取；失败保留旧值并记 warn。
///
/// 返回 `Ok(Failed)` 而不是 `Err`：网络/校验失败是预期内的业务结果，不应让
/// 调用方（后台循环）误以为数据库坏了。只有数据库读取失败才返回 `Err`。
pub async fn run_round(state: &AppState, now: i64) -> anyhow::Result<FxRound> {
    // 自动抓取与手动覆盖串行化；锁只在这一轮内持有。
    let _guard = state.fx.lock().await;

    let stored = repo::settings::get(&state.db.pool, fx::FX_RATES_KEY).await?;
    let current = match stored.as_deref() {
        Some(raw) => match FxRates::from_stored(raw) {
            Some(rates) => Some(rates),
            None => {
                tracing::warn!(
                    key = fx::FX_RATES_KEY,
                    "存量汇率不是合法 JSON，按未配置处理；本轮会尝试重新抓取"
                );
                None
            }
        },
        None => None,
    };
    if !fx::is_due(current.as_ref(), now) {
        return Ok(FxRound::NotDue);
    }

    let outcome = state.fx.fetcher.fetch().await;
    let raw = match outcome {
        Ok(raw) => raw,
        Err(error) => {
            tracing::warn!(
                code = error.code(),
                error = %error.message(),
                "汇率抓取失败，保留旧值 / FX fetch failed, keeping the previous rates"
            );
            return Ok(FxRound::Failed(error.message()));
        }
    };
    let rates = match FxRates::from_api(&raw, now) {
        Ok(rates) => rates,
        Err(error) => {
            tracing::warn!(
                code = error.code(),
                error = %error.message(),
                "汇率响应校验失败，保留旧值 / FX response rejected, keeping the previous rates"
            );
            return Ok(FxRound::Failed(error.message()));
        }
    };

    repo::settings::set(&state.db.pool, fx::FX_RATES_KEY, &rates.to_stored()).await?;
    tracing::info!(
        fetched_at = rates.fetched_at,
        currencies = rates.rates.len(),
        source = %rates.source,
        "汇率已更新 / FX rates refreshed"
    );
    Ok(FxRound::Refreshed {
        fetched_at: rates.fetched_at,
        currencies: rates.rates.len(),
    })
}

/// 启动汇率任务：第一次 tick 立即执行（缺失/过期才真抓），之后每 6 小时检查。
///
/// 抓取在 spawn 出去的任务里，**启动路径不会 await 网络**；即使接口不可达也
/// 只落一条 warn，不影响主控启动。
pub fn spawn(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(CHECK_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match run_round(&state, time::now()).await {
                Ok(FxRound::Refreshed { currencies, .. }) => {
                    tracing::info!(currencies, "汇率后台任务完成一轮")
                }
                Ok(FxRound::NotDue) => tracing::debug!("汇率缓存未超过 24h，跳过本轮"),
                Ok(FxRound::Failed(message)) => {
                    tracing::warn!(error = %message, "汇率后台任务失败，旧值继续生效")
                }
                Err(error) => tracing::error!(error = %error, "汇率后台任务读写设置失败"),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use pierwave_domain::Db;

    /// 固定响应队列；用空队列证明「没有网络也能启动/读设置」。
    struct StaticFetcher {
        responses: Mutex<VecDeque<Result<String, FxError>>>,
        calls: AtomicUsize,
    }

    impl StaticFetcher {
        fn new(responses: Vec<Result<String, FxError>>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                calls: AtomicUsize::new(0),
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl FxFetcher for StaticFetcher {
        fn fetch<'a>(&'a self) -> FxFetchFuture<'a> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.responses
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .pop_front()
                    .unwrap_or_else(|| Err(FxError::Network("测试没有更多模拟响应".to_string())))
            })
        }
    }

    fn response(usd: f64) -> String {
        format!(
            r#"{{"result":"success","base_code":"CNY","rates":{{"USD":{usd},"EUR":0.128,"JPY":21.5}}}}"#
        )
    }

    async fn setup(responses: Vec<Result<String, FxError>>) -> (AppState, Arc<StaticFetcher>) {
        let db = Db::connect("sqlite::memory:").await.unwrap();
        db.migrate().await.unwrap();
        let fetcher = Arc::new(StaticFetcher::new(responses));
        let mut state = AppState::new(db, "web/dist");
        state.fx = FxService::new(fetcher.clone());
        (state, fetcher)
    }

    async fn stored(state: &AppState) -> Option<FxRates> {
        repo::settings::get(&state.db.pool, fx::FX_RATES_KEY)
            .await
            .unwrap()
            .as_deref()
            .and_then(FxRates::from_stored)
    }

    #[tokio::test]
    async fn missing_cache_is_fetched_once_and_persisted_with_the_schema() {
        let now = 1_763_700_000;
        let (state, fetcher) = setup(vec![Ok(response(0.139))]).await;

        let round = run_round(&state, now).await.unwrap();
        assert_eq!(
            round,
            FxRound::Refreshed {
                fetched_at: now,
                currencies: 3
            }
        );
        assert_eq!(fetcher.calls(), 1);

        let rates = stored(&state).await.expect("必须写库");
        assert_eq!(rates.base, "CNY");
        assert_eq!(rates.fetched_at, now);
        assert_eq!(rates.source, "open.er-api.com");
        assert!((rates.rates["USD"] - 1.0 / 0.139).abs() < 1e-9);

        // 设置接口看到的是同一份值与时间戳。
        let settings = crate::routes::settings::load(&state.db).await;
        assert_eq!(settings.fx_rates_updated_at, now);
        assert_eq!(
            settings.fx_rates,
            repo::settings::get(&state.db.pool, fx::FX_RATES_KEY)
                .await
                .unwrap()
                .unwrap()
        );

        // 刚抓过：3 小时后再检查也不联网。
        assert_eq!(
            run_round(&state, now + 3 * 3600).await.unwrap(),
            FxRound::NotDue
        );
        assert_eq!(fetcher.calls(), 1);
    }

    #[tokio::test]
    async fn expired_cache_is_refetched_after_24h() {
        let now = 1_763_700_000;
        let (state, fetcher) = setup(vec![Ok(response(0.139)), Ok(response(0.2))]).await;
        run_round(&state, now).await.unwrap();

        // 正好 24h：不算「超过」，不重抓。
        assert_eq!(
            run_round(&state, now + fx::REFRESH_SECS).await.unwrap(),
            FxRound::NotDue
        );
        assert_eq!(fetcher.calls(), 1);

        assert!(matches!(
            run_round(&state, now + fx::REFRESH_SECS + 1).await.unwrap(),
            FxRound::Refreshed { .. }
        ));
        assert_eq!(fetcher.calls(), 2);
        let rates = stored(&state).await.unwrap();
        assert!((rates.rates["USD"] - 5.0).abs() < 1e-9, "必须换成新值");
    }

    #[tokio::test]
    async fn network_failure_keeps_the_previous_rates() {
        let now = 1_763_700_000;
        let (state, fetcher) = setup(vec![
            Ok(response(0.139)),
            Err(FxError::Timeout),
            Err(FxError::Http(503)),
            Err(FxError::Network("connection reset".into())),
        ])
        .await;
        run_round(&state, now).await.unwrap();
        let before = stored(&state).await.unwrap();

        for offset in [1, 2, 3] {
            let round = run_round(&state, now + offset * fx::REFRESH_SECS + 1)
                .await
                .unwrap();
            assert!(
                matches!(round, FxRound::Failed(_)),
                "网络失败是业务结果，不是 Err：{round:?}"
            );
            assert_eq!(
                stored(&state).await.unwrap(),
                before,
                "失败绝不能覆盖已有汇率"
            );
        }
        assert_eq!(fetcher.calls(), 4);
    }

    #[tokio::test]
    async fn invalid_upstream_shapes_keep_the_previous_rates() {
        let now = 1_763_700_000;
        let (state, _fetcher) = setup(vec![
            Ok(response(0.139)),
            // 报价越界
            Ok(response(0.00001)),
            // 缺 JPY
            Ok(
                r#"{"result":"success","base_code":"CNY","rates":{"USD":0.139,"EUR":0.128}}"#
                    .into(),
            ),
            // 非 JSON
            Ok("not json".into()),
        ])
        .await;
        run_round(&state, now).await.unwrap();
        let before = stored(&state).await.unwrap();

        for offset in [1, 2, 3] {
            assert!(matches!(
                run_round(&state, now + offset * fx::REFRESH_SECS + 1)
                    .await
                    .unwrap(),
                FxRound::Failed(_)
            ));
            assert_eq!(stored(&state).await.unwrap(), before);
        }
    }

    /// 非 https 在发请求之前就被拒绝，旧值不变。
    #[tokio::test]
    async fn non_https_source_never_fetches_and_keeps_old_rates() {
        let now = 1_763_700_000;
        let (mut state, _fetcher) = setup(vec![Ok(response(0.139))]).await;
        run_round(&state, now).await.unwrap();
        let before = stored(&state).await.unwrap();

        state.fx = FxService::new(Arc::new(CurlFxFetcher {
            url: "http://open.er-api.com/v6/latest/CNY".to_string(),
            program: "curl".to_string(),
        }));
        let round = run_round(&state, now + fx::REFRESH_SECS + 1).await.unwrap();
        match round {
            FxRound::Failed(message) => assert!(message.contains("https"), "{message}"),
            other => panic!("非 https 必须是失败：{other:?}"),
        }
        assert_eq!(stored(&state).await.unwrap(), before);
    }

    /// 假 curl 返回退出码 28：映射成 Timeout，旧值不变（不真的等 5 秒）。
    #[cfg(unix)]
    #[tokio::test]
    async fn curl_timeout_is_reported_and_keeps_old_rates() {
        use std::os::unix::fs::PermissionsExt;

        let now = 1_763_700_000;
        let (mut state, _fetcher) = setup(vec![Ok(response(0.139))]).await;
        run_round(&state, now).await.unwrap();
        let before = stored(&state).await.unwrap();

        let dir =
            std::env::temp_dir().join(format!("pierwave-fx-timeout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("fake-curl.sh");
        // 模拟 curl 28（operation timeout），不产生任何输出。
        std::fs::write(&script, "#!/bin/sh\nexit 28\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        state.fx = FxService::new(Arc::new(CurlFxFetcher {
            url: "https://example.invalid/v6/latest/CNY".to_string(),
            program: script.to_string_lossy().into_owned(),
        }));
        let round = run_round(&state, now + fx::REFRESH_SECS + 1).await.unwrap();
        match round {
            FxRound::Failed(message) => assert!(message.contains("超时"), "{message}"),
            other => panic!("超时必须判失败：{other:?}"),
        }
        assert_eq!(stored(&state).await.unwrap(), before);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// 手动覆盖后 24h 内自动任务不覆盖；满 24h 后自动任务重新接管。
    #[tokio::test]
    async fn manual_override_wins_for_24h_then_automatic_fetch_takes_over() {
        let now = 1_763_700_000;
        let (state, fetcher) = setup(vec![Ok(response(0.2))]).await;

        let manual = FxRates::from_manual(
            &serde_json::json!({
                "base": "CNY",
                "rates": {"USD": 7.2, "EUR": 7.8, "JPY": 0.048}
            }),
            now,
        )
        .unwrap();
        repo::settings::set(&state.db.pool, fx::FX_RATES_KEY, &manual.to_stored())
            .await
            .unwrap();

        // 3 小时后：手动值仍有效，不联网。
        assert_eq!(
            run_round(&state, now + 3 * 3600).await.unwrap(),
            FxRound::NotDue
        );
        assert_eq!(fetcher.calls(), 0);
        assert_eq!(stored(&state).await.unwrap().source, fx::SOURCE_MANUAL);

        // 超过 24 小时：自动抓取覆盖手动值（已在文档里说明此行为）。
        assert!(matches!(
            run_round(&state, now + fx::REFRESH_SECS + 1).await.unwrap(),
            FxRound::Refreshed { .. }
        ));
        assert_eq!(fetcher.calls(), 1);
        let rates = stored(&state).await.unwrap();
        assert_eq!(rates.source, fx::SOURCE_OPEN_ER_API);
        assert!((rates.rates["USD"] - 5.0).abs() < 1e-9);
    }

    /// 启动路径不抓取：没有模拟响应也不会阻塞/失败，设置接口照常返回。
    #[tokio::test]
    async fn startup_reads_settings_without_touching_the_network() {
        let (_state, fetcher) = setup(Vec::new()).await;
        assert_eq!(fetcher.calls(), 0, "构造 AppState 不能联网");

        let settings = crate::routes::settings::load(&_state.db).await;
        assert_eq!(settings.fx_rates, "");
        assert_eq!(settings.fx_rates_updated_at, 0);
        assert_eq!(fetcher.calls(), 0, "读设置不能联网");
    }

    #[test]
    fn scheduler_checks_every_six_hours() {
        assert_eq!(CHECK_INTERVAL, Duration::from_secs(6 * 3600));
        assert_eq!(fx::REFRESH_SECS, 24 * 3600);
    }
}
