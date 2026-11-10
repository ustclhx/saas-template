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
8. 动效按需导入：从 `motion/react` 导入 `m as motion`（JSX 仍写 `<motion.div>`，与上游的差异只在导入行），
   并在组件根节点包 `MotionFeatures`（`src/lib/motion-features.tsx`，LazyMotion + domAnimation）；
   `test/motion-imports.test.ts` 拦截完整 `motion` 导入。需要 layout / 拖拽动画的组件改用 domMax 前先评估包体积。
9. 焦点环统一为 2px 描边加 2px 间隙（`outline-2 outline-offset-2 outline-(--focus-ring)`），上游多为 1px ring。
10. 组件内不写英文默认文案：可读名称、占位文字等由应用按语言传入（见下文「必须传入的多语言文案」）。

## 文件清单

| 本包文件 | 上游 registry 项 | 上游月份 | 模板改动 |
|---|---|---|---|
| `src/components/button.tsx` | `button` | 2026-11 | 保留模板公开 API（variant `default/destructive/outline/secondary/ghost/link`、size `default/sm/lg/icon`、`asChild`、`buttonVariants`）；新增 Fluid 变体别名 `primary`、`tertiary`，尺寸 `compact`、`icon-compact`、`icon-sm`，`loading`、`leadingIcon`、`trailingIcon`。底色层由内部 span 改为 `::before`，子元素原样输出；强调色由 `--foreground` 改为 `--primary`（预设可换色），悬停 / 按下用 `color-mix` 掺黑加深（上游降不透明度）；焦点环改为 2px 描边加 2px 间隙（上游 1px ring）；destructive 用 `--destructive` 变量而非 Tailwind 红色，底色 /10、悬停 /15（深色 /15、/20）；未移植 `render`、`nativeButton`、`active`；`sm`/`lg` 为模板原有 32px/40px 尺寸 |
| `src/components/alert-dialog.tsx` | 无（Fluid 没有 AlertDialog，shadcn `alert-dialog` 补缺） | 2026-11 | 结构与 API 取 shadcn（Radix AlertDialog：Trigger / Content / Header / Footer / Title / Description / Action / Cancel），外观、开合动效与宽度档沿用 `dialog.tsx`；无关闭按钮、点击遮罩不关闭；Action / Cancel 渲染 `Button`（默认 `default` / `outline`，可传 `variant="destructive"`），文字必须由调用方传入；没有 Trigger 的受控用法关闭后把焦点还给打开前的元素（Radix 只还给 Trigger） |
| `src/components/badge.tsx` | `badge` | 2026-11 | 18 个色值移入 globals.css 的 `--badge-*`（组件不写死颜色），`accent` 取 `--fluid-accent`；圆点加 `aria-hidden` |
| `src/components/checkbox.tsx` | `checkbox` | 2026-11 | 静止边框 `--control-border`（上游 `--border` 对背景约 1.4:1，未选中方框是唯一状态标识），悬停加深到正文色；焦点环 2px 描边加间隙；勾选图标加 `aria-hidden` |
| `src/components/dialog.tsx` | `dialog` | 2026-11 | `closeLabel` 必填（显示关闭按钮时；上游写死英文 "Close"），`showCloseButton={false}` 时不需要；DialogTitle 加 `font-semibold`（中文回退字体加粗）；`m as motion` + `MotionFeatures` |
| `src/components/input.tsx` | `input` | 2026-11 | 保留模板公开 API（原生 input 属性与 ref，始终只渲染 `<input>`），新增 `size`（尺寸阶梯，替代原生 `size` 属性）；吸收边框、悬停底色、高度 / 内边距 / 字号阶梯（触屏 16px 防缩放）；焦点除边框加深外加 2px 描边加间隙；未移植文件图标与数字步进按钮（需要新图标槽位与多语言的「增加 / 减少」名称），`type="file"` / `"number"` 保持浏览器原生外观 |
| `src/components/select.tsx` | `select` | 2026-11 | 触发器焦点环改为 2px 描边加 2px 间隙；`error` 文字经 `aria-describedby` 关联触发器；`placeholder` 必填（上游默认英文 "Select…"）；`m as motion` + `MotionFeatures` |
| `src/components/switch.tsx` | `switch` | 2026-11 | 关闭态轨道 `--control-border`（上游 `--accent` 对背景约 1.2:1）；开启态滑块 `--switch-thumb-on`（默认白色，深色预设的浅强调色上改为深色，保证 ≥ 3:1）；焦点环 2px 描边加间隙；减少动态效果时滑块直接落到终点（命令式 `animate()` 不受 MotionConfig 控制）；API 保持上游（`label`、受控 `checked` + `onToggle`，整行可点击、可拖动） |
| `src/components/textarea.tsx` | `textarea` | 2026-11 | 焦点环与 Input 一致（2px 描边加间隙） |
| `src/components/tooltip.tsx` | `tooltip` | 2026-11 | 仅统一适配规则（`m as motion` + `MotionFeatures`）；滑入位移在减少动态效果时由 UiRoot 的 MotionConfig 去掉 |
| `src/components/scroll-area.tsx` | `scroll-area` | 2026-11 | 仅统一适配规则；CSS 只并入 `scroll-fade` 与细滚动条（限内部滚动容器，页面根保持系统默认，放在 base 层），未并入 `scroll-divider` 与 `::-webkit-scrollbar` 规则 |
| `src/components/fluid-hover-highlight.tsx` | `use-fluid-hover`（附带文件） | 2026-11 | 仅统一适配规则（`m as motion` + `MotionFeatures`） |
| `src/components/ui-root.tsx` | `fluid-provider` | 2026-11 | 改名 `UiRoot`，参数 `shape`、`density`、`icons`，取值来自 `template.config.ts` 的 `ui` 段；改为受控（上游为初始值），变化即生效 |
| `src/hooks/use-fluid-hover.ts` | `use-fluid-hover` | 2026-11 | 仅统一适配规则 |
| `src/hooks/use-keyboard-nav-gate.ts` | `use-keyboard-nav-gate` | 2026-11 | 仅统一适配规则 |
| `src/hooks/use-touch-primary.tsx` | `use-touch-primary` | 2026-11 | 仅统一适配规则 |
| `src/lib/elevated.tsx` | `elevated` | 2026-11 | 仅统一适配规则 |
| `src/lib/font-weight.ts` | `font-weight` | 2026-11 | 仅统一适配规则 |
| `src/lib/icon-context.tsx` | `icon-context` | 2026-11 | 图标槽位只保留已接入组件用到的 `x`、`chevron-down`、`check`（上游 70 个全部导入，会随 `UiRoot` 进入首屏包）；接入新组件时按上游槽位名补充 |
| `src/lib/motion-features.tsx` | 无（模板新增） | — | `LazyMotion features={domAnimation}` 的封装，见统一适配规则 8 |
| `src/lib/omit.ts` | `omit` | 2026-11 | 仅统一适配规则 |
| `src/lib/popup.ts` | `popup` | 2026-11 | 仅统一适配规则 |
| `src/lib/shape-context.tsx` | `shape-context` | 2026-11 | `ShapeProvider` 新增受控 `shape`；rounded 时 `--shape-input-radius` 取 `var(--radius)` |
| `src/lib/size-context.tsx` | `size-context` | 2026-11 | 仅统一适配规则 |
| `src/lib/springs.ts` | `springs` | 2026-11 | 仅统一适配规则 |
| `src/lib/surface-classes.ts` | `surface-classes` | 2026-11 | 仅统一适配规则 |
| `src/lib/surface-context.tsx` | `surface-context` | 2026-11 | 仅统一适配规则 |
| `src/lib/type-scale.ts` | `type-scale` | 2026-11 | 仅统一适配规则 |
| `src/lib/utils.ts` | `utils` | 2026-11 | 保留模板 `cn` 签名；登记类型阶梯类名，不含上游站点专用的 `text-site-*` |
| `src/styles/globals.css` | `tokens`、`surfaces`、`type-scale`、`shape-context`、`scroll-area`、`button`（CSS） | 2026-11 | 语义色取 Fluid 站点 `app/globals.css` 的默认值，基线与预设放在 `@layer base`（brand.css 不分层即可覆盖）；改动：新增 `--primary`（浅 `#171717` / 深 `#f5f5f5`）；`--destructive` 浅色取 red-700（上游 red-500 作文字对比度不足 4.5:1）；`--muted-foreground` 浅 `#6b6b6b` / 深 `#b0b0b0`（上游在 muted 与高层表面上不足 4.5:1）；`--fluid-accent` 浅 `#3b82f6` / 深 `#4f86f7`（焦点环对背景与主按钮 ≥ 3:1）；`--fs-body` 14px（上游 13px）；`--success` 沿用模板原值；`--ring` 指向 `--focus-ring`；新增 `tint` 颜色工具类；4.1 新增 `--control-border`（`--foreground` 52%，复选框边框与开关关闭轨道对页面、卡片、surface-5 ≥ 3:1）、`--switch-thumb-on`、`--badge-*` 色板 |

## 公开接口

`@saas/ui` 只导出组件、`UiRoot` 与类型；`useShape`、`useSize`、`useIcons`、`SizeProvider` 等上下文接口暂不导出
（随上游月度改名），应用经 `UiRoot` 配置。

## 必须传入的多语言文案（tasks 4.6）

组件不带英文默认文案，类型上要求调用方传入（`apps/web` 中传 `m.*()`）。task 7.1 写 `docs/design-system.md` 时并入：

| 组件 | 属性 | 说明 |
|---|---|---|
| `DialogContent` | `closeLabel` | 右上角关闭按钮的可读名称；`showCloseButton={false}` 时不需要 |
| `SelectTrigger` | `placeholder` | 未选择时显示的文字 |
| `AlertDialogAction` / `AlertDialogCancel` | `children` | 按钮文字；标题与说明同样由调用方传入 |
| `Switch` | `label` | 可见标签，同时是开关的可读名称 |
| `Tooltip` | `content` | 提示文字 |
| `ThemeToggle`、`DataTable` | `labels` | 模板原有，已由调用方传入 |

## SelectItem 的 `index`（tasks 4.5 评估结论：保留显式传入）

`index` 在渲染期决定悬停高亮（`useFluidHoverSelect(activeStore, i => i === index)`），同时用于 fluid-hover 的
注册与 `data-fluid-hover-index`（焦点、键盘导航按它找行）。自动编号只能在挂载后按 DOM 顺序测量：首帧所有行
没有编号，高亮与已选标记会在第二帧跳到正确行；Select 关闭时 Radix 把选项放在脱离文档的 DocumentFragment 中，
测量时机更难确定；分组（`SelectGroup`）与条件渲染也让 `React.Children` 计数不可靠。因此保留显式 `index`
（从 0 起、跨分组连续编号），在 `SelectItemProps` 的注释中说明。上游若改为自动编号再随月度合并跟进。

## 动效包体积（tasks 4.1 评估 LazyMotion）

2026-11-10 用 esbuild（外置 React、minify、gzip -9）打包 Dialog、AlertDialog、Select、Tooltip、Checkbox、Switch：
`motion.*` 约 119.4 KB，改为 `m.*` + `LazyMotion(domAnimation)` 后约 105.1 KB（−14.2 KB）；单独比较 motion 自身，
`motion` + `AnimatePresence` 48.7 KB，`m` + `LazyMotion` + `domAnimation` + `AnimatePresence` 34.2 KB。
`MotionFeatures` 放在各组件根节点而不是 UiRoot，首页 JS 不变（UiRoot 只含 MotionConfig）。

## 尚未接入

其余 Fluid 组件（Tabs、Dropdown、Sidebar、Combobox、Command Menu 等）在 tasks 4.2 中按同样规则逐个接入；
图标库替换（`icons-tabler` 等）与 `use-merge-split` 需要时再接入；Input 的文件图标与数字步进按钮、
`field`（标签 + 说明 + 错误的组合）待需要时接入。
