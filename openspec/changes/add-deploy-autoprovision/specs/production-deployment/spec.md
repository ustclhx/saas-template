## MODIFIED Requirements

### Requirement: 生产发布顺序、串行与版本确认
生产发布 MUST 串行执行，按「解析部署资源 → 构建 jobs 与 web → 数据库迁移 → 部署 jobs → 部署 web」顺序进行，任一步失败 MUST 停止后续步骤；资源解析或构建失败时 MUST NOT 执行迁移。生产资源解析 MUST 只查找、不创建，jobs 与 web MUST 使用解析生成的部署配置。web 部署后 SHALL 轮询 `GET /api/health`，直到返回 200、`db.status` 为 `up` 且 `version` 等于本次提交的完整 SHA；限定时间内未满足 MUST 使流水线失败。日志 MUST NOT 包含连接串或密钥。

#### Scenario: 正常发布
- **WHEN** 已审批的生产发布开始
- **THEN** 资源解析找到全部生产资源，jobs 与 web 构建成功后，生产数据库应用全部迁移，随后 jobs、web 依次部署，健康检查返回本次完整 SHA

#### Scenario: 生产资源缺失
- **WHEN** 已审批的生产发布中，资源解析找不到约定名称的生产队列
- **THEN** 流水线在构建前失败，不创建该队列，不执行迁移，生产继续运行上一版本

#### Scenario: 构建失败
- **WHEN** 生产发布的 web 构建失败
- **THEN** 不执行迁移，生产数据库与 Worker 均不变，流水线失败

#### Scenario: 迁移失败
- **WHEN** 生产迁移失败
- **THEN** jobs 与 web 均不部署，生产继续运行上一版本，流水线失败

#### Scenario: 并发发布
- **WHEN** 一次生产发布进行中又推送了新的版本 tag
- **THEN** 新发布等待前一次完整结束后才开始，进行中的发布不被取消
