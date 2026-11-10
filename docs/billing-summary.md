# 共存定价与账单数据接口

`add-billing-coexistence` 只提供最小接线；卡片视觉、分区布局由 UI 8.7 替换。

## 定价

`features/marketing/pricing-data.ts` 保留公开快照与缓存降级，`marketingPlans(catalog)` 保留完整 `features`，并给出 `featureItems`：`maxSeats`、`storageGb`、`maxConcurrentTasks`、`publicApi`、`priorityQueue`、`watermark`、`models`。条目为 `{ key, value }`，由 UI 本地化；不根据套餐名称猜测权益。`groupPricingPlans(plans)` 返回 `subscriptions` / `creditPacks`；`pricingForInterval(plan, 'month' | 'year')` 只切换订阅价格，积分包始终使用一次性价格。目录原始 prices 字段不变。

## 账单

已鉴权的 `getCustomerBilling` 新增 `summary`；owner/admin 可读，member 返回 null 并且不会读取分类余额。已有 `credits`、订阅历史和 owner 支付/退款历史合同不变。

`summary.currentSubscription` 为最高有效套餐对应订阅（id/name/planKey/provider/status/currentPeriodEnd/cancelAtPeriodEnd），生效判断复用 `selectEntitlements`，包含 past_due 宽限与付费重叠期；没有则 null。`nextRenewalAt` 仅当前订阅仍继续续费时返回边界，取消、终止、暂停均为 null。

`summary.credits` 来自 `@saas/credits` 导出的 `getCreditSummary(db, workspaceId, now?, tx?)` / `CreditSummary`：

- `subscriptionAvailable`：全部可用订阅批次，含宽限与结转。
- `subscriptionCurrentMonth`：依据付款 periodStart/periodEnd、原始 UTC 月锚点和 `{paymentId}:{n}` 归属的当前月度批次，不依据 createdAt 或自然月。
- `creditPack`：purchase 来源。
- `free.signup` / `free.daily` / `free.total`：daily 只按文本读取，为 R3 发放接入预留。
- `other`：其余来源；`available = subscriptionAvailable + creditPack + free.total + other`。

一个 SQL 快照统计 active 且尚未到期的 remaining；预扣已经扣减 remaining，因此不会重复扣减 held。撤销与过期批次不计入。所有 grant/payment 关联限定当前空间。年付锚点从付款原始日期计算，Jan 31 → Feb 28 → Mar 31；旧月批次保留在全部余额中。

账单购买入口支持 `#subscriptions` / `#credit-packs`，选中对应类型；订阅存在不影响积分包 checkout。无物理 schema、新轮询或新定时任务。R3 合并后需协调者用实际 daily 发放复核。
