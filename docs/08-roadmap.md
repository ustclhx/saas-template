# 08 · 开发计划

每个阶段结束时都应该能部署到 staging 并完成验收。阶段内顺序即建议的实现顺序。

每个阶段对应一个 OpenSpec change（`openspec/changes/<name>/`），实现时用 `/opsx:apply <name>` 按其 `tasks.md` 推进，完成后归档：

| 阶段 | OpenSpec change |
|---|---|
| Phase 0 | `setup-scaffold-and-infra`（已归档） |
| Phase 1 | `add-auth-and-workspaces`（已归档：`archive/2026-10-04-add-auth-and-workspaces`） |
| Phase 2 | `add-billing-and-credits` |
| Phase 3 | `add-ai-text-chat` |
| Phase 4 | `add-ai-media-generation` |
| Phase 5 | `add-admin-console` |
| Phase 6 | `add-marketing-i18n-seo` |
| Phase 7 | `add-observability-and-optional-features` |

各阶段之间与阶段内部的并行拆分见 [09-parallel-plan.md](./09-parallel-plan.md)。

**基础设施节奏**（`docs/07` §0）：Phase 0–3 在**阶段一**完成——数据库在开发者本机，staging 部署到 `*.workers.dev`，不需要域名，不做备份。Phase 3 完成即达到**最小原型**（可注册登录、开通套餐或购买积分、进行一次计费正确的 AI 对话），之后执行下文的「生产迁移」进入阶段二，再继续 Phase 4 及以后。

## Phase 0 · 脚手架与基础设施验证（技术风险最高，优先做）

- [x] pnpm monorepo、Biome、TypeScript、Vitest 基础配置
- [x] `apps/web`：TanStack Start 跑在 workerd（Cloudflare Vite 插件），本地 + 部署各一次（staging：`web-staging.saas-jobs.workers.dev`）
- [x] `apps/jobs`：导出一个空 Workflow + Queue consumer + Cron，web 能通过绑定调用
- [x] 本地 Docker PG + Drizzle + 第一个迁移
- [x] 本机 PG（TLS）+ `cloudflared` + Tunnel + Workers VPC + Hyperdrive，部署到 `*.workers.dev` 的 Worker 查询成功；记录延迟基线（开/关 Smart Placement 对比，仅验证链路）——复用连接约 160 ms（LAX），Smart Placement 无效果（`07` §8）
- [x] 验证 Hyperdrive 下的事务 + `SELECT ... FOR UPDATE` + `pg_advisory_xact_lock`——可用，锁在提交 / 回滚 / Worker 中断后都释放（`07` §2）
- [x] 验证跨 Worker（`script_name`）的 Workflow 绑定与 `sendEvent`；确认 Workflow 尚未执行到 `waitForEvent` 时收到的事件是否被缓存——可用，提前发出的事件至少保留 60 分钟；事件类型不能含 `.`（`06` §4）
- [x] 验证流式响应中客户端断开后，`waitUntil(consumeStream())` 能否完成结算——可以，但限于断开后 30 秒，超时静默取消（`06` §3，P3 需按建议处理）
- [x] 本机两个 `cloudflared` 副本，停掉其中一个时 Hyperdrive 查询不中断——会自动切换，但有约 5–10 秒卡顿与少量失败，不是无感（`07` §2）
- [x] `template.config.ts` + env Zod 校验

**验收**：staging（`*.workers.dev`）首页 SSR 正常；`/api/health` 返回 DB 往返耗时；jobs 的 Cron 能写库。——已通过（2026-10-03，`web-staging.saas-jobs.workers.dev`）。CI 自动部署 staging（原任务 6.2）已移到下文「CI 能力建设（待办）」。

**Phase 0 实测对后续阶段的影响**：
- P3（文本对话）：客户端断开后服务端只能再运行 30 秒，长回复可能来不及结算；已决定采用「用量检查点」（`06` §3，已写入 `add-ai-text-chat`），兜底按检查点用量而不是最低费用结算。
- P4（媒体）：事件类型改用 `media-done` 常量（已改示意代码）；`check-callback` 可删去，保留 `recheck-callback`（`06` §4）。
- 阶段二（生产迁移）：`cloudflared` 副本分故障域部署、告警阈值与重试策略按 `07` §2 的建议；在生产服务器上重测延迟基线与副本切换；评估显式放置替代 Smart Placement。

## Phase 1 · 认证与 Workspace

- [x] Better Auth：邮箱密码、邮箱验证、找回密码、Google/GitHub OAuth、Turnstile
- [x] KV secondaryStorage；认证接口限流
- [x] Resend + React Email + EMAIL_QUEUE
- [x] 注册自动创建个人空间；`withSession` / `withWorkspace` 中间件；`scoped()` 查询工具
- [x] `multiTenant` 开关：团队空间创建、邀请、成员角色、空间切换器
- [x] 平台 admin 角色与 `/admin` 入口骨架
- [x] 用户设置：资料、语言、时区、修改密码、删除账号（软删 + 匿名化；默认不退款与客服入口，退款申请提醒在 P2 接入）
- [x] 敏感操作直接查库校验会话；席位上限的并发控制

**验收进度（2026-10-04）**：本地两种开关模式下的注册 → 邮箱验证 → 登录 → 邀请 → 切换空间流程均通过 e2e，包含团队删除、账号匿名化和旧会话吊销；关闭团队为 12 passed / 1 skipped（魔法链接关闭），开启团队与魔法链接为 13 passed。staging 已完成现有认证迁移、测试密钥上传与 web / jobs 部署；线上认证 / 模拟 OAuth 回调为 9 passed / 1 skipped，log 邮件队列、新 Cron 与删除后旧会话拒绝均已验证。邀请邮件队列接线回归也已通过，OpenSpec 为 25/25。OAuth 入口与回调策略通过模拟外部交换验证，尚未使用真实提供方凭据验收。

**P1 阶段边界与后续接入**：三项正式规格已同步，25/25 任务已归档。真实 OAuth 与 Resend 发送暂保持 mock/log；P2 接入套餐席位、验证赠送、删号退款提醒、订阅取消与积分收回；P3/P4 接入 AI 内容与存储清理。CI 自动部署 staging 仍是单列待办，当前继续手动部署。

## Phase 2 · 计费与积分

**开发进度（2026-10-04）**：OpenSpec 已验收 12/34。已完成数据模型、积分发放/预扣/结算/超额欠费、支付统一契约、权益与真实席位限制；Stripe 完整适配器及 PayPal 操作/快照已通过 120 项离线支付测试，尚未取得真实回调录制。下一步完成积分查询与对账、Webhook 管线和 PayPal 验签映射，再接入结账、退款、Cron 与页面。按当前授权，先完成开发，随后才配置 Stripe 测试与 PayPal 沙箱凭据；真实价格同步、测试卡支付和 staging 验收保留未完成。

- [ ] `plan` / `plan_price` 种子数据与同步脚本（Stripe、PayPal）
- [ ] `packages/credits`：grant / hold / capture / release / expire，含并发测试
- [ ] Stripe Provider：订阅 + 积分包 Checkout、Webhook、Portal
- [ ] PayPal Provider：Orders capture、Subscriptions、Webhook 验签、自建取消
- [ ] Webhook 通用管线（按投递去重、登记/处理分事务、失败记录、重放）
- [ ] 权益 `can()` / `limit()`（读取时计算生效状态）；free 档与注册赠送（验证后发放、防刷）
- [ ] 结账前置检查；换套餐 / 换平台的订阅重叠期
- [ ] 超额容忍与欠费（`credit_debt`）；只处理积分数量，AI 的 estimate / actual 在 P3 实现
- [ ] 退款申请：用户发起、后台审核、调用平台退款、Webhook 回收积分
- [ ] Cron：积分过期、年付按月发放、hold 超时回收、订阅对账、积分对账不变式校验
- [ ] 页面：定价页、账单页、用量页

**验收**：两家测试环境下完成订阅（月付、年付）、续费（测试时钟 / 沙箱）、取消、积分包购买、退款；重复投递 Webhook 不重复发积分；首付只发一次积分；并发扣减不出现负数；PayPal 换套餐期间新旧订阅可并存；hold 在批次过期 / 被收回后释放，积分对账不变式仍成立。

## Phase 3 · AI 文本

- [ ] AI Gateway 接入；`ai_model` 注册表与后台编辑；三种计费方式的 estimate / actual
- [ ] `/api/ai/chat` 流式 + hold/capture；按余额压低 maxOutputTokens；定价快照；中断结算
- [ ] 对话列表、对话页（`useChat`）、模型选择
- [ ] 权益检查与 AI 限流

**验收**：流式对话可用；积分流水与 AI Gateway 的 token 统计一致；中断、错误均正确结算。

## CI 能力建设（待办）

从 Phase 0 移出（原 `setup-scaffold-and-infra` 任务 6.2），在专门建设 CI 时补齐：

- [ ] main 流水线自动部署 staging：部署 jobs → 部署 web（`*.workers.dev`），验证合并后 staging 上的版本号更新。前置：在 Cloudflare 创建 API Token（至少 Workers Scripts 编辑权限，按需加 Queues、Workflows、Hyperdrive 读取），存入 GitHub Actions Secrets；CI 不能使用 wrangler 的 OAuth 登录。
- [ ] 阶段一 staging 迁移仍由开发者在本机执行（`docs/07` §5）；阶段二再让 CI 经 Tunnel 执行迁移（见下文「生产迁移」）。

在此之前，staging 由开发者在本机执行 `pnpm --filter @saas/jobs deploy:staging` 与 `pnpm --filter @saas/web deploy:staging` 部署。

## 生产迁移 · 进入阶段二（最小原型完成后）

暂不建 OpenSpec change，先在这里登记，进入阶段二时再拆成 change：

- [ ] 生产服务器：按 `infra/postgres` 部署 PG 17 + 两个 `cloudflared` 副本，Workers VPC 指向新服务器，证书改为受信任并开启校验
- [ ] 备份（原 P0 任务 5.3）：WAL-G 基础备份与 WAL 归档到 R2（需先开通 R2，开启 Bucket Lock）
- [ ] 异地第二副本（待办）：每日同步到非 Cloudflare 对象存储（存储选型待定）
- [ ] 恢复演练（原 P0 任务 5.4）：在临时实例恢复到指定时间点并跑校验脚本，写 `docs/runbooks/restore.md`，核对 RTO
- [ ] 域名：staging 与 production 绑定自定义域名（可先用已有 Zone 的子域名，如 `ezarouter.cc` 的子域）
- [ ] CI 迁移：为 PG 配置公网主机名 + Access（或 SSH），main 流水线执行 staging 迁移
- [ ] tag 流水线（原 P0 任务 6.3）：生产迁移 → 部署 jobs → 部署 web → `/api/health` 冒烟测试
- [ ] 在生产服务器上重测 P0 的延迟基线与 `cloudflared` 副本切换

**验收**：production 绑定域名可访问；备份可恢复；从 staging 合并到 tag 发布的全流程自动化。

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
| Q1 | 表单库 | 已决定并接入：TanStack Form + Zod | Phase 1（已决定） |
| Q2 | 内容方案 | Fumadocs / content-collections | Phase 6 前 |
| Q3 | 产品分析 | PostHog / Umami / 不做 | Phase 7 |
| Q4 | 订阅积分是否结转 | 已按设计确定：按套餐配置，默认不结转 | Phase 2（待实测） |
| Q5 | 升级时是否立即补发积分差额 | 已按设计确定：默认不立即补发 | Phase 2（待实测） |
| Q6 | 退款时已消费积分的处理 | 已按设计确定：默认不追溯 | Phase 2（待实测） |
| Q7 | 文本中断时的最低计费 | 按输入 token / 固定最低值（仅在结算丢失且没有用量检查点时使用；有检查点按检查点结算，正常中断按完整 usage 结算） | Phase 3 |
| Q8 | 是否启用 RLS 加固 | 已决定：默认否；P1 使用 scoped() + lint + 实时成员校验 | Phase 1（已决定） |
| Q9 | Stripe 正式收款所需主体 | 注册海外主体 / 仅 PayPal 上线 / 接 MoR | 上线前 |
| Q10 | 超额容忍的默认额度（`billing.overage`） | 单次 20% / 50 分、空间每日 200 分，按实际误差数据调整 | Phase 3 |
