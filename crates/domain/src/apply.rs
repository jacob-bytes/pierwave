//! Agent `ApplyResult` 的结构化解析。
//!
//! Agent 落受管文件走两阶段提交：提交阶段失败时，**失败点之前**的文件已经
//! rename 生效，不能伪装成「整体失败」。线协议里 `ApplyResult.error` 只是
//! 字符串，所以 Agent 用稳定的文本契约把结论带上来：
//!
//! ```text
//! [agent.apply_files.partial] 受管文件部分生效（partial success），阶段: {stage}；\
//! 已生效 {n}/{total}: {p1}, {p2}；其余文件未生效、临时文件已清理；失败原因: {cause}
//! ```
//!
//! 主控在落库前用 [`ApplyReport::from_result`] 解析：识别标记、抽出阶段与
//! 已生效路径，存成结构化字段。**其它错误不解析、不改写**，原文照旧展示。

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

/// Agent 上报「部分成功」时使用的稳定标记（文本契约，主控与 Agent 共用）。
pub const PARTIAL_MARKER: &str = "[agent.apply_files.partial]";

/// 受管文件错误标记的公共前缀：`[agent.apply_files.{code}]`。
pub const ERROR_MARKER_PREFIX: &str = "[agent.apply_files.";

/// 最近一次 `ApplyResult` 的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyStatus {
    /// Agent 成功收敛到期望态。
    Ok,
    /// 受管文件部分生效：有文件已经对线上生效，也有文件没生效。
    Partial,
    /// 整体失败；没有任何受管文件生效。
    Failed,
}

impl ApplyStatus {
    /// 落库用的稳定字符串（`servers.apply_status`）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Partial => "partial",
            Self::Failed => "failed",
        }
    }

    /// 读库：非法/未知值返回 `None`，由调用方按「从未上报」处理。
    pub fn from_db(raw: &str) -> Option<Self> {
        match raw {
            "ok" => Some(Self::Ok),
            "partial" => Some(Self::Partial),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// 部分成功的结构化详情（落库为 JSON，随服务器详情返回）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PartialApply {
    /// Agent 报告的失败阶段，如 `写临时文件 / write-temp`、`提交 rename / commit`。
    /// 缺字段时为空串。
    #[serde(default)]
    pub stage: String,
    /// 已经 rename 生效的目标文件（按提交顺序）。
    #[serde(default)]
    pub effective: Vec<String>,
    /// 本轮期望落盘的文件总数。
    #[serde(default)]
    pub total: usize,
}

impl PartialApply {
    /// 已生效文件数。**不落库**：永远等于 `effective.len()`，避免两份数据打架。
    pub fn effective_count(&self) -> usize {
        self.effective.len()
    }

    /// 结构是否可信：至少有一个已生效路径。Agent 的契约保证 partial 时非空，
    /// 但解析是纯文本输入，调用方可以用它决定是否展示。
    pub fn is_meaningful(&self) -> bool {
        !self.effective.is_empty()
    }
}

/// 手工序列化：`effective_count` 是派生值，序列化时现算，保证与 `effective`
/// 永远一致；API 消费者不用自己数数组长度。
impl Serialize for PartialApply {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("PartialApply", 4)?;
        state.serialize_field("stage", &self.stage)?;
        state.serialize_field("effective", &self.effective)?;
        state.serialize_field("effective_count", &self.effective.len())?;
        state.serialize_field("total", &self.total)?;
        state.end()
    }
}

/// 一次 `ApplyResult` 的结构化视图：直接交给仓储落库。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyReport {
    pub status: ApplyStatus,
    /// Agent 上报的配置版本（`ApplyResult.version`）。
    pub version: i64,
    /// 错误原文；成功时为 `None`。非 partial 错误**原样保留**，不做改写。
    pub error: Option<String>,
    /// 仅 `status == Partial` 时有值。
    pub partial: Option<PartialApply>,
}

impl ApplyReport {
    /// 把线协议里的 `(version, ok, error)` 归一化。
    ///
    /// `ok == true` 时不解析错误文本：即使旧 Agent 带着历史错误串上报成功，
    /// 也不能把成功的服务器标成 partial。
    pub fn from_result(version: i64, ok: bool, error: Option<&str>) -> Self {
        let error = error
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string);
        if ok {
            return Self {
                status: ApplyStatus::Ok,
                version,
                error: None,
                partial: None,
            };
        }
        let partial = error.as_deref().and_then(parse_partial);
        let status = if partial.is_some() {
            ApplyStatus::Partial
        } else {
            ApplyStatus::Failed
        };
        Self {
            status,
            version,
            error,
            partial,
        }
    }
}

/// 从 Agent 错误文本里解析「部分成功」详情。
///
/// 只认 [`PARTIAL_MARKER`]；没有标记（包括 `write_failed` / `commit_failed`
/// 等其它受管文件错误、网络错误、任意异常文案）一律返回 `None`，
/// 主控按原文展示，不能被误判成 partial。
///
/// 解析是**尽力而为**：Agent 的文案可能演进（多一句说明、少一个字段），
/// 但只要标记还在，就要尽量把已知信息抽出来，绝不因为缺字段丢掉「部分成功」
/// 这个结论：
///
/// * 缺 `阶段:` → `stage` 为空串；
/// * 缺 `n/total` → `n` 用已解析路径数、`total` 至少等于 `n`；
/// * 路径为空 → `effective` 为空数组（`total` 仍按文本保留）。
///
/// 路径按 Agent 的 `, ` 分隔符切分；路径本身含 `, ` 时无法与分隔符区分，
/// 这是文本契约的已知限制（Agent 侧受管路径都是证书/配置文件名）。
pub fn parse_partial(message: &str) -> Option<PartialApply> {
    let at = message.find(PARTIAL_MARKER)?;
    let rest = &message[at + PARTIAL_MARKER.len()..];

    // 阶段：`阶段: {label}；`（label 里不会出现全角分号）。
    let stage = rest
        .split_once("阶段: ")
        .map(|(_, after)| after.split('；').next().unwrap_or("").trim().to_string())
        .unwrap_or_default();

    let mut reported_count = None;
    let mut reported_total = None;
    let mut effective: Vec<String> = Vec::new();

    // 计数 + 路径：`已生效 {n}/{total}: {paths}；...`
    if let Some((_, after)) = rest.split_once("已生效 ") {
        // 路径列表到下一个全角分号为止，避免把「失败原因」里的逗号也吃进来。
        let head = after.split('；').next().unwrap_or("");
        let (numbers, paths) = match head.split_once(": ") {
            Some((numbers, paths)) => (numbers, Some(paths)),
            None => (head, None),
        };
        if let Some((count, total)) = numbers.trim().split_once('/') {
            reported_count = count.trim().parse::<usize>().ok();
            reported_total = total.trim().parse::<usize>().ok();
        }
        if let Some(paths) = paths {
            effective = paths
                .split(", ")
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(str::to_string)
                .collect();
        }
    }

    // 计数缺失 / 坏掉时以实际路径为准；`total` 不能小于已生效数，
    // 否则前端会出现「3/2 个文件已生效」这种自相矛盾的文案。
    let actual = effective.len();
    let total = reported_total
        .or(reported_count)
        .unwrap_or(actual)
        .max(actual);

    Some(PartialApply {
        stage,
        effective,
        total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Agent 侧 `ApplyFilesError::Display` 的真实形状（提交阶段失败，2/3 生效）。
    const PARTIAL_MESSAGE: &str = "[agent.apply_files.partial] 受管文件部分生效（partial success），\
         阶段: 提交 rename / commit；已生效 2/3: /etc/pierwave/xray/server.crt, /etc/pierwave/xray/server.key；\
         其余文件未生效、临时文件已清理；失败原因: 替换文件失败（/etc/pierwave/xray/ca.pem）: Is a directory";

    #[test]
    fn parses_normal_partial_marker() {
        let report = ApplyReport::from_result(7, false, Some(PARTIAL_MESSAGE));
        assert_eq!(report.status, ApplyStatus::Partial);
        assert_eq!(report.version, 7);
        assert_eq!(report.error.as_deref(), Some(PARTIAL_MESSAGE));
        let partial = report.partial.expect("应解析出 partial 详情");
        assert_eq!(partial.stage, "提交 rename / commit");
        assert_eq!(
            partial.effective,
            vec![
                "/etc/pierwave/xray/server.crt".to_string(),
                "/etc/pierwave/xray/server.key".to_string()
            ]
        );
        assert_eq!(partial.total, 3);
        assert_eq!(partial.effective_count(), 2);
        assert!(partial.is_meaningful());

        // 序列化带派生计数，API 消费者不用自己数。
        let value = serde_json::to_value(&partial).unwrap();
        assert_eq!(value["effective_count"], 2);
        assert_eq!(value["total"], 3);
        assert_eq!(value["stage"], "提交 rename / commit");
    }

    /// 字段缺失（阶段 / 计数）：仍然识别为 partial，用可用的信息降级。
    #[test]
    fn parses_partial_with_missing_fields() {
        // 没有 `阶段:`。
        let no_stage =
            "[agent.apply_files.partial] 受管文件部分生效，已生效 1/2: /a.pem；其余文件未生效";
        let partial = parse_partial(no_stage).expect("标记还在就必须识别");
        assert_eq!(partial.stage, "");
        assert_eq!(partial.effective, vec!["/a.pem"]);
        assert_eq!(partial.total, 2);

        // 没有 `n/total`：按实际路径数补齐，total 不能小于路径数。
        let no_counts =
            "[agent.apply_files.partial] 受管文件部分生效，已生效 : /a.pem, /b.pem；其余文件未生效";
        let partial = parse_partial(no_counts).expect("标记还在就必须识别");
        assert_eq!(partial.effective_count(), 2);
        assert_eq!(partial.total, 2);

        // 只有标记、其它什么都没有：不能 panic，也不能返回「没有 partial」。
        let only_marker = "[agent.apply_files.partial] boom";
        let partial = parse_partial(only_marker).expect("标记还在就必须识别");
        assert_eq!(partial.stage, "");
        assert!(partial.effective.is_empty());
        assert_eq!(partial.total, 0);
        assert!(!partial.is_meaningful());
    }

    /// 路径为空（提交阶段不可能发生，但文本解析必须能接住）：仍报 partial，
    /// `n = 0`、`total` 保留，前端显示「0/total」而不是把它当整体失败。
    #[test]
    fn parses_partial_with_empty_paths() {
        let report = ApplyResultFixture::partial("提交 rename / commit", 0, 2, "");
        let partial = report.partial.expect("路径为空也必须识别为 partial");
        assert_eq!(partial.effective_count(), 0);
        assert_eq!(partial.total, 2);
        assert_eq!(partial.stage, "提交 rename / commit");
        assert!(!partial.is_meaningful());
        assert_eq!(report.status, ApplyStatus::Partial);
    }

    /// 非 partial 的错误（受管文件整体失败 / 任意运行时错误）不被误判：
    /// 状态是 failed，错误原样保留。
    #[test]
    fn non_partial_errors_are_not_misclassified() {
        for message in [
            "[agent.apply_files.write_failed] 受管文件应用失败（managed files apply failed），阶段: 写临时文件 / write-temp；没有任何文件生效（no managed file was changed）；失败原因: 创建目录失败: /etc/pierwave/xray",
            "[agent.apply_files.commit_failed] 受管文件应用失败（managed files apply failed），阶段: 提交 rename / commit；没有任何文件生效（no managed file was changed）；失败原因: EIO",
            "dial master: connection refused",
            "受管文件部分生效", // 只有人话、没有稳定标记：不能靠文案猜。
            "",
        ] {
            let report = ApplyReport::from_result(3, false, Some(message));
            assert_eq!(
                report.status,
                ApplyStatus::Failed,
                "不能误判为 partial：{message}"
            );
            assert!(report.partial.is_none());
            let expected = message.trim();
            assert_eq!(
                report.error.as_deref(),
                if expected.is_empty() {
                    None
                } else {
                    Some(expected)
                },
                "错误原文必须保留：{message}"
            );
        }
    }

    /// 成功结果即使带着历史错误串也不能是 partial；空错误串归一化成 None。
    #[test]
    fn success_ignores_error_text_and_blank_errors_are_none() {
        let ok = ApplyReport::from_result(9, true, Some(PARTIAL_MESSAGE));
        assert_eq!(ok.status, ApplyStatus::Ok);
        assert!(ok.partial.is_none());
        assert!(ok.error.is_none());

        let ok = ApplyReport::from_result(9, true, None);
        assert_eq!(ok.status, ApplyStatus::Ok);

        let failed = ApplyReport::from_result(9, false, Some("   "));
        assert_eq!(failed.status, ApplyStatus::Failed);
        assert!(failed.error.is_none());
    }

    #[test]
    fn status_round_trips_through_db_strings() {
        for status in [ApplyStatus::Ok, ApplyStatus::Partial, ApplyStatus::Failed] {
            assert_eq!(ApplyStatus::from_db(status.as_str()), Some(status));
        }
        assert_eq!(ApplyStatus::from_db("bogus"), None);
    }

    /// 生成 Agent 契约形状的错误文本，避免测试里手写时漏掉分隔符。
    struct ApplyResultFixture;

    impl ApplyResultFixture {
        fn partial(stage: &str, count: usize, total: usize, paths: &str) -> ApplyReport {
            let message = format!(
                "[agent.apply_files.partial] 受管文件部分生效（partial success），\
                 阶段: {stage}；已生效 {count}/{total}: {paths}；其余文件未生效、临时文件已清理；\
                 失败原因: boom"
            );
            ApplyReport::from_result(1, false, Some(&message))
        }
    }
}
