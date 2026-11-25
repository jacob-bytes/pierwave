# 链路时延趋势：图例下拉多选 + 数据范围 x 轴

**中文**：24 条链时图例折成三行、把图表往下压；同时 x 轴铺满 24h 窗口，
而数据只覆盖约 19h，左右各留一大段空白。本目录用真实主控数据（`data/preview.db`
的副本）验证两处修复：图例收进卡头多选下拉、只保留一行已选链标签；x 轴收敛到
有效样本的实际最小 / 最大时间，绘图区用满左右空间。

**English**: With 24 chains the legend wrapped to three rows and pushed the
chart down, while the x-axis always spanned the full 24h window even though the
data only covered ~19h, leaving large blank areas on both sides. This directory
verifies both fixes against real controller data (a copy of `data/preview.db`):
the legend moves into a multi-select dropdown in the card header with a single
row of selected-chain tags, and the x-axis shrinks to the actual first/last
sample so the plot uses the full width.

## 交互 / Behaviour

- 卡头右侧按钮显示 `显示 5 / 23`；弹层里是搜索框、全选 / 清空、每条有样本链
  的复选框（线型色块 + 名称 + 当前窗口 P50）。
- **默认选择**：参数缺失时按当前窗口 P50 **降序**取前 5 条（最慢的优先），
  P50 相同按列表原顺序；选择会以 `replace` 写回 `?series=`，30 秒轮询导致
  排名变化时不会重新洗牌。`?series=` 空串表示用户主动清空，刷新后保持空态。
- 无样本链不进入选择，仍折叠在「N 条暂无样本」里；搜索时直接展示命中的
  无样本链。
- 图表下方只保留一行已选链标签（横向滚动，不折行）；图例高度 25.6px。
- x 轴范围 = **选中链的有效样本**最早 / 最晚时间；tooltip 与刻度仍按真实时间
  显示。窗口首尾的空桶会从图中裁掉（表格视图仍保留整窗，空桶显示 `—`），
  因为 recharts 会按数据里的 `ts` 扩展 domain。
- 外边距 `left: 8 / right: 12`；y 轴标签仍占 48px。

**English**: The header button reads `Show 5 / 23`; the popover contains a
search box, select-all / clear, and one checkbox per sampled chain (line
swatch + name + current-window P50). Defaults are the **slowest five by P50**
(descending; ties keep list order), frozen into `?series=` with `replace` so the
30s poll never reshuffles them. An empty `?series=` means the user cleared the
selection and stays empty after reload. Unsampled chains never enter the
selection and remain folded under “N without samples”. Below the chart there is
exactly one horizontally scrollable row of selected tags (25.6px tall). The
x-axis spans the selected chains' first/last valid sample; tooltip and ticks
still show real times. Empty buckets at the window edges are trimmed from the
chart (the table view still shows the full window as `—`) because recharts
extends the domain from the data timestamps. Margins are `left: 8 / right: 12`;
the y-axis label gutter stays 48px.

## 截图 / Screenshots

| 场景 / Scenario | 1440 dark | 1440 light | 390 dark | 390 light |
|---|---|---|---|---|
| 24 链池，默认 5 条 / 24-chain pool, default 5 | `default-5-1440-dark.png` | `default-5-1440-light.png` | `default-5-390-dark.png` | `default-5-390-light.png` |
| 全选 23 条有样本链 / all 23 sampled | `all-chains-1440-dark.png` | `all-chains-1440-light.png` | `all-chains-390-dark.png` | `all-chains-390-light.png` |
| 下拉展开 + 搜索「港日」/ picker + search | `picker-search-1440-dark.png` | `picker-search-1440-light.png` | `picker-search-390-dark.png` | `picker-search-390-light.png` |
| 空选择空态 / empty selection | `empty-1440-dark.png` | `empty-1440-light.png` | `empty-390-dark.png` | `empty-390-light.png` |

## 实测 / Measured

数据池：24 条链，23 条有样本、1 条无样本；有效样本覆盖约 19.25h
（`01:00–20:15`，24h 窗口内）。

| 项目 / Metric | 结果 / Result |
|---|---|
| 图例高度 / legend height | 25.6px（1 行，`white-space: nowrap` + 横向滚动） |
| 右外边距 / right blank | 12px（旧 `margin.right = 40`） |
| 左边距 + y 轴槽 / left gutter | 56px = `margin.left 8` + YAxis 48 |
| 数据占绘图区 / data span | 100%（`lineWidthRatio = 1.0`；旧实现 19.25h/24h ≈ 80%） |
| 绘图区宽度 / plot width | 1440: 1052px；390: 258px（surface 326px） |
| 390 横向溢出 / overflow | 0px |
| 默认选择 / default | URL 中 5 个 id，等于窗口 P50 降序前 5 |

## 断言 / Assertions

`report.json` 共 47 条，全部通过：

- 默认 5 条 = 当前窗口 P50 降序前五，URL `?series=` 写入 5 个 id；
- 勾选第 6 条后 URL 增加该 id，刷新后仍是 6 条；
- 切到「流量趋势」再切回「链路时延」、24h ↔ 7d，`?series=` 不变；
- 全选 = 23 条并写入 URL；清空后 `?series=` 为空串，图表显示「全部链路已隐藏」且无折线；
- 下拉包含搜索 / 全选 / 清空 / 无样本折叠，搜索「港日」只留匹配行；
- x 轴 `data-axis-min/max` 等于所选链有效样本的最小 / 最大时间；
- 图例 1 行且 ≤32px；右侧空白 ≤12px；数据占绘图区 ≥98%；
- 1440 / 390、亮 / 暗均无横向溢出。
- 回归：tooltip 列出 5 条选中链并按真实时间显示；表格视图 = 时间 + 5 列；
  无样本折叠展开后名单与无样本链数量一致（`tooltip-1440-dark.png`、
  `table-view-1440-dark.png`、`picker-unsampled-1440-dark.png`）。

## 重新生成 / Regenerate

```bash
# 1) 复制真实预览库，把样本平移到「现在」约 4.5 小时前：
#    24h 窗口内只覆盖约 19h，用于验证 x 轴收缩。
sqlite3 data/preview.db ".backup '/tmp/pw-chain-trend.db'"
NOW=$(date +%s)
MAXL=$(sqlite3 /tmp/pw-chain-trend.db "select max(ts) from forward_latency_samples;")
MAXP=$(sqlite3 /tmp/pw-chain-trend.db "select max(ts) from forward_probe_samples;")
sqlite3 /tmp/pw-chain-trend.db \
  "update forward_latency_samples set ts = ts + $((NOW - 16200 - MAXL));
   update forward_probe_samples  set ts = ts + $((NOW - 16200 - MAXP));"

# 2) 预览库 admin 密码不是 devpass 时，用本地 argon2id 重算 password_hash：
#    （m=19456, t=2, p=1；也可以把 ADMIN_PASSWORD 指向已有密码）
python3 - <<'PY'
from argon2 import PasswordHasher
print(PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1,
                     hash_len=32, salt_len=16).hash("devpass"))
PY

# 3) 起真实主控（web/dist 必须是当前构建）
make web-build
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8797 \
  PIERWAVE_DB='sqlite:///tmp/pw-chain-trend.db?mode=rwc' \
  ./target/debug/pierwave-master

# 4) 截图 + 断言
BASE=http://127.0.0.1:8797 node web/screenshots/chain-trend-series/shots.mjs
```

Playwright 从仓库 `.npm-cache/_npx/.../playwright` 加载，不新增项目依赖；
需要本机 Chrome（默认 `/Applications/Google Chrome.app`，可用 `CHROME_PATH`
覆盖）。截图内的链、P50、丢包、时间范围全部来自真实 `chain-health` 接口，
没有浏览器侧注入。
