mod app;
mod auth;
mod error;
mod routes;
mod state;

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
    let app = app::router(state);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("listening on http://{addr}, web dir = {web_dir}");
    axum::serve(listener, app).await?;
    Ok(())
}
