# SaaS Template

基于 TanStack Start、Postgres 与 Cloudflare 的 SaaS 模板，也支持自托管 Node/Compose 部署。
架构与领域文档见 [文档目录](docs/README.md)，生成新项目见 [创建项目](docs/create-project.md)。
Node >=22，pnpm 版本以根 `package.json` 为准。

## Agent Skills

项目内提供 8 个技能，Codex 使用 `.agents/skills/`，Claude 使用 `.claude/skills/`：

- `quick-start`：项目选项、真实生成自检、本地数据库、管理员与首次 AI 调用。
- `deploy-cloudflare` / `deploy-selfhost`：资源与配置预检、部署、版本健康与恢复入口。
- `new-page` / `new-module` / `new-static-page`：按模板约定扩展后台、应用、业务与多语言静态内容。
- `add-ai-model`：后台模型配置与必要的 Provider 扩展。
- `security-scan`：确定性本地扫描与变更安全审查。

在项目根输入 `$quick-start`（Codex）或 `/quick-start`（Claude），或直接要求 agent 阅读技能文件执行。
[完整清单与示例](docs/create-project.md#agent-skills) 包含所有技能链接及两处目录同步规则。
部署默认只读预检与 dry-run；具体写入清单确认后才操作，缺外部凭据的环节明确标记待验收。
