# 质量基线 / Quality Gates

四种「不发产品功能、只补质量护栏」的验证入口。脚本都在 `scripts/`，CI 改动在
`.github/workflows/ci.yml`。

| 入口 | 用途 |
|---|---|
| `scripts/flaky-baseline.sh` | 同一份代码连跑 N 次测试，暴露偶发失败 |
| `.github/workflows/ci.yml` | 前端与 Rust 测试拆成并行 job；flaky 基线只在手动触发时跑 |
| `scripts/verify-backup.sh` | 真实 HTTP 导出/导入，断言关键数据一致 |
| `scripts/verify-upgrade.sh` | v0.9.0 建库 → HEAD 打开同一个库，断言迁移与数据 |

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

## 3. 备份恢复实测

```bash
./scripts/verify-backup.sh          # 约 10s
KEEP=1 ./scripts/verify-backup.sh   # 保留现场：两份 DB、导出文件、master 日志
```

流程全部走真实 HTTP（不复制 SQLite 文件）：

1. 起临时主控 A（临时 DB）→ 造 2 台服务器、4 个节点（reality / ws / tls+证书 /
   shadowsocks）、1 个套餐（alice 已绑且改过 quota_override）、规则模板、两跳链、
   单跳转发、改过设置；
2. `GET /api/v1/backup` 导出 `.db.gz`，校验 `Content-Type` / 文件名 / SQLite 文件头；
3. 停掉 A，起临时主控 B 指向**全新的空库**，确认 servers=0、users=1；
4. 先用坏文件打 `POST /api/v1/backup/restore`，确认 400 + `backup.restore_bad_header`
   且不留下 pending；
5. 再上传真备份，确认 `restart_required=true`、`/backup/info` 的 pending 字节数
   与解压后大小一致；
6. 重启 B（恢复契约：启动时替换 DB）→ 断言启动日志里出现「已应用待恢复的数据库备份」；
7. 重新登录，按 9 类关键数据逐字段比对导出前/导入后的快照，并比较订阅 YAML 的 SHA256。

实测（HEAD `7239f04`）：

```
用户 3→3  服务器 2→2  节点 4→4  套餐 1→1  转发链 1→1
转发规则 1→1  规则模板 2→2  证书 1→1  设置项 6→6   全部 OK
订阅内容 SHA256 导出前 0a2e0dc9… / 导入后 0a2e0dc9…  OK
PASS 备份恢复实测通过
```

> 规则模板是 2 而不是 1：迁移 `0010_rule_templates.sql` 会插入一条默认模板，
> 脚本自己又建了一条。

## 4. 升级路径实测

```bash
./scripts/verify-upgrade.sh                      # v0.9.0 → HEAD
FROM_TAG=v0.9.2 ./scripts/verify-upgrade.sh      # 换起点
KEEP=1 ./scripts/verify-upgrade.sh               # 保留两份源码、库、日志
VERIFY_UPGRADE_TARGET_DIR=/tmp/x ./scripts/verify-upgrade.sh   # 复用编译缓存
```

流程：

1. `git archive v0.9.0` 与 `git archive HEAD` 各导出一份源码（两份共用一个 target 目录，
   依赖只编译一次）；
2. 用 v0.9.0 的 master 初始化临时库，通过 HTTP 建 2 台服务器、3 个节点、套餐+用户、
   规则模板、两跳转发链、单跳转发；
3. 停旧版，记录库里的 `_sqlx_migrations`（39 条，version 39）；
4. 用 HEAD 的 master 打开**同一个库**，计时到 `/api/v1/health` 可用；
5. 断言：迁移记录 39 → 47、HEAD 专有接口 `/api/v1/chain-templates` 返回 200、
   7 类关键数据逐字段一致、订阅里每个节点的 uuid/password 不变；
6. 报告跨了哪些迁移、升级耗时。

实测（HEAD `7239f04`，v0.9.0 → 0.11.0）：

```
跨迁移 8 个（39 → 47）：0040 public_port、0041 port_policy、0042 network_interface、
0043 server_protocol_version、0044 user_forwards、0045 forward_traffic、
0046 chain_templates、0047 chain_member_port_unique
升级耗时（启动到健康，含迁移）：1.1s
用户 3→3  服务器 2→2  节点 3→3  套餐 1→1  转发链 1→1  转发规则 1→1  OK
订阅节点凭据（name → uuid/password）：OK
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
2. **`/api/v1/backup/info` 的 `db_bytes` 在 WAL 模式下只算主库文件（P2）**
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

Four checks that add quality guardrails without changing product behavior. All scripts live
in `scripts/`; the CI change is `.github/workflows/ci.yml`.

| Entry point | Purpose |
|---|---|
| `scripts/flaky-baseline.sh` | Run the test suite N times on identical code to expose flakes |
| `.github/workflows/ci.yml` | Split web and Rust work into parallel jobs; flaky baseline is manual-only |
| `scripts/verify-backup.sh` | Export/import through the real HTTP API and assert the data survives |
| `scripts/verify-upgrade.sh` | Build a DB with v0.9.0, open it with HEAD, assert migrations and data |

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

## 3. Backup / restore verification

`./scripts/verify-backup.sh` (about 10s; `KEEP=1` keeps both databases, the export and logs)
seeds a temporary master through the API (2 servers, 4 nodes incl. TLS+reality+shadowsocks,
package bound to a user with a quota override, rule template, 2-hop chain, forward, settings),
exports via `GET /api/v1/backup`, starts a second master on a brand-new empty DB, rejects a
garbage upload with `backup.restore_bad_header` (no pending file left), uploads the real
backup via `POST /api/v1/backup/restore`, restarts to apply it (the documented
`<db>.restore-pending` contract), then re-logs in and deep-compares 9 categories
(users, servers, nodes, packages, chains, forwards, rule templates, certificates, settings)
plus the SHA256 of the rendered subscription. Measured on HEAD `7239f04`: every category
`OK`, subscription SHA256 identical, `PASS`.

## 4. Upgrade path verification

`./scripts/verify-upgrade.sh` extracts `git archive v0.9.0` and `git archive HEAD`, builds
both masters into one shared target dir, seeds the old DB over HTTP, stops the old master,
starts HEAD's master on the same DB, and asserts that migrations advanced
(39 → 47 rows), that the HEAD-only `/api/v1/chain-templates` endpoint answers 200, that all
7 data categories match field by field, and that every node's subscription credential
(uuid/password) is unchanged. Measured: 8 migrations (0040–0047), startup-to-healthy 1.1s,
`PASS`.

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
