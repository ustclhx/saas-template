# Tasks

## 1. 数据模型

- [x] 1.1 用 Better Auth CLI 生成 schema，id 与外键列改为 `uuid`，补充扩展字段（`user.locale` / `timezone`），验证迁移在本地执行成功且 `generateId` 生成的 UUIDv7 能写入
- [x] 1.2 新增 `organization`（`is_personal`、`deleted_at`）、`member`（唯一约束）、`invitation`、`audit_log`、`notification` 表及 `(ws, id desc)` 索引，所有外键 `on delete restrict`，验证迁移成功且删除被引用的 user 行会被数据库拒绝

## 2. Better Auth 接入

- [x] 2.1 在 `packages/auth` 实现 `createAuth(env, db)`，按模板配置启用邮箱密码、`emailOTP`、`magicLink`、OAuth、`twoFactor`，验证关闭某方式时对应接口返回错误（集成测试）
- [x] 2.2 配置会话三层（cookieCache → KV secondaryStorage → 数据库），验证测试：KV 有会话时不查库；数据库删除会话后旧 Cookie 在缓存过期后失效
- [x] 2.3 实现 `requireFreshSession` 守卫（直接查库校验会话与 `banned`），验证被封禁用户 10 秒内访问受保护接口被拒绝
- [x] 2.4 实测注册 / 登录的 CPU 时间并记录到 `docs/04-auth-and-tenancy.md`，超过阈值时改用 PBKDF2 hasher，验证测试环境中注册、登录、修改密码均成功
- [x] 2.5 Turnstile 校验与 `RL_AUTH` 限流（IP + 邮箱）接入注册、登录、发送验证码、找回密码，验证缺失令牌被拒绝、超限返回 429 且不发邮件
- [x] 2.6 在 `@saas/config` 的 `auth` 中加 `requireEmailVerification`（默认 `false`）并接入 `createAuth`：默认注册不发验证邮件、未验证可登录；提供「发送验证邮件」入口供账号设置与领取积分使用；开启后注册即发验证邮件、未验证不能登录，验证两种配置下的集成测试

## 3. 邮件

- [x] 3.1 在 `packages/email` 实现 `EmailSender` 接口与 Resend 实现、React Email 模板（验证、验证码、魔法链接、重置密码、邀请），验证模板渲染快照测试通过
- [x] 3.2 认证邮件改为投递 `EMAIL_QUEUE`，`apps/jobs` 消费并发送，失败时由队列重试，验证模拟 Resend 5xx 时用户请求仍成功、消息重试后发送

## 4. 空间与中间件

- [x] 4.1 注册后自动创建个人空间（随机 slug、owner、设为活跃空间），并在 `withWorkspace` 中补建缺失的个人空间，验证新用户注册后 `/app` 重定向到 `/app/<slug>`
- [x] 4.2 实现 `withSession` / `withWorkspace`（每次请求查库校验成员身份）与 `/app/$slug` 路由骨架，验证被移出的成员立即访问返回 403/404
- [x] 4.3 实现 `scoped(db, ws)` 与禁止绕过的 lint 规则，验证 lint 能拦下一段故意直接查询 `ai_task` 风格表的示例代码，且跨空间 ID 访问的测试返回 404
- [x] 4.4 `multiTenant` 开关：团队空间创建（`maxWorkspacesPerUser`、保留字 slug）、空间切换器、关闭开关后的只读访问，验证两种开关下的接口行为测试
- [x] 4.5 邀请与成员管理：发送 / 接受 / 撤销邀请、角色变更、移除成员、转让 owner，个人空间禁止邀请，验证各角色权限矩阵的测试
- [x] 4.6 席位上限：接受邀请与新增成员时加空间级事务锁后计数，降级超员时禁止新增并提示，验证并发接受最后一个席位只有一人成功

## 5. 平台角色与设置

- [x] 5.1 `admin` 插件接入，`/admin` 入口骨架与角色守卫（非 admin 返回 404），验证普通用户访问被拒绝
- [x] 5.2 用户设置页：资料、语言、时区、修改密码、两步验证开关（受配置控制），验证修改密码后其他会话按 spec 时限失效

## 6. 删除账号与空间

- [x] 6.1 实现删除流程钩子 `registerDeletionStep` 与删除团队空间（owner 限定、软删、撤销邀请与 API Key、移除成员），验证删除后原成员访问返回 404
- [x] 6.2 实现删除账号：近期重新验证、唯一 owner 拦截、退出团队空间、匿名化与凭据清理、写 `audit_log`，验证删号后无法登录且同一邮箱可重新注册得到新空间
- [x] 6.3 实现软删空间的恢复（管理员接口，恢复原 owner）与保留期后清理的 Cron 骨架（本 change 只清理已存在的表），验证保留期内恢复成功、过期后内容被删除
- [x] 6.4 更新 `docs/04-auth-and-tenancy.md`（实测结论、Q8 决定、删除流程钩子）与 `docs/08-roadmap.md` 的 Q8 状态，验证文档与实现一致

## 7. 界面基础与认证页面

- [x] 7.1 在 `packages/ui` 搭建 Tailwind CSS v4 + shadcn/ui 基础（主题 CSS 变量、按钮 / 输入 / 表单 / 卡片 / 提示等基础组件、TanStack Form + Zod 的表单封装），`apps/web` 接入，验证组件在 SSR 下渲染且组件测试通过
- [x] 7.2 认证页面：登录（按模板配置显示邮箱密码 / 验证码 / 魔法链接 / OAuth 入口）、注册、找回密码与重置密码、邮箱验证结果页，表单含 Turnstile 小组件，错误按错误码提示，验证 e2e：关闭某登录方式时页面不显示其入口，注册 → 登录 → 进入 `/app` 的流程可用

## 8. 阶段验收

- [ ] 8.1 Playwright e2e：在 `multiTenant=false` 与 `true` 两种配置下分别走通「注册 → 邮箱验证 → 登录 → 创建团队空间（仅 true）→ 邀请 → 接受 → 切换空间」，验证两套配置的 e2e 均通过并部署到 staging

8.1 本地验收（2026-10-04）：默认 `multiTenant=false` 为 12 passed / 1 skipped（关闭的魔法链接）；临时 `multiTenant=true`、`magicLink=true` 为 13 passed，包含真实邮箱验证、密码 / OTP 登录、邀请接受、成员管理、切换空间与删除吊销。两次均在 Orca 独立数据库运行，配置逐字节恢复。完整仓库 check / deps / singletons / dedupe / typecheck / test（273 项）/ build 通过。staging 认证迁移、密钥上传与 web / jobs 发布仍待授权，因此 8.1 保持未完成。
