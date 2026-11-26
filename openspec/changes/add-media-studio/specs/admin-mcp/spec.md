# Spec Delta

## ADDED Requirements

### Requirement: 插件提供的工具
已启用插件 SHALL 能向管理员 MCP 端点注册工具；插件工具 MUST 与内置工具遵循同样的 scope 划分（只读工具需 `admin:read`，写工具需 `admin:write`）、调用审计、`dryRun` 与敏感写入的确认执行规则，名称 MUST 以插件 id 为前缀且不与已有工具重名。插件未启用时其工具 MUST NOT 出现在工具列表中。

#### Scenario: studio 审核工具
- **WHEN** 启用 studio 的站点用 `admin:write` 令牌调用作品下架工具并附原因
- **THEN** 作品被下架，审计记录 `via=mcp`

#### Scenario: 只读令牌
- **WHEN** 只有 `admin:read` 的令牌调用作品下架工具
- **THEN** 返回权限错误，作品状态不变

#### Scenario: 插件未启用
- **WHEN** 项目未启用 studio
- **THEN** `tools/list` 中没有 studio 前缀的工具
