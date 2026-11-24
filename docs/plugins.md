# 插件开发与部署

插件是 `plugins/<id>` 下的 pnpm workspace 包，包名为 `@saas/plugin-<id>`。模板和衍生项目保留插件源码。构建按 `template.config.ts` 的 `plugins` 配置选择要挂载的路由、入口、Paraglide 文案和 Tailwind 扫描目录。

## 目录与清单

```text
plugins/<id>/
  package.json          # 插件自己使用的依赖
  plugin.ts             # definePlugin 的默认导出
  routes/               # TanStack 文件路由
  src/web/              # 页面组件、Server Functions 和 Web 入口
  src/worker/           # Cloudflare Web Worker 入口及其代码
  src/jobs/             # Cloudflare jobs 入口及其代码
  src/node/             # Node Web 和 jobs 入口
  messages/<locale>/    # 每个语言下按功能拆分的 JSON
  test/                 # 插件测试
```

除包与清单外，按需要创建目录。清单保持静态，入口路径和插件依赖可直接填写，也可引用同文件的常量。配置 schema 可以导入，运行时代码放在入口模块。清单的路径均相对于插件目录。[清单类型与校验](../packages/config/src/plugins.ts)

| 字段 | 用法 |
|---|---|
| `id` | 小写短横线标识，与目录名、包名后缀和配置键一致。 |
| `targets` | 支持的目标列表，使用 `cloudflare` 或 `node`。双目标插件声明两者。 |
| `requires` | `plugins` 列出直接依赖的插件 id。`features` 列出需要开启的模板开关，如 `billing`、`credits`。 |
| `routes` | `dir` 指定文件路由目录。`mount: ''` 挂到根，非空前缀省略首尾斜杠。例如挂到根时，`routes/app/$slug/example.tsx` 使用 `/app/$slug/example`。 |
| `entries` | 按扩展点填写 `web`、`worker`、`jobs`、`webNode`、`jobsNode` 的文件路径。 |
| `bindings` | 用 `web`、`jobs` 分别声明绑定。`kind` 支持 `ai`、`durable_object`、`hyperdrive`、`kv`、`queue`、`r2`、`rate_limit`、`service`、`workflow`。每项填写 `name` 和 `kind`，Durable Object 与 Workflow 还要填导出的 `className`。可降级的绑定可设 `optional: true`。 |
| `secrets` | 声明所需的密钥名称。实际值按环境配置。 |
| `messages` | 文案目录，例如 `messages`。目录内使用 `<locale>/<feature>.json`。 |
| `config` | 校验 `plugins.<id>` 的 Zod schema。省略时启用值填 `{}`。 |

## 扩展点

入口默认导出约定的注册对象。Cloudflare `worker`、`jobs` 入口可额外具名导出 Durable Object 或 Workflow 类，分别由 Web 与 jobs Worker 导出。

| 入口 | 扩展点 |
|---|---|
| `web` | `appNav` 增加应用区导航（侧栏与顶栏布局共用），同 id 依模板、插件、项目的次序覆盖。`adminNav` 向现有后台分组追加条目，组内按 `order` 排序。`toolRenderers` 注册对话工具卡片，项目可覆盖。 |
| `worker` | `fetch(request, env, ctx)` 在网关与 TanStack Start 之前运行。返回 `Response` 即结束，返回 `undefined` 继续请求链。 |
| `jobs` | `queues` 按基础队列名注册处理器，Cloudflare 同时匹配 `-staging` 和 `-production` 后缀。`crons` 使用已有 `heartbeat`、`ten-minute`、`daily` 分组。`holdSweepers` 按预扣来源注册清理器。 |
| `webNode` | Node Web 的 `fetch(request)`，采用同样的请求链约定。 |
| `jobsNode` | 共用 jobs 的队列、Cron 与清理器。`registerWorkflows` 装配 Node 持久任务，可以返回内部 HTTP 路由与停机时停止接收的回调。 |

插件可在 `web` 入口具名导出 `agentTools` 数组或返回数组的同步函数，使用 `@saas/ai` 的 `defineAgentTool` 定义工具。工具依赖服务端模块时，用 `createServerOnlyFn(() => tools)` 导出同步函数，将工具实现模块仅引用在函数体内。启用 `agents` 后，Cloudflare Worker 启动时汇总工具，名称须与所有已启用插件和项目工具中的名称互不重复。有副作用的工具须声明 `needsApproval`，用 `ctx.idempotencyKey` 在业务写入边界去重，并在重放时返回已有结果。

接口定义见 [Web](../apps/web/src/features/plugins/contract.ts)、[Cloudflare Web Worker](../apps/web/src/server/cloudflare/plugins.ts)、[jobs](../apps/jobs/src/plugins/contract.ts) 与 [Node jobs](../apps/jobs/src/node/plugins.ts)。

## 依赖边界

- 核心的运行时代码与脚本经 `*.gen.ts` 接入插件。`apps/web/test`、`apps/jobs/test`、`apps/web/e2e` 可用包名或相对路径直接导入插件做集成验证。依赖插件的用例须检查 `template.config.ts` 的 `plugins`，并在插件未启用时跳过。
- 插件通过 `requires.plugins` 声明其他插件，通过各共享包的公开入口复用能力。Cloudflare 专用导入，如 `cloudflare:workers` 与 `agents`，限于插件的 Cloudflare `worker` 或 `jobs` 入口代码。浏览器端的连接 hook `agents/react` 与 `@cloudflare/ai-chat/react` 例外，可在插件页面中使用。
- `@web/*` 指向 `apps/web/src/*`。插件路由、`src/web`、清单声明的 `web`、`worker`、`webNode` 入口及其导入链可由 Web 构建解析该别名。`jobs`、`jobsNode` 入口及其导入链和未归属 Web 入口的共享代码禁止使用该别名。类型导入遵守同样规则。

## 启用、停用与部署

1. 在 `template.config.ts` 的 `plugins` 中加入插件 id 与配置，例如 `plugins: { example: {} }`。同时启用其 `requires` 声明的插件和模板开关。
2. Cloudflare 部署时，按清单在对应的 `apps/web/wrangler.jsonc` 或 `apps/jobs/wrangler.jsonc` 顶层、`env.staging`、`env.production` 分别补齐所需绑定。绑定名与种类须一致，环境资源名与 ID 按各自部署填写。跨 Worker 的 Durable Object 或 Workflow 绑定指向实际导出类的 Worker。配置所需密钥后重新构建并部署。Node 使用插件自己的 Node 入口校验运行时配置。
3. 停用时，删除 `plugins` 中的键，调整依赖该插件的开关和其他插件，移除专属的 Wrangler 绑定并保留仍在使用的共享绑定。重新构建与部署后，插件路由返回 404，构建产物移除该插件的入口和文案。

Cloudflare 使用声明了 `cloudflare` 的插件。`pnpm build:node` 只打包启用且支持 `node` 的插件，并提示已排除的仅 Cloudflare 插件。使用生成器创建 selfhost 项目时，只能选择支持 `node` 的插件。启停和目标筛选在构建时生效。数据库表与迁移统一由 `packages/db` 管理。

## 内置插件

| 插件 | 部署目标 | 功能与依赖 |
|---|---|---|
| `media` | Cloudflare、Node | 图片和视频任务，依赖 `billing` 与 `credits`。[媒体任务](./06-ai.md#4-图片--视频异步任务) |
| `agents` | Cloudflare | 持久对话、多步工具和人工确认，依赖 `billing` 与 `credits`。web 提供 `AGENT_CONVERSATION` SQLite Durable Object，jobs 复用现有清理 Cron 处理 PG 预扣。[Agent 对话](./06-ai.md#8-agent-对话pluginsagents) |

生成 Cloudflare 项目时可用 `--plugins agents` 选择 Agent。web 的 `AGENT_CONVERSATION` 绑定指向同一 Worker 内的 `AgentConversation`，并用 `agents-v1` SQLite 类迁移。jobs 沿用先部署的顺序。`plugins.agents` 可配置 `maxSteps`、`maxTurnCredits`、`maxPersistedMessages`、`retentionDays` 与 `defaultAgent`。详见 [插件清单](../plugins/agents/plugin.ts) 与 [配置 schema](../plugins/agents/src/config.ts)。

## 新增插件与验证

1. 新建 `plugins/<id>/package.json` 和 `plugin.ts`，声明入口、配置、绑定及所需依赖。在 `apps/web/package.json` 与 `apps/jobs/package.json` 声明该插件的 `workspace:*` 依赖，运行 `pnpm install` 更新锁文件。
2. 按扩展点实现入口并添加路由或文案。注册文件、类型化路由树和 Tailwind 扫描目录由构建与类型检查生成；修改来源文件以更新它们。
3. 启用插件后运行 `pnpm check`、`pnpm check:deps`、`pnpm typecheck`、`pnpm test` 与 `pnpm build`。`pnpm check` 校验清单路径、各环境的所需绑定和已停用插件的类引用。支持 Node 时再运行 `pnpm build:node`。
4. 停用插件后重新构建要部署的目标，验证页面与接口返回 404。可用 `node scripts/plugins/check-artifacts.mjs --absent <插件特有标识> --only <本次构建目标>` 检查产物。`--only` 接受逗号分隔的 `web,web-node,jobs,jobs-node` 子集。
