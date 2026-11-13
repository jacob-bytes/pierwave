//! 迁移 0039 的核心承诺：只追加一个可空列，旧服务器全部归入「未分组」。
//!
//! 迁移器通常一次跑完；这里手工停在 0038，插入一台升级前的服务器，再单独执行
//! 0039，确认历史行不受影响且新列可读可写。

use pierwave_domain::{Db, MIGRATOR};

async fn apply_through(db: &Db, max_version: i64) {
    for migration in MIGRATOR
        .iter()
        .filter(|migration| migration.version <= max_version)
    {
        sqlx::raw_sql(&migration.sql)
            .execute(&db.pool)
            .await
            .unwrap_or_else(|error| panic!("执行迁移 {} 失败: {error}", migration.version));
    }
}

async fn server_columns(db: &Db) -> Vec<String> {
    sqlx::query_scalar("SELECT name FROM pragma_table_info('servers')")
        .fetch_all(&db.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn group_name_is_added_as_nullable_and_legacy_rows_stay_ungrouped() {
    let db = Db::connect("sqlite::memory:").await.unwrap();
    apply_through(&db, 38).await;

    // 停在 0038 的 schema 不允许 group_name 写入；旧数据只需最小列。
    sqlx::query(
        "INSERT INTO servers (id, name, address, token_hash, created_at)
         VALUES ('legacy-1', 'hk-1', '10.0.0.1', 'hash-1', 100)",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    assert!(
        !server_columns(&db)
            .await
            .contains(&"group_name".to_string()),
        "0039 之前不应有 group_name 列"
    );

    let migration = MIGRATOR
        .iter()
        .find(|migration| migration.version == 39)
        .expect("必须存在 0039 迁移");
    sqlx::raw_sql(&migration.sql)
        .execute(&db.pool)
        .await
        .unwrap();

    assert!(server_columns(&db)
        .await
        .contains(&"group_name".to_string()));

    let group: Option<String> =
        sqlx::query_scalar("SELECT group_name FROM servers WHERE id = 'legacy-1'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert!(group.is_none(), "历史服务器的 group_name 必须是 NULL");

    sqlx::query("UPDATE servers SET group_name = '香港' WHERE id = 'legacy-1'")
        .execute(&db.pool)
        .await
        .unwrap();
    let group: Option<String> =
        sqlx::query_scalar("SELECT group_name FROM servers WHERE id = 'legacy-1'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(group.as_deref(), Some("香港"));
}
