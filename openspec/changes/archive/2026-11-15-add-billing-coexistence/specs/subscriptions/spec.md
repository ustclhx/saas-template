# Spec Delta

## ADDED Requirements

### Requirement: 账单订阅摘要
账单服务 SHALL 返回当前最高有效套餐对应的订阅和下次续费时间；已设周期末取消或已终止的订阅 MUST NOT 宣称会续费。读取 SHALL 复用既有鉴权、租户隔离及生效规则，重叠期历史订阅列表 SHALL 保留。

#### Scenario: 生效订阅
- **WHEN** owner 或 admin 查看具有有效订阅的空间账单
- **THEN** 摘要含当前订阅，继续续费时含下一付款周期边界

#### Scenario: 取消或免费空间
- **WHEN** 当前订阅已设周期末取消，或没有有效订阅
- **THEN** 前者保留当前权益及结束时间但不显示下次续费，后者当前订阅为空
