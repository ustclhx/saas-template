# 管理员 MCP

`admin-mcp` 插件提供 `/api/admin/mcp`。平台管理员用个人令牌读取后台数据，修改运行时设置和已有 AI 模型，或发起需要管理员确认的积分调整与退款审核。端点使用无会话的 Streamable HTTP，以 POST 接收 MCP 请求并返回 JSON。[启停与部署](plugins.md#内置插件)

## 创建令牌

1. 以目标环境的平台管理员身份登录，打开后台「API 令牌」(`/admin/api-tokens`)，选择「创建令牌」。
2. 填写能区分用途的名称，最多 100 字符。保留 `admin:read`。执行设置或模型更新时附加 `admin:write`，预览也需要此权限。有效期默认 90 天，上限默认 365 天，部署可设置更短上限。
3. 将一次性显示的完整令牌存入个人钥匙串。列表显示令牌前缀和元数据，数据库仅保存令牌的 SHA-256 摘要。创建和吊销都会写入审计。

每位管理员管理自己的令牌。端点每次请求都核验令牌、有效期和所属用户当前的管理员角色与封禁状态。令牌只用于本环境的管理员 MCP。轮换时先在客户端验证新令牌，再吊销旧令牌。泄露时立即吊销。已吊销或已过期的令牌会在列表置灰保留 30 天，审计仍可关联其 ID。

## 连接 Claude Code

在项目目录执行以下命令，将域名换成目标环境的地址。将 `ADMIN_MCP_TOKEN` 从钥匙串注入启动 Claude Code 的进程环境。下例中的单引号使客户端配置保留变量引用。真值只交给目标环境的 MCP 客户端。

```sh
claude mcp add --transport http --scope local admin-mcp https://app.example.com/api/admin/mcp \
  --header 'Authorization: Bearer ${ADMIN_MCP_TOKEN}'
```

在同一环境运行 `claude mcp list`，或在会话里打开 `/mcp`，确认 `admin-mcp` 已连接。调用 `settings.list` 验证只读权限。其他客户端同样选择 Streamable HTTP，将令牌放进 `Authorization: Bearer …` 请求头。[Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)

| HTTP 状态 | 检查项 |
|---|---|
| `401` | 检查是否注入了目标环境的令牌。过期、吊销、管理员降级或封禁均返回此状态。 |
| `403` | 浏览器发送的 `Origin` 须与部署的 `APP_URL` 同源。CLI 可以省略此头。 |
| `404` | 检查当前地址及该部署是否启用插件。 |
| `405` | 使用 HTTP 传输。端点只接受 POST。 |
| `413` | 请求体上限为 256 KiB。 |
| `429` | 每令牌默认每分钟 120 次请求。等限流窗口重置后再试。 |

## 工具与权限

调用前用 `tools/list` 获取当前部署的输入 schema 和各参数的说明。下表中的 `?` 表示可选参数。分页工具支持 `offset` 和 `limit`，默认从 0 开始取 50 条，每页最多 50 条。日期筛选使用 UTC `YYYY-MM-DD`，包含两端。工具调用被拒时查看 MCP 结果中的错误码，例如 `INSUFFICIENT_SCOPE`。

| 工具 | Scope | 参数与用途 |
|---|---|---|
| `ping` | `admin:read` | `{}`。验证工具调用，返回 `pong`。 |
| `settings.list` | `admin:read` | `{}`。列出登记的运行时设置及其值，密钥项显示设置状态。 |
| `settings.get` | `admin:read` | `{ key }`。读取设置值与定义，功能模型项在 `resolution` 中返回解析结果。密钥项用 `isSet` 表示是否已设置。`source` 为 `database`、`default` 或 `fallback`；`fallback` 表示已存值不符合当前定义，正在使用默认值。 |
| `features.models` | `admin:read` | `{}`。列出功能模型的种类、沿用顺序和解析结果。 |
| `models.list` | `admin:read` | `{ offset?, limit?, kind?, order? }`。查询后台模型目录及启用状态、参数和定价。排序可用 `sort`、`sort_desc`、`key`、`key_desc`。需启用计费。 |
| `users.search` | `admin:read` | `{ offset?, limit?, q? }`。按邮箱、姓名或 ID 搜索用户。 |
| `users.get` | `admin:read` | `{ id }`。读取单个用户及其空间、登录方式。 |
| `workspaces.list` | `admin:read` | `{ offset?, limit?, q?, status? }`。按名称、slug、ID 或状态（`active`、`deleted`）筛选空间。 |
| `orders.list` | `admin:read` | `{ offset?, limit?, workspaceId? }`。查询后台的一次性购买订单，需启用计费。 |
| `credits.ledger` | `admin:read` | `{ offset?, limit?, workspaceId }`。读取指定空间的积分流水，需启用积分。 |
| `audit.list` | `admin:read` | `{ offset?, limit?, actor?, workspaceId?, action?, from?, to? }`。查询审计日志。只对 `log.meta` 脱敏，项目在行上附加的字段（如多站点的 `site`）原样返回。 |
| `metrics.summary` | `admin:read` | `{ from?, to? }`。读取后台业务指标汇总，默认最近七个完整 UTC 日。 |
| `confirmations.get` | `admin:read` | `{ id }`。查询需要管理员确认的操作的状态（`pending`、`done`、`failed`、`rejected`、`expired`）、摘要与结果。只能查询同一管理员的令牌发起的记录，不返回执行参数与密钥。 |
| `settings.set` | `admin:write` | `{ key, value, dryRun? }`。校验并保存登记的设置，返回新旧值。密钥值在结果中脱敏。**改动密钥类设置时返回 `needs_owner_confirm`，经管理员确认后才写入。** |
| `models.update` | `admin:write` | `{ key, enabled?, paramsSchema?, pricing?, dryRun? }`。修改已有模型，至少提供一个可修改字段。参数 schema 和定价分别传入完整 JSON 对象，结果包含各字段的新旧值。**定价改变时返回 `needs_owner_confirm`，经管理员确认后才写入**；只改启停或参数直接写入。需启用计费。 |
| `credits.adjust` | `admin:write` | `{ workspace, kind, amount?, expiresAt?, grantId?, reason, dryRun? }`。为空间增加积分（`kind: "grant"`，需 `amount`，`expiresAt` 为可选 ISO 时间）或收回一个有效批次的剩余积分（`kind: "revoke"`，需 `grantId`）。`workspace` 为空间 ID 或 slug。始终经管理员确认后执行。需启用积分。 |
| `refunds.review` | `admin:write` | `{ requestId, decision, approvedAmount?, reviewNote?, dryRun? }`。审核待处理的退款申请：`approve`（`approvedAmount` 缺省为剩余可退金额，最小货币单位）或 `reject`（需 `reviewNote`，会通知用户）。通过与驳回都经管理员确认后执行。需启用计费。 |

写工具的能力限于表中的设置、模型、积分调整与退款审核。用户、空间、订单、积分流水、审计和指标工具提供只读访问。不提供封禁或删除用户、模拟登录、创建管理员令牌，以及退款审核以外的支付平台写操作。

### 预览、写入与读回

1. 先通过 `settings.get` 或 `models.list` 读取现值并核对目标环境。[设置定义与项目扩展](02-project-structure.md#运行时设置定义) · [模型参数和定价](06-ai.md#2-模型注册表)
2. 调用写工具并显式传入 `dryRun: true`。例如用 `settings.set` 预览 `{"key":"ai.model.article-summary","value":"model-key","dryRun":true}`，将键和值换成已登记功能和当前环境中的模型键。预览执行校验，返回新旧值并写审计，业务数据与缓存不变。
3. 核对预览符合预期后，用相同参数和 `dryRun: false` 写入。保存后刷新相关缓存，再用对应的读工具确认结果。遇到 `CACHE_INVALIDATION_FAILED` 时，业务写入已提交。调用中断或缓存刷新失败时，先读回再决定后续操作。

## 需要管理员确认的操作

令牌只能证明调用者持有凭据，不能证明「此刻是管理员本人同意」。因此下列写入不会在 MCP 调用时执行，而是由令牌所属管理员在后台重新验证身份后确认（openspec `add-admin-step-up`）：

- `settings.set` 写入密钥类设置（`settings.list` 中 `secret: true` 的项，值与现值相同时不算改动）；
- `models.update` 改变定价；
- `credits.adjust` 与 `refunds.review` 的全部正式调用。

`dryRun: true` 照常只预览，不创建确认记录。只读令牌调用这些工具仍返回 `INSUFFICIENT_SCOPE`。

### 返回格式

正式调用返回普通结果（不是错误）：

```json
{
  "status": "needs_owner_confirm",
  "confirmationId": "0193…",
  "confirmUrl": "https://app.example.com/admin/confirm/0193…",
  "expiresAt": "2026-11-25T08:30:00.000Z",
  "summary": "Grant 100 credits to workspace Acme (0193…). Reason: …",
  "message": "This action requires an administrator to confirm it in the admin console before it runs. …"
}
```

- 记录 30 分钟内有效。创建时已把 AI 传入的标识（空间 slug、模型键等）解析为内部 ID，并保存目标现值快照；确认时只执行保存的内容，不再解析原始输入。
- 每个令牌同时最多 20 条待确认记录，超出返回 `CONFIRMATION_LIMIT_REACHED`。
- 密钥参数加密保存，确认页只显示是否设置与末 4 位；记录执行、失败、被拒绝或过期后即无法再解出。
- 工具参数中不存在任何「已确认」字段，附加 `confirmed` 等未声明的参数返回 `INVALID_TOOL_ARGUMENTS`。

### 给 agent 的处理建议

1. 收到 `needs_owner_confirm` 时，把 `summary` 与 `confirmUrl` 原样交给令牌所属管理员，说明需要其在后台确认；**在确认前不要把操作视为已完成**，也不要重复调用（每次调用都会新建一条记录）。
2. 管理员处理后，用 `confirmations.get` 查询：
   - `done`：已执行，`result` 给出执行结果（如 `adjustmentId`、退款申请 ID 与状态、设置或模型的新旧值）。退款通过后的支付平台处理沿用现有退款流程，最终状态以后台退款页为准。
   - `failed`：未执行，`result.code` 说明原因：`TOKEN_REVOKED`（发起令牌已吊销、过期或所属管理员已失效）、`STALE_TARGET`（确认前目标已被他人修改）、`SECRET_UNAVAILABLE`（密钥参数已不可解）或业务校验错误码。按需读取现值后重新发起。
   - `rejected`：管理员拒绝，不要自动重试。
   - `expired`：30 分钟内无人处理，如仍需要则重新发起。
   - `pending`：仍在等待，不要轮询过频。

### 后台确认

确认链接 `confirmUrl` 打开后台确认页 `/admin/confirm/<id>`：展示操作内容（目标、当前值与执行后）、发起令牌名称与前缀、发起时间与剩余有效期。
后台「运营」分组的「待确认」(`/admin/confirmations`) 按待确认 / 历史两栏列出全部记录，导航项上显示待确认数量。
只有发起令牌所属的管理员能确认执行，且确认前需要完成后台重新验证（step-up）；其他管理员可以查看与拒绝。确认与拒绝都用带条件的状态更新，并发点击只会生效一次；确认时在同一事务内重新检查发起令牌与目标快照。纯数据库操作（积分、设置、模型）与确认在同一事务提交；退款审核在退款决策事务内完成确认，提交后再调用支付平台。

过期在读取时惰性处理，残留记录由现有的每日清理（UTC 03:00）置为过期，并删除 30 天前结束的记录，不新增定时任务。

### 查看审计

在后台「审计日志」(`/admin/audit`) 按操作人和动作筛选。读工具、预览及被拒的工具调用使用 `admin.mcp.call`。设置写入使用 `setting.updated`，模型写入使用 `ai.model_updated`、`ai.model_enabled` 或 `ai.model_disabled`。展开「查看详情」核对令牌所属管理员、`via: "mcp"`、`tokenId`、工具名、脱敏参数摘要及结果。写入记录还包含与后台一致的变更前后值，模型参数 schema 以哈希摘要记录。

需要确认的操作另有：

- `admin.confirmation.requested`：MCP 调用创建待确认记录时写入，操作人为令牌所属管理员，`targetId` 为确认记录 ID，meta 含调用信息与摘要。
- `admin.confirmation.confirmed` / `admin.confirmation.failed` / `admin.confirmation.rejected`：确认执行、执行失败与拒绝，操作人为处理的管理员。
- 业务审计（如 `credits.adjust`、`setting.updated`、`ai.model_updated`、`billing.refund_rejected`）的 meta 合并 `via: "mcp"`、`tokenId`、`tool`、`confirmationId`、`confirmedBy` 与 `stepUpMethod`（确认人当时的重新验证方式）。按确认记录 ID 搜索 `targetId` 或 meta 即可串起发起、确认与执行。
