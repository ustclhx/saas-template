# Design

## Context

见 proposal.md。grant 已在同一事务处理全局来源幂等、空间锁、账本和欠费偿还。grantSignupBonus 已从数据库校验身份、个人空间、邮箱验证与黑名单。getWorkspacePage 是 App 布局服务端入口，WebRuntime 提供目标中立 KV。metrics_daily 由现有汇总任务生成。

## Goals / Non-Goals

目标是让每次真实登录后的首次 App 访问领取免费积分，原子维护邮箱日/月额度，并保留已有账本与退款语义。交付范围限于最小业务界面接线。最终视觉由 add-ui-design-system 8.6 交付。

## Decisions

### 领取记录与事务

在 credits schema 增加 credit_daily_claim，保存 UUIDv7 id、userId、规范化邮箱 SHA-256、UTC day、grantId 和 createdAt。唯一约束分别覆盖 (userId, day) 与 (emailHash, day)，索引 (emailHash, day) 支持月区间计数。该表不关联用户删除级联，领取记录保留本月和上月，用于避免删号重注册重置额度，不保存邮箱正文；成功领取事务内按当前 emailHash 清除上月之前记录，未再次成功领取的邮箱不主动清理，账本不受影响。

packages/credits 提供 grantDailyCredits({ db, userId, enabled, now? })。enabled=false 在访问 db 前立即返回 disabled。事务先取 owner:userId 锁，与删号保持顺序，再读取并锁定真实用户、验证个人 owner 空间及 banned 状态，读取运行时设置，复用规范化与黑名单规则。然后取 daily-email:hash 的事务 advisory 锁，检查用户/邮箱当日领取，按 UTC 月区间对 emailHash 或 userId 的历史记录 count(distinct day)，避免改邮箱重置月额度和重复日期多计数；小于 D 时调用 grant、插入领取记录并清理当前邮箱上月之前记录。锁顺序为 owner → email → credits，所有写入同一事务提交。数据库唯一约束与来源键 userId:day 提供第二道幂等保障。

采用独立领取表避免依赖可过期/撤销的批次状态，邮箱锁保证不同账号、不同日期并发时月额度仍正确。grant 的 paymentId 固定 null，过期为发放时刻加有效天数，沿用既有先过期先消费及退款按 paymentId 回收的能力。

### 配置与复用

credits.dailyEnabled 默认 false，模板可显式启用。运行时键为 credits.dailyAmount=10、credits.dailyMaxDaysPerMonth=10、credits.dailyExpiryDays=7、credits.dailyRequireVerifiedEmail=true。数量为 1..2147483647，月天数为 1..31，有效天数为 1..365，后台表单及读取边界验证。credits.enabled=false 同样跳过领取。注册赠送黑名单解析提取为 shared 工具并由两条路径共用，注册赠送语义保持现状。

### 惰性触发与缓存

App 的 getWorkspacePage 在真实会话读取后调用独立服务端 daily 模块。模拟会话跳过。无论当前选中空间类型，都只向已校验的个人空间发放。KV 键包含用户、UTC 日期和邮箱验证状态，以便验证完成立即重试。granted/already_claimed/monthly_limit 缓存到次日 UTC 零点（TTL 下限 60 秒），unverified/blacklisted 缓存 300 秒，命中时返回 cached 且不触发新领取提示。UTC 日期在键中防止跨日缓存污染。仅成功领取的事务返回 granted，缓存不作为额度事实来源。KV 失败只记录结构化告警并继续数据库路径，AppError 业务拒绝返回 ineligible、缓存 300 秒并记录错误 code；未知异常不写检查缓存并允许后续真实访问重试，App 数据加载继续。

### DailyGrantNotice 数据接口

服务端结果采用可序列化联合类型，granted 包含 grantId、credits、daysThisMonth、maxDaysPerMonth、expiresAt（ISO 字符串）、day（UTC YYYY-MM-DD）。unverified 表示应展示验证入口，其他状态 disabled/already_claimed/monthly_limit/blacklisted/cached/ineligible 不触发新的成功提示。界面只用 granted 结果触发一次通知，以 grantId 在 sessionStorage 去重；后续 cached 等非 granted 结果保留已有通知，用户关闭时才清除。未验证入口链接 /account，复用已有发送验证邮件路径并补齐注册赠送关闭时的入口。将来的 DailyGrantNotice 纯展示 props 为 { credits, daysThisMonth, maxDaysPerMonth, expiresAt, onDismiss }，验证提示通过 { verificationHref } 接入，数据读取仍归 apps/web。

用量批次与流水展示 daily 来源，保持现有列表权限。中英文文案新增独立 daily-credits.json。

### 指标

复用现有 metrics 汇总，从 daily 来源 grant 账本按 UTC 日计算 dailyGrantCount 与 dailyGrantCredits，写入 metrics_daily 并在既有后台指标展示。总积分列使用 bigint，避免多笔合法 int4 积分发放的汇总溢出。仅已提交账本参与汇总，重试和缓存命中不重复统计，沿用现有调度，无额外 Cron。

## Risks / Trade-offs

- KV 最终一致可能导致重复检查，由数据库锁与唯一键保证额度正确。当日检查缓存使 monthly_limit 后调高 D 最多延迟到次日 UTC 生效；未验证、黑名单和业务拒绝最多缓存 5 分钟。
- 领取表保留防刷散列和内部标识，升级说明需写明数据保留用途。
- 正式迁移 0021 已由协调者提供，本轮审阅修复不改 schema 或迁移；本地曾执行 schema push 的库需避免重复建表，使用全新隔离库验证完整迁移。

## Migration Plan

初次实施将 schema push 到隔离 worktree 库；协调者已补充正式迁移 0021。PR 明示新增表、唯一约束、索引、来源类型与指标列，本轮审阅修复不改 schema 或迁移。升级草稿放 change 内，正式版本由协调者发布。先部署扩展 schema，再部署代码，已有衍生项目默认关闭。回滚代码并关闭开关，保留领取表和已发账本。
