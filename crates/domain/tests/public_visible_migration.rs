//! 迁移 0064：`servers.public_visible` 默认 1，存量服务器不会被新迁移隐藏。
//!
//! 公开状态页的白名单是「默认公开、按需隐藏」：升级时已有行必须继续公开，
//! 否则一次升级会让所有公开页突然变空。这里停在第 62 版建行，再只应用 0064，
//! 验证默认值与显式写入。

use pierwave_domain::repo;
use pierwave_domain::{Db, MIGRATOR};

async fn apply_through(db: &Db, max_version: i64) {
    for migration in MIGRATOR
        .iter()
        .filter(|migration| migration.version <= max_version)
    {
        sqlx::raw_sql(&migration.sql)
            .execute(&db.pool)
            .await
            .unwrap_or_else(|error| panic!("执行迁移 {} 失败：{error}", migration.version));
    }
}

#[tokio::test]
async fn public_visible_defaults_to_one_for_existing_servers() {
    let db = Db::connect("sqlite::memory:").await.unwrap();
    apply_through(&db, 62).await;

    // 升级前的行：没有 public_visible 列，只写基础列。
    sqlx::query(
        "INSERT INTO servers (id, name, address, token_hash, xray_mode, status, config_version, created_at)
         VALUES ('legacy-1', 'legacy', '203.0.113.9', 'hash', 'external', 'online', 0, 1)",
    )
    .execute(&db.pool)
    .await
    .unwrap();

    let migration = MIGRATOR
        .iter()
        .find(|migration| migration.version == 64)
        .expect("必须存在 0064 公开可见性迁移");
    sqlx::raw_sql(&migration.sql)
        .execute(&db.pool)
        .await
        .unwrap();

    // `Server` 还包含 0067 的两个计费周期列；本测试只关心可见性，先把列补上。
    let cycle = MIGRATOR
        .iter()
        .find(|migration| migration.version == 67)
        .expect("必须存在 0067 计费周期数量 + 单位迁移");
    sqlx::raw_sql(&cycle.sql).execute(&db.pool).await.unwrap();

    let server = repo::servers::find_by_id(&db.pool, "legacy-1")
        .await
        .unwrap();
    assert!(
        server.public_visible,
        "存量服务器升级后必须保持公开（默认 1）"
    );

    // 显式隐藏后读回 false；再放回 true。
    repo::servers::set_public_visible(&db.pool, "legacy-1", false)
        .await
        .unwrap();
    assert!(
        !repo::servers::find_by_id(&db.pool, "legacy-1")
            .await
            .unwrap()
            .public_visible
    );

    // 白名单整体替换：空数组 = 全部隐藏；再只放开 legacy-1。
    let hidden = repo::servers::replace_public_visible(&db.pool, &[])
        .await
        .unwrap();
    assert_eq!(hidden, (0, 1));
    let shown = repo::servers::replace_public_visible(&db.pool, &["legacy-1".to_string()])
        .await
        .unwrap();
    assert_eq!(shown, (1, 0));
}
