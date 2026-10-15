# Tasks

## 1. 后台

- [ ] 1.1 （原 admin 6.1 剩余）staging 出现自然失败的 Stripe/PayPal 回调事件后，经后台重放，核对付款与积分不重复入账并保存审计 ID；若决定引入受控失败机制，先单独评审再执行。验证：重放审计 ID、重放前后付款/批次/账本只读快照一致、对账零差额，证据写入 `docs/runbooks/evidence/staging-acceptance/`。

## 2. PayPal Provider 录制

- [ ] 2.1 （原 billing 3.3 剩余）用已登录 Sandbox personal 买家会话建立独立月付/年付订阅，录制 Sale 付款、Sale 部分/全额退款及其 GET Refund/交易历史回调；不退款既有 staging 验收付款或待审申请。验证：录制夹具脱敏提交，recorded 测试覆盖新事件，`docs/05-billing.md` 回写事件差异；回调只经自建接收器 + quick tunnel。

## 3. staging 支付矩阵

- [ ] 3.1 （原 billing 11.1 剩余，Stripe）在 Stripe Dashboard Simulations 对本应用 Checkout 建立的订阅推进账期，核对续费付款与积分批次唯一、对账不变式。验证：billing-111 证据续写。
- [ ] 3.2 （原 billing 11.1 剩余，PayPal）完成 PayPal 月付/年付订阅、取消/恢复、换套餐重叠期、Sale 退款与重复回调；在 2026-11-11 后观察既有订阅自然续费（不用模拟器、DAY Plan 或欠款 capture 代替）。验证：唯一付款与积分批次、无负余额、同快照对账零差额，证据写入 `docs/runbooks/evidence/staging-acceptance/`。
