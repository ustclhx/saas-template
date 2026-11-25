## ADDED Requirements

### Requirement: 运行时设置定义
每个运行时设置项 SHALL 在代码中登记一份定义：值的 schema、代码默认值、说明，以及是否为密钥。模板设置项由模板登记，项目设置项登记在项目自有文件中（template-sync 保留），两者键名 MUST 不重复。后台保存、MCP 写入与读取回退 SHALL 使用同一份定义校验；数据库中的值不符合定义时读取 MUST 报错而不是静默使用。

#### Scenario: 项目新增设置项
- **WHEN** 项目在项目自有文件中登记新设置项并在业务代码中读取
- **THEN** 未写入数据库时返回其默认值，MCP 能列出并按 schema 写入该项

#### Scenario: 写入不符合定义的值
- **WHEN** 任一写入路径提交不符合该项 schema 的值
- **THEN** 写入被拒绝，数据库不变
