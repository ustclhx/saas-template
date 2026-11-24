## Why

模板接下来要增加 agent、生图站、视频站三块较重的 AI 能力，但衍生项目的需求差别很大：xuanxue 不需要图片与视频，未来的生图站不一定需要 agent。目前所有功能都靠 `template.config.ts` 的运行时判断开关：`ai.image: false` 只隐藏导航、过滤模型，媒体路由、页面、fal 客户端与 `AiMediaWorkflow` 仍全部进入 web 与 jobs 的构建产物。功能越多，未使用的代码、依赖与 Cloudflare 绑定越多。

同时衍生项目通过 template-sync 三方合并采纳模板更新，如果生成器把不要的功能从副本中物理删除，每次同步都会出现「副本删除、模板修改」的冲突。

因此需要一个**构建期插件机制**：插件源码随模板留在副本中，未启用的插件在构建期不进入路由树、服务端入口、jobs 入口与绑定清单。第一个迁移进来的是现有媒体能力，用来验证机制；随后的 `add-ai-agents`、生图站、视频站都以插件形式交付。

## What Changes

- 新增插件目录 `plugins/<id>/`（pnpm workspace 包 `@saas/plugin-<id>`），每个插件有一份静态清单：支持的部署目标、依赖的其他插件与模板开关、web 路由目录、web/jobs 入口、文案目录、所需绑定与密钥名称。
- `template.config.ts` 新增 `plugins` 字段（启用的插件 id 列表，可带每个插件自己的配置段），由 `@saas/config` 校验依赖关系与开关组合。
- 构建期按启用列表生成注册文件（gitignored，与 `routeTree.gen.ts` 同类）：web 路由树通过 TanStack Router 虚拟路由挂载启用插件的路由目录；web Worker 与 jobs Worker 只从生成文件导入启用插件的入口（导出类、fetch 前置处理、Workflow、队列、Cron、积分预扣清理器）；文案只编译启用插件的消息。
- 核心与插件之间的扩展点：应用区导航、后台菜单、Worker fetch 前置处理、jobs 注册、积分预扣清理器、对话消息部件渲染器、权益键。核心代码不再直接引用某个插件。
- 数据库表结构与迁移仍集中在 `packages/db`，所有插件共用一条迁移链；未启用插件的表为空表。
- 只支持 Cloudflare 的插件在 Node（selfhost）构建中自动排除并给出提示；生成器对 selfhost 目标拒绝启用这类插件。
- 新增插件一致性检查（并入 `pnpm check`）：启用插件声明的绑定在 wrangler 各环境中存在，未启用插件导出的 Durable Object / Workflow 类不再被绑定引用，`check-deps` 覆盖 `plugins/` 并约束核心与插件、插件之间的依赖方向。
- 生成器新增 `--plugins`，写入 `template.config.ts` 与 `.template-base.json`；template-sync 的参数推断识别 `plugins`。
- **BREAKING（配置）**：现有媒体能力迁移为 `media` 插件。`ai.image` / `ai.video` 保留为媒体插件内的种类开关，但只有 `plugins` 含 `media` 时才生效；衍生项目同步后需在 `plugins` 中声明 `media`（升级说明给出一行迁移）。图片与视频都关闭的项目同步后不再打包媒体代码与 `AI_MEDIA_WORKFLOW` 绑定。

不在本次范围：agent 能力（`add-ai-agents`）、生图站与视频站产品层（后续 change）、插件市场或独立发布到 npm、运行时（不重新部署）启停插件、按插件拆分数据库迁移链。

## Capabilities

### New Capabilities

- `plugin-system`: 插件清单、启用配置与校验、构建期剔除未启用插件、核心扩展点、部署目标约束与一致性检查。

### Modified Capabilities

- `project-bootstrap`: 生成器支持选择插件，并按部署目标拒绝不支持的插件；基准记录包含插件列表。
- `template-sync`: 同步与基准推断使用插件列表重建基准副本。
- `ai-media-tasks`: 媒体任务能力只在启用 `media` 插件时存在；未启用时相关页面、接口与 Webhook 不存在（404），构建产物不含媒体执行代码。

## Impact

- 新目录 `plugins/`，`pnpm-workspace.yaml` 增加 glob；`plugins/media` 承接 `apps/web/src/features/ai-media`、媒体相关路由与 Webhook、`apps/jobs/src/workflows/media-runner.ts` 及 Node 媒体运行时。`packages/ai/src/media`、`packages/storage/src/media.ts` 等纯能力代码留在原包。
- `apps/web`：`vite-shared.ts`（虚拟路由、生成注册文件）、`src/server.ts`（导出与 fetch 前置处理改为读生成文件）、`app-shell` 导航、`server/cloudflare/env.ts`、`node/runtime.ts`、`scripts/i18n-project.ts`、tsconfig 与 Tailwind 扫描范围。
- `apps/jobs`：`src/index.ts`、`src/ai.ts`、`src/node/*` 改为读生成的插件注册。
- `packages/config`：`plugins` 类型、默认值与校验。
- `scripts/`：`check-deps`、新增插件一致性检查、`create-project`、`template-base`、`template-sync/infer`。
- 文档：新增 `docs/plugins.md`，更新 `02-project-structure.md`、`06-ai.md`、`create-project.md`，发版时写升级说明。
- 不改数据库结构，不影响计费与积分账本规则。
