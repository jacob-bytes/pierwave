# 第二轮：把「需要被读的次要数据」提到 13px

**中文**：本轮只处理用户会认真读的辅助数据，图表刻度 / 图例 / Badge 内部 /
表头保持 11–12px。没有整仓正则替换，逐页按语义改；没有提交。

**English**: This round raises only secondary data users actually read to 13px.
Chart ticks, legends, text inside badges and table headers stay at 11–12px.
Changes are page-by-page and semantic, not a repo-wide regex; nothing is
committed.

## 提到 13px 的位置 / What moved to 13px

| 位置 / Area | 具体内容 / Details |
|---|---|
| 服务器列表 / servers | IP 地址、分组、当前速率、负载、内存百分比、心跳时间、版本与延迟；移动卡片副标题与全部字段 |
| 链路列表 / chain list | 路由、最近样本时间（`[data-chain-endpoint-name]` / `[data-chain-sample]`） |
| 转发列表 / forwards | 监听端口、目标地址、启用 / 停用文字 |
| 用户列表 / users | short code、创建时间、套餐流量数字行；移动卡片全部字段 |
| 套餐列表 / packages | 额度、周期、节点倍率；移动卡片全部字段 |
| 链路详情 / chain detail | 整体 P50 / 窗口丢包数值、诊断句、逐段行（段号 / P50 / 丢包 / 占比） |
| 服务器详情弹层 / server details | 地址副标题与全部字段值 |
| 空态 / 错误态 | `EmptyState`（`size="sm"`）说明、`ListError` 正文 |

**保持 11–12px**：recharts / SVG 刻度、图例、拓扑连接线标注、Chrome 内
tooltip（图表内标注）、Badge 内部文字、表头、极小的密度标签。链路列表
P50 / 丢包 / 状态仍是 15 / 14 / 15px 主数据。

**English**: 11–12px stays for chart ticks, legends, topology connector labels,
in-chart tooltips, text inside badges, table headers and tiny density labels.
The chain table's primary P50 / loss / status values remain 15 / 14 / 15px.

## 必要的列宽 / 标签调整 / Necessary width and label changes

1. **链路列表列宽重排**：13px 后 22fr 路由列会截断 4 跳链的
   「… → 新加坡-02」。改为
   `18fr / 31fr / 25fr + 56 / 72 / 80 / 80 / 24px`：
   地址列 299px、路由列 241px（完整 4 跳）、链路列 174px（最近样本
   13px 仍完整）。实测这三处 `scrollWidth = clientWidth`。
2. **逐段行**：段号列 `w-12 → w-14` 加 `whitespace-nowrap`，避免 13px
   「第 1 段」在 390 折成两行；占比列 `w-7 → w-9` 容纳 13px 的 `100%`。
3. **服务器表**：13px 让表格内容宽 1229px，容器 1152px，
   `scrollWidth - clientWidth = 77px`。改动前 sticky 操作列已经会压住速率列
   右端，13px 后更明显。选择**保留表内横向滚动**，不压缩 13px，也不隐藏
   「当前速率」列：
   - sticky 操作列在 `scrollLeft = 0` 时会盖住速率列右端，这是改动前已有
     的行为，13px 后更明显；
   - 横向滚到末端后完整显示 `↓ 1.8 MB/s ↑ 512 KB/s`，见
     `after13/servers-1440-dark-scrolled.png` / `-light-scrolled.png`；
   - 页面级 `document.scrollWidth` 仍等于视口，不产生整页横向滚动。
4. **390 转发表**：表格内容 760px、容器 342px，保持表内横向滚动
   （`+418px`），页面无溢出；滚到目标列时 `10.0.0.11:22` 完整显示，见
   `after13/forwards-390-dark-target.png`。
5. **390 服务器卡片头部**（只动移动卡片，桌面表格未改）：
   - 第一行：名称 + 在线状态（复选框在名称与状态之间）；
   - 第二行：分组（纯文本，13px，不再用等宽字体）；
   - IP 从副标题移到字段区第一行：13px 等宽、完整显示、右侧保留复制按钮；
   - 名称行的复制按钮移除，同时移动端「详情」从文字按钮改成图标按钮，
     把宽度让给名称；IP 仍可一键复制；状态徽章在移动头部用紧凑样式（无图标），
     避免长名称（新加坡-02 / 探针-待接入）被状态挤掉。
   实测：10 张服务器卡片的名称 / 分组 / IP 均 `scrollWidth = clientWidth`；
   点击 IP 复制按钮后剪贴板为 `203.0.113.11`、toast 显示「已复制」。

## 实测 / Measurements

`measure13.mjs`：**16 项检查，0 失败**，报告在
[measure13-report.json](measure13-report.json)。

| 检查 / Check | 1440 | 390 |
|---|---:|---:|
| 服务器 IP / 心跳 / 版本 / 负载 / 内存 / 速率 | 13px | 13px（移动卡片字段） |
| 链路路由 / 最近样本 | 13px / 13px | 13px / 13px |
| 链路地址（保持） | 12px | 12px |
| 链路表头 | 11px | 隐藏 |
| 转发的端口 / 目标 / 启用 | 13px | 13px |
| 用户的 short code / 创建时间 / 流量行 | 13px | 13px（卡片字段） |
| 套餐的额度 / 周期 / 倍率 | 13px | 13px（卡片字段） |
| 详情诊断句 / 逐段行 / 整体数值 | 13px | 13px |
| 详情时间轴刻度 / 图例 / 拓扑标注 | 11 / 11 / 11px | 11 / 11 / 11px |
| 空态说明 / 错误正文 | 13px | 13px |
| 390 服务器卡片名称 / 分组 / IP | — | 13px，无截断，IP 可复制 |
| 页面横向溢出 / page overflow | 0 | 0 |

链路行实测：`sampleFont = routeFont = 13`，`addressFont = 12`，
`rowOverflow = 0`；1440 路由与地址、390 路由与地址均无 `scrollWidth >
clientWidth`。拓扑长标注仍为 11px，`（引擎不支持探测）` 99px 完整显示。

**English**: 16 checks, 0 failures. All targeted fields measure 13px at both
widths; chart ticks / legends / topology labels remain 11px; address stays 12px;
page overflow is 0. Chain route/address/sample have no truncation.

## 截图 / Screenshots

- `before13/`：本轮改动前（12px 次要数据；链路列表用 12px 样式模拟）。
- `after13/`：本轮改动后（13px 次要数据）。
- `compare13/`：`compare-{servers,chain-list,forwards,chain-detail-long,settings,status}-{width}-{theme}.png`
  左右并排 BEFORE | AFTER。
- 额外证据：
  - `after13/servers-1440-{dark,light}-scrolled.png`：服务器表横向滚到末端，
    完整速率列；
  - `after13/forwards-390-dark-target.png`：390 转发表滚到目标列；
  - `after13/chain-detail-bottom-390.png`：详情逐段行 13px 不折行；
  - `after13/chain-list-{1440,390}-*.png`：链路列表整表；
  - `after13/users-390-dark.png` / `after13/packages-1440-dark.png`：
    用户 / 套餐 13px 次要字段；
  - `after-mobile/servers-390-dark.png`：390 服务器卡片，名称 / 分组 / 完整 IP；
  - `after-mobile/servers-390-light-copied.png`：点击 IP 复制后的「已复制」toast；
  - `after-mobile/servers-1440-dark.png`：桌面表格未受移动头部改动影响。

## 命令结果 / Commands

```text
npm test            1224 pass / 0 fail   (baseline 1224)
npx tsc -b --noEmit exit 0
npm run build       exit 0
npm run lint        0 errors (pre-existing warnings only)
全站 probe          64 checks, below 11px = 0, overflow = 0
tooltip probe       12/12 in viewport, no clipping (11–12px chart tooltips)
源码扫描            < 11px = 0；新增 13px 仅用于上述语义位置
```

## 说明 / Notes

- 图表内 tooltip 仍保持 11–12px；它属于图表标注，和刻度 / 图例同一密度组。
  若希望 tooltip 明细也升 13px，需要单独放宽 tooltip 宽度并重测 390。
- 390 服务器卡片的名称行不再带名称复制按钮（宽度让给名称 + 状态）；
  IP 仍在字段区提供复制。桌面表格仍只有名称 / 地址的 `title` 提示，行为未变。
- 服务器表继续表内滚动是刻意选择：13px 下若强行把列压回 1152px，只能隐藏
  或压缩「当前速率」列，信息损失更大。页面本身没有横向溢出。

- In-chart tooltips remain 11–12px as part of the chart annotation group. The
  server table intentionally keeps in-table horizontal scrolling; squeezing it
  back to 1152px would hide or compress the rate column. Page overflow is zero.
