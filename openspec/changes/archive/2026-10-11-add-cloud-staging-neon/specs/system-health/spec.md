# Spec Delta

## MODIFIED Requirements

### Requirement: 健康检查端点
系统 SHALL 提供 `GET /api/health`，无需认证；数据库可达时返回 200，响应体包含数据库往返耗时（毫秒）与当前部署版本标识。版本标识 MUST 在构建时确定，并能区分不同提交的部署：CI 构建使用完整 commit SHA，本地构建使用当前提交的短 SHA，无法取得提交信息时回退到包版本号。

#### Scenario: 数据库正常
- **WHEN** 探活服务请求 `GET /api/health` 且数据库可达
- **THEN** 返回 200，响应体包含 `db.latencyMs` 与 `version`

#### Scenario: 数据库不可达
- **WHEN** 数据库连接失败或超时（超过 5 秒）
- **THEN** 返回 503，响应体标明数据库不可用，且不泄露连接串或主机名

#### Scenario: 区分部署版本
- **WHEN** CI 以 commit SHA `abc123…` 构建并部署 web
- **THEN** 健康检查响应（无论 200 还是 503）的 `version` 等于 `abc123…`
