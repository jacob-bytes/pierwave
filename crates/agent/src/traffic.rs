//! Xray 流量采样：执行 `xray api statsquery`、解析 email 维度计数器、算增量。
//!
//! 基线（`last`）只在本进程内保存，跨重连保留：断线重连不能把「已上报的累计值」
//! 再报一遍，否则主控会重复计费。Xray 重启会让计数器归零，表现为 `now < last`，
//! 此时按整份新计数上报并 warn。

use std::collections::HashMap;

use anyhow::{Context, Result};
use mmrust_proto::TrafficDelta;

use crate::{command_output, run_program};

/// 每个 email 的 (uplink, downlink) 累计计数。
pub type Snapshot = HashMap<String, (u64, u64)>;

/// 一轮采样的结果。
#[derive(Debug, Default)]
pub struct Sample {
    /// 只包含非零增量，按 email 排序，保证上报 JSON 稳定。
    pub deltas: Vec<TrafficDelta>,
    /// 本轮是否检测到计数器归零（Xray 重启）。
    pub reset: bool,
}

/// 跨重连保留的采样器：内存里保存上一轮快照。
#[derive(Debug, Default)]
pub struct TrafficSampler {
    last: Snapshot,
}

impl TrafficSampler {
    pub fn new() -> Self {
        Self::default()
    }

    /// 执行配置的采样命令；命令失败或输出不是合法 JSON 时返回 `Err`，
    /// **不修改 `last`**，下一轮重新建立基线。
    pub fn sample(&mut self, command: &str) -> Result<Sample> {
        let snapshot = query_stats(command)?;
        Ok(self.advance(snapshot))
    }

    /// 用一份新快照推进基线并算增量；拆出来便于纯逻辑单测。
    pub fn advance(&mut self, now: Snapshot) -> Sample {
        let mut deltas = Vec::new();
        let mut reset = false;

        for (email, &(uplink, downlink)) in &now {
            let (delta_up, delta_down) = match self.last.get(email) {
                // 正常情况：计数器只增不减。
                Some(&(last_up, last_down)) if uplink >= last_up && downlink >= last_down => {
                    (uplink - last_up, downlink - last_down)
                }
                // 任一方向变小 = Xray 重启后计数器归零，按当前值全量算。
                Some(_) => {
                    reset = true;
                    (uplink, downlink)
                }
                None => (uplink, downlink),
            };
            if delta_up > 0 || delta_down > 0 {
                deltas.push(TrafficDelta {
                    email: email.clone(),
                    uplink: delta_up,
                    downlink: delta_down,
                });
            }
        }

        deltas.sort_by(|left, right| left.email.cmp(&right.email));
        // 只有成功解析出快照才覆盖基线；失败的轮次不会走到这里。
        for (email, counters) in now {
            self.last.insert(email, counters);
        }

        Sample { deltas, reset }
    }

    #[cfg(test)]
    fn baseline(&self) -> &Snapshot {
        &self.last
    }
}

/// 解析 `xray api statsquery` 的 JSON：
/// `{"stat":[{"name":"user>>>a@b>>>traffic>>>uplink","value":"123"}]}`。
///
/// 只认 `user>>>` 前缀（计费口径）；`inbound>>>` 等其它维度忽略。
/// 无法识别的条目跳过而不是整份失败，避免一条脏数据让整轮流量丢失。
pub fn parse_snapshot(raw: &str) -> Result<Snapshot> {
    let value: serde_json::Value =
        serde_json::from_str(raw).context("Xray statsquery 输出不是 JSON")?;
    let stats = value
        .get("stat")
        .and_then(serde_json::Value::as_array)
        .context("Xray statsquery 输出缺少 stat 数组")?;

    let mut snapshot = Snapshot::new();
    for stat in stats {
        let Some(name) = stat.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let Some(value) = stat.get("value").and_then(stat_value) else {
            continue;
        };
        let Some((email, direction)) = parse_name(name) else {
            continue;
        };
        let entry = snapshot.entry(email.to_string()).or_insert((0, 0));
        match direction {
            "uplink" => entry.0 = entry.0.saturating_add(value),
            "downlink" => entry.1 = entry.1.saturating_add(value),
            _ => {}
        }
    }
    Ok(snapshot)
}

fn stat_value(value: &serde_json::Value) -> Option<u64> {
    match value {
        serde_json::Value::String(text) => text.trim().parse::<u64>().ok(),
        serde_json::Value::Number(number) => number.as_u64(),
        _ => None,
    }
}

/// `user>>>{email}>>>traffic>>>uplink` → `(email, "uplink")`。
fn parse_name(name: &str) -> Option<(&str, &str)> {
    let rest = name.strip_prefix("user>>>")?;
    let (email, direction) = rest.rsplit_once(">>>traffic>>>")?;
    if email.is_empty() {
        return None;
    }
    Some((email, direction))
}

/// 执行命令并解析 stdout；失败时把 stderr 带进错误信息，便于排查。
fn query_stats(command: &str) -> Result<Snapshot> {
    if command.trim().is_empty() {
        anyhow::bail!("stats_query_command 为空，跳过流量采样");
    }
    let output = run_program(command, None)?;
    if !output.status.success() {
        let detail = command_output(&output);
        anyhow::bail!("statsquery 命令失败（{}）{detail}", output.status);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_snapshot(&stdout)
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;

    const EMAIL: &str = "user-1@hk-1";

    fn json(uplink: u64, downlink: u64) -> String {
        format!(
            r#"{{"stat":[
                {{"name":"user>>>{EMAIL}>>>traffic>>>uplink","value":"{uplink}"}},
                {{"name":"user>>>{EMAIL}>>>traffic>>>downlink","value":"{downlink}"}}
            ]}}"#
        )
    }

    fn delta_of(sample: &Sample, email: &str) -> (u64, u64) {
        sample
            .deltas
            .iter()
            .find(|delta| delta.email == email)
            .map(|delta| (delta.uplink, delta.downlink))
            .unwrap_or((0, 0))
    }

    #[test]
    fn parses_user_counters_and_ignores_other_dimensions() {
        let raw = r#"{"stat":[
            {"name":"user>>>alice@node-a>>>traffic>>>uplink","value":"123"},
            {"name":"user>>>alice@node-a>>>traffic>>>downlink","value":"456"},
            {"name":"user>>>bob@node-b>>>traffic>>>uplink","value":789},
            {"name":"inbound>>>node-a>>>traffic>>>uplink","value":"9999"},
            {"name":"user>>>broken","value":"1"},
            {"name":"user>>>weird@x>>>traffic>>>uplink","value":"not-a-number"}
        ]}"#;
        let snapshot = parse_snapshot(raw).unwrap();

        assert_eq!(snapshot.get("alice@node-a"), Some(&(123, 456)));
        // value 也接受 JSON 数字，便于兼容不同版本输出。
        assert_eq!(snapshot.get("bob@node-b"), Some(&(789, 0)));
        assert!(!snapshot.contains_key("weird@x"));
        assert_eq!(snapshot.len(), 2);
    }

    #[test]
    fn parses_both_directions_of_the_same_user() {
        let snapshot = parse_snapshot(&json(1000, 500)).unwrap();
        assert_eq!(snapshot.get(EMAIL), Some(&(1000, 500)));
    }

    #[test]
    fn rejects_non_json_and_missing_stat() {
        assert!(parse_snapshot("not-json").is_err());
        assert!(parse_snapshot("{}").is_err());
        assert!(parse_snapshot(r#"{"stat":[]}"#).unwrap().is_empty());
    }

    #[test]
    fn increments_are_relative_to_the_previous_snapshot() {
        let mut sampler = TrafficSampler::new();

        let first = sampler.advance([("a@n".to_string(), (1000, 500))].into_iter().collect());
        assert_eq!(delta_of(&first, "a@n"), (1000, 500));
        assert!(!first.reset);

        let second = sampler.advance([("a@n".to_string(), (3000, 1500))].into_iter().collect());
        assert_eq!(delta_of(&second, "a@n"), (2000, 1000));
        assert!(!second.reset);

        // 计数不变 → 不上报。
        let third = sampler.advance([("a@n".to_string(), (3000, 1500))].into_iter().collect());
        assert!(third.deltas.is_empty());
        assert!(!third.reset);
    }

    #[test]
    fn only_non_zero_deltas_are_reported() {
        let mut sampler = TrafficSampler::new();
        let sample = sampler.advance(
            [
                ("zero@n".to_string(), (0, 0)),
                ("up@n".to_string(), (10, 0)),
                ("down@n".to_string(), (0, 10)),
            ]
            .into_iter()
            .collect(),
        );

        let emails: Vec<&str> = sample.deltas.iter().map(|d| d.email.as_str()).collect();
        assert_eq!(emails, vec!["down@n", "up@n"], "按 email 排序且不含零项");
    }

    #[test]
    fn counter_reset_reports_full_values() {
        let mut sampler = TrafficSampler::new();
        sampler.advance([("a@n".to_string(), (5000, 3000))].into_iter().collect());

        let reset = sampler.advance([("a@n".to_string(), (800, 200))].into_iter().collect());
        assert!(reset.reset, "now < last 应识别为 Xray 重启");
        assert_eq!(delta_of(&reset, "a@n"), (800, 200));
    }

    #[test]
    fn one_direction_reset_also_counts_as_reset() {
        let mut sampler = TrafficSampler::new();
        sampler.advance([("a@n".to_string(), (1000, 1000))].into_iter().collect());

        // 上行变大、下行归零：任一方向倒退就按重置处理。
        let sample = sampler.advance([("a@n".to_string(), (2000, 10))].into_iter().collect());
        assert!(sample.reset);
        assert_eq!(delta_of(&sample, "a@n"), (2000, 10));
    }

    /// 每个用例独立临时目录，Drop 时清理。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("mmrust-stats-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn script(&self) -> PathBuf {
            self.0.join("stats.sh")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn write_script(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::write(path, body).unwrap();
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_sample_does_not_overwrite_baseline() {
        let dir = TempDir::new();
        let script = dir.script();
        let command = script.to_str().unwrap().to_string();
        let mut sampler = TrafficSampler::new();

        write_script(
            &script,
            &format!("#!/bin/sh\ncat <<'JSON'\n{}\nJSON\n", json(1000, 500)),
        );
        let first = sampler.sample(&command).unwrap();
        assert_eq!(delta_of(&first, EMAIL), (1000, 500));

        // 输出不是 JSON：本轮失败，但基线保持 1000/500。
        write_script(&script, "#!/bin/sh\necho not-json\n");
        assert!(sampler.sample(&command).is_err());
        assert_eq!(
            sampler.baseline().get(EMAIL),
            Some(&(1000, 500)),
            "失败轮次不能覆盖上一轮基线"
        );

        // 命令非零退出：同样不算基线。
        write_script(&script, "#!/bin/sh\necho boom >&2\nexit 1\n");
        assert!(sampler.sample(&command).is_err());
        assert_eq!(sampler.baseline().get(EMAIL), Some(&(1000, 500)));

        // 恢复后应从旧基线继续，而不是把 3000 全量重报。
        write_script(
            &script,
            &format!("#!/bin/sh\ncat <<'JSON'\n{}\nJSON\n", json(3000, 1500)),
        );
        let recovered = sampler.sample(&command).unwrap();
        assert_eq!(delta_of(&recovered, EMAIL), (2000, 1000));
        assert!(!recovered.reset);
    }

    #[cfg(unix)]
    #[test]
    fn empty_command_fails_without_touching_baseline() {
        let mut sampler = TrafficSampler::new();
        assert!(sampler.sample("   ").is_err());
        assert!(sampler.baseline().is_empty());
    }
}
