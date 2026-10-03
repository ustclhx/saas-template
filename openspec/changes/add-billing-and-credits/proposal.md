# Proposal

## Why

模板要同时支撑订阅制和积分包两种商业模式，所有 AI 消费都通过积分「预扣—结算」完成（`docs/05-billing.md`）。积分账本的正确性（不重复发放、不出现负余额、流水与余额可对账）是 AI 功能上线的前提，必须在 AI change 之前独立完成并经过并发测试（`docs/08-roadmap.md` Phase 2）。

## What Changes

- 支付抽象 `PaymentProvider` 及 Stripe、PayPal 两个实现：订阅与积分包结账、Stripe Customer Portal、PayPal 自建取消 / 恢复。
- Webhook 通用管线：按平台投递去重、登记与处理分两个事务、失败记录、后台可重放；workspace 只在首次关联时从 metadata 解析，之后按平台对象 ID 查本地表。
- 订阅生命周期：首付与续费统一由付款成功事件发积分；同一空间只允许一个「会续费的」订阅，换套餐 / 换平台时允许新旧订阅重叠；结账前置检查。
- 积分账本 `packages/credits`：批次发放（含年付按月发放、注册赠送防刷）、预扣 / 结算 / 释放状态机、退回到已失效批次时的抵消流水、过期、超额容忍与欠费、对账不变式。
- 权益：读取时计算生效订阅，多个生效订阅取较高套餐；`can()` / `limit()` 替换 auth change 中的占位 `withEntitlement`。
- 退款：平台退款 / 争议时收回剩余积分；用户发起退款申请、管理员审核后退款（默认不主动退款）；删除账号时立即取消订阅并提醒可先申请退款。
- Cron：积分过期、年付按月发放、hold 超时回收、订阅对账、积分对账不变式校验。
- 页面：定价页、账单页、用量页；退款申请审核页的最小版本。
- 决定待决事项 Q4、Q5、Q6（均按设计默认值）。

## Capabilities

### New Capabilities
- `payments`: 订阅与积分包的结账、支付平台差异的对外行为、结账前置检查。
- `payment-webhooks`: 支付平台回调的验签、去重、处理与失败重放。
- `subscriptions`: 订阅状态、续费、取消、换套餐与重叠期。
- `credits`: 积分批次、余额、消费顺序、预扣与结算、过期、超额与欠费、对账。
- `entitlements`: 套餐权益的计算与检查。
- `refund-requests`: 用户退款申请与人工审核，以及删号时的退款提醒。

### Modified Capabilities
（无。删号流程中的计费步骤通过 `add-auth-and-workspaces` 提供的删除钩子接入，`account-deletion` 的已有要求不变；新增要求写在 `refund-requests` 中。）

## Impact

- 依赖 `add-auth-and-workspaces`（空间、中间件、删除钩子、`audit_log`）。
- 新增表：`plan`、`plan_price`、`billing_customer`、`subscription`、`purchase`、`payment`、`refund_request`、`webhook_event`、`credit_grant`、`credit_hold`、`credit_hold_allocation`、`credit_ledger`、`credit_debt`。
- 新增外部服务：Stripe（测试模式）、PayPal（沙箱）。
- `add-ai-text-chat` 与 `add-ai-media-generation` 通过 `packages/credits` 的 hold / capture / release 计费；三种计费方式的价格计算属于 AI change 的 `ai-model-registry`，本 change 只处理积分数量。
