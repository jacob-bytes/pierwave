#!/usr/bin/env bash
# 重新生成 P16.1 tunnel 模块的测试证书。
#
# 产物（全部是本机回环测试专用，私钥无价值，禁止用于生产）：
#   tunnel-ca.pem          测试 CA（客户端信任根）
#   tunnel-ca-key.pem      测试 CA 私钥（只为能重签叶子证书）
#   tunnel-server.pem      服务端叶子证书，SAN=tunnel.test
#   tunnel-server-key.pem  服务端叶子私钥（PKCS#8）
#   tunnel-rogue-ca.pem    另一张无关 CA（验证「只信任给定 CA」）
#
# 有效期 10 年；过期后重跑本脚本即可。测试只读取前四个 + rogue CA，
# 不依赖 openssl 在测试运行时存在（证书以 PEM 提交进仓库）。
set -euo pipefail
cd "$(dirname "$0")"

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# 1) 测试 CA：CA:TRUE + keyCertSign，这是 webpki 认可信任根的最小条件。
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out tunnel-ca-key.pem 2>/dev/null
openssl req -x509 -new -key tunnel-ca-key.pem -sha256 -days 3650 \
  -out tunnel-ca.pem \
  -subj "/CN=pierwave tunnel test CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

# 2) 服务端叶子证书：CA:FALSE + serverAuth + SAN。rustls 不接受没有 SAN 的叶子证书。
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out tunnel-server-key.pem 2>/dev/null
openssl req -new -key tunnel-server-key.pem \
  -out "${work}/server.csr" -subj "/CN=tunnel.test"
cat > "${work}/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:tunnel.test,IP:127.0.0.1
EOF
openssl x509 -req -in "${work}/server.csr" \
  -CA tunnel-ca.pem -CAkey tunnel-ca-key.pem -CAcreateserial \
  -days 3650 -sha256 -out tunnel-server.pem \
  -extfile "${work}/server.ext"
rm -f tunnel-ca.srl

# 3) 无关 CA：客户端用它做信任根时，对 tunnel-server.pem 必须报 unknown_issuer。
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -out "${work}/rogue.key" 2>/dev/null
openssl req -x509 -new -key "${work}/rogue.key" -sha256 -days 3650 \
  -out tunnel-rogue-ca.pem \
  -subj "/CN=pierwave rogue test CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

echo "已重新生成 tunnel 测试证书 / regenerated tunnel test certificates:"
ls -1 tunnel-ca.pem tunnel-ca-key.pem tunnel-server.pem tunnel-server-key.pem tunnel-rogue-ca.pem
