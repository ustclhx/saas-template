# Spec Delta

## ADDED Requirements

### Requirement: 结账币种锁定
系统创建的结账 MUST 以平台价格的币种（当前为 USD）向买家扣款，MUST 关闭服务商按买家所在地自动换算币种的功能。收到币种与价格不一致的付款通知时，系统 SHALL 以可区分的错误码记录该通知为失败、不再重试，并发出运营告警供人工处理；MUST NOT 发放积分或权益。

#### Scenario: 海外买家结账
- **WHEN** 一位欧元区买家通过 Stripe 结账购买积分包
- **THEN** 结账页以 USD 计价扣款，付款回调正常入账

#### Scenario: 收到非 USD 付款
- **WHEN** 因平台配置异常收到一笔 EUR 付款通知
- **THEN** 通知被记录为币种不符的失败，不发放积分，运营渠道收到告警
