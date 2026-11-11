# Tasks

## 1. 验证 spike（Claude）

- [x] 1.1 在独立 worktree 按 design D1 接入 Fluid 的 Button、Dialog、Select（Radix 版），改写为 `radix-ui` 导入与包内相对路径；验证 `pnpm --filter @saas/ui typecheck`、`test` 与 `pnpm check:singletons` 通过
- [x] 1.2 接入 Inter 可变字体（opsz）与 `UiRoot` 原型，本地首页切换明暗无闪烁；测量首页 `@saas/ui` bundle 增量（gzip）与本地 Lighthouse，结论写入 design.md「Spike 结论」，超过阈值时按 D9 调整方案后再进入第 2 组

## 2. 依赖边界与规范检查

- [x] 2.1 扩展 `scripts/check-deps.rules.json` 与 `check-deps.mjs`：交互原语/动效/图标库仅 `@saas/ui` 可依赖，`@radix-ui/*` 全局禁止；`check-deps.test.mjs` 覆盖 web 直接导入失败与 ui 导入通过
- [x] 2.2 新增 `scripts/check-ui.mjs`、`check-ui.allow.json` 与测试，检查颜色字面量、任意值 className、`<select>`、`confirm`/`alert`；登记 OG 图与第三方品牌图标例外，其余现存违例暂登记为待替换（第 5 组清零）；并入 `pnpm check`，验证命令在当前主干通过

## 3. token、预设与品牌层

- [x] 3.1 以 Fluid 默认视觉为中性基线更新 `globals.css`（不按特定参考调整），新增 neutral、blue、violet、green 四套 `presets/*.css`；测试断言每个预设浅/深色正文对比度 ≥ 4.5:1
- [x] 3.2 `template.config.ts` 增加 `ui` 段（preset、shape、density），根布局 SSR 写入 `data-preset` 并用 `UiRoot` 包裹；新增 `apps/web/src/styles/brand.css`（仅注释示例）并在入口 CSS 最后导入；验证切换预设后重新构建，组件强调色与圆角随之变化
- [x] 3.3 模板发布检查新增断言：`brand.css` 自创建提交后未被修改；`template-release.test.mjs` 覆盖修改时失败

## 4. 组件库补齐（Claude）

- [x] 4.1 按 D1 接入 Dialog、AlertDialog（确认对话框，含多语言默认文案与焦点返回）、Select、Textarea、Checkbox、Switch、Badge、Tooltip，并更新 Button、Input 样式（保持公开 API）；每个组件有渲染与键盘交互测试，减少动态效果下无位移动画；Input 与 Button/Select 完整对齐（字号、边框、焦点环改为 2px 描边加间隙，#303 只改了圆角）
- [x] 4.2 接入 Tabs、Dropdown、Sidebar、Toast、Combobox、Command Menu；DataTable、Form 吸收新样式且现有调用方测试不变；`UPSTREAM.md` 记录每个组件来源与上游月份
- [x] 4.3 新增预览页 `routes/dev/ui.tsx`（D6）：`UI_PREVIEW` 未开启返回 404、排除预渲染与 sitemap，可切换预设/明暗/shape/density；测试覆盖生产 404 与 sitemap 不含该地址；dev 与 staging 的 wrangler 配置设置 `UI_PREVIEW=true`
- [x] 4.4 悬停与当前项改用 Fluid 交互 token：admin 侧栏悬停/当前项、docs 目录、DataTable 表头与行悬停由 `bg-accent` 改为 `bg-hover` / `bg-active`（`--accent` 保持 Fluid 原值，作为较重的强调底）
- [x] 4.5 评估 `SelectItem` 的 `index` 在 `SelectContent` 内自动编号：index 同时驱动 fluid-hover 注册与渲染期的高亮判断，自动编号需挂载后按 DOM 顺序测量，可能造成首帧高亮错位；评估通过再改，否则在组件文档中保留显式 index
- [x] 4.6 Dialog `closeLabel`、Select `placeholder` 等英文默认值由应用层按语言传入（`apps/web` 封装或调用处传 `m.*()` 文案），并在 `docs/design-system.md` 写明哪些属性必须传多语言文案

## 5. 替换原生控件与私有组件

- [x] 5.1 （Claude）以 admin 一个列表页为样例，替换原生 select、confirm 与 `features/admin/ui.tsx` 中的 Textarea/NativeSelect，形成替换模式说明；该页测试与 e2e 通过
- [x] 5.2 （Codex，可并行，按功能目录切分）按 5.1 模式替换其余原生 select 与 confirm；每个 PR 的 `pnpm check`、typecheck 与相关测试通过
- [x] 5.3 删除 admin 私有的 Textarea、NativeSelect、CheckboxField，并清空 `check-ui.allow.json` 中的待替换登记；`pnpm check` 通过

## 6. 衍生项目继承机制

- [x] 6.1 预留 `packages/ui/src/project/`（`.gitkeep` 与空 `index.ts`）与 `@saas/ui/project` 导出；`check-ui` 与依赖检查覆盖该目录；验证在临时生成项目中新增项目组件并使用后检查通过
- [x] 6.2 生成 `packages/ui/components.lock.json` 与校验：模版内清单过期时失败；存在 `.template-base.json` 时修改模版组件失败并提示定制顺序；`check-ui.allow.local.json` 被读取；测试覆盖三种情况
- [x] 6.3 生成器在副本中创建空的 `check-ui.allow.local.json` 与 `docs/design/README.md`（说明视觉规范、参考、原型副本与 forks 登记的位置）；`create-project.test.mjs` 断言文件存在且生成结果确定
- [x] 6.4 根布局提供项目自有的站点/主题属性扩展点（项目自有文件返回 `<html>` 额外属性，如 `data-site`），避免项目改模板根布局；测试覆盖未注册时输出不变与注册后 SSR 写入属性

## 7. 设计规范文档、技能与生成器

- [x] 7.1 编写 `docs/design-system.md`（分层、token 表、组件用法、动效、页面模式、参考来源、免设计稿标准），更新 `docs/02-project-structure.md` 与 `AGENTS.md` 的 ui 说明；文档中的命令可按原样运行
- [x] 7.2 新增 `ui-design` 技能（`.agents/skills` 与 `.claude/skills` 逐字节一致），覆盖索取参考、衍生项目建立视觉方向（`brand.css`、`docs/design/visual-system.md`、多站点）、Design 画布设计稿的状态矩阵、确认、副本存 `docs/design/prototypes/` 并在 OpenSpec 记录链接与副本、实现只用 `@saas/ui` 与 `@saas/ui/project`；template-sync 技能新增「涉及 `packages/ui` 或基线 token 时合并前截图对比」步骤；`new-page`、`new-static-page` 第 1 步改为检查设计稿链接；技能双目录一致性测试通过
- [x] 7.3 生成器新增 `--theme`（非法值列出可用预设并退出），写入模板配置与 `.template-base.json`；`create-project.test.mjs` 覆盖合法、非法与确定性，`pnpm test:create-project:verify` 通过
- [x] 7.4 用 Design System Artifact 发布设计规范镜像，`docs/design-system.md` 记录镜像地址与同步提交

## 8. xuanxue 基础需求 UI（设计关卡实战验证）

- [x] 8.1 设计评审第一批：基线风格与 `/dev/ui` 组件预览发布为 Design 画布，使用者确认；确认链接与副本记录在 `docs/design-system/prototypes/`
- [x] 8.2 设计评审第二批：用 `ui-design` 流程产出 6 个页面画板（工作台布局、长文阅读器、定价页并列、账单页分区、营销新区块、嵌入式对话与评分），覆盖桌面/移动 × 浅/深 × 空/加载/错误，使用者确认后保存副本；8.3–8.7 以副本为验收依据
- [ ] 8.3 工作台侧边栏（R5.1）：`registerAppNav` 注册表、`ui.appLayout`（默认 sidebar）、折叠状态 cookie、移动端抽屉与焦点返回、底部升级与账户入口；单元测试覆盖注册与高亮，e2e 覆盖两种布局、390px 无横向滚动
- [x] 8.4 长文阅读器（R5.2）：安全 Markdown、自动目录、吸顶高亮、阅读进度、打印样式、浏览器打印导出与 `registerPdfExporter` 扩展点；测试覆盖脚本/事件属性/`javascript:` 链接被拒、目录跳转、未注册扩展时不显示服务端导出
- [ ] 8.5 营销区块（R5.4）：数据背书（无配置不渲染）、三步流程、编号产品矩阵、悬浮 AI 入口；预渲染测试通过，首页本地 Lighthouse SEO 与可访问性 100
- [x] 8.6 业务界面组件（R1–R4 UI）：推荐追问按钮组、消息评分与反馈（可修改与撤销）、嵌入式对话外壳、余额不足弹窗、预计消耗、会员锁定态、每日领取提示；纯展示组件的渲染与交互测试通过，`/dev/ui` 用中性示例数据展示，接口写入 `docs/design-system.md`
- [ ] 8.7 定价页订阅与积分包并列（月付/年付只作用于订阅）、账单页「订阅 / 积分包 / 免费积分」分区布局（无数据来源的分区不渲染）；`marketing-pricing` 等现有测试更新并通过，覆盖只有积分包时不显示切换

## 9. 选型与集成验收

- [x] 9.1 对比 Fluid AI 组件与 AI Elements 接入现有聊天页（基于 `@ai-sdk/react`）的差异，结论写入 `docs/design-system.md` 并另起变更，不在本变更替换
- [ ] 9.2 编写模板升级说明（创建 `brand.css`、迁移自定义变量、`ui` 配置段、`UI_PREVIEW`、项目例外清单、`ui.appLayout` 可设 `topbar` 保持原布局、新营销区块与业务组件的接入方式）；以 xuanxue 为例写明迁移：`site-theme.css` 并入 `brand.css`、`app.css` 恢复模版原样、插画组件颜色登记例外，按说明在 xuanxue 的同步分支本地执行检查通过（不推送）
- [ ] 9.3 staging 验收：首页、定价页、博客中英文 Lighthouse SEO 与可访问性仍为 100；预览页可访问、生产 404；明暗切换无闪烁；新增组件与页面在 390px 宽无横向滚动、浅色与深色正确；证据写入私有证据库
- [ ] 9.4 发布模版版本后通知 xuanxue 协调会话，附版本号、升级说明与业务组件接口文档

## 后续（不阻塞本变更，按需另开任务）

- 强制颜色模式（`forced-colors`）下按钮底色层、焦点环与 Select 高亮的可见性
- 裁剪 Inter 子集（只保留实际用到的字符范围）与 surface 6–8 等未用 token
- 回退字体加 `size-adjust`，减少字体替换时的版面跳动
- `:focus-visible` 兜底焦点环的圆角跟随元素自身圆角
- 焦点环类名（`fieldFocusClasses`）抽到 lib 统一复用：目前 Button、Select、Checkbox、Switch 各写一份同样的 `outline-2 outline-offset-2` 串（上游文件，合并时注意）
- 选中态复选框（方框消失只留勾）与实心 destructive 按钮变体：分别在 4.2、5.x 结合页面再定
- 开关 hover 宽度动画（`m.span`）未进 `motion-features.test.tsx`，目前只靠静态检查保证在 MotionFeatures 之下
- `brandFileErrors` 在浅克隆（CI `fetch-depth` 较小）下找不到创建提交时的行为与测试
- 将组件 lock 摘要写入 `.template-base.json`，校验模板指纹清单本身的完整性
- 评估将指纹范围扩展到 `packages/ui/src/lib/`、`hooks/` 与 `styles/`
- Toast 与 Tooltip、Dialog 的层级关系（`--z-toast` 在模态之上；Toast 内的 Tooltip、模态打开时视口的 aria-hidden）实测后定稿
- Sidebar 拖拽调整宽度后的 `onWidthChange` 回调（布局持久化宽度，8.3 需要时补）
- 预览页补充各组件的状态说明短文案与空 / 加载态示例（8.1 评审时按反馈调整）
