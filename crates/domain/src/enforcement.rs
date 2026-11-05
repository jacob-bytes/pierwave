//! 断流（enforcement）的纯规则：原因归并、中文文案。
//!
//! 这里只做字符串处理，不碰数据库与时钟；「是否跨过可用边界」由
//! [`crate::models::package_status_at`] 判定，master 只负责把结果落成事件。

/// 额度用尽。
pub const REASON_EXHAUSTED: &str = "exhausted";
/// 套餐到期。
pub const REASON_EXPIRED: &str = "expired";
/// 套餐被停用（原始状态不是 active）。
pub const REASON_DISABLED: &str = "disabled";

/// 原因展示的固定顺序：到期 → 用尽 → 停用。
const REASON_ORDER: [&str; 3] = [REASON_EXPIRED, REASON_EXHAUSTED, REASON_DISABLED];

/// 合并多个原因（可重复、可已是逗号串），去重并按固定顺序输出。
///
/// 空输入返回空串；未知原因原样保留在末尾，保证脏数据不丢。
pub fn merge_reasons<'a, I>(reasons: I) -> String
where
    I: IntoIterator<Item = &'a str>,
{
    let mut codes: Vec<String> = Vec::new();
    for reason in reasons {
        for part in reason.split(',') {
            let code = part.trim();
            if !code.is_empty() && !codes.iter().any(|existing| existing == code) {
                codes.push(code.to_string());
            }
        }
    }
    codes.sort_by_key(|code| {
        REASON_ORDER
            .iter()
            .position(|known| *known == code)
            .unwrap_or(REASON_ORDER.len())
    });
    codes.join(",")
}

/// 把原因码翻译成面向管理员的中文短语；多个原因用「、」连接。
pub fn reason_text(reason: &str) -> String {
    let labels: Vec<&str> = reason
        .split(',')
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .map(|code| match code {
            REASON_EXHAUSTED => "额度用尽",
            REASON_EXPIRED => "套餐已到期",
            REASON_DISABLED => "套餐已停用",
            other => other,
        })
        .collect();
    if labels.is_empty() {
        "套餐不可用".to_string()
    } else {
        labels.join("、")
    }
}

/// 落库的完整中文事件说明：谁、因为什么、从哪台服务器移除。
pub fn removal_message(username: &str, reason: &str, server_name: &str) -> String {
    format!(
        "用户 {username} 因{}，已从服务器 {server_name} 的配置中移除",
        reason_text(reason)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_reasons_dedupes_and_orders() {
        assert_eq!(merge_reasons(["exhausted"]), "exhausted");
        assert_eq!(
            merge_reasons(["exhausted", "expired", "exhausted"]),
            "expired,exhausted"
        );
        assert_eq!(
            merge_reasons(["expired,disabled", "expired"]),
            "expired,disabled"
        );
        assert_eq!(merge_reasons(["weird", "expired"]), "expired,weird");
        assert_eq!(merge_reasons(Vec::<&str>::new()), "");
    }

    #[test]
    fn reason_text_is_chinese() {
        assert_eq!(reason_text("exhausted"), "额度用尽");
        assert_eq!(reason_text("expired"), "套餐已到期");
        assert_eq!(reason_text("expired,exhausted"), "套餐已到期、额度用尽");
        assert_eq!(reason_text(""), "套餐不可用");
        // 未知原因不丢，原样展示。
        assert_eq!(reason_text("paused"), "paused");
    }

    #[test]
    fn removal_message_names_user_reason_and_server() {
        let message = removal_message("alice", "exhausted", "hk-1");
        assert_eq!(
            message,
            "用户 alice 因额度用尽，已从服务器 hk-1 的配置中移除"
        );
    }
}
