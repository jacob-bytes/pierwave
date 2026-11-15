//! 迁移 0050 的核心承诺：旧 `update_check_notify` 的历史值被一次性映射到
//! `alert_events` 的 `update_available` 事件，之后事件列表就是唯一事实来源。
//!
//! 迁移器会把全部迁移一次跑完，无法直接构造「升级前」的库；这里按版本手工执行
//! 0001..0049，写入旧设置，再单独执行 0050，断言落库结果。

use pierwave_domain::repo;
use pierwave_domain::{Db, MIGRATOR};

const LEGACY_DEFAULT: &str = "server_offline,user_exhausted,chain_degraded";

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

async fn apply_0050(db: &Db) {
    let migration = MIGRATOR
        .iter()
        .find(|migration| migration.version == 50)
        .expect("必须存在 0050 迁移");
    sqlx::raw_sql(&migration.sql)
        .execute(&db.pool)
        .await
        .unwrap();
}

/// 造一个停在 0049 的库，写入升级前的 `settings` 行，再执行 0050。
async fn migrate_legacy(rows: &[(&str, &str)]) -> Db {
    let db = Db::connect("sqlite::memory:").await.unwrap();
    apply_through(&db, 49).await;
    for (key, value) in rows {
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?)")
            .bind(key)
            .bind(value)
            .execute(&db.pool)
            .await
            .unwrap();
    }
    apply_0050(&db).await;
    db
}

async fn value(db: &Db, key: &str) -> Option<String> {
    repo::settings::get(&db.pool, key).await.unwrap()
}

#[tokio::test]
async fn enabled_legacy_switch_adds_the_update_event() {
    // 旧默认（通知开，但没显式写过这个键）：追加新事件。
    let db = migrate_legacy(&[("alert_events", LEGACY_DEFAULT)]).await;
    assert_eq!(
        value(&db, "alert_events").await.as_deref(),
        Some("server_offline,user_exhausted,chain_degraded,update_available")
    );

    // 显式开启同理。
    let db = migrate_legacy(&[
        ("alert_events", "server_offline"),
        ("update_check_notify", "1"),
    ])
    .await;
    assert_eq!(
        value(&db, "alert_events").await.as_deref(),
        Some("server_offline,update_available")
    );

    // 更早版本可能存的是 true / false 文本。
    let db = migrate_legacy(&[
        ("alert_events", "server_offline"),
        ("update_check_notify", "true"),
    ])
    .await;
    assert_eq!(
        value(&db, "alert_events").await.as_deref(),
        Some("server_offline,update_available")
    );
}

#[tokio::test]
async fn legacy_switch_off_keeps_the_update_event_unchecked() {
    let db = migrate_legacy(&[
        ("alert_events", LEGACY_DEFAULT),
        ("update_check_notify", "0"),
    ])
    .await;
    assert_eq!(
        value(&db, "alert_events").await.as_deref(),
        Some(LEGACY_DEFAULT),
        "旧开关显式关闭的用户升级后仍然收不到版本通知"
    );

    // `false` 文本同样算关闭。
    let db = migrate_legacy(&[
        ("alert_events", "server_offline,upgrade_failed"),
        ("update_check_notify", "false"),
    ])
    .await;
    assert_eq!(
        value(&db, "alert_events").await.as_deref(),
        Some("server_offline,upgrade_failed")
    );
}

#[tokio::test]
async fn missing_event_list_with_switch_off_materialises_the_legacy_default() {
    // 没保存过事件列表 + 关掉了版本通知：补一条不含新事件的旧默认，
    // 否则读取侧的新默认值（含 update_available）会把它重新打开。
    let db = migrate_legacy(&[("update_check_notify", "0")]).await;
    assert_eq!(
        value(&db, "alert_events").await.as_deref(),
        Some(LEGACY_DEFAULT)
    );

    // 没保存过事件列表 + 通知开（或没这个键）：不写库，读取侧默认已包含新事件。
    let db = migrate_legacy(&[("update_check_notify", "1")]).await;
    assert_eq!(value(&db, "alert_events").await, None);

    let db = migrate_legacy(&[]).await;
    assert_eq!(value(&db, "alert_events").await, None);
}

#[tokio::test]
async fn empty_event_list_keeps_only_the_events_it_really_sent() {
    // 空串 = 关掉了其它全部事件，但旧开关开着：版本通知本来就还会发，
    // 映射成唯一勾选的事件是行为等价的结果。
    let db = migrate_legacy(&[("alert_events", "")]).await;
    assert_eq!(
        value(&db, "alert_events").await.as_deref(),
        Some("update_available")
    );

    let db = migrate_legacy(&[("alert_events", ""), ("update_check_notify", "1")]).await;
    assert_eq!(
        value(&db, "alert_events").await.as_deref(),
        Some("update_available")
    );

    // 旧开关也是关闭的：保持「全部关闭」，升级后不能凭空冒出一条通知。
    let db = migrate_legacy(&[("alert_events", ""), ("update_check_notify", "0")]).await;
    assert_eq!(value(&db, "alert_events").await.as_deref(), Some(""));

    let db = migrate_legacy(&[("alert_events", ""), ("update_check_notify", "false")]).await;
    assert_eq!(value(&db, "alert_events").await.as_deref(), Some(""));
}

#[tokio::test]
async fn already_migrated_rows_are_not_touched_twice() {
    let db = migrate_legacy(&[("alert_events", "server_offline,update_available")]).await;
    assert_eq!(
        value(&db, "alert_events").await.as_deref(),
        Some("server_offline,update_available")
    );

    // 迁移本身也必须幂等：重复执行不会追加第二个 update_available。
    apply_0050(&db).await;
    assert_eq!(
        value(&db, "alert_events").await.as_deref(),
        Some("server_offline,update_available")
    );
}
