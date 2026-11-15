# Spec Delta

## ADDED Requirements

### Requirement: 生产日志与错误追踪必须可用
Cloudflare 生产环境的 web 与 jobs Worker SHALL 开启平台日志持久化，使结构化日志（含邮件丢弃、定时任务失败、计费重试等只以日志记录的事件）可在事后检索。仓库发布阶段为上线后时，生产发布 MUST 在缺少错误追踪配置时失败；测试阶段 SHALL 仅在流水线摘要中警告。

#### Scenario: 上线后缺少 Sentry 配置
- **WHEN** 发布阶段为上线后，production environment 未配置错误追踪 DSN，触发生产发布
- **THEN** 流水线在迁移前失败并指出缺少的配置名

#### Scenario: 事后检索定时任务失败
- **WHEN** 生产 jobs 的一次定时任务失败并输出错误日志
- **THEN** 运维可在平台日志中按请求 ID 检索到该条日志
