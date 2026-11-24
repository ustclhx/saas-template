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
