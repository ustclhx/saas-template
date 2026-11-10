## ADDED Requirements

### Requirement: 每日赠送指标
既有运营指标 SHALL 展示每日实际赠送次数和积分总数，来源 MUST 为已提交的 daily 账本，不包含邮箱正文。并发重试、缓存命中与未发放的访问 MUST 不增加指标。

#### Scenario: 权威汇总
- **WHEN** 多个请求只产生一次实际赠送并运行现有汇总
- **THEN** 当日次数为 1，积分总数为该次实际赠送量
