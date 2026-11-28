//! 主控与 Agent 共用的最小工具层。
//!
//! 这里只放**不依赖业务模型、也不依赖数据库/HTTP**的通用能力：
//!
//! - [`fs_security`]：秘密文件与私有目录的权限收紧；
//! - [`release`]：发布产物的 Ed25519 签名与 SHA256 清单校验；
//! - [`error`]：可翻译错误 `DomainError`（`code` + `params` + 中文兜底）。
//!
//! 拆分动机：Agent 只需要上面这些工具，却曾因此依赖整个 `pierwave-domain`
//! （连带 sqlx / tokio）。独立成 `pierwave-common` 后，Agent 可以不依赖领域层
//! 单独发版；`pierwave-domain` 通过 re-export 保持既有路径不变。
//!
//! **依赖约束**：不引入 sqlx、tokio、axum；测试所需的依赖放 `dev-dependencies`。

pub mod error;
pub mod fs_security;
pub mod release;
