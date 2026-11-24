## 1. 技术验证（先于其余各组）

- [x] 1.1 在临时分支建一个最小插件 `plugins/example`（workspace 包，含一个 `app/$slug/example` 路由与一个 `createServerFn`），通过 `virtualRouteConfig`（`rootRoute` + `physical('', 'routes')` + 插件目录）挂载；验证 dev、`pnpm build`（Cloudflare）、`vite.node.config.ts` 构建、`generate-route-tree.mjs` + `tsc` 类型化路由、Tailwind 能扫描到插件组件类名。把结论写进 design.md 决策 1、4 的「验证结果」，失败则切到备选方案并在 PR 说明
- [x] 1.2 验证剔除效果：同一最小插件关闭后，web Worker、Node 与 jobs 产物中搜索不到插件特有字符串；记录检查命令，供 5.4 复用

## 2. 清单、配置与校验

- [x] 2.1 `packages/config` 新增 `definePlugin` 类型（id、targets、requires、routes、entries、bindings、secrets、messages）与 `plugins` 配置段；插件配置 schema 校验、未知 id、`requires` 闭包、`ai.image || ai.video` 需 `media`；单元测试覆盖每条失败分支与错误信息
- [x] 2.2 `pnpm-workspace.yaml` 加 `plugins/*`；apps 依赖插件包；tsconfig `include` 与 Turbo inputs 加入 `plugins/*`（按 `docs/ci.md` 更新缓存输入说明）；`pnpm install --frozen-lockfile` 与 `pnpm typecheck` 通过

## 3. 构建期生成与扩展点

- [x] 3.1 `scripts/plugins/generate.mjs`：读取配置与清单，输出 `apps/web/src/plugins.gen.ts`、`plugins.worker.gen.ts`、`plugins.node.gen.ts`、`apps/jobs/src/plugins.gen.ts`、`plugins.node.gen.ts`（gitignored）；Node 产物跳过仅 Cloudflare 插件并打印提示；同一配置输出确定。Node test 覆盖启用、关闭、目标排除
- [x] 3.2 接入时机：web Vite 配置（含虚拟路由）、jobs `build` / `build:node` / `dev`、`typecheck`、`test` 前置；`pnpm typecheck`、`pnpm test` 在干净工作树通过
- [x] 3.3 `i18n-project.ts` 只加入启用插件的 `messages/`；关闭插件时 Paraglide 输出中没有其消息键（单元测试）
- [x] 3.4 web 扩展点：应用区导航、顶栏入口、后台菜单从 `plugins.gen.ts` 合并；`src/server.ts` 增加 fetch 前置处理链与 `export * from './plugins.worker.gen.ts'`；消息部件渲染器注册入口。组件 / 单元测试覆盖导航合并顺序与前置处理短路
- [x] 3.5 jobs 扩展点：Workflow 类导出、队列处理器、Cron、积分预扣清理器从生成文件合并，Cloudflare 与 Node 两套入口；现有 jobs 测试通过
- [x] 3.6 运行时绑定校验：`server/cloudflare/env.ts` 与 `node/runtime.ts` 按启用插件清单校验必需绑定，去掉写死的媒体判断；单元测试覆盖缺失绑定的报错

## 4. 检查

- [x] 4.1 `scripts/check-plugins.mjs` 并入 `pnpm check`：绑定在 web / jobs 顶层与 staging、production 都存在且种类一致；wrangler 不引用未启用插件的类；清单路径存在。Node test 用 wrangler 夹具覆盖各失败分支
- [x] 4.2 `check-deps` 扫描 `plugins/`：核心不得导入 `@saas/plugin-*`（`*.gen.ts` 例外）；插件只能导入声明的插件；插件内 `cloudflare:*` 等导入只允许在 worker / jobs 入口目录。扩展 `check-deps.test.mjs`
- [x] 4.3 `docs/plugins.md`：目录结构、清单字段、扩展点、启停步骤、部署目标、检查命令、如何新增插件；`02-project-structure.md` §1 与依赖边界、`AGENTS.md` 模块职责各加一行入口

## 5. 媒体迁移为 `media` 插件

- [x] 5.1 建 `plugins/media`：清单（targets 含 node、requires billing+credits、bindings `AI_MEDIA_WORKFLOW` / jobs workflows / 可选 `AI`、secrets `FAL_KEY` / `MEDIA_WEBHOOK_SECRET`）、配置段 `providers`；`ai.mediaProviders` 迁到 `plugins.media.providers`，读取处改为插件配置
- [x] 5.2 迁移 web：`features/ai-media/*`、`features/ai/media-tasks.ts`、媒体路由（`app/$slug/media/new`、`app/$slug/tasks/*`、`api/ai/tasks*`、`api/webhooks/media/$provider`、`api/v1/tasks*`）、`node/media-workflow.ts`、文案；核心中对这些文件的引用改为扩展点。只改路径与导入，不改逻辑；对应单元测试随迁并通过
- [x] 5.3 迁移 jobs：`workflows/media-runner.ts`、`node/media.ts`、`node/media-http.ts`、`mediaTaskHoldSweeper` 注册；`AiMediaWorkflow` 只经生成文件导出；e2e 夹具 `local-media.ts`、`fault-local-media.ts` 的导入路径更新。媒体集成测试与 jobs 测试通过
- [x] 5.4 剔除验证：分别以启用 / 关闭 `media` 构建 web（Cloudflare、Node）与 jobs，用 1.2 的命令确认关闭时产物中无 `AiMediaWorkflow`、`fal.media`、媒体页面组件；关闭时媒体页面与 Webhook 返回 404 的 e2e 或集成测试。关闭媒体后运行 Web / jobs 相关测试与本地 e2e，确认媒体专属用例跳过且其他用例通过
- [x] 5.5 本地媒体端到端回归：启用 `media` 跑现有本地媒体 e2e（`local-media`），结果与迁移前一致；证据写入 `EVIDENCE_DIR`

## 6. 生成器与模板同步

- [x] 6.1 `create-project`：`--plugins` 参数与交互询问；`--ai` 含 image/video 自动加 `media`，`--media-providers` 写入插件配置；按清单删除未启用插件的 wrangler 绑定（替换写死的 `workflows` / `ai` 删除逻辑）；selfhost 拒绝仅 Cloudflare 插件；`PROJECT_SETUP.md` 清单按插件列出绑定与密钥。`create-project.test.mjs` 覆盖
- [x] 6.2 `template-base` 记录 `plugins` 参数（遵循 `optionalParams`）；template-sync 用其重建副本；`infer` 静态解析 `plugins` 键。`template-base.test.mjs`、`template-sync.test.mjs` 覆盖「未启用插件的项目合并插件源码改动无冲突」
- [ ] 6.3 `pnpm test:create-project:verify`：CF 默认（含 media）、selfhost 默认、selfhost 全关三个副本通过 check、typecheck、单元测试与 build；全关副本产物不含媒体代码
- [x] 6.4 更新 `docs/create-project.md`、`docs/06-ai.md`（媒体由插件提供、配置位置）、`docs/08-roadmap.md`（新增「插件与 Agent」阶段：本 change、`add-ai-agents`、生图站、视频站）；升级说明草稿（BREAKING：`plugins.media`、`ai.mediaProviders` 迁移、xuanxue 删除媒体绑定步骤），发版时写入 `docs/upgrades/`

## 7. 验收

- [ ] 7.1 staging 部署（启用 media）后跑 staging 媒体矩阵中图片与视频各一条，结果与迁移前一致；证据写入私有证据库。需要 staging 凭据，未执行时在 PR 中标为未完成验收
