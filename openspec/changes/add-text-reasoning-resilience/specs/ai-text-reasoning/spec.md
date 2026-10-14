# Spec Delta

## Purpose

定义文本模型 thinking 与 reasoning 的配置、展示和用量口径，以及以可见输出为准的失败判定、自动重试、续写与计费规则，使模板可兼容不同外部模型。

## ADDED Requirements

### Requirement: thinking 与 reasoning 配置
系统 SHALL 提供模板配置项：thinking 默认开启或关闭、是否允许用户逐条切换 thinking、是否展示 reasoning 过程。模型 SHALL 声明是否支持 thinking；不支持的模型忽略 thinking 设置。用户请求携带的 thinking 开关只在允许用户切换时生效，否则 MUST 被拒绝或忽略并按配置执行。

#### Scenario: 不暴露开关时按配置执行
- **WHEN** 模板关闭用户切换且默认关闭 thinking，用户对支持 thinking 的模型发起对话
- **THEN** 系统以关闭 thinking 调用模型，请求中的 thinking 参数不改变该行为

#### Scenario: 用户逐条开启 thinking
- **WHEN** 模板允许用户切换，用户对支持 thinking 的模型开启 thinking 发送消息
- **THEN** 该条回复以开启 thinking 调用模型

### Requirement: reasoning 展示与隔离
展示 reasoning 开启时，系统 SHALL 单独保存 reasoning 并在界面折叠显示；关闭时 MUST NOT 保存或下发 reasoning。reasoning MUST NOT 进入后续对话上下文，API key 接口 MUST NOT 返回 reasoning。

#### Scenario: 关闭展示
- **WHEN** 展示 reasoning 关闭，模型返回 reasoning 与正文
- **THEN** 用户只看到正文，消息中不保存 reasoning

#### Scenario: 后续上下文
- **WHEN** 上一条回复包含已保存的 reasoning，用户继续对话
- **THEN** 发送给模型的历史只包含正文

### Requirement: 可见输出前的自动重试
在可见正文出现前，服务商瞬时错误（限流、5xx、网络或超时）、空回复以及只有 reasoning 的回复 SHALL 在同一预扣下自动重试，次数有限；用户只为最终一次回复付费。展示 reasoning 时，重试 SHALL 清除已显示的 reasoning 并提示正在重试。

#### Scenario: 首次仅 reasoning 后重试成功
- **WHEN** 第一次调用用尽输出上限仍只有 reasoning，第二次调用产生正文并完成
- **THEN** 回复标记 completed，只按一次回复结算，预扣不重复

### Requirement: 可见输出后的续写
可见正文出现后流中断时，对支持续写的模型，系统 SHALL 以原上下文加已生成正文续写，结果作为同一条回复保存与结算，次数有限；不支持续写或续写最终失败时按失败计费规则结算。

#### Scenario: 中断后续写完成
- **WHEN** 支持续写的模型在生成部分正文后连接中断，续写调用完成
- **THEN** 用户看到同一条回复连续追加，消息 completed，只结算一次

### Requirement: 无可见输出的失败不向用户收费
回复最终没有任何可见正文（仅 reasoning、reasoning 阶段中断、输出前报错）时，系统 SHALL 标记 failed 并全额释放预扣，无论 token 或按次计费；上游成本由 SaaS 承担。已有可见正文后最终失败时，token 计费按已产生用量、按次计费收取固定积分，均不超过预扣。失败全退开关开启时，所有 failed 回复 SHALL 全额释放预扣。用户主动停止的计费不变。

#### Scenario: 仅 reasoning 最终失败
- **WHEN** 按次计费的回复在全部重试后仍只有 reasoning
- **THEN** 回复 failed，预扣全额退回

#### Scenario: 有正文后失败
- **WHEN** 按 token 计费的回复生成 200 个正文 token 后续写最终失败，失败全退开关关闭
- **THEN** 回复 failed，按已产生用量结算并退回余量

#### Scenario: 开启失败全退
- **WHEN** 失败全退开关开启，回复在产生正文后最终失败
- **THEN** 回复 failed，预扣全额退回

### Requirement: reasoning 用量统计
系统 SHALL 在用量、检查点与对账中单独记录 reasoning token，并计入输出用量；reasoning 阶段中断的检查点 SHALL 反映已产生的 reasoning 用量。

#### Scenario: 正常完成记录 reasoning
- **WHEN** 开启 thinking 的回复完成，服务商返回 reasoning token
- **THEN** 消息用量记录 reasoningTokens，输出用量包含 reasoning

### Requirement: failed 回复的正文进入后续上下文
failed 回复中已保存的可见正文 SHALL 进入同一对话后续请求的历史。

#### Scenario: 失败后继续对话
- **WHEN** 上一条回复生成部分正文后 failed，用户发送下一条消息
- **THEN** 发送给模型的历史包含该部分正文
