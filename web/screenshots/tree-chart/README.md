# TreeChart 拓扑验收截图 / TreeChart topology acceptance shots

**中文**：用独立的 Vite 页面渲染 `ChainTemplateTopology`（真实组件 + 真实
`chainTemplateTree` 布局），不依赖主控或数据库。断言覆盖：曲线是含 `C` 的
`path`、层级 x 递增、边宽 ∝ chains、叶子数 = 目标数、`+N` 按父节点分组、
脉冲并发上限、hover 路径高亮、tooltip 定位、可访问性属性。

**English**: Renders the real `ChainTemplateTopology` component (and the real
`chainTemplateTree` layout) through a standalone Vite page, so no controller or
database is required. Assertions cover cubic bezier `path` edges, increasing x
per level, edge width following chains, leaf count = target count, per-parent
`+N` folding, pulse concurrency cap, hover path highlight, tooltip placement,
and accessibility attributes.

## 运行 / Run

```bash
cd web
./node_modules/.bin/vite --port 5199 --strictPort

# 另开一个终端 / another terminal
BASE=http://localhost:5199 node web/screenshots/tree-chart/shots.mjs
# 新契约：stale 提示 / 未使用候选 / 旧契约降级
BASE=http://localhost:5199 node web/screenshots/tree-chart/contract-shots.mjs
# 性能前后对比（同一份 fixture 在两个代码树上各跑一次）
BASE=http://localhost:5199 LABEL=after  node web/screenshots/tree-chart/measure-perf.mjs
BASE=http://localhost:5183 LABEL=before node web/screenshots/tree-chart/measure-perf.mjs
```

覆盖 / Coverage:

| fixture | 场景 / Scenario |
|---|---|
| `single` | 单跳 / single hop |
| `multi` | 多跳多路径（含交叉边）/ multi-hop, multi-path with cross edges |
| `fold` | 12 个目标，默认 `+4 个目标` / 12 targets, folded to `+4` |
| `offline` | 离线成员，红色虚线 + 不可用 `—` / offline path, dashed red + `—` |
| `fold-multi` | 两个父节点各 10 目标、链数交错：各自 `+2` / per-parent fold |
| `degraded` | `abnormal` / `no_data` 成员：琥珀色、不脉冲 / degraded, no pulse |
| `empty` | 0 链：空态，不画孤立根 / no traffic: empty state |
| `longlabel` | 超长目标名：24 字截断 + `…` / long label truncated |
| `stale` | 模板已修改：提示行 + `stale_reason` 在 title，节点仍按真实链 / stale notice |
| `unused` | 未使用候选只来自 `unused_candidates`，离线 / 降级各一 / unused candidates |

关键截图 / Key shots:

- `*-1440.png` / `*-390.png`：亮暗两套、两端宽度 / both themes, both widths
- `fold-multi-before-1440-dark.png`：修复前全局 slice：p1 只剩 5 个目标、
  唯一的 `+12 个目标` 挂在 p2 上（含别家目标）/ before the fix
- `fold-multi-collapsed-1440-dark.png` / `fold-multi-expanded-p1-1440-dark.png`：
  每个父节点自己的 `+N`，点开只展开这一组 / per-parent fold, expand one group
- `tooltip-top-before-390-dark.png`：修复前首行节点的 tooltip 被滚动容器裁到
  只剩一行 / before: top-row tooltip clipped
- `tooltip-top-row-1440-dark.png`：修复后翻到锚点下方 / after: flips below
- `tooltip-390-end-390-dark.png`：390 滚到末端仍夹在可见窗口里 / clamped at 390 end
- `tooltip-focus-1440-light.png`：键盘 focus 同样定位并关联 tooltip
- `offline-unavailable-tooltip-1440-dark.png`：不可用边标签 `—` + 「最近已知」/
  unavailable label `—` + "last known"
- `degraded-tooltip-1440-dark.png`：降级路径标黄 + 「数值为最近已知」/
  degraded amber + "value is last known"
- `tap-first-390-dark.png` / `tap-second-390-dark.png`：390 首点选中、再点折叠 /
  first tap reveals, second collapses
- `multi-reduced-motion-1440-dark.png`：同一条 pulse path 静态可见，没有静态副本
- `empty-topology-1440-dark.png`：0 链空态 / zero-chain empty state
- `longlabel-1440-dark.png`：长标签截断 / truncated long label
- `real-dialog-1440.png` / `real-dialog-390.png`：真实弹窗里（主控 + 路由 mock）
  的拓扑 / the real dialog in the app (controller + mocked routes)
- `stale-*-{1440,390}.png`：模板已修改提示，`stale_reason` 只在 title /
  stale notice with the reason in the title
- `unused-*-{1440,390}.png`：未使用候选 chips（离线红 / 降级黄）/
  unused candidate chips (offline red / degraded amber)
- `legacy-*-{1440,390}.png`：旧契约（无 `stale` / `unused_candidates`）不显示
  提示与空面板 / legacy contract shows neither notice nor empty panel

`report.json` 记录每张图的尺寸、滚动宽度、叶子数、折叠数，以及 hover 高亮、
tooltip 几何、aria 文案等断言值。`perf-summary.json` 是 before/after 各 4 轮
交替测量的中位数（DOM 数、pulse path 数、hover 写入次数、空闲帧率），
`perf-before.json` / `perf-after.json` 是最后一次原始样本。
`report.json` records per-shot size, scroll width, leaf/fold counts plus hover
highlight, tooltip geometry and aria text. `perf-summary.json` holds alternating
before/after medians (DOM count, pulse path count, hover writes, idle frame
rate); `perf-before.json` / `perf-after.json` are the latest raw samples.
