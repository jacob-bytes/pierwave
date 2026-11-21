# 公开状态页设置截图 / Public status settings screenshots

中文：截图来自 `data/preview.db` 的临时副本（未改动真实库），中文界面；主题见文件名 `dark` / `light`，宽 1440×900、390×844。失败态通过拦截 500 响应模拟。
英文：Screenshots come from a temporary copy of `data/preview.db` (the real database is untouched), Chinese UI; themes follow the `dark` / `light` suffix, viewports 1440×900 and 390×844. Failure states use intercepted 500 responses.

## 设置 → 常规 / Settings → General

- `settings-public-status-enabled-*`：双列开启态（对访客可见 → 到期与价格），白名单 10 / 10。
  Two-column enabled state; 10 / 10 nodes public.
- `settings-public-status-disabled-*`：关闭「对访客可见」；右列与白名单行置灰禁用，三处注释保留。
  Visitor switch off; the right column and whitelist row are disabled, all three notes remain.
- `settings-public-status-billing-off-*`：仅关闭「公开到期与价格」（含英文）；右列开关关闭，注释常驻。
  Pricing switch off only (including English); its persistent note remains.
- `settings-public-status-dialog-*`：白名单对话框，取消勾选 2 台（8 / 10），保存可用。
  Whitelist dialog with 2 nodes unchecked (8 / 10); Save enabled.
- `settings-public-status-dialog-search-dark-1440.png`：按「香港」过滤。
  Filtered by “香港”.
- `settings-public-status-enabled-en-dark-1440.png`、`settings-public-status-dialog-en-dark-1440.png`：英文界面。
  English UI.
- `settings-public-status-whitelist-unsupported-dark-1440.png`：白名单接口 404，只降级白名单组。
  Whitelist GET 404: only that group degrades.
- `settings-public-status-billing-unsupported-dark-1440.png`：旧后端不返回 `public_billing_visible`，默认开、开关禁用、保存不提交该键。
  Old backend without `public_billing_visible`: defaults on, switch disabled, key not submitted.
- `settings-public-status-general-save-success-dark-1440.png` / `...-error...`：底部保存条成功 toast / 失败 toast + 页面内联错误。
  Bottom save bar success toast / failure toast + inline error.
- `settings-public-status-save-success-*`：白名单 PUT 成功，摘要 8 / 10。
  Whitelist PUT success; summary 8 / 10.
- `settings-public-status-save-error-*`：白名单 PUT 失败（模拟 500），弹窗保留、行内错误 + toast。
  Whitelist PUT failure (simulated 500): dialog stays open with inline error and toast.

## 探针页 / Public status page

- `probe-not-public-*`：账期隐藏时第三列显示 muted 的「未公开」。
  With pricing hidden, the third column shows a muted “Not public”.
- `probe-not-set-dark-1440.png`：未配置账期显示「未配置」。
  A node without billing data shows “Not set”.
- `probe-both-dark-1440.png`：同屏「未公开」与「未配置」（per-server 契约）。
  “Not public” and “Not set” side by side (per-server contract).
- `probe-detail-not-public-dark-1440.png`：详情页 ④ 卡显示「未公开」，不隐藏整块。
  Detail card ④ shows “Not public” instead of hiding the block.

## 几何 / Geometry (`geometry.json`)

中文：
- 1440：卡片宽 1152px、高 217.75px；两列各 550px，宽度差 0；两列顶边差 0；两个开关顶边差 0；两列高度均 69.28px。
- 390：卡片宽 342px、高 371.03px；单列 310px；顺序「对访客可见 → 公开到期与价格 → 公开节点」。
- 与「版本更新」卡对照：标题 14px/500/18.9px、说明 12px/19.2px、卡片内边距 16px、网格 gap 20px，全部一致。
- 注释：12px、muted，距上方开关 8px。

English:
- 1440: card 1152×217.75px; columns 550px each, 0px width delta, 0px top delta; switch top delta 0; both column heights 69.28px.
- 390: card 342×371.03px; one 310px column; order “Visible to visitors → pricing → public nodes”.
- Compared with the Updates card: title 14px/500/18.9px, description 12px/19.2px, card padding 16px, grid gap 20px — all identical.
- Notes: 12px muted, 8px below the switch.

备注 / Note：需求里提到的 `gap-6/8` 与「与版本更新卡网格 gap 一致」冲突；这里沿用 `SettingsGroup` 的 20px，以保证同页卡片几何一致。
The requested `gap-6/8` conflicts with “same grid gap as the Updates card”; this card keeps `SettingsGroup`’s 20px so the two cards match geometrically.
