# Tasks

## 1. 数据与模型登记

- [ ] 1.1 迁移：`ai_model.fallbacks`、`ai_task.provider_attempts`（jsonb，默认 `[]`）；`pnpm --filter @saas/db db:migrate` 在隔离库通过，schema 快照提交
- [ ] 1.2 `packages/ai/src/models.ts` 增加备用链解析与保存校验（同类型、不含自身、服务商互不相同、≤2、paramMap 后 schema 兼容），删除模型时从引用链移除；单测覆盖规格「备用模型配置」全部场景
- [ ] 1.3 备用模型不进入用户模型列表、权益与预计消耗；单测覆盖「备用模型对用户隐藏」

## 2. 错误分类

- [ ] 2.1 新增 `MediaFailure` 分类与可切换判定，fal 适配器映射现有错误（HTTP 状态、`error_type`）；`fal.test.ts` 补每类样例并通过

## 3. Replicate 服务商

- [ ] 3.1 `packages/ai/src/media/replicate.ts`：提交、查询、取消、Standard Webhooks 验签（含时间戳窗口）、产出解析与错误分类；用官方文档样例做夹具，单测通过
- [ ] 3.2 登记到 `mediaProviderDefinitions`（`REPLICATE_API_TOKEN`、`REPLICATE_WEBHOOK_SECRET`，产出域名精确白名单），环境校验与 `.dev.vars.example` 同步；`registry.test.ts` 通过
- [ ] 3.3 `docs/third-party.md` 登记行（官方文档链接与核对日期）、`docs/06-ai.md` 服务商章节；`pnpm check` 通过

## 4. kie.ai 服务商

- [x] 4.1 `packages/ai/src/media/kie.ts`：统一任务接口提交与查询、回调验签、产出解析与错误分类；不支持的模型登记时拒绝；单测通过
- [x] 4.2 登记到 `mediaProviderDefinitions`（`KIE_API_KEY` 与回调验签密钥），产出域名白名单；第三方登记表与 `docs/06-ai.md` 写明条款风险与建议用途；`pnpm check` 通过

## 5. 自动切换

- [ ] 5.1 Web 提交：按主模型 + 备用过滤可用候选，全空才拒绝；初始尝试写入任务，定价快照仍取主模型；集成测试覆盖「主服务商未配置」两个分支
- [ ] 5.2 Runner：提交失败与作业失败按分类切换到下一候选，尝试记录、新 request key、带序号的步骤名、硬超时前 20 分钟不再切换、`ambiguous` 不切换；集成测试覆盖规格「备用模型自动切换」全部场景
- [ ] 5.3 回调归属：回调地址签名含尝试序号，按序号选服务商验签，旧尝试回调 200 忽略；集成测试覆盖「旧作业的晚到回调」与伪造服务商签名
- [ ] 5.4 结算不变：切换后按主模型快照结算、全部失败全额退回；集成测试覆盖「备用模型更贵」「备用全部失败」
- [ ] 5.5 `ai.media.failover` 日志与故障注入新模式（服务商限流、可切换的作业失败）；`ai-fault-injection` 相关测试通过

## 6. 文本备用

- [ ] 6.1 `packages/ai/src/text/fallback.ts`：`fallbackLanguageModel` 包装（doGenerate / doStream、首个内容分片前可切换、惰性构造并跳过未配置服务商、`onFallback`）；单测覆盖连接期错误、流内首分片错误、首分片后错误透传、全部失败
- [ ] 6.2 对话与后续问题经备用链构造模型，实际模型 key 记入消息元数据，计费仍按主模型；集成测试覆盖规格「文本备用模型切换」的对话场景与「备用模型单价更高」
- [ ] 6.3 agent 运行器经备用链构造模型，实际模型记入轮次；`plugins/agents` 测试覆盖「agent 中途某一步」
- [ ] 6.4 `ai.text.failover` 日志与 `before-stream` 故障注入可切换错误；`docs/06-ai.md` 文本章节说明备用机制；相关测试通过

## 7. 后台与 Admin MCP

- [ ] 7.1 模型编辑页「备用模型」有序列表与参数映射，任务详情显示尝试记录，对话消息与 agent 轮次显示实际模型；`pnpm typecheck`、组件测试与 e2e 冒烟通过
- [ ] 7.2 Admin MCP `models.create` / `models.update` / `models.get` 支持 `fallbacks`（与后台共用校验），同 PR 更新参数说明与 `docs/admin-mcp.md`；`admin-mcp.test.ts` 通过
- [ ] 7.3 `add-ai-model` 与 `configure-feature-model` 技能补充主备配置与逐对真实生成验收步骤（`.agents` 与 `.claude` 副本 `cmp` 一致）

## 8. Staging 验收（需使用者提供密钥）

- [ ] 8.1 使用者确认后写入 `REPLICATE_API_TOKEN`、`REPLICATE_WEBHOOK_SECRET`、`KIE_API_KEY` 等 Wrangler secrets，启用两服务商，登记首批主备模型对
- [ ] 8.2 真实生成：Replicate 与 kie 各一张图、一段视频，验证回调验签、转存与结算；证据写入 `EVIDENCE_DIR`
- [ ] 8.3 故障注入触发 fal 限流与作业失败，验证切换到 Replicate、再切到 kie、全部失败退款与旧回调忽略；文本对话与 agent 各注入一次主模型限流验证切换；证据写入 `EVIDENCE_DIR`
- [ ] 8.4 升级说明 `docs/upgrades/<版本>.md`（非破坏、新 secrets、默认关闭）并按发版流程打 tag
