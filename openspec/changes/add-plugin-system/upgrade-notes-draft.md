# 媒体插件升级说明草稿

<!-- 发版时将以下章节并入 docs/upgrades/<version>.md，按发布模板补全 frontmatter 并设置 breaking: true。 -->

## 概要

**BREAKING**。图片与视频生成迁入构建期 `media` 插件。启用图片或视频的项目必须声明 `plugins.media`。生成项目仍保留全部插件源码，构建时只注册启用的插件。

## 必须执行的动作

1. 检查同步后的 `template.config.ts`。需要图片或视频时，在顶层 `plugins` 对象中加入 `media: { providers: [...] }`，把已有的 `ai.mediaProviders` 列表原样移到 `providers`，包括显式空列表。使用模板默认服务商的项目可以写 `media: {}`。删除原 `ai.mediaProviders` 配置。
2. 对 xuanxue 等完全关闭媒体的项目，确认 `ai.image` 与 `ai.video` 都是 `false`，且 `plugins` 中没有 `media`。检查 `apps/web/wrangler.jsonc` 与 `apps/jobs/wrangler.jsonc` 的顶层、`env.staging`、`env.production`。从 web 的 `workflows` 删除绑定 `AI_MEDIA_WORKFLOW`，从 jobs 的 `workflows` 删除 `class_name` 为 `AiMediaWorkflow` 的定义。只为媒体配置的 `ai`（绑定 `AI`）也一并移除。数组清空后可删除该 `workflows` 键。
3. 查阅同步报告中「模板已删除、项目中保留的文件」。如果仍保留迁移前的媒体路由或入口，将项目自己的修改移到 `plugins/media` 对应位置，再移除已迁走的旧文件。

## 配置变更

- `plugins.media` 开启媒体插件。`ai.image` 与 `ai.video` 控制启用的任务种类。
- `plugins.media.providers` 取代 `ai.mediaProviders`，默认 `['fal', 'workers-ai']`。
- 继续在 Cloudflare 上运行媒体的项目，在 web 和 jobs 的 Wrangler 各环境保留 `AI_MEDIA_WORKFLOW`。使用 Workers AI 时同时保留两个 Worker 的 `AI` 绑定。

## 数据库变更

无

## 部署顺序

按目标正常发布，Cloudflare 先 jobs 后 web。发布前将模板配置和两个 Worker 的绑定作为同一组变更核对。

## 验证

运行 `pnpm check`、`pnpm typecheck` 和 `pnpm test`，再运行目标对应的构建（Cloudflare 为 `pnpm build`，selfhost 为 `pnpm build:node`）。开启媒体的项目在 staging 验证已启用的图片或视频任务能够生成并结算。关闭媒体的项目确认媒体导航消失，访问 `/app/<空间>/media/new` 与 `/api/webhooks/media/fal` 得到 404。

## 回滚

回退到上一版本代码及其 Wrangler 配置。若手动回退配置，将服务商列表从 `plugins.media.providers` 放回 `ai.mediaProviders`，并恢复旧版本所需的媒体绑定。

## 已知问题

无
