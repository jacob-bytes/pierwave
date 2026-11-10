use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)] // 部分字段留待 P1 使用
pub struct Config {
    #[serde(default = "default_mode")]
    pub mode: String,
    pub master_url: String,
    pub token: String,
    #[serde(default = "default_connection")]
    pub connection_mode: String,
    #[serde(default = "default_xray_mode")]
    pub xray_mode: String,
    #[serde(default = "default_listen_port")]
    pub listen_port: String,
    #[serde(default)]
    pub master_public_key: Option<String>,
    /// xray 配置落盘位置；测试时可指向临时目录
    #[serde(default = "default_xray_config")]
    pub xray_config_path: String,
    /// 重启命令；测试里给 `true` 就能跳过真实 systemd
    #[serde(default = "default_restart_command")]
    pub restart_command: String,
    /// xray 配置校验命令；配置路径会作为独立 argv 追加，不经过 shell
    #[serde(default = "default_xray_test_command")]
    pub xray_test_command: String,
    /// 线上配置的备份后缀；省略时用 `.bak`
    #[serde(default = "default_backup_suffix")]
    pub backup_suffix: Option<String>,
    /// 采样 Xray 计数器的命令；测试/本地可指向假脚本
    #[serde(default = "default_stats_query_command")]
    pub stats_query_command: String,
    /// 节点限速 tc 的出口网卡；空 = 自动探测默认路由所在网卡。
    #[serde(default)]
    pub tc_interface: Option<String>,
    /// tc 原始根队列快照文件；应用限速前记录、清理时恢复。
    #[serde(default = "default_tc_state_path")]
    pub tc_state_path: String,
    /// 流量采样间隔（秒）；生产默认 60，e2e 会调到 1
    #[serde(default = "default_stats_interval_secs")]
    pub stats_interval_secs: u64,
    /// 端口转发的监听地址；默认监听所有网卡。
    /// 只对内网开放转发时改成内网 IP（例如 `192.168.1.10` 或 `10.0.0.5`）。
    #[serde(default = "default_forward_bind")]
    pub forward_bind: String,
    /// realm 引擎的可执行文件。文件不存在时 realm 规则报「realm 未安装」，
    /// native 规则完全不受影响。
    #[serde(default = "default_realm_bin")]
    pub realm_bin: String,
    /// realm 配置里的 `[log].level`。只对带 transport 的端点生成 `[log]`；
    /// 排障时可临时改成 `debug`（单连接握手失败在 debug 级）。
    #[serde(default = "default_realm_log_level")]
    pub realm_log_level: String,
    /// Agent 的持久状态目录（realm.toml 落在这里）；不存在会自动创建。
    #[serde(default = "default_state_dir")]
    pub state_dir: String,
    /// 网络质量探测目标（TCP）。默认公共 DNS 的 443，握手即可测 RTT。
    #[serde(default = "default_probe_target")]
    pub probe_target: String,
    /// 单次 TCP 握手超时（毫秒）；超时按「没有数据」处理，不写 0。
    #[serde(default = "default_probe_timeout_ms")]
    pub probe_timeout_ms: u64,
    /// 探测间隔（秒）；结果缓存在内存里，心跳只读缓存。
    #[serde(default = "default_probe_interval_secs")]
    pub probe_interval_secs: u64,
    /// 自升级的标记/回滚 helper 目录；必须可写，升级失败时靠它判断是否回滚
    #[serde(default = "default_upgrade_state_dir")]
    pub upgrade_state_dir: String,
    /// 升级后重启自身；容器/测试可改成 `true`
    #[serde(default = "default_upgrade_restart_command")]
    pub upgrade_restart_command: String,
    /// 看门狗延迟（秒）；0 = 显式关闭（容器/测试）
    #[serde(default = "default_upgrade_watchdog_secs")]
    pub upgrade_watchdog_secs: u64,
    /// systemd-run 程序名；空 = 关闭看门狗
    #[serde(default = "default_upgrade_systemd_run")]
    pub upgrade_systemd_run: String,
}

fn default_mode() -> String {
    "remote".into()
}
fn default_connection() -> String {
    "websocket".into()
}
fn default_xray_mode() -> String {
    "external".into()
}
fn default_listen_port() -> String {
    "23889".into()
}
fn default_xray_config() -> String {
    "/usr/local/etc/xray/config.json".into()
}
fn default_restart_command() -> String {
    "systemctl restart xray".into()
}
fn default_xray_test_command() -> String {
    "xray run -test -config".into()
}
fn default_backup_suffix() -> Option<String> {
    Some(".bak".into())
}
fn default_stats_query_command() -> String {
    // 不传 `-pattern`：解析层本来就按 `user>>>` 前缀过滤，全量取回再由 Rust 过滤，
    // 不依赖 CLI 的 pattern 匹配语义（不同版本行为可能有差异，少一个变量）。
    "xray api statsquery --server=127.0.0.1:10085".into()
}
fn default_stats_interval_secs() -> u64 {
    60
}
fn default_tc_state_path() -> String {
    "/var/lib/pierwave-agent/tc-originals.json".into()
}
fn default_forward_bind() -> String {
    "0.0.0.0".into()
}
fn default_realm_bin() -> String {
    crate::realm::DEFAULT_BIN.into()
}
fn default_realm_log_level() -> String {
    "warn".into()
}
fn default_state_dir() -> String {
    "/var/lib/pierwave-agent".into()
}
fn default_probe_target() -> String {
    "1.1.1.1:443".into()
}
fn default_probe_timeout_ms() -> u64 {
    1000
}
fn default_probe_interval_secs() -> u64 {
    60
}
fn default_upgrade_state_dir() -> String {
    "/var/lib/pierwave-agent".into()
}
fn default_upgrade_restart_command() -> String {
    "systemctl restart pierwave-agent".into()
}
fn default_upgrade_watchdog_secs() -> u64 {
    120
}
fn default_upgrade_systemd_run() -> String {
    "systemd-run".into()
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("读取配置失败: {}", path.display()))?;
        Ok(toml::from_str(&raw)?)
    }

    /// master_url 可能是 https://panel.example.com/，
    /// 这里统一拼成 wss://panel.example.com/api/agent/ws。
    pub fn ws_url(&self) -> String {
        let base = self.master_url.trim_end_matches('/');
        let base = if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{rest}")
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{rest}")
        } else {
            base.to_string()
        };
        format!("{base}/api/agent/ws")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(url: &str) -> Config {
        Config {
            mode: "remote".into(),
            master_url: url.into(),
            token: "t".into(),
            connection_mode: "websocket".into(),
            xray_mode: "external".into(),
            listen_port: "23889".into(),
            master_public_key: None,
            xray_config_path: default_xray_config(),
            restart_command: default_restart_command(),
            xray_test_command: default_xray_test_command(),
            backup_suffix: default_backup_suffix(),
            stats_query_command: default_stats_query_command(),
            tc_interface: None,
            tc_state_path: default_tc_state_path(),
            stats_interval_secs: default_stats_interval_secs(),
            forward_bind: default_forward_bind(),
            realm_bin: default_realm_bin(),
            realm_log_level: default_realm_log_level(),
            state_dir: default_state_dir(),
            probe_target: default_probe_target(),
            probe_timeout_ms: default_probe_timeout_ms(),
            probe_interval_secs: default_probe_interval_secs(),
            upgrade_state_dir: default_upgrade_state_dir(),
            upgrade_restart_command: default_upgrade_restart_command(),
            upgrade_watchdog_secs: default_upgrade_watchdog_secs(),
            upgrade_systemd_run: default_upgrade_systemd_run(),
        }
    }

    #[test]
    fn builds_ws_url() {
        assert_eq!(
            cfg("https://panel.example.com/").ws_url(),
            "wss://panel.example.com/api/agent/ws"
        );
        assert_eq!(
            cfg("http://127.0.0.1:8787").ws_url(),
            "ws://127.0.0.1:8787/api/agent/ws"
        );
    }

    #[test]
    fn xray_test_and_backup_defaults() {
        let parsed: Config =
            toml::from_str("master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n").unwrap();
        assert_eq!(parsed.xray_test_command, "xray run -test -config");
        assert_eq!(parsed.backup_suffix.as_deref(), Some(".bak"));
    }

    #[test]
    fn xray_test_and_backup_can_be_overridden() {
        let parsed: Config = toml::from_str(
            "master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n\
             xray_test_command = \"/usr/local/bin/xray run -test -config\"\n\
             backup_suffix = \".old\"\n",
        )
        .unwrap();
        assert_eq!(
            parsed.xray_test_command,
            "/usr/local/bin/xray run -test -config"
        );
        assert_eq!(parsed.backup_suffix.as_deref(), Some(".old"));
    }

    #[test]
    fn stats_settings_have_sane_defaults() {
        let parsed: Config =
            toml::from_str("master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n").unwrap();
        assert_eq!(
            parsed.stats_query_command,
            "xray api statsquery --server=127.0.0.1:10085"
        );
        assert!(
            !parsed.stats_query_command.contains("-pattern"),
            "不要依赖 statsquery 的 pattern 语义，过滤交给 Rust 侧"
        );
        assert_eq!(parsed.stats_interval_secs, 60);
    }

    #[test]
    fn upgrade_settings_have_sane_defaults() {
        let parsed: Config =
            toml::from_str("master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n").unwrap();
        assert_eq!(parsed.upgrade_state_dir, "/var/lib/pierwave-agent");
        assert_eq!(
            parsed.upgrade_restart_command,
            "systemctl restart pierwave-agent"
        );
        assert_eq!(parsed.upgrade_watchdog_secs, 120);
        assert_eq!(parsed.upgrade_systemd_run, "systemd-run");
    }

    #[test]
    fn upgrade_settings_can_be_overridden() {
        let parsed: Config = toml::from_str(
            "master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n\
             upgrade_state_dir = \"/tmp/pierwave-state\"\n\
             upgrade_restart_command = \"true\"\n\
             upgrade_watchdog_secs = 0\n\
             upgrade_systemd_run = \"\"\n",
        )
        .unwrap();
        assert_eq!(parsed.upgrade_state_dir, "/tmp/pierwave-state");
        assert_eq!(parsed.upgrade_restart_command, "true");
        assert_eq!(parsed.upgrade_watchdog_secs, 0);
        assert!(parsed.upgrade_systemd_run.is_empty());
    }

    #[test]
    fn stats_settings_can_be_overridden() {
        let parsed: Config = toml::from_str(
            "master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n\
             stats_query_command = \"/tmp/fake-stats.sh\"\n\
             stats_interval_secs = 5\n",
        )
        .unwrap();
        assert_eq!(parsed.stats_query_command, "/tmp/fake-stats.sh");
        assert_eq!(parsed.stats_interval_secs, 5);
    }

    #[test]
    fn tc_interface_defaults_to_auto_detect_and_can_be_overridden() {
        let parsed: Config =
            toml::from_str("master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n").unwrap();
        assert!(
            parsed.tc_interface.is_none(),
            "默认必须自动探测默认路由网卡"
        );
        assert_eq!(
            parsed.tc_state_path,
            "/var/lib/pierwave-agent/tc-originals.json"
        );

        let parsed: Config = toml::from_str(
            "master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n\
             tc_interface = \"eth1\"\n\
             tc_state_path = \"/tmp/tc-originals.json\"\n",
        )
        .unwrap();
        assert_eq!(parsed.tc_interface.as_deref(), Some("eth1"));
        assert_eq!(parsed.tc_state_path, "/tmp/tc-originals.json");
    }

    #[test]
    fn forward_bind_defaults_to_all_interfaces_and_can_be_overridden() {
        let parsed: Config =
            toml::from_str("master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n").unwrap();
        assert_eq!(
            parsed.forward_bind, "0.0.0.0",
            "默认监听所有网卡，行为与旧版本一致"
        );

        let parsed: Config = toml::from_str(
            "master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n\
             forward_bind = \"10.0.0.5\"\n",
        )
        .unwrap();
        assert_eq!(parsed.forward_bind, "10.0.0.5", "允许只监听内网地址");
    }

    #[test]
    fn realm_settings_have_sane_defaults() {
        let parsed: Config =
            toml::from_str("master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n").unwrap();
        assert_eq!(
            parsed.realm_bin, "/usr/lib/pierwave/bin/realm",
            "默认安装路径由打包脚本决定"
        );
        assert_eq!(parsed.state_dir, "/var/lib/pierwave-agent");
        assert_eq!(parsed.realm_log_level, "warn", "默认 warn，不开 debug");
    }

    #[test]
    fn realm_settings_can_be_overridden() {
        let parsed: Config = toml::from_str(
            "master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n\
             realm_bin = \"/opt/realm/bin/realm\"\n\
             realm_log_level = \"debug\"\n\
             state_dir = \"/tmp/pierwave-state\"\n",
        )
        .unwrap();
        assert_eq!(parsed.realm_bin, "/opt/realm/bin/realm");
        assert_eq!(parsed.realm_log_level, "debug");
        assert_eq!(parsed.state_dir, "/tmp/pierwave-state");
    }

    #[test]
    fn probe_settings_have_sane_defaults() {
        let parsed: Config =
            toml::from_str("master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n").unwrap();
        assert_eq!(parsed.probe_target, "1.1.1.1:443");
        assert_eq!(parsed.probe_timeout_ms, 1000);
        assert_eq!(parsed.probe_interval_secs, 60);
    }

    #[test]
    fn probe_settings_can_be_overridden() {
        let parsed: Config = toml::from_str(
            "master_url = \"http://127.0.0.1:8787\"\ntoken = \"t\"\n\
             probe_target = \"8.8.8.8:53\"\n\
             probe_timeout_ms = 250\n\
             probe_interval_secs = 15\n",
        )
        .unwrap();
        assert_eq!(parsed.probe_target, "8.8.8.8:53");
        assert_eq!(parsed.probe_timeout_ms, 250);
        assert_eq!(parsed.probe_interval_secs, 15);
    }
}
