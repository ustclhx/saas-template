# Spec Delta

## MODIFIED Requirements

### Requirement: 无可见输出的失败不向用户收费
回复最终没有任何可见正文（仅 reasoning、reasoning 阶段中断、输出前报错）时，系统 SHALL 标记 failed。同一工作区在滚动时间窗口（默认 1 小时）内的前 N 次（默认 3 次）此类失败 SHALL 全额释放预扣，上游成本由 SaaS 承担；超过 N 次后的此类失败 SHALL 按最后一次上游尝试的实际用量（含输入、输出与 reasoning）结算，按 token 计费不低于 `minCharge`，按次计费收取固定积分，均不超过预扣。N 与窗口为运行时设置。已有可见正文后最终失败时，token 计费按已产生用量、按次计费收取固定积分，均不超过预扣。失败全退开关开启时，所有 failed 回复 SHALL 全额释放预扣。用户主动停止的计费不变。

#### Scenario: 仅 reasoning 最终失败
- **WHEN** 按次计费的回复在全部重试后仍只有 reasoning，且该工作区过去 1 小时内此类失败不足 3 次
- **THEN** 回复 failed，预扣全额退回

#### Scenario: 超过免费失败次数
- **WHEN** 某工作区 1 小时内已有 3 次无可见正文的免费失败，第 4 次按 token 计费的回复因 reasoning 耗尽输出上限而失败
- **THEN** 回复 failed，按最后一次尝试的实际用量结算（不低于 `minCharge`、不超过预扣），并退回余量

#### Scenario: 窗口滚动后恢复免费
- **WHEN** 距该工作区最早一次免费失败已超过 1 小时
- **THEN** 下一次无可见正文的失败重新全额退回

#### Scenario: 有正文后失败
- **WHEN** 按 token 计费的回复生成 200 个正文 token 后续写最终失败，失败全退开关关闭
- **THEN** 回复 failed，按已产生用量结算并退回余量

#### Scenario: 开启失败全退
- **WHEN** 失败全退开关开启，回复在产生正文后最终失败
- **THEN** 回复 failed，预扣全额退回
