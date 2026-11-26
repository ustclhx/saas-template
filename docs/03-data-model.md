# 03 · 数据模型

约定：表通常含 `created_at timestamptz default now()`、`updated_at timestamptz`（下文省略）；主键 `id uuid`（UUIDv7，应用层生成）；金额为整数 cents；积分为整数。`ws` = `workspace_id → organization.id`。

## 1. 认证（Better Auth 管理）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `user` | id, name, email (unique), email_verified, image, **role**(`user`/`admin`), banned, ban_reason, ban_expires, **locale**, **timezone** | role/banned 来自 admin 插件；locale/timezone 为扩展字段 |
| `session` | id, user_id, token, expires_at, ip_address, user_agent, **active_organization_id**, impersonated_by | 会话同时写 KV 二级存储 |
| `account` | id, user_id, provider_id, account_id, password(hash), access_token... | 邮箱密码与 OAuth 账号 |
| `verification` | id, identifier, value, expires_at | 邮箱验证、OTP、重置密码 |
| `two_factor` | user_id, secret, backup_codes | 可选 |
| `apikey` | id, reference_id, name, key(hash), prefix, enabled, expires_at, rate_limit..., **metadata**(含 workspace_id) | api-key 插件（`@better-auth/api-key`，`references: 'user'`，`reference_id` 指向 user）；按 workspace 使用 |

> 字段名以 Better Auth 生成的 schema 为准（`npx @better-auth/cli generate`），上表只列出需要关注或扩展的字段。

## 2. 租户（Better Auth organization 插件 + 扩展）

| 表 | 关键字段 | 说明 |
|---|---|---|
| `organization` | id, name, slug (unique), logo, metadata, **is_personal** bool, **deleted_at** | 即 Workspace；每个用户注册时自动创建一个 `is_personal=true` 的空间（slug 自动生成）；只做软删，从不物理删除（见 §7） |
| `member` | id, organization_id, user_id, role(`owner`/`admin`/`member`) | unique(organization_id, user_id)；**所有者以 `role='owner'` 为唯一事实来源**，`organization` 不再冗余 `owner_id` |
| `invitation` | id, organization_id, email, role, status, inviter_id, expires_at | 仅 multiTenant=true 时可用 |

约束：个人空间不能邀请成员、不能转让；用户删除账号时其个人空间随之软删（见 04-auth-and-tenancy「删除账号」）。

## 3. 计费

```
plan ──< plan_price           (套餐与各平台价格)
organization ──< billing_customer   (workspace 在各平台的客户 ID)
organization ──< subscription ──> plan_price
organization ──< purchase     (一次性购买：积分包)
webhook_event                 (去重与审计)
```

| 表 | 关键字段 | 说明 |
|---|---|---|
| `plan` | id, key (unique, 如 `free`/`pro`/`team`), name(i18n key), type(`subscription`/`credit_pack`), **credits** int, **credit_expiry_days** int null, **rollover** bool, **features** jsonb, sort, active | 订阅套餐的 `credits` 为**每月**发放量（年付按月发放）；积分包为一次性发放量；`sort` 越大套餐越高（重叠期取较高者）；features 见 05-billing「权益」 |
| `plan_price` | id, plan_id, provider(`stripe`/`paypal`/...), provider_price_id, interval(`month`/`year`/null), amount, currency, active | unique(provider, provider_price_id) |
| `billing_customer` | id, ws, provider, provider_customer_id | unique(ws, provider)；PayPal 可能为空（用 payer id） |
| `subscription` | id, ws, plan_id, plan_price_id, provider, provider_subscription_id (unique with provider), **status**(`trialing`/`active`/`past_due`/`canceled`/`expired`/`paused`), current_period_start null, current_period_end null, cancel_at_period_end, canceled_at, trial_end, **past_due_since** null, **last_event_at**, raw jsonb | 一个 ws 同时最多一个「会续费的」订阅（部分唯一索引，见 §7）；`past_due_since` 用于计算宽限期；`last_event_at` 用于丢弃乱序的旧事件；未付款且平台尚未提供服务周期时两日期为空，不授予付费权益 |
| `purchase` | id, ws, user_id, plan_id, plan_price_id, provider, provider_order_id, status(`pending`/`paid`/`refunded`/`failed`), amount, currency, paid_at, raw jsonb | 积分包等一次性购买（不用 `order` 作表名：SQL 保留字） |
| `billing_compensation` | id, ws, key unique, payload jsonb, status(pending/processing/completed), cancel_completed, provider_refund_id null, attempts, error, lease_until | 回调冲突后独立持久化的取消/退款任务；删除空间的任务为仅取消，不自动退款；租约与平台幂等键支持失败/崩溃重试 |
| `payment_refund` | id, ws, payment_id, provider, provider_refund_id, amount, currency | 单个已验证平台退款的记录；`unique(provider, provider_refund_id)` 防止不同投递重复累计部分退款 |
| `payment` | id, ws, provider, provider_payment_id, subscription_id null, purchase_id null, kind(`initial`/`renewal`/`adjustment`/`one_time`), plan_price_id null, period_start null, period_end null, amount, currency, status(`succeeded`/`refunded`/`partially_refunded`/`disputed`), refunded_amount, paid_at | 每一笔实际收款（含订阅续费），发放积分以此为幂等依据；`provider_payment_id` 取值规则见 05-billing |
| `refund_request` | id, ws, user_id, payment_id, reason, **contact_email** null, status(`pending`/`approved`/`rejected`/`refunded`), requested_amount null, approved_amount null, reviewer_id null, review_note, reviewed_at, provider_refund_id null | 退款申请（人工审核，见 05-billing「退款申请」）；部分唯一索引 `unique(payment_id) where status='pending'`；`contact_email` 在申请结束 30 天后清空 |
| `webhook_event` | id, provider, provider_event_id, type, status(`received`/`processed`/`failed`/`ignored`), attempts, error, payload jsonb, received_at, processed_at | unique(provider, provider_event_id)；一行对应一次平台投递（可拆出多个内部事件）；登记与失败记录在独立事务中写入 |

## 4. 积分

```
credit_grant (批次，余额真正所在)
credit_hold  (预扣)  ──< credit_hold_allocation (从哪些批次预扣了多少)
credit_ledger (只增不改的流水)
```

| 表 | 关键字段 | 说明 |
|---|---|---|
| `credit_grant` | id, ws, source(`subscription`/`purchase`/`signup`/`admin`/`refund`/`promo`), **source_ref** , **payment_id** null, amount, **remaining**, expires_at null, status(`active`/`expired`/`revoked`) | unique(source, source_ref) 保证幂等（年付按月批次的 source_ref 为 `{payment.id}:{n}`）；`payment_id` 便于退款时找回所有相关批次；索引 (ws, status, expires_at) |
| `credit_hold` | id, ws, user_id, amount, status(`held`/`captured`/`released`), ref_type(`ai_task`/`ai_message`/`agent_turn`), ref_id, captured_amount, **overage_absorbed**, **overage_debited**, **overage_debt**, expires_at null | 状态只能从 `held` 转出一次；三个 overage 字段分别记录超出预扣后平台承担 / 从余额补扣 / 记为欠费的量（见 05-billing「超额容忍」，平台承担量也用于计算空间当日额度）；超时处理按 ref_type 区分（见 05-billing「超时回收」），`ai_task` 的 hold 不设 expires_at |
| `credit_debt` | ws (pk), amount, updated_at | 空间欠费；`amount > 0` 时禁止新的 hold，下一次发放积分时优先偿还 |
| `credit_hold_allocation` | hold_id, grant_id, amount | 结算/释放时按分配原路退回 |
| `credit_ledger` | id, ws, user_id null, grant_id null, **delta**(+/-), type(`grant`/`consume`/`expire`/`refund`/`revoke`/`adjust`/`debt`/`debt_repay`), ref_type, ref_id, note, created_at | 审计与用量统计的唯一依据，不做 update/delete |

余额 = `sum(remaining) where ws=? and status='active' and (expires_at is null or expires_at > now())`。
（`remaining` 在 hold 时即扣减，所以余额已排除预扣中的积分。）

对账不变式（每日 Cron 校验）：`sum(credit_ledger.delta) = sum(status='active' 批次的 remaining) + sum(status='held' 的 hold.amount) - credit_debt.amount`。积分退回到已过期/已收回批次时必须同时写抵消流水，否则该等式会被破坏（见 05-billing「退回到非 active 批次」）。

## 5. AI

| 表 | 关键字段 | 说明 |
|---|---|---|
| `ai_model` | id, key (unique, 如 `gpt-x`、`flux-dev`), display_name null, kind(`text`/`image`/`video`), provider, provider_model_id, **pricing** jsonb, **min_plan_features** jsonb/标签, params_schema jsonb, supports_tools bool, enabled, sort | `display_name` 可空，用户侧为空时显示 `key`；`supports_tools` 默认为 false，标记文本模型是否支持工具调用；`pricing.mode` 选择计费方式（见 06-ai §2），示例：按次 `{mode:'per_call', credits:5, multipliers:{resolution:{'720p':1,'1080p':2}}}`、按 token `{mode:'token', inputPer1k:2, outputPer1k:8}`、按用量 `{mode:'per_unit', unit:'second', perUnit:20}` |
| `ai_conversation` | id, ws, user_id, title, model_key, archived, kind(`chat`/`agent`), agent_id null, subject_type null, subject_id null | `kind` 默认为 `chat`，只有 `agent` 行填 `agent_id`。普通和业务对象文本对话列表只读取 `chat`；业务对象的类型和 ID 同时为空或同时填写 |
| `ai_message` | id, conversation_id, ws, role(`user`/`assistant`/`system`/`tool`), parts jsonb, model_key, **pricing** jsonb, **status**(`streaming`/`completed`/`aborted`/`failed`), input_tokens, output_tokens, **usage_checkpoint** jsonb null, credits, hold_id | parts 兼容 AI SDK UIMessage；`pricing` 为发起时的定价快照；`usage_checkpoint` 为生成过程中定期写入的累计用量估算 `{inputTokens, outputTokens, at}`，结算丢失时兜底按它结算（06-ai §3） |
| `ai_agent_turn` | id, ws, user_id, conversation_id, request_id, model_key, **pricing** jsonb, hold_id null, status(`running`/`completed`/`stopped`/`failed`/`expired`), usage_checkpoint jsonb null, usage jsonb null, credits_charged, steps, tool_calls jsonb, error_code null | 存储轮次审计与结算数据，消息正文保存在 Durable Object。工具调用记录只含名称、状态与耗时。`(conversation_id, request_id)` 唯一，复用同一轮次；按 `(ws, user_id, id desc)` 索引 |
| `ai_task` | id, ws, user_id, kind(`image`/`video`), model_key, **pricing** jsonb, **status**(`queued`/`running`/`succeeded`/`failed`/`canceled`), input jsonb, output jsonb, provider, provider_job_id, provider_request_key, **callback_payload** jsonb null, workflow_instance_id, hold_id, credits_charged, error_code, error_message, started_at, finished_at, deadline_at | `pricing` 为提交时的定价快照，预扣与结算都用它；`provider_request_key` 为提交服务商时的幂等键；`callback_payload` 由回调入口先落库再通知 Workflow；`deadline_at` 为任务硬超时。索引 (ws, id desc)、(status, updated_at)（后者用于回收卡住任务） |
| `file` | id, ws, user_id, purpose(`upload`/`ai_output`/`avatar`/...), **status**(`pending`/`ready`), r2_key (unique), mime, size, width, height, duration, source_task_id null, public_token null (unique), deleted_at | R2 中对象的元数据；`pending` 为已签发上传 URL 但未确认，只有 `ready` 计入配额并可被引用；`public_token` 用于可选的公开分享 |
| `studio_work` | id, workspace_id, user_id, file_id (unique), task_id, kind, site, slug (unique), title, prompt null, show_prompt, model_key, width/height/duration_ms null, visibility, moderation, moderation_before_hide null, removal_reason null, featured_at null, version, report_count, published_at, reviewed_at/reviewed_by null, created_at, updated_at | 首次发布时建行。`visibility` 为 `public` / `private`，`moderation` 为 `pending` / `approved` / `hidden` / `removed`。隐藏前的 `pending` 或 `approved` 存在 `moderation_before_hide`；`version` 初始为 1。空间、发布者、审核者、输出文件和任务外键均限制物理删除。 |
| `studio_report` | id, work_id, reporter_key, reason, note null, resolved_at null, resolution null, created_at | 同一作品和举报键只能有一条记录。`reason` 为 `sexual` / `violence` / `hate` / `copyright` / `spam` / `other`，`note` 最多 500 字符。删除作品时级联清除举报。 |

## 6. 平台通用

| 表 | 关键字段 | 说明 |
|---|---|---|
| `notification` | id, user_id, ws null, type, title, body, link, read_at | 站内通知 |
| `audit_log` | id, actor_user_id, ws null, action, target_type, target_id, ip, meta jsonb, created_at | 管理员操作、计费关键变更、成员变更 |
| `admin_api_token` | id, user_id, name, prefix, token_hash, scopes text[], expires_at, last_used_at null, revoked_at null, created_at | 管理员 MCP 个人令牌。`prefix` 用于展示，`token_hash` 保存 SHA-256 十六进制摘要。`scopes` 包含 `admin:read`，可附加 `admin:write`。过期时间必填。 |
| `admin_step_up` | session_id (pk, fk session 级联), user_id, method, verified_at, expires_at, last_totp_step null | 管理员会话的敏感操作重新验证状态（[后台重新验证](../openspec/changes/add-admin-step-up/design.md)）。每个会话一行，成功验证即覆盖；`expires_at` 为绝对时间，不随使用延长。`method` 取 `totp`、`backup_code`、`email_otp`、`password`、`rescue`，`passkey` 为预留值。`last_totp_step` 记录最近接受的 TOTP 时间窗，拒绝同窗重放。 |
| `admin_pending_action` | id, tool, action, token_id, requested_by, summary, payload jsonb, display jsonb, secret_ciphertext bytea null, status, result jsonb null, decided_by null, decided_at null, expires_at, created_at | AI（admin MCP）发起、等待管理员确认的敏感操作。`action` 为后台动作登记表中的动作名；`payload` 为创建时解析好的执行参数（不含密钥），`display` 为确认页展示内容；密钥参数只以密文存于 `secret_ciphertext`，数据密钥在平台缓存中随有效期失效，终态即清空。`status`：`pending`、`running`、`done`、`failed`、`rejected`、`expired`。有效期 30 分钟。 |
| `setting` | key (pk), value jsonb, updated_by | 运行时可改设置，KV 缓存 |
| `waitlist` | id, email (unique), source, created_at | 可选 |

`user_attribution`：用户首次进站来源（UTM、来源主机、落地路径、设备），主键 `user_id`，注册时写入一次，账号删除时一并清除。见 [埋点](analytics.md)。

## 7. 索引与约束要点

- 所有带 `ws` 的表：`(ws, id desc)` 复合索引。UUIDv7 本身按时间有序，按 id 排序即按创建时间排序，列表分页用 id 做游标，不需要再单独建 `created_at` 索引。
- 幂等唯一键：`webhook_event(provider, provider_event_id)`、`credit_grant(source, source_ref)`、`payment(provider, provider_payment_id)`。
- 作品：`(site, visibility, moderation, published_at desc)` 用于画廊查询，`(site, featured_at desc) where featured_at is not null` 用于精选，`(moderation, published_at)` 用于审核队列。
- `admin_api_token` 按 `token_hash` 建唯一索引以校验令牌，按 `user_id` 建索引以列出个人令牌。
- `admin_step_up` 以 `session_id` 为主键并级联删除：会话退出或被吊销时验证同时失效。`admin_pending_action` 按 `(requested_by, status)` 与 `(token_id, status)` 建索引，用于待确认列表与每令牌待确认数量上限。
- 订阅：`unique (ws) where status in ('trialing','active','past_due','paused') and cancel_at_period_end = false`（部分唯一索引），保证同一空间只有一个「会续费的」订阅；已设置周期末取消的旧订阅不计入，允许换套餐 / 换支付平台时新旧订阅短暂重叠（见 05-billing §6）。Stripe Customer Portal 以 `cancel_at`（≤ 当前周期末）表达的周期末取消同样写为 `cancel_at_period_end=true`（见 05-billing「Stripe 实现要点」）。
- 删除策略：
  - 业务上对 `organization` 做软删，对 `user` 做匿名化并永久封禁。大部分外键使用 `on delete restrict` 防止误删。`admin_api_token.user_id` 使用 `on delete cascade`，数据库物理删除 `user` 时同步清除令牌。业务删号后，MCP 鉴权读取用户的封禁状态并拒绝令牌。
  - 软删后的数据清理由 Cron 执行（jobs 每日 03:00 UTC 的 `workspace-cleanup` 与十分钟一次的 `files-cleanup`）：
    - **空间保留期**：空间软删 30 天后，`notification`、`invitation` 在首次清理时删除并写入 `workspace.cleanup.completed` 审计；`ai_message` → `ai_conversation` → `ai_task` 按外键顺序分批物理删除（每批一个事务，单批 500 行、单轮最多 200 批，剩余的下一轮继续）；`file` 及其 R2 对象由 `files-cleanup` 删除。
    - **删号**：删号事务内匿名化账号，并删除该用户的 `notification`，以及 `newsletter_subscriber`、`waitlist` 中该邮箱（原值小写与 `normalizeSignupEmail` 规范化值）的记录，均在邮箱被替换为占位值之前完成。该用户在团队空间中的 `ai_conversation`、`ai_message`、`ai_task` 不放进删号事务，由同一个 `workspace-cleanup` 按已删除用户（邮箱为 `deleted+<id>@invalid`）分批删除，日常数据量下在 24 小时内完成删除；个人空间随账号软删，走上面的保留期规则。团队空间中该用户的产出文件属于空间共享资产，保留，只把 `file.source_task_id` 置空。
    - **跳过规则**：仍有 `held` 预扣的消息或任务（以及该消息所在的对话）、一天内仍在生成（`streaming` / `queued` / `running`）的行先跳过，等兜底处理器结算后下一轮再删。`credit_hold` 以 `ref_type` / `ref_id` 文本指向这些行，不受删除影响。
    - **永久保留**：`credit_*`、`payment`、`subscription`、`purchase`、`refund_request`（`contact_email` 除外）、`audit_log`、`webhook_event` 永久保留以供财务审计。
    - **审计记录不存个人信息**：`audit_log` 对 `app` 只追加，删号时无法改写，因此写入方只记录用户 id、邀请 id 与变更的字段名，不写入邮箱、姓名、头像；用户行匿名化后，审计页显示为已删除用户。
  - 指向 `user` 的列（`credit_ledger.user_id`、`audit_log.actor_user_id` 等）在用户删除后仍指向已匿名化的 user 行，不置空。
