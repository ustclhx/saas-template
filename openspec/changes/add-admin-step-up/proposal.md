## Why

后台写操作目前只要求「当前会话属于未封禁的平台管理员」：会话 Cookie 一旦被盗用（共享电脑、恶意扩展、XSS 之外的会话泄露），持有者就能直接退款、调整积分、封禁用户、模拟登录、创建管理员 API 令牌或改写运营通知令牌等密钥设置。Better Auth 1.7.7 没有内置的「敏感操作重新验证」（step-up），其 `freshAge` 只衡量「距登录多久」，不覆盖后台自定义的 Server Function。

同时，add-admin-mcp 有意不给 AI 退款、积分调整等工具，因为令牌本身无法证明「此刻是管理员本人同意」。运营上希望 AI 能发起这类操作，由管理员在后台确认后执行，并且确认环节同样受 step-up 保护。使用者于 2026-11-25 同意规划，排在 add-ops-safeguards 之后实施。

## What Changes

- **敏感后台操作清单**：一处登记全部后台写操作的动作名与是否敏感（可按输入条件判定，如只有改动密钥类设置或模型定价时才算敏感）；`adminAction` / `withAdminAction` / 代理型后台操作 / Better Auth 原生管理员入口都按动作名查表，未登记的动作名在类型检查阶段即报错。守卫测试逐项确认清单中敏感入口在未验证时一律拒绝，日常入口不受影响。
- **重新验证（step-up）**：敏感操作要求当前会话在最近 10 分钟内完成过一次重新验证。验证方式按账号已有手段取最强者：已开启两步验证的用 TOTP（或备用码）；否则用发到已验证邮箱的一次性验证码，有密码的账号也可输入密码。验证状态存服务端、绑定当前会话，记录方式与时间并写审计。Passkey 留作扩展点（模板尚未启用 passkey 插件）。
- **体验**：敏感操作被拒时返回 `STEP_UP_REQUIRED`，后台统一的调用包装当场弹出验证，通过后用原参数自动重试，已填写的表单不丢失。
- **应急**：管理员丢失两步验证设备与备用码时，运维可在部署环境开启救援开关，`BOOTSTRAP_ADMIN_EMAILS` 名单内的管理员可改用邮箱验证码完成验证（方式记为 `rescue`，后台持续显示警示条、写审计并发运营通知）；邮箱也不可用时，按现有引导把新的已验证邮箱加入名单提升为管理员。不会把人锁在外面。
- **AI 发起、管理员确认**：admin-mcp 的敏感工具调用不再直接执行，而是存一条待确认记录（30 分钟有效）并返回 `needs_owner_confirm` 与后台确认链接 `/admin/confirm/$id`。记录保存解析后的目标 ID 与将执行的内容；管理员在确认页 step-up 后执行，或拒绝。用带条件的更新保证只执行一次；执行前重新检查发起令牌是否已吊销、过期或所属管理员已失效；密钥类参数加密保存，终态或到期即不可恢复；只有确认执行路径能给工具处理函数传入「已确认」标志。新增只读工具查询确认结果。
- **BREAKING（admin-mcp 行为）**：`settings.set` 写密钥类设置、`models.update` 修改定价，改为返回 `needs_owner_confirm`，由管理员确认后执行；`dryRun` 与非敏感写入不变。
- **第一批接入的 MCP 敏感工具（待拍板，推荐）**：`credits.adjust`（空间积分增加 / 收回批次）与 `refunds.review`（审核已有退款申请：全额 / 部分通过或驳回），加上上述两个改走确认的写工具。封禁、模拟登录、创建令牌不开放给 MCP。
- **新页面与交互**（需使用者确认设计稿后实现）：验证弹窗、确认页 `/admin/confirm/$id`、待确认列表 `/admin/confirmations` 与导航计数、后台顶部的验证状态与救援警示条。

不在本次范围：引入 passkey 插件、强制管理员开启两步验证、用户侧（非后台）敏感操作的 step-up、MCP 以外的 AI 发起渠道、令牌按 IP 限定。

## Capabilities

### New Capabilities

- `admin-step-up`: 敏感后台操作清单、重新验证方式与优先级、验证状态的有效期与绑定、被拒时的当场验证与自动继续、应急救援。
- `admin-confirmations`: AI（MCP）发起敏感操作的待确认记录、确认 / 拒绝 / 过期的状态流转、只执行一次、令牌复核、密钥参数的生命周期、结果查询与审计。

### Modified Capabilities

- `admin-mcp`: 工具清单新增经确认执行的敏感工具与只读的确认结果查询；`settings.set` 的密钥类设置与 `models.update` 的定价改动改为经管理员确认后执行。

## Impact

- `apps/web/src/features/admin`：`action.ts` / `action.server.ts` 增加动作名登记表与 step-up 检查，`runDelegatedAdminAction` 改为必须带动作名；`impersonation.server.ts` 的原生管理员入口接入同一检查；新增 step-up 服务端函数与客户端调用包装、验证弹窗、确认页与待确认列表。
- `packages/auth`：会话内的重新验证（密码校验、TOTP / 备用码、step-up 专用邮箱验证码），全部不创建新会话；救援开关读取环境变量。
- `packages/db`：新表 `admin_step_up`（按会话）与 `admin_pending_action`（待确认记录），迁移由协调者统一生成。
- `plugins/admin-mcp`：工具框架增加 `confirm` 钩子与确认执行入口，新增 `credits.adjust`、`refunds.review`、`confirmations.get`。
- `packages/email`：step-up 验证码邮件模板。
- 文档：`docs/04-auth-and-tenancy.md`、`docs/admin-mcp.md`、首次运行与应急 runbook；`security-scan` 清单。
- 无新的定时任务：过期记录在读取时惰性处理，清理并入现有每日清理（Neon 缩容到零不受影响）。
