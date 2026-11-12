# Agent 测试夹具

`self-signed-leaf.pem` / `self-signed-leaf-key.pem` 是**一次性自签叶子证书**，
只用于 TLS 探针的本地握手测试（证明自签证书会被判成 `unknown_issuer`）：

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout self-signed-leaf-key.pem -out self-signed-leaf.pem \
  -days 3650 -subj "/CN=example.com" \
  -addext "subjectAltName=DNS:example.com,DNS:www.example.com" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"
```

关键点是 `basicConstraints=critical,CA:FALSE`：`openssl req -x509` 默认会带
`CA:TRUE`，那种证书会被 webpki 当成「CA 被当作叶子证书」而报
`CaUsedAsEndEntity`，拿不到真实自签场景下的 `unknown_issuer`。

私钥未加密、属于测试专用，泄漏无价值；不要换成生产证书。

## P16.1 tunnel 测试证书

`tunnel-*.pem` 是 tunnel 模块回环测试用的**自有 CA 链**，由
[`gen-tunnel-certs.sh`](gen-tunnel-certs.sh) 一次性生成（有效期 10 年）：

| 文件 | 用途 |
|---|---|
| `tunnel-ca.pem` | 客户端信任的测试 CA |
| `tunnel-ca-key.pem` | 测试 CA 私钥（只为重签叶子证书） |
| `tunnel-server.pem` | 服务端叶子证书，SAN `tunnel.test` + `127.0.0.1` |
| `tunnel-server-key.pem` | 服务端私钥（PKCS#8） |
| `tunnel-rogue-ca.pem` | 无关 CA，验证客户端**只**信任给定 CA |

测试以 `include_str!` 读入 PEM 并写入临时目录，再走真实的
`cert_path` / `key_path` / CA 文件加载路径；运行测试不依赖 openssl。
过期或需要换密钥时重跑脚本即可。
