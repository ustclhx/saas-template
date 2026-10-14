# 08 · 开发计划

每个阶段结束时都应该能部署到 staging 并完成验收。阶段内顺序即建议的实现顺序。

**进度基线（2026-10-12，main `cca3f17` / #104）**：以下状态已核对 `openspec list --json`、各 change 的 `tasks.md`、归档与 main 已合并 PR。功能项勾选表示对应任务的实现与规定验证已完成；阶段整体验收另列，代码合并或本地模拟通过不替代 staging 验收。进行中的其他 worktree 不计入完成项。

每个阶段对应一个 OpenSpec change（`openspec/changes/<name>/`），实现时用 `/opsx:apply <name>` 按其 `tasks.md` 推进，全部验收完成后由协调者归档：

| 阶段 | OpenSpec change | 已验收任务 / 状态 |
|---|---|---|
| Phase 0 | `setup-scaffold-and-infra` | 26/26；已归档：`archive/2026-10-04-setup-scaffold-and-infra` |
| Phase 1 | `add-auth-and-workspaces` | 25/25；已归档：`archive/2026-10-04-add-auth-and-workspaces`（#22） |
| Phase 2 | `add-billing-and-credits` | 32/34；3.3、11.1 待办；10.4 实测文档与策略核对已完成 |
| Phase 3 | `add-ai-text-chat` | 16/17；staging 5.1 待办 |
| Phase 4 | `add-ai-media-generation` | 20/22；staging 7.1/7.2 待办 |
| Phase 5 | `add-admin-console` | 13/14；staging 6.1 待办 |
| Phase 6 | `add-marketing-i18n-seo` | 16/16；已归档：`archive/2026-10-11-add-marketing-i18n-seo`（#86） |
| Phase 7 | `add-observability-and-optional-features` | 15/16；staging Sentry 1.2 待办，6.1 已完成（#100） |

另有 `add-cloud-staging-neon` 29/29，已归档（#85）；`add-first-run-admin-setup` 6/6，已合并但尚未归档（#101），其 staging 配置与外部验收边界见 Phase 5；`add-payment-live-mode` 9/9，已合并但尚未归档（#104），生产凭据与外部收款验收仍待办。

各阶段之间与阶段内部的并行拆分见 [09-parallel-plan.md](./09-parallel-plan.md)。

**基础设施节奏**（`docs/07` §0）：当前仍在**阶段一**——本地开发使用各 worktree 的隔离 Docker PG 数据库，线上 staging 使用 Neon 并部署到 `*.workers.dev`，不需要域名，不做备份。Phase 2/3 完整验收后达到**最小原型**（可注册登录、开通套餐或购买积分、进行一次计费正确的 AI 对话），再执行下文的「生产迁移」进入阶段二。Phase 4–7 的开发已按依赖提前推进，完成实现不代表生产迁移已执行。

## Phase 0 · 脚手架与基础设施验证（技术风险最高，优先做）

- [x] pnpm monorepo、Biome、TypeScript、Vitest 基础配置（`setup-scaffold-and-infra` 1.1–1.4）
- [x] `apps/web`：TanStack Start 跑在 workerd（Cloudflare Vite 插件），本地 + 部署各一次（staging：`web-staging.saas-jobs.workers.dev`；#3、P0 5.5）
- [x] `apps/jobs`：导出一个空 Workflow + Queue consumer + Cron，web 能通过绑定调用（#5）
- [x] 本地 Docker PG + Drizzle + 第一个迁移（#4）
- [x] 本机 PG（TLS）+ `cloudflared` + Tunnel + Workers VPC + Hyperdrive，部署到 `*.workers.dev` 的 Worker 查询成功；记录延迟基线（开/关 Smart Placement 对比，仅验证链路）——复用连接约 160 ms（LAX），Smart Placement 无效果（#9、P0 5.1/5.2；`07` §8）。这是历史链路验证，旧资源已在 Neon 9.2 收尾时删除。
- [x] 验证 Hyperdrive 下的事务 + `SELECT ... FOR UPDATE` + `pg_advisory_xact_lock`——可用，锁在提交 / 回滚 / Worker 中断后都释放（#6；`07` §2）
- [x] 验证跨 Worker（`script_name`）的 Workflow 绑定与 `sendEvent`；确认 Workflow 尚未执行到 `waitForEvent` 时收到的事件是否被缓存——可用，提前发出的事件至少保留 60 分钟；事件类型不能含 `.`（#8；`06` §4）
- [x] 验证流式响应中客户端断开后，`waitUntil(consumeStream())` 能否完成结算——可以，但限于断开后 30 秒，超时静默取消（#7；`06` §3，P3 已接入检查点与兜底）
- [x] 本机两个 `cloudflared` 副本，停掉其中一个时 Hyperdrive 查询不中断——会自动切换，但有约 5–10 秒卡顿与少量失败，不是无感（#10；`07` §2）
- [x] `template.config.ts` + env Zod 校验（#2、#5）

**验收**：staging（`*.workers.dev`）首页 SSR 正常；`/api/health` 返回 DB 往返耗时；jobs 的 Cron 能写库。——已通过（2026-10-03，`web-staging.saas-jobs.workers.dev`）。CI 自动部署 staging（原任务 6.2）已移到下文「CI 能力建设」。

**Phase 0 实测对后续阶段的影响**：

- P3（文本对话）：客户端断开后服务端只能再运行 30 秒，长回复可能来不及结算；已决定采用「用量检查点」（`06` §3，已写入 `add-ai-text-chat`），兜底按检查点用量而不是最低费用结算。
- P4（媒体）：事件类型使用 `@saas/shared` 的 `MEDIA_DONE_EVENT = 'media-done'`；保留等待前 `check-callback` 与超时后 `recheck-callback`，结果以已落库回调为准，事件只用于唤醒（#73；`06` §4）。
- 阶段二（生产迁移）：`cloudflared` 副本分故障域部署、告警阈值与重试策略按 `07` §2 的建议；在生产服务器上重测延迟基线与副本切换；评估显式放置替代 Smart Placement。

## Phase 1 · 认证与 Workspace

- [x] Better Auth：邮箱密码、邮箱验证、找回密码、Google/GitHub OAuth 接口与模拟回调、Turnstile（#15、#20；真实 OAuth 提供方交换不在 P1 验收声明内）
- [x] KV secondaryStorage；认证接口限流（#15）
- [x] Resend 适配器 + React Email + EMAIL_QUEUE（#11、#14、#21；P1 外部投递仍为 mock/log 验收）
- [x] 注册自动创建个人空间；`withSession` / `withWorkspace` 中间件；`scoped()` 查询工具（#13、#16）
- [x] `multiTenant` 开关：团队空间创建、邀请、成员角色、空间切换器（#20）
- [x] 平台 admin 角色与 `/admin` 入口骨架（#17）
- [x] 用户设置：资料、语言、时区、修改密码、删除账号（软删 + 匿名化；默认不退款与客服入口，退款申请提醒已在 P2 接入；#17、#20、#24）
- [x] 敏感操作直接查库校验会话；席位上限的并发控制（#15、#20）

**验收进度（2026-10-04）**：本地两种开关模式下的注册 → 邮箱验证 → 登录 → 邀请 → 切换空间流程均通过 e2e，包含团队删除、账号匿名化和旧会话吊销；关闭团队为 12 passed / 1 skipped（魔法链接关闭），开启团队与魔法链接为 13 passed。staging 已完成现有认证迁移、测试密钥上传与 web / jobs 部署；线上认证 / 模拟 OAuth 回调为 9 passed / 1 skipped，log 邮件队列、新 Cron 与删除后旧会话拒绝均已验证。邀请邮件队列接线回归也已通过，OpenSpec 为 25/25。OAuth 入口与回调策略通过模拟外部交换验证，尚未使用真实提供方凭据验收。

**P1 阶段边界与后续接入**：三项正式规格已同步，25/25 任务已归档。P1 的真实 OAuth 提供方交换与 Resend 外部发送不在当时 mock/log 验收声明内；后续接入与验收进度分别见 P2–P4。当时 CI 自动部署 staging 仍是单列待办，采用手动部署；当前完成情况见下文「CI 能力建设」。

## Phase 2 · 计费与积分

**进度（2026-10-12）**：OpenSpec 31/34。离线实现与组合验收已完成（#24）；两平台测试凭据已配置，10 条报价同步及幂等复验通过（1.3）。Stripe 真实录制夹具、测试卡订阅/积分包、测试时钟续费与平台退款已验收（#63、#71）。PayPal 积分包 capture 与重复事件、月付首付、取消/恢复已取得有限沙箱证据（#82、#90），但自然续费、年付、换套餐、退款及完整录制矩阵仍待办。3.3、10.4、11.1 保持未完成，见 [支付联通 runbook](./runbooks/p2-payment-integration.md) 与 [Stripe 验收](./runbooks/p2-acceptance-stripe.md)。

- [x] `plan` / `plan_price` 种子数据与同步脚本（Stripe、PayPal；billing 1.3，两平台同步两次、映射稳定且 active，证据见支付联通 runbook）
- [x] `packages/credits`：grant / hold / capture / release / expire，含并发测试（#24、#27）
- [x] Stripe Provider：订阅 + 积分包 Checkout、Webhook、Portal（#71；billing 3.2）
- [ ] PayPal Provider：Orders capture、Subscriptions、Webhook 验签、自建取消；代码已合并，8 条真实 Sandbox 回调录制已覆盖一次性付款、月付首付、暂停/恢复及独立测试卡 Capture 全额退款；自然续费、Sale 退款与 Capture 部分退款录制等仍待办（#82、#90；billing 3.3；见 [05 §2](./05-billing.md#2-支付-provider-抽象)）。
- [x] Webhook 通用管线（按投递去重、登记/处理分事务、失败记录、重放；#24、#28）
- [x] 权益 `can()` / `limit()`（读取时计算生效状态）；free 档与注册赠送（验证后发放、防刷；#24）
- [x] 结账前置检查；换套餐 / 换平台的订阅重叠期（#24；完整平台验收见 11.1）
- [x] 超额容忍与欠费（`credit_debt`）；只处理积分数量，AI 的 estimate / actual 已在 P3 实现（#24、#32）
- [x] 退款申请：用户发起、后台审核、调用平台退款、Webhook 回收积分（#24；真实管理员审核验收仍见 11.1）
- [x] Cron：积分过期、年付按月发放、hold 超时回收、订阅对账、积分对账不变式校验（#24）
- [x] 页面开发与规定验收：定价/回跳、账单/用量、最小计费后台；Stripe 测试卡支付已通过（#24、#63、#71；billing 10.1–10.3）
- [x] 支付实测文档与 Q4/Q5/Q6 实现核对（billing 10.4，2026-10-15）：记录真实 Sandbox 事件差异、录制来源、已通过与仍待验证的边界；Q4/Q5/Q6 的已实现策略不等于完整平台矩阵通过。协调者继续负责 3.3 与 11.1。
- [ ] **阶段验收（billing 11.1）**：两家测试环境下完成订阅（月付、年付）、续费（测试时钟 / 沙箱）、取消、积分包购买、退款；重复投递 Webhook 不重复发积分；首付只发一次积分；并发扣减不出现负数；PayPal 换套餐期间新旧订阅可并存；hold 在批次过期 / 被收回后释放，积分对账不变式仍成立。Stripe 管理员部分退款审核与 PayPal 完整矩阵仍待验收。

## Phase 3 · AI 文本

- [x] AI Gateway 接入；`ai_model` 注册表与后台编辑；三种计费方式的 estimate / actual（#32、#33、#91；DeepSeek 真实本地调用通过）
- [x] `/api/ai/chat` 流式 + hold/capture；按余额压低 maxOutputTokens；定价快照；中断结算（#38、#40、#84、#89）
- [x] 对话列表、对话页（`useChat`）、模型选择（#36、#41）
- [x] 权益检查与 AI 限流（#33、#38）
- [x] 决策 12：结算使用「流内最终 usage → 预扣额封顶的估算」；被中断流在 Gateway 不产生日志，不做日志回查（#98；chat 2.9，2026-10-12 已决）。
- [ ] **阶段验收（chat 5.1）**：代码已合并，staging 按 token/按次模型的对话、停止、关页与服务商报错，以及账本不变式和 Gateway 可比用量差异 <1% 核对仍待办。决策 12 已完成，不代表 5.1 通过；验收入口见 [staging 验收 runbook](./runbooks/staging-acceptance.md)。

## CI 能力建设

从 Phase 0 移出（原 `setup-scaffold-and-infra` 任务 6.2），由 `add-cloud-staging-neon` 建设：

- [x] main 上 CI 成功后自动部署 staging：`deploy-staging.yml` 按迁移 → jobs → web → 版本健康检查 → Chromium 冒烟的顺序执行；PR #62 与预渲染补正 PR #64 已合并，[Deploy staging run 37894416572](https://github.com/ustclhx/saas-template/actions/runs/37894416572) 全部成功，健康版本匹配 `ce623cab63a99d6eee8c8ba67eeb09e564f97779`、数据库正常、三项冒烟通过，任务 7.4 已验收。
- [x] staging 迁移通过 Neon 直连以 `migrator` 自动执行；Neon 建库、受限角色与权限、12 条迁移实测及切换已完成，GitHub staging 三项 secrets 已配置；上述成功自动发布已验证迁移后按 jobs → web 发布。阶段二生产私有 PG 的 CI 迁移仍见下文「生产迁移」。
- [x] Neon 9.2：观察期由七天缩短为 24 小时，2026-10-10 用户决定测试阶段保持 Free、接受计费周期后段 compute 暂停，上线时再升级；旧 Hyperdrive、Tunnel 与 Workers VPC 已删除，本机 `cloudflared` 容器已停止（#79）。2026-10-13 用户决定 staging 使用 `CRON_PROFILE=reduced`，将五分钟心跳与十分钟维护合并为半小时执行，小时和每日调度不变；生产默认、顶层/本地及 Node 五项调度保持原频率。预计约 48 次唤醒/天 × 5.5 分钟 × 0.25 CU，约 1.1 CU-hours/天、35 CU-hours/月；实际请求与任务耗时会影响用量，合入 main 自动发布后再复核缩容及用量。

发布使用 GitHub `staging` environment 的三个 secrets，PR CI 不获取这些凭据；发布串行且不取消进行中的运行。`add-cloud-staging-neon` 已完成 29/29，并于 2026-10-11 同步规格及归档（#85）。操作与验收证据、2026-10-13 staging 降频决定及半小时心跳核验窗口见 [Neon staging runbook](./runbooks/staging-neon.md) §6。

## 框架完成后的修补

开发中发现的两项缺口均已完成实现与规定验证，真实支付平台与生产上线验收仍按各自清单执行：

- [x] **已完成（`ci-e2e-smoke`，#102）**：`.github/workflows/ci.yml` 的独立 `e2e-smoke` job 使用临时 Postgres 与本地 fake 支付 Provider，覆盖注册进入个人空间、真实退出后密码登录、购买积分包、付款回调入账与重复回调不重复发放。仅安装并缓存 Chromium，无外部服务请求、PR secrets 或 trace/video；PR CI 冒烟已通过，#102 于 2026-10-12 合并。本地命令见 [07 §5](./07-infrastructure.md#5-部署与-ci-github-actions)，真实支付平台验收仍按既有 runbook 执行。
- [x] **已完成（`payment-live-mode`，#104）**：[add-payment-live-mode](../openspec/changes/add-payment-live-mode/proposal.md) 提供统一 `createPaymentRuntime` 工厂，按 `PAYMENT_MODE` 切换 test/live，并迁移 Webhook、Jobs、后台/客户/退款、认证删除与营销定价入口。9/9 任务完成，#104 于 2026-10-12 合并；本地和 staging 保持 test，live 上线清单见 [05 §8](./05-billing.md#8-支付模式与生产切换清单)。生产凭据、外部验收与正式收款主体仍依赖「生产迁移」和待决事项 Q9。

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

- [x] `MediaProvider` + fal.ai 实现与真实录制夹具；媒体服务商注册表与 Workers AI 图片（#68、#81、#93）
- [x] R2 预签名上传（上传后确认大小与配额）、`file` 表、鉴权下载与清理（#69）
- [x] `AiMediaWorkflow`：提交身份复用 → 等待回调/轮询 → 转存 R2（大文件分片）→ 结算 → 通知；fal.ai 不承诺幂等提交，提交响应不确定时不重试，失败退款（#73、#93）。
- [x] 媒体回调入口（HMAC + 服务商验签 + 先落库再 sendEvent；#73）
- [x] 任务列表/详情页、参数表单（由 params_schema 渲染）；后台模型参数 schema 编辑（#72、#75、#96）
- [x] 并发数限制（空间级事务锁）；DB-only 超时回收，Workflow 自检终态停止（#73；media 4.7，不依赖查询 Workflow 状态）
- [ ] **阶段验收（media 7.1/7.2）**：代码已合并，本地故障测试与 fal 录制通过；staging Workers AI 图片与推理失败/硬超时、fal 图片/视频及回调丢失/早到/提交响应丢失/服务商失败/硬超时的完整矩阵仍待办。只录制服务商响应不等于应用 Workflow、转存与账本的线上验收；入口见 [staging 验收 runbook](./runbooks/staging-acceptance.md)。

## Phase 5 · 管理后台

- [x] 用户：搜索、封禁、模拟登录、调整积分（#47、#49）
- [x] 空间、订阅、订单、支付、Webhook 事件（查看/重放）、退款申请审核（#47、#49）
- [x] 模型与定价、系统设置（`setting` 表；#51、#96）
- [x] 审计日志；业务指标看板（注册、付费、MRR、消耗、任务成功率；#54、#59）
- [x] 首次管理员引导与套餐模型权限编辑（`add-first-run-admin-setup`，#101，6/6）：可选 web Worker secret `BOOTSTRAP_ADMIN_EMAILS` 仅提升已验证且未封禁的名单用户；`/admin/billing/plans` 编辑 `features.models`，seed 重跑保留授权。移除名单不自动降权。
- [ ] 首次运行 staging 配置与外部验收：#101 未配置或写入 staging；由协调者配置 secret 后核验真实邮箱登录、创建模型与套餐授权，不能以 6/6 交付任务视为已完成外部验收。
- [ ] **阶段验收（admin 6.1）**：代码已合并，staging 搜索/封禁、模拟登录、补发积分、失败回调重放、退款审核、设置审计及次日指标核对仍待办（#95、#97 提供脚本，脚本合并不等于验收）。

## Phase 6 · 营销、内容、国际化、SEO

- [x] 落地页区块：Hero、功能、定价、FAQ、评价、CTA、页脚（预渲染；#44、#45）
- [x] Paraglide 多语言（页面、邮件、错误码；#35、#50）
- [x] content-collections 博客（MDX）、法律页、可选文档站（#44；Q2 已决定）
- [x] SEO：metadata、sitemap、robots、构建期 OG 图片、JSON-LD、hreflang（#53）
- [x] 暗色模式与主题定制（#37）
- [x] **阶段验收（marketing 5.2）**：2026-10-11 staging 首页、定价页、博客中英文共六页 Lighthouse SEO / 可访问性均为 100；16/16 任务已同步并归档（#86；[验收证据](./runbooks/evidence/marketing/lighthouse-2026-10-11.md)）。

## Phase 7 · 打磨与可选功能

- [x] 请求 ID、结构化日志与脱敏过滤器、Cloudflare Web Analytics / 可选 PostHog（#42、#56）
- [ ] Sentry 与 CI source map 上传：代码已合并（#94），main staging 的 web/jobs 真实异常与可读源码堆栈验收待办（observability 1.2）；新项目 smoke Sentry 证据不替代此项，见 [Sentry runbook](./runbooks/sentry.md)。
- [x] 站内通知中心；内部通知（新订单 → Telegram/Discord；#58）
- [x] 公开 API（API Key、OpenAI 兼容对话、媒体任务接口与文档；#57、#60、#77）
- [x] Waitlist、Newsletter（#46）
- [x] `CLAUDE.md` / `AGENTS.md`：模块说明、约定、常用命令（#52）
- [x] 「从模板创建新项目」的清单与脚本（改名、换配置、初始化基础设施；#52、#92、#100）
- [x] **新项目阶段验收（observability 6.1）**：#100 从模板生成独立文本 AI 项目，配置新 Neon / Cloudflare staging，健康、注册到首次 AI 调用、精确积分结算和 Sentry 源码堆栈均通过；临时资源已清理（2026-10-12；[脱敏证据](./runbooks/evidence/create-project/2026-10-12/acceptance.json)）。原 staging 的 Sentry 1.2 仍待验收。

## 待决事项

| # | 问题 | 决定 / 待选方案 | 决定日期 / 剩余验收 |
|---|---|---|---|
| Q1 | 表单库 | 已决定并接入：TanStack Form + Zod（#20、#22） | 2026-10-04，P1 验收确认 |
| Q2 | 内容方案 | 已决定并接入（#44、#76）：content-collections。博客、法律页与可选文档站都是 `apps/web/content/<集合>/<locale>/<slug>.mdx`，frontmatter 用 Zod 校验；MDX 在构建期渲染为静态 HTML（Worker 不允许执行 MDX 编译结果），文档搜索使用构建期生成的纯文本索引。不引入 Fumadocs：它的路由与 UI 体系对博客和法律页过重；个别站点需要重型文档站时再单独引入 | 2026-10-10 决定；2026-10-11 P6 验收并归档（#86） |
| Q3 | 产品分析 | 已决定并接入（#56、#60）：默认只用无 Cookie 的 Cloudflare Web Analytics（配置公开 token 后在公开页面加载）；PostHog 为可选接入点，由 `features.analytics` 控制且默认关闭，开启后须用户同意（`saas.analytics.consent`）并尊重 DNT，后台不加载；不做 Umami | 2026-10-07 |
| Q4 | 订阅积分是否结转 | 已按设计确定：按套餐配置，默认不结转（#24） | 2026-10-04 策略确定；2026-10-15 文档核对 `grantSubscriptionMonth` 与账期过期测试：月付默认周期末 + 24h，不结转；staging 时间与年付完整验收仍待 11.1 |
| Q5 | 升级时是否立即补发积分差额 | 已按设计确定：默认不立即补发（#24）；Stripe 升级链路已实测（#71） | 2026-10-04 策略确定；2026-10-15 文档核对 `payment.kind=adjustment` 不发积分，仅 initial/renewal 发放；PayPal 换套餐完整验收仍待 11.1 |
| Q6 | 退款时已消费积分的处理 | 已按设计确定：默认不追溯（#24）；Stripe 平台退款已实测（#71） | 2026-10-04 策略确定；2026-10-15 文档核对 `revokePaymentCredits` 只收回剩余积分，部分退款也收回全部剩余批次；管理员与 PayPal 真实退款验收仍待 3.3/11.1 |
| Q7 | 文本中断时的最低计费 | 已决定：优先流内最终 usage；无 usage 时按检查点估算，无检查点按估算输入、输出为 0 计算，应用 `minCharge ?? 1` 下限后再以 `hold.amount` 封顶。按次有输出才扣费；不做 Gateway 日志回查（决策 12，#98），详见 chat design 与 `06` §3 | 2026-10-11 取值确认（#84）；2026-10-12 封顶与决策 12（#89、#98）；staging 5.1 待办 |
| Q8 | 是否启用 RLS 加固 | 已决定：默认否；P1 使用 scoped() + lint + 实时成员校验（#13、#22） | 2026-10-04，P1 验收确认 |
| Q9 | Stripe 正式收款所需主体 | 未决定：注册海外主体 / 仅 PayPal 上线 / 接 MoR；测试账号联通与 test/live 工厂完成（#104）不代表正式收款资格已解决 | 上线前由用户决定 |
| Q10 | 超额容忍的默认额度（`billing.overage`） | 已按 `template.config.ts` 确定：单次平台承担上限为预扣额的 20% 与 50 积分的较小值（向下取整），每空间每 UTC 日累计最多 200 积分；剩余超额从余额补扣，不足记欠费。只适用于真实 usage 超额，估算结算受预扣封顶；上线后观察两周 `overage_absorbed` 再调整 | 2026-10-11 取值确认（#84）；2026-10-12 明确估算封顶（#89）；真实误差数据校准待办 |
