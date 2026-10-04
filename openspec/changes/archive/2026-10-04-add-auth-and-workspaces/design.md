# Design

## Context

详细设计见 `docs/04-auth-and-tenancy.md` 与 `docs/03-data-model.md` §1–2、§6–7；动机见 proposal.md。本 change 基于 `setup-scaffold-and-infra` 产出的 monorepo、`packages/config`、`packages/db` 与 CI。

## Goals / Non-Goals

**Goals:**
- 在 Workers 上跑通 Better Auth 及所需插件，确定每请求创建实例的方式。
- 落地「所有业务数据归属 Workspace」的约束：中间件、`scoped()`、lint 检查，供后续 change 直接复用。

**Non-Goals:**
- Passkey、空间级 SSO、自定义域名（设计中列为后续扩展）。
- 删号流程中的计费步骤（取消订阅、退款申请提醒、收回积分）：本 change 提供删除流程的钩子，由 `add-billing-and-credits` 注册实现。
- 后台的用户管理界面（封禁、模拟登录等），在 `add-admin-console` 实现；本 change 只做角色判断与 `/admin` 入口骨架。

## Decisions

1. **Better Auth 实例按请求创建**：`createAuth(env, db, { config, sendEmail })`（实现时增加了依赖参数：模板配置与发信函数由调用方注入，便于测试切换配置、注入假的发信实现；邮件发送在 3.2 接入 `EMAIL_QUEUE`），Drizzle adapter（`pg`）。插件：`organization`、`admin`、`emailOTP`、`magicLink`、`twoFactor`，`apiKey` 预先接入但由 `features.publicApi` 控制是否启用。
2. **ID 与列类型**：通过 `advanced.database.generateId` 生成 UUIDv7；对 Better Auth CLI 生成的 schema 手动把 id / 外键列改为 `uuid`。若某插件内部假设 id 为字符串格式导致失败，退路是 Better Auth 表保留 `text`、业务表用 `uuid`，并在 `docs/02-project-structure.md` 记录例外。
3. **会话三层**：`session.cookieCache`（maxAge 5 分钟）→ `secondaryStorage`（KV）→ 数据库（`storeSessionInDatabase`）。敏感操作通过一个 `requireFreshSession(ctx)` 守卫绕过前两层直接查库，守卫的适用范围以 `specs/user-auth` 中的列表为准。
4. **个人空间创建**放在 `databaseHooks.user.create.after`，与用户创建不在同一事务中；为防止钩子失败导致「有用户无空间」，`withWorkspace` 在找不到个人空间时补建（幂等，依赖 `member` 唯一约束）。备选是自定义注册接口在一个事务内完成两者，但会绕开 Better Auth 的注册流程与插件钩子。 实现中发现仅靠 `member` 唯一约束不能防止并发补建出两个个人空间，因此**个人空间的 id 等于用户 id**（都是 UUIDv7）：空间插入用 `on conflict (id) do nothing`，成员插入依赖 `(organization_id, user_id)` 唯一约束，并发补建也只会得到同一个空间。
5. **slug 生成**：个人空间用 `u-` + 8 位随机 base36，冲突时重试；团队空间由用户填写，校验唯一与保留字（`admin`、`api`、`app` 等）。
6. **中间件链**：`withSession → withWorkspace → withEntitlement → handler`。本 change 实现前两个，`withEntitlement` 先放一个始终通过的占位，由 billing change 替换。
7. **`scoped(db, workspaceId)`**：返回只暴露带 ws 过滤的查询方法的包装对象；配合 Biome GritQL 插件（或独立脚本）禁止在 `apps/web/src/features/**` 中直接调用 `db.select().from(<带 ws 的表>)`。
8. **席位并发**：接受邀请与新增成员在同一事务中先 `pg_advisory_xact_lock(hashtextextended('ws:'||ws, 0))`，再计数并插入。若 Phase 0 实测 advisory lock 不可用，改为 `SELECT ... FROM organization WHERE id=? FOR UPDATE`。
9. **RLS（Q8）**：默认不启用。理由：`scoped()` + lint + 每请求成员校验已覆盖主要风险；RLS 需要每个事务 `SET LOCAL`，会给所有查询路径增加复杂度。保留为可选加固，在 `docs/04` 中记录启用方法。
10. **删除流程钩子**：`registerDeletionStep(kind: 'account' | 'workspace', step)`，按注册顺序在删除事务前（校验）与事务内（执行）调用。billing change 注册「订阅立即取消」「退款提醒」「收回积分」等步骤。

## Risks / Trade-offs

- [Better Auth 插件在 workerd 中依赖未兼容的 Node API] → 开启 `nodejs_compat`；有问题的插件先关闭并在 `docs/04` 记录。
- [scrypt 密码哈希 CPU 时间超限] → 实测注册 / 登录的 CPU 时间；超过 50ms 时替换为 Web Crypto PBKDF2 自定义 hasher（`docs/04` 已列为备选）。
- [会话缓存导致吊销延迟] → 已在 spec 中明确为可接受行为，敏感操作走实时校验。
- [个人空间钩子失败] → 由 `withWorkspace` 补建，见决策 4。

## Migration Plan

新增表，无既有数据。迁移顺序：Better Auth 表 → organization / member / invitation → audit_log / notification。

## Open Questions

- 被删除账号的占位邮箱域名是否需要可配置（默认 `@invalid`），不影响 spec 与任务拆分。
