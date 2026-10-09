# P2 Stripe 真实联通验收

> 进行中。本文记录通过项、真实失败与尚未完成的门槛；当前不勾选 OpenSpec 3.2、11.1 或 10.4。

## 环境与证据口径

- 验收日期：2026-10-09 UTC；目标 `https://web-staging.saas-jobs.workers.dev`。
- 初始健康版本：`3220611c66c644ed83d97c5c2b9921ac4c111195`；`status=ok`、`db.status=up`，jobs Cron 心跳推进。
- Stripe Sandbox account：`acct_1UMwpCL3UTpBAoXo`；endpoint：`we_1UO7wML3UTpBAoXo3N6XlJhF`；所有录制事件 `livemode=false`。
- 代码及真实 endpoint snapshot 版本：`2026-09-30.endive`，SDK `stripe@23.0.0`。账号 Events GET 返回 `2026-08-26.dahlia`，即使请求使用 endive；因此没有把 Events GET 的版本字段改写成 webhook 版本。
- 账务核对只使用 Neon staging readonly 角色；购买、取消与退款通过应用或 Stripe 测试平台产生，未直接写 staging 数据库。密钥通过指定环境文件加载，未保存在夹具、日志或 PR。

录制夹具位于 `packages/billing/src/stripe/fixtures/recorded/`，来源和摘要见 `provenance.json`。区分三种证据：

1. staging 已验签后存储的 JSONB：保留真实 endive event 形状；摘要是 PostgreSQL JSONB 导出的规范正文摘要，不能作为原 HTTP 字节摘要。
2. Stripe CLI `--latest` 的真实签名本地镜像：在内存中使用该 listener secret 验签并计算原正文、签名摘要；仅保存脱敏正文。它与 staging endpoint 分别接收同一平台事件，不能把本地镜像签名称为 staging 签名。
3. 认证 Stripe API GET：保留查询参数、版本、采集时间及原响应摘要；用于离线重放 invoice payments、PaymentIntent、历史 invoice 和 Checkout 的关联，不作为回调原文。

脱敏会改变正文，录制测试中的离线签名使用测试专用 secret 重新生成；不声称它是 Stripe 原始签名。原始正文含联系方式及带 token 的 URL，未落盘。夹具仍保留对象 ID、金额、USD 币种、业务 metadata、历史周期和退款身份。

可审阅的只读账务快照保存在 [evidence/p2-stripe](./evidence/p2-stripe/)，包含年付首付、积分包、申请 pending、Portal 返回、取消失败后的真实状态、平台退款遗漏及首付两次重投前后比较；仅导出白名单字段。原始 SQL 使用 runbook §6 的对账口径，`monthly-initial-resend-comparison.json` 汇总前后相等结果；平台 HTTP 200 来自 Workbench 独立核对，CLI 接受请求本身不证明目标端点返回 200。

## 已通过与发现的问题

| 场景 | 真实结果 | 账务与证据 |
| --- | --- | --- |
| Pro 月付首付 | 已通过，原有真实 Checkout e2e 1 passed | workspace `01a11fa8-08da-71f1-9c8d-a0ab10568800`；invoice `in_1UOYdeL3UTpBAoXoBFsFpO0W` → PaymentIntent `pi_3UOYdfL3UTpBAoXo1TssRKHa`；1900 USD 最小单位，首月 1000 积分；event `evt_1UOYdhL3UTpBAoXoDzgAEbGZ` processed。 |
| Pro 年付首付 | 已通过，新真实 e2e | workspace `01a11fac-af11-72da-ad52-0869ceb1c9c9`；PaymentIntent `pi_3UOYieL3UTpBAoXo13iyAy3V`；19000 USD 最小单位，仅发首月 1000 积分；invoice event `evt_1UOYihL3UTpBAoXoPA5QUWq3` processed；对账成立、无负批次。 |
| 积分包付款 | 已通过 | workspace `01a11fad-54ef-74b1-bb49-26232712dfa4`；PaymentIntent `pi_3UOYjIL3UTpBAoXo1gvunegg`；1000 USD 最小单位，purchase paid，1000 积分；`evt_1UOYjKL3UTpBAoXo6nn8x7at` processed。退款申请步骤仍待重验。 |
| 月付 Test Clock 续费 | 平台成功，应用失败，待修复发布后重验 | clock `clock_1UOYeQL3UTpBAoXoq2VlSbJ7`；invoice `in_1UOYeuL3UTpBAoXoFow1TDQx` → PaymentIntent `pi_3UOYf0L3UTpBAoXo0tcelvaV`；`evt_1UOYf4L3UTpBAoXoqVeBpjfd` 两次实际投递 500，`Subscription grant month is not due`。事务未产生续费付款或积分；修复 PR [#67](https://github.com/ustclhx/saas-template/pull/67)，回归测试先红后绿。 |
| 用户申请退款 | 已通过，退款申请为 pending | workspace `01a11fbe-9660-75a3-8bcd-8a217b9a626c`；退款表单等待父页面已就绪控件后提交成功（47.7 秒）；付款、积分和 ledger 与提交前相同；尚未执行管理员审核。 |
| Customer Portal | 已通过，打开并返回应用 | workspace `01a11fc0-e265-74aa-b17a-cd6058f2fd49`；配置为测试模式 default Portal，启用发票历史、付款方式更新和周期末取消；实际打开 Portal 再返回账单页（50.1 秒），账务不变。 |
| 平台部分退款 | 平台成功，应用遗漏，待修复发布 | refund `re_3UOYjIL3UTpBAoXo1qqwZkZA`，400 USD 最小单位；`evt_3UOYjIL3UTpBAoXo1KA14f1c` 真实 endive `charge.refunded` 不含 `refunds`，被标为 ignored；08:07:29 UTC 只读核对仍无退款记录或积分撤销。修复 PR [#70](https://github.com/ustclhx/saas-template/pull/70) 通过 34 条定向测试，缺失/截断时认证分页并按退款身份累计；待 main 发布后重验。 |
| 取消/恢复 | 原用例串行重验通过（56.5 秒） | 先前 08:20:56.735 UTC 操作成功但 5 秒内 Resume 不存在；未改变生产代码、刷新页面或放宽断言，本轮取消 true、恢复 false，原付款周期、积分批次、ledger 均保持不变。两次带诊断 wrapper 的取消 probe 也通过，但 wrapper 会改变时序，不能据此认定原失败原因；普通原用例的重验才计为通过。恢复后的 Test Clock 续费仍待执行。 |
| 升级/降级预约 | 已通过（约 1 分钟），周期末实际降级尚待验证 | workspace `01a11fcd-0b52-75db-bad6-3276f1fa0918`，Pro 首付 1900；升级 Team 后 `pi_3UOZH2L3UTpBAoXo04TeSJAo` 为 adjustment / succeeded / 3000 USD 最小单位，Team 权益立即显示，仍只有初付的 1000 积分，ledger 不增加。降级 schedule `sub_sched_1UOZHFL3UTpBAoXoNT1sOZA4` 保留当前 Team，第二阶段在 `1794213309` 切换 Pro；两阶段 proration none、end_behavior release；当前付款/积分/ledger 不变。 |
| 换套餐重叠期 | 单场景重验通过（约 1.1 分钟） | Pro 周期末取消后新购买 Team，两个订阅均保留已付周期，Pro cancel true、Team cancel false；仅 Team 会续费，当前权益 Team，两个真实初付分别发 1000、5000 积分，余额/ledger=6000、held=debt=0。此前矩阵在初始 Checkout 前停于 `Something went wrong!`；保留失败及 CPU 超限证据，重验未改变断言。 |
| 首付重复投递 | 已通过，平台两次 HTTP 200，账务不变 | `evt_1UOYdhL3UTpBAoXoDzgAEbGZ` 两次 CLI resend 被平台接受；Workbench 显示 08:20:05、08:20:06 UTC 两次手动重试均 200 OK，原投递为 07:54:52 UTC 200 OK。08:23:20 UTC 只读核对前后付款、订阅、退款、grant、ledger 完全相同；ledger=expected=1000，负批次 0。 |

## 平台时钟与应用时间

月付测试客户创建 Test Clock 后，从 `1791532535` 推进到 `1794218086`。平台续费周期为 `2026-11-09T07:54:46Z` 至 `2026-12-09T07:54:46Z`；付款时间为 `2026-11-09T08:54:46Z`，event 实际创建及 HTTP 投递仍发生于 2026-10-09 UTC。应用 `Date`、PostgreSQL `now()` 和 Cron 没有推进。年付独立客户已创建 clock `clock_1UOYzzL3UTpBAoXoMAu8qO78`，初始 frozen time `1791533871`；尚未推进年续费。

PR #67 允许已验证成功付款发放其首月积分，年付后续月仍由应用时间判断是否到期。平台年续费不等于应用第 2–12 月发放、积分批次过期或取消到期已完成。这些门槛保持待验证，需协调者安排隔离环境受控时间验证或等待真实到期。

## 剩余门槛

- 等待 #67 合并与 main 自动发布，健康 `version` 匹配完整 merge SHA 后重验月付续费；年付 Test Clock 续费尚未执行。
- 新版退款缺少内嵌列表的修复、录制回归及 staging 重验；平台全额退款、管理员审核部分退款仍待完成。
- 用户退款申请 pending、Customer Portal 返回、取消/恢复、升级立即生效且不补发积分、降级 schedule、换套餐重叠期已通过；恢复后续费、实际周期末降级、取消到期与积分过期仍待验证。
- 首付、续费与退款同一 event 各重复投递至少两次，保存投递状态及前后相同的付款、refund、grant、ledger 证据。
- 每个通过场景核对 runbook §6：ledger 总额等于 active grant remaining 加 held 减 debt；无负余额、无重复付款/批次/退款；到期受控验证的性质需明确标注。
- 完成根目录检查后提交验收 PR；只有 3.2 全部门槛满足才勾选，11.1 和 10.4 由协调者汇总结项。

## 修复集成检查

退款修复与首月修复在本 worktree 集成后，`pnpm check`、`pnpm check:deps`、`pnpm check:singletons`、`pnpm dedupe --check`、`pnpm typecheck`、`pnpm test`、`pnpm build` 均退出 0。类型检查 13/13、测试任务 22/22（billing 256 tests）、构建 2/2；独立退款小分支另通过 `pnpm check`。这些是代码验证，不能替代尚未完成的线上验收。

## 平台资源限制

2026-10-09 08:33:46.660 UTC、08:34:16.536 UTC，任务内只读 `wrangler tail --env staging --status error` 捕获 `web-staging` 的 `outcome=exceededCpu`，CPU 为 66ms、10ms，wall time 为 1527ms、100ms；请求路径由平台显示为 `/_serverFn/REDACTED`。这证明该轮是 CPU 超限，不能推定早先每个失败均为同一原因。

Cloudflare 当前账号 Workers Plans 页面明确显示「免费」为当前套餐，每请求最多 10ms CPU；[官方 CPU 限制说明](https://developers.cloudflare.com/workers/platform/limits/) 与此一致。任务规范要求任何付费或绑卡交给用户，因此未升级计划或修改计费；需用户处理 Workers Paid，或协调者安排有证据的 CPU 优化后复验。没有通过减少业务断言、模拟平台回调或手动部署规避限制。
