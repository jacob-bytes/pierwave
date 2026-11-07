//! 备份与恢复（管理员）。
//!
//! 导出用 `VACUUM INTO` 生成一致性快照再 gzip；恢复只把校验通过的文件落盘为
//! `<db>.restore-pending`，真正替换发生在下次启动、打开连接池之前
//! （见 `pierwave_domain::backup::apply_pending_restore`）。

use std::io::Read;
use std::path::{Path, PathBuf};

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use axum::Json;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;

use pierwave_domain::backup::{self, MAX_BACKUP_BYTES};

use crate::audit;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// `GET /api/v1/backup`：下载 gzip 压缩的一致性快照。
pub async fn export(State(state): State<AppState>, user: CurrentUser) -> AppResult<Response> {
    user.require_admin()?;
    let db_path = backup_db_path(&state)?;
    let dir = parent_dir(&db_path);
    let timestamp = backup::filename_timestamp();
    let snapshot = dir.join(format!(
        ".pierwave-backup-{timestamp}-{}.tmp",
        uuid::Uuid::new_v4()
    ));
    // Drop 时删除：VACUUM INTO 失败、gzip 失败或正常返回都不会留下临时文件。
    let _guard = TempFile::new(snapshot.clone());

    backup::create_snapshot(&state.db.pool, &snapshot).await?;
    let db_bytes = std::fs::metadata(&snapshot)?.len();

    let gzip_source = snapshot.clone();
    let gz = tokio::task::spawn_blocking(move || gzip_file(&gzip_source))
        .await
        .map_err(|error| AppError::Internal(anyhow::anyhow!("压缩备份失败：{error}")))??;

    let filename = format!("pierwave-backup-{timestamp}.db.gz");
    audit::record(
        &state,
        &user.0,
        "backup.export",
        "backup",
        json!({ "bytes": gz.len(), "db_bytes": db_bytes }),
    )
    .await;

    let mut response = Response::new(Body::from(gz));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/gzip"),
    );
    let disposition = format!("attachment; filename=\"{filename}\"");
    let disposition =
        HeaderValue::from_str(&disposition).map_err(|error| AppError::Internal(error.into()))?;
    response
        .headers_mut()
        .insert(header::CONTENT_DISPOSITION, disposition);
    Ok(response)
}

/// `POST /api/v1/backup/restore`：上传 `.db` 或 `.db.gz`，落盘为待恢复文件。
pub async fn restore(
    State(state): State<AppState>,
    user: CurrentUser,
    body: Body,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let db_path = backup_db_path(&state)?;
    let dir = parent_dir(&db_path);
    let pending = backup::pending_path(&db_path);
    let token = uuid::Uuid::new_v4();

    // 原始上传体（可能是 gzip，也可能直接是 .db）。
    let upload = dir.join(format!(".pierwave-restore-upload-{token}.tmp"));
    let _upload_guard = TempFile::new(upload.clone());
    save_body(body, &upload).await?;

    let compressed = is_gzip(&upload)?;
    let raw_path: PathBuf;
    let _raw_guard: Option<TempFile>;
    if compressed {
        let raw = dir.join(format!(".pierwave-restore-raw-{token}.db"));
        let source = upload.clone();
        let target = raw.clone();
        tokio::task::spawn_blocking(move || gunzip_file(&source, &target))
            .await
            .map_err(|error| AppError::Internal(anyhow::anyhow!("解压备份失败：{error}")))?
            .map_err(restore_gunzip_error)?;
        _raw_guard = Some(TempFile::new(raw.clone()));
        raw_path = raw;
    } else {
        _raw_guard = None;
        raw_path = upload.clone();
    }

    let raw_bytes = backup::validate_backup_file(&raw_path)
        .await
        .map_err(restore_validation_error)?;

    // 原子写：校验通过的完整文件已经写盘并 sync，落位只做同目录 rename。
    std::fs::rename(&raw_path, &pending).map_err(|error| AppError::Internal(error.into()))?;

    audit::record(
        &state,
        &user.0,
        "backup.restore.schedule",
        "backup",
        json!({ "bytes": raw_bytes, "compressed": compressed }),
    )
    .await;

    Ok(Json(json!({
        "restart_required": true,
        "pending": {
            "uploaded_at": uploaded_at(&pending),
            "bytes": raw_bytes,
        },
    })))
}

/// `GET /api/v1/backup/info`：当前库大小与待恢复状态。
pub async fn info(State(state): State<AppState>, user: CurrentUser) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let db_path = backup_db_path(&state)?;
    let db_bytes = std::fs::metadata(&db_path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    Ok(Json(json!({
        "db_bytes": db_bytes,
        "pending": pending_info(&db_path),
    })))
}

/// `DELETE /api/v1/backup/restore`：取消待恢复文件。
pub async fn cancel_restore(
    State(state): State<AppState>,
    user: CurrentUser,
) -> AppResult<Json<Value>> {
    user.require_admin()?;
    let db_path = backup_db_path(&state)?;
    let pending = backup::pending_path(&db_path);
    if !pending.exists() {
        return Err(AppError::coded(
            "backup.restore_no_pending",
            None,
            "没有待恢复的备份",
        ));
    }
    let bytes = std::fs::metadata(&pending)
        .map(|meta| meta.len())
        .unwrap_or(0);
    std::fs::remove_file(&pending)?;
    audit::record(
        &state,
        &user.0,
        "backup.restore.cancel",
        "backup",
        json!({ "bytes": bytes }),
    )
    .await;
    Ok(Json(json!({ "cancelled": true })))
}

fn backup_db_path(state: &AppState) -> AppResult<PathBuf> {
    state.db.file_path().map(Path::to_path_buf).ok_or_else(|| {
        AppError::coded(
            "backup.in_memory_unsupported",
            None,
            "当前数据库是内存库，不支持备份与恢复",
        )
    })
}

/// 备份校验失败的错误码：文案保持原样（便于排障），只按原因归类。
fn restore_validation_error(error: anyhow::Error) -> AppError {
    let message = format!("备份文件校验失败：{error:#}");
    if message.contains("文件头不是 SQLite format 3") {
        AppError::coded("backup.restore_bad_header", None, message)
    } else if message.contains("备份缺少必需的表") {
        AppError::coded("backup.restore_missing_tables", None, message)
    } else if message.contains("迁移版本") {
        let numbers: Vec<i64> = message
            .split(|c: char| !c.is_ascii_digit())
            .filter_map(|part| part.parse::<i64>().ok())
            .collect();
        // 前端要按 params 插值，缺了就只能回落中文原文
        AppError::coded(
            "backup.restore_migration_too_new",
            Some(json!({
                "version": numbers.first().copied().unwrap_or_default(),
                "supported": numbers.get(1).copied().unwrap_or_default(),
            })),
            message,
        )
    } else if message.contains("超过 512 MB") {
        AppError::coded(
            "backup.restore_too_large",
            Some(json!({ "max_mb": 512 })),
            message,
        )
    } else {
        AppError::coded("backup.restore_invalid", None, message)
    }
}

/// gzip 解压失败：超过上限与坏包分开，其余归入解压失败。
fn restore_gunzip_error(message: String) -> AppError {
    if message.contains("超过 512 MB") {
        AppError::coded(
            "backup.restore_too_large",
            Some(json!({ "max_mb": 512 })),
            message,
        )
    } else {
        AppError::coded("backup.restore_bad_gzip", None, message)
    }
}

fn parent_dir(db_path: &Path) -> &Path {
    db_path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn pending_info(db_path: &Path) -> Value {
    let pending = backup::pending_path(db_path);
    match std::fs::metadata(&pending) {
        Ok(meta) if meta.is_file() => json!({
            "uploaded_at": uploaded_at(&pending),
            "bytes": meta.len(),
        }),
        _ => Value::Null,
    }
}

fn uploaded_at(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

/// 按内容（gzip 魔数）而不是扩展名判断。
fn is_gzip(path: &Path) -> AppResult<bool> {
    let mut header = [0u8; 2];
    let mut file = std::fs::File::open(path)?;
    match file.read(&mut header) {
        Ok(read) => Ok(read == header.len() && header == backup::GZIP_MAGIC),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn gzip_file(path: &Path) -> AppResult<Vec<u8>> {
    let mut input = std::fs::File::open(path)?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    std::io::copy(&mut input, &mut encoder)?;
    Ok(encoder.finish()?)
}

/// gzip 解压到临时文件，返回解压后字节数；超过上限直接拒绝（防 zip bomb）。
fn gunzip_file(source: &Path, target: &Path) -> Result<u64, String> {
    let input =
        std::fs::File::open(source).map_err(|error| format!("打开上传文件失败：{error}"))?;
    let mut decoder = GzDecoder::new(input);
    let mut output =
        std::fs::File::create(target).map_err(|error| format!("创建临时文件失败：{error}"))?;
    let mut limited = (&mut decoder).take(MAX_BACKUP_BYTES + 1);
    let copied = std::io::copy(&mut limited, &mut output)
        .map_err(|error| format!("gzip 解压失败：{error}"))?;
    output
        .sync_all()
        .map_err(|error| format!("写入临时文件失败：{error}"))?;
    if copied > MAX_BACKUP_BYTES {
        return Err("解压后的数据库超过 512 MB 上限".into());
    }
    Ok(copied)
}

/// 流式落盘，边写边计数，避免把 512 MB 上传体整个读进内存。
async fn save_body(body: Body, target: &Path) -> AppResult<u64> {
    let mut file = tokio::fs::File::create(target).await?;
    let mut stream = body.into_data_stream();
    let mut total: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|_| AppError::coded("backup.restore_read_failed", None, "读取上传内容失败"))?;
        total = total.saturating_add(chunk.len() as u64);
        if total > MAX_BACKUP_BYTES {
            return Err(AppError::coded(
                "backup.restore_too_large",
                Some(json!({ "max_mb": 512 })),
                "备份文件超过 512 MB 上限",
            ));
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| AppError::Internal(error.into()))?;
    }
    file.flush()
        .await
        .map_err(|error| AppError::Internal(error.into()))?;
    file.sync_all()
        .await
        .map_err(|error| AppError::Internal(error.into()))?;
    Ok(total)
}

/// 临时文件守卫：无论成功、失败还是 panic 展开都尽量删掉半成品。
struct TempFile {
    path: PathBuf,
}

impl TempFile {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::body::Body;
    use axum::http::{HeaderMap, Method, Request, StatusCode};
    use axum::Router;
    use tower::ServiceExt;

    use pierwave_domain::repo;
    use pierwave_domain::repo::users::{self, NewUser};
    use pierwave_domain::Db;

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "pierwave-route-backup-{tag}-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn db_path(&self) -> PathBuf {
            self.path.join("pierwave.db")
        }

        fn file(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    async fn setup(tag: &str) -> (TestDir, Router, AppState, String) {
        let dir = TestDir::new(tag);
        let db = Db::connect(&format!("sqlite://{}?mode=rwc", dir.db_path().display()))
            .await
            .unwrap();
        db.migrate().await.unwrap();
        let admin = users::create(
            &db.pool,
            NewUser {
                username: "admin".into(),
                password: "devpass".into(),
                role: "admin".into(),
                quota_bytes: None,
                rule_template_id: None,
            },
        )
        .await
        .unwrap();
        let (token, _) = repo::sessions::create(&db.pool, &admin.id, 3600, None)
            .await
            .unwrap();
        let state = AppState::new(db, "web/dist");
        let app = crate::app::router(state.clone());
        (
            dir,
            app,
            state,
            format!("{}={token}", crate::auth::SESSION_COOKIE),
        )
    }

    async fn request(
        app: &Router,
        cookie: Option<&str>,
        method: Method,
        uri: &str,
        body: Vec<u8>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        let response = app
            .clone()
            .oneshot(builder.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), 32 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec();
        (status, headers, bytes)
    }

    fn json(bytes: &[u8]) -> Value {
        serde_json::from_slice(bytes).unwrap()
    }

    fn gunzip(bytes: &[u8]) -> Vec<u8> {
        let mut decoder = GzDecoder::new(bytes);
        let mut raw = Vec::new();
        decoder.read_to_end(&mut raw).unwrap();
        raw
    }

    /// 临时文件都以 `.pierwave-` 开头；正常路径结束后不应残留。
    fn leftover_temp_files(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".pierwave-"))
            .collect()
    }

    async fn export_bytes(app: &Router, cookie: &str) -> Vec<u8> {
        let (status, _, body) =
            request(app, Some(cookie), Method::GET, "/api/v1/backup", Vec::new()).await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        body
    }

    #[tokio::test]
    async fn export_returns_gzipped_sqlite_snapshot() {
        let (dir, app, _state, cookie) = setup("export").await;
        let (status, headers, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/backup",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            headers.get(header::CONTENT_TYPE).unwrap().to_str().unwrap(),
            "application/gzip"
        );
        let disposition = headers
            .get(header::CONTENT_DISPOSITION)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(
            disposition.starts_with("attachment; filename=\"pierwave-backup-"),
            "实际：{disposition}"
        );
        assert!(disposition.ends_with(".db.gz\""), "实际：{disposition}");

        let raw = gunzip(&body);
        assert!(raw.starts_with(backup::SQLITE_MAGIC));
        assert!(
            leftover_temp_files(&dir.path).is_empty(),
            "导出后临时快照应被删除：{:?}",
            leftover_temp_files(&dir.path)
        );
        let snapshot = dir.file("downloaded.db");
        std::fs::write(&snapshot, &raw).unwrap();
        let db = Db::connect(&format!("sqlite://{}?mode=rwc", snapshot.display()))
            .await
            .unwrap();
        assert!(repo::backup::table_exists(&db.pool, "users").await.unwrap());
        db.pool.close().await;
    }

    #[tokio::test]
    async fn rejects_bad_uploads_with_specific_reasons() {
        let (dir, app, _state, cookie) = setup("reject").await;

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            b"this is not a database".to_vec(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let message = json(&body)["error"].as_str().unwrap().to_string();
        assert!(message.contains("SQLite format 3"), "实际：{message}");
        assert_eq!(json(&body)["code"], "backup.restore_bad_header");

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let message = json(&body)["error"].as_str().unwrap().to_string();
        assert!(message.contains("为空"), "实际：{message}");

        // 合法 SQLite，但没有 users / _sqlx_migrations。
        let tableless_path = dir.file("tableless.db");
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&tableless_path)
            .create_if_missing(true);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE dummy (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            std::fs::read(&tableless_path).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let message = json(&body)["error"].as_str().unwrap().to_string();
        assert!(message.contains("users"), "实际：{message}");
        assert!(message.contains("_sqlx_migrations"), "实际：{message}");
        assert_eq!(json(&body)["code"], "backup.restore_missing_tables");

        assert!(
            !backup::pending_path(&dir.db_path()).exists(),
            "失败的上传不能留下待恢复文件"
        );
    }

    #[tokio::test]
    async fn rejects_backup_with_future_migration_version() {
        let (dir, app, _state, cookie) = setup("future").await;
        let future_path = dir.file("future.db");
        let db = Db::connect(&format!("sqlite://{}?mode=rwc", future_path.display()))
            .await
            .unwrap();
        db.migrate().await.unwrap();
        sqlx::query(
            "INSERT INTO _sqlx_migrations
                (version, description, success, checksum, execution_time)
             VALUES (?, 'from the future', 1, ?, 0)",
        )
        .bind(pierwave_domain::latest_migration_version() + 1)
        .bind(Vec::<u8>::new())
        .execute(&db.pool)
        .await
        .unwrap();
        // 走和真实备份相同的 VACUUM INTO 路径，避免 WAL 旁路文件干扰测试。
        let future_snapshot = dir.file("future-snapshot.db");
        backup::create_snapshot(&db.pool, &future_snapshot)
            .await
            .unwrap();
        db.pool.close().await;

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            std::fs::read(&future_snapshot).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let message = json(&body)["error"].as_str().unwrap().to_string();
        assert!(message.contains("迁移版本"), "实际：{message}");
        assert!(message.contains("高于当前程序支持"), "实际：{message}");
        assert_eq!(json(&body)["code"], "backup.restore_migration_too_new");
    }

    #[tokio::test]
    async fn gzip_upload_creates_pending_info_and_cancel() {
        let (dir, app, state, cookie) = setup("pending").await;
        let gz = export_bytes(&app, &cookie).await;

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            gz,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        assert_eq!(json(&body)["restart_required"], true);

        let pending = backup::pending_path(&dir.db_path());
        assert!(pending.exists(), "上传成功后应生成待恢复文件");
        assert!(std::fs::read(&pending)
            .unwrap()
            .starts_with(backup::SQLITE_MAGIC));
        assert!(
            leftover_temp_files(&dir.path).is_empty(),
            "上传落位后临时文件应被删除：{:?}",
            leftover_temp_files(&dir.path)
        );

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/backup/info",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let info = json(&body);
        assert!(info["db_bytes"].as_u64().unwrap() > 0);
        assert!(info["pending"].is_object(), "info：{info}");
        assert_eq!(
            info["pending"]["bytes"].as_u64().unwrap(),
            std::fs::metadata(&pending).unwrap().len()
        );
        assert!(info["pending"]["uploaded_at"].as_i64().unwrap() > 0);

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            "/api/v1/backup/restore",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        assert_eq!(json(&body)["cancelled"], true);
        assert!(!pending.exists(), "取消后待恢复文件应被删除");

        let (_, _, body) = request(
            &app,
            Some(&cookie),
            Method::GET,
            "/api/v1/backup/info",
            Vec::new(),
        )
        .await;
        assert!(json(&body)["pending"].is_null());

        let actions: Vec<String> = repo::audit::list(&state.db.pool, 50)
            .await
            .unwrap()
            .into_iter()
            .map(|entry| entry.action)
            .collect();
        for action in [
            "backup.export",
            "backup.restore.schedule",
            "backup.restore.cancel",
        ] {
            assert!(actions.contains(&action.to_string()), "缺少审计：{action}");
        }
    }

    #[tokio::test]
    async fn raw_database_upload_is_accepted() {
        let (dir, app, _state, cookie) = setup("raw").await;
        let raw = gunzip(&export_bytes(&app, &cookie).await);

        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::POST,
            "/api/v1/backup/restore",
            raw,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
        assert!(backup::pending_path(&dir.db_path()).exists());
    }

    #[tokio::test]
    async fn cancel_without_pending_is_rejected() {
        let (_dir, app, _state, cookie) = setup("no-pending").await;
        let (status, _, body) = request(
            &app,
            Some(&cookie),
            Method::DELETE,
            "/api/v1/backup/restore",
            Vec::new(),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(json(&body)["error"]
            .as_str()
            .unwrap()
            .contains("没有待恢复"));
    }
}
