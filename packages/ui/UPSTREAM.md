# 上游组件来源

`packages/ui` 中来自外部 registry 的文件在这里登记，便于按上游 changelog 手动合并（openspec
`add-ui-design-system` design D1）。上游每月发布且常有破坏性改名，因此**复制进仓库、不自动升级**，
每季度对照 changelog 选择性合并，合并后更新下表的「上游月份」。

- Fluid Functionalism：<https://www.fluidfunctionalism.com>，MIT，源码
  <https://github.com/mickadesign/fluid-functionalism>。取 Radix 版：
  `https://www.fluidfunctionalism.com/r/<name>.json`（不带 `base/` 前缀）。
- 拉取方式：`curl` 到临时目录后人工移植，不使用 `shadcn add … --overwrite` 直接写入仓库。

## 统一适配规则

1. `@radix-ui/react-*` 改为 `radix-ui` 统一包的命名导入（`import { Dialog as DialogPrimitive } from 'radix-ui'`）。
2. `@/lib/*`、`@/hooks/*`、`@/components/ui/*` 改为包内相对路径，带 `.ts` / `.tsx` 后缀。
3. 去掉 `"use client"`（TanStack Start 不需要），Biome 格式化。
4. 满足 `exactOptionalPropertyTypes`：可选属性不显式传 `undefined`，改为默认值或条件展开。
5. Biome a11y 规则与上游写法冲突处用 `biome-ignore` 注明原因，不改行为。
6. 每个文件头注明来源与上游月份；上游英文注释保留，模板改动处用中文注释。
7. token 不放在组件里：registry 的 `cssVars` / `css` 并入 `src/styles/globals.css`。

## 文件清单

| 本包文件 | 上游 registry 项 | 上游月份 | 模板改动 |
|---|---|---|---|
| `src/components/button.tsx` | `button` | 2026-11 | 保留模板公开 API（variant `default/destructive/outline/secondary/ghost/link`、size `default/sm/lg/icon`、`asChild`、`buttonVariants`）；新增 Fluid 变体别名 `primary`、`tertiary`，尺寸 `compact`、`icon-compact`、`icon-sm`，`loading`、`leadingIcon`、`trailingIcon`。底色层由内部 span 改为 `::before`，子元素原样输出；强调色由 `--foreground` 改为 `--primary`（预设可换色），悬停 / 按下用 `color-mix` 掺黑加深（上游降不透明度）；焦点环改为 2px 描边加 2px 间隙（上游 1px ring）；destructive 用 `--destructive` 变量而非 Tailwind 红色，底色 /10、悬停 /15（深色 /15、/20）；未移植 `render`、`nativeButton`、`active`；`sm`/`lg` 为模板原有 32px/40px 尺寸 |
| `src/components/dialog.tsx` | `dialog` | 2026-11 | 新增 `closeLabel`（关闭按钮可读名称，上游写死英文）；DialogTitle 加 `font-semibold`（中文回退字体加粗） |
| `src/components/select.tsx` | `select` | 2026-11 | 触发器焦点环改为 2px 描边加 2px 间隙；`error` 文字经 `aria-describedby` 关联触发器 |
| `src/components/scroll-area.tsx` | `scroll-area` | 2026-11 | 仅统一适配规则；CSS 只并入 `scroll-fade` 与细滚动条（限内部滚动容器，页面根保持系统默认，放在 base 层），未并入 `scroll-divider` 与 `::-webkit-scrollbar` 规则 |
| `src/components/fluid-hover-highlight.tsx` | `use-fluid-hover`（附带文件） | 2026-11 | 仅统一适配规则 |
| `src/components/ui-root.tsx` | `fluid-provider` | 2026-11 | 改名 `UiRoot`，参数 `shape`、`density`、`icons`，取值来自 `template.config.ts` 的 `ui` 段；改为受控（上游为初始值），变化即生效 |
| `src/hooks/use-fluid-hover.ts` | `use-fluid-hover` | 2026-11 | 仅统一适配规则 |
| `src/hooks/use-keyboard-nav-gate.ts` | `use-keyboard-nav-gate` | 2026-11 | 仅统一适配规则 |
| `src/hooks/use-touch-primary.tsx` | `use-touch-primary` | 2026-11 | 仅统一适配规则 |
| `src/lib/elevated.tsx` | `elevated` | 2026-11 | 仅统一适配规则 |
| `src/lib/font-weight.ts` | `font-weight` | 2026-11 | 仅统一适配规则 |
| `src/lib/icon-context.tsx` | `icon-context` | 2026-11 | 图标槽位只保留已接入组件用到的 `x`、`chevron-down`、`check`（上游 70 个全部导入，会随 `UiRoot` 进入首屏包）；接入新组件时按上游槽位名补充 |
| `src/lib/omit.ts` | `omit` | 2026-11 | 仅统一适配规则 |
| `src/lib/popup.ts` | `popup` | 2026-11 | 仅统一适配规则 |
| `src/lib/shape-context.tsx` | `shape-context` | 2026-11 | `ShapeProvider` 新增受控 `shape`；rounded 时 `--shape-input-radius` 取 `var(--radius)` |
| `src/lib/size-context.tsx` | `size-context` | 2026-11 | 仅统一适配规则 |
| `src/lib/springs.ts` | `springs` | 2026-11 | 仅统一适配规则 |
| `src/lib/surface-classes.ts` | `surface-classes` | 2026-11 | 仅统一适配规则 |
| `src/lib/surface-context.tsx` | `surface-context` | 2026-11 | 仅统一适配规则 |
| `src/lib/type-scale.ts` | `type-scale` | 2026-11 | 仅统一适配规则 |
| `src/lib/utils.ts` | `utils` | 2026-11 | 保留模板 `cn` 签名；登记类型阶梯类名，不含上游站点专用的 `text-site-*` |
| `src/styles/globals.css` | `tokens`、`surfaces`、`type-scale`、`shape-context`、`scroll-area`、`button`（CSS） | 2026-11 | 语义色取 Fluid 站点 `app/globals.css` 的默认值，基线与预设放在 `@layer base`（brand.css 不分层即可覆盖）；改动：新增 `--primary`（浅 `#171717` / 深 `#f5f5f5`）；`--destructive` 浅色取 red-700（上游 red-500 作文字对比度不足 4.5:1）；`--muted-foreground` 浅 `#6b6b6b` / 深 `#b0b0b0`（上游在 muted 与高层表面上不足 4.5:1）；`--fluid-accent` 浅 `#3b82f6` / 深 `#4f86f7`（焦点环对背景与主按钮 ≥ 3:1）；`--fs-body` 14px（上游 13px）；`--success` 沿用模板原值；`--ring` 指向 `--focus-ring`；新增 `tint` 颜色工具类 |

## 公开接口

`@saas/ui` 只导出组件、`UiRoot` 与类型；`useShape`、`useSize`、`useIcons`、`SizeProvider` 等上下文接口暂不导出
（随上游月度改名），应用经 `UiRoot` 配置。

## 尚未接入

其余 Fluid 组件（Tabs、Dropdown、Tooltip、Checkbox、Switch 等）在 tasks 4.x 中按同样规则逐个接入；
图标库替换（`icons-tabler` 等）与 `use-merge-split` 需要时再接入。
