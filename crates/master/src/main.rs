mod app;
mod audit;
mod auth;
mod enforcement;
mod error;
mod routes;
mod scheduler;
mod state;
mod throttle;

use std::net::SocketAddr;

use anyhow::Context;
use pierwave_domain::Db;

use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    // 运维/验证用的小工具入口：
    //   pierwave-master --derive-reality-key <base64-private-key>
    // 用真实 Xray 的 `xray x25519 -i` 对照，确认我们的公钥反推没有算错。
    if let Some(pos) = args.iter().position(|arg| arg == "--derive-reality-key") {
        let private = args
            .get(pos + 1)
            .context("用法: pierwave-master --derive-reality-key <base64-private-key>")?;
        match pierwave_domain::reality::public_key_from_private(private) {
            Some(public) => {
                println!("{public}");
                return Ok(());
            }
            None => anyhow::bail!("无法解析该私钥"),
        }
    }

    // 发布相关的小工具（CI 与安装脚本使用）：
    //   pierwave-master sign-release <私钥 base64 或环境变量 PIERWAVE_RELEASE_SIGNING_KEY> <清单> <签名输出>
    //   pierwave-master verify-release <清单> <签名> [公钥 base64]
    if let Some(pos) = args.iter().position(|arg| arg == "sign-release") {
        let secret = args
            .get(pos + 1)
            .cloned()
            .or_else(|| std::env::var("PIERWAVE_RELEASE_SIGNING_KEY").ok())
            .context("缺少签名私钥：参数或 PIERWAVE_RELEASE_SIGNING_KEY")?;
        let manifest_path = args.get(pos + 2).context("缺少清单路径")?;
        let out_path = args.get(pos + 3).context("缺少签名输出路径")?;
        let manifest = std::fs::read_to_string(manifest_path).context("读取清单失败")?;
        let signature = pierwave_domain::release::sign_manifest(&secret, &manifest)?;
        std::fs::write(out_path, format!("{signature}\n"))?;
        eprintln!("signature written to {out_path}");
        return Ok(());
    }
    if let Some(pos) = args.iter().position(|arg| arg == "verify-release") {
        let manifest_path = args.get(pos + 1).context("缺少清单路径")?;
        let sig_path = args.get(pos + 2).context("缺少签名路径")?;
        let manifest = std::fs::read_to_string(manifest_path).context("读取清单失败")?;
        let signature = std::fs::read_to_string(sig_path).context("读取签名失败")?;
        let public = args
            .get(pos + 3)
            .cloned()
            .unwrap_or_else(|| pierwave_domain::release::embedded_public_key().to_string());
        pierwave_domain::release::verify_manifest(&manifest, &signature, &public)?;
        println!("ok");
        return Ok(());
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,pierwave_master=debug,tower_http=debug".into()),
        )
        .init();

    let db_url = std::env::var("PIERWAVE_DB")
        .unwrap_or_else(|_| "sqlite://data/pierwave.db?mode=rwc".into());
    let addr: SocketAddr = std::env::var("PIERWAVE_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8787".into())
        .parse()
        .context("PIERWAVE_ADDR 不是合法地址")?;
    let web_dir = std::env::var("PIERWAVE_WEB_DIR").unwrap_or_else(|_| "web/dist".into());

    let db = Db::connect(&db_url).await?;
    db.migrate().await?;

    if let Some(generated) = db
        .ensure_admin(std::env::var("PIERWAVE_ADMIN_PASSWORD").ok())
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
    let _upgrade_sweep = scheduler::spawn_upgrade_sweep(state.clone());
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
