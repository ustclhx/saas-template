# Design

## Context

详细设计见 `docs/05-billing.md` 与 `docs/03-data-model.md` §3–4、§7；动机见 proposal.md。依赖 `add-auth-and-workspaces` 的空间模型、`withWorkspace` 中间件、删除流程钩子与 `audit_log`。积分账本是整个模板中正确性要求最高的部分，设计的重点是事务边界与幂等键。

## Goals / Non-Goals

**Goals:**
- `packages/credits` 成为唯一修改积分余额的入口，所有变动在单个数据库事务内完成并写流水。
- 支付平台差异封装在 `PaymentProvider` 实现中，业务层只处理内部统一事件。

**Non-Goals:**
- MoR（Creem / Paddle / Polar）实现、多币种、Stripe Tax。
- 三种计费方式的价格计算（`estimateCredits` / `actualCredits`）：属于 `add-ai-text-chat` 的 `ai-model-registry`。
- 完整的管理后台计费页面：本 change 只做退款审核与回调重放的最小可用页面，其余在 `add-admin-console`。

## Decisions

1. **积分账本的事务模型**：`hold` 在一个事务内 `SELECT ... FOR UPDATE` 锁定该空间的 active 批次，按消费顺序分配，写 `credit_hold` 与 `credit_hold_allocation`。`capture` / `release` 以 `UPDATE credit_hold SET status=? WHERE id=? AND status='held'` 作为状态机闸门，影响行数为 0 即抛 `HOLD_NOT_ACTIVE`。备选「余额单列一个计数字段」更简单，但无法支持按批次过期与按付款收回。
2. **对外暴露带事务参数的 API**：`hold(tx, ...)` 等函数接受调用方的事务，使「并发检查 + 创建任务 + 预扣」能放在同一事务（AI change 需要）。不接受事务时内部自开事务。
3. **退回到失效批次**：退回时检查批次 `status` 与 `expires_at`，失效则不改 `remaining`，改写 `expire` / `revoke` 抵消流水。对账不变式：`sum(ledger.delta) = sum(active remaining) + sum(held amount) - debt`。
4. **超额与欠费**：`capture` 内部按 `billing.overage` 计算平台承担额，空间当日已承担量从 `credit_hold.overage_absorbed` 当日汇总得出（按 captured 记录的 `(ws, updated_at)` 查询，UTC 自然日，结算时写 SQL `now()`，量小，不另建计数表）。欠费单独存 `credit_debt(ws pk)`；`hold` 先查 `credit_debt.amount > 0` 则拒绝；`grant` 在同一事务内先偿还。
5. **Webhook 两事务**：事务 A 登记（`ON CONFLICT DO NOTHING`，独立提交）；事务 B 以 `SELECT ... FOR UPDATE` 锁住登记行后处理；失败时另起事务写 `failed`。理由：失败信息不能随事务 B 回滚而丢失（`docs/05-billing.md` §3）。
6. **事件映射与发积分时机**：Stripe 订阅付款统一走 `invoice.paid`（`subscription_create` / `subscription_cycle`），`checkout.session.completed` 只做关联；Stripe API 版本在 SDK 初始化时锁定，`provider_payment_id` 取 PaymentIntent ID。PayPal 一次性付款以 `PAYMENT.CAPTURE.COMPLETED` 为准，capture 接口只推进状态。
7. **订阅唯一性**：部分唯一索引 `unique(ws) where status in (...) and cancel_at_period_end = false`；撞上索引时（并发结账）由处理逻辑捕获唯一冲突，执行「取消后到者 + 全额退款 + 告警」。
8. **年付按月发放**：Cron `subscription-grants` 每小时运行，用 `source_ref = {payment.id}:{n}` 的唯一约束保证幂等；`plan.credits` 定义为每月发放量。
9. **注册赠送**：在 Better Auth 的 `emailVerification.onEmailVerification`（或 OAuth 已验证邮箱的注册钩子）中发放；`source_ref = sha256(规范化邮箱)`；一次性邮箱黑名单存在 `setting` 表。
10. **权益读取时计算**：`getEntitlements(ws)` 查询该空间所有订阅，按 spec 规则过滤生效者，取 `plan.sort` 最高者；结果在请求内缓存，不跨请求缓存。
11. **超时回收按类型注册处理器**：本 change 只实现扫描与分发框架 `registerHoldSweeper(refType, handler)`；按计费方式兜底的对话处理器由 `add-ai-text-chat` 注册，查询 Workflow 状态的任务处理器由 `add-ai-media-generation` 注册，避免本 change 依赖尚不存在的定价与任务模型。
12. **删除钩子**：向 auth change 的 `registerDeletionStep` 注册「订阅立即取消（不退款）」「退款提醒数据」「收回剩余积分」。
13. **待决事项默认值**：Q4 订阅积分默认不结转（`plan.rollover=false`）；Q5 升级不立即补发差额；Q6 退款不追溯已消费积分。均可通过配置或 plan 字段调整，不影响本 change 的结构。

## Risks / Trade-offs

- [PayPal 事件在不同 API 版本下差异大] → 用沙箱逐个录制真实回调作为测试夹具；映射表以夹具为准并回写 `docs/05-billing.md`。
- [Stripe 新版 API 中 invoice 与 PaymentIntent 关联字段变化] → 锁定 API 版本；升级 API 版本作为独立任务处理。
- [批次锁定导致同一空间的 AI 调用串行] → 可接受：锁持有时间只覆盖一次短事务；若成为瓶颈，再考虑按批次分段锁。
- [对账不变式被未经 `packages/credits` 的写入破坏] → 积分相关表只在 `packages/credits` 内写入，lint 规则禁止其他包直接写这些表。

## Migration Plan

新增表，无既有数据。上线前在 staging 用 Stripe 测试时钟和 PayPal 沙箱跑完 spec 中的全部场景。`plan` / `plan_price` 种子数据通过脚本 `pnpm billing:sync` 同步到两个平台。

## Open Questions

- 争议时是否自动将空间标记为受限，还是只告警由管理员决定；不影响数据结构与任务拆分（先实现标记能力，默认只告警）。
