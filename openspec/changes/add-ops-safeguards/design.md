# Design: add-ops-safeguards

动机见 proposal.md。本文件的盘点基于 2026-11-25 的 main（`196547e`）；第三方行为的出处均为当日访问。参考了某私有建站引擎的同类做法（只借鉴思路，未引用其代码）。

## Context

### 后台任务现状

Cloudflare 上 `apps/jobs/wrangler.jsonc` 默认五条 cron；staging / production 使用 `CRON_PROFILE=reduced`（`*/30` 合并心跳与十分钟组）。`apps/jobs/src/handlers.ts` 的 `CRON_TASK_GROUPS` 把 cron 映射到任务组，`runCoreTaskGroup` 与插件 `crons` 并行执行（`Promise.allSettled`）；Node 由 `registerJobsSchedules` 注册同样五个调度，`missedRun: 'skip'`，崩溃后可能重放。计费子任务只是 `runBillingSchedule` 内的名称字符串，没有统一登记。插件 `JobsPluginModule`（`apps/jobs/src/plugins/module.ts`）支持 `crons` / `holdSweepers`，模板内置插件目前都没有 `crons`。

会删除数据、销毁积分、调用外部取消或批量发送的任务：

| # | 任务（触发） | 动作 | 现有上限 | 顺序 | 时间截止 |
|---|---|---|---|---|---|
| 1 | 删号凭据清理 `deletion-cleanup`（心跳组） | 删 `verification` 行与对应 KV 键 | 无 | 无 | DB `now()` 对比插入时定的 `expires_at` |
| 2 | 文件清理 `files-cleanup`（十分钟组） | R2 删除 + `file` 行删除：未确认上传、过期空间全部文件、废弃 AI 产出 | **无**（全部空间、全部文件） | 按 workspace_id | JS 时钟；未确认 1h、空间 30 天常量；废弃产出无时间条件 |
| 3a | 个人空间分享卡清理（`0 3`） | R2 list + delete | 无（`maxIndexes` 默认无穷，删号路径传 20） | 按 id | 无保留期 |
| 3b | 过期空间清理 | AI 内容（500×200 批）、`notification`、`invitation` 行、分享卡 | AI 有；其余无 | 按 id | DB `now() - 30 天` |
| 3c | 已删用户 AI 内容清理 | 同 3b 的 AI 批量删除 | 500×200 | 按 id | 无（按身份） |
| 4 | `credit_expiration`（每小时） | 积分批次置过期并记账 | 无 | 无 | JS 时钟 `expiresAt <= now` |
| 5 | `hold_sweep`（十分钟组） | 超时预扣结算 | 无 | 无 | JS 时钟 |
| 6 | `refund_notifications`（十分钟组） | 退款邮件入队 | 100 | `updatedAt` 升序 | 无，靠审计标记去重 |
| 7 | `compensation`（十分钟组） | 调支付平台取消订阅 | 25（1–100 校验） | 创建时间升序 | 租约 |
| 8 | `subscription_reconciliation`（`0 4`） | PayPal 过期订阅调平台取消 | 无 | 无 | JS 时钟 |
| 9 | 对账告警（`0 4`） | 每个失败空间一条运维通知 | 无，`sourceId` 含 `now`，跨轮不去重 | — | — |
| 10 | `refund_contact_cleanup`（`0 4`） | 清空联系邮箱（PII） | 无 | 无 | JS 时钟 `now - 30 天` |
| 11 | agents 保留期（Durable Object alarm，web） | 归档会话并 `destroy()` 存储 | 每次 alarm 一个会话 | — | JS 时钟 `updatedAt < now - retentionDays` |
| 12 | Node 队列/工作流清理 `cleanupNodeQueues` / `cleanupNodeWorkflowEvents` | 删除终态记录 | 无 | — | 保留期 ≥1h 校验；**目前未接入调度** |
| 13 | 自托管备份保留（Python） | WAL-G 删除旧备份 | 已有完整证明链 | — | 参数有界 |

不在范围：邮件队列消费者（每批 10 条，由平台投递控制）、运维事件队列（已按渠道去重）、按请求触发的惰性删除。newsletter 目前只有导出，没有群发任务；将来新增群发必须登记（守卫会拦截）。

当前保留期都是常量，配置错误不会直接引发大规模删除；风险主要在「无上限」「JS 与 DB 两套时钟」「重放」与将来改成可配置时缺乏防护。

### MCP 现状

`plugins/admin-mcp/src/web/mcp.ts` 每次请求注册 `[pingTool, ...settingTools, ...modelTools, ...businessTools]`，`defineAdminTool` 用 `z.toJSONSchema(input, { io: 'input' })` 生成 inputSchema。14 个工具都有描述，**所有参数都没有说明**；`docs/admin-mcp.md` 工具表目前与注册结果一致，但没有测试保证。`audit.list` 与 `metrics.summary` 的输入 schema 复用后台页面的 `auditSearchSchema` / `metricsSearchSchema`。

### 存储现状

Cloudflare：R2 写/删在 `packages/storage/src/cloudflare/{index,media,share-cards}.ts`；KV 写/删在 `packages/platform/src/cloudflare/index.ts`。没有任何重试，只有 Workflow 步骤和队列消费者自带的重试间接覆盖。`media.ts` 中远端下载经 `FixedLengthStream` 流式写入 R2，请求体不可重放。Node：对象存储用 `@aws-sdk/client-s3`，未显式设置 `maxAttempts` / `retryMode`；缓存用 Redis，刻意 `maxRetriesPerRequest: 0` 快速失败并映射为 `CACHE_UNAVAILABLE`（503）。

### 公开页面现状

审查结论（详见 tasks 第 5 组）：没有任何后台故障会把公开页面重定向到登录或后台（admin 门禁只匹配 `/admin` 与 `/admin/…`，非管理员得到 404；根 loader 的公告与模拟登录读取都已 try/catch 降级；定价有快照回退）。发现两条会让公开页不可用的路径：

- **R1 环境校验整站失败**：`apps/web/src/server.ts` 在 `checkEnv` 失败时跳过静态资源，所有路径返回 500。校验内容包括插件清单声明的必需绑定，例如只给 admin MCP 用的 `RL_ADMIN_MCP`。预渲染的首页、博客、文档、法律页也因此不可用。
- **R3 语言中间件**：`usesAccountLocale` 对所有 `/_serverFn/` 请求返回 true；已登录访客在公开页间客户端导航时会查库读会话，数据库故障抛出非 `AppError`，server function 返回 500。博客、文档、法律、指南路由与根路由都没有 errorComponent，于是出现框架默认错误页。`docs/platform-capabilities.md` 中「语言处理仅在账号区域读取 auth/db」的描述与实际不符。

另：分享页 `/s/$type/$token` 必须查库，数据库故障时 500 且没有错误界面。

## Goals / Non-Goals

**Goals**
- 每个登记任务单轮最坏影响有界、可预测，异常时间宁可不做也不误删，并且能让运营知道。
- 新增此类任务、MCP 工具、第三方集成时，遗漏登记会在 CI 中失败，而不是靠审阅发现。
- 平台临时错误不直接变成用户可见失败；不可重试的错误不被重试放大。
- 公开页面对后台配置、插件、数据库故障的依赖降到最低，并有测试固定。

**Non-Goals**
- 不改变任何保留期数值、业务语义或数据库 schema；不把常量保留期改成运行时设置。
- 不实现第三方状态的自动查询脚本（登记表中标出可自动化的项，留给后续 change）。
- 不处理 Cloudflare Rate Limiting 绑定线上不拒绝的问题（另有挂起事项）。
- 不覆盖备份保留（#13 已有更强的证明链，只在登记表中列出现状）。
- 不改邮件队列的投递策略。

## Decisions

### D1 任务防护：声明式登记 + 运行时枚举守卫

每个任务以 `defineBulkJob({ id, kind, cap, order, timeGuard, run })` 声明（`kind`: `delete` / `destroy-credit` / `external-write` / `send`；`cap` 为每轮上限常量；`order` 为排序说明）。核心任务组、计费子任务列表与插件 `crons` 都由这些定义组成：`runBillingSchedule` 改为遍历定义数组，不再在函数体中写名称字符串。插件 `PluginCronTask` 增加必填 `safety` 字段（`{ kind: 'none', reason }` 或上述防护声明），由类型强制。

守卫测试（`apps/jobs/test/bulk-jobs.guard.test.ts`）：
1. 从 `CRON_TASK_GROUPS` 解析出的实际任务、计费子任务数组、生成的插件模块 `crons` 中枚举全部任务，`kind !== 'none'` 的任务必须有正整数 `cap` 与时间防护声明。
2. 与 `docs/bulk-jobs.md` 登记表双向一致（任务 id、上限值、代码位置文件存在）。
3. `apps/jobs/wrangler.jsonc` 各环境的 `crons` 与 `CRON_TASK_GROUPS[profile]` 的键一致（现在只有硬编码断言）。
4. 已知的非 cron 删除点（agents alarm、Node 队列清理）在登记表中有行，由测试中的显式列表核对；新增这类入口时需同时更新列表（写在 AGENTS.md 规则中）。

备选：源码扫描 `.delete(` / `send(` 自动发现任务。放弃：误报多、写法变化即失效；声明式加类型强制在 typecheck 阶段就能拦截。

### D2 每轮上限与顺序

上限是代码常量（不做运行时设置，避免又一个可被误配的入口）；到达上限时剩余留到下一轮，记录 `job.cap_reached` 警告日志（含任务 id 与本轮处理数）。候选一律按「最早到期」排序（`expires_at` / `deleted_at` / `created_at` 升序，再按 id），保证积压时不会饿死最老的记录。

上限值（Q1，使用者 2026-11-25 确认按本表），按 reduced profile（每 30 分钟 / 每天一次）估算吞吐：

| 任务 | 上限 | 依据 |
|---|---|---|
| 1 删号凭据 | 200 个清单/轮 | 每清单若干 KV 删除；心跳组 48 轮/天 ≈ 9600/天 |
| 2 文件清理 | 20 个空间/轮，且 500 个对象/轮（先到为准） | R2 `delete()` 单次最多 1000 个键（[Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)，2026-11-25）；每次调用计一个子请求，Workers 每次调用子请求上限 **待核实**；48 轮/天 ≈ 24000 对象/天 |
| 3a 分享卡 | 20 个空间/轮 | 与删号路径现有的 20 一致 |
| 3b 过期空间 | 20 个空间/轮；AI 内容沿用 500×200 | 每天一次；同时限制通知与邀请删除量 |
| 4 积分过期 | 200 个空间/轮 | 每小时一次 ≈ 4800/天 |
| 5 预扣结算 | 500 条/轮 | 十分钟组 |
| 6 退款邮件 | 维持 100 | 已有 |
| 7 补偿取消 | 维持 25 | 已有 |
| 8 订阅对账取消 | 50 次外部调用/轮 | 每天一次，异常时人工介入 |
| 9 对账告警 | 每轮最多 10 条明细，其余合并为 1 条汇总；`sourceId` 按「任务 + UTC 日期」去重 | 避免系统性故障时刷屏 |
| 10 退款联系邮箱 | 500 条/轮 | 每天一次 |
| 11 agents | 每次 alarm 一个会话（维持） | 固有上限 |
| 12 Node 队列清理 | 1000 条/轮（接入调度时生效） | 目前未调度，登记占位 |

文件清理（#2）还会把「逐个空间一个事务、事务中做网络删除」的结构保留不变，只限制空间与对象数；事务内持锁时间因对象上限而有界。

### D3 时间合理性防护

纯函数放在 `packages/shared`（无依赖、两目标共用）：

- **本轮基准时间**：删除类任务以数据库时钟为准（候选查询中同时取 `now()`，不额外加查询），JS 时钟只作对照；两者相差超过 5 分钟时本轮不执行并告警。理由：恢复空间（`restoreWorkspace`）等写入使用 DB 时钟，统一后边界一致。
- **截止时间检查**（整轮）：截止时间无效（NaN）、早于下限 `2024-01-01T00:00:00Z`、晚于本轮基准时间，或换算出的保留期低于该任务声明的最小保留期（如空间保留 ≥1 天、未确认上传 ≥10 分钟、agents ≥1 天）时，本轮不执行，记录错误日志并发运维告警。秒被当成毫秒时得到 1970 年附近的值，会被下限拦截；毫秒被当成秒会得到极远未来，被「晚于基准」拦截。
- **行时间检查**（逐行）：候选查询加条件只选时间列在 `[下限, 基准时间]` 区间内的行；同时统计区间外的行数，大于 0 时发一次告警（按任务 + UTC 日期去重），提示人工检查，不删除这些行。
- 告警走现有运维通知（EVENTS_QUEUE → `notifications/operations.ts`），新增事件类型 `ops.bulk_job.guard_tripped`，载荷只含任务 id、原因与计数，不含用户数据。

备选：只做整轮检查。放弃：单行时间被写坏（迁移错误、导入数据）时整轮检查发现不了。

### D4 MCP 说明：定义时由类型强制

`defineAdminTool` 增加必填 `params` 映射。TypeScript 要求输入 schema 的每个键都有字符串说明，守卫测试确认说明非空。生成 inputSchema 时将说明写入对应属性的 `description`。复用的后台 schema（`auditSearchSchema` 等）无需改动。客户端可见的工具 `description` 使用英文，至少一句完整说明。

`mcp.ts` 中的工具数组导出为 `adminTools`，运行时与测试共用同一来源。守卫测试：
1. 枚举 `adminTools` 生成的 spec：工具描述去空白后不少于 20 字符；inputSchema 每个属性都有非空 `description`；`readOnlyHint` 与 scope 一致。
2. 解析 `docs/admin-mcp.md`「工具与权限」表：工具名集合、scope 与注册结果一致；参数列表 `{ a, b? }` 与 inputSchema 的属性名及 `required` 一致（有默认值的参数在 input 方向为可选，文档写 `?`）。
3. 现有集成测试（`apps/web/test/admin-mcp.test.ts`）增加一条 `tools/list` 断言参数说明经协议返回。

2026-11-25 核对了协议和转换接口。`tools/list` 的参数说明位于 `inputSchema.properties.<参数名>.description`，参数是否必填按对象的 `required` 数组判断。沿用 Zod 的 `io: 'input'` 生成调用方 schema，再补说明。[MCP Tools 规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) · [Zod JSON Schema](https://zod.dev/json-schema) · [JSON Schema 对象参考](https://json-schema.org/understanding-json-schema/reference/object#required)

备选：在 zod schema 上逐个 `.describe()`。放弃：漏写时只能等测试发现，且会改动后台共享 schema。

### D5 第三方登记表

`docs/third-party.md` 一张主表，列：第三方 | 我们自动查询 | 教使用者做的事 | 代码 / 文档位置 | 官方出处 | 上次核对 | 验证方式。验证方式只允许 `真账号`、`文档`、`模拟`、`未核对` 四个值；`上次核对` 为 `YYYY-MM-DD`，`未核对` 时写 `—`。表下另列「可改为自动查询」清单（如 Stripe `GET /v1/webhook_endpoints`、PayPal webhooks 列表、Resend 域名状态、`wrangler hyperdrive get`、`wrangler r2 bucket cors list`、GitHub environments API、Sentry 项目 API、运维通知测试发送），只记录，不在本 change 实现。

覆盖行（按现有代码与文档盘点）：Stripe、PayPal、Cloudflare Workers / R2 / KV / Queues / Workflows / Cron Triggers / Hyperdrive / AI Gateway / Workers AI / Turnstile / Rate Limiting / Tunnel / Durable Objects 与 Agents SDK / Web Analytics / DNS 与自定义域名、Neon、fal.ai、DeepSeek、OpenAI、Anthropic、Google AI Studio、Resend、Google OAuth、GitHub OAuth、Plausible、Sentry、GitHub Actions 与 GHCR、Telegram、Discord、汇率源（open.er-api.com）、IndexNow、PostHog、Microsoft Clarity、自托管栈（Caddy/ACME、SMTP、S3 兼容存储、WAL-G）。

守卫测试（`scripts/check-third-party.test.mjs` 或放入现有 docs 测试）：每行列数完整、验证方式取值合法、日期格式合法、官方出处为 `https://` 链接或 `待核实`；并维护「SDK 依赖 → 登记行」映射（如 `stripe`、`@ai-sdk/*`、`@aws-sdk/*`、`@sentry/*`、`@fal-ai/*`、`posthog-*`），任何 workspace `package.json` 新增匹配监视模式的依赖而没有映射时失败。

规则写入 AGENTS.md（三条，见 proposal），其中「真账号数据不进仓库」与现有私有证据库规则衔接：账号 ID、余额、域名配置截图、部分密钥等写入 `EVIDENCE_DIR`，仓库只引用。盘点中发现现有 runbook 已含真实沙箱账号 ID：按 Q4（使用者 2026-11-25 确认）在回填登记表时替换为占位符，原值只保留在私有证据库，不改写 git 历史。

### D6 存储重试

纯函数 `retryTransient(operation, { classify, delaysMs })` 放在 `packages/shared`；分类器按目标放在各自适配层。

**Cloudflare R2**（[错误码](https://developers.cloudflare.com/r2/api/error-codes/)，2026-11-25）：Workers 绑定抛出异常，错误码出现在 `message` 末尾，分类器同时识别 `(1xxxx)` 与 S3 码名。**已核实（2026-11-25）**：错误码页原文「The error code is included at the end of the `message` property」，示例 `put: Your metadata headers exceed the maximum allowed metadata size. (10012)`；本地 workerd（miniflare 5.20261001）实测绑定抛出普通 `Error`、无 `code` / `action` 属性，message 为 `<操作>: <说明> (<码>)`（如 10012、10037）。

| 码 | 名称 | 处理 | 出处原文要点 |
|---|---|---|---|
| 10001 | InternalError 500 | 重试 | 「Retry the request」 |
| 10043 | ServiceUnavailable 503 | 重试 | 「Retry with exponential backoff」 |
| 10054 | ClientDisconnect 400 | 重试 | 「Check network connectivity and retry」 |
| 10058 | TooManyRequests 429（同键 1 次/秒） | **按同键限流单独重试**（Q3） | [R2 限制](https://developers.cloudflare.com/r2/platform/limits/)：同键并发写超过 1 次/秒返回 429；[错误码](https://developers.cloudflare.com/r2/api/error-codes/)：检查是否有多个客户端写同一键 |
| 其余（NoSuchKey、PreconditionFailed、EntityTooLarge、鉴权、桶错误等） | 4xx | 不重试 | — |

另按 [Workers 错误](https://developers.cloudflare.com/workers/observability/errors/)（2026-11-25）对「Network connection lost」重试（文档：「Catch a fetch or binding invocation and retry it」）。

**Cloudflare KV**（[写入](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)、[限制](https://developers.cloudflare.com/kv/platform/limits/)，2026-11-25）：同键 1 秒内多次写入抛出 `KV PUT failed: 429 Too Many Requests`；官方原文「we recommend implementing a retry logic, with exponential backoff」，示例从 1000 ms 起每次翻倍。按 Q3（使用者 2026-11-25 确认：遵循官方文档），该错误归入同键限流类单独重试；「Network connection lost」与 5xx/内部错误归入临时错误类重试。

**参数**：两类错误分别计数（Q3，使用者 2026-11-25 确认）。

| 类别 | 适用 | 最多重试 | 等待 | 依据 |
|---|---|---|---|---|
| 临时错误 | R2 10001 / 10043 / 10054、KV 与 R2 的「Network connection lost」、内部错误 | 3 次 | 100、300、900 ms，各 ±50% 抖动 | R2 错误码页「Retry with exponential backoff」；Workers 错误页（均 2026-11-25） |
| 同键限流 | R2 10058、KV `KV PUT failed: 429 Too Many Requests` | 2 次（少于临时错误） | 1000、2000 ms，各加 0–250 ms 抖动 | 同键 1 次/秒限制（[R2 限制](https://developers.cloudflare.com/r2/platform/limits/)、[KV 限制](https://developers.cloudflare.com/kv/platform/limits/)）；KV 写入页的指数退避建议与 1000 ms 起始值（2026-11-25） |

单次调用最多 1 + 3 + 2 = 6 次尝试，最坏总等待约 5.5 s（临时类 ≤1.95 s + 同键限流类 ≤3.5 s）；请求路径能接受这个上限，因为同键限流在正常使用中很少出现，且失败比等待更糟（如会话写入失败导致登录失败）。后台任务使用同一参数（队列与 Workflow 已有更长的外层重试）。删除幂等，可直接重试；写入只在请求体可重放（`string` / `ArrayBuffer` / `Uint8Array` / `Blob`）时重试，`ReadableStream` 请求体不在适配层重试，交给外层（Workflow 步骤）重试整段下载。耗尽或不可重试时抛出 `AppError('STORAGE_UNAVAILABLE', 503)`（R2）或沿用 `CACHE_UNAVAILABLE`（KV），日志记录错误类别、错误码与各类尝试次数，不记录键中的用户数据。同键限流耗尽时日志单独标记，便于发现热点键的设计问题。

**Node**：S3 客户端显式设置 `maxAttempts: 3`、`retryMode: 'standard'`（**已核实（2026-11-25）**：[AWS SDK 重试文档](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html) 默认 `standard`、max attempts 3，原文「A max attempts value of `3` means the SDK makes one initial request and up to two retries」；standard 模式重试 InternalError、I/O 失败、无可识别错误码的 500/502/503/504 及 SlowDown 等限流错误。已安装 `@smithy/core` 3.35 的 `DEFAULT_MAX_ATTEMPTS=3`、`DEFAULT_RETRY_MODE=standard` 一致；显式设置是为了不受主机 `AWS_MAX_ATTEMPTS` / `AWS_RETRY_MODE` 影响），不叠加 `retryTransient`，避免 9 次放大。Redis 缓存维持快速失败（连接级故障重试会拖住请求，现有 503 语义已被 `cache-rate-limit` 规范依赖）。

备选：放到 `packages/storage` 调用方逐处包装。放弃：调用点十余个，适配层一处覆盖且两目标语义清晰。

### D7 公开页面优先

规则：公开页面（营销、定价、博客、文档、法律、指南、问答、分享页的外壳）的可用性不得依赖后台配置、后台专用绑定、插件后台路由或数据库可用；需要数据的部分降级显示。

1. **预渲染页不受环境校验影响**：`server.ts` 在 `checkEnv` 失败时仍先查静态资源，命中则返回（静态 HTML 不使用运行时绑定；安全头的输入已做格式校验）。动态请求仍按现状 fail-closed 返回 500，并记录缺失项。
2. **插件绑定不拖垮整站**：插件清单声明的绑定缺失时，只让该插件的路由返回 503（附日志与 `/api/health` 中的插件状态），不再进入全站 `checkEnv`。部署前由 `scripts/production/check-wrangler-envs.mjs` 校验每个启用插件声明的绑定在各环境的 wrangler 配置中都已声明，缺失即 `pnpm check` 失败，把问题挡在部署前（Q2，使用者 2026-11-25 确认）。
3. **语言中间件降级**：`/_serverFn/` 请求读会话遇到非 401/403 错误时按「无账号语言」处理并记警告日志，不再抛出；同时把 `docs/platform-capabilities.md` 的描述改为与实现一致。
4. **兜底错误界面**：根路由增加 errorComponent，复用现有 404 页的导航布局与 `@saas/ui` 组件，文案进 messages；分享页使用同一界面。这是缺陷修复，沿用现有页面样式，不需要新设计稿。
5. **测试**：环境缺失插件绑定时预渲染首页 200、动态公开页正常、插件路由 503；已登录访客 `/_serverFn/` 请求在数据库抛错时不报错；根 loader 在 runtime 的 db/auth 抛错时仍然 resolve；`getAnnouncement` / `getSafeImpersonation` 的异常分支；admin 门禁对 `/administrator`、`/admin-x`、`/zh/admin` 的负例。

实施记录（第 5 组，2026-11-25）：
- 第 2 条的部署前检查：仓库已有 `scripts/check-plugins.mjs`（`pnpm check` 的一步）逐环境（顶层、`env.staging`、`env.production` 及其他 env）核对启用插件声明的 web / jobs 绑定名与种类，缺失即失败并指出环境与绑定名；没有在 `check-wrangler-envs.mjs` 中重复实现，只在 `scripts/check-plugins.test.mjs` 补了插件专用限流绑定在 production 缺失的用例。
- 运行时：`server/cloudflare/env.ts` 的 `pluginBindingStatus` 按插件校验清单绑定（同一 env 在 isolate 内只校验与记日志一次），结果作为 `WebRuntime.pluginStatus` 注入；入口用 `pluginUnavailable(runtime, id)` 检查（admin-mcp 在方法检查后、读令牌前返回 503；agents 的 `/agents/*` 前置处理返回 503；media 沿用 `ai.workflow` 能力不可用时的 503）。`/api/health` 增加 `plugins` 字段，只作展示，不改变整体状态码（插件不可用不等于站点不可用，避免触发整站告警）。
- 第 3 条：降级覆盖所有读取账号语言的请求（含应用区页面），应用区页面随后由自身数据读取报错并显示兜底错误界面。
- 第 4 条：根路由的 errorComponent 会替换整个根组件，所以另包一层 `RootDocument`；子路由用路由器的 `defaultErrorComponent`。分享页在渲染前的查找失败时不再直接返回 500 文本，而是继续渲染错误界面（`cache-control: no-store`），页面数据读取不重复查库。

## Risks / Trade-offs

- [上限过低导致积压] → 上限按 reduced profile 吞吐估算；`job.cap_reached` 日志可见，必要时调常量。积压只是延迟删除，不影响正确性。
- [DB 时钟取值增加查询] → 在已有的候选查询中一并取 `now()`，不新增往返，也不新增 cron 或轮询。
- [行时间区间过滤让坏数据永远不被清理] → 区间外行数会触发告警，由人工处理；这是有意为之的「宁可不删」。
- [插件绑定改为非整站必需后，漏配到线上才发现] → 部署前 `check-wrangler-envs` 硬校验；运行时插件路由 503 与健康检查可见。
- [同键限流重试拉长请求（最坏约 5.5 s）] → 只对该错误类别生效、次数少于临时错误；耗尽时日志单独标记，频繁出现说明有热点键，应改设计而不是加大重试。
- [R2 错误消息格式不确定] → 分类器同时识别数字码和名称；无法识别的错误一律不重试（保守）。
- [插件 cron 类型新增必填字段] → 模板内置插件无 cron，不受影响；衍生项目自有插件升级时补字段，升级说明列出。

## Migration Plan

无数据迁移。各组独立合并；第 1 组的 `defineBulkJob` 框架先合并，再改造各任务。上线后观察 staging 一周的 `job.cap_reached` 与 `ops.bulk_job.guard_tripped` 日志。回滚：任一组可单独 revert，不涉及 schema。升级说明（`docs/upgrades/`）记录插件 cron 的 `safety` 字段与插件绑定语义变化。

## 拍板结果（使用者 2026-11-25 确认）

| # | 事项 | 结论 |
|---|---|---|
| Q1 | 每轮上限数值 | 按 D2 表；上线一周后按日志调整 |
| Q2 | 插件绑定缺失的处理 | 只让该插件路由返回 503，部署前由 `check-wrangler-envs` 硬校验（D7 第 2 条） |
| Q3 | 同键写入过快（R2 10058 / KV 429） | 遵循官方文档：按指数退避有限次重试，与其他临时错误分开计数、次数更少（D6 参数表） |
| Q4 | 现有文档中的真账号数据 | 回填登记表时替换为占位符，原值留在私有证据库，不改写 git 历史 |
| Q5 | 时间下限 | `2024-01-01T00:00:00Z` |
| Q6 | 告警渠道 | 现有运维通知（Telegram/Discord），按任务 + UTC 日去重 |

## Open Questions

- Workers 每次调用的子请求上限（决定文件清理对象上限是否需要更低）：实施第 1 组时查 [Workers 限制](https://developers.cloudflare.com/workers/platform/limits/) 并在 `docs/bulk-jobs.md` 注明，不改变方案。
- ~~R2 绑定错误消息中错误码的确切格式~~：已确认为 message 末尾 `(码)`，见 D6（2026-11-25）。
