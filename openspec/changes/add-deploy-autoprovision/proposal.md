## Why

衍生项目首次部署 Cloudflare 时，要在 `apps/web/wrangler.jsonc` 与 `apps/jobs/wrangler.jsonc` 里逐处替换资源 ID：
每个环境的 KV、两个 Hyperdrive、R2 与 AI Gateway 账号，外加 5 个限流 `namespace_id`，两个文件合计约 24 处；
R2 桶与队列还要先手工创建。漏填或填错会导致部署失败，或者更隐蔽地让 web 与 jobs 绑到不同的 KV。
模板已进入多衍生项目阶段（xuanxue 等），每个新项目都重复这一步，值得做成可重复执行的部署步骤。

## What Changes

- 新增部署资源解析命令（暂名 `pnpm deploy:resources`）：读取已提交的 wrangler 配置和目标环境，
  按约定名称查找 KV、R2 桶、队列（含死信队列）和 Hyperdrive。找到就沿用，找不到时在允许创建的模式下创建，
  然后为每个 app 生成一份已填好 ID 的部署用配置（不入库）。命令可重复执行，默认只读，只输出计划。
- 已提交配置里写着真实 ID 的绑定视为「已固定」，原样沿用，不按名称再查找。已有衍生项目因此行为不变。
- 不能自动创建的资源给出检查与最省事的做法：Hyperdrive 需要数据库连接串，默认只按名称查找、缺失即失败并提示；
  经显式开关才从受保护的环境变量读取连接串，通过 API 创建。限流 `namespace_id` 由项目分配，
  生成器为每个新项目分配互不重叠的号段，检查在部署前核对唯一性。
- staging 与 production 部署工作流在构建前增加「解析资源」步骤，web（Vite 插件）与 jobs（`wrangler deploy`）
  改为使用生成的部署配置；构建、迁移、部署顺序与版本门不变。
- 生成器不再要求手工替换资源 ID：新项目的 staging / production 保留可识别的占位 ID，
  `PROJECT_SETUP.md` 改为指向解析命令；R2 / AI Gateway 账号 ID 可在部署时从 `CLOUDFLARE_ACCOUNT_ID` 补齐。
- 代码版本写入：沿用现有 `APP_VERSION`（jobs `--var`、web 构建期常量、`/api/health` 的 `version`），本 change 不新增机制。
- 文档：`docs/07-infrastructure.md`、`deploy-cloudflare` 技能、`docs/create-project.md`、新的升级说明，写清楚 API 令牌权限、
  命名约定、重复资源与改名风险、回滚方式。

## Capabilities

### New Capabilities

- `deploy-resource-provisioning`：Cloudflare 部署前按名称解析或创建资源，以及生成部署配置的行为契约。
  包括只读计划、已固定 ID 优先、命名约定、不能自动创建资源的处理、不重复创建、权限不足时报错，以及不修改已提交配置。

### Modified Capabilities

- `staging-deployment`：「main 合并后自动部署 staging」的顺序前加入资源解析；解析失败时不迁移、不部署。
- `production-deployment`：生产发布顺序加入资源解析，且生产默认只查找、不创建。
- `project-bootstrap`：「基础设施与密钥清单」改为说明哪些资源由部署自动解析、哪些仍需人工提供；生成的限流 `namespace_id` 按项目分号段。

## Impact

- 新增：`scripts/deploy/`（解析命令与纯逻辑、Node test）、根 `package.json` 脚本、`.gitignore` 中的生成配置。
- 修改：`.github/workflows/deploy-staging.yml`、`deploy-production.yml`（新增步骤和 `--config`）；`apps/web/vite.config.ts`（读取生成配置路径）；
  `scripts/create-project.mjs`（占位 ID、限流号段、清单文案）；`scripts/production/check-wrangler-envs.mjs`（识别占位 ID）。
- 不变：已提交的 `wrangler.jsonc` 结构、`check-plugins.mjs` 绑定检查、selfhost（不使用 Wrangler）、
  template-sync 合并规则（项目已填的 ID 仍按「项目自有配置不被覆盖」保留）。
- 外部：CI 使用的 Cloudflare API 令牌在需要创建资源时要有 KV / R2 / Queues 编辑权限，查找 Hyperdrive 要有读取权限。
  未授予时解析步骤明确失败，不静默跳过。
- 依赖：排在 `add-admin-step-up` 之后实施；不新增 npm 依赖。
