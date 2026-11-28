# 发布流程

## 谁来决定发版 / Who decides

**版本号与是否发版由项目所有者决定。** 协作者（包括 AI）只负责把代码与测试做完，
不要自行 `git tag` 或触发 Release；需要发版时，先提交「建议版本号 + release 说明草稿」，
得到确认后再打 tag。

> **English.** Version numbers and release timing are decided by the project owner.
> Contributors (including AI) only land code and tests — never run `git tag` or trigger a
> Release on your own. Propose a version number plus a release-note draft first, and tag
> only after confirmation.

## 版本号 / Version numbers

`vMAJOR.MINOR.PATCH`，当前处于 0.x，接口与配置格式仍可能变动。

主控与 Agent **各自独立发版**：主控的 `v*` 打在 `pierwave` 仓库，Agent 的 `v*` 打在
`pierwave-agent` 仓库，两条版本线不要求同号。

> **English.** `vMAJOR.MINOR.PATCH`; the project is still 0.x, so the API and config format
> may change. The master and the agent release independently: master `v*` tags live in the
> `pierwave` repository, agent `v*` tags in `pierwave-agent`, and the two version lines do
> not have to match.

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

## 发布签名密钥 / Release signing key

发布产物用 Ed25519 签名（`SHA256SUMS-<target>.sig`），安装脚本与 Agent 用**编译期内置的公钥**验签。

**主仓与 Agent 仓共用同一把密钥**，GitHub Secret 同名 `PIERWAVE_RELEASE_SIGNING_KEY`——
两个仓库都要配置，且值必须相同。

密钥**已经轮换过**：旧私钥作废，现在只剩新私钥可用。**内置旧公钥的版本（主控 0.18.x
及更早）无法验证新版本的签名**，安装/升级会失败，只能重新安装新版本，升级脚本救不回来。

| 项 | 位置 |
|---|---|
| 私钥（32 字节，base64） | 两个仓库的 Secret `PIERWAVE_RELEASE_SIGNING_KEY`（同名同值） |
| 公钥（32 字节，base64） | `crates/common/src/release.rs` 的 `DEV_PUBLIC_KEY_B64` 与 `scripts/install.sh` 的 `RELEASE_PUBKEY` |

两处公钥必须一致，私钥绝不能进仓库。没配 Secret 时主仓发布会跳过签名（安装脚本会 WARN
并退回校验和），Agent 仓则会直接失败、拒绝发布无签名产物。

**轮换步骤**（怀疑私钥泄露时）：

```bash
openssl genpkey -algorithm ed25519 -out priv.pem
# 取私钥种子（PKCS8 DER 尾部 32 字节）与公钥（SPKI DER 尾部 32 字节），各自 base64
```

1. 同时更新两个仓库的 Secret `PIERWAVE_RELEASE_SIGNING_KEY`；
2. 把新公钥同步替换代码里那两处常量——Agent 通过 `common-v*` tag 拿公钥，所以要先发新的
   `common-v*` tag 并升 Agent 仓的依赖，否则 Agent 内置的还是旧公钥；
3. 跑 `make check`，提交；
4. **两个仓库都要发新版本**——旧版本内置的是旧公钥，验不了新签名；只发一边会出现一边装不上。

> **English.** Release artifacts are signed with Ed25519 (`SHA256SUMS-<target>.sig`); the
> installer and the agent verify it with a public key compiled into the binary. Both
> repositories use the **same** key: configure a Secret with the same name,
> `PIERWAVE_RELEASE_SIGNING_KEY`, in both, with the same value. The key has been rotated —
> the old private key is dead. Builds that embed the old public key (master 0.18.x and
> earlier) cannot verify signatures from new releases, so install/upgrade fails until they
> are reinstalled from a current release. Keep the two public-key copies identical:
> `DEV_PUBLIC_KEY_B64` in `crates/common/src/release.rs` and `RELEASE_PUBKEY` in
> `scripts/install.sh`; the private key never enters the repository.
> Without the Secret the master workflow skips signing (the installer warns and falls back
> to the checksum), while the agent workflow fails and refuses to publish unsigned artifacts.
> To rotate: update the Secret in both repositories, replace both constants, cut a new
> `common-v*` tag and bump the agent's pinned dependency so the agent picks up the new key,
> run `make check`, then release **both** repositories — only releasing one side leaves the
> other unable to install.

## 发布前必须做的真机验证（已进 CI）

主仓打 `v*` tag 会触发 `.github/workflows/verify.yml`，它会用真实 Xray 跑一遍完整链路；
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

## 打 tag 前 / Before tagging

两条轨道各自 bump 自己仓库的 `[workspace.package].version`，**不要**在发 Agent 时顺手改主控的
版本，反之亦然：

```bash
# 主控：在 pierwave 仓库根目录执行
VERSION=0.19.0                 # 占位，换成本次要发布的版本
sed -i '' "s/^version = \"[0-9]*\.[0-9]*\.[0-9]*\"/version = \"${VERSION}\"/" Cargo.toml   # macOS
cargo check --workspace        # 让 Cargo.lock 跟上
```

Agent 仓同理：在 `pierwave-agent` 仓库根目录把它自己的 `[workspace.package].version` 改成
Agent 的版本号，**不要**改主控的 `Cargo.toml`。

主控版本会出现在 `/api/v1/health` 里，面板左下角和设置页都读它；Agent 版本由心跳上报、
服务器列表显示。不 bump 就会看到「发布 v0.19.x、面板显示旧版本」的错位。

`proto-v0.1.0` / `common-v0.2.1` 这类共享 tag 是给 Agent 仓固定依赖用的源码 tag，不触发发布
workflow。改协议或公共工具时先发对应 tag、再升 Agent 仓的依赖，最后才发 Agent。

> **English.** Each track bumps its own `[workspace.package].version`; never bump the
> master version while releasing the agent, or vice versa. The master version is returned by
> `/api/v1/health` and shown in the sidebar and settings; the agent reports its version in
> heartbeats and it shows up in the server list. Shared tags such as `proto-v0.1.0` and
> `common-v0.2.1` pin source dependencies for the agent repository and do not trigger a
> release workflow: cut them first when the protocol or shared helpers change, bump the
> agent's pinned dependency, then release the agent.

## 打 tag / Tagging

两条轨道互不影响：**主仓 `v*` 只出主控，Agent 仓 `v*` 只出 Agent**。

### 主控（`pierwave` 仓库）

```bash
git tag -a v0.19.0 -m "feat: 面板支持中英文切换与语言记忆
fix: 修复 Linux 构建产物仅有 5KB 的问题"
git push origin v0.19.0
```

推送 tag 会触发主仓的 `.github/workflows/release.yml`：

1. 用 `cross` 构建 `x86_64-unknown-linux-musl` 与 `aarch64-unknown-linux-musl` 的 `pierwave-master`；
2. 校验产物尺寸（小于 500KB 视为构建失败，直接让 workflow 红掉）；
3. 生成校验清单 `SHA256SUMS-<target>` 并用私钥签名出 `SHA256SUMS-<target>.sig`；
4. 以 tag 消息作为 release 正文，上传全部主控产物。

### Agent（`pierwave-agent` 仓库）

```bash
# 独立仓库；主仓的 crates/agent 只是过渡期源码，用于 e2e 与验证，不随主控发布
cd ../pierwave-agent
git tag -a v0.19.0 -m "feat: 收敛器支持 xxx
fix: 修复 yyy"
git push origin v0.19.0
```

推送 tag 会触发 Agent 仓的 `.github/workflows/release.yml`，每个 target 产出一套：

- `pierwave-agent-x86_64-unknown-linux-musl`
- `pierwave-agent-aarch64-unknown-linux-musl`
- `SHA256SUMS-<target>`
- `SHA256SUMS-<target>.sig`

流程与主仓一致（尺寸校验、签名、用 tag 消息当正文），但**不产出主控**，只有上面这些 Agent 产物；
未配置 `PIERWAVE_RELEASE_SIGNING_KEY` 时直接失败，不允许发无签名产物。

> 只发 Linux（x86_64 / aarch64）。macOS 不再构建——主控和 agent 都只跑在服务器上。

> **English.** The two release tracks are independent: a `v*` tag in the master repository
> ships only the master, a `v*` tag in the agent repository ships only the agent. The master
> workflow builds `pierwave-master` for `x86_64-unknown-linux-musl` and
> `aarch64-unknown-linux-musl`, checks artifact size (under 500KB fails the build), writes and
> signs `SHA256SUMS-<target>`, and publishes with the annotated tag message as the release
> body. The agent workflow does the same from `pierwave-agent` and publishes
> `pierwave-agent-<target>`, `SHA256SUMS-<target>` and `SHA256SUMS-<target>.sig` per target —
> no master artifacts. It refuses to publish unsigned artifacts when
> `PIERWAVE_RELEASE_SIGNING_KEY` is missing. Linux only; macOS is no longer built.

## 校验 / Verify

发布后确认 assets 尺寸合理（Agent ≈ 7.5–8.8 MB、主控 ≈ 15–17.7 MB；低于 500KB 会被 workflow
判为构建失败），并核对：

```bash
shasum -a 256 -c SHA256SUMS-<target>
```

> **English.** After publishing, sanity-check the asset sizes (agent ≈ 7.5–8.8 MB, master
> ≈ 15–17.7 MB; anything under 500KB is a broken build) and verify the checksum manifest with
> `shasum -a 256 -c SHA256SUMS-<target>`. The `.sig` next to it is checked by the installer
> and the agent against the compiled-in public key.
