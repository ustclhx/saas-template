# Spec Delta

## ADDED Requirements

### Requirement: 项目功能键授权
项目 SHALL 能在套餐 features 中配置自定义布尔功能键并通过 `can(ctx, '<featureKey>')` 判断；未配置与非 true 值 MUST 默认拒绝。服务端 SHALL 能在执行业务前要求该权益，拒绝时返回 `UPGRADE_REQUIRED` 和 403；仅拥有积分包 MUST NOT 解锁订阅权益。使用文档 SHALL 包含服务端检查和 UI 锁定态接线示例。

#### Scenario: 会员功能
- **WHEN** 付费套餐授权某个功能键，免费套餐未授权
- **THEN** 付费用户允许执行，免费用户与只买积分包用户在服务端被拒绝，界面可根据同一判定显示锁定态

#### Scenario: 未知键
- **WHEN** 项目检查没有配置的功能键
- **THEN** 返回 false，不推断其他套餐属性作为授权
