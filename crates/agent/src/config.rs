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
}
