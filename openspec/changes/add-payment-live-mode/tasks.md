# Tasks

## 1. 环境配置与上线文档

- [x] 1.1 增加 PaymentMode 类型、resolvePaymentMode 与 env schema；仅 development 缺失模式默认 test，其余抛安全错误；通过 config 单元测试验证模式解析与非法值。
- [x] 1.2 两端 Wrangler 顶层与 staging vars、开发变量模板和生成器 manifest 登记 PAYMENT_MODE=test；通过生成器边界测试并检查无 production 配置、无 staging secrets 改动。
- [x] 1.3 docs/05-billing.md 记录 live 切换清单、密钥/签名 secret/webhook ID 成对配置、独立价格数据与 Q9；路线图勾选修补项 2 并链接本 change；检查未修改 PayPal Sandbox 验收 runbook。

## 2. 支付运行时

- [x] 2.1 使用 createPaymentRuntime 返回实际 mode，test/live Stripe 密钥矩阵、PayPal 环境、错误 503 与结构化脱敏日志；扩展现有 runtime 测试覆盖错配无网络请求、缺失模式、PayPal 两种 API 与 webhook ID，运行 billing 测试通过。
- [x] 2.2 工厂注入 Stripe expected mode，在验签与后台重放时拒绝跨模式事件且先于 API enrichment；以离线签名夹具验证两种匹配模式与错配拒绝，运行既有 Stripe 测试通过。

## 3. 应用入口与模式显示

- [x] 3.1 迁移 Web webhook、admin/customer/refund、auth 删除、营销 pricing 及 Jobs；保持支付错误 503 与营销降级，后台显示实际 mode；更新相关现有应用测试，验证 webhook 错配/缺失模式无账务处理与 Jobs 使用新工厂。
- [x] 3.2 新增 pnpm check 静态边界检查禁止旧测试工厂在入口调用（含别名/namespace 用法），验证检查器能够拦截违规入口且当前仓库通过。

## 4. 集成验收与交付

- [x] 4.1 执行 openspec validate --strict、pnpm check、check:deps、check:singletons、typecheck、test、build、dedupe --check 与生成器边界测试，确认全部通过且无 Sandbox 数据/验收文档变化。
- [ ] 4.2 提交中文 commit、fetch/rebase origin/main，复核最终 diff 后推送并创建 main PR（不合并/归档/部署）；PR 列验证与未做 live 外部验收；将 Orca 卡片设为 in-review 并评论支付模式 PR 已开：#号。
