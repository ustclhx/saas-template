# 每日登录赠送积分升级草稿

发布版本由协调者确定，发布时整理到 docs/upgrades 对应版本说明。

## 数据库

先部署扩展 schema，再部署应用。初次实施对隔离 worktree 库执行 drizzle-kit push，协调者已补充正式迁移 0021；本轮审阅修复不新增或改动 schema、迁移。

- credit_grant.source TypeScript 文本来源联合增加 daily，现有数据库使用 text 列。
- 新增 credit_daily_claim，保存领取用户标识、规范化邮箱 SHA-256、UTC 日期及对应 grant。用户/日期和邮箱散列/日期分别唯一，支持邮箱月区间查询。
- metrics_daily 增加 daily_grant_count（integer）、daily_grant_credits（bigint），历史默认值为 0。
- 领取记录用于按 UTC 日/月防刷、阻止删号重注册和改邮箱重置月额度，不保存邮箱正文。每次成功发放时，在同一事务中删除该 email_hash 上月之前的领取行，保留本月与上月；未再次成功领取的邮箱记录不会被定时清理。此清理只涉及领取表，财务批次与账本保持既有保留策略，无新增 Cron。

## 开启与参数

在 template.config.ts 设置 credits.dailyEnabled=true，同时保持 credits.enabled=true。默认关闭，每日领取由真实用户访问 App 时触发。

后台运行时设置管理以下参数。

| 键 | 默认值 | 范围 |
| --- | --- | --- |
| credits.dailyAmount | 10 | 1–2147483647 整数 |
| credits.dailyMaxDaysPerMonth | 10 | 1–31 整数 |
| credits.dailyExpiryDays | 7 | 1–365 整数 |
| credits.dailyRequireVerifiedEmail | true | 布尔值 |

所有日期按 UTC。granted、already_claimed、monthly_limit 的检查缓存至次日 UTC 零点（TTL 下限 60 秒）；unverified、blacklisted 和 AppError 业务拒绝缓存 300 秒，未知异常不缓存。已达 monthly_limit 时调高每月天数 D，最多延迟至次日 UTC 才能重新领取；其他已完成当日检查的用户也在次日重新应用参数，未验证或黑名单拒绝最多延迟 5 分钟重查。验证完成会切换缓存键以便立即重试。一次性邮箱黑名单沿用 billing.signupBonusDomainBlacklist。关闭邮箱验证要求时，未验证账号可能占用他人邮箱的日/月额度。

## 设置读取兼容性

dbSettingStore 对所有设置键改用原始 SQL 表达式读取 JSONB，直接保留 postgres.js 已解析的值，避免 ORM 二次解析 JSON 字符串。影响不限于每日积分键：字符串 `"true"`、`"10"`、`"null"` 等保持字符串，布尔、数字、对象、数组与 JSON null 保持原类型，缺失键仍回退默认值。现有合法配置及 KV 缓存策略不变；已有错误类型的配置不会再因二次解析被隐式转换，daily 键会在读取边界拒绝，其他键仍由既有调用方按其契约处理。升级前应检查并纠正手工写入的错误类型。

## 账务与界面接入

赠送只进入个人空间，paymentId=null，按现有到期优先规则消费。付款退款回收仍仅关联付款批次。已有注册赠送保持当前领取和验证规则。

App 布局最小提示消费 granted/unverified 数据，接口及未来 DailyGrantNotice props 见本 change 的 design.md。add-ui-design-system 8.6 接管提示视觉，8.7 可使用 daily 批次展示免费积分分区。用量页通过 daily 来源辨识领取流水。

既有运营指标汇总记录实际赠送次数与积分总量，沿用原调度。无真实用户访问时不会因每日领取唤醒数据库。

## 发布验收与回滚

领取提示回归使用现有 Playwright 在真实 Chromium 中执行 effect 与重渲染。首次本地运行 web 测试前执行 `pnpm --filter @saas/web exec playwright install chromium`；CI 的测试 job 已增加 Chromium 及系统依赖安装。

使用协调者提供的迁移 0021 在全新数据库运行完整迁移与 CI，随后验收实际 App 领取、邮箱验证返回、后台参数修改和指标展示。发布模板版本后向衍生项目协调会话提供版本及正式升级说明。

回滚时关闭 dailyEnabled 并回退应用代码，保留扩展 schema、领取记录及已经发放的账本。
