# Proposal

## Why

模板已有验证邮箱后的注册赠送，需要增加可配置的每日访问赠送，支持免费体验并控制每月赠送成本。该能力需保持跨账号防刷与数据库按需唤醒。

## What Changes

- 增加 daily 来源与原子领取记录，按 UTC 日幂等、规范化邮箱每月最多领取 D 天。
- 复用邮箱规范化和注册赠送黑名单，只向个人空间发放，保留现有消费与付款退款规则。
- 增加模板开关和后台运行时参数，App 服务端惰性触发并使用短期缓存。
- 最小接线一次性领取提示、验证邮箱入口、用量流水和每日赠送指标。
- 提供 Postgres 并发集成测试及升级草稿，最终提示视觉由 add-ui-design-system 8.6 接管。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `credits` 增加每日领取、防刷、缓存及用量可见行为。
- `runtime-config` 增加 daily 开关和运行时赠送参数。
- `product-analytics` 增加每日赠送次数和积分数的权威指标。

## Impact

涉及 packages/credits、db credits/metrics schema、config、注册赠送黑名单共用工具、App 布局、后台设置和既有指标汇总。无新增依赖、Cron 或公开页查库。仅向本 worktree 数据库 push schema，迁移 SQL 由协调者生成。
