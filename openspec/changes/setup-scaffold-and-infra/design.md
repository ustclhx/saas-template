# Design

## Context

总体设计见 `docs/01-architecture.md`、`docs/02-project-structure.md`、`docs/07-infrastructure.md`；动机见 proposal.md。本 change 是第一个写代码的 change，没有既有实现可参考。设计文档中标注「待验证」的平台行为，在本 change 中只做最小可运行的实测，不实现业务逻辑。

## Goals / Non-Goals

**Goals:**
- 产出后续所有 change 共用的工程骨架（目录、构建、测试、部署、迁移流水线）。
- 用可重复执行的实测脚本或测试，确认（或推翻）设计依赖的平台行为，并把结论写回 `docs/`。

**Non-Goals:**
- 不实现认证、计费、AI 等任何业务表或接口（只建 `setting` 表与健康检查所需的最小 schema）。
- 不做 preview 环境（设计中为可选项，后续需要时再加）。
- 不做 PG 高可用；单机 + 备份是设计中明确的取舍（`docs/07-infrastructure.md`「可用性目标」）。

## Decisions

1. **monorepo 工具**：pnpm workspaces + Turborepo。Turborepo 只用于任务编排与缓存，不引入其远程缓存。备选是只用 pnpm `-r`：包少时够用，但 web/jobs/packages 的 build、typecheck、test 依赖顺序靠手写容易出错。
2. **TanStack Start 运行方式**：使用 Cloudflare 官方 Vite 插件，本地 `vite dev` 直接跑在 workerd。若实测发现插件与 TanStack Start 的 SSR 入口不兼容，退路是 `wrangler dev` + 构建产物；结论写入 `docs/01-architecture.md` 技术栈的备注。
3. **Workflow 放在独立 Worker**（`apps/jobs`），web 通过 `script_name` 绑定。实测项：web 启动 jobs 中定义的 Workflow、对实例 `sendEvent`，以及「实例尚未执行到 `waitForEvent` 时收到的事件是否被保留」。无论结论如何，媒体任务的设计都已通过「回调先落库」兜底（`docs/06-ai.md`），实测只决定是否可以去掉 `check-callback` 这一步。
4. **数据库客户端按请求创建**：`createDb(env.HYPERDRIVE)` 每个请求或事件调用一次，`max: 5`、`prepare: true`、`fetch_types: false`。在 vitest-pool-workers 中提供一个直连本地 PG 的 Hyperdrive 模拟（`localConnectionString`）。
5. **ID 生成**：应用层生成 UUIDv7，列类型 `uuid`。本 change 只提供生成函数与 `setting` 表；Better Auth 表的类型调整放到 auth change 中验证。
6. **迁移执行**：drizzle-kit 生成 SQL 迁移，CI 中通过 `cloudflared access tcp` 转发端口后以 `migrator` 账号执行；`app` 账号只有 DML 权限。备选「SSH 到 VPS 执行」作为 runbook 中的应急方式。
7. **表单库（Q1）**：选 TanStack Form + Zod。理由：与 TanStack Router/Query 同一生态、类型推导更完整；react-hook-form 生态更成熟但与 Server Functions 的集成需要更多胶水代码。若 shadcn/ui 表单组件适配成本过高，在 auth change 第一个表单时再评估。
8. **健康检查**：只走 `HYPERDRIVE`（不缓存）绑定，见 `specs/system-health`。`jobs.lastCronAt` 存在 `setting` 表的一个保留键中，避免为此新建表。

## Risks / Trade-offs

- [TanStack Start 与 Cloudflare Vite 插件的组合变动快] → 锁定版本；把可运行的最小配置写进 `docs/runbooks/`，升级时先跑 Phase 0 的实测用例。
- [Hyperdrive 经 Tunnel 的延迟高于预期] → 记录开/关 Smart Placement 的延迟基线；必要时改用显式放置区域（placement region）或评估托管 PG。结论写入 `docs/07-infrastructure.md`。
- [advisory lock 在 Hyperdrive 事务模式下不可用] → 后续 change 的并发控制改为锁住 workspace 行（`SELECT ... FROM organization WHERE id=? FOR UPDATE`），在 `docs/04`、`docs/06` 中替换写法。
- [`waitUntil(consumeStream())` 在客户端断开后不能完成] → 文本对话的结算改为完全依赖 hold 超时回收的兜底，并调整 `docs/06-ai.md` 中的说明。
- [单台 VPS 故障] → 已接受的取舍；本 change 必须完成一次从 R2 备份恢复到新实例的演练，验证 RTO。

## Migration Plan

全新项目，无既有数据。部署顺序固定为：迁移 → `apps/jobs` → `apps/web`。回滚：Worker 用 `wrangler rollback`；迁移只做向后兼容变更，因此回滚 Worker 不需要回滚 schema。

## Open Questions

- Turborepo 是否值得保留：如果实测后任务编排很简单，可以在后续 change 中移除，不影响其他设计。
