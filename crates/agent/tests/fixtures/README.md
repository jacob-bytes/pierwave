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
