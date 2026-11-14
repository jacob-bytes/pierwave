//! Golden：没有配置 `nic_name` 时，Xray 配置必须与引入网卡能力之前逐字节一致。
//!
//! 这个断言是「`nic_name` 为空不影响现有配置」的最后一道保险：任何新增字段、
//! 字段顺序或默认值变化都会让 golden 失配。

use pierwave_domain::models::{Node, Outbound, RoutingRule};
use pierwave_domain::xray::{self, ServerPlan};

fn node() -> Node {
    Node {
        id: "node-1".into(),
        server_id: "server-1".into(),
        tag: "hk-1".into(),
        name: "香港 01".into(),
        protocol: "vless".into(),
        transport: "tcp".into(),
        security: "reality".into(),
        port: 443,
        public_port: None,
        config_json: r#"{
            "settings": {
                "clients": [{"id": "11111111-1111-1111-1111-111111111111", "flow": "xtls-rprx-vision"}],
                "decryption": "none"
            },
            "streamSettings": {
                "network": "tcp",
                "security": "reality",
                "realitySettings": {
                    "serverNames": ["www.example.com"],
                    "privateKey": "private-key",
                    "shortIds": ["abcd1234"]
                }
            },
            "sniffing": {"enabled": true, "destOverride": ["http", "tls"]}
        }"#
        .into(),
        enabled: 1,
        created_at: 1,
        cert_id: None,
        bandwidth_kbps: None,
    }
}

fn outbound() -> Outbound {
    Outbound {
        id: "outbound-1".into(),
        server_id: "server-1".into(),
        tag: "relay".into(),
        protocol: "socks".into(),
        config_json: r#"{
            "settings": {"servers": [{"address": "10.0.0.8", "port": 1080}]},
            "streamSettings": {"network": "tcp", "sockopt": {"mark": 7}}
        }"#
        .into(),
        enabled: 1,
        created_at: 1,
    }
}

fn rule() -> RoutingRule {
    RoutingRule {
        id: "rule-1".into(),
        server_id: "server-1".into(),
        sort_order: 1,
        inbound_tag: Some("hk-1".into()),
        domain: Some("example.com".into()),
        ip: None,
        outbound_tag: "relay".into(),
        enabled: 1,
        created_at: 1,
    }
}

#[test]
fn no_nic_config_matches_golden() {
    let n = node();
    let o = outbound();
    let r = rule();
    let plan = ServerPlan {
        server_name: "hk-1",
        nodes: std::slice::from_ref(&n),
        grants: &[],
        certs: &[],
        outbounds: std::slice::from_ref(&o),
        rules: std::slice::from_ref(&r),
        // 显式写 None：这是「旧配置」路径。
        listen_address: None,
    };

    let config = xray::build_config(&plan);
    let actual = format!("{}\n", serde_json::to_string_pretty(&config).unwrap());
    let golden_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/testdata/xray_no_nic.golden.json"
    );
    // 维护 golden 用：PIERWAVE_UPDATE_XRAY_GOLDEN=1 时只覆盖文件，断言仍会执行下一次。
    if std::env::var_os("PIERWAVE_UPDATE_XRAY_GOLDEN").is_some() {
        std::fs::write(golden_path, &actual).unwrap();
    }
    let expected = include_str!("../testdata/xray_no_nic.golden.json");
    assert_eq!(
        actual, expected,
        "nic_name 为空时生成的 Xray 配置必须与 golden 逐字节一致；\
         如果这是有意变更，请先确认它不会影响未配置网卡的服务器"
    );
}
