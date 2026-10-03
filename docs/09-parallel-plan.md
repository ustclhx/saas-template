# 09 · 并行开发计划（Orca）

用 [Orca](https://www.onorca.dev/) 并行推进 `docs/08-roadmap.md` 的 8 个阶段：每个 Orca 任务对应一个 git worktree 与一个分支，从 `origin/main` 分出，完成后经 PR 合并回 main。本文规定 worktree 隔离方式、共享文件规则、阶段之间与阶段内部的并行波次，以及合并流程。

## 1. Orca 的工作方式与对本项目的约束

| Orca 特性 | 约束 |
|---|---|
| 新 worktree 默认从仓库 base ref（`origin/main`）分出 | 依赖其他任务成果的任务，必须等被依赖的分支**合并并推送到 main** 后再创建。确需提前开始时，可在创建时选「从本地分支分出」做堆叠，但堆叠层数不超过 1 |
| 「父 worktree」只是侧边栏嵌套显示，不影响分支 | 依赖关系用 orchestration 的任务 DAG 表达，不靠父子关系 |
| Orchestration：run（协调者）+ task DAG + `worker_done` + decision gate | 每个阶段一个 run；需要人工完成的事项（开 VPS、建支付账号、配 CI Secrets）用 decision gate 阻塞相关任务 |
| `orca.yaml` 的 `scripts.setup` / `scripts.archive` 在 worktree 创建 / 归档时运行，可读到 `ORCA_ROOT_PATH`、`ORCA_WORKTREE_PATH`、`ORCA_WORKSPACE_NAME` | 用于给每个 worktree 隔离数据库与端口，见 §2 |
| `orca.yaml` 只在 main（主 checkout）上的版本对新 worktree 生效 | 修改 `orca.yaml` 或 `scripts/orca/` 必须先合并到 main |

## 2. Worktree 隔离

配置文件：`orca.yaml`、`scripts/orca/{lib,setup,archive}.sh`、`.worktreeinclude`。

| 资源 | 方式 |
|---|---|
| 依赖 | 每个 worktree 自己 `pnpm install`（pnpm 全局内容寻址存储，安装很快）。**不共享 `node_modules`**：并行分支会安装不同依赖 |
| 构建缓存 | `.turbo` 通过 `worktree.sharedDirectories` 共享（内容寻址，可安全共享） |
| 本地数据库 | 所有 worktree 共用一个本地 PG 容器 `saas-template-pg`；每个 worktree 使用独立数据库 `saas_wt_<worktree 名>`，setup 时创建、archive 时删除。主 checkout 使用 `saas_dev` |
| 端口 | 按 worktree 名哈希分配 `20000–29990` 中一个 10 个端口的段，写入 `.env.worktree`（`WEB_PORT`、`JOBS_PORT`、两个 inspector 端口） |
| Hyperdrive 本地连接 | `.env.worktree` 中的 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE(_CACHED)` 指向该 worktree 的数据库（`app` 账号）；`MIGRATION_DATABASE_URL` 为同一库的 `migrator` 账号，供 drizzle-kit 使用 |
| 本地密钥 | `.dev.vars` 只放在主 checkout，经 `.worktreeinclude` 复制到每个新 worktree |
| Miniflare 状态 | `.wrangler/state` 位于各 worktree 目录内，天然隔离 |

P0 实现时必须遵守的约定（setup 脚本依赖它们）：
- `infra/local/docker-compose.yml` 的容器名为 `saas-template-pg`，超级用户 `postgres`，映射宿主机 `5432`，初始化脚本创建 `app` 账号（本地密码 `app`，只有 DML）以及 `migrator`（DDL）、`readonly`（SELECT）；单库权限由 `infra/local/initdb/02-db-grants.sql` 设置，setup 脚本对每个 worktree 库执行一次。
- `apps/web` 的 vite 配置与 `apps/{web,jobs}` 的 wrangler 本地开发配置，在 `.env.worktree` 存在时读取其中的端口与连接串，不存在时使用默认值（主 checkout）。

## 3. 共享文件规则

并行分支最容易在以下文件上冲突，所有 worker 必须遵守：

1. **数据库迁移**：worker 在自己的 worktree 中用 `drizzle-kit push` 把 schema 直接同步到自己的数据库，**不提交迁移 SQL**。分支合并到 main 后，由协调者在 main 上统一 `drizzle-kit generate` 生成迁移并提交。理由：drizzle 迁移带序号和元数据文件，两个分支各自生成必然冲突。
2. **schema 按领域分文件**：`packages/db/src/schema/{auth,tenancy,billing,credits,ai,files,platform}.ts`，每条并行线只改自己领域的文件；汇总导出文件冲突时直接合并两边的导出行。
3. **`routeTree.gen.ts`**：已 gitignore，构建时生成。
4. **`pnpm-lock.yaml`**：冲突时不手工合并，rebase 后在 main 的依赖基础上重新 `pnpm install` 生成。
5. **文案文件**：`apps/web/messages/<locale>/<feature>.json` 按功能拆分，避免多条线同时改一个大文件。
6. **OpenSpec `tasks.md`**：worker 只勾选分配给自己的任务编号；change 的归档（`/opsx:archive`）只在 main 上、该 change 全部任务合并后进行。

## 4. 阶段之间的波次

主线 P0 → P1 → P2 → P3 → P4 是硬依赖；P5、P6、P7 按依赖拆开，跟随主线提前进行。每一波最多同时运行 4 个 agent（瓶颈是人工审阅与合并）。

| 波次 | 主线 | 并行支线 |
|---|---|---|
| W0 | 工程骨架（P0 第 1 组）+ Orca 配置 | 人工：VPS、Cloudflare 资源（P0 5.1–5.3） |
| W1–W2 | P0 剩余部分 | — |
| W3 | P0 平台能力实测 | P7 可观测性；P6 i18n / 主题 / 内容 |
| W4–W5 | P1 | P6 继续；P3 计费函数（纯函数） |
| W6–W8 | P2 | P5 用户管理；P7 Waitlist / Newsletter |
| W9 | P3 注册表 → P3 对话 | P4 存储与 fal.ai 两条线；P6 接入真实定价 |
| W10 | P4 Workflow | P5 计费后台与模型管理 |
| W11 | 整体验收 | P5 审计与指标；P7 通知中心与公开 API |
| W12 | P7 创建项目脚本、文档 | — |

## 5. 阶段内部的任务拆分

记法：每个反引号名称是一个 Orca 任务（一个 worktree / 分支，分支名 `wt/<名称>`），括号内为该 change `tasks.md` 中的编号；`∥` 表示可同时运行；`→` 表示需等前一步合并进 main。

### P0 `setup-scaffold-and-infra`
- W0：`p0-scaffold`（1.1–1.4）在 main 上串行完成
- W1：`p0-config`（2.1, 2.2, 6.1） ∥ `p0-db`（3.1–3.3, 2.3） ∥ `p0-web`（4.1）
- W2：`p0-runtime`（4.2, 4.3, 4.4, 4.5；4.3 依赖 `p0-config` 的 2.2，因此不能放在 W1）；CI 部署 6.2、6.3 由 decision gate 阻塞，直到人工完成 5.4–5.6
- W3：实测 `p0-probe-locks`（7.1） ∥ `p0-probe-workflow`（7.2） ∥ `p0-probe-stream`（7.3） ∥ `p0-probe-latency`（7.4） ∥ `p0-probe-tunnel`（7.5）→ `p0-findings`（7.6）

### P1 `add-auth-and-workspaces`
- `p1-schema`（1.1, 1.2, 2.1） ∥ `p1-email-templates`（3.1）
- → `p1-session`（2.2–2.5） ∥ `p1-email-queue`（3.2） ∥ `p1-workspace`（4.1–4.3） ∥ `p1-admin-settings`（5.1, 5.2）
- → `p1-teams`（4.4–4.6）→ `p1-deletion`（6.1–6.4）→ `p1-e2e`（7.1）

### P2 `add-billing-and-credits`
- `p2-schema`（1.1, 1.2, 3.1）
- → `p2-ledger`（2.1–2.7） ∥ `p2-stripe`（3.2） ∥ `p2-paypal`（3.3） ∥ `p2-entitlements`（6.1, 6.2）
  - `p2-stripe` / `p2-paypal` 由 decision gate 阻塞，直到 Stripe 测试账号与 PayPal 沙箱就绪
- → `p2-webhooks`（4.1–4.3） ∥ `p2-seed-sync`（1.3）
- → `p2-subscriptions`（5.1–5.5） ∥ `p2-signup-bonus`（8.1）
- → `p2-refunds`（7.1–7.4） ∥ `p2-crons`（9.1） ∥ `p2-pages`（10.1, 10.2）
- → `p2-admin-docs`（10.3, 10.4）→ `p2-acceptance`（11.1）

### P3 `add-ai-text-chat`
- `p3-pricing`（1.2，W4 起即可） ∥ `p3-gateway`（2.1）
- `p3-registry`（1.1, 1.3, 1.4，需 P2 权益已合并）
- → `p3-chat-api`（2.2, 2.3） ∥ `p3-model-picker`（3.2）
- → `p3-chat-edge`（2.4–2.6） ∥ `p3-chat-ui`（3.1）→ `p3-acceptance`（4.1, 5.1）

### P4 `add-ai-media-generation`（`p3-registry` 与 `p3-pricing` 合并后即可开始）
- `p4-schema`（1.1）
- → `p4-storage`（2.1–2.4） ∥ `p4-fal`（3.1, 3.2） ∥ `p4-form`（5.1）
- → `p4-submit`（4.1）→ `p4-workflow`（4.2–4.5，串行链，在同一 worktree 内完成） ∥ `p4-cancel-sweeper`（4.6, 4.7）
- → `p4-acceptance`（5.2, 6.1, 7.1）

### P5 `add-admin-console`（按依赖分批开始）
- P1 后：`p5-base`（1.1–1.3）→ `p5-users`（2.1–2.3）
- P2 后：`p5-billing`（3.1, 3.2）
- P3 后：`p5-models`（4.1, 4.2）
- P4 后：`p5-audit-metrics`（5.1–5.3）→ `p5-acceptance`（6.1）

### P6 `add-marketing-i18n-seo`
- W3 起：`p6-i18n`（1.1, 1.3） ∥ `p6-theme`（2.1） ∥ `p6-content`（3.1, 3.3–3.5）
- P1 后：`p6-i18n-user`（1.2, 1.4）
- P2 后：`p6-pricing`（3.2）
- 页面齐全后：`p6-seo`（4.1–4.4）→ `p6-acceptance`（5.1, 5.2）

### P7 `add-observability-and-optional-features`
- W3 起：`p7-obs`（1.1–1.4）
- P1 后：`p7-waitlist-news`（4.1, 4.2）
- P4 后：`p7-notify`（2.1, 2.2） ∥ `p7-public-api`（3.1–3.4）
- 收尾：`p7-agents-md`（5.1）→ `p7-bootstrap`（5.2, 5.3）→ `p7-acceptance`（6.1）

## 6. 用 Orca orchestration 执行

**每个阶段一个 run**，objective 为对应的 OpenSpec change 名。

**每个任务的 spec 模板**：

```
在本 worktree 中执行 /opsx:apply <change>，只做 tasks.md 中的 <编号列表>。
遵守 docs/09-parallel-plan.md §3 的共享文件规则（不提交迁移 SQL，只改 <领域> 的 schema 文件）。
完成标准：pnpm typecheck、pnpm biome check、相关测试通过；只勾选上述编号；推送分支并开 PR 到 main。
完成后发送 worker_done（outcome=succeeded|failed），失败时说明阻塞原因。
```

**合并流程**（协调者执行，一次只合并一个分支）：
1. 分支 rebase 到最新 `origin/main`，冲突按 §3 处理。
2. CI 通过、人工审阅 diff 后合并 PR。
3. 若该分支改了 schema：在 main 上 `drizzle-kit generate` 生成迁移、在本地 `saas_dev` 验证后提交。
4. 推送 main，然后把依赖该任务的后续任务从 blocked 放行（新 worktree 才能从包含该成果的 main 分出）。

**decision gate 清单**（需要人工完成后放行）：
- P0：VPS 与 Postgres 就绪、Tunnel + Access + Hyperdrive 配置完成、GitHub Actions Secrets 配置完成
- P1：Google / GitHub OAuth 应用、Resend 域名验证、Turnstile 站点
- P2：Stripe 测试账号、PayPal 沙箱账号与 webhook
- P3：AI Gateway 与至少一家 LLM 服务商的 API Key
- P4：fal.ai API Key、R2 S3 API 令牌
- P7：Sentry 项目、Telegram / Discord 通知渠道（可选）
