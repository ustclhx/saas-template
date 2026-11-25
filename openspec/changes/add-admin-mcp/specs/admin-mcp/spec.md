## ADDED Requirements

### Requirement: 管理员 API 令牌管理
平台管理员 SHALL 能在后台为自己创建、命名、查看与吊销 API 令牌。创建时 MUST 选择 scope（`admin:read`，可附加 `admin:write`）并设置过期时间（默认 90 天，最长 365 天）。令牌完整值 MUST 只在创建时显示一次，之后只显示前缀、名称、scope、过期时间与最近使用时间。数据库 MUST 只保存令牌哈希。创建与吊销 SHALL 写审计。管理员只能看到和吊销自己的令牌。

#### Scenario: 创建后刷新
- **WHEN** 管理员创建令牌后刷新页面
- **THEN** 只能看到令牌前缀与元数据，无法再次查看完整值

#### Scenario: 非管理员访问
- **WHEN** 普通用户访问令牌管理页或调用其接口
- **THEN** 返回与其他后台页面一致的 404

### Requirement: 令牌校验
MCP 端点 SHALL 对每次请求校验 `Authorization: Bearer` 令牌：哈希匹配、未吊销、未过期，且所属用户此刻仍是未封禁的平台管理员（实时查询，不缓存权限）。任一条件不满足 MUST 返回 401，不区分具体原因。成功使用 SHALL 更新最近使用时间（同一令牌每分钟最多写一次）。令牌 MUST NOT 能用于网页登录或其他 API。

#### Scenario: 管理员被降级
- **WHEN** 令牌所属用户被降为普通用户后再用该令牌调用 MCP
- **THEN** 返回 401

#### Scenario: 令牌已吊销
- **WHEN** 使用已吊销或已过期的令牌调用
- **THEN** 返回 401

### Requirement: MCP 端点协议
插件启用时，系统 SHALL 在 `/api/admin/mcp` 提供无会话的 MCP Streamable HTTP 端点，支持 initialize、tools/list、tools/call。端点 MUST 每令牌限流、限制请求体大小，响应 MUST 带 `Cache-Control: no-store` 与 `X-Robots-Tag: noindex`。错误 MUST 映射为 MCP 错误结果，不包含堆栈、SQL 或密钥。插件未启用时该路径 MUST 返回 404。

#### Scenario: 用 MCP 客户端连接
- **WHEN** 管理员在 Claude Code 中以 HTTP 传输与 Bearer 头添加该端点
- **THEN** 客户端完成 initialize 并列出工具

#### Scenario: 超出限流
- **WHEN** 同一令牌在一分钟内的请求超过限额
- **THEN** 返回 429，不执行工具

### Requirement: 工具与 scope
`admin:read` 令牌 SHALL 只能调用只读工具：运行时设置读取与列表、AI 模型列表、功能模型、用户搜索与详情、空间列表、订单列表、积分流水、审计列表、业务指标。写工具 `settings.set` 与 `models.update` MUST 需要 `admin:write`。读工具返回的字段 MUST 不超出后台页面本来展示的范围，分页与后台列表一致。系统 MUST NOT 提供退款、删除或封禁用户、积分调整、支付平台写操作、模拟登录的工具。

#### Scenario: 只读令牌调用写工具
- **WHEN** 只有 `admin:read` 的令牌调用 `settings.set`
- **THEN** 返回权限错误，设置不变，审计记录该次被拒的调用

### Requirement: 写工具与 dryRun
`settings.set` SHALL 按设置定义校验后写入任意已登记的运行时设置，写入后清除该项缓存（与后台保存一致），返回新旧值。`models.update` SHALL 复用后台模型管理的校验，修改模型的启用状态、参数与定价。两者 SHALL 支持 `dryRun: true`：校验并返回将写入的新旧值，但 MUST NOT 落库或清缓存。写工具 MUST 经与后台相同的 `adminAction` 包装执行。

#### Scenario: 先预览再写入
- **WHEN** agent 以 `dryRun: true` 调用 `settings.set`，确认后再以 `dryRun: false` 调用
- **THEN** 第一次返回新旧值且数据库不变，第二次写入并返回相同的新旧值

#### Scenario: 非法取值
- **WHEN** `settings.set` 的值不符合该设置项的 schema
- **THEN** 返回校验错误，设置不变

### Requirement: 调用审计
每次 tools/call（包括只读与被拒绝的调用）SHALL 写一条审计：操作人为令牌所属管理员，`meta` 含 `via: 'mcp'`、令牌 id、工具名、参数摘要与结果（成功或错误码）。参数摘要中密钥类设置的值 MUST 脱敏。写工具的审计 MUST 与业务写入同事务，并与后台保存使用相同的新旧值格式。

#### Scenario: 后台查看 MCP 操作
- **WHEN** 管理员在后台审计页按动作筛选
- **THEN** 能看到 MCP 调用记录及其令牌、工具名与新旧值

### Requirement: 密钥不出端点
读取运行时设置时，被定义为密钥的设置项 SHALL 只返回「已设置 / 未设置」；任何工具 MUST NOT 返回令牌哈希、Provider API 密钥或 Worker 密钥。

#### Scenario: 读取运营通知令牌
- **WHEN** 调用 `settings.get` 读取 `operations.telegramBotToken`
- **THEN** 只返回是否已设置，不返回值
