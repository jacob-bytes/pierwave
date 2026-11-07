//! Agent 自升级：下载 → 验签 → 落盘 → 看门狗 → 重启。
//!
//! 顺序不可调换：三个文件都先读进内存，**先验清单签名、再核对产物 sha256**，
//! 校验通过前不碰线上二进制。替换用同目录 `.new` + `rename`，保证任何时刻
//! 线上文件要么是旧版本、要么是完整的新版本，不会出现写了一半的二进制。
//!
//! 看门狗是这套流程的安全网：升级前用 `systemd-run --on-active=<secs>` 注册一个
//! 独立 timer，超时后执行本程序的 `--rollback-check <ok> <backup>`；新版本启动后
//! 只有在**连上主控并收到 Ack** 时才写 `upgrade-ok`，没有标记就把 `.bak` 换回去。
//!
//! helper 用 `state_dir/rollback-helper`（刚校验过的新二进制的副本），而不是直接
//! 指向当前路径：这样即使替换失败、或者升级前的旧版本还不认识 `--rollback-check`，
//! 到点执行的也是能跑回滚逻辑的二进制，不会意外启动第二个 Agent。
//! 代价是如果新二进制根本加载不起来，helper 也跑不起来——这是自升级的固有边界。

use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use anyhow::{anyhow, bail, Context, Result};
use pierwave_domain::release::{is_newer, verify_asset, verify_manifest};
use pierwave_proto::AgentUpgradePlan;

/// 升级成功标记：新版本收到主控 Ack 后写入。
pub const OK_MARKER_FILE: &str = "upgrade-ok";
/// 升级进行中标记：替换前写入，用来告诉重启后的新进程「这次启动需要确认」。
pub const PENDING_MARKER_FILE: &str = "upgrade-pending";
/// 看门狗 helper 的落盘位置（新二进制的副本）。
const ROLLBACK_HELPER_FILE: &str = "rollback-helper";
/// 旧二进制备份后缀；helper 靠它反推线上路径。
const BACKUP_SUFFIX: &str = ".bak";
/// 新二进制临时文件后缀；与线上文件同目录，保证 rename 原子。
const NEW_SUFFIX: &str = ".new";

pub const DEFAULT_RESTART_COMMAND: &str = "systemctl restart pierwave-agent";
pub const DEFAULT_WATCHDOG_SECS: u64 = 120;
pub const DEFAULT_WATCHDOG_UNIT: &str = "pierwave-agent-rollback";

/// 下载抽象：测试用假实现，生产用系统 `curl`（安装脚本本来就依赖它）。
///
/// 不用 reqwest 是为了不把 TLS 栈塞进 musl 静态二进制；Agent 只需要 GET 三个
/// 主控给的 URL，curl 已经能满足，且失败信息对运维更直观。
pub type DownloadFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<u8>>> + Send + 'a>>;

pub trait Downloader {
    fn download<'a>(&'a self, url: &'a str) -> DownloadFuture<'a>;
}

#[derive(Debug, Clone)]
pub struct HttpDownloader {
    program: String,
}

impl Default for HttpDownloader {
    fn default() -> Self {
        Self {
            program: "curl".into(),
        }
    }
}

impl HttpDownloader {
    #[allow(dead_code)] // 预留给「系统里 curl 不叫 curl」的部署
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
        }
    }
}

impl Downloader for HttpDownloader {
    fn download<'a>(&'a self, url: &'a str) -> DownloadFuture<'a> {
        Box::pin(async move {
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                bail!("升级下载地址必须是 http(s)：{url}");
            }
            let out = tokio::process::Command::new(&self.program)
                .args([
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--location",
                    "--proto",
                    "=http,https",
                    "--connect-timeout",
                    "10",
                    "--max-time",
                    "300",
                    url,
                ])
                .output()
                .await
                .with_context(|| format!("无法执行 `{}` 下载升级文件", self.program))?;
            if !out.status.success() {
                let detail = crate::command_output(&out);
                if detail.is_empty() {
                    bail!("下载 {url} 失败（{}）", out.status);
                }
                bail!("下载 {url} 失败（{}）：{detail}", out.status);
            }
            Ok(out.stdout)
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpgradeOutcome {
    /// 目标版本不新于当前版本；重复下发是幂等的。
    Noop,
    /// 二进制已替换、重启命令已执行；调用方应退出当前进程。
    Upgraded { version: String },
}

#[derive(Debug, Clone)]
pub struct WatchdogConfig {
    pub program: String,
    pub unit: String,
    pub delay_secs: u64,
}

#[derive(Debug, Clone)]
pub struct UpgradeContext {
    pub current_version: String,
    pub current_exe: PathBuf,
    pub state_dir: PathBuf,
    pub restart_command: String,
    pub public_key: String,
    /// `None` = 显式关闭（容器/测试）；`Some` 但系统没有 systemd 时也会跳过。
    pub watchdog: Option<WatchdogConfig>,
}

/// 纯逻辑：目标版本比当前新才升级。
pub fn should_upgrade(plan_version: &str, current_version: &str) -> bool {
    is_newer(plan_version, current_version)
}

/// 纯逻辑：ok 标记不存在时才回滚。
pub fn should_rollback(ok_marker_exists: bool) -> bool {
    !ok_marker_exists
}

/// 从下载 URL 的最后一段取产物名，供 `SHA256SUMS` 查表。
pub fn asset_name_from_url(url: &str) -> Result<String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let name = path.rsplit('/').next().unwrap_or("");
    if name.is_empty() || name == "." || name == ".." || name.contains('\\') {
        bail!("无法从升级地址解析产物名：{url}");
    }
    Ok(name.to_string())
}

/// 主流程：只有校验全部通过才会写磁盘。
pub async fn run<D: Downloader + ?Sized>(
    plan: &AgentUpgradePlan,
    ctx: &UpgradeContext,
    downloader: &D,
) -> Result<UpgradeOutcome> {
    if !should_upgrade(&plan.version, &ctx.current_version) {
        tracing::info!(
            target_version = %plan.version,
            current = %ctx.current_version,
            "agent upgrade skipped: target is not newer"
        );
        return Ok(UpgradeOutcome::Noop);
    }

    std::fs::create_dir_all(&ctx.state_dir)
        .with_context(|| format!("创建升级状态目录失败: {}", ctx.state_dir.display()))?;
    let ok_marker = ok_marker(&ctx.state_dir);
    let pending_marker = pending_marker(&ctx.state_dir);
    let helper_path = rollback_helper(&ctx.state_dir);

    // 上一个进程留下的 pending 说明「替换可能已经发生、但还没确认」。
    // 当前进程如果已经是目标版本，前面已经 Noop，不会走到这里；能走到这里
    // 说明当前还是旧版本，不能贸然重来（会覆盖 .bak / 和旧看门狗打架）。
    if pending_marker.exists() {
        let target = std::fs::read_to_string(&pending_marker).unwrap_or_default();
        bail!(
            "已有未完成的升级（目标 {}），等待回滚/重启处理后再试",
            target.trim()
        );
    }
    // 上一次成功留下的 ok 标记会压制**本次**的看门狗，必须先清掉。
    match std::fs::remove_file(&ok_marker) {
        Ok(()) => tracing::warn!("清理上一轮遗留的 upgrade-ok 标记"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(anyhow!(
                "清理旧的 upgrade-ok 失败（{}）：{e}",
                ok_marker.display()
            ))
        }
    }

    tracing::info!(
        from = %ctx.current_version,
        to = %plan.version,
        "agent upgrade starting"
    );

    let sums = download_utf8(downloader, &plan.sums_url, "SHA256SUMS").await?;
    let sig = download_utf8(downloader, &plan.sig_url, "SHA256SUMS.sig").await?;

    // 清单签名先验：清单本身不可信时，连产物都不用下。
    verify_manifest(&sums, &sig, &ctx.public_key)
        .context("升级清单验签失败，拒绝升级（线上二进制未被修改）")?;

    let asset_name = asset_name_from_url(&plan.asset_url)?;
    let asset = downloader
        .download(&plan.asset_url)
        .await
        .with_context(|| format!("下载升级产物失败: {}", plan.asset_url))?;
    verify_asset(&sums, &asset_name, &asset)
        .context("升级包 sha256 校验失败，拒绝升级（线上二进制未被修改）")?;
    tracing::info!(
        asset = %asset_name,
        bytes = asset.len(),
        "agent upgrade package verified"
    );

    // —— 从这里开始才落盘。先写 pending，重启后的新进程才知道要确认。——
    std::fs::write(&pending_marker, plan.version.as_bytes())
        .with_context(|| format!("写入升级进行中标记失败: {}", pending_marker.display()))?;

    let new_path = with_suffix(&ctx.current_exe, NEW_SUFFIX);
    if let Err(e) = stage_binary(&new_path, &asset) {
        cleanup_staging(&new_path, &pending_marker, &helper_path);
        return Err(e);
    }

    let backup_path = with_suffix(&ctx.current_exe, BACKUP_SUFFIX);
    if let Err(e) = publish_backup(&ctx.current_exe, &backup_path) {
        cleanup_staging(&new_path, &pending_marker, &helper_path);
        return Err(e);
    }

    // 看门狗：没有 systemd 就跳过并 warn；systemd 在但注册失败则**拒绝升级**
    // （例如同名 timer 还活着），避免在没有回滚保护的情况下替换二进制。
    match &ctx.watchdog {
        Some(wd) if systemd_is_available() => {
            let watchdog = (|| -> Result<()> {
                copy_helper(&new_path, &helper_path)?;
                register_watchdog(wd, &helper_path, &ok_marker, &backup_path)?;
                Ok(())
            })();
            if let Err(e) = watchdog {
                cleanup_staging(&new_path, &pending_marker, &helper_path);
                return Err(
                    e.context("回滚看门狗注册失败，拒绝在没有回滚保护的情况下替换 Agent 二进制")
                );
            }
            tracing::info!(
                secs = wd.delay_secs,
                unit = %wd.unit,
                "rollback watchdog registered"
            );
        }
        Some(wd) => {
            tracing::warn!(
                program = %wd.program,
                "未检测到 systemd（容器/测试环境？），跳过回滚看门狗；本次升级失败不会自动回滚"
            );
        }
        None => {
            tracing::warn!("回滚看门狗已关闭；本次升级失败不会自动回滚");
        }
    }

    if let Err(e) = std::fs::rename(&new_path, &ctx.current_exe) {
        // 备份是当前旧版本；立刻换回去，比等 120 秒看门狗更快。
        let rollback = rollback_installed(&ctx.current_exe, &backup_path, &ctx.state_dir);
        cleanup_staging(&new_path, &pending_marker, &helper_path);
        return match rollback {
            Ok(()) => Err(anyhow!(
                "替换 Agent 二进制失败，已还原旧版本（{}）：{e}",
                ctx.current_exe.display()
            )),
            Err(re) => Err(anyhow!(
                "替换 Agent 二进制失败（{}），且还原失败（{re}）：{e}",
                ctx.current_exe.display()
            )),
        };
    }

    tracing::info!(version = %plan.version, "agent binary replaced, restarting");
    // 注意：这里**不能**根据重启命令的退出码回滚。
    // `systemctl restart` 会停掉当前 service 的 cgroup，命令自己也可能被一起杀掉，
    // 于是「重启成功」也会返回非 0；此时把 .bak 换回去等于把刚升级好的版本又降级。
    // 重启是否真的成功交给看门狗判断：新进程 120 秒内没有 Ack 写 upgrade-ok
    // 才会回滚。命令失败只记日志，进程照常退出，systemd 的 Restart=always 会拉起。
    match run_restart(&ctx.restart_command) {
        Ok(()) => tracing::info!(
            version = %plan.version,
            "agent upgrade installed successfully"
        ),
        Err(e) => tracing::warn!(
            version = %plan.version,
            error = %e,
            "重启命令返回失败（可能只是 systemctl 被自身 cgroup 终止）；交给看门狗与 systemd Restart=always"
        ),
    }
    Ok(UpgradeOutcome::Upgraded {
        version: plan.version.clone(),
    })
}

async fn download_utf8<D: Downloader + ?Sized>(
    downloader: &D,
    url: &str,
    what: &str,
) -> Result<String> {
    let bytes = downloader
        .download(url)
        .await
        .with_context(|| format!("下载 {what} 失败: {url}"))?;
    String::from_utf8(bytes).with_context(|| format!("{what} 不是合法的 UTF-8"))
}

/// 写 `<exe>.new`：写完 fsync 再 chmod，保证 rename 出去的是完整可执行文件。
fn stage_binary(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("创建 Agent 目录失败: {}", parent.display()))?;
    }
    let result = (|| -> Result<()> {
        let mut file = std::fs::File::create(path)
            .with_context(|| format!("写入新二进制失败: {}", path.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("写入新二进制失败: {}", path.display()))?;
        file.sync_all()
            .with_context(|| format!("同步新二进制失败: {}", path.display()))?;
        drop(file);
        make_executable(path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(path);
    }
    result
}

/// 原子备份：先写 `.bak.tmp` 并核对长度，再 rename 成 `.bak`。
///
/// 直接 `copy` 到 `.bak` 在磁盘写满时会留下半截文件，看门狗把它换回去
/// 等于把 Agent 弄砖；这个中间步骤就是为了让 `.bak` 永远完整。
fn publish_backup(live: &Path, backup: &Path) -> Result<()> {
    let tmp = with_suffix(backup, ".tmp");
    let _ = std::fs::remove_file(&tmp);
    let result = (|| -> Result<()> {
        std::fs::copy(live, &tmp).with_context(|| {
            format!(
                "备份当前 Agent 失败（{} -> {}）",
                live.display(),
                tmp.display()
            )
        })?;
        let src_len = std::fs::metadata(live)
            .with_context(|| format!("读取当前 Agent 元数据失败: {}", live.display()))?
            .len();
        let dst_len = std::fs::metadata(&tmp)
            .with_context(|| format!("读取备份元数据失败: {}", tmp.display()))?
            .len();
        if src_len != dst_len {
            bail!("备份长度不一致（{} != {}），拒绝继续", dst_len, src_len);
        }
        make_executable(&tmp)?;
        std::fs::rename(&tmp, backup)
            .with_context(|| format!("发布备份失败: {}", backup.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// helper 也走「临时文件 + rename」，避免看门狗拿到半截二进制。
fn copy_helper(new_binary: &Path, helper: &Path) -> Result<()> {
    let tmp = with_suffix(helper, ".tmp");
    let _ = std::fs::remove_file(&tmp);
    let result = (|| -> Result<()> {
        std::fs::copy(new_binary, &tmp).with_context(|| {
            format!(
                "复制回滚 helper 失败（{} -> {}）",
                new_binary.display(),
                tmp.display()
            )
        })?;
        make_executable(&tmp)?;
        std::fs::rename(&tmp, helper)
            .with_context(|| format!("发布回滚 helper 失败: {}", helper.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn systemd_is_available() -> bool {
    Path::new("/run/systemd/system").is_dir()
}

/// 注册 120 秒后的回滚 timer。返回 true 表示命令成功；没有 systemd 的情况
/// 由调用方先判断，这里只处理「尝试了但失败」。
fn register_watchdog(
    wd: &WatchdogConfig,
    helper: &Path,
    ok_marker: &Path,
    backup: &Path,
) -> Result<bool> {
    if wd.program.trim().is_empty() {
        bail!("systemd-run 程序名为空");
    }
    let out = std::process::Command::new(&wd.program)
        .arg(format!("--on-active={}", wd.delay_secs))
        .arg(format!("--unit={}", wd.unit))
        .arg("--collect")
        .arg(helper)
        .arg("--rollback-check")
        .arg(ok_marker)
        .arg(backup)
        .output()
        .with_context(|| format!("无法执行 `{}`", wd.program))?;
    if out.status.success() {
        return Ok(true);
    }
    let detail = crate::command_output(&out);
    if detail.is_empty() {
        bail!("`{}` 注册回滚任务失败（{}）", wd.program, out.status);
    }
    bail!(
        "`{}` 注册回滚任务失败（{}）：{detail}",
        wd.program,
        out.status
    )
}

/// 进程启动自检：
/// - `upgrade-ok` 存在 → 上次升级已确认成功，删标记、清 pending/helper 并记录；
/// - pending 的目标仍比当前新 → 二进制还是旧的（替换没成功），清掉等待重试；
/// - pending 的目标不新于当前 → 当前就是新版本，保留 pending 等 Ack。
pub fn startup_check(state_dir: &Path, current_version: &str) -> Result<()> {
    if !state_dir.exists() {
        return Ok(());
    }
    let ok = ok_marker(state_dir);
    let pending = pending_marker(state_dir);
    if ok.exists() {
        std::fs::remove_file(&ok)
            .with_context(|| format!("删除 upgrade-ok 失败: {}", ok.display()))?;
        let _ = std::fs::remove_file(&pending);
        let _ = std::fs::remove_file(rollback_helper(state_dir));
        tracing::info!(
            version = current_version,
            "检测到 upgrade-ok：上次 Agent 升级已成功"
        );
        return Ok(());
    }
    if !pending.exists() {
        return Ok(());
    }
    let target = std::fs::read_to_string(&pending).unwrap_or_default();
    let target = target.trim();
    if target.is_empty() || is_newer(target, current_version) {
        std::fs::remove_file(&pending)
            .with_context(|| format!("删除遗留的升级标记失败: {}", pending.display()))?;
        tracing::warn!(
            target,
            current = current_version,
            "发现未完成的升级标记，但当前仍是旧版本；已清理，等待主控重新下发"
        );
    } else {
        tracing::info!(
            target,
            current = current_version,
            "检测到升级中标记：等待主控 Ack 后确认升级"
        );
    }
    Ok(())
}

/// 新版本连上主控并收到 Ack 后调用：写入 `upgrade-ok`。
///
/// 只有存在 pending 时才写，避免正常启动也留下标记。返回 true 表示本次确实
/// 确认了一次升级。
pub fn confirm_upgrade(state_dir: &Path) -> Result<bool> {
    let pending = pending_marker(state_dir);
    if !pending.exists() {
        return Ok(false);
    }
    let ok = ok_marker(state_dir);
    std::fs::write(&ok, b"ok\n")
        .with_context(|| format!("写入 upgrade-ok 失败: {}", ok.display()))?;
    let _ = std::fs::remove_file(&pending);
    tracing::info!("主控已 Ack：写入 upgrade-ok，升级确认成功");
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RollbackOutcome {
    /// 有 ok 标记：升级已确认，什么都不用做。
    Confirmed,
    /// 没有 ok 标记，但有备份：已还原并重启。
    RolledBack,
    /// 没有 ok 标记，也没有备份：替换大概率还没发生，保持现状。
    NoBackup,
}

/// `pierwave-agent --rollback-check <ok-marker> <backup-path>` 的入口。
pub fn rollback_check(ok_marker: &Path, backup: &Path) -> Result<RollbackOutcome> {
    rollback_check_with(ok_marker, backup, DEFAULT_RESTART_COMMAND)
}

pub fn rollback_check_with(
    ok_marker: &Path,
    backup: &Path,
    restart_command: &str,
) -> Result<RollbackOutcome> {
    if !should_rollback(ok_marker.exists()) {
        tracing::info!("看门狗：检测到 upgrade-ok，升级已确认，无需回滚");
        return Ok(RollbackOutcome::Confirmed);
    }
    if !backup.exists() {
        tracing::warn!(
            backup = %backup.display(),
            "看门狗：没有备份可回滚（升级可能尚未替换二进制）"
        );
        return Ok(RollbackOutcome::NoBackup);
    }
    let live = live_from_backup(backup)?;
    std::fs::rename(backup, &live).with_context(|| {
        format!(
            "看门狗还原失败（{} -> {}）",
            backup.display(),
            live.display()
        )
    })?;
    make_executable(&live)?;
    if let Some(dir) = ok_marker.parent() {
        let _ = std::fs::remove_file(dir.join(PENDING_MARKER_FILE));
    }
    tracing::warn!(
        binary = %live.display(),
        "看门狗：升级在 {} 秒内未确认，已还原上一版二进制",
        DEFAULT_WATCHDOG_SECS
    );
    run_restart(restart_command)
        .with_context(|| format!("看门狗还原后重启失败: {restart_command}"))?;
    tracing::warn!("看门狗：已重启上一版 Agent");
    // 只有确认自己确实是 state_dir 里的 helper 才自删，避免误删线上二进制。
    if let Ok(exe) = std::env::current_exe() {
        if ok_marker
            .parent()
            .is_some_and(|dir| exe == dir.join(ROLLBACK_HELPER_FILE))
        {
            let _ = std::fs::remove_file(&exe);
        }
    }
    Ok(RollbackOutcome::RolledBack)
}

fn live_from_backup(backup: &Path) -> Result<PathBuf> {
    let name = backup
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| anyhow!("备份路径没有文件名: {}", backup.display()))?;
    let live = name
        .strip_suffix(BACKUP_SUFFIX)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow!(
                "备份文件名必须以 {BACKUP_SUFFIX} 结尾: {}",
                backup.display()
            )
        })?;
    Ok(backup.with_file_name(live))
}

/// 把 `.bak` 换回线上路径并清掉 pending；不负责重启。
fn rollback_installed(live: &Path, backup: &Path, state_dir: &Path) -> Result<()> {
    if !backup.exists() {
        bail!("备份 {} 不存在，无法还原", backup.display());
    }
    std::fs::rename(backup, live).with_context(|| {
        format!(
            "还原 Agent 失败: {} -> {}",
            backup.display(),
            live.display()
        )
    })?;
    make_executable(live)?;
    let _ = std::fs::remove_file(pending_marker(state_dir));
    Ok(())
}

fn run_restart(command: &str) -> Result<()> {
    if command.trim().is_empty() {
        bail!("升级重启命令为空");
    }
    let out = crate::run_program(command, None)?;
    if out.status.success() {
        return Ok(());
    }
    let detail = crate::command_output(&out);
    if detail.is_empty() {
        bail!("`{command}` 执行失败（{}）", out.status);
    }
    bail!("`{command}` 执行失败（{}）：{detail}", out.status)
}

fn cleanup_staging(new_path: &Path, pending: &Path, helper: &Path) {
    let _ = std::fs::remove_file(new_path);
    let _ = std::fs::remove_file(pending);
    let _ = std::fs::remove_file(helper);
}

fn make_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .with_context(|| format!("读取文件权限失败: {}", path.display()))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)
            .with_context(|| format!("设置可执行权限失败: {}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn ok_marker(state_dir: &Path) -> PathBuf {
    state_dir.join(OK_MARKER_FILE)
}

fn pending_marker(state_dir: &Path) -> PathBuf {
    state_dir.join(PENDING_MARKER_FILE)
}

fn rollback_helper(state_dir: &Path) -> PathBuf {
    state_dir.join(ROLLBACK_HELPER_FILE)
}

/// 在完整文件名后追加后缀（`pierwave-agent` → `pierwave-agent.new`）。
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;
    use std::sync::Mutex;

    use anyhow::anyhow;
    use base64::Engine;
    use ed25519_dalek::SigningKey;
    use sha2::{Digest, Sha256};

    /// 每个用例独立临时目录，Drop 时清理；不引入 tempfile 依赖。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("pierwave-upgrade-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn read(path: &Path) -> Vec<u8> {
        std::fs::read(path).unwrap()
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode()
    }

    fn keypair() -> (String, String) {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        (
            base64::engine::general_purpose::STANDARD.encode(signing.to_bytes()),
            base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().to_bytes()),
        )
    }

    fn signed_manifest(secret: &str, asset: &str, bytes: &[u8]) -> (String, String) {
        let hash = hex::encode(Sha256::digest(bytes));
        let manifest = format!("{hash}  {asset}\n");
        let sig = pierwave_domain::release::sign_manifest(secret, &manifest).unwrap();
        (manifest, sig)
    }

    struct FakeDownloader {
        responses: HashMap<String, Vec<u8>>,
        calls: Mutex<Vec<String>>,
    }

    impl FakeDownloader {
        fn new() -> Self {
            Self {
                responses: HashMap::new(),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn with(mut self, url: &str, body: impl Into<Vec<u8>>) -> Self {
            self.responses.insert(url.to_string(), body.into());
            self
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Downloader for FakeDownloader {
        fn download<'a>(&'a self, url: &'a str) -> DownloadFuture<'a> {
            self.calls.lock().unwrap().push(url.to_string());
            let body = self.responses.get(url).cloned();
            Box::pin(
                async move { body.ok_or_else(|| anyhow!("fake downloader: unexpected url {url}")) },
            )
        }
    }

    const ASSET: &str = "pierwave-agent-x86_64-unknown-linux-musl";

    fn plan(version: &str) -> AgentUpgradePlan {
        AgentUpgradePlan {
            version: version.into(),
            asset_url: format!("https://panel.example/api/agent/release/{version}/{ASSET}"),
            sums_url: format!(
                "https://panel.example/api/agent/release/{version}/SHA256SUMS-x86_64"
            ),
            sig_url: format!(
                "https://panel.example/api/agent/release/{version}/SHA256SUMS-x86_64.sig"
            ),
        }
    }

    fn context(live: &Path, state: &Path, current: &str, public: &str) -> UpgradeContext {
        UpgradeContext {
            current_version: current.into(),
            current_exe: live.to_path_buf(),
            state_dir: state.to_path_buf(),
            restart_command: "true".into(),
            public_key: public.into(),
            watchdog: None,
        }
    }

    fn live_binary(dir: &TempDir) -> PathBuf {
        let live = dir.path().join("pierwave-agent");
        std::fs::write(&live, b"old-agent").unwrap();
        make_executable(&live).unwrap();
        live
    }

    #[tokio::test]
    async fn same_or_older_version_is_noop() {
        let dir = TempDir::new();
        let live = live_binary(&dir);
        let (_secret, public) = keypair();

        for target in ["0.5.1", "0.5.0", "v0.5.1"] {
            let downloader = FakeDownloader::new();
            let ctx = context(&live, &dir.path().join("state"), "0.5.1", &public);
            let outcome = run(&plan(target), &ctx, &downloader).await.unwrap();
            assert_eq!(outcome, UpgradeOutcome::Noop, "target={target}");
            assert!(
                downloader.calls().is_empty(),
                "Noop 不应发起任何下载: {:?}",
                downloader.calls()
            );
        }
        assert_eq!(read(&live), b"old-agent");
    }

    #[tokio::test]
    async fn signature_failure_leaves_live_binary_untouched() {
        let dir = TempDir::new();
        let live = live_binary(&dir);
        let state = dir.path().join("state");
        let (secret, public) = keypair();
        let asset = b"new-agent";
        let (manifest, _sig) = signed_manifest(&secret, ASSET, asset);
        let target = plan("0.6.0");

        // 故意只给 sums 和坏签名：验签失败时不应该再去下载产物。
        let downloader = FakeDownloader::new()
            .with(&target.sums_url, manifest)
            .with(&target.sig_url, "AAAA");
        let ctx = context(&live, &state, "0.5.0", &public);
        let err = run(&target, &ctx, &downloader).await.unwrap_err();

        assert!(format!("{err:#}").contains("验签"), "{err:#}");
        assert_eq!(read(&live), b"old-agent", "验签失败绝不能碰线上二进制");
        assert!(!with_suffix(&live, NEW_SUFFIX).exists(), "不能留下 .new");
        assert!(!with_suffix(&live, BACKUP_SUFFIX).exists(), "不能留下 .bak");
        assert!(
            !state.join(PENDING_MARKER_FILE).exists(),
            "不能留下升级中标记"
        );
        assert_eq!(downloader.calls().len(), 2, "签名失败后不应下载产物");
    }

    #[tokio::test]
    async fn checksum_mismatch_leaves_live_binary_untouched() {
        let dir = TempDir::new();
        let live = live_binary(&dir);
        let state = dir.path().join("state");
        let (secret, public) = keypair();
        let (manifest, sig) = signed_manifest(&secret, ASSET, b"different-content");
        let target = plan("0.6.0");

        let downloader = FakeDownloader::new()
            .with(&target.sums_url, manifest)
            .with(&target.sig_url, sig)
            .with(&target.asset_url, b"new-agent");
        let ctx = context(&live, &state, "0.5.0", &public);
        let err = run(&target, &ctx, &downloader).await.unwrap_err();

        assert!(format!("{err:#}").contains("sha256"), "{err:#}");
        assert_eq!(read(&live), b"old-agent", "sha256 不符绝不能落盘");
        assert!(!with_suffix(&live, NEW_SUFFIX).exists());
        assert!(!with_suffix(&live, BACKUP_SUFFIX).exists());
        assert!(!state.join(PENDING_MARKER_FILE).exists());
    }

    #[tokio::test]
    async fn successful_upgrade_replaces_binary_and_keeps_backup() {
        let dir = TempDir::new();
        let live = live_binary(&dir);
        let state = dir.path().join("state");
        let (secret, public) = keypair();
        let asset = b"new-agent";
        let (manifest, sig) = signed_manifest(&secret, ASSET, asset);
        let target = plan("0.6.0");

        let downloader = FakeDownloader::new()
            .with(&target.sums_url, manifest)
            .with(&target.sig_url, sig)
            .with(&target.asset_url, asset);
        let ctx = context(&live, &state, "0.5.0", &public);
        let outcome = run(&target, &ctx, &downloader).await.unwrap();

        assert_eq!(
            outcome,
            UpgradeOutcome::Upgraded {
                version: "0.6.0".into()
            }
        );
        assert_eq!(read(&live), asset, "线上二进制应换成新版本");
        assert_eq!(
            read(&with_suffix(&live, BACKUP_SUFFIX)),
            b"old-agent",
            ".bak 必须保留旧版本"
        );
        assert!(!with_suffix(&live, NEW_SUFFIX).exists());
        #[cfg(unix)]
        assert_eq!(mode(&live) & 0o777, 0o755);
        assert_eq!(
            std::fs::read_to_string(state.join(PENDING_MARKER_FILE)).unwrap(),
            "0.6.0"
        );
        assert!(!state.join(OK_MARKER_FILE).exists(), "Ack 之前不能写 ok");
    }

    #[tokio::test]
    async fn restart_command_failure_does_not_roll_back_verified_binary() {
        // systemctl restart 可能把自己所在的 cgroup 一起停掉，于是返回非 0。
        // 此时绝不能立刻回滚：升级是否成功由看门狗在 120 秒后判断。
        let dir = TempDir::new();
        let live = live_binary(&dir);
        let state = dir.path().join("state");
        let (secret, public) = keypair();
        let asset = b"new-agent";
        let (manifest, sig) = signed_manifest(&secret, ASSET, asset);
        let target = plan("0.6.0");
        let downloader = FakeDownloader::new()
            .with(&target.sums_url, manifest)
            .with(&target.sig_url, sig)
            .with(&target.asset_url, asset);
        let mut ctx = context(&live, &state, "0.5.0", &public);
        ctx.restart_command = "false".into();

        let outcome = run(&target, &ctx, &downloader).await.unwrap();

        assert_eq!(
            outcome,
            UpgradeOutcome::Upgraded {
                version: "0.6.0".into()
            }
        );
        assert_eq!(read(&live), asset, "已验签的新二进制不能被立即回滚");
        assert_eq!(read(&with_suffix(&live, BACKUP_SUFFIX)), b"old-agent");
        assert!(
            state.join(PENDING_MARKER_FILE).exists(),
            "pending 要留给看门狗判断"
        );
    }

    #[test]
    fn marker_lifecycle_confirms_then_cleans_up_on_start() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join(PENDING_MARKER_FILE), "0.6.0").unwrap();

        // 没有 pending 时重复确认是幂等的，不写 ok。
        let empty = dir.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(!confirm_upgrade(&empty).unwrap());
        assert!(!empty.join(OK_MARKER_FILE).exists());

        assert!(confirm_upgrade(&state).unwrap());
        assert!(state.join(OK_MARKER_FILE).exists());
        assert!(!state.join(PENDING_MARKER_FILE).exists());

        startup_check(&state, "0.6.0").unwrap();
        assert!(!state.join(OK_MARKER_FILE).exists(), "启动自检应删除 ok");
    }

    #[test]
    fn should_rollback_only_when_ok_marker_is_missing() {
        assert!(should_rollback(false));
        assert!(!should_rollback(true));
    }

    #[test]
    fn watchdog_rolls_back_when_ok_marker_is_missing() {
        let dir = TempDir::new();
        let live = dir.path().join("pierwave-agent");
        let backup = with_suffix(&live, BACKUP_SUFFIX);
        let ok = dir.path().join(OK_MARKER_FILE);
        let state = dir.path();
        std::fs::write(&live, b"new-agent").unwrap();
        std::fs::write(&backup, b"old-agent").unwrap();
        std::fs::write(state.join(PENDING_MARKER_FILE), "0.6.0").unwrap();

        let outcome = rollback_check_with(&ok, &backup, "true").unwrap();

        assert_eq!(outcome, RollbackOutcome::RolledBack);
        assert_eq!(read(&live), b"old-agent");
        assert!(!backup.exists(), "回滚后备份被换回线上路径");
        assert!(
            !state.join(PENDING_MARKER_FILE).exists(),
            "回滚后不能留下 pending"
        );
    }

    #[test]
    fn watchdog_keeps_binary_when_ok_marker_exists() {
        let dir = TempDir::new();
        let live = dir.path().join("pierwave-agent");
        let backup = with_suffix(&live, BACKUP_SUFFIX);
        let ok = dir.path().join(OK_MARKER_FILE);
        std::fs::write(&live, b"new-agent").unwrap();
        std::fs::write(&backup, b"old-agent").unwrap();
        std::fs::write(&ok, b"ok\n").unwrap();

        // restart 命令给 false：如果被误调用会返回错误。
        let outcome = rollback_check_with(&ok, &backup, "false").unwrap();

        assert_eq!(outcome, RollbackOutcome::Confirmed);
        assert_eq!(read(&live), b"new-agent");
        assert_eq!(read(&backup), b"old-agent");
    }

    #[test]
    fn watchdog_without_backup_keeps_current_binary() {
        let dir = TempDir::new();
        let live = dir.path().join("pierwave-agent");
        let backup = with_suffix(&live, BACKUP_SUFFIX);
        let ok = dir.path().join(OK_MARKER_FILE);
        std::fs::write(&live, b"new-agent").unwrap();

        let outcome = rollback_check_with(&ok, &backup, "false").unwrap();

        assert_eq!(outcome, RollbackOutcome::NoBackup);
        assert_eq!(read(&live), b"new-agent");
    }

    #[test]
    fn startup_clears_stale_pending_for_old_binary() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join(PENDING_MARKER_FILE), "0.6.0").unwrap();

        startup_check(&state, "0.5.0").unwrap();

        assert!(!state.join(PENDING_MARKER_FILE).exists());
    }

    #[test]
    fn startup_keeps_pending_for_new_binary() {
        let dir = TempDir::new();
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join(PENDING_MARKER_FILE), "0.6.0").unwrap();

        startup_check(&state, "0.6.0").unwrap();

        assert!(
            state.join(PENDING_MARKER_FILE).exists(),
            "新版本启动后要保留 pending，等 Ack 再确认"
        );
    }

    #[test]
    fn parses_asset_name_from_release_url() {
        assert_eq!(
            asset_name_from_url(
                "https://panel.example/api/agent/release/v0.6.0/pierwave-agent-x86_64"
            )
            .unwrap(),
            "pierwave-agent-x86_64"
        );
        assert_eq!(
            asset_name_from_url("https://panel/api/agent/release/v0.6.0/agent?token=abc#x")
                .unwrap(),
            "agent"
        );
        assert!(asset_name_from_url("https://panel/api/agent/release/v0.6.0/").is_err());
        assert!(asset_name_from_url("https://panel/..").is_err());
    }

    #[tokio::test]
    async fn refuses_to_restart_when_previous_upgrade_is_pending() {
        let dir = TempDir::new();
        let live = live_binary(&dir);
        let state = dir.path().join("state");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join(PENDING_MARKER_FILE), "0.6.0").unwrap();
        let (_secret, public) = keypair();
        let downloader = FakeDownloader::new();
        let ctx = context(&live, &state, "0.5.0", &public);

        let err = run(&plan("0.6.0"), &ctx, &downloader).await.unwrap_err();

        assert!(err.to_string().contains("未完成"), "{err}");
        assert_eq!(read(&live), b"old-agent");
        assert!(downloader.calls().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn watchdog_command_has_expected_shape() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new();
        let args_file = dir.path().join("args.txt");
        let script = dir.path().join("fake-systemd-run");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n",
                args_file.display()
            ),
        )
        .unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();

        let wd = WatchdogConfig {
            program: script.display().to_string(),
            unit: DEFAULT_WATCHDOG_UNIT.into(),
            delay_secs: DEFAULT_WATCHDOG_SECS,
        };
        let helper = dir.path().join(ROLLBACK_HELPER_FILE);
        let ok = dir.path().join(OK_MARKER_FILE);
        let backup = dir.path().join("pierwave-agent.bak");

        assert!(register_watchdog(&wd, &helper, &ok, &backup).unwrap());
        let args = std::fs::read_to_string(&args_file).unwrap();
        assert!(args.contains("--on-active=120"), "{args}");
        assert!(args.contains("--unit=pierwave-agent-rollback"), "{args}");
        assert!(args.contains("--rollback-check"), "{args}");
        assert!(args.contains(helper.to_str().unwrap()), "{args}");
        assert!(args.contains(ok.to_str().unwrap()), "{args}");
        assert!(args.contains(backup.to_str().unwrap()), "{args}");
    }
}
