# TreeChart 拓扑验收截图 / TreeChart topology acceptance shots

**中文**：用独立的 Vite 页面渲染 `ChainTemplateTopology`（真实组件 + 真实
`chainTemplateTree` 布局），不依赖主控或数据库。每个场景断言：曲线是含 `C`
的 `path`、层级 x 递增、边宽 ∝ chains、叶子数 = 目标数、折叠 `+N`、hover
路径高亮节点数、390 下横向滚动。

**English**: Renders the real `ChainTemplateTopology` component (and the real
`chainTemplateTree` layout) through a standalone Vite page, so no controller or
database is required. Each run asserts cubic bezier `path` edges, increasing x
per level, edge width following chains, leaf count = target count, collapse `+N`,
hover path highlight counts, and horizontal scrolling at 390.

## 运行 / Run

```bash
cd web
./node_modules/.bin/vite --port 5199 --strictPort

# 另开一个终端 / another terminal
node web/screenshots/tree-chart/shots.mjs
```

覆盖 / Coverage:

| fixture | 场景 / Scenario |
|---|---|
| `single` | 单跳 / single hop |
| `multi` | 多跳多路径 / multi-hop, multi-path |
| `fold` | 12 个目标，默认 `+4 个目标` / 12 targets, folded to `+4` |
| `offline` | 离线成员，红色虚线 + 不可用 / offline path |

- `*-1440.png` / `*-390.png`：亮暗两套、两端宽度 / both themes, both widths
- `*-390-dark-end.png`：横向滚动到末端 / scrolled to the end
- `multi-collapsed-1440-dark.png`：点中间节点折叠，显示 `+5`
- `multi-hover-path-1440-dark.png` / `multi-hover-edge-1440-dark.png`：hover 到根的高亮路径
- `multi-pulse-frame-a/b-1440-dark.png`：脉冲两帧 / two pulse frames
- `multi-reduced-motion-1440-dark.png`：`prefers-reduced-motion` 下静态高亮
- `multi-en-1440-dark.png`：英文标签 / English labels

`report.json` 记录每张图的尺寸、滚动宽度、叶子数，以及 hover 高亮的节点数。
`report.json` records scroll widths, leaf counts, and hover-highlight node counts.
