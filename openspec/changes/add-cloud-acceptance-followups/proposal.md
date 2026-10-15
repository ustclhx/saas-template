# Proposal

## Why

Cloudflare 侧功能与 staging 验收已完成，`add-admin-console` 与 `add-billing-and-credits` 只剩依赖外部资源或自然时间的验收项（2026-10-15 用户决定先对 Cloudflare 部分结项）。把这些剩余验收集中到本 change，原 change 归档并同步主 spec，避免功能 change 因资源等待长期不能归档。

## What Changes

- 承接 `add-admin-console` 6.1 剩余：失败回调的后台重放（staging 目前没有失败事件，不伪造失败）。
- 承接 `add-billing-and-credits` 3.3 剩余：PayPal 订阅 Sale 付款、Sale 部分/全额退款的真实沙箱录制（需已登录 Sandbox 买家会话）。
- 承接 `add-billing-and-credits` 11.1 剩余：Stripe 续费（Dashboard Simulations）、PayPal 月付/年付订阅、自然续费（既有订阅 2026-11-11）、取消恢复、换套餐重叠期、Sale 退款与重复回调矩阵。
- 已完成部分（Stripe 订阅矩阵、积分包购买、管理员部分退款审核、次日指标、PayPal 积分包 capture 与 8 条回调录制等）的证据保留在原 change 的 tasks.md 与 `docs/runbooks/evidence/` 中，本 change 只引用不重复。
- 不新增或修改任何行为与 spec。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

无（`skip_specs: true`，仅承接验收）。

## Impact

- 仅 OpenSpec 任务与验收证据；不改代码、配置或部署。
- 资源需求：PayPal Sandbox 买家会话、Stripe Dashboard 登录（Simulations）、一条自然发生的失败回调或经评审的受控失败机制、自然续费日期。
