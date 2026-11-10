# 测试夹具说明

这里的 PEM 是**一次性自签测试证书**，用下面的命令生成，只用于单元测试：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout test-key.pem -out test-cert.pem \
  -days 3650 -subj "/CN=example.com" \
  -addext "subjectAltName=DNS:example.com,DNS:www.example.com"
openssl genrsa -out test-other-key.pem 2048   # 故意不匹配的私钥
```

`test-expired-cert.pem` / `test-expired-key.pem` 是**已过期**的自签证书
（2020-01-01 → 2021-01-01，SAN `expired.example.com`），用来覆盖「证书过期后
整链不下发」的路径；`openssl req -x509` 不能直接签发过去的时间，所以这组是用
Python `cryptography` 生成的：

```python
# cryptography: not_valid_before=2020-01-01, not_valid_after=2021-01-01
# SAN = DNS:expired.example.com, RSA-2048, PKCS#8 未加密私钥
```

它们不对应任何真实域名或服务，泄漏也无价值；提交进仓库是为了让测试离线可复现。
如果将来接入 secret scanning，可以把这些文件换成测试运行时动态生成。
