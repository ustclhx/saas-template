# P2 支付联通与 staging 验收

基线：PR #24 / `458fafdef81cf30cc41516eec15fc4d1e7122725`，核对日期 2026-10-05。P2 离线验收为 28/34；本文件是操作说明，不是支付实测报告。1.3、3.2、3.3、10.1、10.4、11.1 在证据完整前保持未完成；离线结果见 [p2-offline-acceptance.md](./p2-offline-acceptance.md)。

## 1. 当前准备状态与责任边界

协调者在 2026-10-05 汇报：staging 已应用 0002–0007（累计 8 条迁移），seed 为 4 套餐、10 报价且全部 inactive；`events-staging` 已有 1 producer / 1 consumer。发布版本：jobs `91bdd92a-1ffd-4fc8-9672-ecec303045f0`，web `6c9cf30a-05fa-4e28-8ab4-976424fee830`；健康检查、定价页和未配置支付时 503 已核验。本文件编写者没有重复部署、迁移或访问支付 API；尚无支付凭据、价格同步或真实支付证据。

后续由具备授权的操作者配置账号、秘密和平台对象，由 supervisor 记录实际版本及验收结果。staging 数据库仍在本机 PG，经 Tunnel / Workers VPC / Hyperdrive 接入；保持本机和 cloudflared 在线，计费读写使用不缓存的 `HYPERDRIVE`。无需重新执行已完成迁移；资源或代码变化后的部署顺序仍是 jobs → web。见 [基础设施](../07-infrastructure.md)。

人类需准备：Stripe 同一测试环境的 secret key、Webhook endpoint signing secret、Portal 配置权限；PayPal 同一 sandbox REST App 的 Client ID、Client Secret、Webhook ID，以及不同的 business 卖家 / personal 买家测试账号；Cloudflare 两 Worker staging 的 secrets 配置权限；目标 staging 的 app 账号数据库连接、owner 测试用户和平台 admin。仅汇报准备状态和非敏感对象 ID，不把秘密、数据库密码或买家密码贴进聊天、Git、日志或 shell 命令参数。

## 2. 凭据名称与配置

| 用途 | 必须使用的变量 | 来源 / 约束 |
|---|---|---|
| web、jobs 运行时 | `STRIPE_SECRET_KEY` | 测试环境密钥，代码拒绝非 `sk_test_` 前缀 |
| web、jobs 运行时 | `STRIPE_WEBHOOK_SECRET` | staging Stripe endpoint 的 `whsec_…`；不是 CLI 本地 listener secret |
| web、jobs 运行时 | `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET` | sandbox REST App；工厂固定 sandbox |
| web、jobs 运行时 | `PAYPAL_WEBHOOK_ID` | 同一 App、同一 staging URL 的已注册 Webhook ID，不是事件 ID |
| 本机 sync CLI | `BILLING_SYNC_MODE=test`、`STRIPE_SECRET_KEY` | 测试开关与同一 Stripe 测试环境的 secret key |
| 本机 sync CLI | `PAYPAL_CLIENT_ID`、`PAYPAL_CLIENT_SECRET` | 同一 PayPal sandbox App；CLI 不要求 Webhook ID |
| 本机 seed / sync CLI | `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` | 直连目标 staging 的 **app** DML 连接，不能误用本 worktree 开发库或生产库 |

运行时和 CLI 共用同一套支付变量名。在仓库根目录复制模板后，只在本地文件填入真值：

```sh
cp .env.example .env.local
chmod 600 .env.local
```

根目录 [.env.example](../../.env.example) 只含键和空占位符；`.env.local` 已被 `.gitignore` 忽略。填写五个支付变量，保留 `BILLING_SYNC_MODE=test`。无需 Stripe publishable key：当前结账使用服务端创建的托管 Checkout。PayPal 买家密码只用于沙箱登录，不填入 Worker 配置。Webhook secret / ID 必须对应实际接收 URL：本地 Stripe CLI listener 的 secret 与 staging endpoint 的 secret 不能混用。

`pnpm billing:seed`、`pnpm billing:sync` 自动读取根目录 `.env.local`，进程环境优先；数据库连接未填写时回退到 `.env.worktree`。同步 staging 前必须明确填写或注入目标 staging 的 app 连接，核对库名后再执行。每个 Orca worktree 单独创建自己的 `.env.local`；该文件不通过 `.worktreeinclude` 自动复制，避免把 staging 数据库连接带入开发分支。数据库和端口继续由 `.env.worktree` 隔离。

`pnpm --filter @saas/web dev` 与 `pnpm --filter @saas/jobs dev` 启动时，将五个支付变量写入对应 app 已忽略的 `.dev.vars` 管理区块，供 Cloudflare 本地运行时读取；原有认证配置保留。只需维护根目录 `.env.local`，不需要手动重复填写两个 app。进程环境覆盖本地文件；留空会清除旧的管理区块值，删除 `.env.local` 且未显式设置任何支付进程变量时，再次启动会移除该区块。构建/部署不执行此同步，也不会自动上传本地凭据。OAuth mock 与邮件 log 设置保持原配置。

两 Worker 都调用 `createTestPaymentRuntime`；PayPal 还要求 `CACHE` KV。`docs/07` 中的通用 `PAYPAL_ENV` 不控制当前 P2 工厂，设置 live 不会使其变为 live。staging 仍使用下面的 Cloudflare secrets 配置入口。

离线 Playwright 的 dev 子进程把五项支付变量设为空，并强制启动独立服务；不会复用先前启用真实凭据的 Worker。测试父进程仍不得注入支付凭据。该套离线测试不能用于声明真实支付端到端通过。

构建/部署不调用 dotenv 同步；但 Cloudflare Vite 插件会把 app 已有 `.dev.vars` 复制到 SSR 构建目录，供 `vite preview` 读取构建时快照。此文件被 Git 和前端资源忽略；不要把整个 `dist` 当作不含密钥的可分享产物。修改根 `.env.local` 后应重启 dev；只修改根文件不会更新既有 preview 快照。

由操作者在 Cloudflare Dashboard 分别选择 `web-staging`、`jobs-staging` → Settings → Variables and Secrets，按上表录入五个运行时名字。也可从对应 app 目录逐项执行交互式命令（值在提示中输入，不拼进命令）；例如在 `apps/web` 和 `apps/jobs` 各执行一次：

```sh
pnpm exec wrangler secret put STRIPE_SECRET_KEY --env staging
pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET --env staging
pnpm exec wrangler secret put PAYPAL_CLIENT_ID --env staging
pnpm exec wrangler secret put PAYPAL_CLIENT_SECRET --env staging
pnpm exec wrangler secret put PAYPAL_WEBHOOK_ID --env staging
```

Cloudflare secrets 按环境配置，不应假设从顶层继承；`secret put` 会更新已部署 Worker，纳入发布记录。需要资源/代码发布时使用现有 `pnpm --filter @saas/jobs deploy:staging`、`pnpm --filter @saas/web deploy:staging`。不要打印 secret 内容验证配置。官方依据：[Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

Stripe 账号应选择专用 sandbox / 测试模式，密钥、事件 destination、价格、客户和 Portal 配置保持在同一测试环境。用 sandbox 买家登录 PayPal，不用真实钱包；账号与 App 准备见 [PayPal sandbox](https://developer.paypal.com/sandbox-testing/overview)。

## 3. 平台 Webhook

### Stripe

在测试环境 Workbench / Webhooks 创建 HTTPS destination：

`https://web-staging.saas-jobs.workers.dev/api/billing/webhooks/stripe`

选择当前账号的 **snapshot** 事件，API 版本必须为代码锁定的 `2026-09-30.endive`（SDK `stripe@23.0.0`）。此版本是否可在实际账号选择尚待核对；不可选时记录界面/版本差异并交 supervisor 处理，不直接改代码锁定或升级全账号。SDK 请求版本不等于 destination 版本；代码对收到的 `event.api_version` 严格相等校验，版本不匹配会 500，且可能在登记前失败。

按 `normalizeStripeEvent` 配置这些事件：

```text
checkout.session.completed
checkout.session.async_payment_succeeded
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
charge.refunded
charge.dispute.created
```

复制该 endpoint 的 signing secret 到运行时，完成一笔真实测试卡交易后检查投递状态、HTTP 200 和数据库 `processed`，同时核对实际 `api_version`。原始请求体与 `Stripe-Signature` 用于 Web Crypto 验签，不能先重排 JSON。Stripe 官方说明版本、重复事件及重投规则见 [Webhooks](https://docs.stripe.com/webhooks)。另在同一测试环境启用 Customer Portal，账单页打开门户并返回应用也须实测。

### PayPal

在 Developer Dashboard → Apps & Credentials → **Sandbox** → 当前 REST App 下创建 Webhook：

`https://web-staging.saas-jobs.workers.dev/api/billing/webhooks/paypal`

保存该 URL 的 Webhook ID，并选择代码支持的事件：

```text
CHECKOUT.ORDER.APPROVED
BILLING.SUBSCRIPTION.ACTIVATED
BILLING.SUBSCRIPTION.UPDATED
BILLING.SUBSCRIPTION.CANCELLED
BILLING.SUBSCRIPTION.EXPIRED
BILLING.SUBSCRIPTION.SUSPENDED
BILLING.SUBSCRIPTION.PAYMENT.FAILED
PAYMENT.SALE.COMPLETED
PAYMENT.CAPTURE.COMPLETED
PAYMENT.SALE.REFUNDED
PAYMENT.CAPTURE.REFUNDED
CUSTOMER.DISPUTE.CREATED
```

官方 [事件目录](https://developer.paypal.com/api/rest/webhooks/event-names/) 仍列出订阅 Sale 完成/退款事件，但不能由此认定当前 App 与适配器字段完全匹配。当前实现将五个 `paypal-*` transmission headers、Webhook ID 与事件回传 `/v1/notifications/verify-webhook-signature`，必须返回 `SUCCESS`；订阅首付/续费还会读取 Sale、订阅交易历史及 Plan 来证明付款身份和周期。官方 [Webhook 集成](https://developer.paypal.com/api/rest/webhooks/rest/) 明确：模拟器事件不支持该回传验签方式。因此必须由当前 App 的 sandbox 交易产生回调，模拟器成功/失败都不能代替 3.3 验收。

特别核对订阅路径使用的 `/v1/payments/sale/{id}`、Sale refund 和 `/v1/payments/refund/{id}`：官方 [Payments v1](https://developer.paypal.com/api/deprecated/payments/v1) 已标记弃用，当前账号能否读取/退款须实际验证。如接口拒绝或真实字段、历史分页、时间锚点无法证明周期，应保存失败证据并修复后重测；不要改成猜测 payment ID、伪造历史或以 Capture ID 代替 Sale ID。

### HTTP 判定

未知 provider 404；未配置 provider 503；非法 JSON / 验签失败 400；超过 1 MiB 413；业务、远端请求或数据库失败 500。已提交付款即使队列发送失败仍返回 200，由 jobs 恢复通知。200 只说明接收成功：不支持的事件可以 `ignored`，必须同时检查事件和付款/积分记录。当前处理包含同步远端读取和事务，不是收到即异步入账；记录实际延迟和平台重试，勿把超时当作一定未付款。

## 4. 价格同步与幂等复验（1.3）

先用已授权的连接核对 `current_database()` / `current_user` 是目标 staging / app，并保存原报价快照。以下命令在仓库根目录执行，前提是上述 CLI 变量已在根目录 `.env.local` 配置，或通过安全方式注入进程环境；本 runbook 没有执行它们：

```sh
# 当前 staging 已 seed；仅重建验收库时才需这一条。
pnpm billing:seed
BILLING_SYNC_MODE=test pnpm billing:sync
BILLING_SYNC_MODE=test pnpm billing:sync
```

seed 会 upsert 示例套餐，不能当成不会覆盖配置的只读操作。默认 USD 最小货币单位：Pro 月 1900 / 年 19000、每月 1000 积分；Team 月 4900 / 年 49000、每月 5000 积分；积分包 1000、1000 积分、365 天；free 没有远端价格。

预期每次 sync 报 10 个映射，本地有效报价不再 `unsynced:*`。Stripe 5 个 Price；PayPal 4 个 recurring Plan/Product 映射，积分包是本地 `paypal:credit_pack:{plan_price.id}` 标识，按金额创建 Order，**不会出现 PayPal 积分包 Plan**。第二次成功执行前后本地 ID、远端 ID、金额/币种/周期以及远端对象数量不变，保存两轮快照。平台幂等请求保留时间不能代替本地持久化映射；远端创建成功但本地保存失败时，先人工对账，不删库映射盲目重跑。

## 5. 真实验收顺序

每个场景使用明确的 workspace / 用户 / provider，记录 UTC 起止时间。先做两平台月付、年付、积分包各一笔；取消、退款、换套餐使用独立订阅，避免污染后续续费。页面路径：`/pricing`、`/app/$slug/billing-return`、`/app/$slug/billing`、`/app/$slug/usage`、`/admin/billing`、`/admin/billing/refunds`。

| 场景 | 操作与通过标准 |
|---|---|
| 首付与回跳 | owner 从定价页选平台/报价并完成批准；Stripe 使用官方测试卡 `4242 4242 4242 4242`、未来有效期、任意合法 CVC，见 [测试支付](https://docs.stripe.com/testing)。保留平台交易与浏览器回跳证据。订阅 checkout/activation 只关联，首付付款才发一份积分；年付只发首月，不一次发 12 倍。付款具备不可变报价和周期快照。 |
| 积分包 | 两平台购买；Stripe `payment_intent` 与 PayPal Capture ID 正确关联。PayPal 返回页执行 Orders capture，刷新返回页与重复回调不重复入账；只批准未 capture 不能记付款或发积分。capture 与 callback 两种先后顺序如未真实观测，保留离线证据并标注缺少真实顺序覆盖。 |
| 月付/年付续费 | 见下文时间约束；新付款 ID、`kind=renewal`、正确 workspace 和服务周期，订阅周期推进，只新增对应付款的一个首月批次。不能根据回调到达顺序判断 PayPal initial / renewal。 |
| 取消与恢复 | Stripe 账单页周期末取消应远端 `cancel_at_period_end=true`；到期前恢复为 false，再观测一次续费。PayPal 周期末取消实为远端 **SUSPENDED**、本地 `canceled + cancel_at_period_end=true`，已付周期内仍有权益；SUSPENDED 回调与每日对账不能变成本地 paused 而丢权益。到期前恢复调用 activate，远端 ACTIVE、本地 active/false；恢复后扣款及交易历史连续性必须实测。已有另一会续费订阅时恢复应被拒绝。 |
| 终止 | 另一个取消订阅到周期末后失去付费权益、停止收款；PayPal 每日对账最终 cancel。已终止订阅不能按“恢复”重启。取消不自动退款。 |
| 换套餐/换平台 | Stripe 升级立即生效，补差 `adjustment` 记录付款但不补发积分；降级由 schedule 在周期末生效。PayPal 同平台换套餐、跨平台更换先取消旧、再付新；旧订阅保留已付期，至多一条会续费，重叠权益取较高套餐，两个真实付款各自发积分。 |
| 退款申请与平台退款 | 用户申请、admin 部分审核，分别验证 Stripe、PayPal Capture 与 PayPal Sale 退款路径；另取付款做平台侧全额退款。审核/API 响应不能代替回调最终入账，见下一节。 |
| 重复/迟到回调 | 同一首付、续费、退款平台事件分别重投至少两次；记录每次状态。付款、退款身份、批次和流水不能增量重复；新旧事件 ID 与相同业务对象的重复也须按业务幂等处理。旧状态回调不能回退较新状态。 |

### 续费与时间约束

Stripe 当前官方把 Test Clocks 呈现为 **Simulations**。先由本应用 Checkout 建立订阅与本地关联，再在测试 Dashboard 选择该订阅 → Run simulation → Advance time，推进至下一账期并等 simulation 完成与真实签名回调。每次推进遵守官方最多两周期规则；若账号界面或客户不符合条件，记录原因，由 supervisor 安排支持的 clock customer/订阅测试方式并确保绑定真实 workspace/报价，不能把无关联的 Dashboard 订阅当本应用端到端成功。见 [Simulations](https://docs.stripe.com/billing/testing/test-clocks)、[模拟订阅步骤](https://docs.stripe.com/billing/testing/test-clocks/simulate-subscriptions)。

Stripe 时钟只推进平台对象；应用的 `new Date()`、PG `now()`、jobs hourly/daily Cron 不随之推进。未来回调可能使 `last_event_at` 超前，随后真实时间生成的状态事件可能被视作旧事件：clock 场景用独立 workspace，不将其用于普通取消/恢复结果。平台年续费成功不等于应用年付第 2–12 月 Cron、批次过期或取消到期已完成。应用时间相关验收需等待真实到期，或由 supervisor 另行安排隔离库中可审计的受控时间验证，并明确标注为受控验证；不能改共享 staging 系统时间或伪造付款日期后宣称真实通过。

PayPal 当前代码只接受单个、无试用/无 setup fee、固定 USD 的 MONTH/YEAR 周期，拒绝 DAY 临时加速 Plan、改价方案及无法证明的历史周期。已核对的官方文档没有提供本实现可直接使用的 test-clock 等价操作；实际沙箱续费时机/加速能力须人类账号核对。没有支持的办法就保留月/年续费为待观测，不能把 simulator、手工入库或 `capture` 当订阅续费；11.1 保持未完成。[Subscriptions v1](https://developer.paypal.com/api/subscriptions/v1) 是核对账号可用操作的官方入口。

### 部分退款、重投与录制

1. 从可申请的 succeeded 付款提交退款；admin 批准一个小于付款额的正整数金额（货币最小单位），记录 `approved_amount` 和平台 refund ID。Stripe 对应 PaymentIntent，PayPal 一次性对应 Capture、订阅对应 Sale。保留真实退款响应和回调先后时间。
2. 等待验签成功且 refund ID / 金额匹配：`payment_refund` 新增一个身份，`payment.refunded_amount` 正确、状态 partially_refunded，匹配的申请变 refunded。任何部分退款也会收回该付款的**全部剩余积分**（年付包含已有各月批次，并停止该付款未来月份发放），不是按退款比例收回；已消费不追溯。PayPal 未知累计金额为 null 时按唯一退款 ID 累加，不假装为 0。
3. 同一付款可在平台再做第二笔部分退款，验证累计金额等于唯一已验证退款之和且不超付款额；不能用原申请重复审核发起第二退款。重投第一笔、第二笔事件后金额、revoke 流水不再增加。后台列表的“原始−剩余”还包含 hold/expire/revoke，不能当实际消费。
4. Stripe 在事件详情点 Resend；可由已登录测试 CLI 使用 `stripe events resend evt_实际事件ID --webhook-endpoint=we_实际endpointID`。PayPal 使用当前 sandbox App 的 Webhook Events 重投已有事件，入口不可用时由操作者按官方 resend 操作执行，不能改事件 ID 制造“重复”。平台重投与后台 failed 重放分别记录；后台只对可信已入库 failed 事件重放，不绕过外部验签。[Stripe 重投](https://docs.stripe.com/webhooks)、[PayPal Webhook 管理](https://developer.paypal.com/api/rest/webhooks/)。
5. 每次真实交易从平台事件详情/受控接收记录保存原始 body、必要签名 headers、平台对象响应、投递 HTTP 状态、账号模式/endpoint ID/API 版本及 SHA-256。现有 `webhook_event.payload` 是 JSONB，不能还原原始字节或 headers；它可作业务映射证据，不能单独作 HTTP 验签录制。无需为录制在 Worker 日志公开完整 payload。
6. 原始材料保存在访问受限的位置，脱敏夹具只保留稳定、相互对应的 ID / metadata / 时间 / 金额 / 链接形状，清除邮箱、地址、付款资料、Authorization、token 和 secrets。脱敏后旧签名失效：夹具验证映射，原始受限材料证明在线验签；过期 Stripe 签名不用于普通 HTTP 重放。后续获授权的实现任务才将真实夹具接入测试，此文档任务不写夹具或改测试。

## 6. 可审计验收数据

每个场景记录：场景编号、操作者、UTC、Git SHA、两 Worker version、平台测试环境/App/endpoint ID、workspace/user ID、plan_price ID、subscription/order/invoice/payment/refund/event ID，付款额/退款额/币种/周期，事件名与 Stripe api_version、每次投递状态/耗时，录制原文 hash/受限位置、脱敏夹具位置、前后余额/批次/流水/权益、Cron/Queue/审计结果、pass/fail/pending 和原因。公开报告不包含凭据或个人信息。

在已经安全连接目标库的只读 psql 会话中设置实际 workspace UUID 后执行（`\set workspace_id '实际UUID'`），输出只保存必要字段；不导出全量 payload 或 contact_email：

```sql
SELECT current_database(), current_user;
SELECT id, provider, provider_price_id, interval, amount, currency, active
FROM plan_price ORDER BY provider, id;
SELECT id, provider, provider_subscription_id, status, cancel_at_period_end,
       current_period_start, current_period_end, last_event_at
FROM subscription WHERE workspace_id = :'workspace_id';
SELECT id, provider, provider_payment_id, kind, plan_price_id, amount,
       refunded_amount, status, period_start, period_end
FROM payment WHERE workspace_id = :'workspace_id';
SELECT payment_id, provider, provider_refund_id, amount, currency
FROM payment_refund WHERE workspace_id = :'workspace_id';
SELECT source, source_ref, payment_id, amount, remaining, status, expires_at
FROM credit_grant WHERE workspace_id = :'workspace_id';
SELECT type, delta, grant_id FROM credit_ledger WHERE workspace_id = :'workspace_id';
SELECT
  (SELECT coalesce(sum(delta), 0) FROM credit_ledger
   WHERE workspace_id = :'workspace_id') AS ledger,
  (SELECT coalesce(sum(remaining), 0) FROM credit_grant
   WHERE workspace_id = :'workspace_id' AND status = 'active')
  + (SELECT coalesce(sum(amount), 0) FROM credit_hold
     WHERE workspace_id = :'workspace_id' AND status = 'held')
  - (SELECT coalesce(sum(amount), 0) FROM credit_debt
     WHERE workspace_id = :'workspace_id') AS expected;
SELECT count(*) AS negative_grants FROM credit_grant
WHERE workspace_id = :'workspace_id' AND remaining < 0;
```

`ledger = expected`、negative_grants 为 0；同一 `(provider, provider_event_id)`、付款身份、退款身份和 `(source, source_ref)` 不重复。以实际事件 ID 定位 `webhook_event` 的 status/attempts/error/processed_at，以实际目标 ID 定位 `audit_log`；事件表没有 workspace_id，不能套用空间过滤。记录退款申请 status/approved_amount/provider_refund_id 与 `billing.payment_refunded`、`billing.webhook_postprocessed` 审计。Cron 为 UTC 每小时、每 10 分钟、每日 04:00；daily 对账结果需真实观测，不能靠 HTTP 200 推断。邮件保持 log 时只验队列和模板处理，不声明邮件已送达。

## 7. 剩余六项的完成门槛

| Task | 完成标准 / 必须留下的证据 |
|---|---|
| 1.3 | 两平台真实 test/sandbox sync 两轮成功，10 个有效本地映射、远端对应金额/周期一致、重复执行无新增；说明 PayPal 积分包无远端 Plan。 |
| 3.2 | 当前锁定版本真实 Stripe 结账、门户、取消/恢复、退款及首付/续费/一次性回调录制；录制夹具映射测试通过，验签与 invoicePayments → PaymentIntent 关联有真实证据，版本差异已处理。 |
| 3.3 | 当前 sandbox App 的 Orders capture、Subscriptions、KV OAuth、远端验签、取消/恢复、Sale/Capture 退款真实成功；录制首付/续费/退款等夹具映射通过，Sale 历史/周期与弃用 API 可用性验证；实际事件差异回写 docs/05。 |
| 10.1 | 从 `/pricing` 经真实 Stripe 测试卡付款到 billing-return 的端到端记录/断言，数据库付款与唯一积分批次一致；现有 Playwright mock e2e 不抵充。 |
| 10.4 | 联通结论回写 docs/05，docs/08 的 Q4 默认不结转、Q5 升级不补发、Q6 已消费不追溯状态按实际证据更新；标明仍待项，不删除已确认的不确定性。 |
| 11.1 | staging 两平台月付/年付、真实续费、取消/恢复/到期、重叠期、积分包、申请/平台全额与部分退款、重复回调矩阵全部验收；无重复发放/负余额、对账成立，应用时间与平台 clock 验证区分明确，所有失败修复后重验。 |

当前六项均待真实证据。本文件不勾选 tasks 或更新其他文档；后续 supervisor 按完整门槛结项。无凭据不阻塞文档交付；凭据可用、Stripe 版本选择、PayPal Sale API/历史形状、沙箱续费时间及应用到期验证方案是实际联通前/期间必须解决的事项。

## 8. 代码核对索引

- `packages/billing/src/runtime.ts:22` `createTestPaymentRuntime`；`packages/billing/scripts/sync.ts:9` CLI 门槛；`packages/db/worktree-env.ts:7` `readLocalEnv`。
- `packages/billing/src/stripe/client.ts:4` `STRIPE_API_VERSION`；`stripe/adapter.ts:216` `verifyWebhook` 与版本检查；`stripe/operations.ts` `cancelStripeSubscription` / `resumeStripeSubscription` / `changeStripePlan`。
- `packages/billing/src/paypal/webhooks.ts:67` `payPalWebhookNormalizer`、`:252` `verifyPayPalWebhook`；`paypal/operations.ts:237` suspend/cancel、`:252` activate；`paypal/snapshots.ts:426` `classifyPayPalSale`、`:439` `salePeriod`。
- `packages/billing/src/catalog.ts:8` `EXAMPLE_CATALOG`、`:99` `seedCatalog`、`:134` `syncCatalog`；`services.ts:275` 取消、`:305` 恢复；`events.ts:532` `applyBillingEvent` 的退款身份/累计/收回逻辑。
- `apps/web/src/features/billing/webhook-http.ts:11` `handleBillingWebhook`；`apps/jobs/src/billing.ts:20` Cron 常量与 `runBillingSchedule`；`packages/billing/src/cron.ts:96` `runAnnualGrants`、`:244` `runSubscriptionReconciliation`、`:304` `runCreditReconciliation`。
