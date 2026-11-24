# 跨跳服务器占用置灰 / Cross-hop server occupancy

## 中文

新建 / 编辑转发链时，服务器下拉里**已被其它跳或同跳其它成员占用的服务器**置灰并显示原因
（「已在第 N 跳」/「已在第 N 跳第 M 台」），不再让用户选到一个后端必然拒绝的值
（`chain.duplicate_server` / `chain.duplicate_group_member`）。置灰项保留在列表里，
不会让下拉高度跳动；当前成员自己选中的服务器始终可选，否则打不开下拉看当前值。
链模板编辑器（`ChainTemplateFormDialog`）的逐跳服务器多选同样适用。

截图覆盖两种状态 × 1440 / 390 × 深色 / 浅色：

| 状态 | 说明 |
|---|---|
| `hop2-blocked-*` | 第 1 跳选香港-01，第 2 跳下拉展开：香港-01 置灰并标注「已在第 1 跳」，其余 9 台仍可选 |
| `hop2-released-*` | 第 1 跳改选香港-02，第 2 跳的香港-01 恢复可选，香港-02 置灰并标注原因 |
| `template-hop2-blocked-1440-dark` | 模板编辑器：第 1 跳勾香港-01，第 2 跳的香港-01 置灰并说明 |

其他截图：

- `hop2-blocked-1440-dark.png` / `hop2-blocked-1440-light.png`
- `hop2-blocked-390-dark.png` / `hop2-blocked-390-light.png`
- `hop2-released-1440-dark.png` / `hop2-released-1440-light.png`
- `hop2-released-390-dark.png` / `hop2-released-390-light.png`

### 复现 / Reproduce

```bash
# 1) 主控（用预览库副本；脚本会登录 admin，需要已知密码）
sqlite3 data/preview.db ".backup data/chain-server-occupancy-preview.db"
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
PIERWAVE_DB='sqlite://data/chain-server-occupancy-preview.db?mode=rwc' \
  ./target/debug/pierwave-master

# 2) 前端
cd web && npm run dev               # http://localhost:5173

# 3) 截图 + 断言
BASE=http://localhost:5173 node web/screenshots/chain-server-occupancy/shots.mjs
```

> 预览库沿用 `devpass`；如果库里的 admin 密码不是它，脚本会在登录处 401。
> 脚本只读接口、不提交表单，不会往库里写链或模板。

`report.json` 记录每张截图的断言结果：置灰项数量、原因文案、释放后的可选状态等。

## English

When creating or editing a forward chain, servers already used by **another hop or another
member of the same hop** are greyed out in the server dropdown with a reason
(“Used in hop N” / “Used in hop N, member M”), so the UI never offers a value the backend
must reject (`chain.duplicate_server` / `chain.duplicate_group_member`). Disabled items stay
in the list (no layout jump), and the member's own current server always remains selectable,
otherwise the dropdown could not show its current value. The chain template editor
(`ChainTemplateFormDialog`) applies the same rule to its per-hop multi-select.

The shots cover two states × 1440 / 390 × dark / light:

| State | What it shows |
|---|---|
| `hop2-blocked-*` | Hop 1 picked 香港-01; hop 2's dropdown is open: 香港-01 is disabled with “已在第 1 跳”, the other 9 servers stay selectable |
| `hop2-released-*` | Hop 1 switched to 香港-02; hop 2's 香港-01 becomes selectable again and 香港-02 is disabled with the reason |
| `template-hop2-blocked-1440-dark` | Template editor: hop 1 checked 香港-01, hop 2's 香港-01 is disabled with the reason |

`report.json` records the assertion result for every shot: disabled option count, reason copy,
and the released state after changing the earlier hop.

### Backend note / 后端说明

`POST /api/v1/me/chains` **does** run the cross-hop uniqueness checks: it expands the template
into groups and passes them through `resolve_groups`, which calls
`chains::ensure_group_member_servers_unique` and `chains::ensure_chain_servers_unique`
(`crates/master/src/routes/chains.rs:534-538`). Template writes validate the same rules in
`crates/domain/src/chain_templates.rs:99-107`. No backend gap found for this flow.
