# 第三方登记表

本项目用到的每个第三方服务或产品各占一行，记录我们自动查询什么、需要使用者手动做什么、代码与文档位置、官方出处，以及上次核对的日期和方式。规则（见 AGENTS.md「编码与配置」）：

- 能通过 API 或 CLI 查询状态的，文档给出查询方式，而不是教手工步骤。
- 新写或修改第三方操作说明前先查官方文档，并在说明旁注明出处链接与核对日期。
- 真账号里看到的数据（账号 ID、余额、域名配置、部分密钥、截图）不进本仓库，只写入私有证据库，仓库中只引用。

列含义：

- **我们自动查询**：仓库中已有的脚本、CI 步骤、健康检查或技能里的只读命令；`—` 表示没有。
- **教使用者做的事**：文档要求人工在控制台完成的操作。
- **官方出处**：https 链接，或 `待核实`。本表所有出处链接于 2026-11-25 打开核对。
- **上次核对 / 验证方式**：最近一次核对该集成的日期与方式。验证方式只用四个值：
  `真账号`（在该第三方的真实账号、沙箱或测试模式中实际跑通）、`文档`（只按官方文档核对）、
  `模拟`（只有本地模拟、录制夹具或单元测试）、`未核对`（日期写 `—`）。
  仓库中找不到证据时标 `未核对`，不推测。

`pnpm check` 运行 `scripts/check-third-party.mjs` 检查本表格式，并要求每个受监视的第三方 SDK 依赖都在
`scripts/third-party-deps.json` 中映射到本表的一行（见文末「SDK 依赖登记」）。

## 登记表

| 第三方 | 我们自动查询 | 教使用者做的事 | 代码 / 文档位置 | 官方出处 | 上次核对 | 验证方式 |
|---|---|---|---|---|---|---|
| Stripe | `pnpm billing:sync` 读取价格；每日对账 Cron 读取订阅；`scripts/staging/check-secrets.mjs` 核对密钥名 | 创建产品价格、Webhook 端点与事件、Customer Portal；切换生产模式清单 | `packages/billing/src/stripe/`、`docs/05-billing.md`、`docs/runbooks/p2-payment-integration.md` | [Webhooks](https://docs.stripe.com/webhooks)、[API keys](https://docs.stripe.com/keys) | 2026-11-15 | 真账号 |
| PayPal | 同 Stripe 的同步与对账 Cron；Webhook 验签调用 PayPal API | 开发者控制台建 App、沙箱买卖家账号、注册 Webhook 并记录 Webhook ID | `packages/billing/src/paypal/`、`docs/05-billing.md`、`docs/runbooks/p2-payment-integration.md` | [Webhooks](https://developer.paypal.com/api/rest/webhooks/)、[沙箱](https://developer.paypal.com/sandbox-testing/overview) | 2026-10-18 | 真账号 |
| Cloudflare Workers | `scripts/staging/check-secrets.mjs`（`wrangler secret list`）、`scripts/staging/wait-healthy.mjs`（`/api/health` 与版本）、`scripts/production/check-wrangler-envs.mjs`（静态配置） | `wrangler secret put` 写入密钥；首次部署 | `apps/web/wrangler.jsonc`、`apps/jobs/wrangler.jsonc`、`docs/07-infrastructure.md` | [Limits](https://developers.cloudflare.com/workers/platform/limits/)、[Wrangler 命令](https://developers.cloudflare.com/workers/wrangler/commands/)、[Vite 环境选择](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/) | 2026-11-26 | 真账号 |
| Cloudflare Cache API 与 URL 清除 | Studio 在作品失效时检查清除 API 的 HTTP 状态和 `success` 字段 | 可选配置 Web 的 Zone ID 与 `Cache Purge` 令牌，用于跨机房清除旧版公开媒体 | `plugins/studio/src/worker/index.ts`、`plugins/studio/src/web/work-invalidation.ts`、[Studio 公开媒体](06-ai.md#studio-公开媒体) | [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)、[Purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/) | 2026-11-26 | 模拟 |
| Cloudflare R2 | `deploy-cloudflare` 技能：`wrangler r2 bucket list` | 部署解析可建应用桶。另需按用途配置 CORS、创建桶级 S3 令牌、备份桶 Bucket Lock | `packages/storage/src/cloudflare/`、`docs/07-infrastructure.md`、`docs/runbooks/restore.md` | [Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[CORS](https://developers.cloudflare.com/r2/buckets/cors/) | 2026-11-26 | 真账号 |
| Cloudflare KV | `deploy-cloudflare` 技能：`wrangler kv namespace list` | 部署解析按名称查找或创建，生成两个应用的部署配置 | `packages/platform/src/cloudflare/index.ts`、`packages/auth/src/session.ts`、`docs/04-auth-and-tenancy.md` | [Limits](https://developers.cloudflare.com/kv/platform/limits/) | 2026-11-26 | 真账号 |
| Cloudflare Queues | `deploy-cloudflare` 技能：`wrangler queues list` | 部署解析按配置名查找或创建 email / events 队列与死信队列 | `apps/jobs/src/queues/`、`packages/platform/src/cloudflare/queue.ts`、`docs/runbooks/production-neon.md` | [配置](https://developers.cloudflare.com/queues/configuration/configure-queues/)、[死信队列](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) | 2026-11-26 | 真账号 |
| Cloudflare Workflows | `deploy-cloudflare` 技能：`wrangler workflows list` | 无（随 jobs 部署创建） | `apps/jobs/wrangler.jsonc`、`packages/platform/src/cloudflare/workflow.ts`、`docs/06-ai.md` | [Workflows](https://developers.cloudflare.com/workflows/) | 2026-10-15 | 真账号 |
| Cloudflare Cron Triggers | `/api/health` 的 `jobs.lastCronAt`；`check-wrangler-envs.mjs` 静态核对调度档位 | 在控制台观察心跳与数据库用量 | `apps/jobs/src/cron/`、`apps/jobs/wrangler.jsonc`、`docs/runbooks/staging-neon.md` | [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) | 2026-10-13 | 真账号 |
| Cloudflare Hyperdrive | `deploy-cloudflare` 技能：`wrangler hyperdrive list`；健康检查 `db.up` | 按计划准备关缓存与开缓存的配置，部署解析按名称填入 ID | `packages/db/src/client.ts`、`docs/07-infrastructure.md`、`docs/runbooks/staging-neon.md` | [Hyperdrive](https://developers.cloudflare.com/hyperdrive/)、[Wrangler 命令](https://developers.cloudflare.com/hyperdrive/reference/wrangler-commands/) | 2026-11-26 | 真账号 |
| Cloudflare AI Gateway | — | 创建 Gateway、在 Provider Keys 存放服务商密钥（BYOK）、开启 Gateway 鉴权 | `packages/ai/src/text/model.ts`、`docs/06-ai.md`、`docs/07-infrastructure.md` | [AI Gateway](https://developers.cloudflare.com/ai-gateway/)、[BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) | 2026-11-26 | 真账号 |
| Cloudflare Workers AI | — | 无（绑定即可用；模型在后台配置） | `packages/ai/src/media/workers-ai.ts`、`docs/06-ai.md` | [Workers AI](https://developers.cloudflare.com/workers-ai/) | 2026-10-15 | 真账号 |
| Cloudflare Turnstile | `check-secrets.mjs` 核对密钥名；运行时调用 siteverify | 创建站点，填写允许的主机名与站点公开 key | `packages/auth/src/protection.ts`、`docs/04-auth-and-tenancy.md` | [服务端校验](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) | 2026-11-26 | 真账号 |
| Cloudflare Rate Limiting | `check-wrangler-envs.mjs` 静态核对 `namespace_id` 唯一 | 生成器按项目名分配整数命名空间，多项目在账号内核对号段 | `packages/platform/src/cloudflare/index.ts`、`apps/web/src/server/cloudflare/env.ts`、`docs/04-auth-and-tenancy.md` | [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) | 2026-11-26 | 真账号 |
| Cloudflare Tunnel 与 Workers VPC | — | 历史链路：建 Tunnel、运行 cloudflared、创建 Workers VPC 服务（现已改用 Neon） | `infra/local/docker-compose.yml`、`docs/07-infrastructure.md`、`docs/runbooks/selfhost-proxy.md` | [Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)、[Workers VPC](https://developers.cloudflare.com/workers-vpc/) | 2026-10-03 | 真账号 |
| Cloudflare Durable Objects 与 Agents SDK | — | 声明 DO 绑定与迁移标签；升级 SDK 时按升级说明操作 | `plugins/agents/`、`apps/web/wrangler.jsonc`、`docs/06-ai.md` | [Durable Objects](https://developers.cloudflare.com/durable-objects/)、[Agents](https://developers.cloudflare.com/agents/) | 2026-11-25 | 真账号 |
| Cloudflare Web Analytics | — | 填写 `analytics.cloudflareToken`（默认已改用 Plausible） | `apps/web/src/features/analytics/head.ts`、`docs/analytics.md` | [Web Analytics](https://developers.cloudflare.com/web-analytics/) | — | 未核对 |
| Cloudflare DNS 与自定义域名 | — | 添加 Zone、配置 `routes` 的 `custom_domain`、令牌权限 | `apps/web/wrangler.jsonc`、`docs/runbooks/production-neon.md` | [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) | 2026-11-26 | 真账号 |
| Neon | 健康检查 `db.up`；`scripts/production/verify-restore.mjs` 核对恢复库 | 控制台建项目、受限角色、预算与 PITR 设置、恢复分支 | `packages/db/src/client.ts`、`docs/runbooks/staging-neon.md`、`docs/runbooks/production-neon.md` | [Neon CLI](https://neon.com/docs/cli)、[API keys](https://neon.com/docs/manage/api-keys) | 2026-11-15 | 真账号 |
| fal.ai | — | 申请 `FAL_KEY` | `packages/ai/src/media/fal.ts`、`docs/06-ai.md` | [Queue API](https://fal.ai/docs/documentation/model-apis/inference/queue) | 2026-10-15 | 真账号 |
| DeepSeek | — | 申请 API Key，或存入 AI Gateway Provider Keys | `packages/ai/src/text/model.ts`、`docs/06-ai.md` | [API 文档](https://api-docs.deepseek.com/) | 2026-11-25 | 真账号 |
| OpenAI | — | 申请 API Key，或配置兼容端点 `OPENAI_BASE_URL` | `packages/ai/src/text/model.ts`、`docs/06-ai.md` | [API 参考](https://developers.openai.com/api/reference/overview) | 2026-10-17 | 模拟 |
| Anthropic | — | 申请 API Key，或存入 AI Gateway Provider Keys | `packages/ai/src/text/model.ts`、`docs/06-ai.md` | [API 概览](https://platform.claude.com/docs/en/api/overview) | 2026-10-15 | 模拟 |
| Google AI Studio | — | 申请 Gemini API Key（`GOOGLE_API_KEY`） | `packages/ai/src/text/model.ts`、`docs/06-ai.md` | [API keys](https://aistudio.google.com/docs/api-key) | 2026-10-15 | 模拟 |
| Resend | `check-secrets.mjs` 核对密钥名 | 添加发信域名并按控制台提示配置 DNS，等待 Verified | `packages/email/src/resend.ts`、`docs/04-auth-and-tenancy.md`、`docs/runbooks/production-neon.md` | [域名](https://resend.com/docs/dashboard/domains/introduction)、[查询域名](https://resend.com/docs/api-reference/domains/get-domain) | 2026-11-25 | 文档 |
| Google OAuth | `check-secrets.mjs` 核对密钥名 | 在 Google Cloud 创建 OAuth 客户端，登记回调 `/api/auth/callback/google` | `apps/web/src/features/auth/options.ts`、`packages/auth/src/env.ts`、`docs/04-auth-and-tenancy.md` | [Web 服务端 OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) | 2026-10-04 | 模拟 |
| GitHub OAuth | `check-secrets.mjs` 核对密钥名 | 在 Developer settings 创建 OAuth App，登记回调 `/api/auth/callback/github` | `apps/web/src/features/auth/options.ts`、`packages/auth/src/env.ts`、`docs/04-auth-and-tenancy.md` | [授权 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) | 2026-10-04 | 模拟 |
| Plausible | `scripts/staging/check-site-isolation.mjs`（发布后核对页面注入的站点，不调用 Plausible API） | 自建实例、添加站点与目标 | `packages/config/src/analytics.ts`、`apps/web/src/features/analytics/`、`docs/analytics.md` | [Community Edition](https://github.com/plausible/community-edition) | 2026-11-05 | 真账号 |
| Sentry | `scripts/sentry-probe.mjs`（发送事件后经 API 查询）；`scripts/sentry-node-maps.mjs` 上传 source map | 创建项目、取得 DSN 与 auth token | `apps/web/src/server/cloudflare/sentry.ts`、`docs/runbooks/sentry.md`、`docs/runbooks/sentry-node-adapter.md` | [Cloudflare SDK](https://docs.sentry.io/platforms/javascript/guides/cloudflare/)、[事件 API](https://docs.sentry.io/api/events/list-a-projects-error-events/) | 2026-10-16 | 真账号 |
| GitHub Actions 与 GHCR | `scripts/production/check-release.mjs`（`gh api` 查询发布 run）；`deploy/selfhost/images/registry.mjs`（GHCR manifest） | 配置 environments 与 secrets、发布审批 | `.github/workflows/`、`deploy/selfhost/images/`、`docs/ci.md` | [Environments API](https://docs.github.com/en/rest/deployments/environments)、[Container registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry) | 2026-10-18 | 真账号 |
| Telegram | — | 在后台「运维通知」填写 Bot token 与 chat ID | `apps/jobs/src/notifications/operations.ts`、`packages/db/src/settings.ts` | [Bot API](https://core.telegram.org/bots/api) | 2026-10-14 | 模拟 |
| Discord | — | 在后台「运维通知」填写 Webhook URL | `apps/jobs/src/notifications/operations.ts`、`packages/db/src/settings.ts` | [Webhook](https://docs.discord.com/developers/resources/webhook) | 2026-10-14 | 模拟 |
| 汇率源 open.er-api.com | — | 无（免密钥）；页面须保留来源署名 | `packages/shared/src/fx.ts`、`docs/05-billing.md` | [免费接口说明](https://www.exchangerate-api.com/docs/free) | 2026-11-16 | 模拟 |
| IndexNow | `scripts/production/submit-indexnow.mjs`（生产发布后提交，失败不阻塞） | 配置 IndexNow key；自托管手动运行提交 | `apps/web/src/routes/indexnow[.]txt.ts`、`docs/analytics.md` | [文档](https://www.indexnow.org/documentation) | 2026-11-05 | 模拟 |
| PostHog | — | 填写项目 key 与 host（默认关闭） | `apps/web/src/features/analytics/client.ts`、`docs/analytics.md` | [JS 库](https://posthog.com/docs/libraries/js) | 2026-10-14 | 模拟 |
| Microsoft Clarity | — | 填写 `clarityProjectId` 并更新隐私政策（默认关闭） | `apps/web/src/features/analytics/track.ts`、`docs/analytics.md` | [手动接入](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-setup) | 2026-11-05 | 模拟 |
| Caddy 与 ACME | Caddy 容器健康检查（管理端口） | 域名解析到主机、选择 ACME 或已有代理 | `deploy/selfhost/Caddyfile`、`deploy/selfhost/README.md`、`docs/runbooks/selfhost-proxy.md` | [Automatic HTTPS](https://caddyserver.com/docs/automatic-https) | 2026-10-16 | 真账号 |
| SMTP | — | 填写 SMTP 主机、端口与凭据 | `packages/email/src/node/smtp.ts`、`packages/config/src/node-schema.ts` | [SMTP transport](https://nodemailer.com/smtp) | 2026-10-17 | 模拟 |
| S3 兼容对象存储 | `deploy/selfhost/object-storage-health.sh`（内置 SeaweedFS） | 外部 S3 / R2：创建桶与访问密钥并填写端点 | `packages/storage/src/node/client.ts`、`deploy/selfhost/README.md`、[Studio 公开媒体](06-ai.md#studio-公开媒体) | [R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)、[SeaweedFS S3](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API)、[S3 GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html) | 2026-11-26 | 文档 |
| WAL-G | `deploy/selfhost/backup/backup.py`（`wal-g backup-list`，作为健康检查） | 配置备份桶与密钥、执行恢复演练 | `deploy/selfhost/backup/`、`docs/runbooks/selfhost-backup.md`、`docs/runbooks/selfhost-restore.md` | [PostgreSQL](https://wal-g.readthedocs.io/PostgreSQL/) | 2026-10-16 | 真账号 |
| Redis 与 Valkey | `deploy/selfhost/valkey-health.sh`；Node `/api/health` 缓存探测 | 无（随自托管栈启动） | `packages/platform/src/node/cache.ts`、`deploy/selfhost/README.md`、`docs/platform-node-adapters.md` | [Valkey](https://valkey.io/docs/) | 2026-10-16 | 真账号 |

<!-- template-only:start -->
## 核对依据（模板）

日期来自仓库文档与已归档 change，原始记录在私有证据库。本次回填（2026-11-25）没有新跑真账号验收。
`模拟` 行的日期取引入对应单测或夹具的 change 的归档日。

- Stripe：2026-11-15 staging 测试模式购买（`add-billing-coexistence` 4.3）；完整矩阵 2026-10-09。
- PayPal：2026-10-18 沙箱月付、年付首付与退款（`docs/05-billing.md`）；自然续费未验证，交给衍生项目。
- Cloudflare Workers：staging 持续自动部署，最近有日期的记录为 2026-11-15。
- R2、Hyperdrive、Sentry、DNS 与自定义域名：2026-10-16 生产演示实例（已于 2026-10-18 拆除）。
- KV：2026-10-04 staging 会话存储；Queues：2026-10-09 staging 支付回调经 events 队列。
- Workflows、Workers AI、AI Gateway、fal.ai：2026-10-15 前后的 staging 媒体与对话验收。
- Cron Triggers：2026-10-13 起 staging reduced 调度。Turnstile：2026-10-09 staging 注册冒烟使用真实令牌。
- Rate Limiting：2026-10-25 与 2026-11-12 实测线上绑定不拒绝（挂起事项，见路线图），结论为「集成已核对，平台行为异常」。
- Tunnel 与 Workers VPC：2026-10-03 探针，资源已于 2026-10-10 删除，仅作历史。
- Durable Objects 与 Agents SDK、DeepSeek：`add-ai-agents` 9.3 staging 真实模型验收；仓库没有运行日期，取该 change 归档日 2026-11-25。
- Neon：staging 库持续使用，最近有日期的只读核对为 2026-11-15。
- Plausible：2026-11-05 模板 staging；衍生项目 2026-11-12 生产双站另有记录。
- GitHub Actions 与 GHCR：最近记录的发布 run 为 2026-10-18。
- Caddy 与 ACME、S3 兼容对象存储（外部 R2）、WAL-G、Valkey：2026-10-16 自托管服务器实机验收。
- Resend：2026-10-16 只用 DoH 核对了 DNS 记录，没有真实发送记录，因此标 `文档`（按官方文档于 2026-11-25 核对）。
- OpenAI：只有本地兼容 SSE 夹具（`add-selfhost-foundation`）；Anthropic、Google AI Studio：只有模型构造与能力单测（`add-ai-text-chat`）。
- Google / GitHub OAuth：P1 只做了 mock 回调。Telegram、Discord、PostHog：`add-observability-and-optional-features` 的单测与 e2e。
- 汇率源：`add-fx-rates` 单测（真实接口任务未勾选）；IndexNow、Clarity：`add-analytics-plausible-geo` 单测。SMTP：自托管 SMTP 捕获夹具。
- Cloudflare Web Analytics：没有真账号或测试记录。

### 已脱敏的现有文档

按 add-ops-safeguards 拍板 Q4，以下文档中的 Cloudflare 账号与 Zone ID、Neon 组织/项目/endpoint/分支 ID、Stripe 沙箱账号与对象 ID、PayPal 订阅与资源 ID
已替换为占位符（同一原值在各文件中使用同一占位符），原值对照表在私有证据库 `saas-template-evidence:add-ops-safeguards/third-party/redaction-map-2026-11-25.json`，git 历史不改写：
`docs/05-billing.md`、`docs/runbooks/` 下的 `p2-acceptance-stripe.md`、`p2-acceptance-paypal.md`、`p2-payment-integration.md`、
`p2-staging-preparation.md`、`staging-neon.md`、`production-neon.md`、`hyperdrive-tunnel.md`，以及两个已归档 change 的 `tasks.md`。
wrangler 配置中部署必需的资源 ID 与录制夹具（`packages/billing/src/*/fixtures/recorded/`）不在本次范围。
<!-- template-only:end -->

## 可改为自动查询

以下状态目前靠人工核对，但官方提供了查询接口，后续可写成只读检查脚本（本表只记录，不在本次实现）：

| 第三方 | 可查询的状态 | 接口 |
|---|---|---|
| Stripe | Webhook 端点 URL、启用的事件与状态 | [`GET /v1/webhook_endpoints`](https://docs.stripe.com/api/webhook_endpoints/list) |
| PayPal | 已注册 Webhook 与订阅事件 | [Webhooks Management v1 · List webhooks](https://developer.paypal.com/api/webhooks/v1) |
| Resend | 发信域名验证状态 | [Retrieve Domain](https://resend.com/docs/api-reference/domains/get-domain) |
| Cloudflare Hyperdrive | 配置的源站与缓存设置 | [`wrangler hyperdrive get`](https://developers.cloudflare.com/hyperdrive/reference/wrangler-commands/) |
| Cloudflare R2 | 桶的 CORS 规则 | [`wrangler r2 bucket cors list`](https://developers.cloudflare.com/r2/reference/wrangler-commands/) |
| GitHub Actions | environments、保护规则与 secrets 名称 | [Environments API](https://docs.github.com/en/rest/deployments/environments) |
| Sentry | 项目最近事件与 release | [事件 API](https://docs.sentry.io/api/events/list-a-projects-error-events/) |
| Neon | 项目、分支与计算设置 | [Neon CLI](https://neon.com/docs/cli) |
| 运维通知（Telegram / Discord） | 渠道配置是否可投递 | 后台测试发送（待实现） |

## SDK 依赖登记

`scripts/third-party-deps.json` 维护「受监视的依赖名模式 → 本表的行」：

- `watch`：受监视的依赖名正则（如 `^stripe$`、`^@ai-sdk/`、`^@aws-sdk/`、`^@sentry/`）。
- `packages`：依赖名 → 本表「第三方」列的名称。
- `ignore`：匹配受监视模式但不连接第三方服务的依赖，必须写原因（如只提供前端 hooks 的 `@ai-sdk/react`）。

任何 workspace 的 `package.json` 新增匹配 `watch` 的依赖而不在 `packages` 或 `ignore` 中时，`pnpm check` 失败；
新增第三方时先在本表加行，再加映射。
