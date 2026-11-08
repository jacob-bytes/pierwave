# PierWave UI/UX 审计 / UI/UX Audit

- 审计对象：`http://127.0.0.1:8795`（admin / alice 两个角色；普通用户 alice）。
- 浏览器：系统 Chrome + Puppeteer；视口 390×844、768×1024、1440×900；`pierwave.theme=dark|light`，主审计语言 `zh-CN`，另做 390px 英文抽查。
- 覆盖：19 条路由（17 条登录态 + `/login`、`/status`）× 3 视口 × 2 主题，共 **114 次整页加载**；149 张证据截图；原始 JSON 见文末。
- 排序：以下按「修复收益 ÷ 成本」排序，不按发现顺序。每条都给出实测值；未发现问题的检查项列在「通过项」，没有为凑数编造问题。

## 结论摘要（严重 / 中等 / 轻微 各几条）

- **严重（P0）：2 条**——`/me`、`/chains` 整页白屏。普通用户的唯一入口 `/me` 不可用，属于发布阻断。
- **中等（P1）：5 条**——移动/平板表格裁切、英文设置页 Tab 被裁掉、焦点环对比度不足、Tab 面板焦点不可见、表单必填/错误缺少语义关联。
- **轻微（P2）：7 条**——密码可见性切换缺失、订阅页 10 个小于 24×24 的链接、图表仅靠颜色且 SVG 无名称、移动导航无显式关闭、时间列未使用等宽数字、告警保存按钮视觉权重不一致、状态页汇总卡可点击但无提示。

**共 14 条。建议先修 5 条**

1. `/me` 白屏——普通用户完全无法使用产品。
2. `/chains` 白屏——管理员无法查看/管理转发链。
3. 移动/平板表格裁切——手机和平板上关键列与操作不可见。
4. 焦点环对比度——一处全局样式可同时修复全站键盘可用性。
5. 英文设置页 Tab 裁切——一处布局 + `scrollIntoView` 即可恢复英文移动端设置导航。

### 通过项（避免误以为漏查）

- **图标按钮命名通过**：14 个有内容的登录页（`/chains`、`/me` 因白屏除外）+ `/login`、`/status` 在 1440/390 两档共扫描 0 个「只有图标且无 `aria-label`/`title`/`sr-only`/关联 `<label for>`」的控件。告警事件复选框的名称来自 `<label for>`，不是无名称按钮。
- **文档级横向溢出通过**：390px 下 19 条路由全部 `document.scrollWidth === innerWidth === 390`；768/1440 也无页面级溢出（内部表格滚动另见 P1-4，不改变本项结论）。
- **CLS 通过**：114 次加载的 `layout-shift` 总和均为 0.000；对 7 个关键视图人为延迟 API 800ms 后仍为 0.000（骨架屏与最终内容高度一致）。未记录到任何 layout-shift 元素。
- **焦点顺序通过**：Tab 顺序为侧栏 → 页头 → 主内容；表格内按行从左到右；无焦点陷阱；无 sticky 页头遮挡焦点（`covered=false`）。
- **Toast 自动消失通过**：复制成功 toast 实测 3.26s 消失，登录失败 toast 约 3.1s；配置为 3000ms，落在 3–5s。
- **破坏性二次确认通过**：删除用户弹出 `role=alertdialog`（`aria-labelledby`/`aria-describedby` 均存在），Escape 可取消，取消后行数不变。
- **提交中/成功反馈通过**：登录按钮提交时 `disabled=true`、文案变「登录中…」、有 spinner（实测 507ms 时）；设置页 SaveBar 同样有 spinner；复制/保存/删除成功均有 toast。
- **数据列等宽通过（时间列除外）**：流量、负载、倍率类数据均使用 `font-mono` 或 `tabular-nums`；`servers` 负载实测 `font-variant-numeric: tabular-nums`，`users`/`subscriptions` 的 `已用 / 额度` 叶子节点为 `font-mono`。服务器地址为 `font-mono`；审计范围内没有独立端口列（`/chains` 阻断），因此端口项只做到地址级验证。
- **禁用态可辨通过**：禁用登录按钮实测 `opacity: 0.5`、`cursor: default`、不可点击；其他禁用控件使用 shadcn 的 `disabled:opacity-50` + `cursor-not-allowed`。
- **删除图标一致性通过**：套餐、用户、节点、证书、规则模板、出站/转发均使用 `Trash2`，同一概念没有混用 `X`。
- **四态实现通过（局部）**：列表页均有 skeleton / empty / error / 正常四种分支；例外是 P0 的未捕获渲染异常没有全局 ErrorBoundary。

### English summary

- **Critical (P0): 2** — `/me` and `/chains` render a completely blank page. `/me` is the normal user's only screen, so this is release-blocking.
- **Major (P1): 5** — mobile/tablet table clipping, clipped English settings tabs, insufficient focus-ring contrast, invisible tab-panel focus, and form semantics without required/error associations.
- **Minor (P2): 7** — missing password visibility toggles, ten sub-24px links on the subscriptions page, color-only chart plus unnamed chart SVG, no explicit close button in the mobile nav, non-tabular time columns, inconsistent primary/secondary save styling on Alerts, and clickable status summary cards with no affordance.
- **Passed**: icon-button accessible names (0 unnamed), document-level horizontal overflow at 390/768/1440, CLS (0.000 across 114 loads and with 800ms delayed APIs), focus order/sticky occlusion, toast auto-dismiss (3.26s), destructive confirmations, pending/success feedback, numeric alignment for flow/load/addresses, disabled states, delete-icon consistency, and list four-state implementations.

## P0 阻断（影响可用或可访问性）

### P0-1 `/me` 整页白屏：`summary.usage` 为 undefined

- **页面**：`/me`（admin 和 alice 都复现）。
- **元素**：`#root` 为空，`document.body.innerText` 长度为 0；不是空态，也没有错误提示。
- **实测证据**：`Me-DqEpZ7IJ.js` 抛 `TypeError: Cannot read properties of undefined (reading 'status')`；同一时刻 `GET /api/v1/me/summary` 返回 `{"user":...,"packages":[],"traffic":{...},"subscription_url":"..."}`，**没有 `usage`**。截图：[me-admin__390__dark.png](../data/ui-audit/screenshots/me-admin__390__dark.png)、[me-user__390__dark.png](../data/ui-audit/screenshots/me-user__390__dark.png)。
- **为什么是问题**：普通用户 alice 登录后的唯一入口就是 `/me`；整页渲染失败且没有错误边界，用户看到的是纯色空屏，无法判断是加载中、无权限还是故障。
- **建议改法**：用与当前 web 构建同版本的后端重建并重启预览（当前源码 `crates/master/src/routes/me.rs` 已返回 `usage`），同时给路由内容加 ErrorBoundary 并兼容旧字段。

### P0-2 `/chains` 整页白屏：`chain.groups` 缺失

- **页面**：`/chains`（1440、390 均复现）。
- **元素**：`#root` 为空，Tab 焦点数为 0，页面标题仍是「转发链 · PierWave」。
- **实测证据**：`Chains-BTt5zHFx.js` 抛 `TypeError: e is not iterable`；`GET /api/v1/chains` 的 item 只有旧的 `hops` 数组，没有 `groups`，而前端按 `chain.groups` 做展开/排序。截图：[chains__1440__dark.png](../data/ui-audit/screenshots/chains__1440__dark.png)、[chains__390__dark.png](../data/ui-audit/screenshots/chains__390__dark.png)。
- **为什么是问题**：转发链是管理端核心页面之一；白屏期间任何链的查看、启停、编辑、删除都不可达，且用户没有任何可恢复路径。
- **建议改法**：同步后端/前端版本（或先回退到兼容 `hops` 的读取分支），并加路由级 ErrorBoundary 显示「加载失败 + 重试」。

### English — P0

#### P0-1 `/me` is completely blank: `summary.usage` is undefined

- **Page**: `/me` (reproduced as admin and as alice).
- **Element**: `#root` is empty; `document.body.innerText` has length 0. No empty state, no error state.
- **Evidence**: `Me-DqEpZ7IJ.js` throws `TypeError: Cannot read properties of undefined (reading 'status')`; `GET /api/v1/me/summary` returns `{user, packages, traffic, subscription_url}` with **no `usage`**. Screenshots: [me-admin__390__dark.png](../data/ui-audit/screenshots/me-admin__390__dark.png), [me-user__390__dark.png](../data/ui-audit/screenshots/me-user__390__dark.png).
- **Why it matters**: `/me` is the normal user's only screen. A render exception produces a blank page with no recovery path; users cannot tell loading from failure.
- **Fix**: rebuild/restart the preview with a backend matching the current web build (current `me.rs` already returns `usage`), and add a route-level ErrorBoundary plus a legacy-shape fallback.

#### P0-2 `/chains` is completely blank: `chain.groups` is missing

- **Page**: `/chains` (reproduced at 1440 and 390).
- **Element**: `#root` is empty; 0 tab stops; document title is still "转发链 · PierWave".
- **Evidence**: `Chains-BTt5zHFx.js` throws `TypeError: e is not iterable`; `GET /api/v1/chains` returns items with only the legacy `hops` array and no `groups`, while the UI expands/sorts `chain.groups`. Screenshots: [chains__1440__dark.png](../data/ui-audit/screenshots/chains__1440__dark.png), [chains__390__dark.png](../data/ui-audit/screenshots/chains__390__dark.png).
- **Why it matters**: chain management is a core admin feature; while blank, every chain action is unreachable and there is no recovery UI.
- **Fix**: align backend and frontend versions (or read `hops` as a fallback first), and add a route-level ErrorBoundary with a retry action.

## P1 明显影响体验

### P1-1 键盘焦点环对比度不足（约 1.8–2.6:1）

- **页面**：全站；代表样本 `/`（侧栏「概览」）、`/login`（密码框）、`/status`（汇总卡）。
- **元素**：链接的浏览器 outline、输入框/按钮/复选框的 `ring-ring/50` 焦点环、状态页 `role=button` 汇总卡。
- **实测证据**：焦点环普遍是 **50% 透明度**：链接 `outline: oklab(... / 0.5) auto 1px`；输入框 `box-shadow ... / 0.5 3px`；汇总卡 `ring-ring/40`。对实际像素取样：深色侧栏链接 **2.08:1**、亮色 **2.37:1**；深色输入框 **2.20:1**、亮色 **2.63:1**；状态汇总卡深色 **1.82:1**、亮色 **2.25:1**。按钮另有 1px 实色内边（6.26–8.30:1），但主导的 3px 外环仍只有约 2.3:1。WCAG 2.2 SC 2.4.11 要求至少 3:1。证据：[focus-nav-link__1440__dark.png](../data/ui-audit/screenshots/focus-nav-link__1440__dark.png)、[focus-login-input__1440__dark.png](../data/ui-audit/screenshots/focus-login-input__1440__dark.png)、[focus-status-card__1440__dark.png](../data/ui-audit/screenshots/focus-status-card__1440__dark.png)。
- **为什么是问题**：键盘用户和低视力用户很难定位焦点，尤其在长表格和多卡片页面上；这是全站性的可访问性缺陷，不是个别页面的视觉偏好。
- **建议改法**：把 `outline-ring/50` / `ring-ring/50` 改为全不透明（或 ≥70%）的 2px `outline`/`ring`，并加 `outline-offset-2`，然后重跑本报告的像素对比脚本。

### P1-2 英文设置页 Tab 被裁切，当前 Tab 不可见

- **页面**：`/settings?tab=general|security|certificates`，390px，`pierwave.locale=en`。
- **元素**：`[data-slot="tabs-list"]` 及其 `[role="tab"]`。
- **实测证据**：容器 `clientWidth=342`、`scrollWidth=432`、`justify-content:center`、`scrollLeft=0`。`General` 的 `x=-63.1`（完全在视口左侧外），`Certificates` 的 `x=363.1..453.1`（只有 3px 可见）；切到 `?tab=certificates` 后 `scrollLeft` 仍为 0，当前 Tab 也在屏幕外。中文同页 `scrollWidth=349`，仅轻微裁切。截图：[en-settings-general__390__dark.png](../data/ui-audit/screenshots/en-settings-general__390__dark.png)。
- **为什么是问题**：英文手机用户在设置页看不到「General」，也看不到当前所在的「Certificates」；`overflow-x:auto` 在 `justify-center` 下把两端内容裁到负坐标，左侧内容无法通过滚动到达。
- **建议改法**：把 Tab 列表改为 `justify-start`（或允许换行），并在 Tab 变化后对当前 trigger 调 `scrollIntoView({ inline: "nearest" })`。

### P1-3 Tab 面板获得焦点时没有任何可见指示

- **页面**：`/logs?tab=events|audit`、全部 `/settings?tab=*`。
- **元素**：`div[data-slot="tabs-content"][role="tabpanel"]`（Radix 的 TabsContent 可聚焦）。
- **实测证据**：从当前 Tab 再按一次 Tab，`document.activeElement` 落在 `role=tabpanel` 的 `div` 上；`getComputedStyle` 为 `outline-style: none; outline-width: 1px; box-shadow: none`，组件类名含 `outline-none`。例如 `/settings?tab=alerts` 中，从当前 Tab 再按一次 Tab 后先落在 `告警通知` 面板上，视觉上没有任何圆环。
- **为什么是问题**：每次切换 Tab 后键盘焦点都会「消失」一次，用户不知道下一次 Tab 会去哪里，也不确定是否已经进入面板内容。
- **建议改法**：给 `TabsContent` 加 `focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2`（全不透明）；如果不需要面板本身聚焦，则显式 `tabIndex={-1}`。

### P1-4 390/768 下 8 个列表页的表格被裁切，关键列与操作不可见

- **页面**：`/servers`、`/users`、`/subscriptions`、`/packages`、`/logs?tab=events`、`/logs?tab=audit`、`/settings?tab=templates`、`/settings?tab=certificates`；`/status` 切到列表视图同样受影响。
- **元素**：`div[data-slot="table-container"]`（`overflow-x:auto`），以及 `/logs?tab=audit` 的筛选 TabsList。
- **实测证据**：390px 下容器宽度 342px，但 `scrollWidth` 分别为 servers **780**、users **980**、subscriptions **1000**、packages **880**、logs events **760**、logs audit **980**、templates **760**、certificates **820**；768px 下容器 480px，上述表格仍为 760–1000px。1440px 下全部消失（表格完整显示）。`/users` 在 390px 只看到「用户 / 角色 / 状态」3 列，操作列在 x≈1347（视口外）；`/subscriptions` 只看到约 2.5 列。抽查 `/users` 的 `hasGradient=false`，没有滚动阴影/提示，macOS 上滚动条默认不可见。截图：[users__390__dark.png](../data/ui-audit/screenshots/users__390__dark.png)、[servers__768__dark.png](../data/ui-audit/screenshots/servers__768__dark.png)、[status__list-view__390__dark.png](../data/ui-audit/screenshots/status__list-view__390__dark.png)。
- **为什么是问题**：用户第一眼看到的是被切断的表头和半个状态徽章，不知道可以横向滚动；手机/平板上删除、复制、详情等操作默认不可达。`/settings?tab=certificates` 的空态文案也被裁成半句。
- **建议改法**：在 `<768px` 用卡片列表（可复用 `/nodes` 的响应式卡片）或只保留 2–3 个关键列 + 行内「更多」；过渡期至少加 sticky 首/尾列、可见的滚动阴影和「左右滑动」提示。

### P1-5 表单必填与错误缺少语义关联

- **页面**：`/settings?tab=general|security|alerts`、`/login`、新建/编辑用户对话框、修改密码对话框、重置密码对话框。
- **元素**：带 `*` 的输入框、错误提示 `<p role="alert">`、字段 hint。
- **实测证据**：11 个带红色 `*` 的字段（设置页 6、用户表单 2、修改密码 3）全部 `input.required=false` 且 `aria-required` 为空；扫描到的表单字段 `aria-describedby` 数量为 **0**。用户表单空提交后 `#user-username`/`#user-password` 为 `aria-invalid=true`，但错误文本「用户名至少 3 个字符」「密码至少 8 位」只是同级 `<p role="alert">`，没有 id 关联；修改密码三个字段同样 `aria-describedby=null`。截图：[users__new-user-errors__1440__dark.png](../data/ui-audit/screenshots/users__new-user-errors__1440__dark.png)、[change-password__errors__1440__dark.png](../data/ui-audit/screenshots/change-password__errors__1440__dark.png)。
- **为什么是问题**：错误视觉上就近显示，但读屏用户在字段上不会听到「必填」「最多 64 字符」或对应错误；`role=alert` 只在错误插入时全局播报一次，重新聚焦字段后无法复查。
- **建议改法**：让 `FormField` 统一生成 `errorId`/`hintId` 并传给控件 `aria-describedby`，同时把 `required` 或 `aria-required` 传下去；登录页也补上必填标记。

### English — P1

#### P1-1 Focus-ring contrast is insufficient (about 1.8–2.6:1)

- **Pages**: site-wide; examples `/`, `/login`, `/status`.
- **Elements**: link outlines, input/button/checkbox `ring-ring/50` focus rings, and the public status `role=button` summary cards.
- **Evidence**: the dominant rings are **50%-alpha**: links use `outline: oklab(... / 0.5) auto 1px`; inputs use `box-shadow ... / 0.5 3px`; cards use `ring-ring/40`. Sampled pixels: dark nav link **2.08:1**, light **2.37:1**; dark input **2.20:1**, light **2.63:1**; status card dark **1.82:1**, light **2.25:1**. Buttons also have a 1px solid inner border (6.26–8.30:1), but the dominant 3px outer ring is still about 2.3:1. WCAG 2.2 SC 2.4.11 requires at least 3:1. Evidence: [focus-nav-link__1440__dark.png](../data/ui-audit/screenshots/focus-nav-link__1440__dark.png), [focus-login-input__1440__dark.png](../data/ui-audit/screenshots/focus-login-input__1440__dark.png), [focus-status-card__1440__dark.png](../data/ui-audit/screenshots/focus-status-card__1440__dark.png).
- **Why it matters**: keyboard and low-vision users cannot reliably locate focus, especially in long tables and card grids. This is a global accessibility defect.
- **Fix**: change `outline-ring/50` / `ring-ring/50` to a fully opaque (or ≥70%) 2px outline/ring with `outline-offset-2`, then rerun the pixel-contrast script.

#### P1-2 English settings tabs are clipped and the active tab is off-screen

- **Page**: `/settings?tab=general|security|certificates`, 390px, `pierwave.locale=en`.
- **Element**: `[data-slot="tabs-list"]` and its `[role="tab"]` triggers.
- **Evidence**: container `clientWidth=342`, `scrollWidth=432`, `justify-content:center`, `scrollLeft=0`. `General` is at `x=-63.1` (fully off-screen left) and `Certificates` at `x=363.1..453.1` (only 3px visible); after navigating to `?tab=certificates` the scroll position is still 0, so the active tab is also off-screen. The Chinese version only clips 4px (`scrollWidth=349`). Screenshot: [en-settings-general__390__dark.png](../data/ui-audit/screenshots/en-settings-general__390__dark.png).
- **Why it matters**: English mobile users cannot see or select "General", and cannot see the active "Certificates" tab. With `justify-center`, the left overflow is at negative coordinates and cannot be reached by scrolling.
- **Fix**: use `justify-start` (or allow wrapping) and call `scrollIntoView({ inline: "nearest" })` on the active trigger after a tab change.

#### P1-3 The tab panel receives focus with no visible indicator

- **Pages**: `/logs?tab=events|audit`, every `/settings?tab=*`.
- **Element**: `div[data-slot="tabs-content"][role="tabpanel"]` (Radix TabsContent is focusable).
- **Evidence**: pressing Tab once more from the active tab moves `document.activeElement` to the tab panel; computed style is `outline-style: none; outline-width: 1px; box-shadow: none` and the class list contains `outline-none`. In `/settings?tab=alerts`, focus item 4 is the "告警通知" panel with no visible ring.
- **Why it matters**: keyboard focus appears to vanish on every tab switch, so users do not know where they are or where the next Tab will go.
- **Fix**: add `focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2` (opaque) to `TabsContent`, or remove it from the tab order with `tabIndex={-1}` if focus on the panel is not intended.

#### P1-4 Tables are clipped on 390/768; key columns and actions are off-screen

- **Pages**: `/servers`, `/users`, `/subscriptions`, `/packages`, `/logs?tab=events`, `/logs?tab=audit`, `/settings?tab=templates`, `/settings?tab=certificates`; `/status` in list view is affected too.
- **Element**: `div[data-slot="table-container"]` (`overflow-x:auto`), plus the audit filter TabsList.
- **Evidence**: at 390px the container is 342px wide while `scrollWidth` is servers **780**, users **980**, subscriptions **1000**, packages **880**, logs events **760**, logs audit **980**, templates **760**, certificates **820**. At 768px the container is 480px and the same tables remain 760–1000px. At 1440px all fit. `/users` shows only 3 of 7 columns at 390px and the action column sits at x≈1347 (outside the viewport); `/subscriptions` shows about 2.5 columns. On `/users`, `hasGradient=false`: there is no scroll shadow or hint, and macOS hides the scrollbar by default. Screenshots: [users__390__dark.png](../data/ui-audit/screenshots/users__390__dark.png), [servers__768__dark.png](../data/ui-audit/screenshots/servers__768__dark.png), [status__list-view__390__dark.png](../data/ui-audit/screenshots/status__list-view__390__dark.png).
- **Why it matters**: the first impression is a cut-off header and a half-visible badge, with no clue that horizontal scrolling exists. On phones/tablets, delete, copy and detail actions are unreachable by default. The empty-state copy in `/settings?tab=certificates` is also cut mid-sentence.
- **Fix**: below 768px use a card list (as `/nodes` already does) or keep 2–3 key columns plus a row "More" menu; as an interim step add sticky first/last columns, a visible scroll shadow and a "swipe" hint.

#### P1-5 Required and error semantics are missing from forms

- **Pages**: `/settings?tab=general|security|alerts`, `/login`, New/Edit User dialog, Change Password dialog, Reset Password dialog.
- **Elements**: inputs marked with `*`, error `<p role="alert">`, field hints.
- **Evidence**: all 11 fields with a red `*` (6 settings, 2 user form, 3 change-password) have `input.required=false` and empty `aria-required`; the scanned forms have **0** `aria-describedby`. After an empty submit in the user dialog, `#user-username` / `#user-password` have `aria-invalid=true`, but the errors ("用户名至少 3 个字符", "密码至少 8 位") are sibling `<p role="alert">` elements with no id association; the three change-password fields also have `aria-describedby=null`. Screenshots: [users__new-user-errors__1440__dark.png](../data/ui-audit/screenshots/users__new-user-errors__1440__dark.png), [change-password__errors__1440__dark.png](../data/ui-audit/screenshots/change-password__errors__1440__dark.png).
- **Why it matters**: errors are visually close, but screen-reader users do not hear "required", the hint, or the field error when they focus the control; `role=alert` announces once when inserted but cannot be re-read later.
- **Fix**: have `FormField` generate `errorId`/`hintId`, pass them to the control as `aria-describedby`, and propagate `required` / `aria-required`; add required markers to the login form too.

## P2 打磨项

### P2-1 密码字段没有可见性切换

- **页面**：`/login`、`/users` 新建/编辑用户、修改密码、重置密码。
- **元素**：6 个 `input[type=password]`。
- **实测证据**：登录表单里只有提交按钮，`passwordToggle=[]`；新建用户、修改密码对话框同样 `passwordToggles=[]`。全站唯一带眼睛按钮的是告警页的 Bot Token（`aria-label=显示/隐藏 Bot Token`，`aria-pressed`）。
- **为什么是问题**：用户无法核对长密码或粘贴结果，输错只能重来；登录页尤其容易因大小写/输入法失败。
- **建议改法**：抽一个 `PasswordInput`（或复用告警页的模式），统一加眼睛按钮、`aria-label` 与 `aria-pressed`。

### P2-2 `/subscriptions` 有 10 个小于 24×24 的点击目标

- **页面**：`/subscriptions`，390px。
- **元素**：规则模板徽章链接 `<a data-slot="badge">`（58×20，最长 94×20）与订阅 URL 链接 `a.block.max-w-[220px].truncate`（182.5×16）。
- **实测证据**：每行 2 个，共 5 行 = 10 个；高度 20px 或 16px，均小于 24px。作为对照，行内 checkbox 的原生 rect 虽然是 16×16，但 `::after` 把命中区扩展到 40×32，实测 `elementFromPoint` 仍命中 checkbox，因此**没有**把它们算作失败。
- **为什么是问题**：手指点击 16–20px 高的链接容易点空或误触相邻控件；订阅链接是高频操作。
- **建议改法**：给这两类链接加 `min-h-6` / `py-1`，或把整行/整格设为点击区域。

### P2-3 流量图仅靠颜色区分上下行，且图表 SVG 无可访问名称

- **页面**：`/`（`/me` 因 P0-1 无法验证）。
- **元素**：`recharts` 柱状图、图例、`svg.recharts-surface`。
- **实测证据**：图例「下行/上行」存在，hover tooltip 正常（文本为「2026-11-03 / 下行 243 MB / 上行 32 MB / 计费流量 275 MB」），Y 轴刻度带 `B/MB` 单位，X 轴为日期。但两根柱子的 fill 只有 `var(--primary)` 与 `var(--muted-foreground)`，没有 pattern/纹理；内层 `svg` 是 `role=application`、可聚焦、accessible name 为空，键盘聚焦后 tooltip 不会出现。截图：[overview__chart-tooltip__1440__dark.png](../data/ui-audit/screenshots/overview__chart-tooltip__1440__dark.png)。
- **为什么是问题**：色盲用户只能靠颜色和堆叠位置区分上下行；键盘/读屏用户拿不到按天的数值，且会聚焦到一个没有名字的 application。
- **建议改法**：给柱子加纹理/直接标注，给图表提供 visually-hidden 数据表或可聚焦柱；把内层 SVG 设为 `aria-hidden`/`focusable=false`，或给它一个完整名称。

### P2-4 移动端导航抽屉没有显式关闭按钮

- **页面**：`/`，390px，点击「打开导航」后。
- **元素**：`SheetContent`（`showCloseButton={false}`）。
- **实测证据**：抽屉内 10 个链接高度均为 32px；`explicitClose=false`，没有「关闭」按钮或 X；只能点右侧遮罩或按 Escape。截图：[overview__mobile-nav__390__dark.png](../data/ui-audit/screenshots/overview__mobile-nav__390__dark.png)。
- **为什么是问题**：触屏用户没有 Escape，未必知道点遮罩可关闭；首次使用者容易卡在导航里。
- **建议改法**：打开 `showCloseButton`，或在抽屉底部加一个明确的「关闭」按钮。

### P2-5 时间列没有使用等宽数字

- **页面/列**：`/logs?tab=events` 时间、`/logs?tab=audit` 时间、`/users` 创建时间、`/servers` 最后心跳、`/settings?tab=templates` 更新时间。
- **实测证据**：这些单元格的 `font-variant-numeric` 为 `normal`，也没有 `font-mono`；值是「5 小时前」「3 天前」等相对时间。对比之下，`/servers` 负载、`/users` 与 `/subscriptions` 的已用/额度、`/packages` 的额度/倍率/周期均为 `font-mono` 或 `tabular-nums`。
- **为什么是问题**：多行时间列的字符宽度不一致，扫读和纵向比较略费劲；严格按本审计的「时间列也用等宽数字」标准应补齐。
- **建议改法**：给时间单元格加 `tabular-nums`；如果仍用相对时间，至少让数字部分等宽。

### P2-6 告警设置的保存按钮视觉权重与其他设置页不一致

- **页面**：`/settings?tab=alerts`。
- **元素**：`保存告警设置` 按钮。
- **实测证据**：该按钮 `data-variant="secondary"`、高 32px；`/settings?tab=general` 与 `security` 的保存按钮是 `default`（primary）。同页没有其他 primary 按钮。
- **为什么是问题**：同一个「保存设置」概念在不同 Tab 上视觉权重不同，用户会怀疑告警页的保存是否是次要操作或是否需要额外步骤。
- **建议改法**：统一为 `default` primary，或在告警页明确说明为什么是次要操作。

### P2-7 状态页汇总卡可点击但没有可点击提示

- **页面**：`/status`。
- **元素**：四个 `role="button"` 汇总卡（在线服务器 / 最忙节点 / 累计流量 / 平均可用率）。
- **实测证据**：卡片有 `role=button`、`tabIndex=0`、`title`，但视觉上是普通 KPI 卡；只有桌面 hover 时出现淡环，390px 触屏没有 hover，也没有 chevron/「筛选」文案。按下后才出现 `aria-pressed` 与 ring。截图：[status__390__dark.png](../data/ui-audit/screenshots/status__390__dark.png)。
- **为什么是问题**：多数用户不会想到点 KPI 卡可以筛选服务器列表；该快捷入口在移动端几乎不可发现。
- **建议改法**：在卡片右上角加一个小「筛选」图标/chevron，或把卡片改成明确的 filter chip 样式，并让 accessible name 包含动作（如「筛选：在线服务器」）。

### English — P2

#### P2-1 Password fields have no visibility toggle

- **Pages**: `/login`, New/Edit User, Change Password, Reset Password.
- **Element**: six `input[type=password]` fields.
- **Evidence**: the login form exposes only the submit button (`passwordToggle=[]`); the user and change-password dialogs also return `passwordToggles=[]`. The only eye toggle in the product is the Alerts Bot Token (`aria-label=Show/Hide Bot Token`, `aria-pressed`).
- **Why it matters**: users cannot verify long passwords or pasted values; a typo means starting over, especially on login.
- **Fix**: extract a `PasswordInput` (or reuse the Alerts pattern) with an eye button, `aria-label` and `aria-pressed`.

#### P2-2 Ten click targets on `/subscriptions` are smaller than 24×24

- **Page**: `/subscriptions`, 390px.
- **Elements**: rule-template badge links `<a data-slot="badge">` (58×20, up to 94×20) and subscription URL links `a.block.max-w-[220px].truncate` (182.5×16).
- **Evidence**: two per row × five rows = 10 links, all 16–20px high. By contrast, row checkboxes have a 16×16 rect but their `::after` expands the hit area to 40×32; `elementFromPoint` still returns the checkbox, so they are **not** counted as failures.
- **Why it matters**: 16–20px-high links are easy to miss or mis-tap; subscription links are a frequent action.
- **Fix**: add `min-h-6` / `py-1`, or make the whole cell/row the target.

#### P2-3 The traffic chart relies on color only, and its SVG has no accessible name

- **Page**: `/` (`/me` is blocked by P0-1).
- **Elements**: Recharts bars, legend, `svg.recharts-surface`.
- **Evidence**: the legend ("下行/上行") exists, hover tooltip works ("2026-11-03 / 下行 243 MB / 上行 32 MB / 计费流量 275 MB"), Y ticks carry `B/MB` units, X ticks are dates. But the bars only differ by `var(--primary)` vs `var(--muted-foreground)` and have no pattern; the inner `svg` is `role=application`, focusable, with an empty accessible name, and keyboard focus does not reveal the tooltip. Screenshot: [overview__chart-tooltip__1440__dark.png](../data/ui-audit/screenshots/overview__chart-tooltip__1440__dark.png).
- **Why it matters**: color-blind users must rely on color and stack position; keyboard/screen-reader users cannot get per-day values and land on an unnamed application.
- **Fix**: add patterns/direct labels, provide a visually hidden data table or focusable bars, and mark the inner SVG `aria-hidden`/`focusable=false` or give it a complete name.

#### P2-4 The mobile navigation drawer has no explicit close control

- **Page**: `/`, 390px, after opening the navigation.
- **Element**: `SheetContent` (`showCloseButton={false}`).
- **Evidence**: ten links are 32px high; `explicitClose=false`; there is no Close button/X. Only the overlay or Escape closes it. Screenshot: [overview__mobile-nav__390__dark.png](../data/ui-audit/screenshots/overview__mobile-nav__390__dark.png).
- **Why it matters**: touch users have no Escape key and may not know the overlay is tappable; first-time users can feel stuck.
- **Fix**: enable `showCloseButton`, or add an explicit "Close" button at the bottom of the drawer.

#### P2-5 Time columns do not use tabular figures

- **Pages/columns**: `/logs?tab=events` time, `/logs?tab=audit` time, `/users` created, `/servers` last heartbeat, `/settings?tab=templates` updated.
- **Evidence**: these cells compute `font-variant-numeric: normal` and are not `font-mono`; values are relative strings such as "5 小时前"/"3 天前". By contrast, server load, users/subscriptions usage, and package quota/ratio/period use `font-mono` or `tabular-nums`.
- **Why it matters**: variable-width time strings make vertical scanning slightly harder; strict application of the audit criterion calls for tabular figures.
- **Fix**: add `tabular-nums` to time cells (and/or render absolute time).

#### P2-6 The Alerts save button has different visual weight from other settings tabs

- **Page**: `/settings?tab=alerts`.
- **Element**: the "保存告警设置" button.
- **Evidence**: `data-variant="secondary"`, height 32px; the General and Security save buttons are `default` (primary). There is no other primary button on the Alerts tab.
- **Why it matters**: the same "save settings" concept has different emphasis, making users wonder whether the Alerts save is secondary or incomplete.
- **Fix**: use `default` primary consistently, or explain why Alerts is intentionally secondary.

#### P2-7 Status summary cards are clickable but look static

- **Page**: `/status`.
- **Elements**: the four `role="button"` summary cards (online servers / busiest server / total traffic / average uptime).
- **Evidence**: they have `role=button`, `tabIndex=0` and `title`, but look like ordinary KPI cards. Only desktop hover shows a faint ring; at 390px there is no hover, no chevron and no "filter" copy. The pressed ring appears only after activation. Screenshot: [status__390__dark.png](../data/ui-audit/screenshots/status__390__dark.png).
- **Why it matters**: most users will not guess that clicking a KPI card filters the server list; on touch, the shortcut is effectively undiscoverable.
- **Fix**: add a small filter icon/chevron, or style the cards as explicit filter chips and include the action in the accessible name (e.g. "Filter: online servers").

## 附：测量方法与原始数据位置

### 环境与覆盖

- 预览：`http://127.0.0.1:8795`；`admin` 与普通用户 `alice` 均通过真实登录页登录；`/login`、`/status` 在未登录上下文测量。
- 每个页面在 390×844、768×1024、1440×900 三档、dark/light 两主题下各加载一次；共 114 次。英文抽查 7 页（390px，dark）。
- 页面状态通过 `localStorage.pierwave.theme` / `pierwave.locale` 在文档加载前注入；截图前等待 `networkidle0`、字体就绪与 1.3–2.1s 渲染稳定。

### 各检查项的方法

- **键盘可达性**：真实 `Tab` 键最多 45 次/页；记录 `document.activeElement` 的选择器、`getBoundingClientRect()`、`outline`/`box-shadow`/`border-color`、`elementFromPoint` 遮挡（`covered`）与 overflow 祖先；焦点环对比度用 deviceScaleFactor=3 截图取样，按 WCAG 相对亮度公式计算。
- **图标按钮命名**：对 `a[href], button, [role=button|checkbox|switch|tab|menuitem], summary, input/select/textarea` 计算 accessible name（`aria-label` → `aria-labelledby` → `title` → 关联 `<label for>` → 文本 → `img[alt]`），并单独检查只含 SVG 的控件。
- **触控目标**：390px 下所有可见可点击元素的 rect；对 `Checkbox` 额外验证 `::after` 命中区（`elementFromPoint`），避免把 16×16 外观但 40×32 命中区的控件误报。
- **横向溢出**：`document.documentElement.scrollWidth` vs `window.innerWidth`；并单独记录 `overflow-x: auto/scroll` 容器的 `clientWidth`/`scrollWidth`，区分页面级溢出与容器内滚动。
- **CLS**：文档创建前注入 `PerformanceObserver({type:'layout-shift', buffered:true})`，过滤 `hadRecentInput`；默认加载与「所有 `/api/*` 延迟 800ms」两种条件都测；用强制插入元素验证观察器确实能捕获 shift。
- **数字对齐**：取表格数字叶子节点的 `font-variant-numeric` 与 `font-family`；同时检查 `font-mono`（等宽数字）与 `tabular-nums`。
- **表单**：检查 `label[for]`/`labels`、`required`、`aria-required`、`aria-invalid`、`aria-describedby`（目标是否存在）、错误是否就近、密码可见性按钮、禁用态样式。
- **图表**：读取图例、轴刻度、`fill`、`pattern`；用鼠标移动到柱中心触发 tooltip；检查内层 SVG 的 `role`/`tabindex`/accessible name。
- **状态反馈**：复制操作触发 toast 并轮询消失时间；登录请求人为延迟 1.2s 观察 pending；打开删除对话框但不确认，检查 `role=alertdialog`、`aria-labelledby/describedby` 与 Escape 取消。
- **一致性**：按 `data-size`/`data-variant` 聚合按钮高度、圆角、padding、gap；检查删除图标。

### 原始数据

| 文件 | 内容 |
|---|---|
| [`raw/audit.json`](../data/ui-audit/raw/audit.json) | 114 次页面加载的完整静态扫描、焦点序列、表格、表单、图表、按钮样式与 CLS（约 5.7MB） |
| [`raw/<slug>__<width>__<theme>.json`](../data/ui-audit/raw/) | 每次加载的单页原始 JSON（命名与截图一致） |
| [`raw/interactions.json`](../data/ui-audit/raw/interactions.json) | 登录 pending/错误、toast、破坏性确认、用户/密码表单、图表 hover、移动导航、表格滚动、慢 API CLS |
| [`raw/page-errors.json`](../data/ui-audit/raw/page-errors.json) | 各页面 `pageerror`、console error 与 4xx/5xx 响应 |
| [`raw/accessible-names.json`](../data/ui-audit/raw/accessible-names.json) | 1440/390 下所有无名称交互元素（结果为空） |
| [`raw/numeric.json`](../data/ui-audit/raw/numeric.json) | 表格数字叶子节点的 `font-variant-numeric` / `font-family` |
| [`raw/en-check.json`](../data/ui-audit/raw/en-check.json) | 390px 英文 7 页的溢出与内部滚动 |
| [`raw/focus-contrast.json`](../data/ui-audit/raw/focus-contrast.json) | 焦点环取样颜色、背景、对比度与方法说明 |

### 截图

- 全量命名：`data/ui-audit/screenshots/<slug>__<width>__<theme>.png`（149 张，含重点态）。
- 关键证据：`users__390__dark.png`、`servers__768__dark.png`、`en-settings-general__390__dark.png`、`focus-nav-link__1440__dark.png`、`focus-login-input__1440__dark.png`、`focus-status-card__1440__dark.png`、`users__delete-confirm__1440__dark.png`、`users__new-user-errors__1440__dark.png`、`change-password__errors__1440__dark.png`、`overview__chart-tooltip__1440__dark.png`、`overview__mobile-nav__390__dark.png`、`status__list-view__390__dark.png`、`subscriptions__toast-visible__1440__dark.png`。
- `data/ui-audit/` 已被仓库 `.gitignore` 的 `/data` 忽略，不会进入提交。

### English — Appendix

- **Environment / coverage**: preview at `http://127.0.0.1:8795`; `admin` and normal user `alice` logged in through the real login form; `/login` and `/status` measured in a logged-out context. Each page was loaded at 390×844, 768×1024 and 1440×900 in dark and light (114 loads total), plus a 390px English spot-check on 7 pages.
- **Keyboard**: real Tab presses up to 45 per page; active element selector, rect, outline/box-shadow/border, `elementFromPoint` occlusion and overflow ancestors were recorded. Ring contrast was sampled from 3× screenshots and computed with the WCAG relative-luminance formula.
- **Names / touch / overflow**: accessible names were computed from `aria-label`, `aria-labelledby`, `title`, associated `<label for>`, text and `img[alt]`; touch targets were measured at 390px with `::after` hit-area verification; page overflow compared `documentElement.scrollWidth` with `innerWidth`, separately from inner `overflow-x:auto` containers.
- **CLS**: a `layout-shift` PerformanceObserver was injected before document creation, ignoring `hadRecentInput`; measured under normal load and with every `/api/*` request delayed by 800ms; a forced shift verified the observer.
- **Raw data / screenshots**: see the table and paths above. `data/ui-audit/` is gitignored and was not committed. No `web/` source was modified during this audit.
