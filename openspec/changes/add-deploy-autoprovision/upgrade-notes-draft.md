---
version: 待定
previous: 0.9.1
date: YYYY-MM-DD
breaking: false
---

<!-- 发版时由协调者填写版本和日期、核对 previous，并按 docs/upgrades/README.md 确认 breaking。 -->

## 概要

Cloudflare 发布在部署前解析 KV、R2 桶、队列（含死信队列）和 Hyperdrive，生成 web 与 jobs 的部署配置。新项目保留 KV 和 Hyperdrive 的占位 ID，生成器按项目名分配限流号段。

## 必须执行的动作

无

## 配置变更

- 已有 Cloudflare 项目可沿用 `wrangler.jsonc`。**不要删除已填的 KV 或 Hyperdrive ID。** 解析优先使用固定 ID。清空后会重新按名称查找，允许创建时可能绑定到一组空资源。同步分支若带入生成器的新限流号段，保留现用的 `namespace_id` 可延续已有计数。
- 项目自定义过发布工作流时，检查合并结果。staging 在迁移前运行 `pnpm deploy:resources --env staging --apply`，production 在构建前运行 `pnpm deploy:resources --env production`。jobs 的构建和部署都加 `--config wrangler.deploy.json`。web 构建用 `WRANGLER_DEPLOY_CONFIG` 指向 `apps/web/wrangler.deploy.json`，沿用 `CLOUDFLARE_ENV` 和构建产物中的部署配置。两份 `wrangler.deploy.json` 由脚本生成并被 Git 忽略。[Cloudflare Vite 插件环境配置](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/)（2026-11-26 核对）
- 按 GitHub environment 区分资源解析令牌权限。首次部署或采用自动解析的 staging 环境，给 `CLOUDFLARE_API_TOKEN` 配置 `Workers KV Storage Write`、`Workers R2 Storage Write`、`Queues Write` 和 `Hyperdrive Read`。production 的资源解析使用只读权限 `Workers KV Storage Read`、`Workers R2 Storage Read`、`Queues Read`、`Hyperdrive Read`。照常为 Worker 发布步骤提供发布权限。目标环境的 KV、Hyperdrive ID 都已固定时，默认解析沿用配置中的 ID 和名称，无须为这一步增加 API 权限。 [KV 列表](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/list/) · [R2 列表](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/list/) · [Queues 列表](https://developers.cloudflare.com/api/resources/queues/methods/list/) · [Hyperdrive 列表](https://developers.cloudflare.com/api/resources/hyperdrive/subresources/configs/methods/list/) · [KV 创建](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/) · [R2 创建](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/) · [Queues 创建](https://developers.cloudflare.com/api/resources/queues/methods/create/)（2026-11-26 核对）

## 数据库变更

无

## 部署顺序

1. 先同步资源解析脚本，再同步引用部署配置的工作流与 Vite 配置。模板 staging 和已固定资源 ID 的项目，默认解析无需调用资源 API。
2. 新项目或启用自动解析的环境，先在项目根目录运行 `pnpm deploy:resources --env staging` 核对名称、归属和缺项。按计划准备 Hyperdrive，提供数据库 app 账号连接串。维护者可在本地用 `--apply --create-hyperdrive` 和 `HYPERDRIVE_APP_URL` 创建。 [Hyperdrive 官方指南](https://developers.cloudflare.com/hyperdrive/get-started/)（2026-11-26 核对）
3. staging 流水线运行 apply，补齐缺失的 KV、R2 桶和队列后执行迁移、构建和发布。production 流水线只运行 plan，资源缺失时中止。需要补齐生产资源时，由维护者在本地核对计划后运行 `pnpm deploy:resources --env production --apply --allow-production`。

## 验证

- 同步分支先运行 `pnpm check`。已有环境核对计划输出中的固定 ID 和资源名称与原配置一致。新环境核对 plan 所列缺项与 apply 摘要中的新增资源。
- staging 发布后确认健康检查的版本是目标完整 SHA，并通过 staging 冒烟。

## 回滚

1. 依赖自动解析的项目，先用对应环境的成功 plan 输出的 ID 清单，将真实 ID 填回两个 app 的 `wrangler.jsonc`。同时核对 R2 桶名、队列名和原先由解析补齐的账号 vars。
2. 删除工作流的解析步骤、jobs 的 `--config wrangler.deploy.json` 和 web 构建的 `WRANGLER_DEPLOY_CONFIG`，恢复直接读取已提交的配置。已全部配置真实 ID 的项目可以直接切换。
3. 保留已创建的资源。

## 已知问题

同一 Cloudflare 账号下的项目应使用不同的资源名前缀，并核对限流号段是否重叠。生成器用项目名哈希减少号段冲突，账号内的所有限流命名空间需要项目方统一管理。 [Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)（2026-11-26 核对）
