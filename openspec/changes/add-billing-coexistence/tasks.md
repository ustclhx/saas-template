# Tasks

## 1. 统一余额不足合同

- [x] 1.1 在 shared 定义安全的余额不足 AppError 合同与客户端解析器，通用 hold、聊天预算与媒体预扣统一数值详情；shared/credits/ai/web 相关错误与 PG 并发测试通过，并写合同说明
- [x] 1.2 聊天接入可复用解析器与最小余额不足引导（预计消耗、余额、积分包与订阅入口），保留已有错误提示；聊天组件/HTTP 测试通过，UI 8.6 视觉替换接口可用

## 2. 共存定价与账单

- [x] 2.1 提供套餐类型分组、订阅周期价格与 features 派生权益清单，公开快照降级保持，最小定价接线及单元测试通过，文档注明 UI 8.7 接口
- [x] 2.2 提供租户隔离账单摘要和最小页面接线，覆盖当前订阅/续费、当前月度与全部可用订阅积分、积分包、signup/daily 免费积分与其他来源；PG 测试覆盖预扣、过期、年付锚点/结转与跨空间隔离，member 权限测试通过

## 3. 自定义会员权益

- [x] 3.1 扩展 PlanFeatures JSON 和 can/requireEntitlement 支持自定义功能键，未知键拒绝；补服务端会员功能与 UI 锁定态使用文档，权益单元与鉴权集成测试通过

## 4. 购买回归与升级交接

- [x] 4.1 Stripe 离线/PG 测试覆盖同空间订阅后追加积分包、重复回调仅入账一次、订阅和权益保持；相关 billing 测试通过
- [x] 4.2 change 内交付 upgrade-notes.md 草稿，说明合同、UI 数据、无物理 schema 变化（如有则说明仅本库 push）、R3 合并核验和所需 Stripe 凭据；人工核对文档与导出接口一致
- [ ] 4.3 使用真实 Stripe 测试模式完成订阅与积分包购买并核对入账，证据存私有证据库；需要测试密钥、Webhook secret、已同步两类价格和可达回调，未执行时保持未勾选

## 5. 集成验收与交付

- [x] 5.1 pnpm check、pnpm typecheck、pnpm check:deps、pnpm check:singletons 和相关包 pnpm test（含本 worktree Postgres 集成）全部通过，OpenSpec strict validate 通过，日志写入 EVIDENCE_DIR
- [x] 5.2 提交实现、推送当前分支并开 main PR（不合并），PR 写明验证结果、未完成验收、schema 情况及协调事项，Orca 状态更新 in-review
