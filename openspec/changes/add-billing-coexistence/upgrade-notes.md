# 订阅与积分包并存：升级说明草稿

尚未发布。协调者确定模板版本后，将本稿内容合入对应 `docs/upgrades/<版本>.md` 并更新索引；本 change 不创建发布 tag。

## 概要

沿用现有订阅、积分包、账本和支付 Provider，补齐共存目录、账单分类摘要、余额不足错误合同和项目会员功能键。积分按先到期先消费，年付仍按月发放；购买积分包不取消订阅、不改变会员权益。

## 必须执行的动作

无强制数据迁移。已有自定义余额不足映射的项目应保留服务端新错误详情，以便前端显示预计消耗与当前余额；使用下述解析器代替自行解析 message。

## 配置变更

可选：在订阅套餐 `plan.features.capabilities` 中声明中性功能键，例如 `{ "exports.advanced": true }`，免费套餐不配置或置 false；缺失默认拒绝。既有 models、并发、席位、存储等字段不变。

服务端读取当前 workspace 权益，再执行 `can(ctx, 'exports.advanced')` 或 `requireEntitlement(ctx, { capability: 'exports.advanced' })`。客户端锁定态只负责引导，不能代替服务端检查。完整示例见 [项目功能键](../../../docs/entitlement-features.md)。

## 数据库变更

无物理 schema 变化、无迁移 SQL；PlanFeatures 的可选 capabilities 仅扩展现有 JSON 类型。无需 drizzle-kit push。R3 的 daily 来源由其独立 change 提供，本 change 只读取并分类。

## 部署顺序

先部署包含新错误合同和摘要的后端，再把项目页面接到新数据。视觉组件和定价/账单布局由 `add-ui-design-system` 8.6/8.7 提供，本 change 保留最小可用接线。

余额不足公共合同：HTTP 402，`{ error: { code: 'INSUFFICIENT_CREDITS', message, details: { estimatedCredits, availableCredits } } }`。两项均为非负整数，预计消耗为此次预扣/聊天最小可执行预算，余额为服务器检查时的可用值。

从 `@saas/shared` 导入 `parseInsufficientCredits(value)`；可传 AppError、HTTP JSON 或聊天 SDK 的 Error（JSON message），成功返回两个数值，其他错误或非法详情返回 undefined。直接 `hold` 的余额不足保留 CreditsError 身份并具有 AppError 合同。CREDIT_DEBT 保持 HTTP 402，UPGRADE_REQUIRED 保持 403。其他 CreditsError 为 500；所有 status >= 500 的 AppError 经 toErrorResponse 输出通用 INTERNAL_ERROR，内部 code、message 和详情只用于服务端诊断。AppError 的通用 publicDetails 选项显式声明可公开字段，内部 details 不自动序列化。

UI 8.7 可从 `groupPricingPlans` / `pricingForInterval` 获取订阅与积分包分组，从 `PricingPlan.features` 获取完整权益，并调用 `pricingFeatures(plan.features)` 派生展示清单。已鉴权的 `getCustomerBilling` 返回 `summary.currentSubscription`、`nextRenewalAt` 及 `summary.credits`。后者合同为 `{ available, subscription: { total, currentPeriod }, purchase, free: { signup, daily, total }, other }`；当前周期按原付款月度锚点统计，旧宽限/结转余额保留在 `subscription.total` 中且不计入 `subscription.currentPeriod`。查询默认使用数据库 `now()`，与余额和预扣共用时钟；R3 合并前 `free.daily` 默认为 0，并保留来源文本识别。member 不读取分类余额。完整类型与口径见 [数据接口](../../../docs/billing-summary.md)，公共错误详情见 [错误合同](../../../docs/billing-credit-errors.md)。

## 验证

离线 Stripe 真实录制映射 + 本 worktree Postgres 集成覆盖同空间订阅首付后购买积分包、重复事件只发放一次、订阅保持与账本对账。完整验证结果在最终 PR 记录。

真实 Stripe 测试模式购买（任务 4.3）保持未完成。需提供本测试环境的 `STRIPE_SECRET_KEY`（sk_test）、对应 `STRIPE_WEBHOOK_SECRET`、已同步月付/年付订阅与一次性积分包价格、可达的回调端点，以及测试登录账号。不得把 live 凭据混入此验收；原始凭据不写入证据或 PR。联通验收应确认同空间两类付款各一条、各一份来源批次、重复投递幂等和余额可对账。

R3 合并后验证 daily 实际发放进入 free.daily/free.total，signup 领取语义不变；本 change 不声称验证尚未合并的 daily 发放机制。

## 回滚

回退代码即可，既有订阅、购买和积分账本无需改写。新 capabilities JSON 对旧代码为附加字段；项目专属功能应随服务端授权代码一同回滚。

## 已知问题

真实 Stripe 测试模式验收和 R3 合并后的 daily 实际发放核验留给协调者。UI 视觉稿与最终共享组件仍由 UI change 负责。发布版本与升级说明最终文件名由协调者决定。
