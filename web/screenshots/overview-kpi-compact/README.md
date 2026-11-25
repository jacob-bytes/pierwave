# 概览 KPI 收紧 + 顶部全局 KPI 合并

> 区块 KPI（资源状态 / 成本开支 / 链路时延 / 转发模板）去掉固定 `min-h`，
> 高度只由内容 + 14px 内边距决定；副行固定单行省略，不再在数字下面留白。
> 顶部四卡合并为「在线服务器 / 用户与套餐 / 转发链 / 今日流量」。
> 截图覆盖 1440 / 390 × 亮 / 暗。
>
> Compact block KPI bars (server / cost / chain / templates) without a fixed
> `min-h`: height is content plus 14px padding, and hints are clamped to one
> line. The top row is merged into online servers / users & packages / forward
> chains / traffic today. Shots cover 1440 / 390 in both themes.

## 复现 / Reproduce

```bash
cd web
npm run build
node screenshots/overview-kpi-compact/shots.mjs
```

脚本只读 `web/dist`，并在 Playwright 里 mock `/api/v1/**`；不需要主控、数据库
或种子数据。Playwright 复用仓库 `.npm-cache/_npx` 里的缓存，不新增依赖。
结果写入 `report.json`，断言失败时退出码为 1。

The script serves `web/dist` and mocks `/api/v1/**` inside Playwright. No
controller, database or seed data is needed; it reuses the Playwright copy in
the repo's `.npm-cache/_npx`, so no project dependency is added. Results land in
`report.json`; the script exits non-zero when an assertion fails.

Mock 数据：9 个用户、7 个套餐实例、5 个套餐模板、3 条转发链（1 条阻断、
2 条降级）。/ Mock data: 9 users, 7 package instances, 5 package templates and
3 forward chains (1 blocked, 2 degraded).

## 截图 / Shots

| 文件 / File | 内容 / Contents |
|---|---|
| `top-cards-{dark,light}-{1440,390}.png` | 顶部四卡近景 / top four cards |
| `page-top-{dark,light}-{1440,390}.png` | 首屏（顶部卡 + tab + KPI）/ first viewport |
| `kpi-bars-{dark,light}-{1440,390}.png` | 四个 KPI 条并排对照 / four KPI bars side by side |
| `kpi-bar-{server,cost,chain,templates}-{theme}-{width}.png` | 单个 KPI 条 / single KPI bar |
| `tab-{server,traffic,cost,chain,templates}-{theme}-{width}.png` | 整页上下文 / full tab context |

「流量」tab 原本就没有区块 KPI 条，保持原样，只截整页作对照。
The traffic tab has never had a block KPI bar; it is left unchanged and only
captured for context.

## 断言 / Assertions

- **高度 = 内容 + padding**：单行数字 + 单行副行的单元格恒为
  `14 + 16.2 + 4 + 28 + 4 + 20.8 + 14 = **101px**`。底边与最后一行文字的
  间距正好是 `padding-bottom`（14px），没有 `min-h` 留下的空白。
- **同行等高**：同一行由 grid 自动拉齐；副行 `mt-auto` 贴底，即使同行有
  更高的卡也不会在数字下方留空。
- **1440**：四组 KPI 条均为 **101px**，最大高度差 **0px**。
- **390**：资源状态 / 链路时延 / 转发模板均为 **203px**（两行 × 101 + 1px
  分隔），三者差 0px。成本条为 **231px**：两张金额卡在 390 下
  `CNY 3,071.20` / `CNY 28,124.80` 换成两行，按第 3 条要求允许更高；两格
  仍等高，底边同样只有 14px padding。
- **副行**：`line-clamp-1` 单行省略，`title` 保留完整文案；13px line-height
  20.8px，实测文字高度与行高一致。
- **字号**：数字 28px、副行 13px、标签 12px，统计口径不变。
- **骨架**：资源状态骨架 1440 = 101px、390 = 203px，与真卡完全一致；
  成本骨架取单行高度 203px，金额换两行时只会变高到 231px，不会加载完变矮。
- **顶部四卡**：1440 单行 4 列，390 2×2；顺序为在线服务器 / 用户与套餐 /
  转发链 / 今日流量。
- **合并文案**：主数字 `9 用户 / 7 实例`，副行 `9 个用户 · 5 个套餐模板`，
  「全局」标注只出现一次。
- **转发链**：主数字取 `/api/v1/overview` 的 `chains.total`（mock 为 3），
  副行 `阻断 1 · 降级 2` 取 `chains.blocked` / `chains.degraded`。
- **无溢出**：文档 `scrollWidth` 不超过视口，四张卡都没有横向溢出。

All numeric results are in `report.json` (`errors: []` means every assertion
passed). The new source-level contracts live in
`web/src/components/overviewKpiCompact.test.mjs`.

Note: the 4-tab height spread is 0px at 1440 and 0px across the three
single-line tabs at 390; the cost tab at 390 is 28px taller because two amount
cards wrap to two lines, which is the explicitly allowed exception. Making it
exactly equal would require forcing cost amounts onto one line (a display
format change).
