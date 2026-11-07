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
    /// 流量采样间隔（秒）；生产默认 60，e2e 会调到 1
    #[serde(default = "default_stats_interval_secs")]
    pub stats_interval_secs: u64,
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
            stats_interval_secs: default_stats_interval_secs(),
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
}
