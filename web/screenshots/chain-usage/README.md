# 「转发用量」并入链路时延 · 验收截图 / Forward usage inside chain latency · acceptance

**中文** —— 本目录是「把独立菜单页『转发用量』并入概览 → 链路时延的第三个子页」
的验收证据。子页顺序固定为 **转发链 → 转发模板 → 转发用量**，第三个子页的 URL 是
`?view=chain&section=usage`，默认仍是 `section=chains`。

- 独立页 `/forward-usage` 已删除，旧地址重定向到 `/?view=chain&section=usage`；
- 侧边栏「转发用量」入口已移除，只剩「转发链 / 链模板」；
- 用量视图复用原来的 7/30/90 天窗口、用户筛选、按天表与按转发表、四态；
- 全局服务器筛选**不作用**于用量接口（后端 `/api/v1/forward-traffic` 尚无
  `server_ids`），页面不显示任何「筛选生效」暗示；截图脚本会断言该请求不带
  `server_ids`；
- 切子页保留 `status` / `q` / `series`，离开链路时延清理 `section`；
- 1440 / 390、亮 / 暗均无横向溢出；表格沿用原来的容器内纵向滚动。

截图 / Files:

| 文件 | 内容 |
|---|---|
| `chains-{1440,390}-{dark,light}.png` | 第一个子页「转发链」，三个子 tab 顺序可见 |
| `templates-{1440,390}-{dark,light}.png` | 第二个子页「转发模板」 |
| `usage-7d-{1440,390}-{dark,light}.png` | 第三个子页「转发用量」，默认 7 天 |
| `usage-30d-{1440,390}-{dark,light}.png` | 用量 30 天窗口 |
| `usage-empty-{1440,390}-{dark,light}.png` | 用量空态（窗口切换仍可用） |
| `usage-filter-bob-1440-dark.png` | 用户筛选只显示 bob 的转发 |
| `usage-error-1440-dark.png` | 用量错误态（可重试） |
| `legacy-redirect-usage-1440-dark.png` | `/forward-usage` 重定向后的页面与 URL |
| `sidebar-no-usage-entry-1440-light.png` | 侧边栏没有「转发用量」入口 |
| `usage-server-filter-not-passed-1440-dark.png` | 选了服务器，用量页不伪造过滤 |
| `params-preserved-1440-dark.png` | 切子页后 `status` / `q` / `series` 仍在 URL |
| `usage-7d-1440-light-en.png` / `usage-90d-1440-light-en.png` | 英文文案与 90 天窗口 |

复现 / Reproduce:

```bash
cd web
npm run build
node screenshots/chain-usage/shots.mjs
```

脚本用 Playwright 直接服务 `web/dist` 并在浏览器里 mock API，不需要主控或数据库。

**English** — Acceptance evidence for folding the standalone “Forward usage” page into
**Overview → Chain latency** as the third section. The section order is fixed as
**Chains → Templates → Usage**; the third section lives at
`?view=chain&section=usage`, while `section=chains` stays the default.

- The standalone `/forward-usage` page is gone; the legacy URL redirects to
  `/?view=chain&section=usage`.
- The sidebar entry is removed; only “Forward chains” and “Chain templates” remain.
- The usage view keeps the 7/30/90-day window, user filter, daily table, per-forward
  table and all four states.
- The global server filter intentionally does **not** apply: `/api/v1/forward-traffic`
  has no `server_ids` yet, and the section shows no “filter applied” hint. The screenshot
  script asserts the request never carries `server_ids`.
- Switching sections preserves `status` / `q` / `series`; leaving chain latency clears
  `section`.
- No horizontal overflow at 1440 / 390 in light or dark; the table keeps its existing
  in-container vertical scrolling.

Run the commands above to regenerate every screenshot.
