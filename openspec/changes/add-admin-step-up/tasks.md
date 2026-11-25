# Tasks

实施排在 add-ops-safeguards 之后。任务按 design.md「已拍板事项」D1–D7 编写（使用者 2026-11-25 确认，全部按推荐）。
并行分组：第 1 组先行（单 worker）；第 2、3 组在第 1 组合并后并行；第 4 组等设计稿确认（第 0 组）且第 2、3 组合并；第 5 组收尾。schema 只改 `packages/db/src/schema/platform.ts`，不提交迁移 SQL（docs/09 §3），迁移由协调者合并后生成。
验收标记：〔本地〕本地 PG 与 dev 即可；〔staging〕需要 staging 管理员登录与真实邮件；〔外部凭据〕需要使用者提供或在场。

## 0. 设计稿（协调者，实现 UI 的前置）

- [ ] 0.1 协调者按 `ui-design` 第 3–5 步产出 design.md 决策 11 所列页面与状态的设计稿（验证弹窗、确认页 `/admin/confirm/$id`、待确认列表与导航计数、后台顶部验证状态与救援警示条，含手机端），取得使用者本人确认并登记到 `docs/design-system/prototypes/README.md`，副本放 `docs/design-system/prototypes/admin-step-up/`。验收：索引有对应行且副本文件存在〔外部凭据：使用者确认〕

## 1. 动作登记表与守卫骨架（Worker A，先行）

- [ ] 1.1 新增 `apps/web/src/features/admin/actions.registry.ts`：按 design.md「入口清单」登记全部后台动作名与 `stepUp`（`always` / `never` / 输入判定函数）、理由；导出 `AdminActionName` 类型与插件追加登记的 `defineAdminActions()`（键重复即抛错）。单元测试覆盖重复键、`setting.update` 只在密钥项实际改变时为敏感、`ai.model_save` 只在新建或定价变化时为敏感、`billing.refund_review` 只在通过时为敏感。验收：`pnpm --filter @saas/web test` 相关用例通过〔本地〕
- [ ] 1.2 `action.ts` / `action.server.ts`：`runAdminAction`、`adminAction`、`withAdminAction` 的 `name` 改为 `AdminActionName`；`runDelegatedAdminAction` / `withDelegatedAdminAction` 新增必填 `name`；`AdminActionContext` 增加 `session` 与可选 `confirmation`；事务前调用 `assertStepUp`（本组先实现为读 `admin_step_up` 表的检查，验证方式由第 2 组补齐）。把全部调用点（含 `impersonation.server.ts` 的 `executeAdminAuthAction`、`executeAdminWorkspaceRestore`、`plugins/admin-mcp` 的令牌函数、`server/sentry-test.ts`）改为登记表动作名。验收：`pnpm typecheck` 通过，现有后台测试全部通过〔本地〕
- [ ] 1.3 schema：`packages/db/src/schema/platform.ts` 新增 `admin_step_up`（session_id PK 级联、user_id、method、verified_at、expires_at、last_totp_step）与 `admin_pending_action`（design.md 决策 7 全部字段，`(requested_by, status)` 与 `(token_id, status)` 索引）；`docs/03-data-model.md` 补两表。用 `drizzle-kit push` 同步本 worktree 库，不提交迁移 SQL。验收：`pnpm --filter @saas/db test` 通过〔本地〕
- [ ] 1.4 守卫测试：表驱动集成测试遍历登记表的敏感项，无验证记录调用对应 Server Function 断言 403 `STEP_UP_REQUIRED` 且业务表与审计不变，插入有效 `admin_step_up` 后断言成功；遍历 `never` 项断言无需验证；静态扫描确认调用点与登记表双向一致（每个调用点的动作名已登记、每个登记键至少一个调用点）。验收：集成测试在隔离测试库通过〔本地〕

## 2. 验证方式与应急（Worker B，依赖第 1 组合并）

- [ ] 2.1 `packages/auth` 新增 step-up 服务（不创建、不替换会话）：可用方式计算（2FA → TOTP / 备用码；否则邮箱验证码，有密码另加密码；救援见 2.3）；TOTP 与备用码走 Better Auth 已登录分支校验，并记录 `last_totp_step` 拒绝同窗重放；密码走 `verifyPassword`；邮箱验证码自建（6 位、10 分钟、3 次、`verification` 表 identifier `admin-step-up:<sessionId>`、只存哈希、原子消费）；`RL_AUTH` 按 IP 与账号限流，连续失败锁定 15 分钟并写 `admin.step_up.locked`；成功 upsert `admin_step_up` 并写 `admin.step_up.verified`。集成测试覆盖：会话 ID 不变、开启 2FA 时密码与验证码被拒、备用码只能用一次、跨会话验证码无效、同窗 TOTP 第二次被拒、锁定、过期（伪造时间）。验收〔本地〕
- [ ] 2.2 模板配置 `admin.stepUpMinutes`（默认 10，1–60，`packages/config` schema 与默认值）；`packages/email` 新增「后台操作验证码」模板与多语言文案；web Server Functions：`getStepUpStatus`（剩余时间、可用方式、是否救援）、`sendStepUpCode`、`verifyStepUp`，均经 `requireAdmin`。验收：单元与集成测试、`pnpm typecheck`〔本地〕
- [ ] 2.3 应急救援：密钥 `ADMIN_STEP_UP_RESCUE`（Cloudflare 与 Node 环境 schema 可选项，`.dev.vars.example` 占位）；开启时 `BOOTSTRAP_ADMIN_EMAILS` 名单内的管理员额外可用邮箱验证码，方式记 `rescue`，写审计并投递新运营事件 `admin.step_up.rescue`（jobs 运营通知接受该事件）。集成测试覆盖名单内 / 名单外 / 未开启三种情况；新增 runbook `docs/runbooks/admin-step-up-rescue.md`（备用码 → 救援开关 → 引导名单新增邮箱，以及关闭步骤）。验收〔本地〕
- [ ] 2.4 文档：`docs/04-auth-and-tenancy.md` 新增「后台重新验证」一节（敏感清单的登记方式、方式优先级、有效期、Better Auth 核对结论与出处、新增后台动作时的要求）；`security-scan` 技能清单加入「新增后台写操作须登记动作名」。验收：`pnpm check` 通过〔本地〕

## 3. MCP 待确认后端（Worker C，依赖第 1 组合并，可与第 2 组并行）

- [ ] 3.1 待确认服务（`apps/web/src/features/admin/confirmations/`）：创建（每令牌最多 20 条 pending）、按 ID 读取并惰性过期、列表、条件抢占确认 / 拒绝、令牌复核、终态写 `result`；密钥参数 AES-GCM 加密，数据密钥存平台缓存（TTL = 剩余有效期），终态同事务置空密文并在提交后删缓存键。集成测试覆盖：并发双确认只执行一次、确认与拒绝竞争、过期后不可确认、吊销令牌后确认失败、缓存键过期后密文不可解、目标快照变化时 `STALE_TARGET`。验收〔本地〕
- [ ] 3.2 admin-mcp 工具框架：`defineAdminTool` 增加 `confirm(ctx, args)`（解析 ID、生成 `summary` / `display` / `payload`、快照）与 `execute(ctx, payload)`；分发器按登记表判定敏感后创建待确认并返回 `needs_owner_confirm`；`ctx.confirmation` 只由确认执行路径构造，工具输入 schema 为 strict、附加 `confirmed` 等字段被拒。审计 `admin.confirmation.requested`，执行审计合并 `via`、`tokenId`、`tool`、`confirmationId`、`confirmedBy`、`stepUpMethod`。单元测试覆盖伪造确认字段与 dryRun 不建记录。验收〔本地〕
- [ ] 3.3 工具：`settings.set`（密钥项走确认）、`models.update`（定价改动走确认）改造；新增 `credits.adjust`（复用 `adjustAdminCredits`，确认时生成 `adjustmentId`）、`refunds.review`（复用 `reviewRefundRequest`，通过与驳回都走确认）、只读 `confirmations.get`（只能查同一管理员令牌发起的记录）。集成测试用 `@modelcontextprotocol/client` 走「调用 → needs_owner_confirm → 服务端确认 → confirmations.get 为 done」全流程，并确认业务审计字段。验收〔本地〕
- [ ] 3.4 确认 / 拒绝 Server Functions（动作名 `admin.confirmation.confirm` 敏感、`admin.confirmation.reject` 非敏感）：只有发起令牌所属管理员可确认；纯数据库动作在抢占事务内执行；退款通过沿用现有提交后支付平台调用。每日清理任务（03:00 UTC，`apps/jobs`）顺带把过期 pending 置为 expired 并删除 30 天前的终态记录，不新增 cron。验收：集成测试与 `pnpm --filter @saas/jobs test`〔本地〕
- [ ] 3.5 文档：`docs/admin-mcp.md` 工具表与「需要管理员确认的操作」一节（返回格式、给 agent 的处理建议、查询结果、审计查看）；升级说明登记 BREAKING（密钥设置与定价改为确认执行，衍生项目后台写操作需登记动作名）。验收：`pnpm check` 通过〔本地〕

## 4. 界面（Worker D，依赖 0.1 设计稿确认与第 2、3 组合并）

- [ ] 4.1 按已确认设计稿实现 `StepUpDialog` 与 `useStepUpCall`（`STEP_UP_REQUIRED` 时弹窗，通过后用原参数重试一次，取消时返回取消状态）；后台顶部验证剩余时间与救援警示条；文案进 `apps/web/messages/<locale>/admin-step-up.json`。组件测试覆盖：重试使用同一参数、取消后表单内容保留、各方式表单。验收：组件测试与 `pnpm check`（含 UI 规范检查）〔本地〕
- [ ] 4.2 后台所有写操作调用点改用 `useStepUpCall`（用户封禁 / 模拟登录、积分调整、退款审核与手动退款、回调重放、设置与运营设置、模型保存、套餐模型、令牌创建）。Playwright：填写部分退款金额 → 弹窗验证（邮箱验证码从本地邮件捕获取得）→ 自动提交且金额正确。验收〔本地〕
- [ ] 4.3 确认页 `/admin/confirm/$id` 与待确认列表 `/admin/confirmations`（DataTable + `features/admin/list.ts`）、导航计数；覆盖设计稿全部状态（待确认、执行中、完成、失败、拒绝、过期、非发起人、不存在）。Playwright：MCP 客户端发起积分调整 → 打开链接 → 验证 → 确认 → 余额变化且 `confirmations.get` 为 done。验收〔本地〕

## 5. 本地整体验收（协调者或 Worker D）

- [ ] 5.1 本地 dev 端到端：被盗会话模拟（未验证会话调用敏感 Server Function 被拒）、四种验证方式各一次、救援开关、MCP 四个敏感工具各走一次确认或拒绝、过期链接；`pnpm check`、`pnpm typecheck`、`pnpm check:deps`、`pnpm test`、`pnpm build` 通过；证据写入 `EVIDENCE_DIR`〔本地〕

## 6. 部署与外部验收（不提前勾选）

- [ ] 6.1 staging 验收：合并后确认 main 的 Deploy staging 成功；管理员在 staging 用真实邮件完成邮箱验证码 step-up 并执行一次可逆的敏感操作（例如积分增加后收回）；经 MCP 发起积分调整并在后台确认，再发起一条后拒绝、一条等其过期；吊销令牌后确认失败。证据写入私有证据库〔staging、外部凭据：staging 管理员登录与邮箱〕
- [ ] 6.2 staging 验证 2FA 路径：为 staging 管理员开启 TOTP，确认密码与邮箱验证码被拒、TOTP 与备用码可用；设置 `ADMIN_STEP_UP_RESCUE` 验证救援警示、审计与运营通知后删除该密钥〔staging、外部凭据：验证器设备、Wrangler secret 写入需使用者确认〕
