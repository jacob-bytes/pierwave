# 视觉与交互方向

不复刻妙妙屋X。基线是 **shadcn/ui（radix-nova 预设）** 的克制感，加一点「有生命」的细节：
动效短、幅度小、只在状态变化时出现。目标观感：像一个 2025 年的专业运维工具，而不是后台模板。

## 一、色彩

全部走 shadcn 的 CSS 变量（`--background` / `--foreground` / `--card` / `--border` / `--muted` / `--ring` / `--primary`），
禁止在组件里写死颜色值。基础色板用 **zinc**，只保留一个强调色：

| 角色 | 取值（oklch） | 用途 |
|---|---|---|
| background | `0.145 0.004 285` | 页面底 |
| card | `0.175 0.005 285` | 卡片 / 表格容器 |
| border | `1 0 0 / 8%`（`--border` 变量里表达） | 1px 分隔；卡片另加极轻落影 |
| muted-foreground | `0.70 0.015 285` | 次要文本 |
| primary | `0.673 0.182 277`（indigo-500 dark） | 主按钮、在线态、焦点环 |
| primary-foreground | `0.257 0.09 281` | primary 上的文字 |
| destructive | `0.62 0.20 25` | 删除、离线、错误 |

规则：**一屏最多一个 primary 按钮**；状态色只有「在线=primary、离线=muted、告警=amber、错误=destructive」四种，不自造颜色。

主题策略：**暗色优先**。`:root` 里保留 shadcn 的浅色默认值（以后接亮色零成本），但 `<html class="dark">` 常开；
所有 token 必须成对写（`:root` / `.dark`），不许只写一半。

## 二、形状与密度

- 圆角 `--radius: 0.625rem`；卡片 12px，按钮/输入 8px，徽章全圆。
- 表格行高 40px，`text-sm`，表头 `text-xs uppercase tracking-wide text-muted-foreground`。
- 卡片用 1px ring（`ring-foreground/10`）+ 极轻落影 `shadow-card`，**不使用更重的阴影**；
  Dialog / Dropdown 仍用一层轻阴影（`shadow-lg/40`）。
- 间距走 4 的倍数，页面内边距 24px，卡片内 16–20px。

**English**: Cards use a 1px ring (`ring-foreground/10`) plus the very light
`shadow-card` elevation — never a heavier shadow. Only Dialog / Dropdown keep a
single `shadow-lg/40` layer.

## 三、字号 / Typography

字号负责第一层主次，但**不是唯一手段**；到 11px 就停止继续缩小，改用颜色与字重
区分层级。全站字阶固定为四档：

| 用途 | 字号 | 说明 |
|---|---|---|
| 图表刻度 / 极密数字标签 | **11px** | 全站下限：任何 UI 文字不得低于 11px |
| 常用辅助信息 | **12px** | 行内元信息、时间戳、说明、图例正文；语义类 `.type-micro` |
| 需要被读的次要数据 | **13px** | 列表第二行、表格非主列数据、详情字段值、空态/错误态正文 |
| 正文 / 表单 label | **14px** | `text-sm`，保持现状，不因密度缩小 |

规则：

1. **最小 11px**：任何 UI 文字不得低于 11px（recharts 刻度可以正好 11px）；
   不接受 8 / 9 / 10px，也不设「极小图例」白名单。
2. **常用辅助信息 12px**：行内元信息、时间戳、说明、图例正文统一 12px；
   密集场景用 `.type-micro`（12px + 0.01em 字距），不要再临时写更小字号。
3. **正文 14px**：正文与表单 label 保持 14px，不缩小。
4. **13px 用于「需要被读的次要数据」**：列表第二行（服务器 IP / 端口 / 分组、
   链路路由与最近样本、转发目标、用户/套餐次要字段）、表格非主列数据
   （心跳时间、版本、延迟等）、详情字段值（最近样本、探测次数、窗口丢包）
   以及空态/错误态正文。图表刻度、图例、Badge 内部文字和表头仍保持 11–12px。
5. **层级靠颜色与字重，不靠继续缩小字号**：低对比用 `text-muted-foreground`，
   强调用 `font-medium` / `text-foreground`，而不是 10px 灰字。

源码级约束：`web/src/components/typeFloor.test.mjs` 扫描 `web/src`，禁止
`text-[8px]` / `text-[9px]` / `text-[10px]` 与 `fontSize: 9|10`；新增字号必须
落在这四档内。放大字号后若列宽 / 折叠标签 / Badge / tooltip 被截断，优先调
列宽与最小宽度，不把字缩回去。

**English**: Type carries the first layer of hierarchy but is **not the only
tool**; stop shrinking at 11px and switch to colour and weight. The scale has
four steps:

| Purpose | Size | Notes |
|---|---|---|
| Chart ticks / very dense numeric labels | **11px** | global floor: no UI text below 11px |
| Common supporting text | **12px** | inline metadata, timestamps, descriptions, legend body; `.type-micro` |
| Secondary data meant to be read | **13px** | list second line, non-primary table data, detail field values, empty/error body |
| Body / form labels | **14px** | `text-sm`, unchanged, never reduced for density |

Rules:

1. **11px minimum**: no UI text below 11px (recharts ticks may be exactly
   11px). 8 / 9 / 10px are not allowed, and there is no "tiny legend" exemption.
2. **12px for common supporting text**: inline metadata, timestamps,
   descriptions and legend body are 12px; use `.type-micro` (12px + 0.01em
   tracking) in dense spots instead of inventing a smaller size.
3. **14px body**: body copy and form labels stay at 14px.
4. **13px for secondary data meant to be read**: list second lines (server
   IP / port / group, chain route and latest sample, forward target, user and
   package secondary fields), non-primary table data (heartbeat time, version,
   latency), detail field values (latest sample, probe count, window loss) and
   empty/error body copy. Chart ticks, legends, text inside badges and table
   headers stay at 11–12px.
5. **Hierarchy through colour and weight, not smaller type**: use
   `text-muted-foreground` for lower contrast and `font-medium` /
   `text-foreground` for emphasis, never 10px grey text.

The source-level guard `web/src/components/typeFloor.test.mjs` scans `web/src`
and rejects `text-[8px]` / `text-[9px]` / `text-[10px]` and `fontSize: 9|10`.
When the larger type truncates a column, fold label, badge or tooltip, widen the
column or its minimum width — do not shrink the text back.

### 画布缩放与字号下限 / Canvas zoom and the type floor

**中文**：拓扑画布（React Flow）默认 **适应窗口**：按内容包围盒 + **24px**
内边距计算缩放并居中，打开时就能看到全部列与行；「适应窗口」按钮与首屏完全
一致。卡片字号以 **100% 为基准**：卡片标题 **13px**，状态、卡片第二行与时延
药丸 **12px**（全站下限仍是 11px），画布缩放后字号按比例显示。缩放范围
**0.4–1.6**（按钮按 25% 整档步进），自适应缩放最低 0.4、最高 100%：内容再大
也只缩到 0.4，内容很小时不放大超过 100%。当自适应缩放 **<0.9** 时，缩放栏旁
显示「已缩小到 X%，可点击 + 放大」的轻提示，界面始终给出当前百分比；因此
**不再承诺默认缩放 ≥0.9**。列间距 **80px**，卡片 **192×64**；画布高度上限
**min(640px, 视口高度 × 0.52)**，避免把弹窗撑到看不见标题。缩到 0.4 仍放不下、
或用户放大后，右侧 / 下方还有内容时画布边缘渐隐并显示「右侧还有 N 列」/
「下方还有内容」，点击平移一屏；渐隐只盖内容，右下角的 React Flow 署名始终
在渐隐之上、保持可读可点。同一竖线超过 **6 个**时延药丸默认隐藏，悬停该竖线
或聚焦药丸才显示。**触屏只保留按钮缩放；Safari 的捏合手势未验证**，不承诺
画布内双指缩放。React Flow 的署名保留，**12px + 中性 muted 灰**（不跟随强调色），
不隐藏，也不低于 11px。

每列顶部有一条 **32px** 高的列头：从顶端 **24px** 处开始、与卡片同宽，卡片从
**56px** 起；列名与台数（目标列写「个」）都在这里给出，折叠时写 `4 / 7 台`。
卡片第二行只保留链数与用户数，不再重复列名（列头已经说明）；aria-label 与
折叠卡 tooltip 仍带列名。列头随画布缩放平移，**不可点击、不可 Tab、不参与高亮**，
右缘 / 下缘提示只按卡片判断。连线宽度 **1.5–4**（按链数），脉冲亮划 = 线宽 × **0.7**
且不粗于线，连接点半径 **2**、描边 **1.2**。

**English**: The topology canvas (React Flow) defaults to **fit to view**: the
zoom is derived from the content bounding box plus a **24px** padding and the
result is centred, so every column and row is visible on open; the "Fit to view"
button behaves exactly like the initial view. Card type is measured at **100%**:
**13px** card titles and **12px** for status, the card's second line and the
latency pill (11px is still the global floor), and it scales proportionally with
the canvas. Zoom is limited to **0.4–1.6** (buttons step in whole 25% steps);
fit stops at 0.4 on the low end and at 100% on the high end, so large graphs
shrink only to 0.4 and small ones never enlarge past 100%. When the fit zoom is
**<0.9**, a lightweight hint next to the zoom bar reads "Zoomed to {percent}%;
use + to zoom in", and the current percentage is always shown — the UI no longer
promises a default **≥0.9**. Columns are **80px** apart with **192×64** cards;
the canvas height is capped at **min(640px, viewport height × 0.52)** so it never
pushes the dialog title off screen. When content still overflows at 0.4, or after
the user zooms in, the right edge fades and shows "{n} more columns" while the
bottom edge shows "More content below"; clicking pans one screen. The fades
cover only the content, so the React Flow attribution in the bottom-right corner
always stays above them and remains readable and clickable. More than **6**
latency pills on one vertical rail are hidden by default and appear on rail hover
or pill focus. **Touch devices keep button zoom only; Safari pinch gestures are
unverified**, so in-canvas two-finger zoom is not promised. The React Flow
attribution stays visible at **12px in neutral muted grey** (never the accent
colour), never hidden, never below 11px.

Each column starts with a **32px** header at y **24px**, the same width as a
card, and cards begin at **56px**. The header carries the column name and the
node count ("targets" on the target column), or `4 / 7 nodes` when folded. The
card's second line keeps only chains and users and no longer repeats the column
name (the header does); the aria-label and the folded-card tooltip still include
it. Headers scale and pan with the canvas, are **not clickable, not tabbable
and never highlighted**, and the right/bottom hints count cards only. Links are
**1.5–4px** wide by chain count, the pulse stroke is **0.7×** the link width and
never wider than the link, and the connection dots are **r 2** with a **1.2**
stroke.

## 四、动效（「灵动」的唯一来源）

时长 150–220ms，`ease-out`，位移不超过 4px。只用在这几处：

1. 页面/卡片进入：`opacity 0→1` + `translateY(4px→0)`，120ms。
2. 行 hover：背景 `bg-muted/40`，80ms。
3. 按钮按下：`scale(0.98)`，100ms。
4. Toast：从右上角滑入 8px，带轻微 spring（sonner 默认即可）。
5. 状态点：在线时 2s 一次的柔和呼吸（`opacity 1→0.55`），离线不动。
6. 骨架屏：shimmer 1.2s 循环。

禁止：整屏渐变、发光、弹跳、超过 300ms 的过渡、滚动视差。
唯一的例外见下（登录页整屏径向光晕）。

### 例外：登录页允许整屏径向光晕 / Exception: full-screen radial glow on the login page

**中文**：`/login` 是唯一允许整屏渐变（同时也就是唯一允许「发光」）的一屏。
使用一到两层 `primary` 低透明度的 `radial-gradient`（`.auth-glow`，`inset-0`），
不引入第二种颜色，不加动画。

- 理由：登录页是用户进入产品的第一印象，需要一层品牌氛围；它是全站唯一
  只承载品牌、不承载信息的页面，渐变不会与数据抢注意力。
- 约束：**只此一处，不得扩散**到控制台或其它页面；光晕层必须
  `pointer-events: none` + `aria-hidden="true"`，不遮挡、不拦截交互；亮/暗
  主题各自取值（暗色不过亮、亮色不过蓝），表单文字与背景对比度不得低于
  4.5:1；`prefers-contrast: more` 下降低不透明度；不新增动画，未来若加动效
  必须尊重 `prefers-reduced-motion`。

**English**: `/login` is the only screen allowed to use a full-viewport gradient
(and therefore the only place where a "glow" is allowed). Use one or two
low-opacity `primary` `radial-gradient` layers (`.auth-glow`, `inset-0`) with no
second color and no animation.

- Why: the login screen is the product's first impression and needs a layer of
  brand atmosphere; it is the only screen that carries brand and no
  information, so the gradient never competes with data.
- Constraints: **this one place only — never spread it** to the console or any
  other page; the glow layer must set `pointer-events: none` and
  `aria-hidden="true"` so it never blocks or intercepts interaction; light and
  dark themes get their own strength (not too bright in dark, not too blue in
  light) and form text must stay at or above 4.5:1 against its background;
  reduce opacity under `prefers-contrast: more`; add no animation, and any
  future motion must respect `prefers-reduced-motion`.

## 五、组件策略

- 一律用 `@/components/ui/*`（shadcn 生成），业务里**不手写** Button/Dialog/Toast。
- 组合优先：`Card` + `Table` + `Badge` 拼页面，不新造布局组件。
- 反馈三件套：操作成功用 toast（sonner），失败用 toast + 表单内联错误，破坏性操作用 `AlertDialog` 二次确认。
- 每个列表页必须实现四态：loading（骨架）/ empty（一句话 + 主操作）/ error（可重试）/ 正常。

## 六、文案

- 简体中文，动词开头，不用感叹号，不用「亲」。
- 错误信息说「为什么 + 怎么办」：`Token 已失效，请在服务器页重新生成` 而不是 `错误 401`。
- 数字带单位与千分位；时间优先相对时间（`3 分钟前`），hover 显示绝对时间。
