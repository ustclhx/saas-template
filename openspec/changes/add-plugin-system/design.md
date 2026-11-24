## Context

现状（2026-11-23 调研）：

- `template.config.ts` 是 TS 模块，被 `apps/web/vite.config.ts`、`apps/web/scripts/vite-shared.ts`、`apps/web/src/server/template-config.ts`、`apps/jobs/src/index.ts` 等直接导入；客户端通过 `client-template-config.ts` 的 Vite `load` 钩子替换为 JSON。
- 功能开关全部是运行时判断。媒体相关代码分散在 web 的 9 个路由文件、`features/ai-media`、`features/ai/media-tasks.ts`、`features/api-keys/tasks.ts`、导航、`server/cloudflare/env.ts`、`src/server.ts`、`node/runtime.ts`，以及 jobs 的 `index.ts`（`AiMediaWorkflow` 无条件导出）、`ai.ts`（`mediaTaskHoldSweeper`）、`node/*`。
- 已有的构建期生成物：`routeTree.gen.ts`、Paraglide 输出（`i18n-project.ts` 按配置写 inlang 设置）、content-collections、定价快照与 OG 图。没有 Vite 虚拟模块。
- 路由树由 TanStack Start 插件以默认设置生成（`src/routes`）。已安装的 `@tanstack/router-generator` 1.167 支持 `virtualRouteConfig`，`@tanstack/virtual-file-routes` 1.162 提供 `rootRoute / physical / route / layout`，Start 插件的 router 选项会透传。
- wrangler 配置手写，staging / production 为同文件内的 env 块；生成器在创建项目时用正则删除无媒体时的 `workflows` 与 `ai` 绑定，之后不再改动。`check-wrangler-envs.mjs` 只检查环境间一致性。
- 部署目标只记录在 `.template-base.json` 的 `params.target`，`template.config.ts` 中没有。
- `check-deps` 只扫描 `apps/` 与 `packages/`；`cloudflare:*` 导入只允许出现在 platform 与登记的组合入口文件中。
- template-sync 用 `record.params` 重新生成基准与目标副本做三方合并；`*.project.ts(x)` 为项目自有文件，不被覆盖。

## Goals / Non-Goals

**Goals:**

- 未启用插件的代码、依赖与绑定不出现在 web（Worker 与 Node）及 jobs 的构建产物中。
- 插件源码随模板留在衍生项目里，template-sync 不因启停插件产生冲突。
- 核心不直接引用任何插件；插件通过有限的扩展点接入。
- 用现有媒体能力验证机制：迁移后行为不变，关闭时产物中不含媒体执行代码。
- 为 `add-ai-agents` 提供 Durable Object 导出、Worker fetch 前置处理、仅 Cloudflare 目标等能力。

**Non-Goals:**

- 运行时（不重新部署）启停插件；第三方插件市场；发布到 npm。
- 按插件拆分数据库迁移；按插件拆分 wrangler 文件。
- 自动生成 wrangler 配置（保持手写，改为检查一致性）。

## Decisions

### 1. 插件是 `plugins/<id>/` 下的 workspace 包

每个插件是 `@saas/plugin-<id>`，目录结构：

```
plugins/<id>/
  package.json        # 插件自己的依赖（例如 agents 插件的 `agents`、`@cloudflare/ai-chat`）
  plugin.ts           # 静态清单，不导入运行时代码
  routes/             # web 文件路由，挂载到清单声明的前缀下
  src/web/…           # 服务端函数、页面组件、web 入口 web.ts / worker.ts
  src/jobs/…          # jobs 入口 jobs.ts（Workflow 类、队列、Cron、清理器）
  src/node/…          # 可选：Node 目标的 web / jobs 入口
  messages/<locale>/  # 文案
  test/
```

`apps/web` 与 `apps/jobs` 在 package.json 中依赖全部插件包：安装时总是存在，打包时只导入启用的部分。选择 workspace 包而不是 `apps/web/src/plugins/<id>`，是为了让一个插件的 web、jobs、依赖和测试在同一个目录里，启停与审阅都以目录为单位。

备选：放在 `apps/web/src/plugins/` 与 `apps/jobs/src/plugins/` 两处。更接近现有结构，但一个插件拆到两个地方，依赖只能加到 app 上（无论是否启用都声明）。如果第 1 组的验证任务发现 TanStack Start 无法编译 workspace 包里的 `createServerFn` 或路由文件，就退回这个方案，其余设计不变。

**验证结果（1.1，2026-11-24，不切备选方案）**：用临时插件 `plugins/example`（workspace 包，含 `app/$slug/example` 路由、`createServerFn`、web / worker / jobs / webNode / jobsNode 五个入口与文案）验证：

- `vite dev`：路由挂在 `/app/$slug` 布局下；客户端拿到的插件 `createServerFn` 已编译为 `createClientRpc` 存根，经 `/_serverFn/<id>` 调用返回服务端结果。
- `pnpm build`（Cloudflare）、`vite.node.config.ts` 构建、jobs `wrangler deploy --dry-run` 与 `build:node` 全部通过；服务端函数体只在服务端产物，Worker 入口的具名导出（类）出现在 `dist/server/index.js`，jobs 入口的类出现在 `apps/jobs/dist/index.js`。
- 插件包要自己声明运行时依赖（`@tanstack/react-router`、`@tanstack/react-start`、`react`，开发依赖 `@types/react`）：Vite 与 `tsc` 从插件目录解析这些导入。
- Tailwind：`app.css` 的 `@source "../"` 只扫描 `apps/web/src`，插件类名不会进入样式。生成器另写 `src/styles/plugins.gen.css`（只含启用插件目录的 `@source`），`app.css` 导入它；验证插件的类名出现在两目标的 CSS 中。
- tsconfig 不把 `plugins/*` 整体加进 `include`：未启用插件的路由文件引用不在路由树上的路径，会让类型化路由检查失败。启用插件的代码经生成文件的导入链进入 web / jobs 的类型检查（2.2 的 tsconfig 部分按此落实）。
- 插件代码需要使用 web 核心模块（Paraglide 的 `m`、app-shell 组件、`getWebRuntime`、导航与路由类型）。协调者确认（2026-11-24）：web 的 Vite 与 tsconfig 配置路径别名 `@web/*` → `apps/web/src/*`，只在 web 构建与类型检查中可解析；4.2 的 check-deps 只允许插件的 web 代码（`routes/`、`src/web/`、`src/node/` 的 web 入口）使用它，jobs 入口不得使用。

### 2. 清单与启用配置

`plugin.ts` 导出 `definePlugin({...})`，只含可静态读取的数据：

- `id`、`targets`（`['cloudflare']` 或 `['cloudflare', 'node']`）
- `requires`：依赖的插件 id，以及要求开启的模板开关（例如 billing、credits）
- `routes`：`{ dir: 'routes', mount: '/' }`；路由文件自己写完整路径（如 `app/$slug/media/new.tsx`），挂载点一般为根
- `entries`：`web`、`worker`（Cloudflare 专用导出与 fetch 前置处理）、`jobs`、`webNode`、`jobsNode` 的模块路径
- `bindings`：`{ web: [...], jobs: [...] }`，所需 Cloudflare 绑定名称与种类（durable_object / workflow / queue / ai …）
- `secrets`：所需密钥名称（生成器清单用）
- `messages`：文案目录

`template.config.ts` 新增：

```ts
plugins: {
  media: { providers: ['fal', 'workers-ai'] },
  agents: { … },
}
```

用对象而不是数组：键即启用，值为插件自己的配置段（插件导出 zod schema，由 `@saas/config` 在解析时校验）。已有的 `ai.mediaProviders` 迁到 `plugins.media.providers`；`ai.image` / `ai.video` 与 `ai.defaultPricingMode` 保留在 `ai` 下（它们是模型种类开关，后台模型管理也读取）。校验规则：

- 插件 `requires` 未满足、`ai.image || ai.video` 为真但未启用 `media` → 配置错误，构建失败。
- 未知插件 id → 配置错误。

### 3. 构建期生成注册文件

新增 `scripts/plugins/generate.mjs`（被 web Vite 配置、jobs 构建、`typecheck`、`test` 前置调用，与 `generate-route-tree.mjs` 同一时机），读取 `template.config.ts` 与各插件 `plugin.ts`，输出（均 gitignored）：

- `apps/web/src/plugins.gen.ts`：启用插件 `web` 入口的静态导入数组（导航项、后台菜单、消息部件渲染器、权益键）。
- `apps/web/src/plugins.worker.gen.ts`：启用插件 `worker` 入口的 `export *`（Durable Object 类等）与 fetch 前置处理列表；`src/server.ts` 只引用这个文件。
- `apps/web/src/plugins.node.gen.ts`：Node 目标的对应入口，只含 `targets` 包含 `node` 的插件。
- `apps/jobs/src/plugins.gen.ts` 与 `plugins.node.gen.ts`：jobs 入口导出的 Workflow 类、队列处理器、Cron、积分预扣清理器。
- `apps/web/project.inlang` 的消息来源追加启用插件的 `messages/`（扩展现有 `i18n-project.ts`）。

用生成文件而不用 Vite 虚拟模块，原因：`tsc` 与 vitest 都要能解析导入；jobs 由 wrangler/esbuild 打包，不走 Vite；生成文件可读，排查方便。

**实现说明（3.1–3.3）**：

- 生成器分为库 `scripts/plugins/plugins.mjs`（读取清单、`@saas/config` 的 `resolvePlugins` 校验、渲染文件、虚拟路由与文案目录）与命令 `generate.mjs`。web 的 Vite 配置（`vite-shared.ts`）、`vitest.config.ts` 在解析时直接调用库；`typecheck`、`test`、jobs 的 `build` / `build:node` / `dev` / `deploy:staging`，以及部署 workflow 的 jobs 构建步骤先运行 `generate.mjs`。
- 生成文件的 default 导出为 `{ id, entry?, bindings? }` 列表，`entry` 为入口模块的 default 导出；`plugins.worker.gen.ts` 与 jobs 的 `plugins.gen.ts` 另 `export *` 入口的具名导出（类），列表带上清单的 `bindings` 供运行时校验，只声明绑定、没有入口的插件也在列表中。
- 除上面五个文件外另生成 `src/styles/plugins.gen.css` 与 `plugins.node.gen.css`（`@source`）。两目标共用的代码（导航、后台菜单、消息部件）只导入 `plugins.gen.ts` / `plugins.gen.css`；Node 构建用 `resolveId` 把它们解析为 `plugins.node.gen.*`，排除仅 Cloudflare 的插件。`plugins.node.gen.ts` 的 default 导出与 `plugins.gen.ts` 同形，`nodePlugins` 为 webNode 入口。
- 内容不变时不重写文件，避免 dev 热更新与重复编译。

**构建期剔除依赖静态导入链**：核心代码只从 `*.gen.ts` 进入插件，未启用插件不在任何导入链上，自然不进入产物。验证方式见第 1、5 组任务：对构建产物做字符串检查（例如关闭媒体时产物中没有 `fal.media`、`AiMediaWorkflow`）。

### 4. 路由：虚拟路由配置

在 `vite-shared.ts` 传入 `router.virtualRouteConfig`：

```ts
rootRoute('__root.tsx', [
  physical('', 'routes'),                       // 核心 src/routes 原样挂载
  ...enabled.map((p) => physical(p.mount, relative(srcDir, p.routesDir))),
])
```

核心路由文件不移动，`routeTree.gen.ts` 的类型化路由覆盖核心与已启用插件的路由；未启用插件的路由不在树上，访问返回 404，与营销关闭时的行为一致。

风险：`physical('')` 挂根目录、跨包目录挂载、`routeFileIgnorePattern` 与现有 `-components` 等约定的组合需在第 1 组验证。退路：核心路由仍用默认 `routesDirectory`，插件路由用生成器把插件 `routes/` 同步复制到 `src/routes/(plugins)/<id>/`（gitignored）。复制方案对类型与编辑器跳转不友好，只作为退路。

**验证结果（1.1，2026-11-24，不切退路）**：

- 路径相对 `routesDirectory`（`apps/web/src/routes`）：核心挂载写作 `{ type: 'physical', pathPrefix: '', directory: '.' }`，插件为 `../../../../plugins/<id>/routes`。配置用普通对象传给 `tanstackStart({ router: { virtualRouteConfig } })`，不需要新增 `@tanstack/virtual-file-routes` 依赖。
- 与默认配置相比，生成的 `routeTree.gen.ts` 中全部路由 id / path / fullPath（976 处）完全一致，只有导入变量名不同（如 `indexnow[.]txt` 由 `IndexnowDottxt` 变为 `IndexnowChar91DotChar93txt`），`-components` 等忽略约定不受影响。
- 插件路由文件 `app/$slug/example.tsx` 挂到核心的 `/app/$slug` 布局下（`getParentRoute: () => AppSlugRouteRoute`）；`createFileRoute` 写错路径时 `tsc` 报错，类型化路由覆盖插件。
- 多语言路由（main 最近合并的语言前缀与多站点）：语言前缀由路由器 rewrite 与 `request.server.ts` 处理，插件路由与核心路由在同一棵树上，规则相同；应用区（`/app`）按 Cookie 取语言，不受影响。
- Node 构建按目标挂载：`targets` 不含 `node` 的插件不挂路由（`pluginRouteConfig(..., 'node')`）。
- 剔除效果（1.2）见下方「构建期剔除验证」。

### 构建期剔除验证（1.2，2026-11-24）

同一临时插件 `plugins/example`（每个入口、页面、服务端函数、文案与 Tailwind 类名各带一个特有字符串）分别启用与关闭，构建四个产物后用 `scripts/plugins/check-artifacts.mjs` 搜索（含 source map）：

```sh
APP_VERSION=$(git rev-parse HEAD)
pnpm --filter @saas/web build                                   # apps/web/dist（Cloudflare）
(cd apps/web && pnpm exec vite build --config vite.node.config.ts && node scripts/build-node-bootstrap.mjs)  # apps/web/.output
pnpm --filter @saas/jobs build                                  # apps/jobs/dist（wrangler --dry-run）
pnpm --filter @saas/jobs build:node                             # apps/jobs/.output
node scripts/plugins/check-artifacts.mjs --present <特有字符串...> [--only web,web-node,jobs,jobs-node]
node scripts/plugins/check-artifacts.mjs --absent <特有字符串...>
```

- 启用：页面、服务端函数与 web 入口的字符串出现在 web 两个产物；Worker 入口的 fetch 前置处理与具名导出类只在 `dist/server/index.js`；jobs 入口的类与定时任务在 `apps/jobs/dist/index.js`；Node 入口只在对应的 `.output`；插件类名进入两目标的 CSS。`vite dev` 中 Worker 前置处理先于路由返回，带请求日志与 `x-request-id`。
- 关闭：四个产物中插件的全部特有字符串、`plugins/example` 路径、消息键与类名均为 0 处。
- 仅 Cloudflare：把插件 `targets` 改为 `['cloudflare']` 后，两个 Node 构建成功并打印「插件 example 仅支持 Cloudflare，selfhost（Node）构建已排除」，Node 产物中没有其字符串与类名（`plugins.gen.ts` / `plugins.gen.css` 经别名解析为 Node 版本）。
- 5.4 复用上述命令，字符串换成 `AiMediaWorkflow`、`fal.media` 与媒体页面组件名。验证完成后 `plugins/example` 已删除，不合并进 main；仓库目前没有插件，`apps/web`、`apps/jobs` 在新增插件时于 package.json 声明对 `@saas/plugin-<id>` 的 `workspace:*` 依赖。

### 5. 核心扩展点

只开放以下扩展点，插件通过 web / jobs 入口导出：

| 扩展点 | 现状 | 改造 |
|---|---|---|
| 应用区导航、顶栏入口 | `nav.default.ts` 写死媒体项 | 合并 `plugins.gen.ts` 中的导航项，顺序由插件声明的 `order` 决定 |
| 后台菜单 | 写死 | 同上 |
| Worker fetch 前置处理 | 无 | `server.ts` 在 Start 处理前依次调用，返回 `Response` 即结束（agents 用于 `/agents/*`） |
| Worker 导出 | 只有 `fetch` | `export * from './plugins.worker.gen.ts'` |
| jobs Workflow / 队列 / Cron | `index.ts` 写死媒体 | 从 `plugins.gen.ts` 合并 |
| 积分预扣清理器 | `ai.ts` 写死 `mediaTaskHoldSweeper` | 插件导出清理器，jobs 合并注册 |
| 对话消息部件渲染器 | `registerToolRenderer` 已有 | 插件 web 入口调用，与 `*.project.tsx` 并存 |
| 运行时依赖（env、能力） | `server/cloudflare/env.ts`、`node/runtime.ts` 写死媒体 | 插件声明所需绑定；核心按清单校验存在性，插件自己读取 |

不做通用的事件总线或依赖注入容器；扩展点不够用时再按需新增，并记录在 `docs/plugins.md`。

**实现说明（3.4–3.6）**：

- web 约定在 `apps/web/src/features/plugins/contract.ts`（`appNav`、`adminNav`、`toolRenderers`、Node 的 `fetch`），Cloudflare Worker 约定在 `server/cloudflare/plugins.ts`（`fetch(request, env, ctx)`，具名导出原样导出）。导航登记顺序为模板 → 插件 → 项目（同 id 后者覆盖）；后台菜单追加到已有分组（people / billing / ai / operations）末尾。fetch 前置处理在网关与 Start 之前、日志与运行时上下文之内调用；Worker 外层对 101（WebSocket 升级）原样返回，不重新构造响应。
- jobs 约定在 `apps/jobs/src/plugins/contract.ts`：`crons` 挂在已有触发器上（heartbeat / ten-minute / daily，不新增 wrangler cron），与同组核心任务并行、任一失败则本次触发失败；`queues` 以基础队列名声明（Cloudflare 匹配 `name` / `name-staging` / `name-production`，Node 以 `name` 注册到持久队列）；`holdSweepers` 由入口登记；Node 入口另有 `registerWorkflows`，在 `engine.register` 内注册持久任务并返回内部 HTTP 路由与停止接收。
- 运行时绑定校验：`@saas/config` 的 `pluginBindingsShape` 按种类检查绑定形状；web 的 `checkEnv` 与 jobs 的 `requireEnv` 合并启用插件声明的绑定，必需绑定缺失时与核心绑定一样启动校验失败。Node 目标没有 Cloudflare 绑定，插件在自己的 Node 入口校验所需配置。`server/cloudflare/env.ts` 与 `node/runtime.ts` 中写死的媒体判断随第 5 组（media 清单声明 `AI_MEDIA_WORKFLOW`）一并删除（协调者确认，2026-11-24）。
- `ai.image || ai.video` 需要 `media` 的校验只在仓库存在 `media` 插件时生效：迁移前没有该插件，规则无法满足。

### 6. 部署目标

`targets` 不含 `node` 的插件：

- Node 构建（`vite.node.config.ts`、jobs `build:node`）生成的 `*.node.gen.ts` 跳过它，构建日志提示「插件 X 仅支持 Cloudflare，selfhost 构建已排除」。模板仓库自身同时启用全部插件时，selfhost 构建仍能成功。
- 生成器 `--target selfhost --plugins agents` 直接报错退出，不创建副本。

### 7. 一致性检查 `scripts/check-plugins.mjs`（并入 `pnpm check`）

- 启用插件清单中的每个 Cloudflare 绑定，在对应 wrangler 文件的顶层、`env.staging`、`env.production` 中都存在且种类一致。
- wrangler 中引用插件类的 Durable Object / Workflow 绑定，其插件必须启用（避免部署时类不存在）。
- `requires` 闭包满足、`targets` 合法、清单路径存在。
- 生成文件与当前配置一致（CI 中先生成再比对时间戳无意义，改为检查生成器对同一配置输出确定）。

`check-deps` 扩展：

- `readWorkspace` 扫描 `plugins/`。
- 核心（apps、packages）不得导入 `@saas/plugin-*`，只有 `*.gen.ts` 例外。
- 插件只能导入 `requires` 中声明的其他插件。
- 插件可依赖 packages 的公开入口；`cloudflare:*` 与 `agents` 等 Cloudflare 专用导入只允许出现在插件的 `worker` / `jobs` 入口目录，规则与现有组合入口一致。

### 8. 生成器与 template-sync

- `create-project --plugins media,agents`：写入 `template.config.ts` 的 `plugins` 对象（未选的键删除，选中的保留模板默认配置段）；`.template-base.json` 新增 `plugins` 列表参数（遵循 `optionalParams`：与默认值相同不写，旧生成器不受影响）。
- `--ai` 中含 image/video 时自动包含 `media`；`--media-providers` 映射到 `plugins.media.providers`。
- 生成时删除未启用插件的 wrangler 绑定（沿用现有 `wranglerConfig` 方式），并改为按清单声明删除，而不是写死 `workflows`。
- template-sync：`record.params.plugins` 参与重新生成基准与目标副本；`infer` 静态解析 `plugins` 对象的键。插件源码在所有副本中都存在，所以启停插件只体现为 `template.config.ts` 与 wrangler 的差异。

### 9. 媒体迁移为 `media` 插件

搬入 `plugins/media`：

- `features/ai-media/*`、`features/ai/media-tasks.ts`
- 媒体路由：`app/$slug/media/new`、`app/$slug/tasks/*`、`api/ai/tasks*`、`api/webhooks/media/$provider`、`api/v1/tasks*`
- jobs 的 `workflows/media-runner.ts`、`node/media.ts`、`node/media-http.ts`
- web 的 `node/media-workflow.ts`
- 文案 `ai-media*.json`

留在原处：

- `packages/ai/src/media`：provider 注册表、提交与参数逻辑，属于纯能力。
- `packages/storage/src/media.ts`、`packages/config/src/media.ts`。
- 数据库 `ai_task` 与 `file.source_task_id` 外键：表结构集中。
- 后台模型管理中的图片 / 视频模型种类：这属于模型注册表，不属于媒体插件。

`features/api-keys/tasks.ts` 中的公共 API 任务接口随路由迁入插件；`publicApi` 开启而 `media` 未启用时，`/api/v1/tasks` 不存在。

## Risks / Trade-offs

- [虚拟路由跨包挂载或 `createServerFn` 在 workspace 包中不被编译] → 第 1 组先做验证；失败则退回决策 1、4 中的备选方案，在 PR 中记录。
- [手写 wrangler 与插件清单漂移] → `check-plugins` 在 `pnpm check` 中拦截，并给出缺失绑定的具体 env 与名称。
- [迁移媒体代码改动面大，可能引入回归] → 只移动文件和改导入路径，不改业务逻辑；现有媒体单元、集成与 e2e 测试必须原样通过；构建产物字符串检查验证剔除效果。
- [衍生项目同步后忘记声明 `media`] → 配置校验在 `ai.image || ai.video` 为真但未启用 `media` 时让构建失败，错误信息给出要加的一行；升级说明列出。
- [生成文件导致 typecheck 依赖生成步骤] → 与 `routeTree.gen.ts` 相同处理：`typecheck`、`test` 脚本前置生成，Turbo inputs 加入 `template.config.ts` 与 `plugins/*/plugin.ts`（按 `docs/ci.md` 更新缓存输入）。

## Migration Plan

1. 模板发版说明（BREAKING 配置）：`ai.mediaProviders` 改为 `plugins.media.providers`；需要图片 / 视频的项目加 `plugins: { media: {...} }`。
2. 衍生项目：template-sync 合并后运行 `pnpm check`；`check-plugins` 会指出 wrangler 中多余或缺失的绑定。
3. xuanxue（图片、视频都关）：同步后不声明 `media`，删除 wrangler 中的 `AI_MEDIA_WORKFLOW` 与 jobs 的 workflows 块。不需要数据库迁移。
4. 回滚：恢复到上一个模板版本即可，数据库无变化。

## Open Questions

无阻塞问题。第 1 组的验证结论（虚拟路由与 workspace 包编译）可能把实现切到备选方案，但不改变对外行为与配置格式。
