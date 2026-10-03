# Proposal

## Why

计费、积分和 AI 的所有数据都归属 Workspace，计费主体也是 Workspace（`docs/04-auth-and-tenancy.md`）。在用户身份和空间模型落地之前，后续任何业务功能都无处挂靠，因此认证与多租户是骨架之后的第一个业务 change（`docs/08-roadmap.md` Phase 1）。

## What Changes

- 接入 Better Auth：邮箱 + 密码（含邮箱验证、找回密码）、邮箱验证码（`emailOTP`）、魔法链接（`magicLink`）、Google / GitHub OAuth、可选两步验证，均由 `template.config.ts` 开关控制。
- 会话三层读取（签名 Cookie 缓存 → KV → 数据库），敏感操作直接查库校验会话与封禁状态。
- Turnstile 与 Rate Limiting 保护注册、登录、发送验证码、找回密码。
- 邮件：Resend + React Email，经 `EMAIL_QUEUE` 异步发送。
- 个人空间模型：注册即创建个人空间；`multiTenant` 开关控制团队空间、邀请、成员角色、空间切换器；URL 统一为 `/app/$slug/...`。
- `withSession` / `withWorkspace` 中间件与 `scoped()` 查询工具；绕过 `scoped()` 的 lint 检查。
- 席位上限的并发控制（空间级事务锁）。
- 平台 admin 角色与 `/admin` 入口骨架（具体后台功能在 `add-admin-console`）。
- 用户设置：资料、语言、时区、修改密码；删除账号与删除团队空间（软删 + 匿名化）。
- 决定待决事项 Q8（是否启用 RLS）：默认不启用，见 design.md。

## Capabilities

### New Capabilities
- `user-auth`: 注册、登录方式、邮箱验证、会话有效性与吊销、平台角色与封禁、认证接口防刷。
- `workspace-tenancy`: 个人空间与团队空间、成员与角色、邀请、席位上限、当前空间解析与数据隔离。
- `account-deletion`: 删除账号与删除团队空间的前置条件、匿名化与数据保留规则。

### Modified Capabilities
（无）

## Impact

- 依赖 `setup-scaffold-and-infra` 的工程结构与数据库。
- 新增表：Better Auth 的 `user` / `session` / `account` / `verification` / `two_factor` / `apikey`，`organization` / `member` / `invitation`，以及 `audit_log`、`notification`（结构见 `docs/03-data-model.md`）。
- 新增外部服务：Resend、Google / GitHub OAuth 应用、Turnstile。
- 删除账号时与计费相关的步骤（取消订阅、退款申请提醒、收回积分）在本 change 中只预留扩展点，由 `add-billing-and-credits` 接入。
