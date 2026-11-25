# 后台敏感操作重新验证与 MCP 确认执行：升级说明草稿

<!-- 发版时将以下章节并入 docs/upgrades/<version>.md，按发布模板补全 frontmatter 并设置 breaking: true。
     第 2 组（验证方式、模板配置 admin.stepUpMinutes、救援密钥）与第 4 组（界面、打开强制开关）合并时在对应章节补充。 -->

## 概要

**BREAKING**。后台写操作改为按动作名登记，敏感操作需要重新验证（step-up）；admin MCP 的敏感写入改为由令牌所属管理员在后台确认后执行（openspec `add-admin-step-up`）。

## 必须执行的动作

1. **衍生项目自有的后台写操作登记动作名**：`adminAction`、`withAdminAction`、`runAdminAction`、`withDelegatedAdminAction` / `runDelegatedAdminAction`（新增必填动作名参数）只接受 `apps/web/src/features/admin/actions.registry.ts` 中登记的动作名；项目插件用 `defineAdminActions(<插件 ID>, { … })` 追加登记。`pnpm typecheck` 会指出未登记的调用点，`actions.registry.scan.test.ts` 检查调用点与登记表双向一致。每项声明 `stepUp: 'always' | 'never' | (input) => boolean` 与理由。
2. **MCP 客户端处理 `needs_owner_confirm`**：`settings.set` 写入密钥类设置、`models.update` 改变定价不再即时生效，返回 `{ status: "needs_owner_confirm", confirmationId, confirmUrl, expiresAt, summary, message }`（普通结果，不是错误）。依赖这两类即时写入的脚本或 agent 改为把链接交给令牌所属管理员，确认后用新增的只读工具 `confirmations.get` 查询结果。`dryRun: true` 与非敏感写入不变。处理建议见 `docs/admin-mcp.md`「需要管理员确认的操作」。

## 新增能力

- MCP 工具 `credits.adjust`（空间积分增加 / 收回批次）、`refunds.review`（审核退款申请，通过与驳回都经确认）、`confirmations.get`（只读）。
- 后台确认与拒绝的 Server Function：`plugins/admin-mcp/src/web/confirmations.functions.ts` 的 `confirmAdminConfirmation`（动作名 `admin.confirmation.confirm`，敏感）与 `rejectAdminConfirmation`（`admin.confirmation.reject`）。确认页与列表界面随第 4 组提供。
- 待确认服务 `apps/web/src/features/admin/confirmations/service.ts`；每日清理任务 `admin-confirmations-cleanup` 挂在现有 UTC 03:00 触发器上（不新增 cron），登记在 `docs/bulk-jobs.md`。
- `@saas/billing` 的 `reviewRefundRequest` 新增可选参数 `auditMeta`（合并进决策审计）与 `inDecision`（在决策事务内回调）；不传时行为不变。后台退款页使用的支付运行时与退款选项移到 `apps/web/src/features/billing/admin-refunds.server.ts`。

## 数据库迁移

新表 `admin_step_up`、`admin_pending_action`（只增不改，迁移由协调者在 main 上生成）。无数据迁移；回滚代码时两张表可保留。

## 配置变更

无新增必填配置。缓存（KV / Valkey）新增键前缀 `admin-confirmation:key:`，存放待确认记录的数据密钥，TTL 为记录剩余有效期。
