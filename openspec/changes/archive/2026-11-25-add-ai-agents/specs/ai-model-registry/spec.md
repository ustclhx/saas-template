# Spec Delta

## ADDED Requirements

### Requirement: 工具调用能力标记
文本模型 SHALL 有「支持工具调用」标记，默认关闭，管理员可在后台模型编辑中修改；agent 只能使用带此标记且对空间可用的文本模型，修改在下一次请求生效。

#### Scenario: 关闭标记
- **WHEN** 管理员关闭某模型的工具调用标记
- **THEN** 该模型不再出现在 agent 的模型选择中，正在使用它的 agent 对话下一轮被拒绝并提示模型不可用
