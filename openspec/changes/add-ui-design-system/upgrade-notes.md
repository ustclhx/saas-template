# 升级说明草稿（UI 基线）

供 task 9.2 合并进正式升级说明（`docs/upgrades/<版本>.md`）。这里记录 #303（tasks 1.1、1.2、3.1–3.3）
带来的、衍生项目同步后会看到的视觉与行为变化。

## 必须执行的动作

1. 创建 `apps/web/src/styles/brand.css`（模板版本只有注释），并在 `app.css` 中作为最后一个 `@import`。
   项目原有的品牌变量（如 xuanxue 的 `site-theme.css`）迁入该文件；基线与预设在 `@layer base` 中，
   brand.css 不分层，用普通 `:root` / `.dark` 选择器覆盖，覆盖浅色值时须同时给出 `.dark` 值。
2. `template.config.ts` 增加 `ui: { preset, shape, density }`（省略取默认 neutral / rounded / default；
   未知取值在构建期报错）。

## 视觉变化（全站）

- 字体：自托管 Inter 可变字体（opsz），中文回退系统字体；预加载拉丁子集。
- 页面背景由纯白改为 `#fafafa`（深色 `#171717`）；卡片与弹层为白色（深色 `#252525` 起的表面阶梯）。
- 圆角基准 `--radius` 由 0.625rem 改为 0.5rem：控件 8px、卡片 12px。
- 正文控件字号：按钮由 14px medium 改为 14px regular（Fluid 字重）。
- 焦点环：Button、Select 为 2px 描边加 2px 间隙，浅色 `#3b82f6`、深色 `#4f86f7`；shadcn 组件的
  `--ring` 指向同一颜色（原为灰色）。
- 按钮变体：
  - `default`：实心 `--primary`，悬停/按下加深；按下时整体收缩 1px。
  - `outline`：无底色、无阴影，只有 1px 边框圈，悬停显示浅灰底。
  - `ghost`：默认灰字（`--muted-foreground`），悬停变为正文色并显示浅灰底。
  - `secondary`：半透明灰底，透出所在表面。
  - `destructive`：由实心红底白字改为浅红底红字（`--destructive` 浅色 red-700）。
- `--accent` 取 Fluid 原值（浅 `#e5e5e5`、深 `#525252`），比原 shadcn 值更重；使用 `bg-accent` 的
  悬停态（admin 侧栏、docs 目录、DataTable）会显得更深，task 4.4 改为 `bg-hover` / `bg-active`。
- 深色 `--muted` 为 `#1e1e1e`，`--muted-foreground` 为 `#b0b0b0`。
- 内部滚动容器（弹层列表、ScrollArea 等）使用细滚动条；页面根滚动条保持系统默认。
- 选中文字使用强调色淡底。

## 组件补齐（tasks 4.1、4.4–4.6）

- 新增组件：AlertDialog（确认对话框）、Textarea、Checkbox、Switch、Badge、Tooltip，均从 `@saas/ui` 导入。
  项目里自写的同类组件可逐步替换（admin 私有 Textarea / CheckboxField 由 tasks 5.x 替换）。
- Input 外观：边框由 `--input` 改为 `--border`（与 Select 触发器一致），去掉阴影与深色半透明底，悬停显示浅灰底；
  聚焦时边框加深并显示 2px 强调色描边加 2px 间隙（原为 3px 半透明 ring）；字号沿用正文 14px、触屏 16px。
  `size` 属性改为尺寸阶梯（`'default' | 'compact'`），不再是原生字符宽度；`type="file"` / `"number"` 外观不变。
- 类型变化：`DialogContent` 显示关闭按钮时必须传 `closeLabel`，`SelectTrigger` 必须传 `placeholder`
  （原默认英文 "Close" / "Select…"）。项目调用处传 `m.*()` 文案；不显示关闭按钮时传字面量 `showCloseButton={false}`；
  用布尔变量控制（`showCloseButton={flag}`）时必须同时传 `closeLabel`。
- Dialog / AlertDialog 退场动画期间面板不可点击（`inert`），关闭后再点其中的按钮不会触发回调。
- 输入框边框：Input、Textarea、Select 触发器共用 `--field-border`（默认等于 `--border`），项目要更醒目的边框时在
  brand.css 只改它；错误态边框由半透明红改为实色 `--destructive`。
- Textarea 只在支持 `field-sizing` 的浏览器随内容长高并隐藏拖拽把手，Safari / Firefox 可纵向拉伸。
- Badge `size` 只接受 `'default' | 'compact'`。
- 悬停与当前项：admin 侧栏悬停 `bg-hover`、当前项 `bg-active`，docs 搜索结果与 DataTable 行悬停 `bg-hover`
  （原 `bg-accent` / `bg-muted/30`）。`--accent` 保持 Fluid 原值，作为较重的强调底（灰色 Badge 使用）。
- 新增变量：`--control-border`（复选框边框、开关关闭轨道，对背景 ≥ 3:1）、`--switch-thumb-on`（开启态开关滑块，
  深色的 blue / violet / green 预设改为深色）、`--badge-*` 色板。项目在 brand.css 改强调色或前景色后，
  `pnpm --filter @saas/ui test` 的对比度用例只覆盖模板预设，需自行确认开关滑块与轨道 ≥ 3:1。

## 组件补齐 B 与预览页（tasks 4.2、4.3）

### 破坏性变更（同步后必须处理）

1. **DataTable `labels` 必填**：组件不再带英文默认文案，所有 `<DataTable>` 都要传 `labels`。
   app 区与公开页传 `labels={dataTableLabels()}`（`apps/web/src/features/i18n/table-labels.ts`，文案在
   `messages/<locale>/common.json` 的 `common_table_*`），后台列表沿用 `adminTableLabels()`。项目自建的列表一并补上，
   否则 typecheck 失败。
2. **DataTable 筛选下拉改为 `@saas/ui` Select**：原生 `<select>` 改为 Radix Select（随表单提交的隐藏原生 select 仍在）。
   e2e 中对筛选下拉的 `getByLabel(…).selectOption(…)` 改用 `e2e/select.ts` 的 `chooseOption(trigger, 选项文字)`；
   单元测试里 `fireEvent.change(select)` 改为打开触发器后点击选项。没有空值选项的筛选默认第一项，与原生一致。
3. **字号**：`CardTitle` 由 `text-xl`（20px）改为 `text-title`（16px）；Card 说明、Alert、Label、DetailList 由 `text-sm`
   改为 `text-body`（同为 14px，随 density 变化）。`type-scale.ts` 的正文回退值 13px → 14px，与 `--fs-body` 一致。
   页面若依赖 20px 卡片标题，给 `CardTitle` 传 `className="text-display"` 之类的阶梯类，不写任意字号。
4. **Button `link` 变体改用 `--primary-text`**（原 `--primary`）：默认等于 `--primary`，模板的深色 blue / violet / green
   预设改为 400 号色以满足 4.5:1。项目在 brand.css 或自有预设中改了 `--primary` 时，须在 `.dark` 中同时给出
   `--primary-text`（作文字对页面与卡片 ≥ 4.5:1）。
5. **新增非密钥变量 `UI_PREVIEW`**：`/dev/ui` 组件预览页只在 `UI_PREVIEW=true` 时开放。项目自有 `wrangler.jsonc`
   的顶层（开发）与 `env.staging.vars` 设 `"UI_PREVIEW": "true"`，**`env.production` 不设**（`check-wrangler-envs.mjs`
   会拦截）；自托管默认不传即关闭。该页不预渲染、不进 sitemap、输出 noindex。
6. **Sidebar 快捷键默认关闭**：`SidebarProvider` 的 `shortcut` 默认 `null`（上游默认 `[` / `]`）；需要时显式传入。

### 新增组件与变量

- 新组件：Tabs、Dropdown（菜单）、Sidebar、Toast（`Toaster` + `toast()`）、Combobox、Command Menu。可读文字全部由
  调用方传入，清单见 `docs/design-system.md` §4。`Toaster` 含动效库，按 §4 在 app / admin 布局用 `React.lazy` 挂载，
  不放进根布局。
- 图标：业务页面从 `@saas/ui/icons` 按名称导入（apps 不能直接依赖 lucide-react）。
- 变量：`--primary-text`、`--switch-thumb-off`（原写死白色）、`--z-toast`；工具类 `scroll-divider`、`scrollbar-hide`。
  项目改过开关颜色时同时检查关闭态滑块与轨道 ≥ 3:1。
- DataTable 表头底色由 `bg-muted/50` 改为 `bg-hover`，容器圆角 `rounded-xl`；单元格按函数调用渲染，调用方不必再为
  保留行内按钮焦点而 `useMemo` 列定义。

## 主题预设

`ui.preset` 可选 neutral、blue、violet、green，只换强调色与焦点环，不改圆角；圆角由 `ui.shape`
（sharp / rounded / pill）与 brand.css 决定。`ui.shape` 目前只影响按钮、选择器与弹窗。

## 验证

- 同步后在浅色与深色下检查首页、定价页、登录页与 admin 列表页。
- 若项目改过品牌色，确认正文对比度 ≥ 4.5:1，焦点环与背景、与主按钮 ≥ 3:1。

## 衍生项目继承检查（6.1–6.3、7.3）

老衍生项目若已创建 `docs/design/README.md`，首次同步本变更时可能产生 add/add 冲突。
合并时保留项目已有的设计记录，并补入复制组件的登记说明。复制到 `packages/ui/src/project/`
的组件需在 `docs/design/forks.md` 记录来源，同时在 `scripts/check-ui.allow.local.json` 按文件
登记 `arbitrary-class` 等必要例外及原因。

组件指纹清单随模板维护。Git 仓库只计算已跟踪的组件文件，新增组件须先 `git add`，再运行
`pnpm ui:lock`。清单冲突在 rebase/merge 后重新生成，并执行 `pnpm check:ui`。

### 多站点根文档属性（6.4）

`apps/web/src/features/theme/html-attributes.ts` 与 `brand.css` 同属项目：模板创建后不再修改，
生成器原样保留。模板维护旁边的类型、属性过滤和根布局接入。项目只需修改此文件的
`getProjectHtmlAttributes`，即可在 SSR、构建期预渲染和客户端水合时得到一致的 `<html>` 属性：

```ts
import type { HtmlAttributesContext, ProjectHtmlAttributes } from './html-attributes.types.ts'

export function getProjectHtmlAttributes(context: HtmlAttributesContext): ProjectHtmlAttributes {
  return { 'data-site': context.pathname.startsWith('/west') ? 'west' : 'east' }
}
```

上下文提供服务端请求 URL 的 `host`（含非默认端口）、当前 `locale`、不含语言前缀和查询参数的
路由 `pathname`。函数应同步且无副作用，不使用浏览器 API 或数据库。允许字符串值的 `data-*`、
`title`、`dir`（ltr/rtl/auto）、`translate`（yes/no）；`lang`、`data-preset`、事件、className、style
等其余属性被忽略并记录 `theme.html_attribute_ignored` 警告（只记录属性名）。`lang` 与主题预设
继续由模板写入。返回值随根路由上下文序列化，水合时直接复用。只在服务端首屏计算，客户端
导航从现有 `<html>` 读取白名单属性，不发起服务端请求或按 pathname 重算；需要随路由变化时
请在页面组件内处理。

xuanxue 迁移：把根布局中 `data-site="east|west"` 的计算移到此函数，在 `brand.css` 中使用
`:root[data-site="east"]` / `:root[data-site="west"]`（并覆盖深色组合）切换 token，再将
`__root.tsx` / `root-document.tsx` 恢复为模板版本。

预渲染属性在构建时按当次请求计算。同一静态文件被多个域名复用时，`host` 不会变为访问者域名；
若按域名切换站点，需要每个域名分别构建对应产物或使用 SSR。按 pathname 分站可正常预渲染。
同步后核对 SSR 原文含 `data-site`，关闭 JavaScript 检查首屏配色，再启用 JavaScript 检查水合
无属性变化及 mismatch。`docs/design-system.md` 尚未合入 main，其多站点段落由后续文档任务引用本节。

### 指纹检查的已知限制

检查以仓库中的 `packages/ui/components.lock.json` 为基准，同时修改组件与清单可以绕过比对。
删除 `.template-base.json` 也会让检查按模板态运行。当前护栏依赖版本审阅，尚未在基准记录中
固定清单摘要。未被 Git 跟踪的文件不会计入 Git 仓库的指纹。指纹范围目前仅含
`packages/ui/src/components/`，`lib/`、`hooks/` 与 `styles/` 尚未纳入。

## 工作台侧边栏（tasks 8.3）

- App 区（`/app/$slug/*`）默认改为侧边栏工作台布局。想保持原顶部布局的项目在 `template.config.ts` 设
  `ui: { …, appLayout: 'topbar' }`，页面与测试行为不变。
- 侧边栏布局下：空间名称（`data-testid="workspace-name"`）在侧边栏顶部，当前用户（`data-testid="current-user"`）在底部
  账户入口；角色与多空间切换表单在工作台首页 `/app/$slug`；语言与主题切换在顶栏（窄屏在抽屉底部），不再浮动在页面角落。
  依赖原布局头部位置的项目 e2e 需相应调整。
- 项目导航条目写在 `apps/web/src/features/app-shell/nav.project.ts`（项目自有）；`nav.default.ts` 为模板条目，
  不要在其中加项目条目。
- 新 cookie `app_sidebar`（`expanded` / `collapsed`）记录折叠状态，属于功能性 cookie。
