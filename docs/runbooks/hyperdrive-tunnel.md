# Runbook · 本机数据库经 Tunnel 接入 Hyperdrive（阶段一 staging）

把开发者本机 Docker 中的 Postgres 接到 Cloudflare 上的 staging Worker：

```
Worker（*.workers.dev）→ Hyperdrive → Workers VPC 服务（TCP）→ Tunnel → cloudflared ×2（本机 Docker）→ Postgres（TLS）
```

不需要域名、DNS 记录、Access 应用或 Service Token。背景与取舍见 `docs/07-infrastructure.md` §0、§2。

## 当前资源（账号 `170a06d37ad50396b19943eb6b77a21d`）

| 资源 | 名称 | ID |
|---|---|---|
| Tunnel | `saas-template-local` | `1fad053b-8b3b-4dde-a8aa-7ddf524847a3` |
| Workers VPC 服务 | `saas-template-local-pg`（主机名 `postgres`，端口 5432，不校验证书） | `01a10214-295e-78c1-b8db-506adb15ef2a` |
| Hyperdrive（关缓存） | `saas-template-staging` → 绑定 `HYPERDRIVE` | `c4b28441aeaf49c3853a321a39cf8ec4` |
| Hyperdrive（开缓存，max_age 60s） | `saas-template-staging-cached` → 绑定 `HYPERDRIVE_CACHED` | `1b360caddf134503af774993499bdc4e` |
| Queue | `email-staging` | — |
| Workflow | `ai-media-staging`（定义在 `jobs-staging`） | — |
| Worker | `jobs-staging`、`web-staging` | `https://web-staging.saas-jobs.workers.dev` |

workers.dev 子域名 `saas-jobs` 是账号级设置（第一次部署时由 wrangler 自动注册），可在 Cloudflare 控制台 Workers → 子域名处修改；修改后所有 `*.workers.dev` 地址随之改变。

## 前置条件

- Docker Desktop 已启动；`pnpm install` 已完成。
- 已登录 Cloudflare：`pnpm --dir apps/web exec wrangler login`（OAuth 已包含 Tunnel、Workers VPC、Hyperdrive、Queues、Workers 所需权限）。
- 下文命令均在仓库根目录执行，`W` 表示 `pnpm --dir apps/web exec wrangler`。

## 一、日常使用

```bash
# 启动本机 PG（TLS）与两个 cloudflared 副本
docker compose -f infra/local/docker-compose.yml --profile tunnel up -d

# 检查：两个副本各注册 2 条连接，Tunnel 状态 healthy
docker compose -f infra/local/docker-compose.yml --profile tunnel logs cloudflared | grep "Registered tunnel connection"
W tunnel info saas-template-local

# 检查 staging 链路
curl -s https://web-staging.saas-jobs.workers.dev/api/health

# 不用 staging 时只停 cloudflared（本机开发不受影响）
docker compose -f infra/local/docker-compose.yml --profile tunnel stop cloudflared
```

本机关机或 cloudflared 停止时，staging 的 `/api/health` 返回 503，属预期行为。

## 二、从零重建

### 1. 本机 Postgres 启用 TLS

`infra/local/docker-compose.yml` 通过 `pg-tls-entrypoint.sh` 在首次启动时生成自签证书并开启 `ssl=on`（Workers VPC 要求数据库启用 TLS）。

```bash
docker compose -f infra/local/docker-compose.yml up -d postgres
docker exec saas-template-pg psql -U postgres -tAc "show ssl"     # 期望 on
```

### 2. staging 数据库

```bash
docker exec saas-template-pg psql -U postgres -c 'CREATE DATABASE saas_staging'
docker exec -i saas-template-pg psql -v ON_ERROR_STOP=1 -q -U postgres -d saas_staging < infra/local/initdb/02-db-grants.sql
MIGRATION_DATABASE_URL=postgres://migrator:migrator@localhost:5432/saas_staging pnpm --filter @saas/db db:migrate
```

之后每次合并含迁移的改动，都要在本机对 `saas_staging` 重新执行最后一条命令（阶段一 CI 不执行迁移，docs/07 §5）。

### 3. Tunnel 与 cloudflared

```bash
W tunnel create saas-template-local          # 记下输出的 Tunnel ID
```

取运行令牌写入 `infra/local/.env`（已被 `.gitignore` 忽略，不要提交、不要打印到日志）：

```bash
ACCOUNT_ID=170a06d37ad50396b19943eb6b77a21d
TUNNEL_ID=<上一步的 ID>
OAUTH=$(grep oauth_token ~/Library/Preferences/.wrangler/config/default.toml | cut -d'"' -f2)
TOKEN=$(curl -s -H "Authorization: Bearer $OAUTH" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])')
(umask 077; printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "$TOKEN" > infra/local/.env)

docker compose -f infra/local/docker-compose.yml --profile tunnel up -d
```

### 4. Workers VPC 服务

`cloudflared` 与 Postgres 在同一 compose 网络中，VPC 服务的主机名用 compose 服务名 `postgres`；自签证书需要关闭证书校验。

```bash
W vpc service create saas-template-local-pg --type tcp --tcp-port 5432 --app-protocol postgresql \
  --tunnel-id <TUNNEL_ID> --hostname postgres --cert-verification-mode disabled
```

### 5. Hyperdrive

```bash
W hyperdrive create saas-template-staging --service-id <VPC_SERVICE_ID> \
  --database saas_staging --user app --password app --scheme postgresql --caching-disabled
W hyperdrive create saas-template-staging-cached --service-id <VPC_SERVICE_ID> \
  --database saas_staging --user app --password app --scheme postgresql --max-age 60
```

把两个 ID 填入 `apps/web/wrangler.jsonc` 与 `apps/jobs/wrangler.jsonc` 的 `env.staging.hyperdrive`。

> 刚创建 VPC 服务后立即创建 Hyperdrive 可能失败，且命令没有明显报错（重建演练中遇到过）。每次创建后用 `W hyperdrive list` 确认配置存在，不存在就重新执行。

### 6. Queue 与部署

```bash
pnpm --dir apps/jobs exec wrangler queues create email-staging
pnpm --filter @saas/jobs deploy:staging      # 先部署 jobs：web 的 Workflow 绑定指向 jobs-staging
pnpm --filter @saas/web deploy:staging       # CLOUDFLARE_ENV=staging vite build && wrangler deploy
curl -s https://web-staging.saas-jobs.workers.dev/api/health   # 期望 200，db.status = up
```

`jobs.lastCronAt` 在下一次 Cron（每 5 分钟）后出现。

## 验证记录

- 2026-10-03：按本文第二节第 3–5 步，用一次性的名称（`saas-template-rebuild-test*`）在同一 compose 网络中另起一个 cloudflared，重建 Tunnel、VPC 服务与 Hyperdrive，经 `wrangler dev --remote` 查询 `saas_staging` 成功（TLS、`app` 账号），随后按第四节删除。第 1、2、6 步在搭建正式 staging 时已执行。

## 三、排查

| 现象 | 检查 |
|---|---|
| `/api/health` 返回 503 | `docker compose ... ps` 中 cloudflared 是否在运行；`W tunnel info saas-template-local` 是否 healthy；`show ssl` 是否为 on |
| Tunnel healthy 但查询失败 | VPC 服务的主机名是否为 `postgres`（compose 服务名）、端口 5432、证书校验是否为 `disabled` |
| 认证失败（28P01） | Hyperdrive 中的账号密码与本机 `app` 账号是否一致；`saas_staging` 是否执行过 `02-db-grants.sql` |
| 表不存在 | 本机是否对 `saas_staging` 执行了最新迁移 |
| 延迟波动大（160 ms – 2.5 s） | 阶段一请求要绕回开发者本机网络，新建连接时明显变慢；不代表生产延迟（docs/07 §0） |

## 四、删除（停用阶段一 staging）

```bash
pnpm --dir apps/web exec wrangler delete web-staging
pnpm --dir apps/jobs exec wrangler delete jobs-staging
W queues delete email-staging
W hyperdrive delete <两个 Hyperdrive ID>
W vpc service delete <VPC_SERVICE_ID>
docker compose -f infra/local/docker-compose.yml --profile tunnel stop cloudflared
W tunnel delete saas-template-local   # 需等 cloudflared 的连接关闭（停止后约几分钟），否则报错 1022，稍后重试
rm infra/local/.env
```
