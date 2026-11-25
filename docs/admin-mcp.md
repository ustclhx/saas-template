# 管理员 MCP

`admin-mcp` 插件提供 `/api/admin/mcp`。平台管理员用个人令牌读取后台数据，或修改运行时设置和已有 AI 模型。端点使用无会话的 Streamable HTTP，以 POST 接收 MCP 请求并返回 JSON。[启停与部署](plugins.md#内置插件)

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

调用前用 `tools/list` 获取当前部署的输入 schema。下表中的 `?` 表示可选参数。分页工具支持 `offset` 和 `limit`，默认从 0 开始取 50 条，每页最多 50 条。日期筛选使用 UTC `YYYY-MM-DD`，包含两端。工具调用被拒时查看 MCP 结果中的错误码，例如 `INSUFFICIENT_SCOPE`。

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
| `audit.list` | `admin:read` | `{ offset?, limit?, actor?, workspaceId?, action?, from?, to? }`。查询审计日志。 |
| `metrics.summary` | `admin:read` | `{ from?, to? }`。读取后台业务指标汇总，默认最近七个完整 UTC 日。 |
| `settings.set` | `admin:write` | `{ key, value, dryRun? }`。校验并保存登记的设置，返回新旧值。密钥值在结果中脱敏。 |
| `models.update` | `admin:write` | `{ key, enabled?, paramsSchema?, pricing?, dryRun? }`。修改已有模型，至少提供一个可修改字段。参数 schema 和定价分别传入完整 JSON 对象，结果包含各字段的新旧值。需启用计费。 |

写工具的能力限于表中的设置与模型更新。用户、空间、订单、积分、审计和指标工具提供只读访问。

### 预览、写入与读回

1. 先通过 `settings.get` 或 `models.list` 读取现值并核对目标环境。[设置定义与项目扩展](02-project-structure.md#运行时设置定义) · [模型参数和定价](06-ai.md#2-模型注册表)
2. 调用写工具并显式传入 `dryRun: true`。例如用 `settings.set` 预览 `{"key":"ai.model.article-summary","value":"model-key","dryRun":true}`，将键和值换成已登记功能和当前环境中的模型键。预览执行校验，返回新旧值并写审计，业务数据与缓存不变。
3. 核对预览符合预期后，用相同参数和 `dryRun: false` 写入。保存后刷新相关缓存，再用对应的读工具确认结果。遇到 `CACHE_INVALIDATION_FAILED` 时，业务写入已提交。调用中断或缓存刷新失败时，先读回再决定后续操作。

### 查看审计

在后台「审计日志」(`/admin/audit`) 按操作人和动作筛选。读工具、预览及被拒的工具调用使用 `admin.mcp.call`。设置写入使用 `setting.updated`，模型写入使用 `ai.model_updated`、`ai.model_enabled` 或 `ai.model_disabled`。展开「查看详情」核对令牌所属管理员、`via: "mcp"`、`tokenId`、工具名、脱敏参数摘要及结果。写入记录还包含与后台一致的变更前后值，模型参数 schema 以哈希摘要记录。
