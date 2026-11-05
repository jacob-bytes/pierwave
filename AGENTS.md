# 工程约定（所有人和子 agent 必须遵守）

## 构建命令：只能用 make

本机沙箱不允许写 `~/.cargo`、`~/.npm`，所以全局缓存被指到仓库内。
**直接敲 `cargo` / `npm` 会失败**（Operation not permitted）。一律用：

```bash
make check        # fmt + clippy(-D warnings) + test + web build，提交前必跑
make test         # 只跑测试
make clippy
make web-build
make run          # 起主控（默认 127.0.0.1:8787，DB=data/pierwave.db）
```

需要单独跑 cargo 时显式带上缓存目录：

```bash
CARGO_HOME=$PWD/.cargo-home cargo test -p pierwave-domain
```

## 分层与文件归属

| 目录 | 职责 | 禁止 |
|---|---|---|
| `crates/proto` | 主控↔Agent 线协议、跨端 DTO | 引入 axum / sqlx |
| `crates/domain` | 数据模型、SQL、业务规则 | 引入 axum、读 HTTP 上下文 |
| `crates/master` | axum 路由、鉴权、静态资源 | 直接写 SQL（走 repo） |
| `crates/agent` | 收敛器、进程监督、上报 | 依赖 master 的代码 |
| `web/` | SPA（React 19 + TS + Tailwind 4 + **shadcn/ui**） | 手改 `dist/`、手写 Button/Dialog/Toast |

所有 SQL 只能在 `crates/domain/src/repo.rs` 里出现。

## 硬性规则

1. **协议只增不改**：动 `crates/proto` 的字段/变体，必须同时升 `PROTOCOL_VERSION`，并保证旧 Agent 能忽略新消息。
2. **期望态而非命令**：Agent 侧只有「收敛到 DesiredState」一个动作，新增能力不许加命令式 RPC。
3. **迁移只追加**：`crates/domain/migrations/` 下不改历史文件，新需求加 `000N_xxx.sql`。
4. **文案中文**：面向用户的报错、按钮、提示一律简体中文。
5. **测试**：纯逻辑（配置生成、订阅渲染、计费换算）必须有单元测试；涉及 HTTP 的用 `#[tokio::test]` + 内存 SQLite。
6. **不碰参考目录**：`miaomiaowux-docs/` 是本地抓取的第三方文档，已 gitignore，只读。
7. 提交前 `make check` 必须全绿；不许 `#[allow(dead_code)]` 掩盖没写完的东西（临时标注需在 PR 说明里写清）。

## 前端

- 组件层是 **shadcn/ui（radix-nova 预设）**：组件放 `web/src/components/ui/`，用 `npx shadcn@latest add <name>` 拉取，不自己重写。
- 视觉与动效规范见 `docs/DESIGN.md`（深色 zinc 基底 + 单一强调色，动效 150–220ms）。
- 列表页四态（loading / empty / error / 正常）是硬要求，不是可选优化。
- 不写死颜色，全部走 `--background` 这类 CSS 变量。

## 并行协作（多 lane 同时开工时）

1. **同一时刻只有一条 lane 改共享 crate**（`crates/domain`、`crates/master`）；其它 lane 改自己的 crate 或 `web/`。
2. 新增 `mod xxx;` 引用时，**必须在同一次改动里创建文件**，否则整棵树编不过，别人全部阻塞。
3. lane 自查用 `cargo check -p <自己的 crate>`；`make check` / `make e2e` 这种全量验证由主控在合流后统一跑。
4. 发现工作区被别的 lane 改坏：不要 revert、不要注释别人的代码、不要 `git checkout`，直接汇报并停下。
5. 卡住超过一个回合就上报，不要反复重试同一个失败命令。
6. shell 脚本里变量后面紧跟中文标点时必须写 `${VAR}`：本机 locale 会把全角字符吞进变量名，
   报错长得像 `V（: unbound variable`，极难定位。

## 当前已通的链路

登录（Cookie 会话）→ 建服务器并一次性返回 token → Agent 用 token 反连 `/api/agent/ws` →
主控下发 Ack、接收心跳并落库 → 断开标记离线。前端 `/login`、`/servers` 两屏可用。
