# 链路列表筛选 / 搜索 / 排序验收

> 「链路时延」列表从「只能滚动看 24 条」变成可筛选的列表：状态下拉
> （带各状态数量）、即时关键词过滤、三档排序、URL 持久化与空态。
> 全部改动只在 `web/`。
>
> The chain-latency list is now filterable: a status dropdown with per-status
> counts, instant keyword search, three sort dimensions, URL persistence and a
> no-match empty state. All changes live under `web/`.

## 行为 / Behaviour

**中文**

1. **状态筛选**：卡头右侧下拉，选项为「全部 / 正常 / 降级 / 阻断 / 未知 /
   样本不足」；有停用链时追加「停用」一档（否则总数与各档之和对不上）。
   状态一律走 `chainHealthState()`，与列表状态徽章是同一套判定：阻断 /
   降级 / 未知取新契约 `status.kind`，缺契约时回退到链配置，最后才是
   「变慢 / 样本」；`slow`（变慢）仍属于「正常」，与徽章 `正常 + 变慢` 一致。
   下拉每一项右侧显示数量，选中项有勾选与高亮。
2. **关键词过滤**：搜索框即时过滤（无需回车），匹配链路名、起点 / 终点
   地址与服务器名、路由节点 / 组成员、模板名（管理员模板列表）以及链配置
   里的入口地址、组名、成员名；大小写不敏感，空格分隔的多个词按 AND。
   输入后出现清除按钮；与状态筛选叠加生效。
3. **排序**：桌面表头的 P50 / 窗口丢包可点击切换升降序；卡头排序下拉覆盖
   P50 / 丢包 / 最近样本三档并带「默认顺序」复位。空值（没有样本 / 没有
   探测）永远排最后，不当作 0；默认保持后端原有顺序。
4. **URL 与空态**：`?status=blocked&q=港日` 是筛选的唯一来源，刷新 / 分享
   保持；离开「链路时延」tab 时由 `applyOverviewView` 清掉这两个参数。
   过滤后为空显示「没有匹配的链路」+「清除筛选」；计数显示
   `24 条 · 筛出 6 条`，无筛选时仍显示 `24 条`。

**English**

1. **Status filter**: a dropdown on the right of the card header with
   All / Normal / Degraded / Blocked / Unknown / Not enough samples, plus
   Disabled only when a disabled chain exists (otherwise the counts would not
   add up). States go through `chainHealthState()` — the same path as the row
   badge: `status.kind` first, then chain config, then the slow/sample
   fallback. A slow chain is still Normal, matching the `Normal + Slow` badges.
   Each option shows its count; the selected option gets the check and
   highlight.
2. **Keyword filter**: instant filtering while typing. Matches chain name,
   entry/exit address and server name, route nodes and group members, template
   name (admin template list), plus config entry address, group names and
   member names. Case-insensitive; space-separated terms are ANDed. A clear
   button appears once there is input; it stacks with the status filter.
3. **Sorting**: desktop P50 / window-loss headers toggle ascending/descending;
   the header dropdown covers P50 / loss / latest sample and can reset to the
   original order. Missing values (no samples / no probes) always sort last,
   never as zero.
4. **URL and empty state**: `?status=blocked&q=港日` is the single source of
   truth for filters, so refresh/share keeps them; leaving the chain-latency
   tab drops both params via `applyOverviewView`. An empty result shows
   “没有匹配的链路” with a “清除筛选” button; the count shows
   `24 条 · 筛出 6 条` while filters are active and `24 条` otherwise.

## 状态映射 / Status mapping

筛选档位与列表徽章共用 `chainHealthState()`，每个档位直接复用
`CHAIN_STATE_LABEL_KEYS` 的文案键；「停用」不是新语义，只是徽章本来就有的
第六种状态，且只在有停用链时出现在下拉里。

| 徽章状态 / badge state | 徽章文案 / badge label | 筛选档位 / filter option | URL 值 / URL value |
|---|---|---|---|
| `ok` | 正常 / Normal | 正常 | `ok` |
| `degraded` | 降级 / Degraded | 降级 | `degraded` |
| `blocked` | 阻断 / Blocked | 阻断 | `blocked` |
| `unknown` | 未知 / Unknown | 未知 | `unknown` |
| `insufficient` | 样本不足 / Not enough samples | 样本不足 | `insufficient` |
| `disabled` | 停用 / Disabled | 停用（有停用链时才出现） | `disabled` |

`chainStatus()` 的 `slow`（变慢）不是独立状态：徽章显示 `正常 + 变慢`，
筛选仍归入「正常」，与状态列完全一致。

## 输入延迟 / Input latency

24 条链、1440 暗色、10 次采样（输入事件 → 过滤后的行绘制完成，
`requestAnimationFrame` 计时）：

| 指标 / Metric | 实测 / Measured |
|---|---|
| 最小 / min | **14.4 ms** |
| 中位数 / median | **16.1 ms** |
| 最大 / max | **31.3 ms** |

单个查询覆盖 6 条（港日）/ 3 条（模板名、服务器名）/ 2 条（出口地址）/
0 条（空态）。数值随机器与帧率波动，量级是「一帧左右」，不是网络请求。

## 文件 / Files

| 文件 / File | 内容 / Contents |
|---|---|
| `web/src/lib/chainListFilters.ts` | URL 参数、状态分档 / 计数、关键词 haystack、排序的纯逻辑 / pure URL, status bucketing, search and sort logic |
| `web/src/lib/chainListFilters.test.mjs` | 17 项单元测试（URL、状态映射、计数、搜索、排序边界） / 17 unit tests |
| `web/src/components/overview/ChainLatencyListControls.tsx` | 搜索框、状态下拉、排序下拉、可点击表头 / search, status & sort pickers, sortable headers |
| `web/src/components/overview/ChainLatencyList.tsx` | 接线、URL 读写、计数、空态 / wiring, URL state, counts, empty state |
| `web/src/lib/overviewViews.ts` | 离开 tab 时清理 `status` / `q` / `series` / `section` / clears the chain-only params when leaving the tab |
| `web/src/components/chainListLayout.test.mjs` | 表头断言同步为可点击排序结构 / header test updated for sortable headers |
| `web/src/lib/overviewViews.test.mjs` | 补「离开链路 tab 清理筛选 / series」与四参数共存的组合断言 / combined coexistence + cleanup assertions |
| `web/src/i18n/{zh-CN,en}.ts` | 新增中英双语文案 / new bilingual strings |

## 截图 / Shots

截图由 `shots.mjs` 在无主控、无数据库的情况下直接 mock `/api/v1/**` 生成，
覆盖 1440 / 390 × 亮 / 暗。

| 文件 / File | 内容 / Contents |
|---|---|
| `status-{all,ok,degraded,blocked,unknown,insufficient,disabled}-{dark,light}-{1440,390}.png` | 七档状态筛选（含 390、亮暗） / all seven status passes |
| `status-dropdown-{dark,light}-{1440,390}.png` | 状态下拉展开，各档数量（含 390）/ open dropdown with counts |
| `search-港日-{dark,light}-390.png`、`search-港日-dark-1440.png` | 关键词过滤 / keyword filter |
| `combined-blocked-港日-{dark,light}-390.png`、`combined-blocked-港日-dark-1440.png` | 状态 + 关键词叠加 / stacked filters |
| `empty-{dark,light}-390.png`、`empty-dark-1440.png` | 空态与清除按钮 / empty state |
| `sort-p50-asc-dark-1440.png` | 点击 P50 表头升序 / P50 header ascending |
| `header-{dark,light}-390.png` | 390 筛选栏近景 / filter header close-up |

## 复现 / Reproduce

```bash
cd web
npm run build
node screenshots/chain-list-filters/shots.mjs
```

脚本只读 `web/dist`，并在 Playwright 里 mock `/api/v1/**`；不需要主控、数据库
或种子数据。Playwright 复用仓库 `.npm-cache/_npx` 里的缓存，不新增依赖。
结果写入 `report.json`，断言失败时退出码为 1。

如果构建目录正被其它 lane 覆盖，可先把 `dist` 复制到临时目录，再用
`DIST_DIR=/tmp/chain-list-dist node screenshots/chain-list-filters/shots.mjs`
对一份冻结的构建产物截图。

The script serves `web/dist` and mocks `/api/v1/**` inside Playwright. No
controller, database or seed data is needed; it reuses the Playwright copy in
the repo's `.npm-cache/_npx`, so no project dependency is added. Results land in
`report.json`; the script exits non-zero when an assertion fails. To avoid a
concurrent build replacing `dist` mid-run, copy it first and pass
`DIST_DIR=/tmp/chain-list-dist`.

## 断言 / Assertions

`report.json` 的 49 项全部通过：

1. 七档状态筛选的行数正确，每一行 `data-chain-status` 都等于所选档位
   （即与徽章同一口径）；计数徽章分别为 `24 条` / `24 条 · 筛出 N 条`。
2. 下拉计数 `全部 24 / 正常 15 / 降级 3 / 阻断 2 / 未知 2 / 样本不足 1 /
   停用 1`；与行数、徽章一致。
3. `q=港日` 命中 6 条；地址 `198.51.100.30` 命中入口/出口链；服务器
   `大阪-01` 命中 3 条；模板名「港日中转模板」命中 3 条。
4. 逐字输入 203 不丢字符；搜索框写入 `?q=`，清除按钮移除 `?q=`；
   `?status=blocked&q=港日` 叠加后 1 条；刷新后输入框、状态下拉与行数都保持。
5. 空态文案「没有匹配的链路」，计数 `24 条 · 筛出 0 条`；点「清除筛选」
   后恢复 24 行且 URL 不再有 `status` / `q`。
6. `status` / `q` 与兄弟 lane 的 `series`、`section` 共存：改关键词后
   三者都不被覆盖；离开「链路时延」切到「流量」后 `status` / `q` /
   `series` / `section` / `chain` 全部清掉（单测 + 浏览器断言各一条）。
7. 390 下 document / card 的 `scrollWidth` 不超过 `clientWidth`（无横向溢出）。
8. P50 表头点击后数值升序、再点降序；丢包下拉降序；最近样本选项存在且
   选择后 trigger 显示「最近样本」；「默认顺序」复位。

49 checks pass in `report.json`: status rows/counts match the badge state,
search hits names/addresses/servers/templates, stacked filters, URL persistence
and tab cleanup, empty-state copy and reset, no 390 horizontal overflow, and
ascending/descending sort behavior.

## 数据说明 / Data note

Mock 数据固定 24 条链：正常 15（其中「港美西链」delta 12ms，显示
`正常 + 变慢`）/ 降级 3 / 阻断 2 / 未知 2 / 样本不足 1 / 停用 1；名称带
「港日」的正好 6 条，对应需求示例 `q=港日 → 6 条`。起点 / 终点地址、
路由节点、模板 id、链配置均按真实契约形状生成；最后一段到「链目标」，
与主控契约一致。

Fixtures are 24 chains: 15 Normal (港美西链 has delta 12ms and therefore shows
`Normal + Slow`), 3 Degraded, 2 Blocked, 2 Unknown, 1 Not-enough-samples and
1 Disabled. Exactly six names contain 港日, matching the `q=港日 → 6` example.
Endpoints, route nodes, template ids and chain config follow the real contract
shape, including the final segment to the chain target.
