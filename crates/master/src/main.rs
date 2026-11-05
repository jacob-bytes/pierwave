mod app;
mod auth;
mod enforcement;
mod error;
mod routes;
mod scheduler;
mod state;
mod throttle;

use std::net::SocketAddr;

use anyhow::Context;
use mmrust_domain::Db;

use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,mmrust_master=debug,tower_http=debug".into()),
        )
        .init();

    let db_url =
        std::env::var("MMRUST_DB").unwrap_or_else(|_| "sqlite://data/mmrust.db?mode=rwc".into());
    let addr: SocketAddr = std::env::var("MMRUST_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8787".into())
        .parse()
        .context("MMRUST_ADDR 不是合法地址")?;
    let web_dir = std::env::var("MMRUST_WEB_DIR").unwrap_or_else(|_| "web/dist".into());

    let db = Db::connect(&db_url).await?;
    db.migrate().await?;

    if let Some(generated) = db
        .ensure_admin(std::env::var("MMRUST_ADMIN_PASSWORD").ok())
        .await?
    {
        tracing::warn!("已创建初始管理员 admin，密码：{generated}（请立刻修改）");
    }

    let state = AppState::new(db, &web_dir);
    // 每日重置：每小时检查一次，启动后立即跑第一轮。
    let _reset_task = scheduler::spawn_daily_reset(state.clone());
    // 过期会话清理：每小时一轮，启动时先跑一次。
    let _session_purge = scheduler::spawn_session_purge(state.clone());
    // 断流：流量上报实时标记 + 每 5 分钟过期对账，统一交给去抖 worker 收敛。
    let _enforce_worker = enforcement::spawn_worker(state.clone());
    let _enforce_reconcile = scheduler::spawn_enforcement_reconcile(state.clone());
    let app = app::router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{addr}, web dir = {web_dir}");
    // 开启 ConnectInfo，登录限流在拿不到 X-Forwarded-For 时回落到真实对端 IP。
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
