# Staging 验收脚本

脚本入口：`apps/web/e2e/staging-acceptance/playwright.config.ts`。默认 e2e 与 staging smoke 均不收集该目录；staging 必须以 `--headed` 运行并有人值守，单 worker、无自动重试，不录制 trace、截图、视频，不将 Cookie 或 storageState 写入文件/日志；模型设置与后续验收在同一 worker 中顺序执行，失败后停止；仅在内存复用新鲜登录会话，避免逐用例重新登录触发认证限流。脚本只通过应用 HTTP/UI 产生业务数据，数据库证据查询仅使用 `NEON_READONLY_URL`，在 Docker 内执行只读事务。

本 PR 不运行 staging，不部署，也不勾选 OpenSpec。脚本通过不等于 media 7.1/7.2、chat 5.1、admin 6.1 或 observability 1.2 全部验收完成。

## 环境与执行（协调者）

在已忽略的 `.env.local` 中填写以下变量；不要把值粘贴到命令、卡片或 PR：

| 变量 | 用途 |
|---|---|
| `STAGING_URL` | 明确目标 HTTP origin，无账号、查询串或片段 |
| `STAGING_USER_EMAIL` / `STAGING_USER_PASSWORD` | `.env.local` 中随机生成的 `@example.com` 普通验收用户凭据；缺失仅跳过媒体与聊天 |
| `STAGING_TEST_USER_EMAIL` / `STAGING_TEST_USER_PASSWORD` | `.env.local` 中随机生成的 `@example.com` 专用后台测试用户凭据；缺失跳过 Admin 6.1 |
| `STAGING_ACCEPTANCE_RUN_ID` | 建议固定如 `acceptance-2026-10-12`；默认 UTC 日期 |
| `NEON_READONLY_URL` | 只读证据连接，来自指定 staging 凭据文件 |

管理员不配置邮箱或密码环境变量。脚本打开 `/login` 后打印「请在弹出的浏览器中登录管理员账号」，等待最多 5 分钟；管理员亲自完成登录，可使用 Google OAuth。登录后脚本检查当前会话身份是否为平台管理员并可访问 `/admin`，后台测试的身份与唯一性检查使用该会话用户。未加 `--headed` 或登录身份不满足管理员要求时，脚本明确提示并停止该步骤。管理员 Cookie 只在当前 worker 内存中复用，不保存密码、Cookie 文件或 storageState；每次新进程需重新人工登录。

普通用户与专用后台用户不存在时，脚本使用 `.env.local` 凭据通过普通注册页面创建；重跑复用已有账号，不重复注册。运行前需启用注册；当前 staging 为 `requireEmailVerification=false`，Turnstile 仍启用，需在可见浏览器中人工完成。专用后台用户必须与当前会话管理员、普通验收用户不同，已有账号只有姓名精确匹配脚本的专用 fixture、角色为 user 时才可复用。不要使用真实客户账号。

普通用户登录进入媒体/聊天验收前，脚本以只读数据库检查其有效套餐的 `features.models` 包含下表五个模型 key 或 `*`、可用积分至少 30，且没有欠费。新注册账号不保证满足这些条件；缺少模型权限或有欠费时，脚本失败并打印固定准备指引及用户 UUID，由管理员手动修正后重跑。脚本不修改套餐。仅可用积分不足 30 时，允许使用当前管理员会话通过已有的后台积分调整 UI 补足差额，该操作仍经过 adminAction 并留下审计，reason 精确为 `staging acceptance test credits <runId>`。调整前按同一空间和同一 run ID 查询审计，已有记录时不重复赠送；若已有调整后仍不足，提示人工核验，不换 run ID 绕过幂等检查。余额、欠费、套餐权益与审计查询继续只读，不直接写 staging 数据库。普通用户还需有可用存储，验收期间避免其他并发操作。

严格按 wave-common 的读取方式，从根目录执行（不加 shell tracing）：

```sh
set -a
. ./.env.local
. /Users/hxlee/workspace/saas-template/.env.staging-neon
set +a
pnpm --filter @saas/web exec playwright test -c e2e/staging-acceptance/playwright.config.ts --headed
```

管理员登录和 Turnstile 都由人在弹出的浏览器中完成，脚本不会在 staging 绕过验证。缺少相关环境变量会明确 skip。完整执行前检查没有 skip；不要将依赖缺失当作成功。

验收凭据分两阶段管理：现阶段由协调者在本机读取已忽略的 `.env.local`，人工值守执行 staging 验收；生产发布阶段计划将普通与专用验收用户凭据迁入生产 GitHub environment secrets，并通过 GitHub Actions 执行。生产验收工作流及其管理员登录方案尚未实现，本次只记录迁移方向，不代表当前脚本能在 Actions 中完成生产验收。

同一用户、run ID 和步骤重跑会复用已有媒体任务或聊天会话。不要更换 run ID 作为故障恢复手段：新 ID 会产生新收费请求。提交结果不明确、已有用户消息却没有 assistant、重复任务、外部取消待确认会失败，先核对数据库证据与供应商作业再恢复。视频已完成时不能再证明取消退款。关页用例另存流中关页的动作证据；已有回复缺少对应动作证据时明确 skip、交给人工核验，不认证为关页成功。同 run ID 跨 UTC 日期恢复时，应将其动作证据复制到当日目录（保留原文件），否则同样 skip。

真实 staging 运行的证据写入 `docs/runbooks/evidence/staging-acceptance/<UTC日期>/<run-ID>-*.json`，只有这些真实证据可以提交仓库。本地假服务商证据写入仓库根目录下已被 git 忽略的 `test-results/staging-acceptance/<UTC日期>/<run-ID>-*.json`，不得提交。两种证据只含 ID、状态、定价、用量、积分、账本和审计记录 ID，不含邮箱、对话内容、请求体、Cookie、下载签名或连接串。同 run ID 同步骤覆盖最新证据，不同 run ID 分开保留。默认 reporter 只输出步骤标题/状态/失败代码位置；人工登录与账户准备的失败详情仅保留固定安全指引及必要用户 UUID，不输出邮箱或凭据。自行使用 verbose reporter 或 trace 可能泄露认证页面数据，勿用于可分享日志。

## 模型设置与当前阻塞

脚本使用稳定 key（`acceptance-*`），若已有同 key 就完整核对配置，不覆盖定价或重复创建。单次价格 1/2/3 积分；DeepSeek token 为输入 1、输出 2 积分/1k，最低 1；按次 2 积分，输入上限 4096、输出上限 1024。模型不附加套餐标签；普通用户套餐的 `features.models` 必须包含这五个 key 或 `*`，空列表不会授予模型权限。脚本不会修改 staging 套餐。

| Key | Provider / model |
|---|---|
| `acceptance-workers-image` | workers-ai / `@cf/black-forest-labs/flux-1-schnell` |
| `acceptance-fal-image` | fal / `fal-ai/flux/schnell` |
| `acceptance-fal-video` | fal / `fal-ai/wan/v2.2-a14b/text-to-video/turbo` |
| `acceptance-deepseek-token` / `acceptance-deepseek-call` | deepseek / `deepseek-flash` |

后台已提供 `Parameters schema (JSON)` 字段；脚本在新建媒体模型前检查该字段，缺失则明确 skip，不创建不可用模型、不写 staging 库。模型完整定义及平面参数 schema 在 `models.ts`；文本模型使用空对象 schema（默认文本配置），媒体模型使用明确的平面参数 schema。已有同 key 模型仍会完整核对配置。

fal 图片尺寸采用官方 API 支持的平面枚举 `square`，避免当前 schema 不支持嵌套尺寸对象。参考 [fal FLUX schnell API](https://fal.ai/models/fal-ai/flux/schnell/api)。参数与价格都冻结在任务快照中。

## 本地验证

本地配置只接受 worktree 隔离数据库和 loopback origin。管理员凭据优先使用进程中的 `LOCAL_ADMIN_EMAIL` / `LOCAL_ADMIN_PASSWORD`；未设置的键从主 checkout 已忽略的 `/Users/hxlee/workspace/saas-template/.env.local` 读取，仅读取这两个本地键，不导入 `STAGING_URL`、数据库连接或其他配置。两键齐全且非空时使用该账号；任一键缺失或为空时继续使用当前随机账号 fallback。不要打印这些凭据，也不要在本地执行前 source 整份主 checkout `.env.local`。

在 worktree 根目录先应用现有迁移，清除 staging 环境变量后执行；主 checkout 的本地管理员键无需复制到 worktree：

```sh
pnpm --filter @saas/db db:migrate
unset STAGING_URL NEON_READONLY_URL STAGING_ACCEPTANCE_LOCAL
pnpm --filter @saas/web exec playwright test -c e2e/staging-acceptance/local.config.ts
```

本地创建账号、晋升管理员、给普通空间配置这五个模型的测试权益并赠送 100 测试积分，采用现有 e2e 隔离库方式；这些写库动作只存在 `local-setup.ts`。媒体 schema 由本地种子提供，因此本地不证明后台 UI 能创建媒体 schema。本地配置注入文本假流、媒体假 Provider、简化 Workflow 调度和鉴权后的本地 R2 下载，业务提交/预扣/媒体 runner/转存/结算/账本仍走真实实现。视频保持 queued 供立即取消。无真实 AI/支付/Sentry 调用；Sentry 503 只证明禁用 gate，不能算错误上报验收。

`local-setup.ts` 查询该管理员账号，不存在时通过普通注册页面创建，再晋升管理员；现有账号直接复用。普通验收账号仍自动生成仅驻留进程的密码，自动登录管理员与验收用户，默认无头运行，不要求人工管理员登录；套餐和积分准备仍由上述本地种子完成。需要重跑同一普通账号时，在进程中提供相同 `STAGING_ACCEPTANCE_RUN_ID`、`STAGING_USER_EMAIL` / `STAGING_USER_PASSWORD`，且仍先 unset 远程目标变量；管理员可继续复用上述本地凭据。服务由 Playwright 启停，不复用现有 dev。

本地关页动作证据的写入与重跑读取都使用 `test-results/staging-acceptance`，不会写入 staging 的证据目录。跨 UTC 日期重跑时，在这个本地目录内复制对应动作证据到当日子目录；不要将本地文件搬到 runbook 证据目录。

## 媒体人工故障验收（待执行）

自动脚本覆盖 Workers/fal 图片成功下载、按次精确消费及对账，以及 fal 视频立即取消全退。Workers 推理失败没有已验证的参数可安全触发，明确作为人工步骤；不会随机扩大 schema 或尝试不可信参数。每个故障保存 task ID、hold ID、终态、退款/消费 ledger ID 和只读对账结果。

以下注入需协调者与用户确认针对专用验收资源，通过单独故障注入改动走 main 自动发布；不得从本分支手动部署、直接改 staging 数据或破坏共享资源。优先在本地 Provider 夹具复现，再在 staging 验证单一已确认故障。

| 场景 | 建议注入方式 | 验收 |
|---|---|---|
| Workers 推理失败 | 专用任务的 AI 绑定代理抛错；或在官方文档确认后由模型管理员提供本站接受但供应商拒绝的参数 | failed；hold released；0 消费；全退 |
| fal 服务商失败 | 专用 Provider 代理返回确定失败状态/有效签名失败回调 | failed；0 消费；全退 |
| 回调丢失 | 针对专用 task 的 webhook 暂时拒绝投递，保留查询状态可用；不要全站屏蔽 | 等待 15 分钟后轮询成功；产出1份、消费1次 |
| 回调早到 | 仅专用任务在提交返回后、等待前延迟 Workflow；确保真实验签回调已先落库 | callback_payload 被复用；产出和消费不重复 |
| 提交响应丢失 | 专用队列出口代理在供应商已受理后断开响应连接（保留供应商 request ID） | 非幂等 fal 不再次提交；failed/全退；核对供应商只有1作业 |
| 硬超时 | 专用任务 Provider 保持 queued/running，等真实 2 小时 deadline 及10分钟扫描缓冲；可用经评审的专用短超时配置加速 | failed/全退；晚到回调/Workflow不重复结算 |

只读对账使用同一快照：`sum(credit_ledger.delta) = sum(active credit_grant.remaining) + sum(held credit_hold.amount) - sum(credit_debt.amount)`。active 批次不额外排除已到期而待 Cron 处理的记录，以免制造虚假差异。失败/取消只释放预扣，不要求额外 refund 分录；可花余额的 remaining 已减去 hold，不能再减一次。

## Chat 与 AI Gateway 核对（待日志读取 token）

脚本对两个 DeepSeek 模型分别完成正常回复、点击停止、流中关闭页面；记录 message/conversation/hold ID、消息 token 数、检查点 token 数、积分和 ledger。关闭页面场景要求尾部在30秒内完成并恢复完整回复；若真实输出超时，此用例失败，应另按长流检查点与10分钟回收器验收，不能把部分回复当成完整成功。staging 停止/关页必须实际发生在仍生成时。

**Gateway 对比 pending**：目前缺少 AI Gateway 日志读取权限 token，脚本不查 Gateway、不推断已通过 <1% 差异要求，也不决定 chat 2.9 的即时查询/延后补差方案。

取得权限后，在 AI Gateway Logs 用证据中的生成开始时间、Provider/model 与独占验收窗口筛选调用。当前请求没有发送带 message ID 的 `cf-aig-metadata`；如果时间窗口有多个候选，关联核验也应保持 pending，后续需经授权补齐关联 ID，不能随意挑选相近记录。唯一关联确认后，记录日志 ID、`tokens_in`/`tokens_out` 和可查询延迟，与 `ai_message.input_tokens/output_tokens` 比较；正常完成输入/输出差异应<1%，超出要调查统计口径。停止/断开场景记录是否具有实际 usage、检查点是否估算、是否受预扣封顶；日志缺 usage 时标为无法比对，不伪造零差异。不要导出 prompts、responses 或完整请求头。官方字段参考 [Gateway 日志详情 API](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/get/)。

服务商报错、超过30秒的关页及回收结算不由本脚本强行制造；用专用代理/模型夹具验证后保存脱敏账本证据。OpenSpec chat 5.1 与 2.9 保持未完成直到真实要求全部验收。

## Admin 人工补充（待用户确认）

脚本只操作专用用户：搜索封禁、解封、模拟并退出、幂等补发25积分、公告修改与恢复；每项保存审计 ID。恢复公告在 finally 中执行；进程被强制中止时，下次从上一次设置变更 audit 的旧值恢复。脚本不输出公告正文。

失败支付回调重放与退款审核由用户确认具体 Stripe Test/PayPal Sandbox 资源后人工执行，不进入脚本。重放前记录 webhook event/payment ID 与状态，通过后台重放，核对平台/本地付款/积分没有重复入账并保存审计 ID。退款审核先确认金额与积分是否可收回，记录申请/payment/refund/audit ID 与供应商状态，复核对应积分账本；不得用真实支付制造测试。按 [支付联通 runbook](p2-payment-integration.md) 操作。

次日检查 metrics 看板的截至时间和专用操作对应积分/任务汇总，保存日期、指标值与审计关联；后台显示不是实时数据，脚本不提前勾选 admin 6.1。

## Sentry 1.2 人工核对

脚本以管理员浏览器同源 POST `/api/admin/observability/sentry-test`，仅记录500状态和 `x-request-id`。503为未启用Sentry，403/404为同源/权限问题，都不是成功发送证据。测试异常可明确再次触发。

按 [Sentry runbook](sentry.md) 等 main 自动发布成功，记录 health 完整SHA。在指定项目查询 `environment:staging release:<SHA> requestId:<ID>`；确认 event ID、dist=web、release、TypeScript函数/文件/行号与源码上下文，并确认事件没有凭据或对话内容。jobs仍需现有Workflow/Queue/Cron真实失败事件核对dist=jobs与源码映射。保存脱敏事件链接/ID及堆栈位置，只有真实上报与source map要求全部通过后由协调者勾选1.2。
