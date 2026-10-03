# 08 · 开发计划

每个阶段结束时都应该能部署到 staging 并完成验收。阶段内顺序即建议的实现顺序。

每个阶段对应一个 OpenSpec change（`openspec/changes/<name>/`），实现时用 `/opsx:apply <name>` 按其 `tasks.md` 推进，完成后归档：

| 阶段 | OpenSpec change |
|---|---|
| Phase 0 | `setup-scaffold-and-infra` |
| Phase 1 | `add-auth-and-workspaces` |
| Phase 2 | `add-billing-and-credits` |
| Phase 3 | `add-ai-text-chat` |
| Phase 4 | `add-ai-media-generation` |
| Phase 5 | `add-admin-console` |
| Phase 6 | `add-marketing-i18n-seo` |
| Phase 7 | `add-observability-and-optional-features` |

各阶段之间与阶段内部的并行拆分见 [09-parallel-plan.md](./09-parallel-plan.md)。

## Phase 0 · 脚手架与基础设施验证（技术风险最高，优先做）

- [ ] pnpm monorepo、Biome、TypeScript、Vitest 基础配置
- [ ] `apps/web`：TanStack Start 跑在 workerd（Cloudflare Vite 插件），本地 + 部署各一次
- [ ] `apps/jobs`：导出一个空 Workflow + Queue consumer + Cron，web 能通过绑定调用
- [ ] 本地 Docker PG + Drizzle + 第一个迁移
- [ ] VPS PG + Tunnel + Access + Hyperdrive，线上 Worker 查询成功；记录延迟基线（开/关 Smart Placement 对比）
- [ ] 验证 Hyperdrive 下的事务 + `SELECT ... FOR UPDATE` + `pg_advisory_xact_lock`
- [ ] 验证跨 Worker（`script_name`）的 Workflow 绑定与 `sendEvent`；确认 Workflow 尚未执行到 `waitForEvent` 时收到的事件是否被缓存
- [ ] 验证流式响应中客户端断开后，`waitUntil(consumeStream())` 能否完成结算
- [ ] VPS 上两个 `cloudflared` 副本，停掉其中一个时 Hyperdrive 查询不中断
- [ ] `template.config.ts` + env Zod 校验

**验收**：线上首页 SSR 正常；`/api/health` 返回 DB 往返耗时；jobs 的 Cron 能写库。

## Phase 1 · 认证与 Workspace

- [ ] Better Auth：邮箱密码、邮箱验证、找回密码、Google/GitHub OAuth、Turnstile
- [ ] KV secondaryStorage；认证接口限流
- [ ] Resend + React Email + EMAIL_QUEUE
- [ ] 注册自动创建个人空间；`withSession` / `withWorkspace` 中间件；`scoped()` 查询工具
- [ ] `multiTenant` 开关：团队空间创建、邀请、成员角色、空间切换器
- [ ] 平台 admin 角色与 `/admin` 入口骨架
- [ ] 用户设置：资料、语言、时区、修改密码、删除账号（软删 + 匿名化 + 退款申请提醒）
- [ ] 敏感操作直接查库校验会话；席位上限的并发控制

**验收**：两种开关模式下的注册 → 登录 → 邀请 → 切换空间流程均通过 e2e。

## Phase 2 · 计费与积分

- [ ] `plan` / `plan_price` 种子数据与同步脚本（Stripe、PayPal）
- [ ] `packages/credits`：grant / hold / capture / release / expire，含并发测试
- [ ] Stripe Provider：订阅 + 积分包 Checkout、Webhook、Portal
- [ ] PayPal Provider：Orders capture、Subscriptions、Webhook 验签、自建取消
- [ ] Webhook 通用管线（按投递去重、登记/处理分事务、失败记录、重放）
- [ ] 权益 `can()` / `limit()`（读取时计算生效状态）；free 档与注册赠送（验证后发放、防刷）
- [ ] 结账前置检查；换套餐 / 换平台的订阅重叠期
- [ ] 超额容忍与欠费（`credit_debt`）；三种计费方式的 estimate / actual
- [ ] 退款申请：用户发起、后台审核、调用平台退款、Webhook 回收积分
- [ ] Cron：积分过期、年付按月发放、hold 超时回收、订阅对账、积分对账不变式校验
- [ ] 页面：定价页、账单页、用量页

**验收**：两家测试环境下完成订阅（月付、年付）、续费（测试时钟 / 沙箱）、取消、积分包购买、退款；重复投递 Webhook 不重复发积分；首付只发一次积分；并发扣减不出现负数；PayPal 换套餐期间新旧订阅可并存；hold 在批次过期 / 被收回后释放，积分对账不变式仍成立。

## Phase 3 · AI 文本

- [ ] AI Gateway 接入；`ai_model` 注册表与后台编辑
- [ ] `/api/ai/chat` 流式 + hold/capture；按余额压低 maxOutputTokens；定价快照；中断结算
- [ ] 对话列表、对话页（`useChat`）、模型选择
- [ ] 权益检查与 AI 限流

**验收**：流式对话可用；积分流水与 AI Gateway 的 token 统计一致；中断、错误均正确结算。

## Phase 4 · AI 图片 / 视频

- [ ] `MediaProvider` + fal.ai 实现
- [ ] R2 预签名上传（上传后确认大小与配额）、`file` 表、鉴权下载
- [ ] `AiMediaWorkflow`：幂等提交 → 等待回调/轮询 → 转存 R2（大文件分片）→ 结算 → 通知
- [ ] 媒体回调入口（HMAC + 先落库再 sendEvent）
- [ ] 任务列表/详情页、参数表单（由 params_schema 渲染）
- [ ] 并发数限制（空间级事务锁）；卡住任务回收（查 Workflow 状态，超时 terminate）

**验收**：图片、视频各跑通一个模型；模拟回调丢失、回调早于 waitForEvent 两种情况都能完成；模拟提交响应丢失时不重复提交；失败任务积分全额退回；并发提交不超过 maxConcurrentTasks。

## Phase 5 · 管理后台

- [ ] 用户：搜索、封禁、模拟登录、调整积分
- [ ] 空间、订阅、订单、支付、Webhook 事件（查看/重放）、退款申请审核
- [ ] 模型与定价、系统设置（`setting` 表）
- [ ] 审计日志；业务指标看板（注册、付费、MRR、消耗、任务成功率）

## Phase 6 · 营销、内容、国际化、SEO

- [ ] 落地页区块：Hero、功能、定价、FAQ、评价、CTA、页脚（预渲染）
- [ ] Paraglide 多语言（页面、邮件、错误码）
- [ ] 博客（MDX）、法律页、可选文档站
- [ ] SEO：metadata、sitemap、robots、OG 图片、JSON-LD、hreflang
- [ ] 暗色模式与主题定制

## Phase 7 · 打磨与可选功能

- [ ] Sentry、结构化日志、Web Analytics
- [ ] 站内通知中心；内部通知（新订单 → Telegram/Discord）
- [ ] 公开 API（API Key、OpenAI 兼容接口）
- [ ] Waitlist、Newsletter
- [ ] `CLAUDE.md` / `AGENTS.md`：模块说明、约定、常用命令
- [ ] 「从模板创建新项目」的清单与脚本（改名、换配置、初始化基础设施）

## 待决事项

| # | 问题 | 选项 | 何时决定 |
|---|---|---|---|
| Q1 | 表单库 | TanStack Form / react-hook-form | Phase 0 |
| Q2 | 内容方案 | Fumadocs / content-collections | Phase 6 前 |
| Q3 | 产品分析 | PostHog / Umami / 不做 | Phase 7 |
| Q4 | 订阅积分是否结转 | 按套餐配置（默认不结转） | Phase 2 |
| Q5 | 升级时是否立即补发积分差额 | 配置项，默认否 | Phase 2 |
| Q6 | 退款时已消费积分的处理 | 默认不追溯 | Phase 2 |
| Q7 | 文本中断时的最低计费 | 按输入 token / 固定最低值（仅用于结算丢失的兜底；正常中断按完整 usage 结算） | Phase 3 |
| Q8 | 是否启用 RLS 加固 | 默认否 | Phase 1 |
| Q9 | Stripe 正式收款所需主体 | 注册海外主体 / 仅 PayPal 上线 / 接 MoR | 上线前 |
| Q10 | 超额容忍的默认额度（`billing.overage`） | 单次 20% / 50 分、空间每日 200 分，按实际误差数据调整 | Phase 3 |
