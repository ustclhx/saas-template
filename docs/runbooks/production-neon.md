# Neon production 操作与验收

本 runbook 对应 `add-cloud-production-neon`（2026-10-15 用户决定：Cloudflare 形态生产数据库使用 Neon 付费档，不自建 PG）。流程沿用 [staging-neon](./staging-neon.md) §1–2，本文只记录生产项目的事实与差异，不含任何凭据。

## 1. 项目（任务 1.1，2026-10-15）

| 项 | 值 |
|---|---|
| 组织 | `Haixin`（`org-ancient-mountain-81615147`），计划 **Launch**（用户 2026-10-15 升级） |
| 项目 | `saas-production`（`super-resonance-99115167`），独立于 staging 项目 `saas-staging` |
| 区域 / 版本 | `aws-us-west-2`（用户选定，与 staging 一致，沿用已验证的 Hyperdrive 锁探针结论）/ Postgres 17 |
| 默认分支 | `main`（`br-cold-morning-ar2z16iw`）；staging 默认分支名为 `production`，两者不要混淆 |
| 读写 endpoint | `ep-morning-resonance-arum7105`（非 pooled 主机名，不带 `-pooler`） |
| 数据库 | `saas_production`，owner `migrator`；创建时默认 owner 为 `neondb_owner` |
| PITR 保留 | 7 天（创建时默认 1 天），见 §4 |
| 计算 | autoscaling 0.25–1 CU（创建时默认固定 1 CU），`suspend_timeout_seconds = 0`（平台默认 5 分钟缩容），见 §4 |

创建命令（`--no-secrets` 不在输出中打印密码）：

```sh
neonctl projects create --org-id org-ancient-mountain-81615147 --name saas-production \
  --region-id aws-us-west-2 --pg-version 17 --database saas_production --role neondb_owner \
  --no-secrets --output json
```

## 1a. 生产域名（任务 1.2，2026-10-15）

- 用户选定 production web 域名 **`app.ezarouter.cc`**；staging 保持 `web-staging.saas-jobs.workers.dev`，不绑定自定义域名。
- Zone `ezarouter.cc`（`c6b12cacca002dc21f9b24370d4a5bd7`）在本 Cloudflare 账号 `170a06d3…` 下，`active`，Free Website 计划；NS 为 Cloudflare（`bingo` / `damien`）。apex 已在使用（Cloudflare 代理），不改动 apex 及其他记录。
- `app.ezarouter.cc` 公共 DNS（DoH `cloudflare-dns.com`）查询 A/AAAA/CNAME 均为 NXDOMAIN，未被占用。本机经代理的普通 `dig` 返回 `198.18.x.x`（fake-ip），不能作为依据。
- 绑定方式：web Worker `env.production` 的 Workers 自定义域名（`routes` 中 `custom_domain: true`），由 Cloudflare 自动建 DNS 记录与证书；存在同名 DNS 记录时绑定失败而不会覆盖。
- 权限：本机 wrangler OAuth 有 `zone (read)`、`workers_routes (write)`、`ssl_certs (write)`，无 DNS 读取权限（DNS records API 返回 Authentication error），实际绑定在 2.1 / 3.3 首次部署时验证。CI 使用的生产 Cloudflare API token（任务 1.4）须对 Zone `ezarouter.cc` 具备 Workers Routes 编辑权限，不能直接沿用只含账号级权限的 staging token。

域名确定后连带的配置（在对应任务中完成）：

| 用途 | 地址 / 动作 | 任务 |
|---|---|---|
| 应用 URL 与认证回调 | `APP_URL=https://app.ezarouter.cc`；Google / GitHub OAuth 生产应用回调登记该域名 | 2.1 / 2.2 |
| 邮件发件域 | 生产发件地址所用域名需在邮件服务商验证，并按其要求在 DNS 增加 SPF / DKIM 记录（需用户在控制台操作或授予 DNS 编辑权限） | 2.2 |
| Turnstile | 生产站点 hostname 加入 `app.ezarouter.cc` | 2.2 |
| 支付 webhook（Q9 后） | `https://app.ezarouter.cc/api/billing/webhooks/stripe`、`/paypal` | 6.1 |
| 只读冒烟 | Playwright `production` project 的 baseURL | 3.2 |

## 2. 受限角色与凭据

按 staging §1 以 **SQL** 创建 `migrator` / `app` / `readonly`（NOSUPERUSER、NOCREATEDB、NOCREATEROLE、NOREPLICATION、NOBYPASSRLS），`GRANT migrator TO neondb_owner` → `ALTER DATABASE saas_production OWNER TO migrator` → `REVOKE migrator FROM neondb_owner`；再以 migrator 执行 `infra/local/initdb/02-db-grants.sql`。

**与 staging runbook 的差异——密码设置**：Neon 控制面拒绝预先计算的 SCRAM 校验值（`ALTER ROLE ... PASSWORD 'SCRAM-SHA-256$...'` 返回 `Neon only supports being given plaintext passwords`），psql `\password` 同样在客户端加密，因此不可用。生产采用：脚本用 `crypto.randomBytes(32)` 生成 64 位十六进制密码，`ALTER ROLE ... PASSWORD '<明文>'` 只经 psql **stdin** 与 TLS 发送；连接参数通过 `PG*` 环境变量传入，连接串与密码不出现在命令参数、shell 历史或输出中。默认 owner 连接串由 `neonctl connection-string main --role-name neondb_owner` 取得后只在脚本内存中使用。

三个非 pooled 直连 URL（`sslmode=require`）保存在主 checkout 被忽略的 `.env.production-neon`（600），键名 `NEON_MIGRATOR_URL`、`NEON_APP_URL`、`NEON_READONLY_URL`。该文件只用于运维与恢复演练；CI 迁移凭据在任务 1.4 写入 GitHub `production` environment。

```sh
set -a; . ./.env.production-neon; set +a
psql "$NEON_MIGRATOR_URL" -X -c 'select current_user, current_database()'   # 应为 migrator | saas_production
```

## 3. 验证结果（2026-10-15）

- 身份：owner、migrator、app、readonly 分别返回 `<角色> | saas_production`。
- 数据库 owner 与 public schema owner 均为 `migrator`；public ACL 为 `{migrator=UC/migrator,app=U/migrator,readonly=U/migrator}`。
- 三角色 `rolsuper / rolcreatedb / rolcreaterole / rolreplication / rolbypassrls` 均为 false，`pg_has_role(rolname,'neon_superuser','MEMBER')` 均为 false。
- 拒绝验证（独立事务、ROLLBACK）：app `CREATE TABLE public.t` → `permission denied for schema public`；readonly `CREATE TABLE public.t` → 同上；app `CREATE SCHEMA` → `permission denied for database saas_production`。
- 尚未迁移（0 张业务表）：app 修改 `audit_log`、readonly 写业务表的拒绝验证在首次生产发布（任务 3.3）迁移后执行，届时迁移记录数应等于 `packages/db/migrations/meta/_journal.json` 条目数。

## 4. 项目设置与费用（2026-10-15 用户按推荐配置确认）

用户在组织升级 Launch 后按以下推荐配置确认，已经 Neon API（`neonctl api ... -X PATCH`）修改并回读核对：

| 项 | 创建时默认 | 现值 |
|---|---|---|
| 生产 PITR 保留 | 1 天 | **7 天**（`history_retention_seconds = 604800`，Launch 上限） |
| 生产计算 | 固定 1 CU | **autoscaling 0.25–1 CU**（endpoint 与项目默认值），缩容沿用平台默认 5 分钟 |
| staging 计算上限 | 0.25–8 CU（升级后） | **0.25–2 CU**（两个 endpoint 与项目默认值） |

**费用依据**（[Neon 定价](https://neon.com/pricing)，2026-10-15 查询，Launch）：$0.106/CU-hour、$0.35/GB-月、PITR history $0.20/GB-月，每项目含 10 个分支与 500 GB 出流量，无月度最低消费。升级为组织级：同组织的 `saas-staging` 与无关项目 `yingshu` 也按量计费，不再受 Free 的 100 CU-hours 上限保护。

**估算（每月，待 Usage 复核）**：生产首次发布前接近 $0；发布后默认 Cron 使 compute 基本常驻，0.25 CU 空闲约 183 CU-hours ≈ $20–25（固定 1 CU 时约 $77）；测试期生产使用 `CRON_PROFILE=reduced` 时约 33 CU-hours ≈ $4（见提案 2.1 / D7）；存储与 7 天 history 低于 $0.1；staging 约 $4，验收期另加 $1–3。

## 5. 逻辑备份存储与加密（任务 1.3，2026-10-15）

用户选定 R2。桶与规则由 wrangler 创建并回读核对：

| 项 | 值 |
|---|---|
| 桶 | `saas-production-backups`（账号 `170a06d3…`，2026-10-15T08:57Z 创建），r2.dev 公开访问关闭 |
| Bucket Lock | `retain-30d`：全部前缀，对象写入后 30 天内不可删除或覆盖 |
| 生命周期 | `expire-35d`：全部前缀，35 天后过期（晚于锁定期，避免删除失败）；未完成分片 1 天后中止。另有平台默认规则：未完成分片 7 天后中止 |

保留策略：每日一份，约保留 35 份；锁定期内即使 R2 凭据泄露也无法删除已有备份。调整保留期时先改生命周期再改锁（生命周期天数始终大于锁定天数）。

加密：备份上传前用 age 公钥加密，私钥不进仓库与 CI。

- 公钥（`BACKUP_AGE_RECIPIENT`）：`age1e7a6xlm8rfj0skg8658qhk559prk6g6d4pcrtk0usl5g43e4c3fq3l3tve`
- 私钥：开发机 `~/.config/saas-template/production-backup.agekey`（目录 700、文件 600），生成后已做一次加解密往返验证。**用户须另存两份离线副本**（如密码管理器 + 离线介质）；私钥丢失则所有备份不可解密，恢复演练（4.2）时验证离线副本可用。

## 6. GitHub environments（任务 1.4，2026-10-15）

| environment | 保护规则 | 允许的 ref | 用途 |
|---|---|---|---|
| `production` | 必需审批人 `ustclhx`，允许本人审批（`prevent_self_review=false`，单人仓库） | 仅 tag `v*` | 生产迁移与部署（3.1） |
| `production-backup` | 无审批（每日定时任务不能等待人工） | 仅分支 `main` | 每日逻辑备份（4.1） |

| environment | 名称 | 类型 | 状态 |
|---|---|---|---|
| production | `PRODUCTION_MIGRATION_DATABASE_URL` | secret | 已写入（Neon migrator 非 pooled 直连） |
| production | `CLOUDFLARE_ACCOUNT_ID` | secret | 已写入 |
| production | `CLOUDFLARE_API_TOKEN` | secret | **待用户创建**：账号级 Workers Scripts / KV / R2 / Queues / Hyperdrive 编辑，Zone `ezarouter.cc` 的 Workers Routes 编辑与 Zone 读取；不复用 staging token |
| production | `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` | secret | 待 5.2 |
| production-backup | `PRODUCTION_READONLY_DATABASE_URL` | secret | 已写入（Neon readonly 非 pooled 直连） |
| production-backup | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | secret | **待用户创建**：R2 API token，Object Read & Write，仅限桶 `saas-production-backups` |
| production-backup | `BACKUP_BUCKET` / `BACKUP_AGE_RECIPIENT` / `R2_ACCOUNT_ID` | variable | 已写入（非机密） |

secret 均经 stdin 写入（无末尾换行），不出现在命令参数或输出中。仓库级 secrets 为空，生产值只存在于上述两个 environment；PR 与 `deploy-staging.yml`（environment `staging`）的作业无法读取。用户自行写入时在 Claude Code 提示符执行，输入不回显：

```sh
! gh secret set CLOUDFLARE_API_TOKEN --env production
! gh secret set R2_ACCESS_KEY_ID --env production-backup
! gh secret set R2_SECRET_ACCESS_KEY --env production-backup
```
