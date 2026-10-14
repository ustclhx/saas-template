# Proposal

## Why

模板已有生成器、部署 runbook 与业务扩展模式，但使用者仍需自行拼接操作步骤。提供仓库内 Agent Skills，让 Codex 与 Claude 能依据真实入口完成项目启动、部署准备与功能扩展，并清楚区分离线验证和外部验收。

## What Changes

- 在 `.agents/skills` 与 `.claude/skills` 增加完全同步的 quick-start、deploy-cloudflare、deploy-selfhost、new-page、new-module、new-static-page、add-ai-model、security-scan。
- 每个技能包含 name/description、执行步骤、真实命令、验收条件与故障处置；部署技能默认只读，外部写入前列出具体动作并确认。
- 更新 `docs/create-project.md`、`docs/README.md`，新增根 README 提供 Agent Skills 入口。
- 用临时副本真实验证生成器与页面/模块技能；部署仅预检与 dry-run。排除 clone-website、generate-image、sync-upstream。

## Capabilities

### New Capabilities

- `agent-skills`: 本模板的项目启动、部署准备和扩展技能契约，以及双目录一致性与验证证据。

### Modified Capabilities

无。复用 project-bootstrap 与 staging-deployment 现有行为，不改变生成器、部署或业务 API。

## Impact

仅技能 Markdown、说明文档与本 change 规划材料；不增加依赖、不改 schema/迁移或运行时代码。现有 `pnpm create-project`、staging 发布和 selfhost release 是执行依据；本次不创建云资源、不部署、不改 secrets。样例代码仅留在一次性副本，证据写入 PR。
