# 质量基线 / Quality Gates

五种「不发产品功能、只补质量护栏」的验证入口。脚本都在 `scripts/`，CI 改动在
`.github/workflows/ci.yml`。

| 入口 | 用途 |
|---|---|
| `scripts/flaky-baseline.sh` | 同一份代码连跑 N 次测试，暴露偶发失败 |
| `.github/workflows/ci.yml` | Rust / web / 依赖扫描拆成并行 job（flaky 基线不在 CI 里跑） |
| `scripts/audit.sh` | Rust `cargo audit` + 前端 `npm audit`，默认只观察 |
| `scripts/verify-backup.sh` | 真实 HTTP 导出/导入（加密 + 明文），断言关键数据一致 |
| `scripts/verify-upgrade.sh` | v0.15.0 建库 → HEAD 打开同一个库，断言迁移、数据与旧备份恢复 |

## 1. flaky 测试基线

```bash
./scripts/flaky-baseline.sh              # 默认连跑 10 次 cargo test --workspace
./scripts/flaky-baseline.sh 3            # 本地快速自检
FLAKY_RUNS=20 ./scripts/flaky-baseline.sh
FLAKY_TEST_ARGS="-p pierwave-domain" ./scripts/flaky-baseline.sh   # 只跑一个包
FLAKY_FAIL_FAST=1 ./scripts/flaky-baseline.sh                      # 第一次失败就停
KEEP_LOGS=1 ./scripts/flaky-baseline.sh                            # 全绿也保留日志
```

- 输出汇总表（每次 pass/fail 与耗时）；任一次失败即打印失败用例名并以非零退出；
- 失败日志按 `run-<n>.log` 保留在临时目录（全绿时删除）；
- 第一次失败后是否继续跑由 `FLAKY_FAIL_FAST` 控制，默认跑满 N 次，便于看「是不是每次都挂」。

本机实测（2026-11-19，HEAD `e0ed3f7`，`FLAKY_TEST_ARGS="-p pierwave-agent -- --test-threads=10"`）
连跑 20 次**全部通过**，总耗时约 194s。此前 HEAD `7239f04` 上的 10 次全部失败是
`realm::tests::*` 的探测竞态，本次基线已不再复现。

> 同一份代码用 32 线程加压（`--test-threads=32`，模拟少核 CI 的过订阅）会挂 3–4 个
> `forward::tests::*`（端口复用假设），这是另一条链的已知问题，不在本轮 UDP 修复范围；
> 隧道 UDP 用例自身的修复见下。

### 隧道 UDP 用例的 flaky 根因与修复

历史失败用例：`tunnel::supervisor::tests::two_udp_clients_get_separate_sessions_and_replies`、
`noise_udp_tunnel_echoes_three_datagrams_without_certificates`。

- **根因（时序，不是端口）**：断言用「发一次 + 固定等 5s」。UDP 没有重传，握手期间
  与首个会话建立前的数据报仍可能丢失（入口只缓存有限个），少核 CI 上握手本身也可能
  超过 5s。统计计数此前已经改成 10s 轮询，但**首个数据报的收发仍是固定 5s**，
  所以握手慢时必然超时。
- **修复**：`udp_roundtrip` 改成在 15s 预算内轮询重发，每次探针带唯一序号（迟到的
  旧回包不会被误认为本次成功）；两个客户端用例各自声明「别的客户端的载荷」，
  收到即断言串包。等待预算统一为 15s，没有 `#[ignore]`，也没有分钟级超时。
- **端口假设**：`free_port()` 现在要求 TCP 与 UDP **同时**空闲才返回（隧道会同时绑
  两个协议），降低并行用例之间的端口抢占窗口。
- **结果**：修复后同一条 `-p pierwave-agent -- --test-threads=10` 连跑 20 次全绿。

CI 里**没有** flaky job（避免拖慢 push/PR）；需要时按上面的命令本地跑，
`workflow_dispatch` 目前只暴露 `audit_blocking` 一个开关。

## 2. CI 时长与并行拆分

测法：用 GitHub Actions API 拉最近一次成功 CI run（run `44532732377`，commit
`7d0fd1c`，2026-11-19）的 job/step 时间戳，只统计 step 自身耗时。

拆分前（单个 `check` job，墙钟 654s）：

| 步骤（`fmt + clippy + test + web build` job） | 耗时 |
|---|---|
| Set up / checkout / rust toolchain / setup-node | 15s |
| Cache cargo（恢复 target/.cargo-home） | 85s |
| Cache npm | 3s |
| Frontend deps（`npm install`） | 10s |
| Format | 1s |
| Clippy（`-D warnings`） | 53s |
| Tests（`cargo test --workspace`） | 231s |
| Install cargo-audit | 175s |
| Dependency audit | 2s |
| Installer self-test | 11s |
| Web tests | 5s |
| Web build | 3s |
| Post Cache npm + Post Cache cargo（保存缓存） | 56s |
| **该 job 墙钟** | **654s** |
| e2e job（本来就并行） | 225s |
| **workflow 墙钟** | **654s** |

拆分后（四个 job，其中三个与 e2e 并行）：

| job | 内容 | 估计耗时 |
|---|---|---|
| `check`（名字保持不动） | checkout + fmt + clippy + test + installer self-test + cargo 缓存 | **约 455s** |
| `web` | npm install + web-test + web-build | **约 28s** |
| `audit` | cargo-audit + 依赖扫描（首次 192s；命中二进制缓存约 15s） | **约 15–192s** |
| `e2e` | 不变（新增三条覆盖后约 240s，见下） | 约 240s |

`check` job 从 654s 降到约 455s（**-30%**），workflow 墙钟同样约 654s → 455s。
没有删除或跳过任何检查项：`check` 少了的两段（web、audit）原样搬到并行 job，
`make check` 仍覆盖 fmt/clippy/test/web-build/web-test。

收益最大的一笔是 cargo-audit：它原来串在 Tests 之后每次重编 175s。主 cargo 缓存
的 key 是「`Cargo.lock` 哈希 + 只写一次」，某个 lock 早期保存的缓存里没有这个
二进制，之后每次 run 都会重装。现在 `audit` job 用固定 key 单独缓存
`.cargo-home/bin/cargo-audit`，安装前先 `--version` 验活；热缓存轮次这项从
175s 降到几秒，而且它已经不在 `check` 的关键路径上。

> 为什么 `check` job 不改名：分支保护按 job 名匹配 required check，改名会让 PR
> 一直等一个永远不会出现的检查。名字里的 `web build` 现在由 `web` job 承担，
> 这只是历史名称，不代表检查项缺失。
>
> 为什么不拆 clippy：只有 53s，单独 job 还要再付一次 cargo 缓存恢复（85s），
> 净收益为负。

**e2e 预期时长**：新增「WS 首帧超时（固定等 10s）」「加密备份导出 → 恢复 →
重启」两段后，CI 上约 225s → **约 240s**；本地（10 核、已编译）约
**45–60s**。e2e 仍与 `check` 并行，不进入关键路径。


## 3. 依赖漏洞扫描

CI 里是独立的 `audit` job（与 `check` / `web` / `e2e` 并行，见第 2 节）跑
`scripts/audit.sh`：

- **Rust**：`cargo audit`。CI 先执行
  `cargo install cargo-audit --locked --root "$CARGO_HOME"`，二进制落在
  `.cargo-home/bin/`；`audit` job 用固定 key 单独缓存这个二进制，安装前先
  `--version` 验活，命中时不再解析 index 或编译；
- **前端**：在 `web/` 下执行 `npm audit --audit-level=high`，缓存走仓库内的
  `NPM_CONFIG_CACHE`（`.npm-cache`）。

**默认不阻塞**：发现漏洞也以 0 退出，但会把摘要写进 job summary，并把每条发现
打成 annotation（非阻塞轮次用 warning）。需要阻塞时二选一：

- 手动触发 CI（Actions → CI → Run workflow）勾选 `audit_blocking`；
- 本地 `AUDIT_BLOCKING=1 ./scripts/audit.sh`。

阻塞阈值与工具语义一致：Rust 任意漏洞 + npm `critical` / `high`。

```bash
./scripts/audit.sh                       # Rust + 前端，非阻塞
RUST=0 ./scripts/audit.sh                # 只跑前端
NPM=0 ./scripts/audit.sh                 # 只跑 Rust
AUDIT_BLOCKING=1 ./scripts/audit.sh      # 达到阈值时退出码非零
AUDIT_SUMMARY=/tmp/audit.md ./scripts/audit.sh
RUSTSEC_DB=/path/to/advisory-db ./scripts/audit.sh   # GitHub 不可达时用本地 RustSec 库
```

> 为什么不用 `rustsec/audit-check`：它把「安装 + 运行 + 注解」打包成一个 action，
> 但我们要自己控制「默认不阻塞 / 阻塞开关 / job summary / 阈值」，用
> `cargo install` 后调脚本更直接，也不需要额外信任一个第三方 action。
> cargo-audit 安装失败时只记 scanner error：非阻塞轮次不红，阻塞模式再失败。

当前发现（2026-11-19，HEAD `e0ed3f7`；前端数据来自
`npm audit --audit-level=high --json` 实测）：

| 生态 | 结果 |
|---|---|
| Rust（`Cargo.lock`） | **2** 个漏洞（均为 moderate）+ 2 个 unmaintained 警告（本轮未重新拉 RustSec，沿用上一次实测） |
| npm（`web/`） | **4** 个：critical 0 / high 0 / moderate 4 / low 0 |

Rust 两个漏洞（未变化）：

| 严重度 | 包 | Advisory | 说明 | 修复 |
|---|---|---|---|---|
| moderate | `libsqlite3-sys` 0.30.1 | RUSTSEC-2026-0459（CVE-2026-119375，CVSS 6.8） | sqlx 的 `bundled` 特性带进来的 SQLite；WAL 页大小不一致时可能返回未初始化内存 | 等 sqlx 升级到 `libsqlite3-sys >= 0.39` |
| moderate | `rsa` 0.9.10 | RUSTSEC-2023-0071（Marvin Attack，CVSS 5.9） | 不在正常依赖树里（`cargo tree -i rsa` 为空），是锁文件里的残留/可选依赖；cargo audit 仍会报告 | 无兼容修复；可评估删除锁文件中的残留 |

另外 2 个 **unmaintained** 警告（不是漏洞，阻塞阈值不计）：`chrono` 0.4.45、
`unsafe-libyaml` 0.2.11。

npm 当前 4 个 moderate 是**同一条链**（`shadcn` CLI 的 AST 工具链）：

| 严重度 | 包 | 摘要 | 修复 |
|---|---|---|---|
| moderate | `minimatch` 10.2.6 | globparts 放大型 DoS（GHSA-g3hv-75wg-m249，影响 7.0.0–11.0.0） | 升级到 11.0.1+ |
| moderate | `@ts-morph/common` 0.27.0 | 经由 `minimatch`（影响 0.19.0–0.29.0） | 随 `ts-morph` 升级 |
| moderate | `ts-morph` 26.0.0 | 经由 `@ts-morph/common`（影响 18.0.0–27.0.2） | 随 `shadcn` 升级 |
| moderate | `shadcn` 4.23.0 | 经由 `ts-morph` / `@ts-morph/common` / `minimatch` | 只有 `npm audit fix --force` 会装 `shadcn@1.0.0`（降级，破坏性） |

### picomatch（上一轮的 11 个 high）根因与现状

- **根因**：`picomatch` ReDoS（GHSA-fc5q-39xc-vjpf）随 `vite` / `@vitejs/plugin-react` /
  `shadcn` / `fast-glob` / `fdir` / `tinyglobby` / `micromatch` 传递进锁文件；当时锁文件里
  的版本低于修复版，所以同一条链被展开成 11 条 high。
- **现状（2026-11-19）**：依赖树已经在之前的工具链升级里前滚，锁文件里只剩
  `picomatch@2.3.2`（`fast-glob → micromatch`）与 `picomatch@4.0.7`
  （`vite` / `tinyglobby` / `@dotenvx/dotenvx`），两者都在修复版之上；`npm audit`
  已不再报告 picomatch，**不需要跨主版本修复**。
- **影响面**：这些包只在构建/代码生成期使用（`shadcn` CLI 的 `ts-morph` 解析、
  `minimatch` glob 匹配；`shadcn/tailwind.css` 只在构建期被 Tailwind/Vite 处理），
  不进入 SPA 的运行时 JS 逻辑，也不出现在 `web/dist` 的 JS 产物里。
- **跟踪方式**：`scripts/audit.sh` 里的 `npm audit` 保持**非阻塞**，每次 CI 的
  `audit` job 写 job summary + annotation；达到 `critical` / `high` 才会在阻塞模式下变红。
- **升级触发条件**：等上游发布修复版——`ts-morph > 27.0.2`（或
  `@ts-morph/common > 0.29.0` 带 `minimatch >= 11.0.1`）进入 `shadcn` 的正式依赖；
  届时升 `web/package.json` 的 `shadcn`，再跑 `npm audit`、`npm test`、`npm run build`。
- **已尝试**：`npm audit fix`（非 force）实测输出 `up to date, audited 393 packages`，
  没有可用的兼容修复；`npm audit fix --force` 会把 `shadcn` 降到 `1.0.0`，
  属于破坏性降级。**结论：暂不修**（保持 0 high/0 critical，不与 `shadcn` 的
  主版本升级硬绑在同一轮改动里）。

> 本机实测受 GitHub 不可达影响：`cargo audit` 的 advisory DB 用
> `RUSTSEC_DB=/path/to/advisory-db` 指向本地快照，脚本会自动加 `--no-fetch`；
> CI 里不设这个变量，默认从 GitHub 拉取/更新。

## 4. 备份恢复实测

```bash
./scripts/verify-backup.sh          # 约 15s（加密 + 明文两条路径）
KEEP=1 ./scripts/verify-backup.sh   # 保留现场：三份 DB、导出文件、master 日志
```

流程全部走真实 HTTP（不复制 SQLite 文件）：

1. 起临时主控 A（临时 DB）→ 造 2 台服务器、4 个节点（reality / ws / tls+证书 /
   shadowsocks）、1 个套餐（alice 已绑且改过 quota_override）、规则模板、两跳链、
   单跳转发、改过设置；
2. `GET /api/v1/backup` 默认导出加密备份：断言 `Content-Type:
   application/octet-stream`、文件名 `.db.gz.enc`、文件头是 `PWSB`，且**不是**
   gzip 魔数、**不是**明文 SQLite；再翻转密文末字节上传，确认 400 +
   `backup.restore_decrypt_failed` 且不留下 pending；
3. 通过 `PATCH /api/v1/settings {"backup_encrypt": false}` 关掉加密，再导出明文
   `.db.gz`：断言 `Content-Type: application/gzip`、文件名 `.db.gz`、gzip 魔数，
   解压后是 SQLite 文件头；
4. 停掉 A，起临时主控 B 指向**全新的空库**，确认 servers=0、users=1；先用坏文件打
   `POST /api/v1/backup/restore`，确认 400 + `backup.restore_bad_header` 且不留下
   pending；再上传**加密**备份，确认 `restart_required=true`、pending 是 SQLite
   页大小的整数倍；重启 B（恢复契约：启动时替换 DB）→ 断言日志出现「已应用待恢复
   的数据库备份」；
5. 重新登录，按 9 类关键数据逐字段比对导出前/导入后的快照，并比较订阅 YAML 的
   SHA256；
6. 起临时主控 C（另一个全新空库），用同一套断言恢复**明文**备份 → 两条路径都覆盖。

> 脚本给所有临时主控注入同一个 `PIERWAVE_SECRET_KEY`（32 字节 base64）：加密备份
> 用导出端主密钥封装，恢复端密钥不一致会得到 `backup.restore_decrypt_failed`。
> 这也是生产环境「换机恢复要带原 `secret.key`」的自动化版本。

实测（HEAD `dddd1df`）：

```
加密导出是 PWSB 加密信封（非 gzip、非明文 SQLite）
加密导出：30558 B；明文导出：gz 30748 B → 565248 B SQLite
篡改的加密备份被拒绝且原因可读：backup.restore_decrypt_failed
加密备份导入成功：pending=565248 B
用户 3→3  服务器 2→2  节点 4→4  套餐 1→1  转发链 1→1
转发规则 1→1  规则模板 2→2  证书 1→1  设置项 6→6   全部 OK
订阅内容 SHA256 导出前 1c5f5c57… / 导入后 1c5f5c57…  OK
明文备份导入成功：pending=565248 B；同一组数据再次全部 OK
PASS 备份恢复实测通过（加密 + 明文两条路径）
```

> 规则模板是 2 而不是 1：迁移 `0010_rule_templates.sql` 会插入一条默认模板，
> 脚本自己又建了一条。
>
> 不要用 `/backup/info` 的 `db_bytes` 断言解压后大小：`VACUUM INTO` 会压缩空闲页，
> 与 `page_count × page_size` 可能差一页；pending 用的是实际解压大小。

## 5. 升级路径实测

```bash
./scripts/verify-upgrade.sh                      # v0.15.0（HEAD 前一个 release）→ HEAD
FROM_TAG=v0.9.0 ./scripts/verify-upgrade.sh      # 换起点，跨度更大
FROM_TAG=v0.14.0 TO_REV=v0.15.0 ./scripts/verify-upgrade.sh   # 只验证已发布版本之间
KEEP=1 ./scripts/verify-upgrade.sh               # 保留两份源码、库、日志
VERIFY_UPGRADE_TARGET_DIR=/tmp/x ./scripts/verify-upgrade.sh   # 复用编译缓存
```

流程：

1. `git archive` 分别导出起点（默认 `v0.15.0`，加密备份落地前的最后一个 release）
   与终点（默认 `HEAD`）的源码，两份共用一个 target 目录，依赖只编译一次；
2. 用起点 master 初始化临时库，通过 HTTP 建 2 台服务器、3 个节点、套餐+用户、
   规则模板、两跳转发链、单跳转发；导出旧版**明文** `.db.gz`，断言 gzip 魔数且
   解压后是 SQLite；
3. 停旧版，记录库里的 `_sqlx_migrations`（57 条，version 57）；
4. 用 HEAD 的 master 打开**同一个库**，计时到 `/api/v1/health` 可用；
5. 断言 HEAD 专有接口 `/api/v1/chain-templates` 返回 200；
6. 断言新版导出是 **PWSB 加密信封**（`application/octet-stream`、文件名
   `.db.gz.enc`、非 gzip / 非明文 SQLite）；
7. 比对 7 类关键数据与订阅里每个节点的 uuid/password；
8. 用新版恢复第 2 步的**旧版明文备份**：断言 200、pending 字节等于解压后大小、
   `/backup/info` 有 pending；重启后再比对一次，并确认迁移记录仍是 58 条；
9. 报告跨了哪些迁移、升级/旧备份恢复耗时。

实测（HEAD `dddd1df`，v0.15.0 → HEAD）：

```
跨迁移 1 个（57 → 58）：0058_secret_settings.sql
升级耗时（启动到健康，含迁移）：0.9s；旧版启动 1.4s
用户 3→3  服务器 2→2  节点 3→3  套餐 1→1  转发链 1→1  转发规则 1→1  OK
订阅节点凭据（name → uuid/password）：OK
备份格式：v0.15.0 导出明文 gzip（解压后 565248 B）→ HEAD 导出 PWSB 加密（27300 B）
跨版本备份恢复：旧版明文备份在新版本恢复成功（pending 565248 B，迁移后 58 条）
PASS 升级路径实测通过
```

## 发现的问题

1. **realm 能力探测在并发测试下失败（历史问题，当前 HEAD 不复现）**
   在 HEAD `7239f04` 上 `cargo test --workspace`（默认 10 线程）稳定挂 4–5 个用例：
   `realm::tests::*` 的 transport 三个用例 + `tests::heartbeat_reports_realm_transport_capability_from_binary`，
   根因是 `detect_transport()` 把 2s 超时 / spawn 失败折叠成 `None`（= 不支持）。
   2026-11-19 在 HEAD `e0ed3f7` 上用 `-p pierwave-agent -- --test-threads=10`
   连跑 20 次全绿，该竞态已不再复现（对应改动不在本 lane 范围内）。
2. **`/api/v1/backup/info` 的 `db_bytes` 在 WAL 模式下只算主库文件（P2，**已在 v0.11.3 修复**：改用 `page_count × page_size`）**
   实测 `db_bytes=4096`，而同一时刻导出的快照解压后是 `479232` 字节。前端设置页
   （`web/src/components/settings/BackupCard.tsx`）直接展示这个数字，用户会看到 4 KB。
   建议按 `main + -wal` 统计，或读 `PRAGMA page_count * page_size`。
   备份本身没有问题：`VACUUM INTO` 产出的快照包含 WAL 里已提交的数据（脚本已断言
   9 类数据与订阅逐字节一致）。
3. **恢复会整体替换 sessions / audit 表（行为说明，不是 bug）**
   恢复后旧登录态来自备份那一刻，需要重新登录；脚本因此在恢复后重新登录再断言。
   恢复旧版本备份时，启动阶段 `db.migrate()` 会把库前滚到当前版本（升级路径实测覆盖）。

---

# Quality Gates (English)

Five checks that add quality guardrails without changing product behavior. All scripts live
in `scripts/`; the CI change is `.github/workflows/ci.yml`.

| Entry point | Purpose |
|---|---|
| `scripts/flaky-baseline.sh` | Run the test suite N times on identical code to expose flakes |
| `.github/workflows/ci.yml` | Rust, web and dependency audit run as parallel jobs (the flaky baseline is local-only) |
| `scripts/audit.sh` | `cargo audit` + `npm audit`, non-blocking by default |
| `scripts/verify-backup.sh` | Export/import (encrypted + plaintext) through the real HTTP API and assert the data survives |
| `scripts/verify-upgrade.sh` | Build a DB with v0.15.0, open it with HEAD, assert migrations, data and legacy-backup restore |

## 1. Flaky baseline

```bash
./scripts/flaky-baseline.sh              # 10 × cargo test --workspace (default)
./scripts/flaky-baseline.sh 3            # quick local check
FLAKY_RUNS=20 ./scripts/flaky-baseline.sh
FLAKY_TEST_ARGS="-p pierwave-domain" ./scripts/flaky-baseline.sh
FLAKY_FAIL_FAST=1 ./scripts/flaky-baseline.sh
KEEP_LOGS=1 ./scripts/flaky-baseline.sh
```

It prints a summary table (pass/fail and duration per run), prints the failing test names of
any failing run, keeps that run's log as `run-<n>.log`, and exits non-zero if any run fails.

Measured locally on 2026-11-19 (HEAD `e0ed3f7`,
`FLAKY_TEST_ARGS="-p pierwave-agent -- --test-threads=10"`): 20/20 runs passed in ~194s.
The 10/10 failures seen earlier on HEAD `7239f04` were the `realm::tests::*` probe race and
no longer reproduce. Pushing the same binary to 32 threads (oversubscribing a small CI
runner) still fails 3–4 `forward::tests::*` cases due to port-reuse assumptions — a
different chain, out of scope here.

### Tunnel UDP flake: root cause and fix

Historical failures: `tunnel::supervisor::tests::two_udp_clients_get_separate_sessions_and_replies`
and `noise_udp_tunnel_echoes_three_datagrams_without_certificates`.

- **Root cause (timing, not ports)**: the assertions used "send once + wait a fixed 5s". UDP
  has no retransmission: datagrams sent during the QUIC handshake or before the first
  session is ready can still be lost (the ingress only buffers a limited number), and on a
  small CI runner the handshake itself can take longer than 5s. The stats counters had
  already moved to 10s polling, but the **first datagram** still used a fixed 5s wait, so a
  slow handshake always timed out.
- **Fix**: `udp_roundtrip` now polls and re-sends within a 15s budget, tagging every probe
  with a unique sequence number (a late reply from an earlier probe cannot be mistaken for
  success). Each two-client assertion declares the other client's payloads and fails on any
  cross-talk. The wait budget is 15s, with no `#[ignore]` and no minute-level timeout.
- **Port assumption**: `free_port()` now requires both TCP and UDP to be free before
  returning (the tunnel binds both protocols on one port), shrinking the race window
  between parallel tests.
- **Result**: after the fix, the same `-p pierwave-agent -- --test-threads=10` baseline passed
  20/20.

CI has **no** flaky job (it would slow every push/PR); run the command above locally when
needed. `workflow_dispatch` currently exposes only the `audit_blocking` input.

## 2. CI duration and job split

Measured from the GitHub Actions API for the last successful CI run (`44532732377`, commit
`7d0fd1c`, 2026-11-19), counting each step's own timestamps.

Before — one `check` job, **654s** wall:

| Step (`fmt + clippy + test + web build` job) | Duration |
|---|---|
| Set up / checkout / rust toolchain / setup-node | 15s |
| Cache cargo (restore target/.cargo-home) | 85s |
| Cache npm | 3s |
| Frontend deps (`npm install`) | 10s |
| Format | 1s |
| Clippy (`-D warnings`) | 53s |
| Tests (`cargo test --workspace`) | 231s |
| Install cargo-audit | 175s |
| Dependency audit | 2s |
| Installer self-test | 11s |
| Web tests | 5s |
| Web build | 3s |
| Post Cache npm + Post Cache cargo (save) | 56s |
| **Job wall clock** | **654s** |
| e2e job (already parallel) | 225s |
| **Workflow wall clock** | **654s** |

After — four jobs, three of them parallel with e2e:

| Job | Contents | Estimated duration |
|---|---|---|
| `check` (name unchanged) | checkout + fmt + clippy + test + installer self-test + cargo cache | **~455s** |
| `web` | npm install + web-test + web-build | **~28s** |
| `audit` | cargo-audit + dependency scan (192s cold, ~15s with the binary cache) | **~15–192s** |
| `e2e` | unchanged apart from the three new checks (~240s, see below) | ~240s |

The `check` job goes 654s → ~455s (**-30%**), and the workflow wall clock follows,
654s → ~455s. No check was removed or skipped: the two blocks the `check` job lost (web and
audit) run verbatim in parallel jobs, and `make check` still covers fmt/clippy/test/
web-build/web-test.

The biggest single win is cargo-audit: it used to run serially after Tests and recompile for
175s on every run. The main cargo cache key is "Cargo.lock hash + write once", and the cache
saved for a given lock was created before this binary existed, so it was rebuilt every time.
The `audit` job now caches just `.cargo-home/bin/cargo-audit` under a fixed key (validated
with `--version` before use); on a warm cache that step drops to seconds and is no longer on
the `check` critical path.

> Why the `check` job keeps its name: branch protection matches required checks by job name,
> so renaming it would leave PRs waiting for a check that never reports. Its old `web build`
> suffix is a historical label; the web job now performs that work.
>
> Why clippy stays: it is only 53s, and a separate job would pay another 85s cargo cache
> restore, a net loss.

**Expected e2e duration**: with the new first-frame timeout (a fixed 10s wait) and the
encrypted backup export/restore/restart, CI goes from ~225s to **~240s**; locally (10 cores,
already compiled) it is **45–60s**. e2e still runs in parallel with `check`, so it is not on
the critical path.

## 3. Dependency audit

CI runs `scripts/audit.sh` in its own `audit` job (parallel with `check` / `web` / `e2e`, see
section 2):

- **Rust**: `cargo audit`, installed by
  `cargo install cargo-audit --locked --root "$CARGO_HOME"`. The binary lands in
  `.cargo-home/bin` and the `audit` job caches just that binary under a fixed key, validating
  it with `--version` before reuse;
- **Frontend**: `npm audit --audit-level=high` inside `web/`, with `NPM_CONFIG_CACHE`
  pointing at the repo-local `.npm-cache`.

**Non-blocking by default**: findings still exit 0, but the summary is written to the job
summary and every finding becomes an annotation (warning in the observation round). To block:

- trigger the workflow manually (Actions → CI → Run workflow) and tick `audit_blocking`;
- or run `AUDIT_BLOCKING=1 ./scripts/audit.sh` locally.

Blocking threshold matches the tools: any Rust advisory plus npm `critical` / `high`.

```bash
./scripts/audit.sh                       # Rust + frontend, non-blocking
RUST=0 ./scripts/audit.sh                # frontend only
NPM=0 ./scripts/audit.sh                 # Rust only
AUDIT_BLOCKING=1 ./scripts/audit.sh      # non-zero exit at the threshold
AUDIT_SUMMARY=/tmp/audit.md ./scripts/audit.sh
RUSTSEC_DB=/path/to/advisory-db ./scripts/audit.sh   # local RustSec DB when GitHub is unreachable
```

> Why not `rustsec/audit-check`: the action bundles install + run + annotations, but we need
> our own non-blocking switch, job summary and threshold. Installing with cargo and calling
> our script gives that control without trusting an extra third-party action. A failed
> install is recorded as a scanner error: the observation round stays green, blocking mode
> fails.

Current findings (2026-11-19, HEAD `e0ed3f7`; the npm numbers are a fresh
`npm audit --audit-level=high --json` run):

| Ecosystem | Result |
|---|---|
| Rust (`Cargo.lock`) | **2** vulnerabilities (both moderate) + 2 unmaintained warnings (numbers carried over from the last RustSec run) |
| npm (`web/`) | **4**: critical 0 / high 0 / moderate 4 / low 0 |

The two Rust advisories (unchanged):

| Severity | Package | Advisory | Notes | Fix |
|---|---|---|---|---|
| moderate | `libsqlite3-sys` 0.30.1 | RUSTSEC-2026-0459 (CVE-2026-119375, CVSS 6.8) | SQLite pulled in by sqlx's `bundled` feature; a mismatched WAL page size can expose uninitialized memory | wait for sqlx to ship `libsqlite3-sys >= 0.39` |
| moderate | `rsa` 0.9.10 | RUSTSEC-2023-0071 (Marvin Attack, CVSS 5.9) | not in the normal dependency graph (`cargo tree -i rsa` is empty); a stale/optional entry in the lockfile, still reported by cargo audit | no compatible fix; consider dropping the stale lock entry |

Two further **unmaintained** warnings (not vulnerabilities, not blocking): `chrono` 0.4.45
and `unsafe-libyaml` 0.2.11.

The 4 npm moderates are one chain (the `shadcn` CLI AST tooling):

| Severity | Package | Summary | Fix |
|---|---|---|---|
| moderate | `minimatch` 10.2.6 | globparts amplification DoS (GHSA-g3hv-75wg-m249, affects 7.0.0–11.0.0) | upgrade to 11.0.1+ |
| moderate | `@ts-morph/common` 0.27.0 | via `minimatch` (affects 0.19.0–0.29.0) | follow `ts-morph` |
| moderate | `ts-morph` 26.0.0 | via `@ts-morph/common` (affects 18.0.0–27.0.2) | follow `shadcn` |
| moderate | `shadcn` 4.23.0 | via `ts-morph` / `@ts-morph/common` / `minimatch` | only `npm audit fix --force` would install `shadcn@1.0.0` (a breaking downgrade) |

### picomatch (the 11 highs from the previous round): root cause and current state

- **Root cause**: the `picomatch` ReDoS (GHSA-fc5q-39xc-vjpf) reached the lockfile
  transitively through `vite` / `@vitejs/plugin-react` / `shadcn` / `fast-glob` / `fdir` /
  `tinyglobby` / `micromatch`. The locked versions were below the patched release, so one
  chain expanded into 11 high findings.
- **Current state (2026-11-19)**: the dependency tree rolled forward during earlier toolchain
  upgrades. The lockfile now contains only `picomatch@2.3.2` (`fast-glob → micromatch`) and
  `picomatch@4.0.7` (`vite` / `tinyglobby` / `@dotenvx/dotenvx`), both above the patched
  release; `npm audit` no longer reports picomatch at all, so **no cross-major fix is needed**.
- **Blast radius**: build/code-generation only (`shadcn` CLI's `ts-morph` parsing and
  `minimatch` glob matching; `shadcn/tailwind.css` is only processed by Tailwind/Vite at
  build time). It is not part of the SPA's runtime JS and does not appear in the `web/dist`
  JS output.
- **Tracking**: the `npm audit` inside `scripts/audit.sh` stays **non-blocking**; every CI
  `audit` job writes the summary plus annotations, and only `critical` / `high` can fail the
  opt-in blocking mode.
- **Upgrade trigger**: when upstream ships the fix — `ts-morph > 27.0.2` (or
  `@ts-morph/common > 0.29.0` with `minimatch >= 11.0.1`) in `shadcn`'s stable dependency
  set. Then bump `shadcn` in `web/package.json` and run `npm audit`, `npm test`,
  `npm run build`.
- **Already tried**: `npm audit fix` (non-force) reports `up to date, audited 393 packages`
  — there is no compatible fix; `npm audit fix --force` downgrades `shadcn` to `1.0.0`,
  which is breaking. **Conclusion: not fixing now** (0 high / 0 critical; keep this separate
  from the `shadcn` major upgrade).

> In this sandbox GitHub is unreachable, so the local run pointed `RUSTSEC_DB` at a snapshot
> of the advisory database (which makes the script add `--no-fetch`). CI leaves it unset and
> fetches/updates from GitHub normally.

## 4. Backup / restore verification

`./scripts/verify-backup.sh` (about 15s; `KEEP=1` keeps the three databases, the exports and
the logs) seeds a temporary master through the API (2 servers, 4 nodes incl.
TLS+reality+shadowsocks, package bound to a user with a quota override, rule template, 2-hop
chain, forward, settings), then:

1. exports via `GET /api/v1/backup` (encrypted by default) and asserts
   `Content-Type: application/octet-stream`, a `.db.gz.enc` filename, a `PWSB` header, and
   that the body is neither gzip nor a plain SQLite file; uploads a copy with one flipped
   ciphertext byte and expects 400 `backup.restore_decrypt_failed` with no pending file;
2. sets `backup_encrypt=false` through the API, exports again and asserts
   `application/gzip`, a `.db.gz` filename, the gzip magic, and a SQLite header after
   gunzip;
3. starts a second master on a brand-new empty DB, rejects a garbage upload with
   `backup.restore_bad_header`, restores the **encrypted** backup, restarts to apply it (the
   documented `<db>.restore-pending` contract), re-logs in and deep-compares 9 categories
   (users, servers, nodes, packages, chains, forwards, rule templates, certificates,
   settings) plus the SHA256 of the rendered subscription;
4. repeats the same restore/compare cycle for the **plaintext** backup on another empty DB.

All masters share one `PIERWAVE_SECRET_KEY` (32-byte base64): the encrypted backup is sealed
with the exporting side's key, and a different key on the restoring side would fail with
`backup.restore_decrypt_failed`. This automates the production rule "carry the original
`secret.key` when restoring on another host".

Measured on HEAD `dddd1df`: encrypted export 30558 B, plaintext export 30748 B gzip → 565248 B
SQLite, tampered upload rejected, both restore rounds `OK` for all 9 categories with an
identical subscription SHA256, `PASS`.

> `/backup/info`'s `db_bytes` must not be used to assert the decompressed size: `VACUUM INTO`
> compacts free pages, so it can differ from `page_count × page_size` by one page; pending
> bytes use the actual decompressed size.

## 5. Upgrade path verification

`./scripts/verify-upgrade.sh` extracts `git archive v0.15.0` (the last release before
encrypted backups) and `git archive HEAD`, builds both masters into one shared target dir,
seeds the old DB over HTTP, exports a **legacy plaintext** `.db.gz` and asserts gzip + SQLite,
stops the old master, starts HEAD's master on the same DB, and asserts that migrations
advanced (57 → 58 rows), that the HEAD-only `/api/v1/chain-templates` endpoint answers 200,
that HEAD's export is now a `PWSB` envelope (octet-stream, `.db.gz.enc`, not gzip/SQLite),
and that all 7 data categories plus every node's subscription credential are unchanged. It
then restores the legacy backup through the new version, restarts, compares the data again
and checks that migrations are still complete. Measured: migration `0058_secret_settings.sql`,
startup-to-healthy 0.9s, legacy restore pending 565248 B, `PASS`.

## Findings

1. **Realm capability probe was concurrency-sensitive (historical; no longer reproduces on
   HEAD).** On HEAD `7239f04`, `cargo test --workspace` failed 4–5 tests (occasionally 6–7)
   with the default thread count (10) because `detect_transport()` folded the 2s timeout and
   spawn errors into `None` (= unsupported). On 2026-11-19, HEAD `e0ed3f7`, running
   `-p pierwave-agent -- --test-threads=10` 20 times passed every run, so the race no longer
   reproduces (the change that fixed it is outside this lane's scope).
2. **`/api/v1/backup/info` under-reports `db_bytes` in WAL mode (P2).**
   Observed `db_bytes=4096` while the exported snapshot was 479232 bytes after gunzip. The
   settings page (`web/src/components/settings/BackupCard.tsx`) shows this number. Suggest
   summing the main file with `-wal`, or using `PRAGMA page_count * page_size`. The backup
   itself is correct: `VACUUM INTO` includes committed WAL data (the script asserts all 9
   categories and the subscription match byte for byte).
3. **Restore replaces the sessions/audit tables wholesale (documented behavior, not a bug).**
   Sessions come back as of the backup moment, so clients must log in again; the script logs
   in again after the restore. Restoring an older backup also runs migrations forward at
   startup, which the upgrade-path check covers.
