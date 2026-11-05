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

## 四、组件策略

- 一律用 `@/components/ui/*`（shadcn 生成），业务里**不手写** Button/Dialog/Toast。
- 组合优先：`Card` + `Table` + `Badge` 拼页面，不新造布局组件。
- 反馈三件套：操作成功用 toast（sonner），失败用 toast + 表单内联错误，破坏性操作用 `AlertDialog` 二次确认。
- 每个列表页必须实现四态：loading（骨架）/ empty（一句话 + 主操作）/ error（可重试）/ 正常。

## 五、文案

- 简体中文，动词开头，不用感叹号，不用「亲」。
- 错误信息说「为什么 + 怎么办」：`Token 已失效，请在服务器页重新生成` 而不是 `错误 401`。
- 数字带单位与千分位；时间优先相对时间（`3 分钟前`），hover 显示绝对时间。
