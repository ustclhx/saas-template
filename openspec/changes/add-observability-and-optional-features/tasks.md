# Tasks

## 1. 可观测性

- [x] 1.1 请求 ID 生成与贯穿（日志上下文、队列消息、Workflow 参数），结构化 JSON 日志，验证测试：一次结账请求与其后续队列消息的日志带同一请求 ID
- [ ] 1.2 接入 `@sentry/cloudflare`（web + jobs）、release 与 source map 上传（CI），验证在 staging 触发一个测试异常后 Sentry 中出现可读堆栈
- [x] 1.3 统一脱敏过滤器（日志与 Sentry），验证单元测试：带 Authorization 头与对话内容的错误事件中这些字段被移除
- [ ] 1.4 接入 Cloudflare Web Analytics，以及 `features.analytics` 控制的可选 PostHog 接入点（默认关闭），验证默认配置下页面不加载 PostHog 脚本

## 2. 通知

- [ ] 2.1 站内通知中心（未读数、列表、点击跳转并标记已读、全部已读），验证 e2e：视频任务完成后未读数加一，点击后归零
- [ ] 2.2 内部运营通知：`EVENTS_QUEUE` 消费者推送新付款、新退款申请、回调失败、对账失败到 Telegram / Discord（`setting` 配置），验证测试：推送接口超时时业务请求成功且消息被重试

## 3. 公开 API

- [ ] 3.1 API Key 管理页（owner / admin；创建时显示一次完整值、命名、过期、撤销）与 `/api/v1` 鉴权中间件（Key → 空间上下文、权益检查、按 Key 限流），验证撤销后调用返回 401、`features.publicApi=false` 时返回 404
- [ ] 3.2 `POST /api/v1/chat/completions`（非流式与流式 SSE），复用站内对话服务，验证用 OpenAI 官方 Node 与 Python SDK 的集成测试通过且积分按模型计费方式扣除
- [ ] 3.3 `POST /api/v1/tasks` 与 `GET /api/v1/tasks/:id`，复用站内任务服务，结果返回短期下载地址，验证通过 API 生成一张图片的集成测试
- [ ] 3.4 编写公开 API 文档页（受 `features.docs` 与 `features.publicApi` 控制），验证文档中的示例请求可直接运行

## 4. Waitlist 与 Newsletter

- [x] 4.1 Waitlist：加入接口（Turnstile、限流、邮箱去重）、后台名单与分批邀请、邀请链接在注册关闭时可注册，验证测试覆盖重复提交与「注册关闭时被邀请」
- [x] 4.2 Newsletter：新增 `newsletter_subscriber` 表，订阅 → 确认邮件 → 确认；邮件中的一键退订，验证未确认邮箱不在发送名单中、退订后不再发送

## 5. 项目约定与创建脚本

- [ ] 5.1 编写根目录 `CLAUDE.md` 与 `AGENTS.md`（模块职责、依赖方向、编码约定、常用命令、OpenSpec 工作流），验证文档中列出的命令都能执行成功
- [ ] 5.2 实现 `scripts/create-project`（交互输入、复制并排除 `.git` / `.dev.vars` / `openspec/changes` / `node_modules`、替换占位符、生成配置与 `.dev.vars.example`、输出基础设施与密钥清单），验证在临时目录生成的项目中不含模板原名称且 typecheck 与单元测试通过
- [ ] 5.3 更新 `docs/08-roadmap.md` 中 Q3 的决定与 `docs/README.md` 的状态说明，验证文档与实现一致

## 6. 阶段验收

- [ ] 6.1 用创建脚本从模板生成一个新项目，按输出清单完成基础设施配置并部署到一个新的 staging，验证健康检查通过、注册到首次 AI 调用的完整流程可用、错误能在 Sentry 中看到
