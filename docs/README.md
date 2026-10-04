# SaaS Template 技术设计文档

自用的 AI SaaS 模板。目标：以 Cloudflare 为主要运行平台、自建 Postgres 为数据层，作为后续不同 AI 应用的起点，通过配置开关适配不同业务形态（个人用户 / 团队、订阅 / 积分）。

> 状态：**v0.4（2026-10-04）**。Phase 0 与 Phase 1 已完成、部署到 staging 并归档，验收记录见 `08`。Phase 2（计费与积分）开发中，已验收 10/34 项任务。真实 OAuth 联调与 Resend 发送仍待配置，当前保持 OAuth mock、邮件 log 模式。支付平台与可选 RLS 等能力在对应阶段实测。基础设施按两个阶段推进，当前为阶段一（数据库在开发者本机，见 `07` §0）。

## 文档目录

| 文档 | 内容 |
|---|---|
| [01-architecture.md](./01-architecture.md) | 总体架构、技术栈、Cloudflare 服务与 Workers 限制 |
| [02-project-structure.md](./02-project-structure.md) | Monorepo 目录结构、模块划分、配置体系、编码约定 |
| [03-data-model.md](./03-data-model.md) | 数据表设计（字段、索引、约束） |
| [04-auth-and-tenancy.md](./04-auth-and-tenancy.md) | 认证、平台角色、可选多租户（Workspace） |
| [05-billing.md](./05-billing.md) | 支付抽象（Stripe / PayPal / 未来 MoR）、订阅、积分、权益 |
| [06-ai.md](./06-ai.md) | 文本 / 图片 / 视频生成、任务模型、Provider 适配、计费结算 |
| [07-infrastructure.md](./07-infrastructure.md) | 自建 Postgres、Hyperdrive + Tunnel、备份、环境、部署、CI |
| [08-roadmap.md](./08-roadmap.md) | 分阶段开发计划与验收标准、待决事项 |
| [09-parallel-plan.md](./09-parallel-plan.md) | 用 Orca 并行开发：worktree 隔离、共享文件规则、并行波次与合并流程 |

## 已确定的关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 运行平台以 **Cloudflare** 为主（Workers / R2 / KV / Queues / Workflows / AI Gateway） | 成本低、全球边缘、服务齐全 |
| D2 | 框架使用 **TanStack Start**（非 Next.js） | 对 Workers 一等支持，本地开发即 workerd 运行时，包体更小 |
| D3 | 数据库使用 **自建 Postgres**，经 **Hyperdrive + Cloudflare Tunnel（Workers VPC）** 访问，ORM 为 **Drizzle**；最小原型前数据库在本机，之后迁移到生产服务器（`07` §0） | D1 能力不足；Tunnel 避免数据库暴露公网；只用标准 PG 以便迁移到托管服务 |
| D4 | 模板**不绑定地区与时区**：数据库地区为部署参数，时间一律 UTC 存储，展示时按用户时区换算 | 面向不同应用需求 |
| D5 | 支付先接 **Stripe + PayPal**，通过 `PaymentProvider` 抽象，后续扩展 MoR（Creem / Paddle / Polar）；不做中国大陆境内支付 | 暂无主体；PayPal 可个人跨境收款，Stripe 先做测试模式开发 |
| D6 | **多租户为可选项**，采用「个人空间」模型：所有数据归属 Workspace，开关只控制是否允许团队 Workspace | 一套代码适配 B2C / B2B |
| D7 | AI 同时支持 **文本、图片、视频**；文本走流式同步，图片/视频统一为异步任务（Cloudflare Workflows） | 三者耗时差异大 |
| D8 | 计费同时支持 **订阅 + 一次性积分包**；积分按「批次」管理，预扣-结算模型 | 两种商业模式都要支持 |
| D9 | 认证使用 **Better Auth**（organization / admin / api-key 等插件） | 开源、数据自持、插件完善 |
| D10 | 仓库采用 **pnpm monorepo**：`apps/web`（TanStack Start）+ `apps/jobs`（后台 Worker）+ 共享 packages | Workflows / 队列消费者 / Cron 与 Web 解耦 |

## 参考对象

ShipAny、MkSaaS、TanStarter（功能清单参考）、Aceternity UI / Magic UI（营销页组件参考）。不购买、不复制其代码。
