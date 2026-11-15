# Design

## Context

动机见 proposal.md；行为契约见本 change 的 specs。本节只列出影响实现方式的现状。

- **积分写入**：都经过 `packages/credits`，按工作区取咨询锁，并对预扣行加 `FOR UPDATE`。结算函数都在这把锁内运行，所以在锁内读取的次数类数据不会被并发请求同时读到旧值。
- **对话失败结算**：
  - 由 `packages/ai/src/text/settle.ts` 的 `interruptedCredits` 决定，它目前只看「失败且无可见正文」这一条件。
  - `apps/web/src/features/ai/text-stream.ts` 记录每次尝试的用量，被丢弃的尝试计入 `absorbed`。
  - 定时兜底处理器 `chatHoldSweeper` 复用同一结算函数。
- **媒体任务**：
  - 取消由 `media-tasks.ts` 的 `handleMediaCancel` 处理：先调用 `settleMediaTask(outcome: 'canceled')` 退款，再通知服务商与 Workflow 取消。
  - 提交结果不确定时由 `media-runner.ts` 标记 `MEDIA_SUBMISSION_UNCERTAIN` 并退款。
  - 回调路由按「任务 HMAC + 服务商签名 + 作业 ID」验证后写入 `callbackPayload`。
- **订阅欠费时间**：`pastDueSince` 只有 `past_due` 事件会赋值。`subscription.updated` 事件、换套餐路径（`services.ts:180`）与每日对账（`cron.ts:286`，同样构造 `subscription.updated` 事件）都会用快照中恒为 null 的值覆盖它。
- **Stripe 换套餐**：降级已在当前周期结束时生效，即"定时切换"路径。升级用 `always_invoice` 立即切换。
- **发布流程**：
  - 生产只检查"是否有成功的 staging 发布"（`scripts/production/check-release.mjs`），并在构建前执行迁移。
  - Cloudflare 回滚方式是对旧 tag 重跑 `workflow_dispatch`。
  - self-host 的 release bundle 已有 `rollbackCompatibleWith` 概念。
- **队列**：
  - Cloudflare 队列没有配置死信队列。
  - 事件消费者遇到终态失败时需要注入 `deadLetters`，而只有 Node 目标提供它（job-engine 死信表）。

## Goals / Non-Goals

**Goals:**
- 每项修复都配有能复现原缺陷的测试（单元测试，或 Postgres 集成测试），并且改动后测试通过。
- 保持现有积分账本的不变量：幂等、不透支、单次结算。

**Non-Goals:**
- 不做文本对话的并发数上限，也不做按用户的花费上限，这次只修计费漏洞。
- 不改变 PayPal 的换套餐行为。
- 不为邮件队列配置死信队列。
- 不做完整的 GDPR 导出功能。
- CSP 本次只上线到 Report-Only，不切换到强制执行；何时强制执行另行决定。

## Decisions

### D1 AI 免费失败次数在结算锁内按时间计数
- **计数方式**：结算一次无可见正文的失败时，在工作区咨询锁内统计该工作区窗口内的 `ai_message` 行，条件为 `status='failed' and credits=0 and role='assistant'`。
  - 时间下界用 UUIDv7 的时间前缀表示，可以复用现有的 `(workspace_id, id desc)` 索引。
  - 计数小于 N 则释放预扣，否则按最后一次尝试的用量结算。
- **"最后一次尝试的用量"**：由 text-stream 在检查点里额外记录 `lastAttempt` 用量（input、output、reasoning）。兜底处理器拿不到这项数据时按 `minCharge` 计，按次计费则按固定价，且都不超过预扣。
- **配置位置**：N 与窗口放在 `packages/db/src/settings.ts`，作为运行时设置，默认 3 次 / 3600 秒。
- **备选方案**：新增计数表或使用 KV 计数器。否决原因是计数与结算必须在同一个事务锁内完成，用 KV 会产生竞态。

### D2 媒体取消先确认服务商状态，免费次数记录在任务上
- **新增字段**：`ai_task` 增加 `cancel_billing` 字段，可取值为 `free_unstarted`、`free_started`、`charged`、null。再加一个部分唯一索引 `(workspace_id) where cancel_billing='free_started'`，从数据库层面保证每个工作区终身只有一次免费取消。
- **取消流程**：
  1. 先查询服务商的作业状态。fal 的 `status` 接口可以区分 `IN_QUEUE` 与 `IN_PROGRESS`；没有 `providerJobId` 时视为尚未开始生成。
  2. 尝试通知服务商取消。
  3. 在锁内结算：
     - 尚未开始生成：退款。
     - 已开始生成且该工作区还没有 `free_started` 记录：退款，并写入 `free_started`。
     - 其余情况：按定价快照全价结算（复用成功结算的金额计算），并写入 `charged`。
- **状态查询失败时**：按"已开始生成"处理，以平台风险最小为准。
- **前端**：取消按钮先请求一个只读的"取消预览"接口，拿到本次是否计费与剩余免费次数，弹出确认框后才执行取消。服务端以执行取消时的判断为准；预览之后状态发生变化时，执行结果以服务端返回为准并提示用户。
- **备选方案**：不查询服务商，按任务状态是否为 `running` 判断。否决原因是 `running` 只表示 Workflow 在运行，并不表示服务商已经开始生成，排队中的任务会被误判为已开始。

### D3 不确定提交改为等待回调
- **提交结果不确定时**：任务保持 `running` 状态，`errorCode` 记为 `MEDIA_SUBMISSION_UNCERTAIN` 作为标记，保留预扣。Workflow 在运行时设置的等待时限内（默认 1 小时，小于 2 小时的硬超时）等待回调事件。
- **回调到达时**：此时任务还没有 `providerJobId`。回调验证改为：任务处于这个标记状态时，任务 HMAC 与服务商签名都通过即接受，并把回调中的作业 ID 写入任务，随后走正常的成功或失败结算。
- **超时**：标记失败并退款，与现在的行为一致。
- **晚到回调**：任务已经结束后才到达的回调只记录日志，不改变已结算的结果。

### D4 存储配额前置检查与生成后超额
- **提交前**：在预扣之前读取 `getStorageUsage`，用量大于等于配额时拒绝，返回现有的配额错误码。
- **生成后超额**：`packages/storage` 的媒体转存在这种情况下不再抛出 `UPGRADE_REQUIRED`，而是照常保存产出，并返回 `overQuota` 标记，由调用方记录日志。之后的上传与提交照常因配额已满被拒绝。

### D5 OTP 防护
- `/email-otp/check-verification-otp` 加入 `disabledPaths`。
- `protection.ts` 新增一个"只限流"路径集合，包含 `/email-otp/verify-email`、`/email-otp/reset-password`、`/reset-password`、`/sign-in/email-otp`。这些路径走与现有路径相同的 IP + 邮箱限流键，但不要求 Turnstile。
- 计数竞态的修复依赖两点：校验接口已禁用，而消费验证码的接口本身使用原子消费。补一条测试：并发提交错误验证码，累计成功的尝试次数不超过上限。

### D6 计费
- **币种锁定**：
  - Stripe Checkout 显式传 `adaptive_pricing: { enabled: false }`。
  - `money()` 遇到币种不符时抛出带 `BILLING_CURRENCY_MISMATCH` 码的错误。webhook 管线把这个错误码归为不可重试的终态失败，记录 `webhook_event` 失败行并发运营告警。
- **周期变更**：`services.ts` 判断升降级时，先比较计费周期。周期不同的切换一律走现有降级的定时切换路径，在周期结束时生效。
- **欠费开始时间**：`packages/billing` 新增纯函数 `nextPastDueSince(current, nextStatus, eventTime)`，替换 `events/subscriptions.ts` 中两处赋值与 `services.ts:180` 的赋值。每日对账走 `applyBillingEvent`，自动被覆盖。

### D7 安全响应头
- 在 `apps/web` 新增 `security-headers.ts`，导出 `withSecurityHeaders(headers, { https })`。`server.ts` 在附加 `x-request-id` 的位置调用它，错误分支同样调用；`server.node.ts` 复用同一函数。
- 只在上游没有设置同名头时才写入。
- CSP 的 Report-Only 策略按实际集成生成：Turnstile、Stripe 跳转、R2 下载域名、Sentry、内联主题脚本使用 nonce 或 hash。
- **备选方案**：Cloudflare 的 Transform Rules。否决原因是 Node 目标无法共享这套配置，而且规则不进版本库。

### D8 删除范围与执行时机
- **空间到期清理**（`cleanupExpiredWorkspaces`）：按外键顺序删除 `ai_message`、`ai_conversation`、`ai_task`。仍有 `held` 状态预扣的行先跳过，等预扣兜底处理器结算后下一轮再删。
- **删号**（`deleteAccount`）：
  - 删号事务内：删除 newsletter 与 waitlist 记录（此时原邮箱还在）以及该用户的通知，并去除审计记录元数据中该用户的邮箱与姓名。
  - 事务外：团队空间中该用户的对话、消息与媒体任务，交给 jobs 的定时清理分批删除，与空间到期清理放在同一个清理任务里，按已删除用户扫描。这样删号事务不会因为数据量大而长时间持锁。
- **保留**：财务表（payment、refund、subscription、credit_*、webhook_event）与审计记录。

### D9 发布阶段与 CI 门禁
- **仓库变量 `RELEASE_PHASE`**：取值为 `testing` 或 `live`。未设置时按 `live` 处理，即默认采用更严格的规则。
- **`check-release.mjs`**：
  - 在现有检查之外，新增"该 SHA 在 main 上有成功的 CI push 运行"这一项。
  - 以下两种情况跳过 CI 检查，并输出 `::warning` 与 Job Summary，记录绕过类型、原因与 `github.actor`：`RELEASE_PHASE=testing`；或者 `workflow_dispatch` 时输入 `bypass=hotfix` 并填写 `reason`。
- **staging 手动触发**：`deploy-staging.yml` 的 `workflow_dispatch` 入口使用同一套规则，检查脚本抽成共享模块。
- **发布顺序**：`deploy-production.yml` 改为先构建 jobs 与 web，构建产物保留在同一个 job 内，然后再执行迁移、部署。
- **Sentry 必需**：`RELEASE_PHASE=live` 时缺少 Sentry DSN 则发布失败，`testing` 时只警告。

### D10 迁移安全与回滚兼容
- **超时设置**：迁移命令通过连接串的 `options` 参数设置 `lock_timeout=5s` 与 `statement_timeout=15min`，staging 与 production 共用同一个迁移脚本入口。
- **迁移检查**：CI 对相对 base 新增的迁移 SQL 运行 squawk（固定版本，加入 devDependencies，加入前确认 npm 包名与发布者无误）。豁免使用 squawk 自带的 ignore 注释，并要求同一行写明原因。
- **回滚兼容**：
  - 回滚时，从生产 `/api/health` 读取当前 `version`，并在 git 中列出"当前版本相对目标 tag 新增的迁移文件"。
  - 每个新增迁移都带有 `-- rollback-safe: <原因>` 注释时，允许回滚；否则在部署前失败。
  - 新迁移由协调者生成时，就判断它是否只做扩展、旧代码可以兼容；可以兼容则加上这条注释。
- **备选方案**：沿用 self-host 的 bundle 声明方式。否决原因是 Cloudflare 发布没有 release bundle，按迁移文件逐条标注更简单，也能被 CI 校验。

### D11 可观测性与上游超时
- **日志**：生产环境下 web 与 jobs 的 `wrangler.jsonc` 都开启 `observability`（`head_sampling_rate: 1`）。
- **events 死信队列**：
  - `events` 队列配置 `dead_letter_queue: "events-dlq"`，由 jobs 消费 `events-dlq`。
  - 死信写入 job-engine 现有的死信表（字段满足 spec 时直接复用；不满足时按 §3 只在 schema 中新增字段），并发送运营告警。
  - Cloudflare 上遇到不可重试错误时，通过 producer 绑定把消息直接投递到 `events-dlq` 后再确认，取代现在"重试 5 次后被丢弃"的行为。
- **上游超时**：
  - 每次尝试新建一个 `AbortController`，用 `AbortSignal.any([userSignal, attemptController.signal])` 合并用户的取消信号。
  - 每收到一个片段就重置空闲计时器（默认 60 秒）；总超时取 `deadline`。
  - 超时产生的错误归为可重试的上游错误，复用现有的重试、续写与失败路径。

## Risks / Trade-offs

- **[风险] 免费失败的计数窗口可能被并发请求在锁外绕过** → 计数在结算锁内进行，预扣阶段不预判，所以并发请求只会在结算时串行计数。
- **[风险] 服务商状态查询有延迟，排队中的任务可能被判为已开始** → 只影响免费次数是否被使用，用户在确认框里已经知情；失败时按"已开始"处理，以平台风险最小为准。
- **[权衡] 周期变更延迟生效，想立即换年付的用户要等到周期结束** → 这是用户已确认的方案，前端在确认页写明生效时间。
- **[风险] 删号后的清理是异步执行，有时间差** → 清理任务至少每天运行一次，账号删除说明中写明"24 小时内完成删除"。
- **[风险] `RELEASE_PHASE` 忘记从 `testing` 改为 `live`** → 正式上线的 runbook 中加入这一步；每次以 testing 阶段发布时，Job Summary 都显示警告。
- **[风险] squawk 误报，阻塞正常迁移** → 允许带原因的豁免注释；只检查新增文件，不检查历史迁移。
- **[风险] CSP 漏掉某个集成域名** → 先以 Report-Only 上线，不影响用户。

## Migration Plan

1. 按 tasks 分组并行实施。`ai_task.cancel_billing` 由协调者在合并后统一生成迁移；该迁移只新增可空列和部分索引，加上 `rollback-safe` 注释。
2. 合并后在 Cloudflare 的 staging 与 production 各创建 `events-dlq` 队列，并设置仓库变量 `RELEASE_PHASE=testing`。
3. staging 验收：
   - 用 Stripe test clock 走一遍"月付切换年付"。
   - 并发猜验证码，确认被限流。
   - 媒体任务取消的三种情况各走一遍。
   - 免费失败第 4 次开始计费。
   - 确认 CSP Report-Only 没有违规报告。
   - 确认删号后数据已清理。
4. 回滚：除 `cancel_billing` 的扩展迁移外，所有改动都是代码层面的，可以按 tag 回滚。
