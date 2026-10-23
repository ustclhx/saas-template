# Tasks

> 并行分工（协调者按 docs/09 §5 记法派发）：
> 第一波：`h-auth-headers`（1）∥ `h-billing`（2）∥ `h-ai-text`（3）
> 第二波：`h-media`（4）∥ `h-deletion`（5）∥ `h-release-ops`（6）
> 协调者负责：第 7 组、合并后生成迁移，以及验收。

## 1. 认证防刷与安全响应头

- [ ] 1.1 在 `packages/auth/src/auth.ts` 的 `disabledPaths` 中加入 `/email-otp/check-verification-otp`；测试断言请求该路径返回 404
- [ ] 1.2 在 `protection.ts` 中新增"只限流"路径集合（verify-email、email-otp reset-password、reset-password、sign-in/email-otp），按 IP 与邮箱限流，不要求 Turnstile；单元测试覆盖超限返回 429，且不调用后续处理器
- [ ] 1.3 增加并发错误验证码的测试：累计有效尝试不超过上限（无法在单元层复现时，用 Postgres 集成测试）
- [ ] 1.4 新增 `apps/web/src/security-headers.ts`，在 `server.ts` 的正常与错误分支、`server.node.ts` 中统一附加基础安全响应头；单元测试覆盖已存在同名头时不覆盖、HTTPS 下才发送 HSTS
- [ ] 1.5 生成 CSP Report-Only 策略：内联主题脚本使用 nonce 或 hash，并列出 Turnstile、Stripe、R2、Sentry 的来源；本地 `pnpm build` 后用浏览器访问首页、登录、对话页，确认没有违规报告，并在 PR 中附上结果说明
- [ ] 1.6 更新 `docs/04-auth-and-tenancy.md` 的防刷说明，在 `docs/07-infrastructure.md` 中记录安全响应头与 CSP 的上线步骤

## 2. 计费：币种锁定、周期变更、欠费开始时间

- [ ] 2.1 在 Stripe Checkout 参数中加入 `adaptive_pricing: { enabled: false }`；单元测试断言请求参数包含该项
- [ ] 2.2 `money()` 遇到币种不符时抛出 `BILLING_CURRENCY_MISMATCH`，webhook 管线将其视为不可重试错误：记录失败并发运营告警；Postgres 测试断言不发放积分且不再重试
- [ ] 2.3 新增 `nextPastDueSince` 纯函数，替换 `events/subscriptions.ts` 的两处赋值与 `services.ts:180` 的赋值；单元测试覆盖四种情况：欠费期间收到更新、每日对账、多次重试失败、恢复后再次欠费
- [ ] 2.4 `services.ts` 判断升降级时，周期不同的切换走定时切换路径（周期结束时生效）；测试断言月付切换年付时不调用立即开票，并在周期结束时生效
- [ ] 2.5 账单页的换套餐确认文案写明"周期变更在当前周期结束时生效"（多语言）；在 `docs/05-billing.md` 中更新升降级与欠费说明

## 3. AI 文本：免费失败次数与上游超时

- [x] 3.1 在 `packages/db/src/settings.ts` 新增 `ai.freeFailures`（次数默认 3，窗口默认 3600 秒），后台可编辑；settings 单元测试覆盖默认值
- [x] 3.2 text-stream 在检查点中记录最后一次尝试的用量（input、output、reasoning）；单元测试断言重试后检查点只保留最后一次尝试
- [x] 3.3 修改 `interruptedCredits` 及其调用方：在结算锁内统计窗口内的免费失败次数，超出后按最后一次尝试的用量结算（token 计费不低于 `minCharge`，按次计费收固定价，都不超过预扣），失败全退开关开启时仍全额退回；Postgres 测试覆盖第 3 次退款、第 4 次扣费、窗口滚动后恢复，以及兜底处理器走相同规则
- [x] 3.4 每次上游尝试加空闲超时（60 秒）与总超时，用 `AbortSignal.any` 合并用户取消；单元测试用不返回数据的假流断言中止、重试后失败结算、心跳停止
- [x] 3.5 在 `docs/06-ai.md` 更新失败计费与超时说明

## 4. AI 媒体：取消计费、不确定提交、配额

- [ ] 4.1 在 `ai_task` schema 中新增 `cancel_billing` 字段与部分唯一索引（只用 `drizzle-kit push` 同步到本 worktree 数据库，不提交迁移）
- [ ] 4.2 新增取消预览接口（返回本次是否计费与剩余免费次数），并按 D2 改写 `handleMediaCancel`：先查服务商状态，再在锁内结算；Postgres 测试覆盖排队中免费、首次已开始免费、第二次已开始按全价扣费，以及状态查询失败按已开始处理
- [ ] 4.3 前端取消按钮加确认弹窗，说明计费规则与剩余免费次数（多语言）；用组件测试或 Playwright 离线用例验证三种文案
- [ ] 4.4 不确定提交改为保留预扣并等待回调（等待时限为运行时设置，默认 1 小时）：回调验证允许处于标记状态、还没有作业 ID 的任务，并写入回调中的作业 ID；测试覆盖等待期间回调成功后结算、超时退款、任务结束后的晚到回调不改变结果
- [ ] 4.5 提交前检查存储配额，转存后才超额时保存产出并按成功结算；测试覆盖两种情况
- [ ] 4.6 更新 `docs/06-ai.md` 中的媒体取消与提交说明

## 5. 删除与清理

- [ ] 5.1 `cleanupExpiredWorkspaces` 按外键顺序删除空间的 `ai_message`、`ai_conversation`、`ai_task`，跳过仍有 `held` 预扣的行；Postgres 测试断言保留期后这些表中没有该空间的行，财务表不变
- [ ] 5.2 `deleteAccount` 的事务内删除 newsletter、waitlist 中对应邮箱的记录与该用户的通知，并去除审计记录元数据中的邮箱与姓名；Postgres 测试断言
- [ ] 5.3 在 jobs 清理任务中分批删除已删除用户在团队空间中的对话、消息与媒体任务；Postgres 测试断言团队空间其他成员的数据与积分流水不受影响
- [ ] 5.4 更新 `docs/03-data-model.md` 的删除与保留说明，包括"24 小时内完成删除"

## 6. 发布门禁、迁移安全与可观测性

- [ ] 6.1 抽出共享的发布检查模块：要求该 SHA 在 main 上有成功的 CI，支持 `RELEASE_PHASE=testing` 与 `bypass=hotfix` + `reason` 两种绕过，并写入 Job Summary；用 node 测试覆盖各分支；在 `deploy-staging.yml` 与 `deploy-production.yml` 中加入 dispatch 输入并接入该模块
- [ ] 6.2 `deploy-production.yml` 改为先构建、再迁移、再部署；`RELEASE_PHASE=live` 时缺少 Sentry 配置则失败，`testing` 时只警告；用 actionlint 或 `act` 的 dry-run 校验语法
- [ ] 6.3 迁移入口设置 `lock_timeout=5s` 与 `statement_timeout=15min`；用本地 PG 集成测试证明锁被占用时迁移失败
- [ ] 6.4 CI 对新增迁移运行固定版本的 squawk（确认 npm 包名与发布者无误），支持带原因的豁免；在 PR 中演示对一条危险迁移的拦截结果
- [ ] 6.5 回滚兼容检查：读取生产 health 的版本，列出比目标 tag 新增的迁移，任一条缺少 `-- rollback-safe:` 注释即失败；node 测试覆盖各种情况；为已有迁移补齐判断后的注释
- [ ] 6.6 生产环境的 web 与 jobs `wrangler.jsonc` 开启 observability；`events` 队列配置 `dead_letter_queue: "events-dlq"`，jobs 消费 `events-dlq`，写入死信表并告警；不可重试错误直接投递到死信队列；单元测试覆盖消费者
- [ ] 6.7 更新 `docs/07-infrastructure.md` 与生产 runbook：说明 `RELEASE_PHASE`、紧急修复的触发方式、回滚兼容注释、`events-dlq` 的创建步骤，并在上线清单中加入"`RELEASE_PHASE` 改为 `live`"

## 7. 协调者：合并后与验收

- [ ] 7.1 第 4 组合并后，在 main 上生成 `ai_task.cancel_billing` 迁移（如第 6 组需要死信字段，一并生成），加 `rollback-safe` 注释，并在本地 `saas_dev` 验证
- [ ] 7.2 创建 staging 与 production 的 `events-dlq` 队列，设置仓库变量 `RELEASE_PHASE=testing`
- [ ] 7.3 staging 验收：Stripe test clock 月付切换年付、并发猜验证码被限流、媒体取消三种情况、免费失败第 4 次扣费、CSP 没有违规报告、删号后数据已清理；证据写入 `EVIDENCE_DIR`
