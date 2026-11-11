//! 迁移 0034：旧的 `udp` 布尔位一次性转成 `protocol`，之后读写路径只看 protocol。
//!
//! 迁移器把全部迁移一次跑完，无法直接构造「升级前」的库；这里手工执行
//! 0001..0033，写入旧数据，再单独执行 0034，断言迁移结果。

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
async fn udp_flags_migrate_to_protocol_and_tcp_defaults_are_preserved() {
    let db = Db::connect("sqlite::memory:").await.unwrap();
    apply_through(&db, 33).await;

    sqlx::query(
        "INSERT INTO servers (id, name, address, token_hash, created_at)
         VALUES ('srv-a', 'hk-a', '10.0.0.1', 'token-a', 100)",
    )
    .execute(&db.pool)
    .await
    .unwrap();

    // 升级前的数据：一条只开 TCP、一条同端口双开。
    for (id, port, udp) in [("fwd-tcp", 8443_i64, 0_i64), ("fwd-both", 9443, 1)] {
        sqlx::query(
            "INSERT INTO forwards
                (id, server_id, name, listen_port, target_host, target_port, enabled, engine, udp,
                 created_at, updated_at)
             VALUES (?, 'srv-a', ?, ?, '10.0.0.8', 443, 1, 'native', ?, 100, 100)",
        )
        .bind(id)
        .bind(id)
        .bind(port)
        .bind(udp)
        .execute(&db.pool)
        .await
        .unwrap();
    }
    for (id, udp) in [("chain-tcp", 0_i64), ("chain-both", 1)] {
        sqlx::query(
            "INSERT INTO chains
                (id, name, target_host, target_port, enabled, engine, udp, transport,
                 created_at, updated_at)
             VALUES (?, ?, '1.1.1.1', 443, 1, 'native', ?, 'none', 100, 100)",
        )
        .bind(id)
        .bind(id)
        .bind(udp)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    let migration = MIGRATOR
        .iter()
        .find(|migration| migration.version == 34)
        .expect("必须存在 0034 迁移");
    sqlx::raw_sql(&migration.sql)
        .execute(&db.pool)
        .await
        .unwrap();

    for (id, expected) in [
        ("fwd-tcp", "tcp"),
        ("fwd-both", "both"),
        ("chain-tcp", "tcp"),
        ("chain-both", "both"),
    ] {
        let (protocol, udp): (String, i64) = if id.starts_with("fwd-") {
            sqlx::query_as("SELECT protocol, udp FROM forwards WHERE id = ?")
                .bind(id)
                .fetch_one(&db.pool)
                .await
                .unwrap()
        } else {
            sqlx::query_as("SELECT protocol, udp FROM chains WHERE id = ?")
                .bind(id)
                .fetch_one(&db.pool)
                .await
                .unwrap()
        };
        assert_eq!(protocol, expected, "{id}");
        // 旧列原样保留，作为回滚/兼容用的历史镜像。
        assert_eq!(udp, if expected == "both" { 1 } else { 0 }, "{id}");
    }

    // 新写入不带 protocol 的历史路径由列默认值兜底为 tcp。
    sqlx::query(
        "INSERT INTO forwards
            (id, server_id, name, listen_port, target_host, target_port, enabled, engine,
             created_at, updated_at)
         VALUES ('fwd-default', 'srv-a', '默认', 10443, '10.0.0.9', 443, 1, 'native', 100, 100)",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    let (protocol,): (String,) =
        sqlx::query_as("SELECT protocol FROM forwards WHERE id = 'fwd-default'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(protocol, "tcp", "protocol 列必须默认 tcp");
}
