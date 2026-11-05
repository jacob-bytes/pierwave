# 证书管理（第一步：上传 + 部署，暂不做 ACME）

TLS 节点没有证书就是空壳。这轮先打通「证书进系统 → 推到服务器 → 被 Xray 引用」，
把网络依赖最重的 ACME 留到下一步——否则一个 DNS/端口问题就会把整条链路卡住。

## 1. 数据模型

```sql
CREATE TABLE certificates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domains TEXT NOT NULL,      -- JSON 数组
  cert_pem TEXT NOT NULL,
  key_pem TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  not_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

上传时用 `x509-parser` 解析 PEM：拿 SAN 里的域名、有效期；解析失败返回 400 中文错误。
**私钥永不出现在任何 GET 响应里**（列表只回 `has_key`）。

## 2. 节点引用

`nodes` 增加 `cert_id TEXT NULL`（迁移 0006）。约束：

- `security = tls` 的节点必须绑定证书，否则 apply 时该节点进 warnings 并跳过；
- `security = reality` 不需要证书；
- 证书不存在 → 400。

## 3. 下发

`desired::render` 时，把被引用证书写成 `ManagedFile`：

```
/usr/local/etc/xray/certs/{cert_id}.pem    (0644)
/usr/local/etc/xray/certs/{cert_id}.key    (0600)
```

同时把节点的 `stream.tlsSettings.certificates` 设成这两个路径（若片段里已显式给了路径，以片段为准，不强改）。

Agent 侧的 `apply_files` 已经是「写临时文件 → rename」，不需要改协议。

## 4. 过期

列表接口返回 `days_left`。`<= 30` 天在概览告警里计数（`alerts.expiring_certs`），不做自动续期（ACME 那轮再做）。

## 5. 本轮不做

- ACME 签发（HTTP-01 / DNS-01）——下一轮；
- 证书推送到 nginx；
- 证书吊销 / CRL。
