## Context

- 后台写操作统一经 `apps/web/src/features/admin/action.ts`：`runAdminAction(context, name, handler)` 在写事务内以 `FOR SHARE` 实时校验管理员并强制同事务审计；`runDelegatedAdminAction` 只做实时角色校验（业务自管事务，如退款审核）。`name` 目前只出现在「未写审计」的错误消息里，没有登记表。
- 入口守卫 `adminMiddleware` → `requireAdmin` → `requireFreshSession`（签名 Cookie 取 token、直接查库，拒绝模拟会话），不看会话年龄。
- Better Auth 原生 `/api/auth/admin/*` 已收窄为白名单（`impersonation-http.ts`）：ban / unban / impersonate / stop-impersonating 走 `executeAdminAuthAction`，restore-workspace 走 `executeAdminWorkspaceRestore`，其余 404。
- admin-mcp：令牌即全部凭据（无会话）；写工具 `settings.set`（可写密钥类设置）与 `models.update`（含定价）在 `runAdminAction(ctx, 'mcp.<tool>')` 内执行，审计合并 `via: 'mcp'`、`tokenId`、`tool`。
- 认证配置（模板默认）：`emailPassword`、`emailOtp` 开启，`magicLink`、`twoFactor` 关闭，OAuth 按配置；没有 passkey 插件；会话 `cookieCache` 5 分钟 + KV 二级存储 + 数据库为准。`BOOTSTRAP_ADMIN_EMAILS` 只提升、不降权（`packages/auth/src/admin-bootstrap.ts`）。
- 删号已有「十分钟内真实登录」的新鲜度判断（`packages/auth/src/deletion.ts`），说明产品已接受 10 分钟这一量级。
- 思路参考：某私有建站引擎的做法——敏感入口集中登记并双向测试、验证状态按方式记录且有效期 10 分钟、客户端拦截后弹窗并重新提交同一表单、AI 发起的敏感操作落待确认记录由站长在后台确认、确认标志只能来自服务端确认路径、密钥参数终态即清除。以下均为本项目自己的设计。

### 入口清单（2026-11-25 逐个核对）

| 入口 | 动作名（登记表键） | 敏感 | 理由 |
|---|---|---|---|
| `setAdminUserBan`（+ 原生 `/admin/ban-user`、`unban-user`） | `user.ban` / `user.unban` | 是 | 影响他人访问 |
| `startAdminImpersonation`（+ 原生 `/admin/impersonate-user`） | `user.impersonate` | 是 | 取得他人身份 |
| `stopAdminImpersonation` | `user.impersonate.stop` | 否 | 降权动作，且此时没有管理员会话 |
| `adjustCredits` | `credits.adjust` | 是 | 资金等价物 |
| `replayAdminWebhook` | `billing.webhook_replay` | 是 | 可能发放付款积分 |
| `reviewAdminRefund` | `billing.refund_review` | 通过时是；驳回否 | 资金流出 |
| `completeAdminRefund` | `billing.refund_manual` | 是 | 登记线下退款并收回积分 |
| `retryAdminRefundEmail` | `billing.refund_email_retry` | 否 | 只重发通知 |
| `saveOperationsSettings` | `setting.operations.update` | 是 | 全部为密钥类设置 |
| `saveAdminSettings` / `saveAdminFeatureModels` | `setting.update` | 仅当改动了 `secret: true` 的设置项 | 普通设置属日常 |
| `saveAdminModel` | `ai.model_save` | 新建模型或定价改变时 | 定价即价格 |
| `setAdminModelEnabled` / `copyAdminModel` | `ai.model_toggle` / `ai.model_copy` | 否 | 复制件默认停用、启停可逆 |
| `saveAdminPlanModels` | `admin.plan.models.update` | 是 | 套餐权益变更 |
| `createAdminApiTokenFn` | `admin.api_token.create` | 是 | 产生长期管理员凭据 |
| `revokeAdminApiTokenFn` | `admin.api_token.revoke` | 否（D3，已确认） | 降权，越快越好 |
| `restoreAdminWorkspace`（+ 原生 `/admin/restore-workspace`） | `workspace.restore` | 否 | 只恢复原 owner，30 天内可逆 |
| `inviteAdminWaitlist` | `waitlist.invite` | 否 | 只发邀请 |
| `deleteAdminFeedback` / `getAdminFeedbackConversation` | `ai.feedback.delete` / `ai.feedback.view` | 否 | 日常运营 |
| `/api/admin/observability/sentry-test` | `observability.sentry_test` | 否 | 只抛测试异常 |
| 确认页「确认执行」 | `admin.confirmation.confirm` | 是 | 执行 AI 发起的敏感操作 |
| 确认页「拒绝」 | `admin.confirmation.reject` | 否 | 不产生副作用 |
| MCP `settings.set` / `models.update` | 与后台同名动作 | 同上条件 | 见决策 6 |

模板当前**没有**删除用户、改角色、改套餐价格的后台入口（Better Auth 原生 `remove-user` / `set-role` / `set-user-password` 已 404，`deleteUser` 关闭，价格由 billing seed 同步）。以后新增时必须在登记表中声明，见决策 1。

### Better Auth 核对（better-auth 1.7.7，核对日期 2026-11-25）

| 机制 | 结论 | 出处 |
|---|---|---|
| `session.freshAge` | 只判断 `session.createdAt` 距今是否小于 freshAge（默认 1 天）；`updateAge` 刷新不重置；内置只用于 `/list-sessions`、`/unlink-account` 与无密码的 `/delete-user`；admin 插件端点不检查。恢复「新鲜」只能重新登录（产生新会话） | [Session Management · Session Freshness](https://www.better-auth.com/docs/concepts/session-management)；端点范围由安装包源码核对，文档未列出 |
| twoFactor 已登录时校验 | `/two-factor/verify-totp`、`verify-backup-code`（`disableSession` 选项）在已有会话时直接校验；次数限制与锁定只在登录流程生效（已登录分支的 `beginAttempt` 为空实现），需自行限流；备用码成功即消耗；同一时间窗内 TOTP 可重复使用。**补充（第 2 组复核）**：`verify-totp` 不返回命中的时间窗；`twoFactor.verified !== true` 且用户未开启时，已登录分支会新建会话并删除旧会话 | [Two-Factor Authentication](https://www.better-auth.com/docs/plugins/2fa)；已登录分支由源码 `dist/plugins/two-factor/verify-two-factor.mjs`、`totp/index.mjs`、`backup-codes/index.mjs` 核对（2026-11-25）；[issue #10387](https://github.com/better-auth/better-auth/issues/10387) |
| emailOTP 类型 | 只有 `sign-in`、`email-verification`、`forget-password`（源码另有 `change-email`），类型为固定枚举，不能自定义用途；默认 300 秒、3 次 | [Email OTP](https://www.better-auth.com/docs/plugins/email-otp) |
| magicLink / 社交登录 | 校验即创建新会话并写 Cookie，无「仅重新验证」模式；Google 只支持静态 `prompt`（`select_account` 等），不支持按请求 `max_age` | [Magic Link](https://www.better-auth.com/docs/plugins/magic-link)、[Google](https://www.better-auth.com/docs/authentication/google)；`max_age` / `auth_time` **待核实** |
| 密码校验 | 服务端 `verifyPassword`（`sensitiveSessionMiddleware`，不改会话）。step-up 不经该端点：直接用模板的 `passwordHasher.verify`（`packages/auth/src/password.ts`，兼容 Better Auth 默认 scrypt）比对 `account`（`provider_id='credential'`）的哈希 | 源码核对（2026-11-25）；step-up 不依赖该端点，文档条目不再需要 |
| Passkey | `@better-auth/passkey`：`/passkey/verify-authentication` 总是新建会话；`authentication.afterVerification` 钩子在建会话前执行，可借抛错实现「只验证」，但需自行比对凭据所属用户，且默认 `requireUserVerification: false` | [Passkey](https://www.better-auth.com/docs/plugins/passkey)；[issue #8071](https://github.com/better-auth/better-auth/issues/8071) |
| admin 插件 | `impersonate-user`、`ban-user` 等均不检查新鲜度；模拟会话默认 1 小时 | [Admin](https://www.better-auth.com/docs/plugins/admin) |
| 会话自定义字段 | `additionalFields` 可加字段，`/update-session` 允许客户端写未标记 `input: false` 的字段；Cookie 缓存与二级存储不包含自定义字段 | [Session Management](https://www.better-auth.com/docs/concepts/session-management) |
| 签名 Cookie | 钩子与端点内可用 `ctx.setSignedCookie` / `ctx.getSignedCookie` | [Hooks](https://www.better-auth.com/docs/concepts/hooks) |
| 官方 step-up | 无（仅有功能请求 [#6000](https://github.com/better-auth/better-auth/issues/6000)、#8071） | 文档检索 + GitHub issue，**待核实**是否有更新 |

结论：不能用 `freshAge`（只看登录时间且会话轮换）；不能借用 emailOTP / magicLink / 社交登录（都会新建会话，emailOTP 也无法自定义用途）。可在不改动会话的前提下复用的只有：密码校验、2FA 校验（TOTP / 备用码），以及自建的 step-up 验证码。

## Goals / Non-Goals

**Goals:**
- 盗用的会话 Cookie 不足以执行任何敏感后台操作；敏感清单一处登记、编译期与测试双重保证覆盖。
- 验证体验不打断操作：当场弹窗，通过后原样继续。
- 不把管理员锁在外面：任何账号至少有一种可用方式，丢失全部手段时有运维级出路。
- AI 可以发起敏感操作，但只有管理员本人在后台验证后才会执行，执行内容就是确认页展示的内容。

**Non-Goals:**
- 引入 passkey 插件或强制管理员开启 2FA（只预留扩展点）。
- 用户侧敏感操作（结账、删号、改密码）的 step-up；它们已有实时会话校验与各自的新鲜度规则。
- MCP 之外的 AI 渠道（应用内 agent 已有自己的确认卡片，不在本范围）。

## Decisions

### 1. 动作名登记表：一处定义、类型约束、按输入判定
`apps/web/src/features/admin/actions.registry.ts`（无运行时依赖，可被测试与插件导入）导出 `adminActions`：键为动作名，值为 `{ stepUp: 'always' | 'never' | ((input) => boolean), reason }`。`runAdminAction` / `adminAction` / `withAdminAction` / `runDelegatedAdminAction`（新增必填 `name` 参数）与 `executeAdminAuthAction`、`executeAdminWorkspaceRestore` 的 `name` 类型改为 `AdminActionName`（登记表键的联合类型），新增入口未登记即类型检查失败。插件（admin-mcp 等）通过 `defineAdminActions()` 在自己的清单中追加登记，键名重复启动即报错（同设置定义的处理方式）。
条件判定的输入取已通过 zod 校验的参数；`setting.update` 的判定按设置定义的 `secret` 标记并与数据库现值比较，未改动的密钥项（表单原样提交）不算敏感。
备选：按路由路径登记——Server Function 的 URL 不稳定且一个函数可能承载多种动作，否决。
实现备注（第 1 组，2026-11-25）：
- 包装接受 `AdminActionRef`：始终 / 从不敏感的动作直接写名称；按输入判定的动作（`setting.update`、`ai.model_save`、`billing.refund_review`）必须写成 `{ name, input }`，否则类型检查失败，运行时缺少输入按敏感处理。判定函数签名为 `(input, { db }) => boolean | Promise<boolean>`。
- `defineAdminActions(owner, group)` 多一个插件 ID 参数：不同 owner 的键重复即抛错，同一 owner 重新加载（开发热更新）覆盖自己的登记；返回带品牌的动作名供包装使用。admin-mcp 登记 `admin.api_token.create` / `revoke`、只写调用审计的 `admin.mcp.call` 与写工具预览 `admin.mcp.dry_run`（均为 never，后两者不在上表）。
- MCP 写工具在定义中声明 `adminAction(input)`，与后台同名：`settings.set` → `setting.update`、`models.update` → `ai.model_save`。强制开关打开后、第 3 组接入待确认前，命中敏感判定的 MCP 调用（无会话）返回 `STEP_UP_REQUIRED`；开关关闭期间行为不变。
- 原有动作名统一为上表：`ai.model_set_enabled` → `ai.model_toggle`、`ai.feedback.view_conversation` → `ai.feedback.view`、`billing.refund_notification_retry_requested` → `billing.refund_email_retry`、`observability.sentry-test` → `observability.sentry_test`、MCP 的 `mcp.<tool>` → 后台同名动作（审计 action 不变）。
- 检查在 `apps/web/src/features/admin/step-up/check.ts`（`assertStepUp`、`hasValidStepUp`）；拒绝前先确认仍是有效管理员，已降级时得到 404 而非要求验证。`details.methods`（同时写入 `publicDetails`，随错误体返回客户端）由第 2 组补齐：有会话时为该账号当前可用方式，无会话（MCP）时为空数组。

### 2. 检查点：在写事务之前、所有副作用之前
包装在开启事务前调用 `assertStepUp(context, name, input)`：判定为敏感且当前会话没有未过期的验证记录时抛 `AppError('STEP_UP_REQUIRED', { status: 403, details: { methods } })`。`AdminActionContext` 增加 `session: { id, userId }`（来自 `requireFreshSession`）与可选 `confirmation`（只由确认执行路径设置，见决策 8）。MCP 调用没有会话，`settings.set` / `models.update` 等命中敏感判定时由工具框架转为待确认（决策 6），永远不会以「无会话」绕过。
守卫测试（任务 2.3）：
1. 表驱动集成测试遍历登记表中 `stepUp !== 'never'` 的每个动作，用有效管理员会话、无验证记录调用其 Server Function（条件项用使其为敏感的输入），断言 403 `STEP_UP_REQUIRED` 且数据库与审计不变；再写入验证记录后断言成功。
2. 遍历 `'never'` 项断言无验证也能执行。
3. 静态扫描 `apps/web/src`、`plugins/*/src` 中对上述包装的调用，确认每个调用点的动作名都在登记表中、登记表中每个键至少有一个调用点（防止改名漂移）。

强制开关（协调者审阅第 1 组时要求，2026-11-25）：`step-up/check.ts` 导出单一常量 `STEP_UP_ENFORCED`，验证方式（第 2 组）与弹窗（第 4 组）上线前为 `false`，此时 `assertStepUp` 在判定之后直接放行——登记表、类型约束、未登记名称的运行时报错与守卫扫描照常生效，后台与 MCP 写入保持现有行为，不会把管理员锁在敏感操作外。守卫测试经 `overrideStepUpEnforcedForTesting(true)` 强制开启，继续覆盖拒绝与放行。第 4 组 4.2 完成时改为 `true` 并删除开关与测试注入函数。

### 3. 验证方式与优先级（按账号已有手段取最强，不允许降级）
| 账号状态 | 可用方式 |
|---|---|
| 已开启 2FA（`user.twoFactorEnabled`） | TOTP 或备用码（备用码用后即消耗） |
| 未开启 2FA，有密码凭据 | 邮箱验证码或密码，任选 |
| 未开启 2FA，无密码（仅 OAuth / 验证码登录） | 邮箱验证码 |
| 救援开关开启且邮箱在名单内（决策 5） | 额外允许邮箱验证码，方式记为 `rescue` |

- **TOTP / 备用码**：调用 Better Auth 已登录分支的校验（不新建会话），外加我们自己的限流（`RL_AUTH` 键 `stepup:<userId>`，每 5 分钟 5 次失败后锁 15 分钟）与「同一 TOTP 时间窗只接受一次」的防重放（在验证记录中存最后一次使用的时间窗编号）。
- **邮箱验证码**：自建，不复用 emailOTP 插件（类型固定且登录会建会话）。6 位数字、有效 10 分钟、最多 3 次尝试，存 `verification` 表，identifier 为 `admin-step-up:<sessionId>`，值只存 SHA-256；复用现有 `verificationReservation` 的原子消费；发送走现有邮件队列与 `RL_AUTH`（IP + 邮箱维度），模板新增「后台操作验证码」。验证码只发往数据库中已验证的邮箱（引导提升本就要求已验证）。
- **密码**：服务端 `verifyPassword`，同样限流。
- **重新走 OAuth**：不采用——会新建会话、Google 不支持按请求 `max_age`（待核实），且邮箱验证码已覆盖 OAuth 用户。
- **Passkey**：不在本次实现。登记方式枚举中预留 `passkey`，优先级高于 TOTP；将来接入时用 `afterVerification` 钩子抛错实现「只验证」，并校验凭据所属用户与 `userVerification: 'required'`（见核对表）。
- 「不允许降级」：开启 2FA 的账号即使有密码也不能用密码或邮箱验证码 step-up（救援除外），否则 2FA 形同虚设。

实现备注（第 2 组，2026-11-25）：
- 服务在 `packages/auth/src/admin-step-up.ts`（`createAdminStepUp`），web 装配在 `apps/web/src/features/admin/step-up/service.server.ts`，入口为 `step-up.functions.ts` 的 `getStepUpStatus` / `sendStepUpCode` / `verifyStepUp`（预期内失败以 `{ ok: false, error, details }` 返回，供第 4 组弹窗展示）。
- **TOTP 与备用码不调用插件端点**（与上文「调用 Better Auth 已登录分支」不同，原因见核对表补充）：端点不返回命中时间窗，无法做同窗防重放；且绑定未完成时会替换会话。改为用 `better-auth/crypto` 的 `symmetricDecrypt` / `symmetricEncrypt` 与 `auth.$context.secretConfig` 直接读写 `two_factor` 行，算法与插件默认值一致（HOTP-SHA1、6 位、30 秒、窗口 ±1；备用码 `encrypted` JSON，成功即移除并在行锁内写回）。集成测试经插件真实 `/two-factor/enable` 与 `/two-factor/verify-totp` 完成绑定，再用本模块校验 TOTP 与备用码，锁定兼容性。只有 `two_factor.verified` 不为 false 的行才算开启。
- 同窗防重放按**账号**而非会话：比较该用户所有 `admin_step_up.last_totp_step` 的最大值，命中时间窗不大于它即拒绝；换用其他方式验证时保留已记录的时间窗。
- 失败计数与锁定存 `verification` 表（identifier `admin-step-up-lock:<userId>`，值为 JSON 计数与解锁时间），不新增 schema；同一账号的发码与校验在 `pg_advisory_xact_lock` 内串行。失败写入先提交、再把失败转为错误返回，避免回滚抹掉计数。RL_AUTH 键为 `stepup:ip:<ip>` 与 `stepup:<userId>`。
- 邮箱验证码值格式 `<已尝试次数>:<email_otp|rescue>:<SHA-256(sessionId:code)>`；救援码与普通码互不通用。重发冷却 60 秒，重发即作废旧码。
- 救援方式只加给「常规方式中没有邮箱验证码」的名单内账号（即开启了 2FA 的账号）；未开 2FA 的账号本就可用邮箱验证码，不重复提供。救援开关取值 `1` / `true` 为开启。
- 运营事件 `admin.step_up.rescue` 的 `sourceId` 为该次验证审计的 ID，web 在验证提交后投递，jobs 运营通知按事件去重发送。

### 4. 验证状态：服务端表 `admin_step_up`，绑定会话、10 分钟绝对有效期
字段：`session_id`（PK，FK `session.id` 级联删除）、`user_id`、`method`（`totp` | `backup_code` | `email_otp` | `password` | `rescue` | 预留 `passkey`）、`verified_at`、`expires_at`（= verified_at + 10 分钟，不随使用滑动）、`last_totp_step`。每次成功验证 upsert 一行并写审计 `admin.step_up.verified`（meta：method、ip）；连续失败达到锁定写 `admin.step_up.locked`。检查时与 `requireFreshSession` 同一查询链读库，不走缓存。会话被吊销、退出、封禁时级联删除，验证随之失效。
备选：签名 Cookie（无需写库，但无法服务端吊销、无法在审计中关联，且要另管 Cookie 路径与 SameSite）；会话自定义字段（Better Auth 允许客户端经 `/update-session` 写未标记字段，且缓存层不含自定义字段，容易误用）。采用表方案（D2，使用者 2026-11-25 确认）。
有效期 10 分钟为默认值，可经模板配置 `admin.stepUpMinutes`（1–60）调整；不做运行时设置，避免被盗会话把它调大。

### 5. 应急：救援开关 + 引导名单
- 正常情况下每个账号至少有邮箱验证码这一方式（管理员邮箱必然已验证），邮件服务故障时有密码的账号还可用密码。
- 开启 2FA 后丢失设备：先用备用码；备用码也丢失时，运维在部署环境设置密钥 `ADMIN_STEP_UP_RESCUE=1`（Wrangler secret / Node 环境）。此时邮箱在 `BOOTSTRAP_ADMIN_EMAILS` 名单内的管理员可用邮箱验证码完成 step-up，方式记为 `rescue`；救援状态下后台所有页面顶部显示警示条，每次 rescue 验证写审计并发运营通知（新增运营事件 `admin.step_up.rescue`），之后管理员可在账号设置中重置 2FA。问题解决后运维删除该密钥。
- 邮箱本身不可用：沿用现有引导——把另一个已验证邮箱加入 `BOOTSTRAP_ADMIN_EMAILS`，登录即被提升为管理员，再处理旧账号。
- 救援与引导都需要部署环境的写权限，被盗会话无法触发。登录与只读后台页面从不要求 step-up，所以任何情况下都能进入后台查看。
- 文档新增 runbook「管理员无法完成重新验证」。

### 6. MCP：敏感判定命中时改为待确认
工具框架在 zod 校验后、执行前，用与后台相同的登记表判定：命中敏感（`settings.set` 改密钥项、`models.update` 改定价、新工具 `credits.adjust` / `refunds.review`）且调用不来自确认执行路径时，不执行业务，改为创建待确认记录并返回结果（非错误）：
```json
{ "status": "needs_owner_confirm", "confirmationId": "…", "confirmUrl": "https://<APP_URL>/admin/confirm/<id>",
  "expiresAt": "…", "summary": "为空间 Acme（ws_…）增加 100 积分，原因：…",
  "message": "该操作需要管理员在后台确认后才会执行，请把链接交给管理员；在确认前不要视为已完成。" }
```
`dryRun: true` 照旧只预览、不创建待确认记录。需要 `admin:write` scope；只读令牌调用照旧被拒。

### 7. 待确认记录：`admin_pending_action`
字段：`id`（UUIDv7）、`tool`、`action`（登记表动作名）、`token_id`、`requested_by`（令牌所属管理员）、`summary`（服务端生成的人类可读说明）、`payload`（jsonb，解析后的执行参数，不含密钥）、`display`（jsonb，确认页展示的结构化内容：目标对象名称与 ID、新旧值，密钥只显示是否设置与末 4 位）、`secret_ciphertext`（bytea，可空）、`status`（`pending` | `running` | `done` | `failed` | `rejected` | `expired`）、`result`（jsonb，≤ 2 KB，不含密钥）、`decided_by`、`decided_at`、`expires_at`（创建 + 30 分钟）、`created_at`。
- **解析在创建时完成**：工具的 `confirm(ctx, args)` 钩子把 AI 传入的文本（邮箱、slug、模型键）解析为 ID，读出现值作为快照写入 `payload` / `display`；确认时只用 `payload`，不再解析 AI 原始输入。执行时比对快照（如设置现值、模型现定价、退款申请状态），已被他人改动则 `failed: STALE_TARGET`，避免覆盖。
- **密钥参数**：值用 AES-GCM 加密存 `secret_ciphertext`，每条记录随机生成数据密钥，存在平台缓存（KV / Valkey）中，TTL = 剩余有效期。到期时缓存自动失效，密文即不可解；执行、拒绝、失败时同事务置空密文并在提交后删除缓存键。这样「过期立即不可恢复」不依赖定时任务。未采用的备选：密文与密钥都存数据库、靠读取时惰性清空——过期到下一次读取之间密文仍可解（D5，使用者 2026-11-25 确认采用前者）。
- **过期**：读取、列表、确认时惰性把过期的 `pending` 改为 `expired` 并清空密文；残留行由现有每日清理任务（03:00 UTC）顺带处理，删除 30 天前的终态记录。不新增定时任务（Neon 成本基线）。
- **只执行一次**：确认执行用 `update admin_pending_action set status='running', decided_by=$admin, decided_at=now() where id=$1 and status='pending' and expires_at > now() returning *`，只有返回一行才继续；拒绝用同样的条件更新改为 `rejected`。纯数据库动作（积分调整、设置、模型）的「抢占 + 业务写入 + 审计 + 置 done」在同一事务完成，失败回滚即回到 `pending`，不会卡在 `running`。需要提交后调用外部服务的动作（退款通过）：抢占与退款决策同事务提交，随后的支付平台调用沿用现有退款流程的确认 / 重试状态；记录写入 `done` 并在 `result` 中给出退款申请 ID，提示到退款页核对最终结果。
- **复核令牌**：抢占后、执行前，在同一事务重新读取 `token_id` 对应令牌：已吊销、已过期或所属管理员已失效时置 `failed: TOKEN_REVOKED`，不执行。
- **谁能确认**：只有发起令牌所属的管理员能确认执行（D4，使用者 2026-11-25 确认）；其他管理员可查看与拒绝。确认动作本身是登记表中的敏感动作，需 step-up。

### 8. 「已确认」标志只来自服务端
工具定义增加 `execute(ctx, payload)`，其 `ctx.confirmation`（`{ id, confirmedBy, stepUpMethod }`）只由确认执行路径构造；MCP 分发器调用工具时该字段恒为 `undefined`，工具的 zod 输入 schema 中不存在任何「已确认」参数（测试断言 AI 传入额外字段被拒绝或忽略）。`runAdminAction` 对敏感动作的放行条件是「当前会话有有效 step-up」或「`context.confirmation` 存在且其 `id` 对应的记录在本事务中刚被本人抢占」。业务审计 meta 合并 `via: 'mcp'`、`tokenId`、`tool`、`confirmationId`、`confirmedBy`、`stepUpMethod`；另有 `admin.confirmation.requested`（创建时，actor 为令牌所属管理员）与 `admin.confirmation.rejected`。

实现备注（第 3 组，2026-11-25）：
- 服务在 `apps/web/src/features/admin/confirmations/`（`service.ts` 创建 / 读取 / 列表 / 计数 / 确认 / 拒绝，`secret.ts` 加密）；确认与拒绝的 Server Function 放在 `plugins/admin-mcp/src/web/confirmations.functions.ts`：执行器来自插件的工具定义，依赖方向只能是插件 → web。读取类 Server Function（确认页、列表、导航计数）由第 4 组在同处补齐，直接调用 `getPendingAction` / `listPendingActions` / `countPendingActions`。
- 工具定义：`confirm(ctx, input)` 在 `admin.confirmation.request`（插件登记，never）事务内运行并返回 `{ summary, display, payload, secret? }`；`execute(env)` 返回执行器，`kind: 'transaction'`（抢占、业务、审计、置 done 同事务）或 `kind: 'delegated'`（业务自管事务，在其决策事务内调用一次 `decide(tx)`）。`alwaysConfirm` 用于判定不敏感但仍需确认的调用（`refunds.review` 驳回）。写工具拒绝 schema 未声明的参数。
- 「已确认」不经 `runAdminAction` 放行：确认路径只以 `admin.confirmation.confirm`（会话 step-up）进入一次包装，工具执行器直接拿到该事务的 scope，执行信息（`confirmation`、`auditMeta`）由服务端构造，因此 `assertStepUp` 无需识别确认上下文。`stepUpMethod` 读取当前会话的 `admin_step_up.method`，强制开关关闭期间无记录时记为 `none`。
- 失败语义：抢占前的拒绝（不存在 404、非发起人 403、已过期 / 已处理 409、未重新验证）不改记录；令牌失效、目标已变化、密钥不可解与业务校验错误（AppError 4xx）回滚业务后另起事务把记录置为 `failed`；其他异常回滚，记录保持 `pending` 可重试。`running` 不会被提交。退款决策提交后的支付平台或邮件失败不改变 `done`，结果附 `followUpError`。
- 不存在的记录同样先经过 step-up 检查再返回不存在，未验证的会话无法探测记录。
- 快照：设置存现值的 SHA-256 指纹（不存密钥原值）并在执行时以同一把咨询锁比对；模型存启用、定价与参数的指纹；积分收回存批次剩余与状态；退款存申请状态与付款已退金额。
- 摘要（`summary`）用英文，与 MCP 工具说明一致；确认页按 `display` 结构化内容本地化展示。
- `@saas/billing` 的 `reviewRefundRequest` 增加可选 `inDecision` 与 `auditMeta`；插件经 `apps/web/src/features/billing/admin-refunds.server.ts` 的 `reviewAdminRefundRequest` 调用，不新增对 `@saas/billing` 的依赖。

### 9. 第一批 MCP 敏感工具（D1，使用者 2026-11-25 确认）
| 工具 | 输入（AI 侧） | 解析与快照 | 执行复用 |
|---|---|---|---|
| `credits.adjust` | `{ workspace（ID 或 slug）, kind: grant, amount, expiresAt?, reason }` 或 `{ workspace, kind: revoke, grantId, reason }` | 空间 ID 与名称、批次剩余、生成 `adjustmentId` | `adjustAdminCredits` |
| `refunds.review` | `{ requestId, decision, approvedAmount?, reviewNote? }` | 申请状态、付款金额与币种、对应批次已用 / 剩余 | `reviewRefundRequest`（驳回也走确认：保持一致，且驳回会发邮件给用户） |
| `settings.set`（密钥项） | 不变 | 现值是否已设置 | `writeRuntimeSetting` |
| `models.update`（定价改动） | 不变 | 现定价 | 抽出的模型保存 |
| `confirmations.get`（只读） | `{ id }` | — | 返回状态、摘要、结果；只能看同一管理员令牌发起的记录 |

不提供：封禁 / 解封、模拟登录、创建令牌、退款以外的支付平台写操作、删用户。

### 10. 客户端：统一调用包装与验证弹窗
`apps/web/src/features/admin/step-up/` 提供 `useStepUpCall(serverFn)`：调用失败且错误码为 `STEP_UP_REQUIRED` 时打开 `StepUpDialog`（列出 `details.methods`），验证成功后用**同一份参数**重试一次并把结果交回原调用方；用户取消则返回取消状态，表单保持原样。弹窗挂在后台布局根部，表单组件不卸载，所以已填写内容不丢失。所有后台写操作的调用点改用该包装（任务 4.2 一并替换）。邮箱验证码弹窗内提供发送 / 重发（60 秒冷却）。后台顶部显示「已验证，剩余 N 分钟」与救援警示条。
重试安全：检查在任何副作用之前（决策 2），被拒的请求没有写入；积分调整本就带幂等 `adjustmentId`。

### 11. 设计稿（协调者负责 ui-design 第 3–5 步，本 change 不出稿）

已确认（2026-11-25）：见 `docs/design-system/prototypes/README.md` 中「后台敏感操作验证弹窗 StepUpDialog」「后台确认 AI 发起的操作 /admin/confirm/$id」「后台待确认列表 /admin/confirmations」三行，副本在 `docs/design-system/prototypes/admin-step-up/`。组件变更提议：`@saas/ui` 无 InputOTP 时按 `packages/ui/UPSTREAM.md` 接入（随画布确认）。实现与验收以副本为准。

| 页面 / 交互 | 需覆盖的状态 |
|---|---|
| 验证弹窗 `StepUpDialog` | 方式选择（TOTP / 备用码 / 邮箱验证码 / 密码，按账号可用项显示）；验证码已发送与重发冷却；输入错误与剩余次数；锁定（显示解锁时间）；提交中；成功后自动继续；无可用方式时的应急说明；救援方式提示；手机端底部面板 |
| 确认页 `/admin/confirm/$id` | 待确认（摘要、结构化内容与新旧值、发起令牌名称与前缀、发起时间、剩余有效期、确认 / 拒绝）；需要验证（点确认后弹窗）；执行中；已完成（结果）；失败（令牌已吊销、目标已变化、业务错误）；已拒绝；已过期；非发起人（只读 + 可拒绝）；不存在；手机端 |
| 待确认列表 `/admin/confirmations` | 待确认 / 历史两栏，空、加载、失败；后台导航项上的待确认数量 |
| 后台顶部状态 | 已验证剩余时间；救援模式红色警示条 |

无新增 `@saas/ui` 组件预期（Dialog、Card、Badge、DataTable、InputOTP 若无则需新增，设计确认时一并确认）。

## Risks / Trade-offs

- [每次敏感操作多一次验证，打扰管理员] → 10 分钟内只验证一次；日常操作不受影响；条件型判定（只有改密钥 / 定价才算敏感）减少误伤。
- [管理员未开 2FA 时，邮箱被攻破即可 step-up] → 与「邮箱可重置密码」同级风险，文档建议管理员开启 2FA；本次不强制（D6 已确认），留待后续。
- [TOTP 同窗口可重放（上游 issue）] → 记录最后使用的时间窗，同窗口第二次拒绝。
- [Better Auth 内部分支随版本变化] → 已登录 2FA 校验与 `verifyPassword` 用法由集成测试锁定；升级 better-auth 时这些测试会先失败。
- [退款通过后的支付平台调用失败] → 沿用现有退款流程的确认与重试；确认页结果引导到退款页核对。
- [待确认记录被大量创建（失控 agent）] → 每令牌同时最多 20 条 `pending`，超出返回错误；MCP 原有每令牌限流仍在。
- [登记表与实现漂移] → 类型约束 + 双向静态扫描 + 表驱动拒绝测试。
- [BREAKING：MCP 写密钥 / 定价不再即时生效] → 文档与升级说明写明；dryRun 不变。

## Migration Plan

1. 迁移新增 `admin_step_up`、`admin_pending_action`（新表，无数据迁移；由协调者在 main 上统一生成）。
2. 部署后首次执行敏感操作会弹出验证，无需预先配置；`ADMIN_STEP_UP_RESCUE` 默认不设置。
3. 升级说明：衍生项目自有的后台写操作需要在登记表中声明动作名（类型检查会指出），MCP 客户端需处理 `needs_owner_confirm`。
4. 回滚：回退代码即可，两张表保留无害。

## 已拍板事项（使用者 2026-11-25 确认：D1–D7 全部按推荐）

- **D1 第一批 MCP 敏感工具**：`credits.adjust`、`refunds.review`，并把 `settings.set`（密钥项）与 `models.update`（定价）改为确认执行；不开放封禁、模拟登录、建令牌。
- **D2 验证状态存储**：服务端表 `admin_step_up`（可吊销、可审计），不用签名 Cookie。
- **D3 吊销 API 令牌**：不需要 step-up（降权动作，泄露时越快吊销越好）；创建令牌需要。
- **D4 谁能确认 AI 发起的操作**：只有发起令牌的所属管理员能确认，其他管理员可查看与拒绝。
- **D5 待确认记录中的密钥参数**：密文在库、数据密钥在缓存并设 TTL，过期即不可解。
- **D6 2FA 与 passkey**：本次不强制管理员开启 2FA，只在后台提示；passkey 另开 change（已预留方式枚举）。
- **D7 有效期**：step-up 10 分钟（模板配置 `admin.stepUpMinutes` 可在 1–60 分钟内调整），待确认 30 分钟。

无其他阻塞问题。设计稿由协调者另行产出（tasks 0.1）。
