# Tasks

> 标注【人工】的任务需要用户在 Neon / Cloudflare / GitHub / Stripe / PayPal 控制台操作或提供凭据，实施者只准备命令与核对步骤，不在聊天、日志或 git 中传递密钥值。未标注的任务由实施者完成。

## 0. 前置

- [x] 0.1 把分支 `chore/cloudflared-http2` 上 `infra/local/docker-compose.yml` 的 `--protocol http2` 改动提交并合入 main（独立 PR），验证 `docker compose --profile tunnel config` 输出的 cloudflared 命令包含 `--protocol http2`

## 1. Neon 数据库

- [ ] 1.1【人工】创建 Neon 项目（Postgres 17，区域 `aws-us-west-2`）；在控制台创建角色 `migrator`、`app`、`readonly`，以 `migrator` 为 owner 创建数据库 `saas_staging`；把三个账号的**直连（非 pooled）**连接串保存到本机密码管理器，验证 `psql "<migrator 连接串>" -c 'select current_user, current_database()'` 返回 `migrator | saas_staging`
- [ ] 1.2 以 `migrator` 连接对 `saas_staging` 执行 `infra/local/initdb/02-db-grants.sql`；如 Neon 拒绝某条语句，以 Neon 默认 owner 角色补执行该语句并记录到 runbook（不修改 SQL 文件对本地 / CI 的行为），验证 `\dn+ public` 显示 owner 为 `migrator`、`app` 只有 USAGE
- [ ] 1.3 执行 `MIGRATION_DATABASE_URL=<migrator 连接串> pnpm --filter @saas/db db:migrate`，验证 `drizzle.__drizzle_migrations` 的记录数等于 `packages/db/migrations` 中的迁移数，且以 `app` 账号执行 `create table t(x int)` 与对 `audit_log` 的 `UPDATE` 均被拒绝
- [ ] 1.4 执行 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=<app 连接串> pnpm billing:seed`，验证 `plan` 表有 free / pro / team / credit_pack 四个套餐，重复执行不新增行

## 2. Hyperdrive 切换与手动部署

- [ ] 2.1 用 `wrangler hyperdrive create saas-staging-neon --connection-string <app 连接串> --caching-disabled` 与 `wrangler hyperdrive create saas-staging-neon-cached --connection-string <app 连接串> --max-age 60` 新建两个配置（连接串从环境变量读入，不写进命令历史或日志），验证 `wrangler hyperdrive list` 中两者存在且缓存设置正确
- [ ] 2.2 把 `apps/web/wrangler.jsonc` 与 `apps/jobs/wrangler.jsonc` 中 `env.staging.hyperdrive` 的两个 ID 换成新配置，并把注释从「本机 PG … Tunnel」改为 Neon；验证 `pnpm build` 通过、`git diff` 只涉及 staging 段
- [ ] 2.3 本机按 jobs → web 执行 `deploy:staging`，验证 `curl https://web-staging.saas-jobs.workers.dev/api/health` 返回 200 且 `db.status=up`，10 分钟内 `jobs.lastCronAt` 更新
- [ ] 2.4 用 `scripts/probes/71-locks` 对 `saas-staging-neon` 重跑一轮（7 个场景），验证全部判定通过，并在 `docs/07` §2「事务与锁」后追加一段 Neon 直连的结果（日期、往返时延、是否通过）

## 3. 版本标识

- [x] 3.1 在 `apps/web/vite.config.ts` 中按 `APP_VERSION` 环境变量 → `git rev-parse --short HEAD` → `pkg.version` 的顺序确定 `__APP_VERSION__`（git 不可用时不报错），验证 `APP_VERSION=test-sha pnpm --filter @saas/web build` 后产物中包含 `test-sha`、不设置时包含当前短 SHA
- [x] 3.2 为 `healthResponse` 增加单元测试：传入的 `version` 在 200 与 503 响应中原样返回，验证 `pnpm --filter @saas/web test` 通过

## 4. 缺凭据告警

- [x] 4.1 在 `packages/billing/src/runtime.ts` 中，已启用的服务商因凭据缺失被跳过时调用告警回调（默认 `log.warn('billing.provider_unconfigured', { provider, missing })`，每个 isolate 每个服务商一次，只含变量名）；验证新增单元测试覆盖：缺 Stripe 全部凭据、PayPal 只有 `CLIENT_ID`、凭据齐全不告警、同一服务商重复构造只告警一次、日志中不出现任何凭据值
- [x] 4.2 确认 web 的 7 个调用方与 `apps/jobs/src/billing.ts` 不需改动即获得该告警（或补上必要的注入），验证 `pnpm typecheck` 与 `pnpm test` 通过

## 5. staging 配置与密钥

- [x] 5.1 新增 `scripts/staging/check-secrets.mjs`（design 决策 8 的名单；调用 `wrangler secret list --env staging`；只输出缺失项名称；有必需项缺失时退出码 1），并在根 `package.json` 增加 `staging:check-secrets`；验证当前环境运行时列出 jobs 缺少 Stripe / PayPal 五项、web 缺少 `PAYPAL_CLIENT_SECRET` 与 `PAYPAL_WEBHOOK_ID`
- [ ] 5.2【人工】为 `jobs-staging` 配置 Stripe / PayPal 测试凭据，为 `web-staging` 补齐 PayPal 两项（`wrangler secret bulk --env staging`，从本机文件读入后删除该文件），验证 `pnpm staging:check-secrets` 退出码 0
- [ ] 5.3【人工】在 Stripe 测试模式与 PayPal 沙箱登记 webhook：`https://web-staging.saas-jobs.workers.dev/api/billing/webhooks/stripe` 与 `/paypal`（事件按 `docs/runbooks/p2-payment-integration.md`），验证 Stripe 控制台「发送测试事件」后 `webhook_event` 表出现一条已验签记录
- [ ] 5.4【人工】创建 AI Gateway `saas-staging`；实施者把 `AI_GATEWAY_ACCOUNT_ID`、`AI_GATEWAY_ID` 写入 `apps/web/wrangler.jsonc` 的 `env.staging.vars`（若开启 Gateway 鉴权，`AI_GATEWAY_TOKEN` 走 secret），验证部署后 `pnpm staging:check-secrets` 通过且 web 启动校验无报错
- [ ] 5.5【人工】创建 R2 桶 `files-staging` 与只授权该桶的 S3 API 令牌，凭据暂存密码管理器（绑定与 secrets 由 `add-ai-media-generation` 接入），验证 `wrangler r2 bucket list` 中存在该桶
- [ ] 5.6 重新部署后在 Workers Logs 中确认 jobs-staging 的计费 Cron 不再出现 `billing.provider_unconfigured`，验证在日志中检索该事件近 1 小时为 0 条

## 6. staging 冒烟用例

- [x] 6.1 修改 `apps/web/playwright.config.ts`：存在 `STAGING_URL` 时使用其为 `baseURL`、不启动 webServer、只运行 `e2e/staging/`；否则保持现有行为并忽略 `e2e/staging/`；验证本地 `pnpm --filter @saas/web exec playwright test --list` 的用例清单与改动前一致
- [ ] 6.2 新增 `apps/web/e2e/staging/smoke.spec.ts`（首页、定价页、随机邮箱注册并进入个人空间，共注册 1 次），验证本机 `STAGING_URL=https://web-staging.saas-jobs.workers.dev pnpm --filter @saas/web exec playwright test` 全部通过

## 7. 自动发布流水线

- [ ] 7.1 新增 `scripts/staging/wait-healthy.mjs`（参数：URL、期望版本；每 5 秒轮询、最长 3 分钟；成功条件 200 + `db.status=up` + `version` 相等；失败时只打印状态码与 `version`），验证对当前 staging 以正确版本运行退出码 0、以错误版本运行约 3 分钟后退出码 1
- [ ] 7.2【人工】在 Cloudflare 创建 API Token（Workers Scripts 编辑；Workers KV、Queues、Hyperdrive、Workflows 读取；Account Settings 读取），在 GitHub 创建 environment `staging` 并存入 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`STAGING_MIGRATION_DATABASE_URL`，验证 `gh secret list --env staging` 列出三项
- [x] 7.3 新增 `.github/workflows/deploy-staging.yml`（design 决策 6：`workflow_run` 于 main 上 CI 成功 + `workflow_dispatch`；`environment: staging`；`concurrency` 不取消；迁移 → jobs → web（`APP_VERSION=<sha>`）→ wait-healthy → Playwright staging，安装 chromium），验证 `actionlint`（或 `gh workflow view`）无错误，且 `ci.yml` 未获得任何 staging secret
- [ ] 7.4 合并本 change 的代码后，验证首次自动发布成功：Actions 中 `deploy-staging` 全部步骤通过，`/api/health` 的 `version` 等于该合并提交的 SHA

## 8. 文档

- [ ] 8.1 新增 `docs/runbooks/staging-neon.md`：Neon 建库与权限（含 1.2 记录的差异）、Hyperdrive 配置、secrets 核对、手动部署、从空库重建 staging、回滚到本机 Tunnel、Neon 用量检查；验证按文档在一个新的 Neon 分支上重建可得到与 1.3、1.4 相同的结果
- [ ] 8.2 更新 `docs/07-infrastructure.md` §0（阶段一 staging 数据库改为 Neon）、§2（Neon 直连说明与 71-locks 结果）、§3 环境表、§5（main 流水线自动迁移与部署；阶段一不再要求本机执行 staging 迁移），更新 `docs/08-roadmap.md`「CI 能力建设」两项为完成，以及 `docs/runbooks/p2-staging-preparation.md`、`p2-payment-integration.md` 中指向本机 `saas_staging` 的命令；验证 `grep -rn "localhost:5432/saas_staging" docs` 只剩历史记录段落且已标注为历史

## 9. 集成验收与收尾

- [ ] 9.1 在 staging 手工走一遍：注册 → 定价页显示 Stripe / PayPal 可选 → Stripe 测试卡购买一个积分包 → 余额增加；验证 `webhook_event` 中该事件只处理一次，jobs 心跳持续更新（本项只验证环境可用，P2 的完整验收仍在 `add-billing-and-credits` 11.1）
- [ ] 9.2【人工】观察 7 天后在 Neon 控制台记录计算与存储用量，决定是否升级计划；删除旧 Hyperdrive 配置 `c4b28441aeaf49c3853a321a39cf8ec4` / `1b360caddf134503af774993499bdc4e`，并决定 Tunnel `saas-template-local` 与 Workers VPC 服务的去留；验证结论写入 `docs/runbooks/staging-neon.md`
