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
| PITR 保留（创建时默认） | `history_retention_seconds = 86400`（1 天），见 §4 |
| 计算（创建时默认） | 固定 1 CU，`suspend_timeout_seconds = 0`（平台默认缩容），见 §4 |

创建命令（`--no-secrets` 不在输出中打印密码）：

```sh
neonctl projects create --org-id org-ancient-mountain-81615147 --name saas-production \
  --region-id aws-us-west-2 --pg-version 17 --database saas_production --role neondb_owner \
  --no-secrets --output json
```

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

## 4. 待用户确认的项目设置

以下为成本 / 恢复能力取舍，创建后保持平台默认，未修改：

- **PITR 保留窗口**：当前 1 天。生产建议提高到 Launch 允许的上限（7 天），代价是 history 存储增加。
- **计算规格**：当前固定 1 CU。生产 Cron 保持默认频率会使 compute 基本常驻，固定 1 CU 约 720 CU-hours/月；改为 autoscaling（例如 0.25–1 CU）可在低负载时降低费用。以 Neon Usage 复核后定。
