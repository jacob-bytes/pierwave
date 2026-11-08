//! 领域层可翻译错误：`code` + `params` + 中文兜底文案。
//!
//! 领域层不依赖 axum，也不需要知道 HTTP 状态码；它只负责把「面向用户的校验失败」
//! 标注成稳定错误码，方便 master 在响应里带上 `code`/`params`，让英文界面查词典。
//!
//! 它可以被 `anyhow::Result` 直接承载（实现了 [`std::error::Error`]），master
//! 侧通过错误链 `downcast_ref::<DomainError>()` 取出结构化信息。
//!
//! 只放**用户能看懂、并且应该收到 400**的校验错误；IO、数据库等内部错误继续用
//! `anyhow!`，不要在这里硬套错误码。

use std::fmt;

use serde_json::Value;

/// 领域层的错误码。
///
/// `params` 为 [`Value::Null`] 表示没有插值参数，master 序列化时不会输出该字段。
#[derive(Debug, Clone, PartialEq)]
pub struct DomainError {
    /// 稳定错误码，命名规则见 `docs/ERRORS.md`（`域.snake_case`）。
    pub code: &'static str,
    /// 前端词典插值用的参数；只放短值，不放整段文案。
    pub params: Value,
    /// 中文兜底文案；前端查不到词典时直接展示它。
    pub message: String,
}

impl DomainError {
    /// 无插值参数的校验错误。
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            params: Value::Null,
            message: message.into(),
        }
    }

    /// 带插值参数的校验错误。
    pub fn with_params(code: &'static str, params: Value, message: impl Into<String>) -> Self {
        Self {
            code,
            params,
            message: message.into(),
        }
    }

    /// 响应里要输出的 `params`：无参数时返回 `None`，避免出现 `"params": null`。
    pub fn params_option(&self) -> Option<Value> {
        (!self.params.is_null()).then(|| self.params.clone())
    }
}

impl fmt::Display for DomainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DomainError {}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    #[test]
    fn new_error_has_code_message_and_no_params() {
        let error = DomainError::new("backup.restore_invalid", "备份文件校验失败");

        assert_eq!(error.code, "backup.restore_invalid");
        assert_eq!(error.message, "备份文件校验失败");
        assert_eq!(error.params, Value::Null);
        assert_eq!(error.params_option(), None);
        assert_eq!(error.to_string(), "备份文件校验失败");
    }

    #[test]
    fn with_params_keeps_params_for_the_frontend() {
        let error = DomainError::with_params(
            "backup.restore_too_large",
            json!({ "max_mb": 512 }),
            "备份文件超过 512 MB 上限",
        );

        assert_eq!(error.code, "backup.restore_too_large");
        assert_eq!(error.params, json!({ "max_mb": 512 }));
        assert_eq!(error.params_option(), Some(json!({ "max_mb": 512 })));
    }

    #[test]
    fn anyhow_carries_domain_error_for_downcasting() {
        let error: anyhow::Error = DomainError::with_params(
            "outbound.tag_reserved",
            json!({ "tag": "direct" }),
            "tag「direct」是保留字，请换一个",
        )
        .into();

        let domain = error
            .downcast_ref::<DomainError>()
            .expect("anyhow 应保留 DomainError 类型");
        assert_eq!(domain.code, "outbound.tag_reserved");
        assert_eq!(domain.params, json!({ "tag": "direct" }));
        assert_eq!(format!("{error:#}"), "tag「direct」是保留字，请换一个");
    }

    #[test]
    fn context_wrapped_domain_error_stays_in_the_chain() {
        let error: anyhow::Error = anyhow::Error::new(DomainError::new(
            "release.signature_invalid",
            "清单签名校验失败",
        ))
        .context("升级清单验签失败");

        let domain = error
            .chain()
            .find_map(|cause| cause.downcast_ref::<DomainError>())
            .expect("包装后的错误链里仍能找到 DomainError");
        assert_eq!(domain.code, "release.signature_invalid");
    }
}
