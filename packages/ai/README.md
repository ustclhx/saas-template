# AI 平台迁移（A 4.3）

`packages/ai` 的模型注册、预算、检查点、结算及媒体 Provider/runner 契约已经使用业务类型，
不需要 Workers 全局声明。模型列表的 `ModelCache` 只要求 KV 的文本读取、写入与删除，
可直接接入平台 `KeyValueStore`。本批不修改 `src/text/model.ts` 的 Gateway/BYOK 出口；
直连出口与 Workers AI 模型过滤由 change 的第 6 组处理。

Web AI、媒体回调及公开 API 从请求 `WebRuntime` 读取数据库、认证、缓存和限流。
`WebRuntime.ai` 由目标入口显式装配 AI 标量配置、后台延续、媒体 Workflow、Workers AI
及文件签名能力。未装配 AI 时返回 503；媒体 Workflow unavailable 在任务创建或预扣前拒绝。
公开媒体文件签名通过能力注入，业务路由不再持有 R2 环境。Cloudflare 入口继续使用原绑定，
`waitUntil` 保留 receiver，Workflow 状态通过平台适配器归一化。

限流使用 `ai`/`api` policy，保留原来的 workspace/user、API key/workspace 键。
同一聊天业务测试套件由 CF 和 Node 入口复用，验证真实 Postgres 上的预算、预扣、结算、
用量检查点、停止、重复结算和客户端响应流断开后的后台消费。Node 使用平台后台任务
集合与有界 drain；测试模型为 AI SDK 模拟模型。

验证命令（仓库根目录）：

```sh
pnpm --filter @saas/ai test
pnpm --filter @saas/web exec vitest run test/ai-chat.test.ts test/ai-media-tasks.test.ts test/public-api.test.ts test/public-media.test.ts
pnpm --filter @saas/web exec vitest run --config vitest.ai-node.config.ts
```

Node 配置必须使用同一个隔离 worktree/CI 数据库的 app/migrator 连接；缺失或数据库不匹配
立即失败，不静默跳过。默认 CF 测试不会收集 `.node.ts` 入口。

这批验证不代表 Node 生产 HTTP 断开验收、direct 出口验收或 B/C 的持久媒体执行、对象
存储验收完成；这些仍属于第 5/6/9 组和 B/C 交付。CF 媒体及公开媒体 runner 测试继续保留。
