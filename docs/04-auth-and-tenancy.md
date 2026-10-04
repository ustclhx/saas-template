# 04 · 认证与多租户

## 1. 认证（Better Auth）

### 登录方式（由 `template.config.ts` 开关）
- 邮箱 + 密码。**默认不强制验证邮箱**（`auth.requireEmailVerification = false`）：注册后即可登录使用，注册时不发送验证邮件；用户领取注册赠送积分时才触发验证（发送验证邮件，验证完成后发放，见 05-billing §4「注册赠送防刷」），也可以在账号设置中主动验证。设为 `true` 时注册即发送验证邮件，未验证不能登录。OAuth 提供方返回已验证邮箱的账号直接视为已验证。
  - 「发送验证邮件」入口：`POST /api/auth/send-verification-email`（`{ email, callbackURL }`，客户端为 `authClient.sendVerificationEmail`），账号设置与领取注册赠送积分都用它；已登录时只能为自己的邮箱发送，免 Turnstile，但与其他发信入口一样按 IP + 邮箱限流。
  - 强制验证时，未验证账号的密码登录返回 403 `EMAIL_NOT_VERIFIED`，并自动重发一封验证邮件（`sendOnSignIn`）；点击链接后自动登录。实现见 `packages/auth/src/email-verification.ts`。
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
- **会话读取的分层**（`packages/auth/src/session.ts`）：
  1. `session.cookieCache`（签名 Cookie，`maxAge` 5 分钟）：绝大多数请求不读 KV 也不查库。
  2. `secondaryStorage` 接 KV（绑定 `CACHE`，键前缀 `auth:`）：cookie 缓存过期后读 KV，减少跨地域查库；KV 未命中时回退查库。
  3. 同时保留数据库中的 session 表（`session.storeSessionInDatabase`），作为吊销与审计的事实来源。
  - 吊销必须经 Better Auth（退出登录、撤销会话、封禁、改密码等），它同时删除数据库行与 KV 副本。只在数据库中删除会话行（如手写 SQL）不会删除 KV 副本，KV 中的会话会一直有效到其 TTL（会话过期时间）；运维脚本需同时删除 `auth:<token>`。
  - 验证码、验证链接等验证值同时写 KV 与数据库（`verification.storeInDatabase`）：KV 跨节点最终一致，在另一节点校验时可能读不到；一次性消费在数据库中原子完成。
  - KV 的 `expirationTtl` 最少 60 秒，适配层把更短的 TTL 提升到 60 秒。
  - Better Auth 自带的 rateLimit 改用 isolate 内存，不存 KV：每个请求写同一个键会触发 KV「同一键每秒最多写 1 次」的限制，且计数最终一致。认证入口的限流以 `RL_AUTH` 为准（见下文）。
- **吊销不是即时的**：KV 的写入和删除传播到所有边缘节点最多约 60 秒，再叠加 cookie 缓存的 `maxAge`，改密码 / 封禁 / 踢下线后，旧会话最长可能还有效「cookieCache maxAge + 约 60 秒」。可接受的场景照常使用；以下**敏感操作不走缓存，直接查库**校验会话与 `user.banned`：
  - 修改密码 / 邮箱 / 2FA、删除账号
  - 计费操作（结账、取消订阅、门户）、成员与角色管理、创建 API Key
  - `/admin` 下的所有请求
- **实时校验的实现**（`packages/auth/src/fresh-session.ts`）：`requireFreshSession({ auth, db, headers })` 只从签名 Cookie 取会话 token（校验 HMAC 签名），会话与用户直接查库；会话不存在或已过期返回 401 `SESSION_REQUIRED`，用户被封禁（`banned` 且 `banExpires` 为空或未到）返回 403 `USER_BANNED`。业务代码（计费、`/admin`、成员管理的 server function 等）在 handler 开头调用它。Better Auth 自带的敏感接口（`/change-password`、`/change-email`、`/two-factor/*`、`/delete-user`、`/revoke-*`、`/admin/*`、`/api-key/create`、organization 的成员与邀请管理）由同文件中的插件在执行前做同样的校验——Better Auth 的 `sensitiveSessionMiddleware` 只绕过 Cookie 缓存，仍会读 KV。

### 密码哈希（2.4 实测，2026-10-04）

**结论：改用 PBKDF2。** Better Auth 默认的 scrypt（N=16384、r=16、p=1，workerd 中走 `node:crypto` 原生实现）在本地 workerd 中单次约 36 ms，注册 / 登录约 47–49 ms（p95 超过 50 ms），修改密码要算两次，约 81 ms，超过 design.md 设定的 50 ms 阈值。改为 Web Crypto 的 PBKDF2-HMAC-SHA256（100,000 次迭代，`packages/auth/src/password.ts`）后，注册 / 登录 / 修改密码约 16–21 ms。哈希格式为 `pbkdf2-sha256$<迭代次数>$<salt>$<hash>`，校验时兼容 scrypt 格式的旧哈希。

测量方法：`pnpm --filter @saas/auth probe:cpu`（`packages/auth/probe/`），在 vitest-pool-workers 的 workerd 中经 `auth.handler` 执行完整流程，每项 20 次（另有 3 次预热），共 3 轮；关闭 Turnstile 与 RL_AUTH。单位 ms，三轮 p50 的范围（p95 的范围）：

| 项目 | scrypt | PBKDF2（100k） |
|---|---|---|
| 哈希原语 | 37（39–45） | 7（7–8） |
| 校验原语 | 37（38–52） | 6–7（7） |
| 注册 | 49–71（54–95） | 16–21（22–25） |
| 登录 | 47–64（51–91） | 16–25（27–41） |
| 登录（密码错误） | 42–61（44–71） | 11–13（12–15） |
| 修改密码 | 81–84（90–117） | 20–24（22–28） |

对照：绕过 Cookie 缓存的 `get-session`（KV 命中）与单次 `select 1` 的 p50 均为 0 ms（p95 ≤ 7 ms），因此流程耗时几乎全是 CPU，可作为本地 CPU 时间的上限。第 2 轮整体偏高，是本机同时有其他负载。

**本地测量与线上的差异**：
- 本地 workerd 的时钟在纯计算期间会推进，可以在 Worker 内计时；线上 Workers 的时钟只在 I/O 后推进，Worker 内无法这样测 CPU 时间，需看 Workers 日志 / Tail 的 `cpuTime`。
- 本机为 Apple M4，线上边缘服务器单核性能通常更低，同样的哈希会更慢；scrypt 本地已超阈值，线上只会更高。
- 计时是墙钟时间，含本地 PG 与 Miniflare KV 往返（对照组显示不到 1 ms）；线上 CPU 时间不含 I/O 等待。
- Cloudflare 文档规定 Workers 的 PBKDF2 最多 100,000 次迭代，本地 workerd 并不限制（实测 100,001 次被接受），因此迭代次数取 100,000，不随本地结果调高。100,000 次低于 OWASP 对 PBKDF2-SHA256 的建议（600,000），是 Workers 平台上限下的折中；迭代次数随哈希保存，平台放宽后可调高，已有哈希不受影响。
- 部署到 staging 后，应从 Workers 日志确认注册 / 登录的 `cpuTime`，结果补在本节。
- Cookie：`SameSite=Lax`、`Secure`；使用自定义域名，web 与 API 同源，避免跨站 Cookie 问题。
- **防刷**（`packages/auth/src/protection.ts`）：注册（`/sign-up/email`）、登录（`/sign-in/email`、`/sign-in/email-otp`、`/sign-in/magic-link`）、发送验证码（`/email-otp/send-verification-otp`）、找回密码（`/request-password-reset`、`/forget-password/email-otp`、`/email-otp/request-password-reset`）以及发送验证邮件（`/send-verification-email`）在接口执行前依次检查：
  1. `RL_AUTH` 按 IP（`cf-connecting-ip`）限流；
  2. Turnstile（`auth.turnstile=true` 时）：请求头 `x-turnstile-token`，服务端调用 siteverify（带 `remoteip`），缺失、无效或 siteverify 不可达都返回 403 `TURNSTILE_FAILED`；已登录用户调用 `/send-verification-email` 时免检；
  3. `RL_AUTH` 按邮箱（规范化后 SHA-256）限流。
  超限返回 429 `RATE_LIMITED`。不通过时接口本身不执行，不会创建用户或发送邮件；服务端直接调用 `auth.api.*` 不经过这些检查。限额在 `wrangler.jsonc` 的 `ratelimits` 中配置（当前每个 key 每 60 秒 10 次）。
- 本地开发与测试：Turnstile 使用 Cloudflare 官方测试 secret（`1x0000000000000000000000000000000AA` 始终通过、`2x0000000000000000000000000000000AA` 始终失败，见 `apps/web/.dev.vars.example`）；集成测试按官方文档的行为模拟 siteverify，不访问外部服务。`CACHE` 与 `RL_AUTH` 由 Miniflare 模拟。
- 注意 Rate Limiting 绑定的计数是**按 Cloudflare 数据中心分别统计、最终一致**的，不是全局精确计数，只用来防刷和削峰。

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
