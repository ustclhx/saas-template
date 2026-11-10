# 每日登录赠送积分升级草稿

发布版本由协调者确定，发布时整理到 docs/upgrades 对应版本说明。

## 数据库

先部署扩展 schema，再部署应用。本分支只对隔离 worktree 库执行 drizzle-kit push，正式迁移由协调者统一生成和审阅。

- credit_grant.source TypeScript 文本来源联合增加 daily，现有数据库使用 text 列。
- 新增 credit_daily_claim，保存领取用户标识、规范化邮箱 SHA-256、UTC 日期及对应 grant。用户/日期和邮箱散列/日期分别唯一，支持邮箱月区间查询。
- metrics_daily 增加 daily_grant_count（integer）、daily_grant_credits（bigint），历史默认值为 0。
- 领取记录随财务记录保留，用于阻止删号重注册重复领取，记录中不保存邮箱正文。

## 开启与参数

在 template.config.ts 设置 credits.dailyEnabled=true，同时保持 credits.enabled=true。默认关闭，每日领取由真实用户访问 App 时触发。

后台运行时设置管理以下参数。

| 键 | 默认值 | 范围 |
| --- | --- | --- |
| credits.dailyAmount | 10 | 1–2147483647 整数 |
| credits.dailyMaxDaysPerMonth | 10 | 1–31 整数 |
| credits.dailyExpiryDays | 7 | 1–365 整数 |
| credits.dailyRequireVerifiedEmail | true | 布尔值 |

所有日期按 UTC。配置修改后，已缓存的领取检查最多延迟 5 分钟应用。验证完成会切换缓存键以便立即重试。一次性邮箱黑名单沿用 billing.signupBonusDomainBlacklist。

## 账务与界面接入

赠送只进入个人空间，paymentId=null，按现有到期优先规则消费。付款退款回收仍仅关联付款批次。已有注册赠送保持当前领取和验证规则。

App 布局最小提示消费 granted/unverified 数据，接口及未来 DailyGrantNotice props 见本 change 的 design.md。add-ui-design-system 8.6 接管提示视觉，8.7 可使用 daily 批次展示免费积分分区。用量页通过 daily 来源辨识领取流水。

既有运营指标汇总记录实际赠送次数与积分总量，沿用原调度。无真实用户访问时不会因每日领取唤醒数据库。

## 发布验收与回滚

协调者生成迁移后，在全新数据库运行迁移与 CI，随后验收实际 App 领取、邮箱验证返回、后台参数修改和指标展示。发布模板版本后向衍生项目协调会话提供版本及正式升级说明。

回滚时关闭 dailyEnabled 并回退应用代码，保留扩展 schema、领取记录及已经发放的账本。
