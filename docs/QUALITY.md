# 质量基线 / Quality Gates

五种「不发产品功能、只补质量护栏」的验证入口。脚本都在 `scripts/`，CI 改动在
`.github/workflows/ci.yml`。

| 入口 | 用途 |
|---|---|
| `scripts/flaky-baseline.sh` | 同一份代码连跑 N 次测试，暴露偶发失败 |
| `.github/workflows/ci.yml` | 前端与 Rust 测试拆成并行 job；flaky 基线只在手动触发时跑 |
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

本机实测（HEAD `7239f04`，默认 10 线程）10 次全部失败，且每次都是同一批 5 个用例，
说明这不是「偶发一次」而是可复现的并发问题（见「发现的问题」1）。

CI 里是一个**手动触发**的 job（不拖慢 push/PR）：

```
GitHub → Actions → CI → Run workflow → flaky_runs（默认 10）
```

失败时会把汇总表写进 job summary、把失败行打成 annotation，并上传日志 artifact。

## 2. CI 时长与并行拆分

拆分前（GitHub Actions run `43599754842`，commit `7239f04`，2026-11-14）：

| 步骤（`fmt + clippy + test + web build` job） | 耗时 |
|---|---|
| Cache cargo（恢复 target/.cargo-home） | 76s |
| Frontend deps（`npm install`） | 6s |
| Format | 2s |
| Clippy（`-D warnings`） | 42s |
| Tests（`cargo test --workspace`） | 116s |
| Installer self-test | 11s |
| Web tests | 3s |
| Web build | 3s |
| Post Cache cargo（保存缓存） | 31s |
| **该 job 墙钟** | **308s** |
| e2e job（本来就并行） | 137s |
| **workflow 墙钟** | **约 311s** |

拆分后：

| job | 内容 | 估计耗时 |
|---|---|---|
| `rust` | fmt + clippy + test + installer self-test | **约 294s** |
| `web` | npm install + web-test + web-build（无 cargo 缓存） | **约 16s** |
| `e2e` | 不变 | 137s |

工作流墙钟从「一个 308s 的 job」变成「`max(294, 16, 137)` ≈ **294s**」，约省 14s（-4.5%）。

收益为什么只有十几秒：前端在缓存命中时本来就只有 3s/3s，真正的大头是 Rust 测试 116s
和 cargo 缓存读写 76s+31s。拆分没有删任何测试——`rust` job 仍是 fmt/clippy/test/installer，
`web` job 是 web-test/web-build，`e2e` 保持原样。主要收益是**失败定位更早、两个技术栈
互不阻塞**（前端失败不用等 Rust 测试跑完，反之亦然），而不是这十几秒。

> 没有把 clippy 再拆一个 job：clippy 只有 42s，单独一个 job 还要再付一次 cargo 缓存
> 恢复（30–80s），净收益大概率是负的。

## 3. 依赖漏洞扫描

CI 的 `fmt + clippy + test + web build` job 在 Tests 之后跑 `scripts/audit.sh`：

- **Rust**：`cargo audit`。CI 先执行
  `cargo install cargo-audit --locked --root "$CARGO_HOME"`，二进制落在
  `.cargo-home/bin/`——这个目录本来就在 cargo 缓存里，命中缓存时直接复用、
  不再解析 index 或编译；
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

当前发现（2026-11-18，HEAD `dddd1df`）：

| 生态 | 结果 |
|---|---|
| Rust（`Cargo.lock`） | **2** 个漏洞（均为 moderate）+ 2 个 unmaintained 警告 |
| npm（`web/`） | **13** 个：critical 0 / high 11 / moderate 2 / low 0 |

Rust 两个漏洞：

| 严重度 | 包 | Advisory | 说明 | 修复 |
|---|---|---|---|---|
| moderate | `libsqlite3-sys` 0.30.1 | RUSTSEC-2026-0459（CVE-2026-119375，CVSS 6.8） | sqlx 的 `bundled` 特性带进来的 SQLite；WAL 页大小不一致时可能返回未初始化内存 | 等 sqlx 升级到 `libsqlite3-sys >= 0.39` |
| moderate | `rsa` 0.9.10 | RUSTSEC-2023-0071（Marvin Attack，CVSS 5.9） | 不在正常依赖树里（`cargo tree -i rsa` 为空），是锁文件里的残留/可选依赖；cargo audit 仍会报告 | 无兼容修复；可评估删除锁文件中的残留 |

另外 2 个 **unmaintained** 警告（不是漏洞，阻塞阈值不计）：`chrono` 0.4.45、
`unsafe-libyaml` 0.2.11。

npm Top 10（按严重度；11 个 high 基本是同一批构建工具链的传递依赖）：

| # | 严重度 | 包 | 摘要 | 修复 |
|---|---|---|---|---|
| 1 | high | `picomatch` | ReDoS（GHSA-fc5q-39xc-vjpf，CVSS 7.5） | 升级 `vite` / `shadcn` 主版本 |
| 2 | high | `vite` | 经由 `picomatch` / `tinyglobby` | `vite` 6.2.7+ |
| 3 | high | `@vitejs/plugin-react` | 经由 `vite` | 主版本升级 |
| 4 | high | `shadcn` | 经由 `@dotenvx/dotenvx` / `@shadcn/registry` | `shadcn` 2.10.0 |
| 5 | high | `@shadcn/registry` | 经由 `@dotenvx/dotenvx` | 随 `shadcn` 升级 |
| 6 | high | `@dotenvx/dotenvx` | 经由 `fdir` / `picomatch` | 随 `shadcn` 升级 |
| 7 | high | `fast-glob` | 经由 `micromatch` / `picomatch` | 随 `shadcn` 升级 |
| 8 | high | `micromatch` | 经由 `picomatch` | 随 `shadcn` 升级 |
| 9 | high | `fdir` / `tinyglobby` | 经由 `picomatch` | 随工具链升级 |
| 10 | moderate | `minimatch` | globparts 放大型 DoS（GHSA-g3hv-75wg-m249） | 升级到 11.0.1+ |

npm 这些基本都是 `shadcn` / `vite` 构建期依赖，不在生产运行时；修复需要跨主版本升级。
所以先按「观察一轮」接入，等前端工具链和 sqlx 升级时再收紧为阻塞。

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

1. **realm 能力探测在并发测试下失败（P1，crates/agent）**
   `cargo test --workspace`（默认 10 线程）稳定挂 4–5 个用例（个别轮次 6–7 个）：
   `realm::tests::*` 的 transport 三个用例 + `tests::heartbeat_reports_realm_transport_capability_from_binary`
   （个别轮次还带 `capability_probe_reads_the_transport_feature`、
   `exit_code_is_recorded_in_status`）。`--test-threads=1` 或单独跑这几个用例全绿；
   `--test-threads=2` 全绿，`4/8/10` 线程至少挂 2 个。失败时的状态是
   「无法判定 realm 是否支持跳间加密，已拒绝下发」——即 `detect_transport()`
   返回了 `None`。该函数 2s 超时、spawn 失败都折叠成 `None`（= 不支持），
   测试与生产都会把「探测失败」当成「不支持」。本 lane 不能改 `crates/`，仅报告。
   这正是 flaky 基线要抓的东西：同一份代码，换并行度就变结果。
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
| `.github/workflows/ci.yml` | Split web and Rust work into parallel jobs; flaky baseline is manual-only |
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
It runs on the CI `flaky` job, triggered manually via
`Actions → CI → Run workflow → flaky_runs` (default 10); that job never runs on push/PR.
On failure the summary is written to the job summary, failing lines become annotations, and
the logs are uploaded as an artifact.

## 2. CI duration and job split

Before (run `43599754842`, commit `7239f04`): a single `fmt + clippy + test + web build` job
took **308s** wall (cache restore 76s, clippy 42s, tests 116s, installer 11s, npm 6s,
web tests 3s, web build 3s, cache save 31s); the e2e job (137s) already ran in parallel,
so the workflow took ~311s.

After: `rust` (fmt/clippy/test/installer) ≈ **294s**, `web` (npm install + web-test +
web-build, no cargo cache) ≈ **16s**, `e2e` unchanged at 137s. Workflow wall clock becomes
`max(294, 16, 137)` ≈ **294s**, about 14s (-4.5%) shorter.

The saving is small because the web steps are already cheap (3s each with a warm npm cache)
while Rust tests and cargo cache I/O dominate. The real win is earlier, independent failure
signals: a broken frontend no longer waits for three minutes of Rust tests. No test was
removed — the `rust` job still runs fmt, clippy, the full test suite and the installer
self-test; the `web` job runs web-test and web-build; `e2e` is untouched. Clippy was not
split into its own job because it is only 42s and would need another 30–80s cache restore.

## 3. Dependency audit

The CI `fmt + clippy + test + web build` job runs `scripts/audit.sh` right after the Tests
step:

- **Rust**: `cargo audit`, installed by
  `cargo install cargo-audit --locked --root "$CARGO_HOME"`. The binary lands in
  `.cargo-home/bin`, which is already part of the cargo cache, so later runs skip the build;
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

Current findings (2026-11-18, HEAD `dddd1df`):

| Ecosystem | Result |
|---|---|
| Rust (`Cargo.lock`) | **2** vulnerabilities (both moderate) + 2 unmaintained warnings |
| npm (`web/`) | **13**: critical 0 / high 11 / moderate 2 / low 0 |

The two Rust advisories:

| Severity | Package | Advisory | Notes | Fix |
|---|---|---|---|---|
| moderate | `libsqlite3-sys` 0.30.1 | RUSTSEC-2026-0459 (CVE-2026-119375, CVSS 6.8) | SQLite pulled in by sqlx's `bundled` feature; a mismatched WAL page size can expose uninitialized memory | wait for sqlx to ship `libsqlite3-sys >= 0.39` |
| moderate | `rsa` 0.9.10 | RUSTSEC-2023-0071 (Marvin Attack, CVSS 5.9) | not in the normal dependency graph (`cargo tree -i rsa` is empty); a stale/optional entry in the lockfile, still reported by cargo audit | no compatible fix; consider dropping the stale lock entry |

Two further **unmaintained** warnings (not vulnerabilities, not blocking): `chrono` 0.4.45
and `unsafe-libyaml` 0.2.11.

The 11 npm highs are essentially one build-tooling chain (`picomatch` ReDoS via `vite`,
`shadcn`, `fast-glob`, `fdir`, `tinyglobby`, …), and the 2 moderates are `minimatch` /
`ts-morph`. All of them are dev/build-time dependencies, not production runtime; fixing them
requires major `vite` / `shadcn` upgrades, which is why the first round only observes.

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

1. **Realm capability probe is concurrency-sensitive (P1, crates/agent).**
   `cargo test --workspace` fails 4–5 tests (occasionally 6–7) with the default thread count
   (10), and at least 2 with `--test-threads=4/8`; it passes with 1 or 2 threads and when the
   tests run alone. All 10 baseline runs failed with the same five tests. The failing state is "cannot determine whether realm supports hop TLS, refusing to
   apply" — `detect_transport()` returned `None`, which is also what it returns on the 2s
   timeout or a spawn error. Both the tests and production treat "probe failed" as
   "unsupported". This lane may not touch `crates/`, so this is reported only.
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
