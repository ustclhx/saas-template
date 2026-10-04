# 04 · 认证与多租户

## 1. 认证（Better Auth）

### 登录方式（由 `template.config.ts` 开关）
- 邮箱 + 密码。**默认不强制验证邮箱**（`auth.requireEmailVerification = false`）：注册后即可登录使用，注册时不发送验证邮件；用户领取注册赠送积分时才触发验证（发送验证邮件，验证完成后发放，见 05-billing §4「注册赠送防刷」），也可以在账号设置中主动验证。设为 `true` 时注册即发送验证邮件，未验证不能登录。OAuth 提供方返回已验证邮箱的账号直接视为已验证。
- 邮箱验证码（`emailOTP` 插件，开关 `auth.emailOtp`）
- 魔法链接（`magicLink` 插件，开关 `auth.magicLink`）；两者可同时开启
- OAuth：Google、GitHub（可扩展其他 provider）
- 可选：两步验证（`twoFactor`）、Passkey（后续）

### 插件
| 插件 | 用途 |
|---|---|
| `organization` | Workspace、成员、邀请、角色 |
| `admin` | 平台角色（user/admin）、封禁、模拟登录（impersonate） |
| `apiKey` | 公开 API 的密钥（`features.publicApi=true` 时启用） |
| `emailOTP` | 邮箱验证码登录（`auth.emailOtp`） |
| `magicLink` | 魔法链接登录（`auth.magicLink`） |
| `twoFactor` | 可选 |

### Workers 适配要点
- 每个请求创建 `auth` 实例（`createAuth(env)`），内部用该请求的 Drizzle 实例（Drizzle adapter，provider `pg`）。
- **会话读取的分层**：
  1. `session.cookieCache`（签名 Cookie，短 `maxAge` 如 5 分钟）：绝大多数请求不读 KV 也不查库。
  2. `secondaryStorage` 接 KV：cookie 缓存过期后读 KV，减少跨地域查库。
  3. 同时保留数据库中的 session 表（`session.storeSessionInDatabase`），作为吊销与审计的事实来源。
- **吊销不是即时的**：KV 的写入和删除传播到所有边缘节点最多约 60 秒，再叠加 cookie 缓存的 `maxAge`，改密码 / 封禁 / 踢下线后，旧会话最长可能还有效「cookieCache maxAge + 约 60 秒」。可接受的场景照常使用；以下**敏感操作不走缓存，直接查库**校验会话与 `user.banned`：
  - 修改密码 / 邮箱 / 2FA、删除账号
  - 计费操作（结账、取消订阅、门户）、成员与角色管理、创建 API Key
  - `/admin` 下的所有请求
- 密码哈希在 Paid 套餐下可接受；若实测 CPU 偏高，可替换为 Web Crypto 的 PBKDF2 自定义 hasher（待验证）。
- Cookie：`SameSite=Lax`、`Secure`；使用自定义域名，web 与 API 同源，避免跨站 Cookie 问题。
- Turnstile：注册、登录、发送验证码、找回密码四个入口校验 token。
- 限流：Rate Limiting 绑定按 IP + 邮箱维度限制认证接口；Better Auth 自带 rateLimit 使用 secondaryStorage。注意 Rate Limiting 绑定的计数是**按 Cloudflare 数据中心分别统计、最终一致**的，不是全局精确计数，只用来防刷和削峰。

### 邮件
验证邮件、OTP、重置密码、邀请邮件均通过 `EMAIL_QUEUE` 异步发送；OTP 类邮件若对时效敏感也可同步直发（Resend HTTP API）。

## 2. 平台角色 vs 空间角色

| 层级 | 角色 | 能力 |
|---|---|---|
| 平台（`user.role`） | `user` | 普通用户 |
| | `admin` | 进入 `/admin`：用户管理、订单、积分调整、模型配置、系统设置、模拟登录 |
| 空间（`member.role`） | `owner` | 全部权限，含账单、删除空间、转让 |
| | `admin` | 成员管理、使用 AI、查看账单 |
| | `member` | 使用 AI、查看自己的用量 |

权限判断统一在 `packages/entitlements` 的 `can(ctx, action)` 中实现，同时考虑：空间角色、套餐权益、空间状态（是否欠费/被封）。

## 3. 多租户：「个人空间」模型

### 核心规则
1. **所有业务数据归属 Workspace**（`organization`），从不直接归属用户。
2. 用户注册成功后（Better Auth `databaseHooks.user.create.after`）自动创建个人空间：`is_personal=true`，用户为 `owner`，并设为 `active_organization_id`。
3. 计费主体是 Workspace：订阅、积分、订单都挂在 Workspace 上；积分流水额外记录 `user_id`。

### 开关行为

| 行为 | `multiTenant=false` | `multiTenant=true` |
|---|---|---|
| 个人空间 | ✅ 自动创建 | ✅ 自动创建 |
| 创建团队空间 | ❌ | ✅（受 `maxWorkspacesPerUser` 与套餐权益限制） |
| 邀请成员 | ❌ | ✅（仅团队空间） |
| 空间切换器 UI | 隐藏 | 显示 |
| URL | `/app/$slug/...` | `/app/$slug/...` |
| 席位计费 | — | 可选（权益 `maxSeats`） |

实现方式：代码路径完全一致，开关只影响 **UI 可见性** 与 **创建/邀请接口的准入校验**。关闭开关后已有的团队空间保持只读可访问（避免数据丢失）。

**URL 统一为 `/app/$slug/...`**：个人空间注册时自动生成 slug（如 `u-` + 短随机串，用户可改）。不为 `multiTenant=false` 单独做一套不带 slug 的路由——两套路由会让「代码路径完全一致」不成立，而且中途打开开关会让已分享出去的链接全部失效。`/app` 本身只做重定向：跳到 `active_organization_id` 对应空间（没有则跳个人空间）。

### 当前空间的解析
- 优先级：URL 中的 `$slug` → session.active_organization_id → 用户的个人空间（后两者只用于 `/app` 的重定向）。
- `withWorkspace` 中间件解析后**每次请求查库**校验成员身份（不使用会话缓存中的数据，避免被移出的成员在缓存有效期内仍可访问），把 `{ workspace, member }` 注入上下文。

### 席位
- 接受邀请、新增成员时与 AI 任务提交一样，先取空间级事务锁 `pg_advisory_xact_lock(hashtextextended('ws:' || $ws, 0))`，再在同一事务内检查 `count(member) < maxSeats` 并插入，避免并发接受邀请导致超员。
- 降级到席位更少的套餐时不自动移除成员：超员期间禁止新增成员，并在空间设置页提示 owner 处理。

### 数据隔离
- **共享库 + 共享表 + `workspace_id` 列**。
- `scoped(db, workspaceId)`（`@saas/db`）返回预绑定过滤条件的查询工具：`select` / `count` / `findById` / `insert`（自动填入空间 id）/ `update` / `delete` / `updateById` / `deleteById` / `transaction`；按 id 访问其他空间的记录与访问不存在的记录一样抛出 `NOT_FOUND`（404），不泄露记录是否存在。
- 禁止绕过：Biome GritQL 插件 `packages/db/lint/no-unscoped-workspace-query.grit` 在 `apps/web/src/features/**` 与 `apps/jobs/src/**`（不含测试）中拦截对带空间列的表的直接 `db.select().from(t)` / `insert` / `update` / `delete` / `db.query.t`，随 `pnpm check` 在 CI 中执行。新增带 `workspace_id` 的表时须同步插件中的表清单（有测试对照 schema 校验）。确需跨空间的系统任务用 `// biome-ignore lint/plugin: <理由>` 显式豁免。
- Postgres RLS 作为**可选加固**：事务内 `SET LOCAL app.workspace_id = ...` + 策略。Hyperdrive 以事务为单位复用连接，`SET LOCAL` 在事务内安全（待验证）；默认不启用以降低复杂度。
- R2 对象 key 以 `ws/{workspaceId}/...` 为前缀，下载一律经服务端鉴权后签发短期 URL。

## 4. 删除账号与空间

财务与审计数据必须保留，因此删除一律是「软删 + 匿名化」，不物理删除 `user` / `organization` 行（外键策略见 03-data-model §7）。

**删除空间**（仅团队空间，owner 操作）：
1. 前置条件：没有「会续费的」订阅（需先取消），没有运行中的 AI 任务。
2. 置 `organization.deleted_at`，撤销所有邀请，移除所有成员关系，作废该空间的 API Key。
3. 剩余积分批次写 `revoke` 流水并置为 `revoked`。
4. 内容数据（对话、任务、文件及 R2 对象）在保留期（如 30 天）后由 Cron 物理删除；保留期内可由平台管理员恢复。

**删除账号**（用户本人，需近期重新验证身份）：
1. 前置条件：用户不是任何团队空间的唯一 owner（需先转让或删除这些空间）。
2. **退款提醒**：确认删除前，若个人空间有生效中的订阅或 `refundWindowDays` 内的付款，页面明确提示「删除账号默认不退款」，并提供「先申请退款」入口（创建 `refund_request`，见 05-billing「退款申请」）。用户可以先申请再删号，也可以直接删号；删号不会撤销已提交的申请，审核结果发到申请时填写的联系邮箱。
3. 个人空间按「删除空间」流程处理：订阅改为**立即取消，不退款**；如申请审核通过，再按审核金额退款。
4. 退出所有团队空间。
5. 匿名化 `user`：`email` 改为 `deleted+{id}@invalid`，清空 `name` / `image` / `locale` / `timezone`，删除 `account`（密码哈希与 OAuth 令牌）、`session`（含 KV 中的副本）、`two_factor`、`apikey`、`verification`；置 `banned=true` 防止登录。
6. 写 `audit_log`。`credit_ledger`、`payment`、`audit_log` 中对该用户的引用保持不变，指向已匿名化的行。
7. 同一邮箱可重新注册（新的 user 行）；注册赠送积分按规范化邮箱哈希去重，不会再次发放。

## 5. 后续扩展
- 租户自定义域名：Cloudflare for SaaS（Custom Hostnames）。
- 空间级 SSO / 审计导出：面向 B2B 时再做。
