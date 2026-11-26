# 输入模态焦点环 · Input-modality focus rings

**中文** —— 点击概览的二级子 tab（例如「转发模板」）后不再出现 2px 蓝框；
键盘 Tab / 方向键导航仍然显示焦点环。

## 做法 / How it works

- `web/src/lib/inputModality.ts` 维护 `<html data-input="pointer|keyboard">`：
  - `pointerdown`（任意指针按下，捕获阶段）→ `pointer`；
  - `keydown`（Tab / 方向键 / 输入字符等，捕获阶段）→ `keyboard`；
  - 初始视为 `pointer`（`index.html` 首帧就带 `data-input="pointer"`）。
- `index.css` 在统一焦点环规则旁新增：

  ```css
  html[data-input="pointer"] :focus-visible {
    outline: none;
    --tw-ring-shadow: 0 0 #0000;
    --tw-inset-ring-shadow: 0 0 #0000;
  }
  ```

  指针模态下 outline 与 Tailwind 的 ring（box-shadow）一起收起；键盘模态下
  这条规则不匹配，原有 2px 焦点环照常生效。输入框同样适用，不会被误伤。
- 监听在应用根组件 `App` 挂载时注册一次、卸载时移除。登录页与公开状态页
  不挂 `AppShell`，但共用这套焦点环规则；挂到路由根才能覆盖登录表单。

## 验收结果 / Acceptance

`report.json` 是脚本实测的原始数据（1440 × 亮 / 暗）：

| 场景 | `data-input` | `:focus-visible` | `outline-style` | 结果 |
|---|---|---|---|---|
| 点击「转发模板」后（暗） | `pointer` | `true` | `none` | 无蓝框 |
| 再按 Tab 后（暗） | `keyboard` | `true` | `solid` / 2px | 焦点环出现 |
| 点击「转发模板」后（亮） | `pointer` | `true` | `none` | 无蓝框 |
| 再按 Tab 后（亮） | `keyboard` | `true` | `solid` / 2px | 焦点环出现 |
| 登录用户名输入框，鼠标点击 | `pointer` | `true` | `none` | 无蓝框、ring 全透明 |
| 登录用户名输入框，键盘 Tab 回来 | `keyboard` | `true` | `solid` / 2px | 焦点环出现 |

截图 / Screenshots:

| 文件 | 内容 |
|---|---|
| `no-ring-after-click-1440-dark.png` | 暗色，点击「转发模板」后无焦点环 |
| `ring-after-tab-1440-dark.png` | 暗色，键盘 Tab 回到子 tab 后 2px 焦点环 |
| `no-ring-after-click-1440-light.png` | 亮色，点击后无焦点环 |
| `ring-after-tab-1440-light.png` | 亮色，键盘 Tab 后焦点环 |

复现 / Reproduce:

```bash
cd web
npm run build
node screenshots/input-modality/shots.mjs
```

脚本用 Playwright 直接服务 `web/dist` 并在浏览器里 mock API，不需要主控或数据库。
断言失败会打印页面可见文本并保存 `_debug.png`。

**English** — Clicking an Overview sub-tab (e.g. “Templates”) no longer leaves a
2px blue focus ring, while keyboard navigation keeps its focus indicator.

## How it works / 做法

- `web/src/lib/inputModality.ts` keeps `<html data-input="pointer|keyboard">`:
  - `pointerdown` (any pointer press, capture phase) → `pointer`;
  - `keydown` (Tab / arrows / typed characters, capture phase) → `keyboard`;
  - the initial state is `pointer` (`index.html` ships `data-input="pointer"`).
- `index.css` adds, next to the global focus-ring rule:

  ```css
  html[data-input="pointer"] :focus-visible {
    outline: none;
    --tw-ring-shadow: 0 0 #0000;
    --tw-inset-ring-shadow: 0 0 #0000;
  }
  ```

  In pointer mode both the outline and Tailwind's ring (a box-shadow) are
  cleared. In keyboard mode the rule does not match, so the existing 2px focus
  ring still applies. Text inputs follow the same rule and are not harmed.
- The listener is registered once when the app root `App` mounts and removed on
  unmount. The login and public status pages do not mount `AppShell` but share
  the same focus-ring rules, so registering at the router root is what covers
  the login form.

## Acceptance / 验收结果

`report.json` holds the raw headless measurements (1440, light/dark):

| Scenario | `data-input` | `:focus-visible` | `outline-style` | Result |
|---|---|---|---|---|
| Click “Templates” (dark) | `pointer` | `true` | `none` | no blue frame |
| Then press Tab (dark) | `keyboard` | `true` | `solid` / 2px | ring shown |
| Click “Templates” (light) | `pointer` | `true` | `none` | no blue frame |
| Then press Tab (light) | `keyboard` | `true` | `solid` / 2px | ring shown |
| Login username input, mouse click | `pointer` | `true` | `none` | no ring; shadow layers transparent |
| Login username input, keyboard Tab back | `keyboard` | `true` | `solid` / 2px | ring shown |

See the screenshot table above. Regenerate everything with:

```bash
cd web
npm run build
node screenshots/input-modality/shots.mjs
```

The script serves `web/dist` directly and mocks the API in the browser; no
master or database is required. On assertion failure it prints the visible page
text and saves `_debug.png`.
