# 链路拓扑按「组」呈现 / Chain topology as groups

**中文**：本目录是「链路时延」详情页拓扑这一版的验收截图与机读报告。改动集中在
`web/`：

1. 拓扑节点从「代表成员」改成「组」：顶部 `SOURCE` / `HOP n` / `TARGET`
   + 组级状态点 + `member_count`（如 `2 台`），主文本是组名（组名为空时回退
   代表成员名）。
2. 组内成员：1 台时不渲染列表（保持旧外观）；2 台显示两行；3 台及以上显示
   前两行 + `+N` 折叠。每行带状态点：在线为 2s 呼吸绿点、非 online 为静止
   红点、状态未知为灰点。
3. 节点高度随成员数增加：1 台 56px、2 台 72px、3+ 台 88px；同一行内节点
   垂直居中，连接线仍对准节点高度中心。
4. 组级状态点取最差成员（fault > unknown > online）；契约的组级 `status`
   也参与判定，避免后端只回部分成员时丢掉组级结论。
5. 链级 `estimated: true` 时，只有**两端至少一侧是多成员组**的段在时延后
   加 `≈`，title 追加「多路径估算」；单成员链的段不变。
6. 目标节点仍是虚线框、无状态点、无成员；旧契约（`nodes` 没有 `members`）
   直接回退到单节点外观，节点高度 56px。
7. 链级「估算」徽章的 tooltip 改为解释多路径中位数求和；只有契约显式给
   `estimated: true` 才显示徽章，缺跳保留自己的提示，两者不混用。

**English**: Acceptance screenshots and a machine-readable report for the
chain-latency detail topology. All changes are under `web/`:

1. a topology node now represents a whole group: `SOURCE` / `HOP n` / `TARGET`
   on top, a group status dot and `member_count` (e.g. `2 台`), with the group
   name as the main text (falling back to the representative member name).
2. members: one member renders no list (legacy look), two render two rows, and
   three or more render the first two rows plus a `+N` fold. Every row carries a
   status dot — a 2s breathing green dot when online, a still red dot otherwise,
   and a grey dot when the status is unknown.
3. node height grows with the member count: 56px / 72px / 88px for 1 / 2 / 3+
   members; nodes in one row are vertically centred and the connector stays on
   the row's centre line.
4. the group dot takes the worst member (fault > unknown > online); the
   contract's group-level `status` is folded in as well so a partial member list
   cannot hide a blocked group.
5. when the chain is `estimated: true`, only segments touching a multi-member
   group get `≈` after the latency and a "Multi-path estimate" tooltip; segments
   between single-member nodes are unchanged.
6. the target stays a dashed box with no dot and no members; the legacy contract
   (`nodes` without `members`) falls back to the single-node look at 56px.
7. the chain-level "Estimated" badge tooltip now explains multi-path medians
   ("Multi-path chain, summed from per-hop medians; approximate"); it only
   renders when the contract explicitly sends `estimated: true`, and missing
   hops keep their own separate hint.

## 数据说明 / Data note

数据来自真实主控（`data/preview.db` 的副本 `data/chain-members-preview.db`）。
最新主控已经在 `chains[].nodes[]` 里返回 `members[]` / `member_count`；为了让
一条链同时出现「双成员一在线一离线」和「3+ 成员折叠」，`shots.mjs` 仍然只在
浏览器层替换两条链的 `nodes`（组名、成员、计数、成员状态），并把第三条链的
`members` / `member_count` **剥掉**来模拟旧契约。其余字段——`series`、逐段
`p50` / 窗口丢包、`entry` / `exit`、链状态（`blocked · 大阪-01 离线`）、
`estimated`——全部来自真实接口。

副本里的时延 / 探测样本先整体平移进当前 24h 窗口（`UPDATE ... ts = ts +
54600`，300s 对齐），否则当前窗口没有样本、拓扑边会全部显示「无历史数据」。
注入只影响截图与断言，不改仓库里的 `data/preview.db`。

Data comes from a real controller (a copy of `data/preview.db` at
`data/chain-members-preview.db`). The latest controller already returns
`members[]` / `member_count`; to get one chain that shows both a dual-member
group (one online, one offline) and a 3+ member fold at once, `shots.mjs` still
replaces the `nodes` of two chains at the browser layer (group name, members,
count, member status) and **strips** `members` / `member_count` from a third
chain to simulate the legacy contract. Everything else — `series`, per-segment
`p50` / window loss, `entry` / `exit`, chain status (`blocked · 大阪-01 离线`)
and `estimated` — stays real. The copy's
latency and probe samples were shifted into the current 24h window first
(`UPDATE ... ts = ts + 54600`, aligned to 300s); otherwise the topology edges
would all show "No history". The injection affects screenshots and assertions
only and never touches the checked-in `data/preview.db`.

## 文件 / Files

- `topology-mixed-{1440,390}-{dark,light}.png`：同屏覆盖单成员（SOURCE）、
  双成员一在线一离线（HOP 1）、3+ 成员折叠（HOP 2，两行 + `+1`）与目标节点。
- `topology-mixed-390-{dark,light}-group.png`：390 卡片内横向滚到 3+ 成员组，
  展示两行成员与 `+1` 折叠。
- `topology-mixed-390-{dark,light}-end.png`：390 卡片内横向滚到末端，展示
  目标虚线框。
- `topology-estimated-{1440,390}-{dark,light}.png`：`estimated` 链上双成员组
  两侧的段显示 `≈`，单成员组到目标的最后一段不带 `≈`。
- `topology-legacy-{1440,390}-{dark,light}.png`：旧契约（无 `members`）仍是
  单节点外观，56px 高、无成员行、无 `2 台`。
- `report.json`：52 项断言（标签、高度、成员行数与 `member_count` 一致、
  `+N`、成员点颜色 / 呼吸、组级最差点、目标虚线、`≈` 与 tooltip、阻断徽章、
  估算徽章的 tooltip 文案与「缺失时不显示」、1440 无横向溢出、390 卡片内滚动
  且整页不溢出）。
- `shots.mjs`：生成上面全部截图与 `report.json` 的脚本。

## 实测 / Measured

| 项目 / Item | 结果 / Result |
|---|---|
| 断言 / assertions | 52 / 52 通过，0 失败 |
| 节点高度 / node heights | SOURCE 56、HOP 1 72、HOP 2 88、HOP 3 56、TARGET 56 |
| 成员行 / member rows | HOP 1 两行 = 2 台；HOP 2 两行 + `+1` = 3 台；单成员 0 行 |
| 成员点颜色 / member dots | 绿 `oklch(0.73 0.16 152)` 呼吸 / 红 `oklch(0.62 0.2 25)` 静止 / 灰 `oklch(0.7 0.015 285)` 静止（dark） |
| 组级状态 / group tone | HOP 1、HOP 2、HOP 3 红；SOURCE 绿；目标无点 |
| 链状态徽章 / badge | `blocked` + `阻断 · 大阪-01 离线` |
| 估算标记 / ≈ | 双成员组两侧段 `15 ms ≈`、`23.5 ms ≈`；最后一段 `6 ms` 无 ≈ |
| 估算徽章 tooltip | `多路径链路，按各跳中位数求和，为估算值`；`estimated=false` 的链不渲染徽章 |
| 横向溢出 / overflow | 1440 拓扑 0px；390 拓扑卡片内滚动 538px、整页 0px |
| 旧契约 / legacy | 3 个节点全部 56px、0 成员行 |
| 单测 / web tests | `npm test` 1106 通过（基线 1093 + 新增 13） |
| 类型 / types | `npx tsc -b --noEmit` 通过 |
| 构建 / build | `npm run build` 通过 |

## 复现 / Reproduce

```bash
# 1. 复制预览库并把样本平移进当前窗口
sqlite3 data/preview.db ".backup data/chain-members-preview.db"
#    delta = floor((now - max(ts)) / 300) * 300，两张表用同一个 delta
#    本机实测 delta = 54600

# 2. 起主控 + 前端
PIERWAVE_ADMIN_PASSWORD=devpass PIERWAVE_ADDR=127.0.0.1:8787 \
PIERWAVE_DB='sqlite://data/chain-members-preview.db?mode=rwc' \
  ./target/debug/pierwave-master
cd web && npm run dev

# 3. 生成截图与报告
node web/screenshots/chain-members/shots.mjs
```
