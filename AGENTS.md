<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# 项目开发约定

## 先读什么

首次修改架构或跨模块行为时，完整阅读 [总体架构](docs/01-architecture.md) 与
[项目结构和配置](docs/02-project-structure.md)，再阅读对应领域文档。
<!-- template-only:start -->
并行工作、共享文件修改、创建或清理 worktree、提交 PR 时，必须阅读
[并行计划 §3 与 §6](docs/09-parallel-plan.md) 并遵守其规则；共享文件规则以该文档为准。

<!-- template-only:end -->
## 模块职责与依赖方向

- `apps/web`：TanStack Start 路由、页面、Server Functions 和 HTTP 接口。
- `apps/jobs`：Cloudflare Workflows、Queue 消费者和 Cron；web 经绑定调用 jobs。
- `plugins/<id>` 承载可选功能。新增、启停或调整插件入口时，见 [插件开发与部署](docs/plugins.md)。
- `packages/shared`：类型、错误、ID、结构化日志；`config`：模板类型、默认值和环境校验；
  `db`：Drizzle schema、迁移、租户查询和运行时设置；`platform`：目标中立能力契约与 Cloudflare/Node 适配。
- `packages/auth`：身份、会话和空间；`billing`：支付、订单和订阅；`credits`：积分账本和预扣结算；
  `entitlements`：套餐权益；`ai`：模型和 Provider；`storage`：R2 与安全下载；
  `email`：邮件模板与发送；`ui`：共享 React 组件与设计 token。
- `infra`：本地及服务器 Postgres；`scripts`：工程检查、项目生成和 Orca 生命周期。

依赖边界以 `scripts/check-deps.mjs` 为准：packages 不依赖 apps；shared 不依赖其他内部包；
config 只可依赖 shared；db 只可依赖 shared、config；platform 只可依赖 shared、config、db，
config/db 不反向依赖 platform。业务包之间允许依赖，检查器没有规定它们的总顺序。React 仅允许用于 ui，email 可依赖 React / React Email，但不能依赖 ui。
检查器同时检查 manifest 与源码 import。业务平台能力通过 platform 中立入口访问；Cloudflare
导入边界与逐文件过渡清单见 [项目结构 §1](docs/02-project-structure.md#1-monorepo-目录)。

## 编码与配置

- TypeScript strict；使用 Biome 的两空格缩进、单引号和无分号风格，中文注释说明原因。
- UUIDv7 主键、UTC `timestamptz`、整数金额最小单位与整数积分。
- 租户业务查询使用 `scoped(db, workspaceId)`；按请求创建数据库客户端。
  Webhook 按验签、去重、事务处理、异步副作用的顺序处理。
- 后台写入使用 `apps/web/src/features/admin/action.ts` / `action.server.ts` 的 adminAction；
  列表使用 `packages/ui` 的 DataTable 与 `apps/web/src/features/admin/list.ts`。
- 页面只用 `@saas/ui`（衍生项目另有 `@saas/ui/project`）的组件与设计 token，不写死颜色、任意值尺寸、原生 `<select>` 或 `confirm()`；
  新页面与较大布局改动先经 `ui-design` 技能取得使用者确认的设计稿，文案、小样式与缺陷修复免。规范见 [设计规范](docs/design-system.md)。
- 日志使用 `@saas/shared/log`，业务错误使用 AppError；外部服务调用经过对应 package。
- 模板开关放 `template.config.ts`，运行时设置使用 `packages/db/src/settings.ts`，
  密钥放 Wrangler secrets 或本地 `.dev.vars`。三层配置各自负责，不互相覆盖。
- 根布局和公开页面的数据读取失败时降级；数据库不可达时营销页与构建期预渲染仍应可用。
- 新增定时任务、轮询或公开页查库时遵循 Neon 成本基线（`docs/runbooks/production-neon.md` §4）：无真实用户时数据库应能缩容到零。
- 验收/自测证据写入 `EVIDENCE_DIR`（未设置时使用已忽略的 `test-results/evidence/`），提交到私有证据库 `saas-template-evidence`；主仓库与 PR 只引用，不提交证据。
- 只修改任务所需内容；复用现有实现与测试，为核心行为和真实回归风险增加精简用例。
- 修改 `.github/workflows/`、`.github/actions/` 或 Turbo 配置前阅读 [CI 规范](docs/ci.md)：合并前必须通过的检查、CI 模式、缓存输入与并发规则以该文档为准。
- 新增或改动 MCP 工具能力时，同一 PR 更新工具与参数说明及[管理员 MCP 工具表](docs/admin-mcp.md#工具与权限)。
- 访客不会因后台问题看不到公开页面：公开页面的可用性不依赖后台配置、后台专用绑定、插件路由或数据库，需要数据的部分降级显示；预渲染页在环境校验失败时仍返回，插件绑定缺失只让该插件入口 503。见 `public-site-availability` 规范。
- 第三方集成登记在 [第三方登记表](docs/third-party.md)，新增第三方 SDK 依赖须同时加登记行与
  `scripts/third-party-deps.json` 映射（`pnpm check` 检查）。能经 API 或 CLI 查询第三方状态时，提供查询方式而不是教手工步骤。
- 写或改第三方操作说明前先查官方文档，在说明旁注明出处链接与核对日期，并同步登记表的「上次核对」。
- 真账号中看到的数据（账号 ID、余额、域名配置、部分密钥、截图）不进本仓库，写入 `EVIDENCE_DIR` 对应的私有证据库，仓库只引用。

## 常用命令

在根目录运行，Node >=22 与 package.json 声明的 pnpm 版本为前提。
数据库命令及集成测试需要已启动的本地 PG；Orca worktree 使用自己的 `.env.worktree`。
运行集成测试前，按[本地集成测试数据库](docs/02-project-structure.md#5-本地集成测试数据库)准备隔离库。
启用本地回落的测试在未配置连接串时使用 `<项目>_test`。`ALLOW_TEST_ON_DEV_DATABASE=1` 才允许使用开发库。

| 命令 | 用途 |
|---|---|
| `pnpm install --frozen-lockfile` | 安装工作区依赖 |
| `pnpm --filter @saas/db db:migrate` | 应用现有迁移 |
| `pnpm check` | Biome 与积分写入边界检查 |
| `pnpm typecheck` | 所有包和应用类型检查，生成路由与文案 |
| `pnpm check:deps` | 内部依赖方向检查 |
| `pnpm check:singletons` | 关键依赖唯一实例检查 |
| `pnpm test` | 单元测试与已启用的集成测试 |
| `pnpm build` | web 生产构建与 jobs 部署 dry-run |
| `pnpm eval:prompts --suite <name>` | 提示词评测，默认离线回放；真实调用须 `--live`/`--record` 与 `--budget-usd` |
| `pnpm create-project --help` | 查看生成器的交互和非交互参数 |
| `pnpm test:create-project` | 临时目录中的生成器边界测试 |
| `pnpm test:create-project:verify` | 真实副本改名、类型检查与单元测试验收 |
| `openspec list --json` | 查看当前 change 与项目根 |

持续开发使用根 package.json 的 dev 脚本，启动 web 与 jobs；停止时仅结束自己启动的进程。
新项目生成与自检见 [创建项目](docs/create-project.md)。

## OpenSpec 工作流

需求探索、提案、实施、同步与归档分别使用 `.agents/skills/openspec-*` 中对应的技能。
实施已有 change 时先读 `openspec-apply-change/SKILL.md`，通过 status 与 instructions apply
读取当前状态、上下文路径和任务位置，完整阅读其 proposal、design、specs、tasks。
只实施获分配的编号；全部验收通过后立即勾选对应项，并刷新 apply instructions 确认进度。
遇到设计冲突或范围扩大时向协调者询问。change 的同步与归档遵循并行计划，只在全部任务
合并后由协调者处理。PR 应包含验证结果与未完成验收，不把部署或外部凭据验收提前勾选。
