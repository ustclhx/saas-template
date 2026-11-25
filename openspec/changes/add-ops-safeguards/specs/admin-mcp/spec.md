## ADDED Requirements

### Requirement: 工具与参数说明完整且与文档一致
每个注册的 MCP 工具 SHALL 提供完整的一句以上说明，每个输入参数 SHALL 在 `tools/list` 返回的 inputSchema 中带非空说明。`docs/admin-mcp.md` 的工具清单 MUST 与实际注册的工具在名称、所需 scope、参数名及是否可选上一致。新增或改动工具能力的变更 MUST 在同一 PR 中更新说明与文档；不一致时 CI SHALL 失败。

#### Scenario: 新增参数未写说明
- **WHEN** 开发者给工具新增一个输入参数但没有写说明
- **THEN** 类型检查失败

#### Scenario: 文档漏登记新工具
- **WHEN** 新注册了一个工具但 `docs/admin-mcp.md` 工具表中没有对应行
- **THEN** 守卫测试失败

#### Scenario: 客户端读取参数说明
- **WHEN** MCP 客户端调用 `tools/list`
- **THEN** 每个工具的每个参数都带有说明文字
