//! 迁移 0051：给 `forwards` 增加 `last_sampled_at`（采样窗口起点）。
//!
//! 迁移器把全部迁移一次跑完，无法直接构造「升级前」的库；这里手工执行
//! 0001..0050，写入升级前的转发行，再单独执行 0051，断言：
//!
//! * 历史行的 `last_sampled_at` 默认 0（= 从未采样，按首次采样处理）；
//! * 升级前已有的累计计数器原样保留，不被迁移覆盖；
//! * 新列 NOT NULL，读取路径不需要处理 NULL。

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

#[tokio::test]
async fn existing_forwards_start_unsampled_and_keep_their_counters() {
    let db = Db::connect("sqlite::memory:").await.unwrap();
    apply_through(&db, 50).await;

    sqlx::query(
        "INSERT INTO servers (id, name, address, token_hash, created_at)
         VALUES ('srv-1', 'hk-1', '10.0.0.1', 'token-1', 100)",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO forwards
            (id, server_id, name, listen_port, target_host, target_port, enabled, engine,
             count_traffic, last_traffic_in, last_traffic_out, created_at, updated_at)
         VALUES ('fwd-old', 'srv-1', 'old', 8443, '10.0.0.8', 443, 1, 'native',
                 1, 5000, 2500, 100, 100)",
    )
    .execute(&db.pool)
    .await
    .unwrap();

    let migration = MIGRATOR
        .iter()
        .find(|migration| migration.version == 51)
        .expect("必须存在 0051 迁移");
    sqlx::raw_sql(&migration.sql)
        .execute(&db.pool)
        .await
        .unwrap();

    let (last_sampled_at, last_in, last_out, count_traffic): (i64, i64, i64, bool) =
        sqlx::query_as(
            "SELECT last_sampled_at, last_traffic_in, last_traffic_out, count_traffic
               FROM forwards WHERE id = 'fwd-old'",
        )
        .fetch_one(&db.pool)
        .await
        .unwrap();

    assert_eq!(
        last_sampled_at, 0,
        "历史行必须默认 0：升级后第一轮按首次采样处理，不回溯补记"
    );
    assert_eq!(
        (last_in, last_out),
        (5000, 2500),
        "迁移不能改动已有的累计计数器"
    );
    assert!(count_traffic);

    let not_null: i64 = sqlx::query_scalar(
        "SELECT \"notnull\" FROM pragma_table_info('forwards') WHERE name = 'last_sampled_at'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(not_null, 1, "last_sampled_at 必须是 NOT NULL");
}
