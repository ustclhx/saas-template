# Proposal

## Why

模板目前只有 9 个 shadcn 风格组件和一套中性主题变量，web 里仍有 15 处原生 `<select>`、8 处 `confirm()` 和 admin 私有组件；衍生项目没有品牌主题的落点，agent 开发页面时也没有设计参考，容易得到「功能齐全但不想用」的界面。模板要长期服务多个产品，需要固定分层、单一设计规范来源和「先设计后开发」的关卡，让 agent 还原经确认的设计，而不是自行发挥。

## What Changes

- 固定 UI 分层：框架（TanStack Start + Tailwind v4）→ 底层交互（继续 Radix，统一 `radix-ui` 包；Base UI 留待后续评估）→ 组件层 `packages/ui`（以 Fluid Functionalism 的 Radix 版本为主、shadcn 补缺，逐个组件接入）→ 设计规范（token 与规范文档）→ 页面模式 → 业务页面。
- 设计规范以仓库为准：token、字体、动效与组件使用规范放在 `packages/ui` 与 `docs/design-system.md`；claude.ai 的 Design System Artifact 只作可视化镜像，供 agent 出设计稿前读取。
- 模版基线保持中性：直接采用 Fluid Functionalism 的默认视觉，不按特定参考调整；视觉方向由各项目按需要提供参考后在品牌层决定。提供四套主题预设（neutral、blue、violet、green），`template.config.ts` 选择，生成器新增 `--theme`。
- 衍生项目的品牌 token 放在独立文件，模板创建后不再修改它，`template-sync` 时不产生冲突。
- 衍生项目继承规则：模版拥有 `packages/ui` 组件、基线 token、预设与检查；项目拥有 `brand.css`、`packages/ui/src/project/`（经 `@saas/ui/project` 导出，模版保证不在其中写文件）、`docs/design/` 与项目例外清单。项目不得直接修改模版组件，按 token → ui 配置 → project 包装 → 复制到 project 并登记的顺序定制；通用组件回流模版。经确认的设计稿副本存入项目 `docs/design/prototypes/`。
- 补齐组件（Dialog、AlertDialog、Select、Textarea、Tabs、Dropdown、Tooltip、Badge、Switch、Checkbox、Sidebar、Toast 等），替换 web 中的原生 select、confirm 与 admin 私有组件。
- 护栏：`check-deps` 限制 radix / base-ui / motion 只能在 `packages/ui` 导入；新增 `check:ui`，禁止 apps 中写死颜色、任意值尺寸、原生 `<select>` 与 `confirm()`；新增 `/dev/ui` 预览页（仅开发与 staging）。
- 新增 `ui-design` 技能，规定新页面和较大布局改动须先在 Design 画布产出设计稿并经使用者确认；`new-page`、`new-static-page` 先调用它。文案、小样式和缺陷修复免设计稿。
- 并入 xuanxue 基础需求（`~/.claude/codex-specs/saas-template/2026-11-10-foundation-from-xuanxue.md`）的 UI 部分，作为设计关卡的首批实战验证：
  - R5.1 工作台侧边栏布局（分组由项目注册、可折叠、手机抽屉、底部升级与账户入口），与现有布局经配置二选一，模版默认侧边栏；
  - R5.2 长文阅读器（安全的 Markdown 渲染、自动目录、吸顶导航、阅读进度、打印样式，导出 PDF 用浏览器打印，服务端生成只留扩展点）；
  - R5.4 营销区块：数据背书条（未配置数值时不渲染，不预填假数据）、三步流程、编号产品矩阵、悬浮 AI 入口；
  - R1–R4 的界面组件，只做组件与页面布局、不接新后端：推荐追问按钮、消息评分与反馈、嵌入式对话外壳、余额不足弹窗、本次预计消耗、会员锁定态、每日领取提示，以及定价页订阅与积分包并列、账单页分区布局；真实数据由各自的后端变更接入。
  - 所有新组件与页面在 `/dev/ui` 展示，390px 宽无横向滚动，浅色与深色均正确。
- 不在本变更：R1–R4 的后端与数据、R5.3 动态 OG 分享图（另开 seo 变更）、R6 提示词评测。
- 营销页动效（Magic UI、beUI）只按需引入，营销页 Lighthouse 必须保持现有水平；AI 页面在 Fluid AI 组件与 AI Elements 中选一套，不在本变更中替换聊天页。
- 实施前先做 3 个组件（Button、Dialog、Select）的验证，确认导入改写、字体、主题和包体积可行。

## Capabilities

### New Capabilities

- `design-system`：UI 分层与依赖边界、设计 token 与品牌层、主题预设、组件库覆盖、预览页、UI 规范检查。

- `app-workbench`：App 区工作台布局（项目注册的导航、折叠与移动端抽屉）与长文阅读器。

### Modified Capabilities

- `marketing-site`：新增数据背书、三步流程、产品矩阵与悬浮 AI 入口区块，以及订阅与积分包并列的定价展示。
- `agent-skills`：技能清单新增 `ui-design`，页面技能在开发前须经过设计关卡。
- `project-bootstrap`：生成器新增 `--theme` 并生成项目自有的品牌 token 文件。

## Impact

- 代码：`packages/ui`（组件、token、预设、Provider）、`apps/web` 根布局与使用原生控件的页面、`apps/web/src/routes/dev/ui`、`scripts/check-deps.*`、新增 `scripts/check-ui.mjs`、`scripts/create-project*`、`template.config.ts`。
- 依赖：`packages/ui` 新增 `motion`、`lucide-react`、Inter 可变字体（自托管，含 opsz 轴）；Radix 仍走统一的 `radix-ui` 包，不引入 `@radix-ui/react-*` 与 `next-themes`。
- 技能与文档：新增 `.agents/skills/ui-design` 与 `.claude/skills/ui-design`；更新 `new-page`、`new-static-page`；新增 `docs/design-system.md`，更新 `docs/02-project-structure.md`。
- 衍生项目：通过 template-sync 获得组件与护栏；首次同步需按升级说明把项目 token（如 xuanxue 的 `site-theme.css`）并入 `brand.css`、把 `app.css` 恢复为模版原样，并把插画类组件的写死颜色登记到项目例外清单。
- 外部：claude.ai Design System Artifact 作为镜像，不进入构建或运行时。
