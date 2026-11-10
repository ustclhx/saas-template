# Design

## Context

- `packages/ui` 现有 Button、Card、Input、Label、Alert、Separator、Form（TanStack Form）、DataTable、ThemeToggle；颜色来自 `globals.css` 的 shadcn 变量（neutral），暗色由 `theme.tsx` 的首屏内联脚本切换 `.dark` 类，不依赖 next-themes。
- 组件已使用统一的 `radix-ui` 包；`check-deps` 只限制 React 归属，未限制交互原语；`check:singletons` 已拦截关键依赖多实例。
- `apps/web` 有 15 处原生 `<select>`、8 处 `confirm()`；`features/admin/ui.tsx` 自带 Textarea、NativeSelect、Field、Panel、EmptyState。允许写死颜色的合理位置：构建期 OG 图（`features/seo/og-card.ts`）与第三方品牌标识（登录页 Google 图标）。
- Fluid Functionalism（MIT，2026-02 起，月度发布）：34 个组件，Radix 版为默认；每个组件依赖 `motion`、`@radix-ui/react-*`、cva、`lucide-react`，组件源码不引用 `next/*`；token 叠加在 shadcn 变量之上（`--fluid-accent`、`--focus-ring`、hover/selected、z 层级），由 Shape/Size/Icon 等 Provider 统一控制；要求 Inter 可变字体的 opsz 轴。7–10 月每月均有破坏性改名。
- 模板同步是三方合并：模板侧未改动的文件保持项目值。
- claude.ai 的 Design 与 Design System 已是 Artifact 类型；独立的 claude.ai/design 将于 2026-12-14 关闭，因此不使用 DesignSync。

## Goals / Non-Goals

**Goals:**
- 组件来源可追溯、可逐个升级；接入外部组件不引入第二套原语或 Next.js 依赖。
- token 三层（基线 → 预设 → 品牌）各自归属清楚，模板升级不覆盖项目品牌。
- 规范靠检查脚本落地，而不是只写在提示词里。

**Non-Goals:**
- 不迁移到 Base UI；不在本变更替换 AI 聊天页组件（只产出选型结论）。
- 不批量引入营销动效库；Magic UI、beUI 只在具体区块有设计稿时按需接入。
- 不重做营销页视觉；基线风格调整完成后，营销页改版另起变更并走设计关卡。

## Decisions

### D1 组件来源：Fluid（Radix 版）逐个接入，shadcn 补缺
用 `shadcn add @fluid/<name>` 拉到临时目录，经适配后写入 `packages/ui/src/components`，不使用 `setup --overwrite`。适配固定为：
1. `@radix-ui/react-*` 改为 `radix-ui` 的命名导入；
2. `@/` 别名改为包内相对路径（`.tsx` 后缀，与现有风格一致）；
3. 去掉 `'use client'` 以外的 Next.js 假设，Biome 格式化；
4. 已有组件（Button、Input、DataTable、Form）保留现有公开 API，只吸收 Fluid 的样式与动效，必要时新增 props，不破坏调用方。

每个组件文件头记录来源与上游月份（如 `// 来源：fluid-functionalism radix/dialog（2026-10）`），`packages/ui/UPSTREAM.md` 汇总，便于以后按 changelog 手动合并。
- 备选：直接用原版 shadcn。放弃原因：缺统一动效与尺寸系统，需要自己补设计。
- 备选：Base UI 版。放弃原因：要重写整个底层，与决策「先 Radix」冲突。

### D2 token 三层
模版基线刻意保持中性（Fluid 默认视觉，不按任何具体参考调整），只提供四套预设（neutral、blue、violet、green）做强调色与圆角差异；具体视觉方向属于项目，由项目在建立视觉方向时提供参考，落在品牌层。

- `packages/ui/src/styles/globals.css`：基线（shadcn 变量 + Fluid 叠加变量 + 字号/间距/动效时长），模板维护。
- `packages/ui/src/styles/presets/*.css`：每个预设只覆盖强调色、圆角、焦点环等少量变量，挂在 `:root[data-preset="<名>"]`（含 `.dark` 组合）。预设数量小，全部打包，体积可忽略。
- `apps/web/src/styles/brand.css`：项目品牌层，在入口 CSS 最后导入。模板版本只含注释示例；模板发布检查断言该文件自创建后未被修改，从而保证同步无冲突。

根布局按 `templateConfig.ui.preset` 在 SSR 时给 `<html>` 写 `data-preset`，不依赖客户端脚本，首屏无闪烁。
- 备选：构建期按预设只打包一个 CSS。放弃原因：需改 Vite 配置，收益小，且预览页需要运行时切换。

### D3 Provider 与配置
`template.config.ts` 新增 `ui: { preset, shape: 'sharp' | 'rounded' | 'pill', density: 'default' | 'compact' }`。`packages/ui` 导出 `UiRoot`，内部组合 Fluid 的 Shape/Size/Icon/Motion Provider，减少动态效果跟随 `prefers-reduced-motion`；根布局用它包裹 children。主题切换沿用现有 `theme.tsx`。

### D4 字体
用 `@fontsource-variable/inter` 自托管 opsz 版本，在 `globals.css` 引入，`font-display: swap`，只预加载拉丁子集；中文回退系统字体。不使用外部字体 CDN（隐私与 CSP）。

### D5 依赖边界与规范检查
- `check-deps.rules.json` 增加「仅 `@saas/ui` 可依赖」清单：`radix-ui`、`@radix-ui/*`、`@base-ui/*`、`motion`、`framer-motion`、`lucide-react`、`class-variance-authority`。`@radix-ui/*` 在任何包都禁止（D1 已改写）。
- 新增 `scripts/check-ui.mjs`（并入 `pnpm check`）：对 `apps/**/src/**/*.tsx` 用 TypeScript AST 检查颜色字面量（hex/rgb/hsl/oklch）、className 中的任意值（`-[...]`）、`<select>` 元素、`confirm(`/`alert(` 调用。例外写在 `scripts/check-ui.allow.json`，逐文件加原因（OG 图、第三方品牌图标），与 `check-deps` 的逐文件登记方式一致。

### D6 预览页
路由 `apps/web/src/routes/dev/ui.tsx`，`beforeLoad` 在服务端读取非密钥变量 `UI_PREVIEW`，未设为 `true` 时抛 notFound；`wrangler` 的 dev 与 staging 配置设为 `true`，production 不设。路由排除在预渲染与 sitemap 之外。页面按组件分节展示变体，顶部可切换预设、明暗、shape、density。
- 备选：Storybook。放弃原因：多一套构建与依赖，且看不到真实路由环境。

### D7 设计工作流与镜像
- 设计规范文档 `docs/design-system.md`：分层、token 表、组件用法、动效、页面模式、参考来源、镜像地址与最近同步提交。
- 镜像：Claude 用 Design System Artifact 类型发布，内容由仓库 token 与预览截图生成；每次 token 或组件规范 PR 合并后由协调者更新，文档记录同步提交。
- 设计稿：每个需要设计关卡的需求，Claude 用 Design Artifact 类型产出画板（桌面/移动 × 浅/深 × 正常/空/加载/错误），使用者在画布评论确认；确认后的链接写进该需求 OpenSpec 的 design.md，作为验收依据。
- `ui-design` 技能固化以上步骤，并给出「免设计稿」的判断标准；`new-page`、`new-static-page` 第 1 步改为检查设计稿链接，没有时转入 `ui-design`。

### D10 衍生项目继承与专属设计
以 xuanxue 现状为样板：它已有项目 token 文件 `site-theme.css`（`data-site` 多站点，映射到 shadcn 变量）、`docs/design/visual-system.md` 与 `prototypes/*.dc.html` 原型副本，`packages/ui` 未改动；唯一隐患是在模版文件 `app.css` 中加了 import。

归属：
- 模版拥有：`packages/ui/src/components`、基线与预设 token、`check-ui` 与模版例外清单、预览页、技能、`docs/design-system.md`。
- 项目拥有：`apps/web/src/styles/brand.css`（模版入口 CSS 已在最后导入它，项目无需改 `app.css`）、`packages/ui/src/project/`（模版只放 `.gitkeep` 并在 `package.json` 预置 `./project` 导出，指向 `src/project/index.ts`，该文件由模版创建后不再修改）、`docs/design/`、`scripts/check-ui.allow.local.json`、`template.config.ts` 中 `ui` 段取值。

根文档属性扩展（6.4）：项目拥有 `apps/web/src/features/theme/html-attributes.ts`，模板只创建返回空对象的
`getProjectHtmlAttributes({ host, locale, pathname })`，之后不再修改，生成器逐字节保留。类型与过滤、
服务端接入仍由模板维护。根路由 beforeLoad 调用扩展并序列化过滤后的结果，SSR、预渲染与首次水合使用
同一份属性；pathname 改变时重新读取。pathname 为不含语言前缀和查询参数的路由路径，host 为
请求 URL 的 host（含非默认端口）。允许字符串值的 `data-*`、`title`、`dir`（ltr/rtl/auto）、
`translate`（yes/no）；`lang`、`data-preset` 与其余属性被忽略并记录不含属性值的警告。
多站点将 `data-site` 的计算移到此文件，`brand.css` 使用相应选择器，避免修改模板根布局。
预渲染使用构建请求的 host；不同域名需要不同属性时，应按域名分别构建或使用 SSR，不能将同一份
静态 HTML 按访问域名变化作为此扩展点的能力。

防止项目改模版组件：模版生成 `packages/ui/components.lock.json`（组件文件相对路径 → 内容哈希），模版的 `check-ui` 断言清单与文件一致；在衍生项目中同一检查对比哈希，不一致即失败并给出定制顺序（token → ui 配置 → project 包装 → 复制到 `project/` 并登记 `docs/design/forks.md`）。清单随模版同步更新，因此项目不需要维护它。判断「是否衍生项目」用 `.template-base.json` 是否存在。
- 备选：不检查、靠约定。放弃原因：agent 修样式时最容易直接改组件，冲突会在下次同步才暴露。

项目专属设计流程：定方向（参考 → 项目 Design System Artifact → `brand.css` + `visual-system.md`）→ 每个新页面经 `ui-design` 出画布稿并确认 → 副本存 `docs/design/prototypes/<页面>.html` 并在 OpenSpec 中同时记录链接与副本路径 → 实现与截图验收。template-sync 技能在同步涉及 `packages/ui` 或基线 token 时，合并前对 staging 预览页与项目关键页截图对比，偏差在项目层修正。通用的项目组件按惯例回流模版，同步后删除项目副本。

### D8 分工
组件接入、适配模式、预览页、技能与第一处替换样例由 Claude 完成（审美与交互敏感）；样例合并后，其余原生 select / confirm / admin 私有组件的机械替换交给 Codex 并行，按功能目录切分，避免同时改同一文件。

### D9 验证 spike 先行
正式接入前在独立 worktree 接 Button、Dialog、Select，验证：D1 改写可行、`check:singletons` 通过、首屏无主题闪烁、Inter opsz 生效、`@saas/ui` 进入首页 bundle 的增量（gzip）与 Lighthouse。spike 结论写进本文件「Spike 结论」一节；若增量超过 25 KB gzip 或 Lighthouse 下降，营销页改为只用无动效变体，再继续。

### D11 xuanxue 基础需求的 UI 部分（设计关卡实战验证）
来源：`~/.claude/codex-specs/saas-template/2026-11-10-foundation-from-xuanxue.md`。模版不得出现任何命理概念，示例数据用中性领域。

- **评审分两批**：第一批确认基线风格与 `/dev/ui` 组件预览（第 3、4 组产物）；第二批一次评审 6 个页面画板：工作台布局、长文阅读器、定价页并列、账单页分区、营销新区块、嵌入式对话与评分。等待评审期间推进不依赖设计稿的任务。确认后的模版设计稿副本放在 `docs/design-system/prototypes/`（模版文档的一部分，生成器不复制到衍生项目）。
- **工作台**：`apps/web/src/features/app-shell/` 新增导航注册表 `registerAppNav({ group, items })`，项目在自有文件中注册，避免改热点路由文件。`template.config.ts` 增加 `ui.appLayout: 'sidebar' | 'topbar'`，模版默认 `sidebar`；已有衍生项目在升级说明中可设 `topbar` 保持原样。折叠状态存 cookie，SSR 直接按状态渲染，避免闪烁。
- **长文阅读器**：放 `packages/ui`，用 `react-markdown` + `remark-gfm`，`skipHtml` 并限制 URL 协议；目录由标题节点生成，进度与吸顶高亮用 IntersectionObserver。打印样式用 `@media print`。PDF 扩展点为 `registerPdfExporter(fn)`，未注册时只显示浏览器打印。聊天消息以后可复用同一渲染器。
  - 备选：复用构建期 MDX（content-collections）。放弃原因：报告正文是运行时数据，Worker 不允许执行 MDX 编译结果。
- **业务界面组件**：放 `packages/ui`（纯展示，属性进、回调出，无数据请求）；`apps/web` 只在 `/dev/ui` 用示例数据挂载。组件接口在 `docs/design-system.md` 列出，供 R1–R4 的后端变更接入；这些变更可与本变更并行，先用现有界面，本变更合并后再替换。
- **营销区块**：放 `apps/web/src/features/marketing/sections/`，内容来自 `template.config.ts` 与文案文件；背书区块没有配置值时返回 null。悬浮入口用 CSS 定位与页脚留白，避免遮挡。
- **定价与账单**：定价页按套餐类型分组渲染，月付/年付切换只作用于订阅组；账单页按「订阅 / 积分包 / 免费积分」分区，免费积分分区在没有数据来源时不渲染（R3 合并后自动出现）。

## Spike 结论

2026-11-10 在 worktree `ui-foundation` 完成 tasks 1.1–1.2（同一 PR 含 3.1–3.3），测量均为本地 `pnpm --filter @saas/web build` 后 `vite preview`（workerd），证据在私有证据库 `ui-design-system/spike-2026-11-10/`。

- **D1 改写可行**：Button、Dialog、Select 及其 registry 依赖（tokens、surfaces、type-scale、springs、shape/size/icon/surface context、elevated、popup、scroll-area、use-fluid-hover、use-keyboard-nav-gate、use-touch-primary、fluid-provider）共 19 个文件按规则移植；组件源码无 `next/*` 引用，只需 `radix-ui` 命名导入、相对路径、去 `"use client"` 与 `exactOptionalPropertyTypes` 的少量改写。`@saas/ui` typecheck、全部测试与 `check:singletons` 通过；现有 Button 调用方与 SSR 断言未改动即通过（底色层改用 `::before`，见 `packages/ui/UPSTREAM.md`）。
- **首页 JS 增量**：首页引用的 JS 合计 gzip 从 205,292 B 降到 184,360 B（−20.9 KB）。下降来自给 `@saas/ui` 声明 `"sideEffects": ["*.css"]`：此前 `forwardRef(...)` 等顶层调用让 Rollup 保留了首页未用到的组件（未声明时接入 Dialog/Select 会使首页 +85.6 KB）。只计 Fluid 的增量（与「仅加 sideEffects」的基线 180,151 B 相比）为 **+4.2 KB**：Button 约 +1.9 KB，`UiRoot`（MotionConfig 与三个 Provider）约 +2.0 KB，rebase 到含 #301 的 main 并把字体预加载移到 `@saas/ui/fonts` 子路径后复测为 184,932 B（约 +4.8 KB），均低于 D9 的 25 KB 阈值，无需改为无动效变体。CSS gzip 7.3 KB → 12.4 KB（预渲染页内联，含字体声明与 token）。
- **动效库只随交互组件加载**：Dialog + Select 单独打包（esbuild，外置 React）约 105 KB gzip，其中 motion 约 48 KB、Radix 约 36 KB、组件自身约 21 KB；首页与定价页不加载。4.x 在 app/admin 页面大量使用前，评估把 `motion.*` 改为 `LazyMotion` + `m.*`（`domAnimation`）。
- **Lighthouse**（变更前 → 变更后；性能分在本机波动大，仅供参考）：首页移动端 可访问性/最佳实践/SEO 100/100/100 → 100/100/100，性能 31 → 62，CLS 0.118 → 0.121；首页桌面 性能 87 → 95，CLS 0.045 → 0.047；定价页移动端 100/100/100 不变，性能 66 → 64；定价页桌面 性能 96 → 98。移动端 CLS ≈ 0.12 为变更前已有。
- **审阅修复后复测**（#303 审阅：token 分层、destructive / 焦点环对比度、正文 14px 等）：首页 JS gzip 185,069 B（相对变更前 −20.2 KB；相对只加 sideEffects 的基线约 +4.9 KB），CSS 12.6 KB；Lighthouse 可访问性/最佳实践/SEO 仍为 100（首页与定价页、移动与桌面），首页移动 CLS 0.120、桌面 0.046；字体预加载经 React `preload()` 输出，位于样式表之前；闪烁检查 12/12 通过。
- **首屏明暗无闪烁**：Playwright 在任何脚本前挂观察器，`/`、`/pricing`、`/zh` × 系统浅/深 × 存储浅/深/未设置共 12 组，`<body>` 出现时 `<html>` 的 `dark` 类即为最终值，首帧与最终背景色一致；`data-preset` 由 SSR 写出。
- **Inter opsz**：`@fontsource-variable/inter/opsz.css` 自托管，按 unicode-range 分子集，根布局预加载拉丁子集（73 KB woff2）；页面计算字体为 `Inter Variable`，中文回退系统字体。
- **预设**：同一构建内切换 `data-preset`，主按钮底色、按钮/卡片圆角与焦点环随之变化；改 `template.config.ts` 为 violet 重新构建后 SSR 输出 `data-preset="violet"`，浅/深色主按钮为 `#7c3aed` / `#a78bfa`、圆角 12px。

## Risks / Trade-offs

- [Fluid 月度破坏性变更] → 复制进仓库、不自动升级；`UPSTREAM.md` 记录每个组件的上游月份，按季度对照 changelog 选择性合并。
- [motion 增加包体积] → 营销页组件优先用 CSS 过渡；motion 只在交互组件中按需导入（`LazyMotion` + `domAnimation`）；D9 设定阈值。
- [现有组件 API 变化影响调用方与测试] → D1 第 4 条保留公开 API；替换后跑全量 typecheck 与测试。
- [衍生项目已手改 `globals.css`] → 升级说明要求先把自定义变量迁入 `brand.css`，再同步；冲突按 template-sync 逐个处理。
- [设计关卡拖慢小改动] → 明确免设计稿范围；关卡只在技能中执行，不做 CI 强制。
- [镜像与仓库漂移] → 文档记录同步提交；合并 token/组件 PR 的清单中包含「更新镜像」。
- [默认改为侧边栏影响已有衍生项目] → 升级说明给出 `ui.appLayout: 'topbar'`；同步后 e2e 覆盖两种布局。
- [与 R1–R4 后端变更并行时接口不一致] → 组件接口先在 `docs/design-system.md` 定稿并经协调者确认，后端变更按此接入。
- [Markdown 渲染的 XSS 风险] → 禁用原始 HTML、限制协议，测试覆盖脚本、事件属性与 `javascript:` 链接。

## Migration Plan

1. 模板按 tasks 分批合并；组件替换期间旧组件与新组件可并存，最后删除 admin 私有组件。
2. 发布模板新版本时附升级说明：创建 `brand.css`、迁移自定义变量、在 `template.config.ts` 增加 `ui` 段、设置 staging 的 `UI_PREVIEW`。
3. 回滚：回退代码即可，无数据库与数据变更。

## Open Questions

- 四套预设的具体强调色取值在 3.1 定稿，并在第一批设计评审（8.1）中由使用者确认。
- AI 聊天页采用 Fluid AI 组件还是 AI Elements，在任务 9.1 对比后另起变更。
