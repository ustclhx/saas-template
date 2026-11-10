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

### 指纹检查的已知限制

检查以仓库中的 `packages/ui/components.lock.json` 为基准，同时修改组件与清单可以绕过比对。
删除 `.template-base.json` 也会让检查按模板态运行。当前护栏依赖版本审阅，尚未在基准记录中
固定清单摘要。未被 Git 跟踪的文件不会计入 Git 仓库的指纹。指纹范围目前仅含
`packages/ui/src/components/`，`lib/`、`hooks/` 与 `styles/` 尚未纳入。
