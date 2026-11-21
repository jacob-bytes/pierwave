# 公开状态页设置截图 / Public status settings screenshots

中文：全部截图来自 `data/preview.db` 的临时副本（未改动真实库），中文界面、主题按文件名里的 `dark` / `light`，宽度 1440×900 与 390×844。
英文：All screenshots use a temporary copy of `data/preview.db` (the real database is untouched); the UI is Chinese, themes follow the `dark` / `light` suffix, and viewports are 1440×900 and 390×844.

## 设置 → 常规 / Settings → General

- `settings-public-status-enabled-*`：总开关开启，白名单 10 / 10，账期公开。
  Master switch on, 10 / 10 nodes public, pricing shown.
- `settings-public-status-disabled-*`：总开关关闭，后两组置灰不可编辑，显示「关闭后 /status 对所有人不可见」。
  Master switch off; the other two groups are disabled and the consequence copy is visible.
- `settings-public-status-billing-off-*`：状态页开启、账期隐私关闭，显示统一「未公开」的后果说明。
  Status page on, pricing privacy off, with the consequence copy.
- `settings-public-status-dialog-*`：白名单对话框，取消勾选 2 台（8 / 10），保存可用。
  Whitelist dialog with 2 nodes unchecked (8 / 10); Save is enabled.
- `settings-public-status-dialog-search-dark-1440.png`：对话框按「香港」过滤。
  Dialog filtered by “香港”.
- `settings-public-status-dialog-en-dark-1440.png`、`settings-public-status-enabled-en-dark-1440.png`：英文界面。
  English UI.
- `settings-public-status-whitelist-unsupported-dark-1440.png`：白名单接口 404 时仅该组降级，卡片其余开关可编辑。
  Whitelist GET returns 404: only that group degrades; the rest of the card stays editable.
- `settings-public-status-billing-unsupported-dark-1440.png`：旧后端不返回 `public_billing_visible` 时默认开启、开关禁用、保存不提交该键。
  Old backend without `public_billing_visible`: defaults to on, the switch is disabled, and the key is not submitted.
- `settings-public-status-general-save-success-dark-1440.png`：底部保存条成功 toast「常规设置已保存」。
  Bottom save bar success toast.
- `settings-public-status-general-save-error-dark-1440.png`：底部保存条失败 toast + 页面内联错误（PATCH 500 为模拟）。
  Bottom save bar failure toast + inline page error (simulated PATCH 500).
- `settings-public-status-save-success-*`：白名单 PUT 成功 toast「公开节点已保存」，摘要变为 8 / 10。
  Whitelist PUT success toast; summary becomes 8 / 10.
- `settings-public-status-save-error-*`：白名单 PUT 失败（模拟 500），弹窗保留、行内错误 + toast。
  Whitelist PUT failure (simulated 500): the dialog stays open with an inline error and toast.

## 探针页 / Public status page

- `probe-not-public-*`：账期隐藏时，卡片第三列显示 muted 的「未公开」。
  With pricing hidden, the third column shows a muted “Not public”.
- `probe-not-set-dark-1440.png`：未配置账期的节点仍显示「未配置」。
  A node without billing data still shows “Not set”.
- `probe-both-dark-1440.png`：通过响应拦截同时展示「未公开」与「未配置」（验证 per-server 契约）。
  Response interception shows “Not public” and “Not set” side by side (per-server contract).
- `probe-detail-not-public-dark-1440.png`：详情页④卡显示「未公开」，不隐藏整块。
  Detail card ④ shows “Not public” instead of hiding the block.

## 几何数据 / Geometry

`geometry.json` 对比「公开状态页」与同页「面板」「版本更新」「Agent 升级」三张卡：
`geometry.json` compares the new card with the existing Panel / Updates / Agent upgrades cards.

- 1440：四张卡均为 width 1152px、border-radius 16.8px、padding 16px；
  标题 14px / 500 / 18.9px 行高；说明 12px / 19.2px 行高；
  内容网格 row/column gap 20px。
- 390：四张卡均为 width 342px，其余 token 与 1440 相同。
- 开关：两行均为 32×18.39px、行高 18.89px、`justify-between`、gap 12px，
  右边缘同为 1400px（1440）/ 350px（390），标签与开关垂直中心偏差 0px；
  与同页「版本更新」卡开关尺寸一致。

English: at 1440 all four cards share width 1152px, radius 16.8px, padding 16px,
title 14px/500/18.9px, description 12px/19.2px, grid gaps 20px; at 390 all are
342px wide with the same tokens. Both switch rows are 32×18.39px with 18.89px
row height, `justify-between`, 12px gap, the same right edge (1400px / 350px),
0px vertical-center offset, and the same control size as the Updates card.
