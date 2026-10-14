# Tasks

## 1. 项目启动与部署

- [x] 1.1 创建同步 quick-start 技能，包含完整选项、三层配置/外部 key、本地管理员与 AI 验收；在临时目录真实执行非交互生成、安装、typecheck 与 unit 并保存脱敏结果。
- [x] 1.2 创建同步 deploy-cloudflare / deploy-selfhost 技能，覆盖参数、幂等预检、确认门、现有部署/health/回滚与备份恢复入口；只读检查命令/help、Cloudflare 构建 dry-run 与 selfhost 配置/安全预检通过，不创建资源、不部署、不改 secrets。
- [x] 1.3 更新 docs/create-project.md、docs/README.md 和根 README 的 Agent Skills 入口，核对名称、调用示例、路径、同步规则与验收限制。

## 2. 业务扩展与安全

- [x] 2.1 创建同步 new-page / new-module 技能；在一次性副本分别实际生成最小页面和模块，运行 pnpm check、typecheck、相关测试通过，丢弃样例并保存 PR 证据。
- [x] 2.2 创建同步 new-static-page / add-ai-model 技能；核对内容、语言/SEO、模型 schema 与 Provider 引用均指向真实源码，frontmatter 校验通过。
- [x] 2.3 创建同步 security-scan 技能；真实执行工程检查与敏感路径/凭据扫描、diff 审查，核对不输出真值、不把远端 secret 名称预检冒充源码泄漏扫描。

## 3. 集成与交付

- [x] 3.1 八技能 frontmatter、引用路径和双目录 byte 对比通过，openspec validate add-agent-skills --strict 与 pnpm check、check:deps、check:singletons、typecheck、test、build、dedupe --check 均通过；记录离线验证范围与未做外部验收。
- [x] 3.2 fetch/rebase origin/main 后复核变更并推送，创建中文标题 PR、描述逐项验证和未完成外部验收；Orca 卡片设置 in-review 与 comment「skills PR 已开：#<号>」，不合并、不归档。
