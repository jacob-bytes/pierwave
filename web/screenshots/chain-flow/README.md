# 链路详情复用模板画布 / Chain detail reuses the template canvas

**中文**：本目录验收「完整链路」从方框 + 细线条带改为复用模板拓扑画布的
这一版。脚本用静态构建 + Playwright API mock，不依赖主控 / 数据库；六条
链路 fixture 覆盖多成员、单卡、长链、最后一跳不可测、最后一跳缺数据与
折叠。

**English**: Acceptance shots for the "Full chain" section moving from the
box-and-line strip to the shared template topology canvas. The script serves a
static build and mocks the API with Playwright, so no master or database is
needed. Six chain fixtures cover multi-member, single-card, long, unmeasurable
last hop, missing last hop and folding.

## 复现 / Reproduce

```bash
cd web && npm run build
cd ..
node web/scripts/shots-chain-flow.mjs
```

模板画布静止帧的改动前 / 改动后对比。`before-*` 截图来自改动前的构建
（临时快照，不随仓库提交）；`after-*` 来自当前构建：

```bash
TEMPLATE_ONLY=1 SHOT_PREFIX=before- DIST_DIR=web/.dist-before \
  node web/scripts/shots-chain-flow.mjs
TEMPLATE_ONLY=1 SHOT_PREFIX=after- COMPARE_TEMPLATE=1 \
  node web/scripts/shots-chain-flow.mjs
```

## 读数 / Readings

- `multi`：适应窗口 **95%**，**4** 个可见药丸、**4** 条 hot 连线、
  **2** 首选 + **2** 候选；列头 = 组名 + 台数；`≈` 只出现在多成员段。
- `single`：**100%**，全部卡片 / 连线点亮，没有首选 / 候选标签。
- `long`：缩放下限 **90%**，右侧提示「右侧还有 2 列」，点击后画布平移。
- `folded`：入口 6 台 → **4 + 1** 张卡，列头 `4 / 6 台`；展开后 `6 台`
  并出现「恢复默认」。
- 药丸 CSS 盒宽：链路 **56px** / 模板 **44px**。
- 点亮连线带 **1s** march（`animationDuration: 1s`），链路画布无 pulse；
  `prefers-reduced-motion: reduce` 下 `animationName: none`。
- 不可测 / 缺数据段：虚线 + `—` + tooltip 说明；`target` / `unknown` 不画点。
- 模板画布静止帧：折叠 / 展开 × 深浅四组，改动前后 **0px** 差异
  （`report.json` 的 `templateDiff`）。
- `report.json` 记录全部读数与 `errors`（当前为空）。
