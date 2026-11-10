# Spec Delta

## MODIFIED Requirements

### Requirement: 预扣与余额不足
发起消费时 SHALL 先预扣；可用余额不足时 MUST 拒绝并返回 `INSUFFICIENT_CREDITS`，HTTP 状态为 402，详情包含本次预计消耗 `estimatedCredits` 与当前可用余额 `availableCredits`；聊天及通用预扣 SHALL 使用相同合同，并提供客户端解析工具。并发预扣 MUST NOT 使任何批次的剩余积分小于零。

#### Scenario: 并发预扣
- **WHEN** 余额 10，两个各需 8 的请求同时预扣
- **THEN** 只有一个成功，另一个收到余额不足，详情为预计消耗 8、当前余额 2

#### Scenario: 聊天余额不足
- **WHEN** 聊天请求因余额不足无法执行
- **THEN** 客户端能解析数值并显示最小购买引导，提供积分包与订阅两个入口

#### Scenario: 其他业务错误
- **WHEN** 错误是欠费、鉴权失败或未知错误
- **THEN** 解析工具不将其误判为余额不足，任意内部详情不被公开

## ADDED Requirements

### Requirement: 账单分类积分摘要
账单摘要 SHALL 分开返回仍可用的订阅积分、当前月度订阅批次积分、积分包积分和免费积分（signup 与 daily 分开且有合计）。预扣占用、已过期或撤销的余额 MUST NOT 计入；其他来源 SHALL 单独归类以便与总余额核对。member SHALL 延续既有账单金额与余额可见性限制。

#### Scenario: 混合来源与预扣
- **WHEN** 空间同时有订阅、购买、signup 和其他来源，且有预扣与失效批次
- **THEN** 分类合计与可用总余额一致，免费来源单独返回，失效与预扣部分不计入

#### Scenario: R3 daily 合并
- **WHEN** R3 已增加 daily 来源且空间获得 daily 积分
- **THEN** 摘要自动将其计入免费 daily 与免费合计，无需新建定时任务
