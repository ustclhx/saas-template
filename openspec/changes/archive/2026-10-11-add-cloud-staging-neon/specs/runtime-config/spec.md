# Spec Delta

## ADDED Requirements

### Requirement: 已启用的可选集成缺少凭据时告警
模板配置启用、但凭据为可选的外部集成（如支付服务商）在当前环境缺少凭据时，Worker SHALL 继续服务并以该集成不可用的方式运行，同时 MUST 记录一条告警日志，列出集成名称与缺失的变量名，MUST NOT 输出任何密钥的值；同一 isolate 内同一集成的告警 SHALL 只记录一次。

#### Scenario: jobs 缺少支付凭据
- **WHEN** 模板配置启用了 `stripe`，而 jobs 的定时任务运行时缺少 `STRIPE_SECRET_KEY`
- **THEN** 定时任务照常执行其他工作，日志中出现一条告警，包含 `stripe` 与 `STRIPE_SECRET_KEY`，不包含任何密钥值

#### Scenario: 凭据部分缺失
- **WHEN** 启用了 `paypal`，只配置了 `PAYPAL_CLIENT_ID`
- **THEN** PayPal 不可用，告警列出 `PAYPAL_CLIENT_SECRET` 与 `PAYPAL_WEBHOOK_ID`

#### Scenario: 凭据齐全
- **WHEN** 启用的服务商所需凭据全部存在
- **THEN** 不记录该告警
