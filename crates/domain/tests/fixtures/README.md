# 测试夹具说明

这里的 PEM 是**一次性自签测试证书**，用下面的命令生成，只用于单元测试：

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout test-key.pem -out test-cert.pem \
  -days 3650 -subj "/CN=example.com" \
  -addext "subjectAltName=DNS:example.com,DNS:www.example.com"
openssl genrsa -out test-other-key.pem 2048   # 故意不匹配的私钥
```

它们不对应任何真实域名或服务，泄漏也无价值；提交进仓库是为了让测试离线可复现。
如果将来接入 secret scanning，可以把这三份文件换成测试运行时用 `openssl` 动态生成。
