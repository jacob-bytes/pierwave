# W6 受管文件应用结果 / Managed-file apply result

契约见 `docs/APPLY-STATUS.md`：`partial` 是提交阶段失败、失败点之前的文件
已生效；`failed` 是整体失败；`ok` / NULL 不显示任何应用徽标。

The contract is in `docs/APPLY-STATUS.md`: `partial` means the commit phase
failed after some files were already renamed into place, `failed` is a total
failure, and `ok` / NULL shows no apply badge at all.

## 展示位置 / Placement

- **列表**：徽标在「名称」身份列（名称下一行），不放进「状态」列；因此
  「在线 / 离线」仍由状态列单独表达。`partial` 用 warning，`failed` 用
  destructive。
- **列表 390**：徽标收进移动端卡片的字段（Agent 版本之后），不占名称行。
- **详情**：窄屏「详情」popover 底部有应用结果段（stage + 已生效路径；
  partial 的原始错误折叠）；徽标自身可点击展开，桌面/窄屏都能看完整
  stage、路径与错误原文。
- `ok` / `null`：徽标、字段、详情段都不渲染。

- **List**: the badge sits under the server name in the identity column, never
  in the online/offline status column. `partial` uses warning, `failed` uses
  destructive.
- **390 list**: the badge is a card field (after Agent version), so it never
  squeezes the name.
- **Details**: the narrow-screen details popover ends with an apply-result
  section (stage + effective paths; the raw partial error is collapsed), and
  the badge itself expands to the full stage, paths and verbatim error.
- `ok` / `null`: nothing is rendered.

## 数据 / Fixture

用 W1–W5 的预览库（`/tmp/pw-w15/db.sqlite`）写入三条应用结果，然后启动
新版 master 即可截取。关键字段：

```sql
-- partial（2/3）
UPDATE servers SET
  apply_status='partial',
  apply_error='[agent.apply_files.partial] 受管文件部分生效（partial success），阶段: 提交 rename / commit；已生效 2/3: /etc/pierwave/xray/server.crt, /etc/pierwave/xray/server.key；其余文件未生效、临时文件已清理；失败原因: permission denied',
  apply_version=7,
  apply_partial_json='{"stage":"提交 rename / commit","effective":["/etc/pierwave/xray/server.crt","/etc/pierwave/xray/server.key"],"effective_count":2,"total":3}'
WHERE name='香港-亚太边缘入口-主节点-超长名称用于移动端截断验证';

-- failed（原文展示）
UPDATE servers SET
  apply_status='failed',
  apply_error='dial master: connection refused',
  apply_version=7,
  apply_partial_json=NULL
WHERE name='东京-中转-备用入口';

-- ok / null
UPDATE servers SET apply_status='ok', apply_error=NULL, apply_partial_json=NULL
WHERE name='新加坡-专线-长名称节点-二号';
UPDATE servers SET apply_status=NULL, apply_error=NULL, apply_partial_json=NULL
WHERE name='洛杉矶-美洲-测试节点';
```

```bash
PHASE=before BASE=http://127.0.0.1:8798 node web/screenshots/w6-apply/shots.mjs
PHASE=after  BASE=http://127.0.0.1:8798 node web/screenshots/w6-apply/shots.mjs
```

## 改前 / 改后几何 / Geometry

| 实测 / Measurement | 改前 / Before | 改后 / After |
|---|---|---|
| 列表应用徽标 / list apply badges | 0 | 3（2 partial + 1 failed） |
| partial / failed 行高 / row height | 50.9px | 75.3px |
| ok / null 行高 / row height | 50.9px | 50.9px |
| 状态列 / status cell | 在线 | 在线（未被应用语义占用） |
| 390 卡片名称宽度 / title width | 76.39px | 76.39px（不变） |
| 390 卡片应用字段 / apply field | 无 | 1（在 Agent 版本之后） |
| 页面横向溢出 / page overflow | false | false（doc 390/390，main 390/390） |

## 截图 / Screenshots

- 列表 1440：`before|after/w6-servers-{light,dark}-1440.png`
- 列表 390：`before|after/w6-servers-{light,dark}-390.png`
- partial 展开：`after/w6-partial-popover-{dark,light}-{1440,390}.png`
- failed 原文：`after/w6-failed-popover-{dark,light}-1440.png`
- 窄屏详情（列表 / 详情段）：`after/w6-detail-{dark,light}-390.png`

## 断言 / Assertions

`shots.mjs` 在 after 阶段断言：

- partial 行有 1 个应用徽标，文案为「部分应用（2/3）」；
- 状态列仍是「在线」，应用徽标没有占用在线/离线语义；
- partial 展开含 `提交 rename / commit` 与两条 `/etc/pierwave/xray/...` 路径；
- failed 展开原样含 `dial master: connection refused`；
- ok / null 行没有应用徽标；
- 390 卡片有且仅有一个应用字段，名称宽度与改前一致；
- 390 详情段含 stage 和生效路径；
- 390 页面无横向溢出。

English summary: the badge is separated from the online/offline status column;
`partial` shows `2/3`, stage and the effective paths in an expandable popover;
`failed` shows `apply_error` verbatim; `ok` / NULL render nothing. At 390 the
badge is a card field so the name width is unchanged (76.39px before and after)
and the page has no horizontal overflow.

## 测试 / Tests

`npm test`：663 pass（654 基线 + 9 个新增：8 个 `applyStatus.test.mjs` +
1 个 `tableCells.test.mjs` 的布局/位置断言）；`npx tsc -b --noEmit` 与
`npm run build` 通过。
