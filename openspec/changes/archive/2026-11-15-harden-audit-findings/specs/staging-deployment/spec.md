# Spec Delta

## MODIFIED Requirements

### Requirement: main 合并后自动部署 staging
main 分支的 CI 检查全部通过后，系统 SHALL 自动按「数据库迁移 → 部署 jobs → 部署 web」的顺序更新 staging；任一步失败 MUST 停止后续步骤并使流水线失败。手动触发的 staging 发布 MUST 同样要求被发布的 main 提交已通过 CI，只有仓库发布阶段为测试阶段，或上线后手动选择紧急修复并填写原因时可以不要求，并 MUST 在流水线摘要中记录绕过类型、原因与触发人。

#### Scenario: 正常发布
- **WHEN** 一个提交合并到 main 且 CI 检查通过
- **THEN** staging 数据库应用该提交包含的全部迁移，随后 jobs-staging、web-staging 依次部署该提交

#### Scenario: 迁移失败
- **WHEN** staging 迁移执行失败
- **THEN** jobs 与 web 均不部署，流水线标记失败，staging 继续运行上一版本

#### Scenario: CI 未通过
- **WHEN** main 上某个提交的 CI 检查失败
- **THEN** 不执行 staging 迁移与部署

#### Scenario: 上线后手动触发未通过 CI 的提交
- **WHEN** 发布阶段为上线后，维护者手动触发 staging 发布，该提交 CI 失败且未选择紧急修复
- **THEN** 流水线在迁移前失败
