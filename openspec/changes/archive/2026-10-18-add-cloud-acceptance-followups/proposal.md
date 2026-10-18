# Proposal

## Why

Cloudflare 侧功能与 staging 验收已完成，`add-admin-console` 与 `add-billing-and-credits` 只剩依赖外部资源或自然时间的验收项（2026-10-15 用户决定先对 Cloudflare 部分结项）。把这些剩余验收集中到本 change，原 change 归档并同步主 spec，避免功能 change 因资源等待长期不能归档。

## What Changes

- 承接 `add-admin-console` 6.1 剩余：失败回调的后台重放。按 2026-10-18 用户决定，无自然失败事件时允许通过既有测试入口和已知校验制造可审阅的受控失败，先在 PR 说明方式；若需新增代码机制，停止并交评审。受控事件不能冒称自然事件。
- 承接 `add-billing-and-credits` 3.3 剩余：PayPal 订阅 Sale 付款、Sale 部分/全额退款的真实沙箱录制（需已登录 Sandbox 买家会话）。
- 承接 `add-billing-and-credits` 11.1 剩余的沙箱部分：Stripe 续费（Dashboard Simulations 或已登录 Sandbox CLI/API 的 Test Clocks，须关联应用 Checkout）、PayPal 月付/年付订阅、取消恢复、换套餐重叠期、Sale 退款与重复回调矩阵。
- 按 2026-10-18 用户决定，依赖自然时间的 PayPal 月/年续费、恢复后扣款、到期终止与真实 Cron 观察，以及真实收款主体、live 配置与收款验收，移交派生实际项目；不以模拟器、DAY Plan、欠款 capture 或本地时间夹具冒称完成。模板沙箱任务通过且移交说明齐备后，可由协调者归档。
- 已完成部分（Stripe 订阅矩阵、积分包购买、管理员部分退款审核、次日指标、PayPal 积分包 capture 与 8 条回调录制等）的证据保留在原 change 的 tasks.md 与 `docs/runbooks/evidence/` 中，本 change 只引用不重复。
- 不新增或修改任何行为与 spec。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无（`skip_specs: true`，仅承接验收）。

## Impact

- 包含 OpenSpec 任务、脱敏验收证据、PayPal 新录制夹具及 recorded 回归测试和事件差异文档；不修改生产行为、配置或部署。
- 资源需求：PayPal Sandbox 买家会话、后台管理员会话、Stripe Sandbox CLI/API；回调录制仅用本地接收器与 Cloudflare quick tunnel，完成后停止。不得触碰生产或退款既有验收付款、待审申请。
