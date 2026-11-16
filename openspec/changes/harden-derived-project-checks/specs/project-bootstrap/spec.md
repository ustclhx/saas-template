## ADDED Requirements

### Requirement: 衍生项目的端到端检查按项目配置运行
模板提供的端到端用例与 Nightly 任务 SHALL 按项目的模板配置、运行时绑定与页面声明决定运行或跳过，MUST NOT 只在模板默认配置下成立；跳过时 SHALL 给出原因。
用例结果 MUST NOT 依赖执行顺序：共享状态（价格目录缓存、夹具套餐）SHALL 在全局准备阶段写入或在用例结束时还原。

#### Scenario: 项目关闭了某项功能
- **WHEN** 衍生项目关闭注册赠送积分、答案页或 Workers AI 媒体服务商
- **THEN** 对应用例跳过并在报告中写明原因，其余用例照常运行

#### Scenario: 项目没有浮动控件
- **WHEN** 页面未声明浮动语言与主题控件
- **THEN** 浮动控件用例跳过

#### Scenario: 用例顺序变化
- **WHEN** 首个访问定价页的用例先于其他用例运行
- **THEN** 定价页读到完整的价格目录，后续用例不受影响

#### Scenario: 多租户关闭的衍生项目跑 Nightly
- **WHEN** 衍生项目未开启 `multiTenant`
- **THEN** Nightly 的多空间任务跳过并说明原因；模板仓库中照常运行
