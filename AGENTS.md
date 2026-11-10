# 工程约定（所有人和子 agent 必须遵守）

## 构建命令：只能用 make

本机沙箱不允许写 `~/.cargo`、`~/.npm`，所以全局缓存被指到仓库内。
**直接敲 `cargo` / `npm` 会失败**（Operation not permitted）。一律用：

```bash
make check        # 格式校验 + clippy(-D warnings) + test + web build，提交前必跑
make fmt          # 自动格式化（check 只校验，不改文件）
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
4. **文案双语**：面向用户的报错、按钮、提示要同时提供简体中文与英文（见下方「发布与内容规则」）。
   后端的错误信息目前只有中文，这是已知缺口，新增错误文案时优先做成可翻译的键。
5. **测试**：纯逻辑（配置生成、订阅渲染、计费换算）必须有单元测试；涉及 HTTP 的用 `#[tokio::test]` + 内存 SQLite。
6. **不碰参考目录**：`miaomiaowux-docs/` 是本地抓取的第三方文档，已 gitignore，只读。
7. 提交前 `make check` 必须全绿；不许 `#[allow(dead_code)]` 掩盖没写完的东西（临时标注需在 PR 说明里写清）。

## 前端

- 组件层是 **shadcn/ui（radix-nova 预设）**：组件放 `web/src/components/ui/`，用 `npx shadcn@latest add <name>` 拉取，不自己重写。
- 视觉与动效规范见 `docs/DESIGN.md`（深色 zinc 基底 + 单一强调色，动效 150–220ms）。
- 列表页四态（loading / empty / error / 正常）是硬要求，不是可选优化。
- 不写死颜色，全部走 `--background` 这类 CSS 变量。

### 少写解释性文案（UI 层）

> **Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.**

面板的每一行说明都在和数据抢注意力。默认**不加**副标题、字段说明、功能注释卡：

- 表单字段能靠 label + placeholder 说清 → 不加 hint；
- 页面头部能靠标题 + 内容说清 → 不加一句"这里可以…"的导语；
- 列表能靠列名说清 → 不加"下表列出所有…"的描述。

**只有这三种情况值得写文案**，其余一律不加：

1. **不可逆或破坏性操作**（删除、重置订阅链接、恢复备份）——必须说清后果；
2. **语义容易被误解**（例如"监听中"不代表目标可达、套餐限速是近似值）——说明的是事实边界，不是功能；
3. **环境前置条件**（需要安装 realm、需要证书、需要重新应用配置）——用户不知道就会以为自己配置错了。

判断标准：**删掉这句话，用户会不会做错事或无法理解？** 不会，就删掉。

## 发布与内容规则（项目所有者明确要求）

1. **不要自行发版**：`git tag`、Release、版本号都由项目所有者拍板。改完代码只提交，等指示。
   需要发版时先给出建议的版本号与 release 说明草稿，等确认。
2. **面向用户的一切都要中英双语**：UI 文案、错误提示、空态、文档（README / docs/*.md）、
   截图说明都要同时提供中文与英文。新增 i18n 键必须**同时**加到 `zh-CN.ts` 与 `en.ts`
   （`en.ts` 用 `satisfies Messages`，漏键编译失败）。
3. **测试先于实现**：新增需求必须先补单元测试（或继承测试），再写业务代码。
   测试要覆盖边界与失败路径，而不只是 happy path。

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

## 回归红线（项目所有者明确要求）

**新需求不得破坏已经实现并验收的旧需求。** 每次改动前后都要确认：

1. 只改需求涉及的范围，**不要"顺手"回退或重写相邻的已验收实现**；
2. 视觉/文案调整前，先确认当前状态是不是**上一轮验收过的结果**——是就不许动；
3. 改动完成后，对同页面的其它既有功能做一次回归（至少肉眼过一遍）；
4. 发现别人的改动与自己的判断冲突时：**停下汇报，不要直接覆盖**；
5. 任何一次"改回"（把功能/样式恢复到更早状态）都必须先得到确认。

违反后果：用户会看到已经验收的东西莫名其妙消失，这比不做更糟。
