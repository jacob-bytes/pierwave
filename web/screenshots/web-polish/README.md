# Web polish：六项整改的改前 / 改后证据

Six-item web polish: before/after evidence. 本轮只改 `web/`。截图为 Playwright
（headless Chrome）在 1440×900 / 390×844、`deviceScaleFactor=1` 下拍摄；数据由
`seed.mjs` 写入本地 `data/web-polish.db`，不触碰产品库。

This pass only touches `web/`. Screenshots come from Playwright (headless Chrome) at
1440×900 / 390×844 with `deviceScaleFactor=1`. `seed.mjs` writes a throwaway local
`data/web-polish.db`; the product database is never touched.

## 复现 / Reproduce

```bash
# 1) master（本地临时库，admin/devpass）
PIERWAVE_DB='sqlite://data/web-polish.db?mode=rwc' \
PIERWAVE_ADMIN_PASSWORD=devpass target/debug/pierwave-master

# 2) vite dev
cd web && npm run dev

# 3) 种数据并截两轮 / seed + capture both phases
node web/screenshots/web-polish/seed.mjs
node web/screenshots/web-polish/shots.mjs before   # 改动前 / before the edits
node web/screenshots/web-polish/shots.mjs after    # 改动后 / after the edits
```

`metrics.json` 是脚本用 `getBoundingClientRect()` / DOM 探针采集的断言数据；
`after` 轮里任一断言失败会直接退出非 0。

`metrics.json` holds DOM/geometry probes. The `after` run exits non-zero if any
assertion fails.

## 1. 登录页整屏光晕 / Login full-screen glow

- 改前：`.auth-glow` 铺满 `inset-0`，页面顶部整片径向渐变。
- 改后：删除整屏层，只在品牌标识行内保留 `240×240` 容器、`190px` 半径的
  `radial-gradient`；页面与 `body` 的 `background-image` 均为 `none`。

| 亮 / light 1440 | 亮 / light 390 | 暗 / dark 1440 | 暗 / dark 390 |
|---|---|---|---|
| [before](before/login-light-1440.png) → [after](after/login-light-1440.png) | [before](before/login-light-390.png) → [after](after/login-light-390.png) | [before](before/login-dark-1440.png) → [after](after/login-dark-1440.png) | [before](before/login-dark-390.png) → [after](after/login-dark-390.png) |

断言：`oldGlowPresent=false`、`glowWidth/Height=240`、`glowBackground` 含
`radial-gradient(190px, …)`、页面容器与 `body` 的 `backgroundImage=none`。

## 2. 概览双 Y 轴 / Overview dual Y axis

- 改前：左轴流量 + 右轴累计（竖排「累计（GB）」），累计线要反向读。
- 改后：只保留左侧流量轴；累计改为图例 chip 显示末值（`累计 582 GB`），
  tooltip 里给「当天累计」（`463 GB`）。

| 改前 / before | 改后 / after |
|---|---|
| [overview](before/overview-light-1440.png) | [overview](after/overview-light-1440.png) |
| [tooltip](before/overview-tooltip-light-1440.png) | [tooltip](after/overview-tooltip-light-1440.png) |

断言：`.recharts-yAxis` 数量 1、无右轴、无竖排累计文案、图例 chip 存在。
暗色与 390 宽度同样采集。

## 3. 空态与页头 CTA 重复 / Duplicate empty + header CTA

- 改前（空库）：servers / packages / chains / chain-templates /
  subscription-templates 各有两个入口（页头 primary + 空态 outline）。
- 改后：空库只保留空态的主操作（primary）；页头同名/同动作入口隐藏。
  有数据时页头仍是 primary。

| 页面 | 空库改前 / before empty | 空库改后 / after empty |
|---|---|---|
| servers | [before](before/empty-servers-light-1440.png) | [after](after/empty-servers-light-1440.png) |
| packages | [before](before/empty-packages-light-1440.png) | [after](after/empty-packages-light-1440.png) |
| chains | [before](before/empty-chains-light-1440.png) | [after](after/empty-chains-light-1440.png) |
| chain templates | [before](before/empty-chain-templates-light-1440.png) | [after](after/empty-chain-templates-light-1440.png) |
| subscription templates | [before](before/empty-subscription-templates-light-1440.png) | [after](after/empty-subscription-templates-light-1440.png) |

有数据 / with data：[servers](after/data-servers-light-1440.png)、
[packages](after/data-packages-light-1440.png)（亮/暗/390 均已采集）。

断言：五个页面空库可见操作按钮均为 1，且该按钮带 `bg-primary`。

## 4. 表格骨架与真实列 / Skeleton vs real columns

- 改前：骨架固定 12 列等宽，1440 下真实表可见 11 列（模式列 2xl 才出现），
  且骨架阶段分组筛选不存在。
- 改后：表头与骨架共用 `src/lib/tableColumns.ts` 的列元数据；骨架复用响应式
  可见性与近似宽度，加载中分组筛选已渲染且为禁用态。

| 亮 / light 1440 | 暗 / dark 1440 | 亮 / light 390 |
|---|---|---|
| [skeleton](after/skeleton-servers-light-1440.png) → [real](after/real-servers-light-1440.png) | [skeleton](after/skeleton-servers-dark-1440.png) → [real](after/real-servers-dark-1440.png) | [skeleton](after/skeleton-servers-light-390.png) → [real](after/real-servers-light-390.png) |

改前对照：[skeleton before](before/skeleton-servers-light-1440.png)（12 个可见 `td`，无筛选）。

断言：骨架总列数 12 == 真实 12；骨架可见列数 11 == 真实 11；
骨架阶段筛选存在且 `disabled=true`。

## 5. 时间展示统一 / Relative time everywhere

- 改前：同一列里 45 天前显示 `2026-10-05`，2 小时前显示 `2 小时前`。
- 改后：`lib/time.ts` 扩展到「N 个月前」；超过一年或未来时间才回退绝对时间。
  可见文本为相对时间，`title` 始终给绝对时间。

| 亮 / light 1440 | 亮 / light 390 | 暗 / dark 1440 |
|---|---|---|
| [before](before/users-light-1440.png) → [after](after/users-light-1440.png) | [before](before/users-light-390.png) → [after](after/users-light-390.png) | [before](before/users-dark-1440.png) → [after](after/users-dark-1440.png) |

断言（after）：45 天前 = `1 个月前`、2 小时前 = `2 小时前`、5 分钟前 = `N 分钟前`；
`title` 仍为 `2026-…`。纯逻辑测试覆盖刚刚 / 分钟 / 天 / 月 / 超一年 / 未来。

## 6. 秘密损坏时的设置页 / Corrupted secrets on Settings

后端已改为 **始终 200**：秘密解不开时在顶层带 `secret_errors`，`items` 里
对应字段为空。截图脚本按下面响应伪造（不再用 400）：

```jsonc
{
  "items": {
    // 坏掉的键对应字段为空
    "telegram_bot_token": "",
    "telegram_bot_has_token": false,
    "webhook_url": "",
    "backup_webdav_password": "",
    "backup_webdav_has_password": false
    // …其余正常设置
  },
  "secret_errors": {
    "keys": ["telegram_bot_token", "backup_webdav_password"]
  }
}
```

- 无 `secret_errors` / `keys` 为空：不显示恢复卡（[正常设置截图](after/settings-healthy-no-card-light-1440.png)）。
- `keys` 非空：专用恢复卡列出无法解密的秘密（可读名称），提供「重新填写」；
  表单可编辑可覆盖，未填写时「保存新值」禁用，填写后可用。
- PATCH 仍可能返回 `settings.secret_overwrite`，恢复卡沿用 `errorText` 的翻译与 toast。

| 改前（旧后端 400，历史） / before | 改后（200 + secret_errors）/ after | 展开表单 / form | 填入新值 / filled |
|---|---|---|---|
| [before](before/settings-secret-error-light-1440.png) | [after](after/settings-secret-error-light-1440.png) | [form](after/settings-secret-error-form-light-1440.png) | [filled](after/settings-secret-error-filled-light-1440.png) |

暗色 1440 与 390 也已采集。`hmac_secret_v1` 目前不会出现在 `keys` 里；
恢复卡仍保留「不可在设置页重填」的分支，防后端将来变化。

## 验证 / Verification

```text
npx tsc -b --noEmit     ✓
npm run build           ✓ (vite 8.3.5)
npm test                ✓ 647 tests, 647 pass
```

新增测试：`lib/tableColumns.test.mjs`（列元数据 / 响应式可见性 / 宽度）、
`lib/settingsSecrets.test.mjs`（无字段 / keys 空 / keys 非空 / 未知键 / 可读名称 /
PATCH 构造）、`lib/time.test.mjs` 扩展（月份 / 超一年 / 未来）。
