//! Read-only MCP (Model Context Protocol) server for PierWave.
//!
//! The process speaks line-delimited JSON-RPC 2.0 on stdin/stdout and only
//! ever opens the master SQLite database in read-only mode. It intentionally
//! does **not** depend on `pierwave-domain`, `pierwave-master` or
//! `pierwave-proto`: the database schema is the single integration point, so
//! this crate cannot accidentally mutate panel state through domain helpers.
//!
//! See `docs/MCP.md` for client configuration and tool examples.

pub mod db;
pub mod protocol;
pub mod tools;

pub use db::Database;
pub use protocol::{serve_stdio, Server};

/// MCP revision implemented by this server.
pub const PROTOCOL_VERSION: &str = "2024-11-05";

/// Name advertised in `serverInfo`.
pub const SERVER_NAME: &str = "pierwave-mcp";

/// Version advertised in `serverInfo`.
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
