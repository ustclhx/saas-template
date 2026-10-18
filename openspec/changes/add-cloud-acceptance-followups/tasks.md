# Tasks

## 1. 后台

- [x] 1.1 （原 admin 6.1 剩余）staging 的 Stripe/PayPal 失败回调经后台重放，核对付款与积分不重复入账并保存审计 ID。无自然失败时，按 2026-10-18 用户决定，允许经既有测试入口以已知校验制造可审阅的受控失败，先在 PR 说明方式及账务隔离；需新增代码机制则停止评审。验证：2026-10-18 真实管理员在后台重放受控平台事件 `evt_1URbLcL3UTpBAoXoPo2JjN1L`，attempts 3→4，审计 `01a14d88-cd77-764e-98c9-64b3250f8ffc`；因刻意缺少关联 metadata，结果仍 failed，不冒称恢复 processed。六类业务表计数/摘要及观察空间付款/批次/账本只读快照一致，同快照对账差额 0。证据为 `docs/runbooks/evidence/staging-acceptance/2026-10-18/w3-admin-replay-{before,after}.json`。

## 2. PayPal Provider 录制

- [ ] 2.1 （原 billing 3.3 剩余）用已登录 Sandbox personal 买家会话建立独立月付/年付订阅，录制 Sale 付款、Sale 部分/全额退款及其 GET Refund/交易历史回调；不退款既有 staging 验收付款或待审申请。验证：录制夹具脱敏提交，recorded 测试覆盖新事件，`docs/05-billing.md` 回写事件差异；回调只经自建接收器 + quick tunnel。

## 3. staging 支付矩阵

- [x] 3.1 （原 billing 11.1 剩余，Stripe）对本应用 Checkout 建立的订阅推进账期，核对续费付款与积分批次唯一、对账不变式。按 2026-10-18 协调者指示，可使用已登录 Sandbox CLI/API 的 Test Clocks 替代 Dashboard Simulations；须核对 livemode=false 及 Checkout/订阅/空间/报价关联。验证：2026-10-17 UTC 的 `billing-111-w3-stripe-{month,year}-renewal-{intent,advance,settled,duplicates}.json`：月付 1900、年付 19000 各新增唯一 renewal 付款与首月 1000 积分批次，各两次重投经 staging tail 核实 HTTP 200，前后付款/批次/账本/订阅/退款快照完全一致，同快照对账差额 0。
- [ ] 3.2 （原 billing 11.1 剩余，PayPal 沙箱部分）完成 PayPal 月付/年付订阅、取消/恢复、换套餐重叠期、Sale 退款与重复回调。验证：唯一付款与积分批次、无负余额、同快照对账零差额，证据写入 `docs/runbooks/evidence/staging-acceptance/`。自然时间与真实主体部分按下述移交，不冒称沙箱已验证。

## 移交派生项目（2026-10-18 用户决定）

- PayPal 自然续费：既有订阅 `I-H2LE38AW7EU4` 下一账单时间为 `2026-11-11T10:00:00Z`，须在实际扣款后核对新 Sale、交易历史、不可变账期、唯一 renewal 付款与积分批次、同快照对账。年付自然续费、恢复后真实扣款、取消到期终止及真实年付第 2–12 月 Cron 观察亦由派生项目按实际账期执行；不能用模拟器、DAY Plan、欠款 capture 或隔离库时间夹具替代。
- 真实收款主体与 live 上线：由派生项目确认 Stripe 支持地区/主体或替代收款方案，并配置独立生产资源、价格、凭据、验签 endpoint，完成受控真实付款/退款与对账。执行清单沿用 `docs/05-billing.md` §8；本模板不触碰生产、不把这些事项计为已验收。
- 以上为已获批准的范围移交，不是沙箱任务通过证据。1.1、2.1、3.1、3.2 仅在各自剩余沙箱门槛真实通过后勾选；全部完成并由协调者合并后才归档。
