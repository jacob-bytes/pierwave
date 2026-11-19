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
| border | `1 0 0 / 8%`（`--border` 变量里表达） | 1px 分隔，不用阴影 |
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
- 卡片用 1px border，**不用 box-shadow**；只有 Dialog / Dropdown 允许一层轻阴影（`shadow-lg/40`）。
- 间距走 4 的倍数，页面内边距 24px，卡片内 16–20px。

## 三、动效（「灵动」的唯一来源）

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

## 四、组件策略

- 一律用 `@/components/ui/*`（shadcn 生成），业务里**不手写** Button/Dialog/Toast。
- 组合优先：`Card` + `Table` + `Badge` 拼页面，不新造布局组件。
- 反馈三件套：操作成功用 toast（sonner），失败用 toast + 表单内联错误，破坏性操作用 `AlertDialog` 二次确认。
- 每个列表页必须实现四态：loading（骨架）/ empty（一句话 + 主操作）/ error（可重试）/ 正常。

## 五、文案

- 简体中文，动词开头，不用感叹号，不用「亲」。
- 错误信息说「为什么 + 怎么办」：`Token 已失效，请在服务器页重新生成` 而不是 `错误 401`。
- 数字带单位与千分位；时间优先相对时间（`3 分钟前`），hover 显示绝对时间。
