# Design

## Context

见 proposal.md。现有 `packages/billing/src/runtime.ts` 根据启用的 provider 返回 providers、normalizers、readiness，缺失凭据只告警且保持离线。PayPal transport 已支持 sandbox/live，OAuth KV key 已含环境；Stripe Provider 未约束已签名事件的 livemode。营销定价页也调用测试工厂，后台 runtime 捕获 EnvValidationError 后降级。

## Goals / Non-Goals

**Goals:** 将环境选择集中于一个工厂，沿用既有 Provider 和离线行为，错误模式绝不执行网络或付款写入。

**Non-Goals:** 不做账户、数据库或价格迁移，不扩展 billing:sync 的 test-only 边界，不升级 SDK，不部署、不操作凭据或 Sandbox 验收资料。

## Decisions

### 1. 显式模式与按入口关闭

`PAYMENT_MODE` 是 Worker var，`packages/config` 提供类型与模式解析；共享 env schema 校验显式值是否合法。缺失时仅 `SENTRY_ENVIRONMENT=development` 回退 test；staging、production、未知环境均拒绝，避免无环境标记的生产部署默认为测试。

选择支付入口 fail closed 而非整站启动失败：营销页/预渲染与认证的现有降级需求不应被支付配置牵连。Web 启动 schema 排除 PAYMENT_MODE，由工厂统一校验；Jobs 启动 schema 校验非法值。工厂在缺失/非法模式或 Stripe 密钥错配时记录 `billing.runtime_invalid`（仅字段名、模式与环境），抛出 `AppError('BILLING_UNAVAILABLE', ..., {status:503})`。Webhook 转为 503，Server Functions 的支付动作保留既有结果格式且设置 HTTP 503；Jobs 抛错供 Queue 重试/Cron 失败。营销页捕获该类错误，所有支付选项 unavailable；不得构造另一模式的 runtime。认证删除步骤延迟到执行删除前才构造支付运行时，普通登录保持可用，删除错误返回 503。

### 2. 统一工厂与凭据契约

`createPaymentRuntime(env, enabled, options)` 替代旧工厂，签名保留 enabled 与 db/cache/fetch/warn 选项，结果新增 `mode: PaymentMode`。test 仍只接受 `sk_test_`，live 接受 `sk_live_` 与 `rk_live_`；部分配置缺失仍按原 readiness unavailable，不自动切换。

PayPal 仅依据模式选择 sandbox/live，以同一环境的 Client ID、Secret 与 webhook ID 初始化 Provider/normalizer。凭据本身没有可离线识别的环境前缀；错配由选定环境 OAuth/验签拒绝，不探测或重试另一环境。现有 KV key 继续分离两种环境。

`STRIPE_WEBHOOK_SECRET` 在 test/live 没有可识别的模式前缀，必须与部署环境的 endpoint 成对提供；Provider 增加可选 expected mode，由工厂注入，验签完成后、任何 normalize/API enrichment 前检查 Stripe event.livemode，避免拿错 endpoint secret 后跨模式入账。后台保存载荷重放也执行同一模式检查。直接 Provider 测试未传模式时维持既有契约。

### 3. 入口与显示

Web webhook、admin/customer/refund Server Functions、auth 删除步骤、marketing pricing、Jobs 均使用新工厂。后台付款页显示 runtime.mode；已有日志加入实际 mode。扫描现有 dashboard links 或 test banner；仅存在测试工具中的 test 描述继续保持，因为工具仍限 test。增加根 `pnpm check` 的静态边界检查，拒绝应用源码或业务源码使用旧工厂。

### 4. 配置与生成器

两端 Wrangler 顶层和 env.staging vars 都增加 `PAYMENT_MODE=test`，不新增 production；开发 `.dev.vars.example` 标明 test，manifest 登记变量。继续只同步五项支付 secret，本地 dev loader 不接管 Worker mode，避免 `.env.local` 或 staging 操作改变 Sandbox 模式。

## Risks / Trade-offs

- [PayPal/Stripe webhook secret 无环境前缀] → 文档列出模式成对配置，Stripe 用已验签 event.livemode 二次验证，PayPal 只请求选定 origin。
- [生产沿用测试价格或数据库] → 上线清单要求独立 live 数据与价格对象；本 change 不迁移已有测试数据。
- [模式错误被降级吞掉] → 仅只读营销页允许不可用降级，所有支付写入口保留 503、日志与无副作用断言。
- [主体未决定] → Q9 保留为上线外部依赖；本次只交付代码能力。

## Migration Plan

先合并配置与工厂及入口，在本地/CI 离线完成回归；staging 由 main 流水线发布，继续 test。生产切换前按 docs/05-billing.md 配置两个 Worker 的 live var 与 live secrets/webhook endpoint、独立 live 价格及数据，完成 Q9 主体决策后再验收。回滚使用上一个已验证部署；不在含 live 账务的数据库上直接切回 test，不混用两套支付对象。
