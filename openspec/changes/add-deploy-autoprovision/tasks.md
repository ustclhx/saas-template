## 0. 分组与依赖

- W1（第 1 组）先做，其余组依赖它的共享模块。W2（第 2 组）与 W3（第 3 组）在 W1 合并后并行。第 4 组在 W2、W3 合并后由协调者执行。
- 第 5 组涉及部署与外部凭据，单列，不在 PR 中提前勾选。
- 验收标记：〔本地〕不需要 Cloudflare 凭据；〔staging〕需要 main 发布到模板 staging；〔凭据〕需要使用者提供令牌或连接串。
- 建议分派：W1、W2 涉及跨模块逻辑与工作流，由 Claude 实施；W3 是生成器与文档的机械改动，可交 Codex。

## 1. 解析核心（W1）

- [x] 1.1 新建 `scripts/deploy/resources-lib.mjs`，提供纯逻辑：占位判定（缺失或 `^0{24}[0-9a-f]{8}$`）、由 web Worker 名推出前缀与后缀、按约定命名（design 决策 2）、按「环境 + 绑定名」合并 web 与 jobs 的同名绑定、两边固定 ID 不一致时报错、把解析结果写入完整配置对象（保留 env 结构与其他字段，账号 vars 只填空值）、遍历全部 KV / R2 / 队列（含 `dead_letter_queue`）/ Hyperdrive 配置段而不写死绑定名。验证：`node --test scripts/deploy/resources-lib.test.mjs` 覆盖模板配置、生成器占位配置、插件新增 KV、ID 冲突、production 段。〔本地〕
- [x] 1.2 `scripts/production/check-wrangler-envs.mjs` 改用 1.1 的占位判定，原有规则不变。验证：`node --test scripts/production/*.test.mjs` 与 `pnpm check` 通过，新增一个占位 ID 不触发「生产复用 staging ID」的用例。〔本地〕
- [x] 1.3 新建 `scripts/deploy/cloudflare-api.mjs`：基于 `fetch` 实现 KV、R2、Queues、Hyperdrive 的列表（遍历全部分页）与创建；错误只保留 HTTP 状态和 Cloudflare 错误码，403 转成「缺少某类权限」的提示；Hyperdrive 创建从环境变量读取连接串并放进请求体。验证：用注入的假 `fetch` 做 Node test，覆盖分页、同名多条、403、Hyperdrive 输出与错误中不含连接串。〔本地〕
- [x] 1.4 新建 `scripts/deploy/resources.mjs` 与根脚本 `deploy:resources`，实现 design 决策 6 的模式（默认 plan、`--apply`、`--allow-production`、`--create-hyperdrive`、`--verify`），按 KV → R2 → 死信队列 → 队列 → Hyperdrive 的顺序创建，每创建一项重新查询确认；输出可读计划和可粘贴的 ID 清单；`apps/*/wrangler.deploy.json` 加入 `.gitignore`。验证：假 API 的端到端 Node test 覆盖首次创建、中断后重跑不重复创建、production 无开关时不创建、Hyperdrive 缺失失败、全部固定时零 API 调用、运行后 `git status` 无已跟踪文件变化；测试加入 `pnpm check` 的 `node --test` 列表。〔本地〕
- [x] 1.5 按已拍板事项 4（使用者 2026-11-25 确认），把模板自身 `apps/web/wrangler.jsonc` 与 `apps/jobs/wrangler.jsonc` 中 `env.production` 已失效的 KV、Hyperdrive ID 改为生成器占位格式（web 与 jobs 同一绑定使用同一占位值），并删去说明这些资源仍在用的注释；`env.staging` 不动。验证：`pnpm check`（`check-wrangler-envs`、`check-plugins`）通过，`pnpm deploy:resources --env production` 在假 API 下把这些绑定报为「待创建」且不创建。〔本地〕

## 2. 构建与流水线接入（W2，依赖 1）

- [ ] 2.1 `apps/web/vite.config.ts` 读取 `WRANGLER_DEPLOY_CONFIG`，作为 `cloudflare()` 的 `configPath`，未设置时行为不变。验证：设置该变量指向含不同 KV ID 的配置后执行 `CLOUDFLARE_ENV=staging pnpm --filter @saas/web build`，`dist/server/wrangler.json` 中是新 ID；不设置时产物与改动前相同；`pnpm check`（含 `check-turbo-inputs`）通过。〔本地〕
- [ ] 2.2 `deploy-staging.yml`：在迁移前加「Resolve deployment resources」步骤（`--env staging --apply`，只注入 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）；jobs 的构建与部署命令加 `--config wrangler.deploy.json`；web 构建设 `WRANGLER_DEPLOY_CONFIG`。`deploy-production.yml` 同样改动，但解析只做 plan，放在构建前，不传 `--apply`（已拍板事项 1，使用者 2026-11-25 确认）。修改前先读 `docs/ci.md`，concurrency 与步骤顺序符合 §4、§6。验证：用本地 `act` 不可行时，以 `--dry-run` 跑通相同命令序列，并在 PR 中贴出命令与退出码。〔本地〕
- [ ] 2.3 实测 wrangler 4.146.0 的 `--no-x-provision` / `--no-x-auto-create` 是否被接受，在部署配置含全部 ID 时是否改变行为；结论写入 design 决策 1 的「验证结果」，可用就加到两个工作流的部署命令上。同时决定是否加 `--message <SHA>`（决策 10）。验证：`wrangler deploy --dry-run` 带参数时退出 0，结果记录进 design。〔本地〕
- [ ] 2.4 更新 `.agents/skills/deploy-cloudflare/SKILL.md`（预检改用 `pnpm deploy:resources` 的 plan，资源表中 KV / R2 / Queues 改为由命令创建，Hyperdrive 写清两种做法，其中 `--create-hyperdrive` 仅限本地手动使用）与 `docs/07-infrastructure.md`（§0 / §4 / §5：解析步骤、命名约定、按环境拆分的令牌权限（staging 可写、production 只读，已拍板事项 3）、Workers Builds 差异、回滚方式，附 design 中的官方出处和核对日期）。验证：`pnpm check`（含 `agent-skills` 测试）通过，文档中的命令能按写法执行 plan。〔本地〕

## 3. 生成器与升级说明（W3，依赖 1）

- [x] 3.1 `scripts/create-project.mjs`：限流 `namespace_id` 按项目名哈希分号段（design 决策 7），模板保留 1001–1015；保留占位 ID；`PROJECT_SETUP.md` 资源段改为「自动解析 / 需要提供」两部分，并给出 plan 命令。验证：`pnpm test:create-project` 覆盖两个项目号段不重叠、重复生成结果相同、项目内无重复（`check-wrangler-envs` 通过），清单文案快照更新。〔本地〕
- [x] 3.2 `docs/create-project.md` 的部署章节改为先运行 plan、再在 staging 流水线中 apply；起草下一版本的升级说明（`docs/upgrades/_template.md` 格式，草稿放在本 change 目录 `upgrade-notes-draft.md`，由协调者发版时并入），写明「不要删除已填 ID」、工作流合并、令牌权限与回滚。验证：`pnpm check` 通过，草稿涵盖 design 迁移计划的全部要点。〔本地〕
- [x] 3.3 `pnpm test:create-project:verify`：真实副本改名后运行 `pnpm deploy:resources --env staging`，无凭据时应输出缺凭据的计划并以非零退出，且不修改已跟踪文件。验证：该测试通过。〔本地〕

## 4. 集成检查（协调者，依赖 2、3）

- [ ] 4.1 在 main 合并后的工作树执行 `pnpm check`、`pnpm typecheck`、`pnpm test:create-project`、`openspec validate add-deploy-autoprovision --strict`，全部通过；核对 tasks 勾选与 design 中的验证结果已更新。〔本地〕

## 5. 部署与外部凭据验收（单列，不提前勾选）

- [ ] 5.0 在 GitHub `staging` environment 的 `CLOUDFLARE_API_TOKEN` 上加 KV / R2 / Queues 写权限与 Hyperdrive 读权限；`production` environment 的令牌保持只读（已拍板事项 3）。由使用者在 Cloudflare 控制台调整令牌，协调者用 plan 核对权限是否足够。〔凭据〕
- [ ] 5.1 模板 staging（ID 已固定）：合并后 main 的 Deploy staging 成功，解析步骤零 API 调用，健康检查返回完整 SHA，冒烟通过。〔staging〕
- [ ] 5.2 用临时测试前缀（如 `aptest-…-staging`）在模板账号做一次新项目演练：plan 报缺 → `--apply` 创建 KV / R2 / 队列 → 再次 `--apply` 不重复创建 → 缺 Hyperdrive 时失败并提示 → `--create-hyperdrive` 用测试库创建 → 部署成功并通过健康检查。证据写入 `EVIDENCE_DIR`，演练结束后按清单删除临时资源（删除前向使用者确认）。〔凭据〕
- [ ] 5.3 使用 production 只读令牌运行 `deploy:resources --env production`：缺资源时失败、不创建；令牌缺权限时给出明确提示。〔凭据〕
- [ ] 5.4 选一个衍生项目（如 xuanxue）在其同步分支上验证升级：不改 `wrangler.jsonc`，staging 部署行为不变。〔凭据〕
