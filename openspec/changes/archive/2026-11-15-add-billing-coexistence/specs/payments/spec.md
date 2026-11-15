# Spec Delta

## ADDED Requirements

### Requirement: 共存套餐目录
定价数据 SHALL 分别提供订阅与一次性积分包；订阅价格 SHALL 按月付与年付区分，切换周期 MUST NOT 隐藏积分包。权益展示清单 SHALL 来自套餐 features 数据。公开定价读取失败 SHALL 保留既有快照降级。

#### Scenario: 两类套餐同时存在
- **WHEN** 目录包含月付、年付订阅和一次性积分包
- **THEN** 两类均有独立数据，订阅切换周期不改变积分包，权益清单反映套餐配置

### Requirement: 订阅用户追加积分包
已有有效订阅的空间 owner SHALL 能购买积分包；积分包付款 SHALL 只增加积分，不取消订阅或改变其权益，重复付款投递 MUST NOT 重复入账。

#### Scenario: Stripe 订阅空间购买积分包
- **WHEN** 同一空间先完成订阅首付，再完成积分包付款，并重复投递两个付款事件
- **THEN** 订阅保持有效，两类付款各入账一次，订阅与购买来源的积分分别可用
