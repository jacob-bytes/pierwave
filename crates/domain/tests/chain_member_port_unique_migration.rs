//! 迁移 0047：链成员端口唯一索引 + 历史重复行的清理口径。
//!
//! 写路径的「查冲突 + 插入」在并发下曾经不是原子的，库里可能已经存在同一
//! `(server_id, listen_port)` 的多行。唯一索引无法在保留全部行的前提下建立，
//! 迁移保留最早插入的一行、删除其余重复行；被删空的组由 `chain.group_empty`
//! 整链阻断并在 UI 显示原因，绝不静默改成直连目标。

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
async fn migration_cleans_duplicates_then_enforces_unique_member_ports() {
    let db = Db::connect("sqlite::memory:").await.unwrap();
    apply_through(&db, 46).await;

    for (id, name, address) in [("srv-a", "hk-a", "10.0.0.1"), ("srv-b", "jp-b", "10.0.0.2")] {
        sqlx::query(
            "INSERT INTO servers (id, name, address, token_hash, created_at)
             VALUES (?, ?, ?, ?, 100)",
        )
        .bind(id)
        .bind(name)
        .bind(address)
        .bind(format!("token-{id}"))
        .execute(&db.pool)
        .await
        .unwrap();
    }

    // 两条链、各两跳；两条链的入口/中间跳都非法地占用了同一端口。
    for (chain_id, name) in [("chain-1", "链一"), ("chain-2", "链二")] {
        sqlx::query(
            "INSERT INTO chains
                (id, name, target_host, target_port, enabled, created_at, updated_at)
             VALUES (?, ?, '1.1.1.1', 443, 1, 100, 100)",
        )
        .bind(chain_id)
        .bind(name)
        .execute(&db.pool)
        .await
        .unwrap();
        for seq in 0_i64..2 {
            sqlx::query(
                "INSERT INTO chain_groups (id, chain_id, seq, name, strategy)
                 VALUES (?, ?, ?, NULL, 'round_robin')",
            )
            .bind(format!("grp-{chain_id}-{seq}"))
            .bind(chain_id)
            .bind(seq)
            .execute(&db.pool)
            .await
            .unwrap();
        }
    }
    // 先插入的（chain-1 的成员）是保留行；后插入的是历史冲突行。
    for (group_id, server_id, port) in [
        ("grp-chain-1-0", "srv-a", 20000_i64),
        ("grp-chain-2-0", "srv-a", 20000),
        ("grp-chain-1-1", "srv-b", 20001),
        ("grp-chain-2-1", "srv-b", 20001),
    ] {
        sqlx::query(
            "INSERT INTO chain_group_members (group_id, server_id, listen_port, priority, weight)
             VALUES (?, ?, ?, 0, 1)",
        )
        .bind(group_id)
        .bind(server_id)
        .bind(port)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    let migration = MIGRATOR
        .iter()
        .find(|migration| migration.version == 47)
        .expect("必须存在 0047 迁移");
    sqlx::raw_sql(&migration.sql)
        .execute(&db.pool)
        .await
        .expect("有历史重复行时迁移也必须能成功执行");

    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT group_id, listen_port FROM chain_group_members ORDER BY listen_port, group_id",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("grp-chain-1-0".to_string(), 20000),
            ("grp-chain-1-1".to_string(), 20001),
        ],
        "保留最早插入的一行，删除历史冲突行"
    );

    // 被删空的组仍在：视图会通过 chain.group_empty 给出可读原因。
    let empty_groups: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM chain_groups g
          WHERE NOT EXISTS (SELECT 1 FROM chain_group_members m WHERE m.group_id = g.id)",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(empty_groups, 2, "空组必须保留，由 blocked 原因解释");

    // 清理之后唯一索引必须真正生效。
    let duplicate = sqlx::query(
        "INSERT INTO chain_group_members (group_id, server_id, listen_port, priority, weight)
         VALUES ('grp-chain-2-0', 'srv-a', 20000, 0, 1)",
    )
    .execute(&db.pool)
    .await;
    assert!(
        duplicate.is_err(),
        "同一 (server, port) 的第二个成员必须被拒绝"
    );

    let index: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master
          WHERE type = 'index'
            AND name = 'idx_chain_group_members_server_port'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(index, 1, "唯一索引必须落库");
}
