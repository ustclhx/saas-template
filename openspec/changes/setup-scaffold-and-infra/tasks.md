# Tasks

## 1. 工程骨架

- [x] 1.1 初始化 pnpm workspace（`apps/*`、`packages/*`）、根 `package.json`、`pnpm-workspace.yaml`、`turbo.json`、`.gitignore`（含 `.dev.vars`），验证 `pnpm install` 成功
- [x] 1.2 配置 TypeScript strict 基础配置（`tsconfig.base.json`）与 Biome，验证 `pnpm typecheck` 与 `pnpm biome check` 在空包上通过
- [x] 1.3 创建 `packages/shared`（`AppError`、UUIDv7 生成、UTC 时间工具）并写单元测试，验证 UUIDv7 按生成顺序单调递增的测试通过
- [x] 1.4 创建 `packages/{auth,billing,credits,entitlements,ai,storage,email,ui}` 空壳包（只含 `package.json` 与入口），验证依赖方向检查脚本（禁止业务包依赖 `apps`、禁止非 `ui` 包依赖 React）在 CI 中运行并通过

## 2. 配置与环境变量

- [x] 2.1 在 `packages/config` 实现 `defineTemplateConfig` 与按 `docs/02-project-structure.md` 草案定义的类型和默认值，验证省略可选项时得到默认值、非法取值时 typecheck 失败（类型测试）
- [x] 2.2 实现环境变量 Zod schema 与 `loadEnv(env)`，缺失项报出变量名但不输出值，验证对应单元测试覆盖「缺失」「格式非法」「齐全」三种情况
- [x] 2.3 实现运行时设置读取 `getSetting(key)`：读 `setting` 表（KV 缓存），缺失回退代码默认值，验证单元测试覆盖「表中存在」「表中缺失」两种情况

## 3. 数据库

- [x] 3.1 编写 `infra/local/docker-compose.yml`（PG 17）与初始化脚本（创建 `app` / `migrator` / `readonly` 账号及权限），验证 `docker compose up` 后三个账号可登录且 `app` 不能执行 DDL
- [x] 3.2 在 `packages/db` 实现 `createDb(hyperdrive)` 与 Drizzle 配置，创建第一个迁移（`setting` 表，`id`/外键约定为 `uuid`），验证 `drizzle-kit migrate` 在本地执行成功
- [x] 3.3 配置 vitest-pool-workers 使用本地 PG（Hyperdrive `localConnectionString`），验证一个读写 `setting` 表的集成测试通过

## 4. Web 与 Jobs Worker

- [x] 4.1 创建 `apps/web`（TanStack Start + Cloudflare Vite 插件 + `nodejs_compat`），首页 SSR 输出版本号，验证 `vite dev` 在 workerd 下可访问首页
- [x] 4.2 实现 `GET /api/health`（数据库往返耗时、版本、`jobs.lastCronAt`；数据库不可达返回 503），验证集成测试覆盖 200 与 503 两种情况
- [x] 4.3 在请求入口接入环境变量校验，验证缺少必需变量时请求返回 5xx 且日志只含变量名
- [x] 4.4 创建 `apps/jobs`：导出空 `AiMediaWorkflow`（示例 step + `waitForEvent`）、`EMAIL_QUEUE` 消费者（只打日志）、每 5 分钟的 Cron（写 `jobs.lastCronAt`），验证本地 `wrangler dev` 下 Cron 触发后健康检查中的时间更新
- [x] 4.5 在 `apps/web` 配置 Workflow（`script_name: jobs`）与 Queue producer 绑定，新增仅限开发环境的调试路由启动 Workflow、投递消息，验证本地两个 Worker 联调时 jobs 收到消息并启动实例

## 5. 本机测试基础设施（阶段一，见 docs/07 §0）

- [x] 5.1 编写 `infra/postgres/docker-compose.yml`（PG 17、两个 `cloudflared` 副本、可选 exporter；WAL-G 备份留到阶段二）与 `postgresql.conf`（含 `archive_timeout = 60s`、TLS），作为阶段二生产服务器的模板，验证在本机用它启动后 PG 只在 compose 内网监听且 TLS 可用
- [x] 5.2 本机 PG（`infra/local`）启用 TLS（自签证书）并新增可选的 `cloudflared` 服务；创建专用 Tunnel、Workers VPC TCP 服务，以及指向它的 `app-db`（关缓存）与 `app-db-cached`（开缓存）两个 Hyperdrive 配置，验证部署后的 Worker 通过两个绑定都能查询本机 `saas_staging` 库
- [x] 5.5 配置 staging 环境：本机 `saas_staging` 库（`migrator` 执行迁移）、`env.staging` 的绑定与变量、Queues 等资源，jobs 与 web 部署到 `*.workers.dev`，验证 staging 上 `/api/health` 返回 200 且 `jobs.lastCronAt` 随 Cron 更新
- [x] 5.6 编写 `docs/runbooks/hyperdrive-tunnel.md`（本机 TLS、`cloudflared`、Tunnel、Workers VPC 服务、Hyperdrive、staging 部署步骤），验证按文档能从零重建 staging 的数据库连接

> 5.3（WAL-G 备份到 R2 与异地副本）与 5.4（恢复演练）推迟到阶段二，已移入 `docs/08-roadmap.md`「生产迁移」，不在本 change 范围内。

## 6. CI / CD

- [x] 6.1 GitHub Actions PR 流水线：install → biome → typecheck → vitest → build，验证一个故意引入类型错误的 PR 失败
- [ ] 6.2 main 流水线：部署 jobs → 部署 web 到 staging（`*.workers.dev`），验证合并后 staging 上的版本号更新；staging 迁移在阶段一由开发者在本机执行（docs/07 §5），CI 经 Tunnel 执行迁移留到阶段二
  - 待办（用户在 CI 能力建设时补齐）：需要一个 Cloudflare API Token（至少 Workers Scripts 编辑权限）存入 GitHub Actions Secrets；CI 不能使用 wrangler 的 OAuth 登录。在此之前 staging 由开发者在本机执行 `pnpm --filter @saas/jobs deploy:staging` 与 `pnpm --filter @saas/web deploy:staging` 部署

> 6.3（tag 流水线：生产迁移 → 部署 → 冒烟测试）推迟到阶段二，已移入 `docs/08-roadmap.md`「生产迁移」。

## 7. 平台能力实测（结论回写 docs）

- [x] 7.1 实测 Hyperdrive 下事务 + `SELECT ... FOR UPDATE` + `pg_advisory_xact_lock`：两个并发请求争同一把锁，验证后到者等待先到者提交；结论写入 `docs/07-infrastructure.md`
- [x] 7.2 实测跨 Worker Workflow：web 启动 jobs 的实例并 `sendEvent`；以及实例尚未执行到 `waitForEvent` 时先发送的事件是否被保留，验证结论写入 `docs/06-ai.md` 的「待验证」注释处
- [x] 7.3 实测流式响应：服务端用 `waitUntil` 读完一个模拟的长流，客户端中途断开，验证流读完后的回调仍写库成功；结论写入 `docs/06-ai.md`
- [x] 7.4 记录延迟基线：同一查询在开/关 Smart Placement 下从至少两个地区访问的 p50/p95，验证数据写入 `docs/07-infrastructure.md`（阶段一的数据库在本机，结果只用于验证链路，需在文档中注明不代表生产延迟）
- [ ] 7.5 本机同时运行两个 `cloudflared` 副本，停掉其中一个期间持续请求 staging 的 `/api/health`，验证没有失败请求（或记录中断时长）
- [ ] 7.6 根据 7.1–7.5 的结论更新 `docs/08-roadmap.md` 的 Phase 0 勾选状态与 `docs/README.md` 中受影响的「待验证」标注，验证 docs 中不再有已实测项仍标为待验证
