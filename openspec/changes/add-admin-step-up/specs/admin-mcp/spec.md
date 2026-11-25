## MODIFIED Requirements

### Requirement: 工具与 scope
`admin:read` 令牌 SHALL 只能调用只读工具：运行时设置读取与列表、AI 模型列表、功能模型、用户搜索与详情、空间列表、订单列表、积分流水、审计列表、业务指标、待确认记录查询。写工具 `settings.set`、`models.update`、`credits.adjust`（空间积分增加或收回批次）与 `refunds.review`（审核已有退款申请）MUST 需要 `admin:write`。读工具返回的字段 MUST 不超出后台页面本来展示的范围，分页与后台列表一致。命中敏感操作清单的写工具调用 MUST 经管理员确认后才执行。系统 MUST NOT 提供删除或封禁用户、模拟登录、创建管理员令牌、退款审核以外的支付平台写操作的工具。

#### Scenario: 只读令牌调用写工具
- **WHEN** 只有 `admin:read` 的令牌调用 `settings.set`
- **THEN** 返回权限错误，设置不变，审计记录该次被拒的调用

#### Scenario: 调用退款审核
- **WHEN** 持有 `admin:write` 的令牌调用 `refunds.review` 以部分金额通过某退款申请
- **THEN** 返回 `needs_owner_confirm`，退款申请状态不变，直到管理员在后台确认

### Requirement: 写工具与 dryRun
`settings.set` SHALL 按设置定义校验后写入任意已登记的运行时设置，写入后清除该项缓存（与后台保存一致），返回新旧值。`models.update` SHALL 复用后台模型管理的校验，修改模型的启用状态、参数与定价。写入密钥类设置或修改定价时，两者 SHALL 返回 `needs_owner_confirm`，经管理员确认后才写入；其余改动直接写入。写工具 SHALL 支持 `dryRun: true`：校验并返回将写入的新旧值（密钥脱敏），但 MUST NOT 落库、清缓存或创建待确认记录。写工具 MUST 经与后台相同的 `adminAction` 包装与敏感操作清单执行。

#### Scenario: 先预览再写入
- **WHEN** agent 以 `dryRun: true` 调用 `settings.set` 修改普通设置，确认后再以 `dryRun: false` 调用
- **THEN** 第一次返回新旧值且数据库不变，第二次写入并返回相同的新旧值

#### Scenario: 非法取值
- **WHEN** `settings.set` 的值不符合该设置项的 schema
- **THEN** 返回校验错误，设置不变

#### Scenario: 写密钥类设置
- **WHEN** agent 以 `dryRun: false` 调用 `settings.set` 写入 `operations.telegramBotToken`
- **THEN** 返回 `needs_owner_confirm`，设置不变，直到令牌所属管理员在后台确认

#### Scenario: 只改模型启停
- **WHEN** agent 调用 `models.update` 只停用某模型
- **THEN** 直接写入并返回新旧值，不需要确认
