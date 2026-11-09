//! 启动时采集一次的系统信息：操作系统名称 / 版本与虚拟化类型。
//!
//! 这些值不会变化（容器/VM 不会在生命周期中换发行版），所以只在进程启动时
//! 采集一次并随心跳重复上报；心跳路径只读缓存，绝不每 15 秒 fork 一次
//! `systemd-detect-virt`。
//!
//! 所有解析函数都是纯函数，单测直接喂字符串，不依赖真实系统。

use std::process::Command;

/// 一台机器的静态系统信息；任何一项读不到都是 `None`，绝不用空串占位。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SystemInfo {
    /// `/etc/os-release` 的 `NAME`。
    pub os_name: Option<String>,
    /// `/etc/os-release` 的 `VERSION_ID`。
    pub os_version: Option<String>,
    /// 虚拟化类型，如 `kvm` / `vmware`；裸机或读不到为 `None`。
    pub virt: Option<String>,
}

/// 采集一次系统信息。读不到的文件 / 命令都回退为 `None`。
pub fn collect() -> SystemInfo {
    let os_release = std::fs::read_to_string("/etc/os-release").ok();
    let (os_name, os_version) = os_release
        .as_deref()
        .map(parse_os_release)
        .unwrap_or((None, None));

    // 优先 systemd-detect-virt；命令不存在或输出 none 时再看 DMI 产品名。
    let virt = detect_virt_from_command().or_else(|| {
        std::fs::read_to_string("/sys/class/dmi/id/product_name")
            .ok()
            .and_then(|raw| virt_from_product_name(&raw))
    });

    SystemInfo {
        os_name,
        os_version,
        virt,
    }
}

/// 解析 `/etc/os-release`：只取 `NAME` 与 `VERSION_ID`。
///
/// 支持双引号 / 单引号包裹的值、空行、`#` 注释与值里的 `=`；
/// 缺键或值为空都返回 `None`。
pub fn parse_os_release(raw: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut version = None;

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = unquote(value.trim());
        if value.is_empty() {
            continue;
        }
        match key.trim() {
            "NAME" => name = Some(value),
            "VERSION_ID" => version = Some(value),
            _ => {}
        }
    }

    (name, version)
}

fn unquote(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

/// 解析 `systemd-detect-virt --vm` 的输出。
///
/// 输出 `none`（裸机或 `--vm` 未命中）视为没有虚拟化；命令失败时输出为空，
/// 同样返回 `None`，由调用方回退到 DMI 推断。
pub fn parse_detect_virt(raw: &str) -> Option<String> {
    let value = raw.lines().map(str::trim).find(|line| !line.is_empty())?;
    let value = value.to_ascii_lowercase();
    if value == "none" {
        None
    } else {
        Some(value)
    }
}

/// 从 DMI 产品名推断虚拟化类型；只有明确命中关键字才返回 `Some`。
pub fn virt_from_product_name(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("qemu") || lower.contains("kvm") {
        Some("kvm".into())
    } else if lower.contains("vmware") {
        Some("vmware".into())
    } else if lower.contains("virtualbox") || lower.contains("innotek") {
        Some("virtualbox".into())
    } else {
        None
    }
}

/// 真正执行 `systemd-detect-virt --vm`。命令不存在 / 失败 / 输出不可解析都返回
/// `None`；`none` 也返回 `None`，让调用方决定是否继续看 DMI。
fn detect_virt_from_command() -> Option<String> {
    let output = Command::new("systemd-detect-virt")
        .arg("--vm")
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_detect_virt(&stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_and_version_id_with_quotes_and_comments() {
        let raw = r#"
# 这是注释
PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
ID=debian
"#;
        assert_eq!(
            parse_os_release(raw),
            (Some("Debian GNU/Linux".into()), Some("12".into()))
        );
    }

    #[test]
    fn parses_unquoted_values_and_equals_inside_value() {
        let raw = "NAME=Alpine Linux\nVERSION_ID=3.20.1\nHOME_URL=https://a=b\n";
        assert_eq!(
            parse_os_release(raw),
            (Some("Alpine Linux".into()), Some("3.20.1".into()))
        );
    }

    #[test]
    fn missing_or_empty_os_fields_are_none() {
        assert_eq!(parse_os_release(""), (None, None));
        assert_eq!(
            parse_os_release("ID=ubuntu\nVERSION_ID=\n"),
            (None, None),
            "缺 NAME / 空 VERSION_ID 必须是 None，不能是空串"
        );
        assert_eq!(
            parse_os_release("NAME=\"\"\n"),
            (None, None),
            "空引号值也视为读不到"
        );
    }

    #[test]
    fn detect_virt_none_and_blank_are_none() {
        assert_eq!(parse_detect_virt("none\n"), None);
        assert_eq!(parse_detect_virt(""), None);
        assert_eq!(parse_detect_virt("  \n\n"), None);
    }

    #[test]
    fn detect_virt_keeps_known_and_unknown_values_lowercased() {
        assert_eq!(parse_detect_virt("kvm\n"), Some("kvm".into()));
        assert_eq!(parse_detect_virt("VMware\n"), Some("vmware".into()));
        assert_eq!(
            parse_detect_virt("microsoft\n"),
            Some("microsoft".into()),
            "未知类型原样上报，展示层自己决定怎么显示"
        );
    }

    #[test]
    fn dmi_product_name_maps_known_hypervisors() {
        assert_eq!(
            virt_from_product_name("Standard PC (QEMU, BIOS)"),
            Some("kvm".into())
        );
        assert_eq!(
            virt_from_product_name("KVM\n"),
            Some("kvm".into()),
            "KVM 关键字（大写）也要识别"
        );
        assert_eq!(
            virt_from_product_name("VMware Virtual Platform"),
            Some("vmware".into())
        );
        assert_eq!(
            virt_from_product_name("VirtualBox"),
            Some("virtualbox".into())
        );
        assert_eq!(
            virt_from_product_name("PowerEdge R750"),
            None,
            "普通物理机产品名不能瞎猜"
        );
        assert_eq!(virt_from_product_name(""), None);
    }
}
