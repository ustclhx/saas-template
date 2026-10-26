# Spec Delta

## MODIFIED Requirements

### Requirement: 双目录技能入口
系统 SHALL 提供 quick-start、deploy-cloudflare、deploy-selfhost、new-page、new-module、new-static-page、add-ai-model、security-scan、template-sync；每个技能 SHALL 有 name/description 和可执行步骤、真实命令、验收条件、常见故障，两处目录内容 MUST 完全一致。

#### Scenario: 两种 agent 使用同一技能
- **WHEN** 使用者分别读取 `.agents/skills` 与 `.claude/skills` 下同名技能
- **THEN** 获得逐字节一致的指导，且引用能在项目中解析

## ADDED Requirements

### Requirement: 模板同步先预检再授权
template-sync 技能 SHALL 用于衍生项目。它 SHALL 先做只读预检：
- 基准记录；
- 工作区是否干净；
- 模板可达性；
- 待采纳的版本区间、各版本升级说明中的必须执行动作与 `requiresDeployed` 边界；
- 待移植的迁移。

然后在本地分支上执行同步并报告冲突与验证结果。推送、开 PR、合并以及任何环境上的迁移 MUST 先列出具体动作并取得明确确认。冲突 MUST 由使用者或在其指示下逐个处理，不得整体采用任一方。升级说明中涉及外部系统的动作（新增密钥、部署绑定、线上迁移）MUST 逐项确认，不得代为执行。

#### Scenario: 默认调用同步技能
- **WHEN** 使用者调用 template-sync 但未批准推送或开 PR
- **THEN** 只在本地同步分支上完成合并与验证并输出报告，不推送、不开 PR、不迁移任何数据库

#### Scenario: 升级说明要求新增密钥
- **WHEN** 区间内某个版本的升级说明要求配置新的 secret
- **THEN** 技能在待办清单中列出 secret 名称与配置位置，不读取也不写入任何密钥值

#### Scenario: 没有基准记录
- **WHEN** 在没有 `.template-base.json` 的衍生项目中调用技能
- **THEN** 技能改为引导基准推断，并在写入记录前请求确认
