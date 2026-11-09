# 发布流程

## 谁来决定发版

**版本号与是否发版由项目所有者决定。** 协作者（包括 AI）只负责把代码与测试做完，
不要自行 `git tag` 或触发 Release；需要发版时，先提交「建议版本号 + release 说明草稿」，
得到确认后再打 tag。

## 版本号

`vMAJOR.MINOR.PATCH`，当前处于 0.x，接口与配置格式仍可能变动。

## 发布说明格式（固定）

release 正文**直接取 annotated tag 的消息**，所以格式在打 tag 时就定下来：

```
feat: 一句话说清新增了什么
fix: 一句话说清修了什么
```

规则：

- 只写做了什么，不写实现细节、不做技术复盘；
- 一次发布可以有多行，按 `feat` 在前、`fix` 在后排列；
- **不写任何可能敏感的信息**（部署地址、服务器 IP、用户数据、内部排查过程、安全问题细节）。
  拿不准就先讨论，不要直接写进 tag。

## 发布签名密钥

发布产物用 Ed25519 签名（`SHA256SUMS.sig`），安装脚本与 Agent 用**编译期内置的公钥**验签。

| 项 | 位置 |
|---|---|
| 私钥（32 字节，base64） | 仓库 Secret `PIERWAVE_RELEASE_SIGNING_KEY` |
| 公钥（32 字节，base64） | `crates/domain/src/release.rs` 的 `DEV_PUBLIC_KEY_B64` 与 `scripts/install.sh` 的 `RELEASE_PUBKEY` |

两处公钥必须一致，私钥绝不能进仓库。没配 Secret 时发布会跳过签名（安装脚本会 WARN 并退回校验和）。

**轮换步骤**（怀疑私钥泄露时）：

```bash
openssl genpkey -algorithm ed25519 -out priv.pem
# 取私钥种子（PKCS8 DER 尾部 32 字节）与公钥（SPKI DER 尾部 32 字节），各自 base64
```

1. 更新 GitHub Secret；
2. 把新公钥同步替换代码里那两处常量；
3. 跑 `make check`，提交；
4. **发一个新版本**——旧版本内置的是旧公钥，验不了新签名。

注意：轮换后必须重新发布，否则已发布版本的安装脚本会拒绝新签名。

## 发布前必须做的真机验证（已进 CI）

打 tag 会触发 `.github/workflows/verify.yml`，它会用真实 Xray 跑一遍完整链路；
另外每周一自动跑一次，防止「代码没动但上游 Xray 变了」的情况被漏掉。

手动跑（推荐在发版前自己先跑一次）：

```bash
make verify-xray
```

下面这段是本地手跑的说明，保留作为排查参考。

## realm 引擎的验证（已进 CI）

`.github/workflows/verify-realm.yml` 在 Linux runner 上：下载 realm v2.9.6 官方二进制、
**按 `scripts/realm-checksums.txt` 校验哈希**、用我们生成的配置形状起一个 endpoint、
真实走一遍 TCP 转发。失败时贴出 realm 日志。

它守两件事：

1. 我们生成的 `realm.toml` 被真实二进制接受（字段名、`balance` 语法、endpoint 结构）；
2. 清单里的哈希没写错——写错了这步会红。

升级 realm 版本时同步改三处：`scripts/realm-checksums.txt`、`crates/agent/src/realm.rs` 的注释、
本文件里的版本号。

## 真机验证的判定标准

```bash
# 在一台能访问 GitHub 的 Linux 机器上（不需要 root）
curl -fsSL "https://raw.githubusercontent.com/jacob-bytes/pierwave/main/scripts/verify-xray-bootstrap.sh?$(date +%s)" | bash
```

必须看到 `PASS 真实 Xray 全链路验证通过`。这条检查能抓到单元测试与 e2e 都抓不到的问题——
历史上一共抓到过：

- `streamSettings` 写成 `stream`（Xray 静默忽略传输与 TLS 配置）
- 用户级统计挂在 `policy.system` 而不是 `policy.levels`（计费永远是 0）

## 打 tag 前

先把 `Cargo.toml` 的 `[workspace.package].version` 改成要发布的版本号——
它在 `/api/v1/health` 里返回，面板左下角和设置页都读它，不 bump 会出现
「发布 v0.1.1、面板显示 v0.1.0」。

```bash
sed -i '' 's/^version = "0\.1\.1"/version = "0.1.2"/' Cargo.toml   # macOS
cargo check --workspace   # 让 Cargo.lock 跟上
```

## 发布签名密钥

发布产物用 Ed25519 签名（`SHA256SUMS.sig`），安装脚本与 Agent 用**编译期内置的公钥**验签。

| 项 | 位置 |
|---|---|
| 私钥（32 字节，base64） | 仓库 Secret `PIERWAVE_RELEASE_SIGNING_KEY` |
| 公钥（32 字节，base64） | `crates/domain/src/release.rs` 的 `DEV_PUBLIC_KEY_B64` 与 `scripts/install.sh` 的 `RELEASE_PUBKEY` |

两处公钥必须一致，私钥绝不能进仓库。没配 Secret 时发布会跳过签名（安装脚本会 WARN 并退回校验和）。

**轮换步骤**（怀疑私钥泄露时）：

```bash
openssl genpkey -algorithm ed25519 -out priv.pem
# 取私钥种子（PKCS8 DER 尾部 32 字节）与公钥（SPKI DER 尾部 32 字节），各自 base64
```

1. 更新 GitHub Secret；
2. 把新公钥同步替换代码里那两处常量；
3. 跑 `make check`，提交；
4. **发一个新版本**——旧版本内置的是旧公钥，验不了新签名。

注意：轮换后必须重新发布，否则已发布版本的安装脚本会拒绝新签名。

## 发布前必须做的真机验证（已进 CI）

打 tag 会触发 `.github/workflows/verify.yml`，它会用真实 Xray 跑一遍完整链路；
另外每周一自动跑一次，防止「代码没动但上游 Xray 变了」的情况被漏掉。

手动跑（推荐在发版前自己先跑一次）：

```bash
make verify-xray
```

下面这段是本地手跑的说明，保留作为排查参考。

## realm 引擎的验证（已进 CI）

`.github/workflows/verify-realm.yml` 在 Linux runner 上：下载 realm v2.9.6 官方二进制、
**按 `scripts/realm-checksums.txt` 校验哈希**、用我们生成的配置形状起一个 endpoint、
真实走一遍 TCP 转发。失败时贴出 realm 日志。

它守两件事：

1. 我们生成的 `realm.toml` 被真实二进制接受（字段名、`balance` 语法、endpoint 结构）；
2. 清单里的哈希没写错——写错了这步会红。

升级 realm 版本时同步改三处：`scripts/realm-checksums.txt`、`crates/agent/src/realm.rs` 的注释、
本文件里的版本号。

## 真机验证的判定标准

```bash
# 在一台能访问 GitHub 的 Linux 机器上（不需要 root）
curl -fsSL "https://raw.githubusercontent.com/jacob-bytes/pierwave/main/scripts/verify-xray-bootstrap.sh?$(date +%s)" | bash
```

必须看到 `PASS 真实 Xray 全链路验证通过`。这条检查能抓到单元测试与 e2e 都抓不到的问题——
历史上一共抓到过：

- `streamSettings` 写成 `stream`（Xray 静默忽略传输与 TLS 配置）
- 用户级统计挂在 `policy.system` 而不是 `policy.levels`（计费永远是 0）

## 打 tag

```bash
git tag -a v0.2.0 -m "feat: 面板支持中英文切换与语言记忆
feat: 用户列表展示套餐额度合计与断流状态
fix: 修复 Linux 构建产物仅有 5KB 的问题"
git push origin v0.2.0
```

推送 tag 会触发 `.github/workflows/release.yml`：

1. 用 `cross` 构建 `x86_64-unknown-linux-musl` 与 `aarch64-unknown-linux-musl`；
2. 校验产物尺寸（小于 500KB 视为构建失败，直接让 workflow 红掉）；
3. 生成 `SHA256SUMS-<target>`；
4. 以 tag 消息作为 release 正文，上传全部产物。

> 只发 Linux（x86_64 / aarch64）。macOS 不再构建——主控和 agent 都只跑在服务器上。

## 校验

发布后确认 assets 尺寸合理（agent ≈ 2.5MB、master ≈ 8MB），并核对：

```bash
shasum -a 256 -c SHA256SUMS-x86_64-unknown-linux-musl
```
