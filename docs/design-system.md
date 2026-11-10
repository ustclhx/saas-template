# 设计规范

模板与衍生项目的 UI 分层、设计 token、组件用法、动效、页面模式与设计关卡。规范以仓库为准：
token 在 `packages/ui/src/styles/`，组件在 `packages/ui/src/components/`，本文说明如何使用它们。
claude.ai 的 Design System Artifact 只是可视化镜像，供出设计稿前读取，二者不一致时以仓库为准。

决策来源：OpenSpec change `add-ui-design-system`（design D1–D11）。组件来源与上游月份见
[`packages/ui/UPSTREAM.md`](../packages/ui/UPSTREAM.md)。

## 1. 镜像与同步记录

| 字段 | 值 |
|---|---|
| Design System 镜像 | 待发布（tasks 7.4 发布后填写 claude.ai 链接） |
| 最近同步提交 | 待发布（填写镜像内容所依据的 main 提交 SHA） |

每次合并修改 token、预设或组件规范的 PR 后，由协调者按仓库内容更新镜像，并把上表的「最近同步提交」
改为该合并提交或之后的提交。镜像落后时，以本文与 `packages/ui` 为准。

## 2. 分层

自下而上，每层只依赖下一层：

| 层 | 位置 | 说明 |
|---|---|---|
| 框架 | TanStack Start + Tailwind CSS v4 | 路由、SSR 与工具类生成 |
| 底层交互 | `radix-ui` 统一包 | 焦点管理、键盘与无障碍语义；不使用拆分的 `@radix-ui/react-*`。Base UI 以后再评估 |
| 组件层 | `packages/ui`（`@saas/ui`） | 以 Fluid Functionalism 的 Radix 版为主、shadcn 补缺，逐个组件接入并适配（`UPSTREAM.md`）|
| 设计 token | `packages/ui/src/styles/globals.css` → `presets/*.css` → `apps/web/src/styles/brand.css` | 三层：基线 → 预设 → 项目品牌，见第 3 节 |
| 页面模式 | 工作台、列表、表单、营销区块等 | 由组件组合而成的固定版式，见第 6 节 |
| 业务页面 | `apps/web/src/routes`、`apps/web/src/features` | 只组合 `@saas/ui` 与 `@saas/ui/project`，不写死颜色与尺寸 |

边界由检查脚本落地，不只靠约定：

- `pnpm check:deps`：`radix-ui`、`motion`、`lucide-react`、`class-variance-authority` 等只允许 `@saas/ui`
  依赖与导入，`@radix-ui/*` 在任何包中都禁止。规则在 `scripts/check-deps.rules.json`。
- `pnpm check:ui`（并入 `pnpm check`）：扫描 `apps/**/src/**/*.tsx`，禁止颜色字面量（hex / rgb / hsl / oklch）、
  className 任意值（`-[...]`）、原生 `<select>` 与 `confirm()` / `alert()`。例外逐文件登记在
  `scripts/check-ui.allow.json`（模板）与 `scripts/check-ui.allow.local.json`（项目），每条写明规则与原因。

## 3. 设计 token

### 3.1 三层归属

| 层 | 文件 | 归属 | 内容 |
|---|---|---|---|
| 基线 | `packages/ui/src/styles/globals.css` | 模板 | Fluid 默认视觉（中性灰阶）：语义色、表面阶梯、阴影、交互态、层级、字号阶梯；`@layer base` |
| 预设 | `packages/ui/src/styles/presets/{neutral,blue,violet,green}.css` | 模板 | 只覆盖强调色与焦点环，挂在 `<html data-preset="…">`，同为 `@layer base` |
| 品牌 | `apps/web/src/styles/brand.css` | 项目 | 项目品牌值；不分层，普通 `:root` / `.dark` 选择器即可覆盖前两层 |

模板基线刻意保持中性，不按任何具体产品的参考调整；视觉方向由衍生项目提供参考后写在品牌层。
`apps/web/src/styles/app.css` 已把 `brand.css` 作为最后一个导入，项目不需要改 `app.css`。

### 3.2 token 清单

数值会随上游与预设调整，本表只列名称与用途；当前取值直接从源文件读取：

```sh
# 基线（浅色在前，.dark 在后）
grep -nE -- '^ +--[a-z0-9-]+:' packages/ui/src/styles/globals.css
# 各预设覆盖的变量
grep -nE -- '--[a-z0-9-]+:' packages/ui/src/styles/presets/*.css
# 项目品牌层实际生效的覆盖（模板版本只有注释，无输出）
grep -nE -- '^ *--[a-z0-9-]+:' apps/web/src/styles/brand.css
```

| 类别 | 变量 | 工具类 | 用途 |
|---|---|---|---|
| 页面与容器 | `--background` `--foreground` `--card(-foreground)` `--popover(-foreground)` | `bg-background` `text-foreground` `bg-card` `bg-popover` | 页面底色取 `--surface-1`，卡片与弹层取 `--surface-3` |
| 强调 | `--primary` `--primary-foreground` | `bg-primary` `text-primary-foreground` | 主按钮等实心强调；预设与品牌层改这里换色 |
| 次级 | `--secondary(-foreground)` `--muted` `--muted-foreground` | `bg-secondary` `bg-muted` `text-muted-foreground` | 次要底色、说明文字（在 muted 与高层表面上满足 4.5:1） |
| 较重强调底 | `--accent` `--accent-foreground` | `bg-accent` | Fluid 原值，较重；普通悬停与当前项改用 `bg-hover` / `bg-active` |
| 状态 | `--destructive` `--destructive-light` `--success` | `text-destructive` `bg-destructive-light` `text-success` | 危险与成功；作文字时满足 4.5:1 |
| 边框与输入 | `--border` `--input` | `border-border` `border-input` | 边框由前景色混出，随明暗自动变化 |
| 交互态 | `--hover` `--active` `--selected` `--tint` `--tint-hover` | `bg-hover` `bg-active` `bg-selected` `bg-tint` | 悬停、按下、选中与按钮底色层 |
| 焦点与品牌强调 | `--fluid-accent` `--focus-ring` `--ring` | `bg-fluid-accent` `ring-ring` | 唯一的品牌强调色：开关、选区与焦点环；焦点环与背景、与主按钮 ≥ 3:1 |
| 表面阶梯 | `--surface-1` … `--surface-8` | `bg-surface-1` … `bg-surface-8` | 浅色靠阴影分层，深色层级越高越亮 |
| 阴影 | `--shadow-1` … `--shadow-8` | `shadow-surface-1` … `shadow-surface-8` | 与表面层级配对使用 |
| 圆角 | `--radius` | `rounded-sm/md/lg/xl` | 基准值；控件 `rounded-lg`、容器 `rounded-xl`；按钮、选择器与弹窗的形状另由 `ui.shape` 控制 |
| 字号阶梯 | `--fs-*` / `--lh-*`（display、title、subtitle、body、caption、micro，各含 `-compact`） | `text-display` `text-title` `text-subtitle` `text-body` `text-caption` `text-micro` | 页面只用这六个角色，不写任意字号 |
| 层级 | `--z-sticky` `--z-overlay` `--z-modal` `--z-popover` `--z-tooltip` | — | 离开组件流的浮层只用这些值 |
| 字体 | `--font-sans` | `font-sans` | 自托管 Inter 可变字体（opsz），中文回退系统字体 |

新增 token 先改基线（模板）或品牌层（项目），再用工具类引用；页面中不出现原始颜色值。

### 3.3 主题预设与 ui 配置

`template.config.ts` 的 `ui` 段：

| 键 | 取值 | 作用 |
|---|---|---|
| `preset` | `neutral`（默认）`blue` `violet` `green` | 强调色与焦点环；根布局在 SSR 时写入 `<html data-preset>`，首屏无闪烁 |
| `shape` | `sharp` `rounded`（默认）`pill` | 按钮、选择器与弹窗的圆角形状，经 `UiRoot` 下发 |
| `density` | `default`（默认，控件 36px）`compact`（28px） | 控件尺寸与字号阶梯 |

省略的键取默认值，未知取值在构建期报错。每个预设同时定义浅色与 `.dark`，对比度由
`packages/ui/test/presets.test.ts` 断言：正文 ≥ 4.5:1，焦点环与背景、与主按钮 ≥ 3:1。
明暗主题由 `themeInitScript` 在首屏前设置 `<html class="dark">`，`ThemeToggle` 提供浅色、深色与跟随系统。

## 4. 组件用法

页面只从 `@saas/ui`（模板组件）与 `@saas/ui/project`（项目组件）导入，不直接导入 Radix、motion、lucide-react
等底层库（`pnpm check:deps` 会失败）。当前可用的公开组件以 `packages/ui/src/index.ts` 为准：

```sh
grep -nE '^export' packages/ui/src/index.ts
```

规则：

- **根组件**：根布局用 `UiRoot` 包裹一次，传入 `template.config.ts` 的 `shape`、`density`；上下文 hooks 与 Provider
  不导出（随上游月度改名），只经 `UiRoot` 配置。
- **按钮**：`Button` 保留 shadcn 变体（`default` `destructive` `outline` `secondary` `ghost` `link`）与尺寸；
  需要加载态时用 `loading`，图标用 `leadingIcon` / `trailingIcon`，不要在按钮里手写转圈。
- **选择**：用 `Select` 系列，不用原生 `<select>`。`SelectItem` 需要显式 `index`（从 0 起，与渲染顺序一致），
  它同时驱动悬停高亮注册与渲染期的高亮判断。
- **确认**：删除等危险操作用确认对话框，不用 `confirm()`；取消后焦点回到触发按钮。确认对话框（AlertDialog）
  将由 tasks 4.1 提供，未合并前用 `Dialog` 组合。
- **列表与表单**：后台列表用 `DataTable` 与 `apps/web/src/features/admin/list.ts`；表单用 `useAppForm` / `TextField`。
- **多语言文案**：组件内置的英文默认值只作兜底，应用层必须传入 `m.*()` 文案：

  | 组件 | 属性 |
  |---|---|
  | `DialogContent` | `closeLabel` |
  | `SelectTrigger` | `placeholder` |
  | `DataTable` | `labels` |

  完整清单将由 tasks 4.6 补齐。
- **浮层层级**：自定义吸顶、遮罩与弹层用 `--z-*` 变量，不写任意 `z-[…]`。

将由 tasks 4.1、4.2 接入：AlertDialog、Textarea、Checkbox、Switch、Badge、Tooltip、Tabs、Dropdown、Sidebar、Toast、
Combobox、Command Menu。缺少的组件先在 `packages/ui` 补齐（模板）或在 `packages/ui/src/project/` 补齐（项目），
再实现页面，不在页面里临时写一个。

## 5. 动效与减少动态效果

- 动效只在 `@saas/ui` 组件内部实现，档位取 `packages/ui/src/lib/springs.ts` 的 `spring.fast` / `moderate` / `slow`
  （移动的东西越大越慢），不手写时长；退出用对应档位的 `.exit`。
- `UiRoot` 以 `MotionConfig reducedMotion="user"` 包裹：系统开启「减少动态效果」时去掉位移与布局动画，
  只保留淡入淡出或直接切换。纯 CSS 动画用 Tailwind 的 `motion-reduce:` 变体降级。
- 营销页优先用 CSS 过渡；`motion` 只随交互组件按需加载，不进入营销首屏。新增动效区块须保持营销页
  Lighthouse SEO 与可访问性分数不下降，并在数据库不可用时仍可预渲染。

## 6. 页面模式

| 模式 | 组成 | 状态 |
|---|---|---|
| 工作台 | 侧边栏（分组由项目注册、可折叠、手机抽屉、底部升级与账户入口），与顶部布局经 `ui.appLayout` 二选一 | 将由 tasks 8.3 提供 |
| 后台列表 | `DataTable` + `adminListSearch` / `adminListPage`，筛选改变回第一页 | 现有 |
| 表单 | `useAppForm` + 字段组件，提交按钮 `SubmitButton`，错误用 `FieldErrors` | 现有 |
| 长文阅读 | 安全 Markdown、自动目录、吸顶高亮、阅读进度、打印样式 | 将由 tasks 8.4 提供 |
| 营销区块 | 数据背书（未配置不渲染）、三步流程、编号产品矩阵、悬浮 AI 入口 | 将由 tasks 8.5 提供 |
| 业务界面组件 | 推荐追问、消息评分、嵌入式对话、余额不足弹窗、预计消耗、会员锁定、每日领取 | 将由 tasks 8.6 提供，接口写入本节 |

每个页面都要设计并实现四种状态：正常、空、加载、错误；在 390px 宽无横向滚动，浅色与深色均正确。
根布局与公开页面的数据读取失败时降级，不让整页报错。

## 7. 组件预览页

`/dev/ui` 展示全部组件与页面模式的变体，可切换预设、明暗、shape、density；只在开发与 staging（`UI_PREVIEW=true`）
可访问，生产返回 404 且不进 sitemap。将由 tasks 4.3 提供。

## 8. 设计关卡

### 8.1 何时需要设计稿

需要经使用者确认的 Design 画布稿：

- 新增页面（app、admin、营销或静态独立页）；
- 较大布局改动：改变页面的区块结构、导航方式、信息层级，或新增页面模式；
- 建立或改变视觉方向（品牌 token、字体、多站点配色）。

免设计稿：

- 文案与翻译修改；
- 小样式调整：间距、对齐、已有 token 之间的替换、单个组件变体切换；
- 缺陷修复（恢复已确认设计稿或现有页面应有的样子）；
- 在已有内容集合中新增文章（博客、文档、法律页），不改版式。

拿不准时按需要设计稿处理，并向使用者确认。设计流程见 `ui-design` 技能（`.agents/skills/ui-design/SKILL.md`）。

### 8.2 设计稿与副本

- 设计稿用 claude.ai 的 Design Artifact 类型产出，画板覆盖桌面 / 移动 × 浅色 / 深色 × 正常 / 空 / 加载 / 错误，
  使用者在画布上确认。
- 确认后保存可离线打开的副本，并在该需求的 OpenSpec `design.md` 同时记录链接与副本路径；实现与验收以副本为准。
- 副本位置：模板自身的设计稿在 `docs/design-system/prototypes/`（属于模板文档，生成器不复制到衍生项目）；
  衍生项目的设计稿在 `docs/design/prototypes/<页面>.html`。

### 8.3 参考来源

- 组件与默认视觉：Fluid Functionalism（Radix 版，MIT），缺口用 shadcn/ui 补齐；交互原语为 Radix。
- 营销动效：Magic UI、beUI 等只在具体区块有设计稿时按需接入，不批量引入。
- 项目视觉方向的参考（网站或截图）由使用者提供，记录在项目的 `docs/design/` 中（`visual-system.md`），
  不写进本文。没有参考时只使用现有 token，不引入规范外的颜色、字体或组件样式。

## 9. 衍生项目

### 9.1 文件归属

| 模板拥有（同步时更新，项目不改） | 项目拥有（模板创建后不再修改，同步不冲突） |
|---|---|
| `packages/ui/src/components`、`lib`、`hooks` | `apps/web/src/styles/brand.css` |
| `packages/ui/src/styles/globals.css` 与 `presets/` | `packages/ui/src/project/`（经 `@saas/ui/project` 导出） |
| `scripts/check-ui.mjs`、`scripts/check-ui.allow.json` | `scripts/check-ui.allow.local.json` |
| 组件指纹清单 `packages/ui/components.lock.json` | `docs/design/`（视觉规范、参考、原型副本、forks 登记） |
| 预览页、技能、本文 | `apps/web/src/features/ai/subject-providers.ts` |
| `template.config.ts` 中 `ui` 段的结构 | `template.config.ts` 中 `ui` 段的取值 |

`packages/ui/src/project/` 与 `@saas/ui/project` 导出将由 tasks 6.1 提供；`components.lock.json` 校验与
`check-ui.allow.local.json` 读取将由 tasks 6.2 提供；生成器创建空的项目例外清单与 `docs/design/` 说明将由 tasks 6.3 提供。

### 9.2 定制顺序

项目不得直接修改模板组件文件（`components.lock.json` 校验会失败）。需要不同外观或行为时按顺序尝试，
前一步能解决就不进入下一步：

1. **token**：在 `brand.css` 覆盖变量（浅色与 `.dark` 成对给出，改色后核对对比度）。
2. **ui 配置**：调整 `template.config.ts` 的 `ui.preset` / `shape` / `density`。
3. **project 包装**：在 `packages/ui/src/project/` 写组合或包装组件，经 `@saas/ui/project` 导出。
4. **复制到 project 并登记**：把模板组件复制到 `packages/ui/src/project/` 后修改，并在 `docs/design/forks.md`
   登记来源文件、复制时的模板版本与原因；同步模板后对照上游改动手动合并。

项目中写出的通用组件按惯例回流模板；模板发布后，项目同步并删除自己的副本。

### 9.3 多站点

一个项目服务多个站点时，在 `brand.css` 用 `:root[data-site="<站点>"]` 与 `:root[data-site="<站点>"].dark`
分别覆盖品牌变量，由根布局写入 `data-site`；各站点的视觉规范写在项目的 `docs/design/visual-system.md`。

### 9.4 同步模板

`template-sync` 涉及 `packages/ui` 或基线 token 时，合并前对 staging 的 `/dev/ui` 与项目关键页面截图对比；
偏差在品牌层或项目组件中修正，不改模板组件。

## 10. 常用命令

```sh
pnpm check:ui
pnpm check:deps
pnpm --filter @saas/ui typecheck
pnpm --filter @saas/ui test
```
