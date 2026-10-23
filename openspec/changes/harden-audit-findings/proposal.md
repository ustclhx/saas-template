# Proposal

## Why

2026-10-24 的工程审查（对照通用 SaaS 上线清单逐项核对代码）发现了十个最值得修的问题，集中在三类：
- **资金损失**：AI 失败零计费可被刷；媒体任务运行中取消也会全额退款；Stripe 结账可能用非 USD 扣款；年付周期变更后付款无法入账。
- **账号安全**：邮箱验证码校验接口没有限流，尝试计数存在竞态；全站没有安全响应头。
- **服务中断与合规**：欠费宽限期计算错误；删号与空间清理不删 AI 内容；生产发布可以绕过 CI；迁移与回滚缺少防护；生产失败事件没有可靠落点；上游卡住时请求没有超时。

模板即将用于正式项目。这些问题都能在真实流量下造成损失，越早修越便宜。

## What Changes

1. **AI 文本失败计费**：每个工作区每滚动 1 小时内，前 3 次无可见正文的失败仍全额退回预扣；从第 4 次起按最后一次尝试的实际用量结算（按 token 计费不低于 `minCharge`，按次计费扣固定积分），且不超过预扣。失败全退开关的行为不变。次数与窗口为运行时设置。
2. **媒体任务取消与不确定提交**：
   - 排队中的任务取消后免费。
   - 已开始生成的任务：每个工作区终身有 1 次免费取消，之后的取消按该任务的定价快照全价结算。前端在取消前说明这一规则，并显示是否还有免费机会。
   - 提交结果不确定时不再立即退款：保留预扣并等待回调，在时限内到达则正常结算，超时才退款。
   - 存储配额改为提交前检查；生成完成后才超配额时，仍保存产出并扣费。
3. **认证防刷**：禁用未使用的 `/email-otp/check-verification-otp`；验证码校验与重置密码类接口纳入 IP 与邮箱限流。
4. **结账币种锁定**：Stripe Checkout 显式关闭 Adaptive Pricing。收到非 USD 付款时，以可识别的错误码停止重试，并发运营告警。
5. **Stripe 周期变更**：月付与年付之间的切换，改为在当前周期结束时生效，复用现有降级的定时切换路径。同一周期内升级到更高档套餐仍立即生效。
6. **欠费开始时间**：`pastDueSince` 取首次进入欠费的时间。后续订阅更新、每日对账与扣款重试都不得清空或刷新它；离开欠费状态时才清空。
7. **安全响应头**（新能力）：web 的所有响应（Cloudflare 与 Node）统一加防嵌入、HSTS、nosniff、Referrer-Policy 等响应头。完整 CSP 先以 Report-Only 上 staging，验证后再强制执行。
8. **删除即清理**：空间保留期结束后，永久删除对话、消息与媒体任务；删号时，删除该用户在团队空间中的对话、消息与媒体任务，以及 newsletter、waitlist 中的对应记录与通知。财务数据（付款、退款、订阅、积分账本与预扣、webhook 事件）保留；审计记录保留，但去除个人信息。
9. **发布门禁与迁移安全**：
   - 生产与 staging 都必须在 CI 通过后才能发布。只有两种情况允许绕过：仓库处于测试阶段（`RELEASE_PHASE=testing`），或上线后经手动触发并填写原因的紧急修复。每次绕过都要在流水线摘要中留下记录。
   - 生产先构建、再迁移、再部署。迁移连接设置锁等待与语句超时，CI 增加危险迁移检查。
   - Cloudflare 回滚增加 schema 兼容检查，不兼容时拒绝回滚。
10. **可观测性与上游超时**：
    - 生产 web 与 jobs 开启 Workers Logs。生产处于 live 阶段时，缺少 Sentry 配置会阻止发布。
    - Cloudflare 的 events 队列配置死信队列，死信持久化并告警。邮件队列维持不配置死信的现有设计。
    - 对话流每次上游尝试设置空闲超时与总超时，超时后中止上游请求，按失败规则结算。

## Capabilities

### New Capabilities
- `web-security-headers`：web 应用所有 HTTP 响应的安全响应头与 CSP 上线策略。

### Modified Capabilities
- `ai-text-reasoning`：「无可见输出的失败不向用户收费」改为每个工作区按小时计的免费次数。
- `ai-chat`：「出错与结算丢失」跟随上一项的免费次数规则；新增上游空闲超时与总超时。
- `ai-media-tasks`：「只提交一次」「结算规则」「用户取消」改为按服务商状态与免费取消次数结算；新增存储配额前置检查。
- `user-auth`：「认证入口防刷」覆盖验证码校验与重置密码接口，并禁用未使用的校验接口。
- `payments`：新增结账币种锁定。
- `subscriptions`：「Stripe 升降级」区分周期变更；新增欠费开始时间规则。
- `account-deletion`：「账号匿名化」「删除团队空间」明确 AI 内容与增长数据的删除范围。
- `production-deployment`：「生产发布由 tag 触发并只发布已验证的提交」增加绕过规则；「生产发布顺序、串行与版本确认」改为先构建；新增迁移安全与回滚兼容检查。
- `staging-deployment`：「main 合并后自动部署 staging」覆盖手动触发与绕过规则。
- `job-queues`：新增 Cloudflare events 队列的死信要求。
- `observability`：新增生产日志保留与 live 阶段要求配置 Sentry。

## Impact

- **代码**：
  - `packages/ai/src/text/settle.ts`
  - `apps/web/src/features/ai/{text-stream,chat,media-tasks,media-runner}.ts`
  - 媒体前端页面
  - `packages/storage/src/media.ts`
  - `packages/auth/src/{auth,protection}.ts`
  - `packages/billing/src/{stripe/operations,events/shared,events/subscriptions,services}.ts`
  - `apps/web/src/{server,server.node}.ts`
  - `packages/auth/src/{deletion,workspace-lifecycle}.ts`
  - `apps/jobs/src/queues/billing.ts`
  - `apps/{web,jobs}/wrangler.jsonc`
- **数据库**：`ai_task` 增加取消计费类型字段，迁移由协调者统一生成。免费失败次数用现有索引按时间计数，不改 schema。
- **运行时设置**：新增 AI 失败免费次数与窗口、不确定提交等待时限。
- **CI/CD**：
  - `.github/workflows/{ci,deploy-staging,deploy-production}.yml`
  - `scripts/production/check-release.mjs`
  - 仓库变量 `RELEASE_PHASE`
  - 新增迁移检查工具依赖
- **Cloudflare 资源**：新建 `events-dlq` 队列（staging 与 production 各一）。web 与 jobs 的生产环境开启 observability。
- **文案**：媒体取消说明与不确定提交状态的多语言文案。
