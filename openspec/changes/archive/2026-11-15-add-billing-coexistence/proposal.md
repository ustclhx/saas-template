# Proposal

## Why

订阅和一次性积分包已有独立的购买与发放链路，但定价、账单和余额不足错误尚未提供两者并存所需的完整数据。补齐共享数据合同和权益扩展点，让衍生项目与独立 UI 变更能直接接线。

## What Changes

- 统一 `INSUFFICIENT_CREDITS` 的预计消耗和当前余额详情，聊天与通用预扣共用，并提供客户端解析工具与最小购买引导。
- 提供订阅（月付/年付）和积分包分组数据，展示权益由 `plan.features` 派生。
- 提供租户隔离的账单摘要：当前订阅、下次续费、当前月度订阅批次余额、积分包、signup/daily 免费积分；保留订阅者购买积分包的能力。
- 扩展 `can(ctx, '<featureKey>')`，未知或未授权键默认拒绝，服务端检查与 UI 锁定态共用结果。
- 用 Stripe 离线映射与 Postgres 集成测试验证同一空间订阅加积分包付款入账与幂等；真实 Stripe 验收独立保留未完成。
- 在 change 内提供升级说明草稿与 UI 交接合同。视觉组件和分区布局由 `add-ui-design-system` 8.6/8.7 负责。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `payments`：按类型分组的定价数据、从套餐权益派生展示清单，订阅与积分包购买并存。
- `subscriptions`：账单摘要中的有效订阅与续费信息。
- `credits`：分类可用余额与余额不足详情/客户端合同。
- `entitlements`：项目自定义布尔功能键的服务端授权与使用示例。

## Impact

涉及 shared、credits、billing、entitlements、db 的 `PlanFeatures` JSON 类型及 web 的计费/聊天接线；沿用已有支付 Provider、账本和公开定价缓存降级，无新增依赖、定时任务或轮询。预计无需物理 schema 变化；若实施确认需要，按 worktree 规则只 push 本地库，不提交迁移 SQL。升级草稿随 change 提交，发布版本由协调者确定。
