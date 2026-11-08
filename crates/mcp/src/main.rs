//! `pierwave-mcp` binary entry point.
//!
//! stdout is reserved for JSON-RPC; diagnostics go to stderr.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{bail, Context};
use pierwave_mcp::{serve_stdio, Database, PROTOCOL_VERSION};

const USAGE: &str = "\
pierwave-mcp — read-only MCP server for PierWave / PierWave 只读 MCP 服务

用法 / Usage:
  pierwave-mcp [--db <path>]

选项 / Options:
  --db <path>     主控 SQLite 文件路径（默认读取 PIERWAVE_DB，再回落到 data/pierwave.db）
                  Path to the master SQLite file (defaults to PIERWAVE_DB, then data/pierwave.db)
  -h, --help      显示帮助 / Show this help
  -V, --version   显示版本 / Show version

数据库只会以只读方式打开（?mode=ro）；文件不存在时启动失败。
The database is opened read-only (?mode=ro); a missing file is a startup error.

示例 / Examples:
  pierwave-mcp --db ./data/pierwave.db
  PIERWAVE_DB=./data/pierwave.db pierwave-mcp
";

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("pierwave-mcp: {error:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let raw_path = parse_db_arg(&args)?
        .or_else(|| {
            std::env::var("PIERWAVE_DB")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| "data/pierwave.db".to_string());
    let path = normalize_db_path(&raw_path)?;
    let db = Database::open_read_only(&path).await?;

    eprintln!(
        "pierwave-mcp {}: read-only database {}, MCP {}",
        env!("CARGO_PKG_VERSION"),
        path.display(),
        PROTOCOL_VERSION
    );
    serve_stdio(db).await
}

fn parse_db_arg(args: &[String]) -> anyhow::Result<Option<String>> {
    let mut db = None;
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--db" {
            let value = args
                .get(index + 1)
                .with_context(|| "--db 缺少路径 / --db requires a path")?;
            if value.trim().is_empty() {
                bail!("--db 路径不能为空 / --db path must not be empty");
            }
            db = Some(value.clone());
            index += 2;
        } else if let Some(value) = arg.strip_prefix("--db=") {
            if value.trim().is_empty() {
                bail!("--db 路径不能为空 / --db path must not be empty");
            }
            db = Some(value.to_string());
            index += 1;
        } else {
            bail!("未知参数 / unknown argument: {arg}\n\n{USAGE}");
        }
    }
    Ok(db)
}

/// Accept a plain path or the `sqlite://...?mode=...` form used by the master.
fn normalize_db_path(raw: &str) -> anyhow::Result<PathBuf> {
    let raw = raw.trim();
    let without_scheme = raw
        .strip_prefix("sqlite://")
        .or_else(|| raw.strip_prefix("sqlite:"))
        .unwrap_or(raw);
    let path = without_scheme.split('?').next().unwrap_or(without_scheme);
    if path.is_empty() || path == ":memory:" {
        bail!(
            "pierwave-mcp 需要文件型 SQLite 数据库（只读打开）。\n\
             pierwave-mcp requires a file-backed SQLite database (opened read-only)."
        );
    }
    Ok(PathBuf::from(path))
}
