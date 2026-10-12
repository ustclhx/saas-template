# Proposal

## Why

当前 Web、Jobs 和认证删除步骤直接构造测试支付运行时，Stripe 拒绝 live 密钥且 PayPal 固定 Sandbox，阻碍生产收款。上线前需要显式的环境模式，同时保留正在进行的 PayPal Sandbox 验收行为。

## What Changes

- 新增 Worker var `PAYMENT_MODE=test|live`，本地与 staging 显式为 test；补环境校验、开发模板与生成器 manifest。
- 统一使用 `createPaymentRuntime`，按模式校验 Stripe 密钥并选择 PayPal API，错配和非开发环境缺少模式时关闭支付且记录结构化日志。
- 运行时返回实际模式，后台显示模式；签名 secret、PayPal webhook ID 与所选环境一起配置，禁止自动回退。
- 增加模式矩阵、PayPal URL、Webhook 与入口静态检查，保留原支付测试。
- 更新路线图与生产切换清单；不创建 production 配置、不使用 live 凭据、不改 Sandbox 验收数据和 runbook。

## Capabilities

### New Capabilities

- `payment-mode`: 环境支付模式选择、凭据匹配、入口统一与实际模式展示。

### Modified Capabilities

无。现有 billing 能力仍在未归档的 `add-billing-and-credits` 中，本 change 只新增 payment-mode 能力。

## Impact

影响 packages/config、packages/billing、Web 支付/定价/认证入口、Jobs 支付入口、两端 Wrangler vars、开发变量模板、生成器 manifest、根检查脚本和计费文档。无数据库变更、无新依赖、无部署或凭据操作；staging 仅新增显式 test var。
