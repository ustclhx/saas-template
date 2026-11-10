# Design

## Context

动机见 proposal。现有 `createCheckout` 只对 subscription 执行旧订阅切换检查，积分包无需新增购买分支。`customerCatalog` 与公开 `readPricingCatalog` 已带 type、features、价格 interval；营销读取已有构建快照/失败降级。积分 `hold` 在锁内读取可用批次，聊天预算也会提前拒绝；两条路径的错误都缺预计消耗/余额详情。权益当前仅支持固定布尔字段与模型 allowlist。

已完整阅读总体架构、项目结构、计费领域文档及相关主 specs。UI 规格参照 `add-ui-design-system/specs/app-workbench` 与 `marketing-site`，实现其后端合同，视觉仍由该 change 8.6/8.7 负责。

## Goals / Non-Goals

**Goals:** 单一错误合同、可对账的分类余额、现有套餐数据驱动的分组与权益展示、可复用的服务端会员授权。

**Non-Goals:** 重做支付 Provider、积分消费顺序、R3 发放规则、UI 视觉、发布模板版本或执行生产迁移。

## Decisions

### D1 错误合同与边界

共享模块导出 `INSUFFICIENT_CREDITS`、错误构造及纯客户端解析函数。合同为 `{ error: { code, message, details: { estimatedCredits, availableCredits } } }`，HTTP 402。通用 hold 在锁内以所有可用批次总和构造 AppError；保留 CreditsError 的兼容身份或等价的现有 code 判断。聊天预算用同一构造器，在预检与竞争失败均提供正确数值；媒体预扣同步适配。

AppError 通过通用 publicDetails 显式声明可公开字段，内部 details 不外发。余额不足构造器验证并复制两个整数到 publicDetails，解析器继续校验数值。CreditsError 保留继承，余额不足与欠费为 HTTP 402，其余积分错误为 500；toErrorResponse 对所有 status >= 500 的错误统一输出 INTERNAL_ERROR，日志与 Sentry 保留内部诊断。解析器接受公共错误对象以及聊天 SDK 的 JSON message，拒绝不完整、非法或其他 code。最小页面引导通过两个入口传数值，后续可替换为 UI 8.6 纯展示组件，不增加第二套共享视觉组件。

替代方案：只在 web 映射 CreditsError 会遗漏衍生项目的直接 hold；普遍序列化所有 details 会扩大公开合同。

### D2 定价分组与权益

新增纯数据 helper，保留现有目录字段和公开快照结构，输出 subscriptions（含 month/year 价格）及 creditPacks。营销 PricingPlan 保留完整 features，并从已存在的数值/布尔权益派生可本地化清单，不添加 schema 字段。月付/年付选择只筛选订阅价格；积分包始终提供。具体卡片布局交给 UI 8.7，必要的列表和文案为最小接线。

替代方案：硬编码会员权益会与后台模型授权漂移；增加专用表或物理列没有当前需求。

### D3 账单摘要

扩展现有鉴权 `getCustomerBilling` 返回 `summary`。余额查询在同一快照按来源统计，复用 active、expires_at 和 remaining 的定义，输出 available、subscription.total/currentPeriod、purchase、free.signup/daily/total 和 other。默认时钟使用数据库 now()，与余额和预扣查询一致。daily 按来源文本归类，不提前修改 R3 的 schema 或发放逻辑。

“本月”采用付款周期锚点对应的当前月度批次，而非 UTC 自然月或 grant.created_at。依据现有 `{paymentId}:{n}` 与付款 period_start/end 判定月付/年付当前发放窗口；旧宽限/结转批次仍计入 subscription.total，但不计入 subscription.currentPeriod。失效、撤销、预扣占用不计入任何可用分类，other 保证分类与 available 对账。

当前订阅与 getEntitlements 共用导出的 isSubscriptionEffective 生效规则取最高套餐，通过单独的状态/周期条件查询读取候选项；历史列表在数据库侧 limit(50)，在重叠期保留历史记录。nextRenewalAt 仅来自仍会续费的当前订阅，取消/过期无下一续费。owner/admin 获得摘要；member 保留既有余额不可见约束。积分包购买继续使用现有 owner checkout，不受订阅存在影响。

### D4 自定义权益

在 PlanFeatures JSON 类型增加可选 `capabilities: Record<string, boolean>`；`can` 保留所有内置键行为并对其他键仅接受 capabilities[key] === true。requireEntitlement 接受同样的自定义键并保持 403 UPGRADE_REQUIRED。只通过当前最高生效订阅/free plan 授权，不依据积分余额或套餐名。文档给出中性功能 `exports.advanced` 的服务端中间件与前端锁定判定示例。

替代方案：顶层任意 JSON 键将与数字限额/保留键混淆；类型声明能力注册框架超过当前需要。

### D5 验证与交接

扩展真实 Stripe 录制映射和隔离 Postgres 测试，覆盖同一空间订阅后买包、重复事件、两类来源可用及权益保持。真实测试模式购买需要 sk_test、对应 webhook secret、已同步的两类价格和可达回调地址，任务独立保留未完成，不用离线测试声称真实验收。

升级草稿写入本 change `upgrade-notes.md`：合同、字段、扩展示例、UI 接口、无 SQL 变化与待办凭据。协调者在发版时移入带版本的 docs/upgrades。验收日志写入忽略的 EVIDENCE_DIR；主仓库仅放引用。

## Risks / Trade-offs

- [旧调用方依赖 CreditsError 身份] → 保留兼容并回归现有核心测试。
- [月底锚点、年付和 rollover 导致“本月”误统计] → 使用既有 UTC 月锚点算法，增加相关 PG 用例并保留全部可用订阅余额。
- [R3 尚未合并] → 查询按 source 文本识别 daily，不提前添加来源写入，合并后协调者验证 daily 实际发放。
- [视觉并行冲突] → 新 helper 与小接线为主，不修改 UI change 的任务或组件。

## Migration Plan

预计仅有 JSON TypeScript 类型的兼容扩展，无物理 schema 变化，无迁移 SQL。旧 features 无 capabilities 时按空字典解释。若确需物理 schema，按用户指示 drizzle-kit push 到本 worktree 库并在 PR 声明，由协调者统一生成迁移。回滚代码即可，已有订阅、购买与积分账本不变。
