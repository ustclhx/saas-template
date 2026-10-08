# Neon staging 操作与验收

本 runbook 对应 `add-cloud-staging-neon`。staging 专用 Neon Postgres 17（`aws-us-west-2`），数据库 `saas_staging`，角色 `migrator` / `app` / `readonly`；Hyperdrive 使用非 pooled 直连，TLS `sslmode=require`。不搬迁本机旧 staging 数据，不改变本地 worktree 或阶段二生产方案。

## 当前进度与证据

- 前置 HTTP/2 PR：[#61](https://github.com/ustclhx/saas-template/pull/61)，已验证 compose 命令包含 `--protocol http2`；合并由协调者完成。
- PR 2 准备版本注入、支付缺凭据告警、secrets 核对、staging 冒烟和自动发布代码。
- Neon 控制台需要用户登录；数据库、权限差异、迁移、seed、Neon Hyperdrive 与锁探针结果待实测。
- Cloudflare R2 API 返回 `10042`（需先在 Dashboard 启用 R2），未创建桶或令牌。
- GitHub `staging` environment 已通过 CLI 创建（名称已核对），三个 secrets 待配置；Neon / Cloudflare 网页均需用户登录。
- staging 注册冒烟（6.2）、首次自动发布（7.4）、空库重建（8.1）、支付与 Cron（5.6、9.1）均尚未验收。

以下步骤为操作准备，不能作为任务完成证据。实测后记录 UTC、提交 SHA、资源 ID、命令退出码和关键非敏感结果；不记录任何密码、连接串、token 或 API key。

## 1. 建库与本地凭据

在已登录的 Neon 控制台使用 Free 计划创建项目（建议名 `saas-staging`），Postgres 17、`aws-us-west-2`。创建三个角色，以 `migrator` 为 owner 创建 `saas_staging`。若遇到登录验证、付费、条款、账号/组织选择或已有资源覆盖，交给用户。

三个账号必须使用直连主机名，不能带 `-pooler`。保存到密码管理器；从控制台 Copy 操作经剪贴板写入被忽略的 `.env.staging-neon`，键名为 `NEON_MIGRATOR_URL`、`NEON_APP_URL`、`NEON_READONLY_URL`，文件权限 600。先执行 `git check-ignore .env.staging-neon`。复制后立即清空剪贴板，不用 echo、shell tracing 或把真值拼入历史。

```sh
set -a
. ./.env.staging-neon
set +a
# libpq 从环境读取，命令参数不包含连接串。
PGDATABASE="$NEON_MIGRATOR_URL" psql -X -v ON_ERROR_STOP=1 \
  -c 'select current_user, current_database()'
```

只有返回 `migrator | saas_staging` 后才执行写入。始终不连接本机共享 `saas_dev` / `saas_staging`，本地验证只连接当前 worktree 数据库。

## 2. 权限、迁移与 seed

不在 Neon 执行含本地密码的 `01-roles.sql`。以 migrator 执行现有权限脚本：

```sh
PGDATABASE="$NEON_MIGRATOR_URL" psql -X -v ON_ERROR_STOP=1 \
  -f infra/local/initdb/02-db-grants.sql
PGDATABASE="$NEON_MIGRATOR_URL" psql -X -c '\dn+ public'
MIGRATION_DATABASE_URL="$NEON_MIGRATOR_URL" pnpm --filter @saas/db db:migrate
PGDATABASE="$NEON_MIGRATOR_URL" psql -X \
  -c 'select count(*) from drizzle.__drizzle_migrations'
```

迁移记录数应等于 `packages/db/migrations/meta/_journal.json` 条目数。核对 public owner 为 migrator，app 只有 USAGE；用 app 在事务中尝试 `create table t(x int)` 与 `UPDATE audit_log SET action=action WHERE false`，应均拒绝，最后 ROLLBACK。测试即使意外成功也不会留下表或更改审计记录。

若 Neon 拒绝权限语句，停止该步骤，由默认 owner 补执行对应语句，并记录语句、非敏感错误及处理结果；不修改原 SQL 的本地/CI 行为。**实测差异：待填写。**

确认 app 的 `current_database()` 为 `saas_staging` 后：

```sh
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_APP_URL" pnpm billing:seed
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="$NEON_APP_URL" pnpm billing:seed
PGDATABASE="$NEON_APP_URL" psql -X -c 'select key from plan order by key'
```

应为 free / pro / team / credit_pack 四套餐，两次执行行数不变；seed 不是平台价格同步，真实购买前按 [P2 支付联通](./p2-payment-integration.md) 同步测试报价。

## 3. Hyperdrive 与切换

先核对已有名称，不覆盖资源。新建 `saas-staging-neon`（关缓存）与 `saas-staging-neon-cached`（max_age 60）。直连参数从环境读取；禁用命令 tracing，CLI 输出只保留名称、ID 与缓存配置，不输出源连接串。

```sh
pnpm --dir apps/web exec wrangler hyperdrive create saas-staging-neon \
  --connection-string "$NEON_APP_URL" --caching-disabled
pnpm --dir apps/web exec wrangler hyperdrive create saas-staging-neon-cached \
  --connection-string "$NEON_APP_URL" --max-age 60
```

PR 2 合并后，从最新 origin/main 创建 PR 3 分支，替换两个 app 的 `env.staging.hyperdrive` ID 和 Neon 注释。旧关缓存 ID `c4b28441aeaf49c3853a321a39cf8ec4`，旧缓存 ID `1b360caddf134503af774993499bdc4e`；观察期保留。

```sh
pnpm --filter @saas/jobs deploy:staging
APP_VERSION="$(git rev-parse HEAD)" pnpm --filter @saas/web deploy:staging
node scripts/staging/wait-healthy.mjs https://web-staging.saas-jobs.workers.dev/api/health "$(git rev-parse HEAD)"
STAGING_URL=https://web-staging.saas-jobs.workers.dev pnpm --filter @saas/web exec playwright test --project staging
```

健康检查应 200、db.up、版本匹配；10 分钟内 jobs.lastCronAt 更新。按 `scripts/probes/71-locks/README.md` 对新关缓存 ID 重跑一轮七场景；探针 token 只走 secret/stdin，避免 README 示例的明文参数。只操作本轮创建的临时探针，保留其他现有资源。记录日期、往返延迟、锁释放与七场景结论到 docs/07。**结果：待填写。**

## 4. 配置与自动发布

```sh
pnpm staging:check-secrets
```

脚本核对两个 Worker 的 secret 名称；必需项缺失退出 1，可选项缺失仍列出。web 必需 Auth、Turnstile、OAuth 四项、Stripe 两项、PayPal 三项；jobs 必需 Stripe 两项和 PayPal 三项。可选为 RESEND_API_KEY、AI_GATEWAY_TOKEN、SENTRY_DSN。真值只通过标准输入写 Wrangler，严禁覆盖已有密钥；Stripe 仅 Test mode，PayPal 仅 Sandbox，webhook 事件按 P2 runbook。

创建 AI Gateway `saas-staging`，账号与 Gateway ID 写 web staging vars；开启鉴权时 token 走 secret。R2 `files-staging` 与仅该桶的 S3 API 令牌由此任务准备，绑定由媒体 change 接入；如启用 R2 涉及付款/绑卡/条款，交给用户。

GitHub environment `staging` 需要 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、STAGING_MIGRATION_DATABASE_URL。CI token 权限为 Workers Scripts 编辑，Workers KV / Queues / Hyperdrive / Workflows / Account Settings 读取。token 从控制台 Copy 后经剪贴板 stdin 写 `gh secret set`，立即清空；迁移 URL 只从忽略文件 stdin 传入。用 `gh secret list --env staging` 仅核对名称。

`deploy-staging.yml` 跟随 main 成功 CI，检出该次 head_sha；手动运行也限 main。environment 限制 secrets，PR CI 不引用它们。`staging-deploy` 串行且不取消：迁移 → jobs → web（完整 SHA）→ 3 分钟版本探活 → staging Chromium 冒烟。验证首次合并发布每步通过后，再勾选 7.4。手动重发：

```sh
gh workflow run deploy-staging.yml --ref main
```

配置后重新发布并检查近 1 小时 Workers Logs 没有 `billing.provider_unconfigured`；注册 → 两平台可选 → Stripe 测试积分包购买 → 余额增加，核对 webhook 只处理一次及 Cron 心跳。

## 5. 空库重建与回滚

重建只用新的 Neon 分支/空数据库，先核对它仍叫 `saas_staging`，不删除/覆盖现有库。重复 §1–2，验证权限、迁移数及 seed 幂等一致；将新分支直连信息写受保护本地文件。验证完成后才决定是否切换 Hyperdrive，不自动删除分支。

回滚前由用户确认本机旧 staging PG 与 cloudflared 可用。把两个 app 的 staging ID 还原为 §3 旧值，按 jobs → web 发布；确认健康与心跳。必要时由协调者禁用 `deploy-staging.yml`，避免自动发布覆盖回滚。Neon 新库与本机旧库是独立数据集，回滚不复制测试数据。

## 6. 七天观察（任务 9.2 保持未完成）

记录切换日期后观察满七天。每日检查 /api/health、Cron 心跳、错误率；Neon Dashboard 查看计算小时与存储占用，记录 Free 配额、使用量和预计耗尽时间。jobs 高频 Cron 可能使计算无法休眠；不更改 Cron 频率来节省用量。需要升级/关闭 scale-to-zero 时交给用户决定。

七天后由用户决定是否删除旧 Hyperdrive、保留 Tunnel `saas-template-local` 与 Workers VPC 服务供阶段二使用。本次不执行删除、不提前勾选 9.2。**用量与去留结论：待观察后填写。**
