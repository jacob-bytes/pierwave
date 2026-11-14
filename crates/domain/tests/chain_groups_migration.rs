//! 迁移 0026 的核心承诺：旧 `chain_hops` 原样变成「每组一台成员」的 groups。
//!
//! 迁移器把全部迁移一次跑完，无法直接构造「升级前」的库；这里按版本手工执行
//! 0001..0025，写入旧 hops，再单独执行 0026，断言转换结果。

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
            .unwrap_or_else(|error| panic!("执行迁移 {} 失败: {error}", migration.version));
    }
}

#[tokio::test]
async fn legacy_hops_become_single_member_groups() {
    let db = Db::connect("sqlite::memory:").await.unwrap();
    apply_through(&db, 25).await;

    // 不能用 `repo::servers::create`：它按最新 schema 写 country_code / os_*，
    // 而这里刻意停在 0025。迁移测试只关心 servers.id，直接按 0025 的列插入。
    for (id, name, address) in [
        ("legacy-a", "hk-a", "10.0.0.1"),
        ("legacy-b", "jp-b", "10.0.0.2"),
    ] {
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
    let server_a = String::from("legacy-a");
    let server_b = String::from("legacy-b");

    sqlx::query(
        "INSERT INTO chains (id, name, target_host, target_port, enabled, created_at, updated_at)
         VALUES ('legacy-chain', '旧链', '1.1.1.1', 443, 1, 100, 100)",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    for (seq, server_id, listen_port) in [
        (0_i64, server_a.as_str(), 9001_i64),
        (1, server_b.as_str(), 9002),
    ] {
        sqlx::query(
            "INSERT INTO chain_hops (chain_id, seq, server_id, listen_port)
             VALUES ('legacy-chain', ?, ?, ?)",
        )
        .bind(seq)
        .bind(server_id)
        .bind(listen_port)
        .execute(&db.pool)
        .await
        .unwrap();
    }

    // 只执行 0026。
    let migration = MIGRATOR
        .iter()
        .find(|migration| migration.version == 26)
        .expect("必须存在 0026 迁移");
    sqlx::raw_sql(&migration.sql)
        .execute(&db.pool)
        .await
        .unwrap();

    // repo 按**最新** schema 查询（0028 之后 Chain 带 engine 列），
    // 所以断言 0026 的转换结果前，把后续只追加列的迁移补跑完。
    // 0026 本身的行为仍是在「升级前库」上单独验证的。
    for migration in MIGRATOR.iter().filter(|migration| migration.version > 26) {
        sqlx::raw_sql(&migration.sql)
            .execute(&db.pool)
            .await
            .unwrap_or_else(|error| panic!("执行迁移 {} 失败: {error}", migration.version));
    }

    let chain = repo::chains::find_by_id(&db.pool, "legacy-chain")
        .await
        .unwrap()
        .expect("旧链必须还在");
    assert_eq!(chain.groups.len(), 2, "每个旧 hop 变成一个组");
    assert_eq!(
        chain.chain.transport, "none",
        "0031 之后旧链默认明文，下发结果必须与升级前一致"
    );
    assert_eq!(
        chain.chain.tunnel_security, "tls",
        "0038 之后旧链默认 TLS 隧道模式，P16.1 行为不变"
    );
    assert!(
        chain
            .groups
            .iter()
            .all(|group| group.group.cert_id.is_none()),
        "旧数据不能凭空出现证书"
    );
    for (seq, (group, (expected_server, expected_port))) in chain
        .groups
        .iter()
        .zip([(&server_a, 9001_i64), (&server_b, 9002)])
        .enumerate()
    {
        assert_eq!(group.group.seq, seq as i64, "seq 必须原样保留");
        assert_eq!(group.group.id, format!("grp-legacy-chain-{seq}"));
        assert_eq!(group.group.strategy, "round_robin");
        assert!(group.group.name.is_none());
        assert_eq!(group.members.len(), 1, "旧 hop 是单台组");
        let member = &group.members[0];
        assert_eq!(&member.server_id, expected_server);
        assert_eq!(member.listen_port, expected_port);
        assert_eq!(member.priority, 0);
        assert_eq!(member.weight, 1);
    }

    // 0031 的追加列：transport / cert_id 能经仓储往返；realm_transport 默认 NULL。
    let tls_chain = repo::chains::create(
        &db.pool,
        repo::chains::NewChain {
            name: "新加密链".into(),
            target_host: "1.1.1.1".into(),
            target_port: 443,
            enabled: true,
            engine: "realm".into(),
            protocol: "tcp".into(),
            transport: "tls".into(),
            tunnel_security: "tls".into(),
            groups: vec![
                repo::chains::NewChainGroup {
                    name: None,
                    strategy: "round_robin".into(),
                    cert_id: None,
                    public_port: None,
                    members: vec![repo::chains::NewChainGroupMember {
                        server_id: server_a.clone(),
                        listen_port: 9101,
                        priority: 0,
                        weight: 1,
                    }],
                },
                repo::chains::NewChainGroup {
                    name: None,
                    strategy: "round_robin".into(),
                    cert_id: Some("cert-hop1".into()),
                    public_port: None,
                    members: vec![repo::chains::NewChainGroupMember {
                        server_id: server_b.clone(),
                        listen_port: 9102,
                        priority: 0,
                        weight: 1,
                    }],
                },
            ],
        },
    )
    .await
    .unwrap();
    assert_eq!(tls_chain.chain.transport, "tls");
    assert_eq!(tls_chain.chain.tunnel_security, "tls");
    assert_eq!(
        tls_chain.groups[1].group.cert_id.as_deref(),
        Some("cert-hop1")
    );

    let noise_chain = repo::chains::update(
        &db.pool,
        &tls_chain.chain.id,
        repo::chains::UpdateChain {
            tunnel_security: Some("noise".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        noise_chain.chain.tunnel_security, "noise",
        "tunnel_security 必须能经仓储往返"
    );

    let plain_again = repo::chains::update(
        &db.pool,
        &tls_chain.chain.id,
        repo::chains::UpdateChain {
            transport: Some("none".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(plain_again.chain.transport, "none");

    let capability: Option<bool> =
        sqlx::query_scalar("SELECT realm_transport FROM servers WHERE id = ?")
            .bind(&server_a)
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(capability, None, "旧 Agent 未上报时必须是 NULL（未知）");

    // chain_hops 保留（只追加迁移，不删历史表）。
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM chain_hops")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(kept, 2, "chain_hops 必须保留");

    // 端口冲突检查已经改读成员表。
    let conflict =
        repo::chains::find_member_port_conflict(&db.pool, &server_a, 9001, Some("another-chain"))
            .await
            .unwrap()
            .expect("迁移后的成员端口必须能被冲突检查看到");
    assert_eq!(conflict.chain_id, "legacy-chain");
    assert_eq!(conflict.seq, 0);
    assert_eq!(conflict.listen_port, 9001);
}
