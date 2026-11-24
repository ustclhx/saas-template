# Spec Delta

## ADDED Requirements

### Requirement: 清理 agent 对话
删号与删空间的 AI 内容清理 SHALL 同时清除被清理 agent 对话的实例内消息数据与轮次记录；清理 MUST 幂等，实例清理失败时可重试且不阻塞其他数据的清理，最终不残留可访问的对话内容。

#### Scenario: 删除团队空间中的 agent 对话
- **WHEN** 团队空间保留期结束，空间中有 agent 对话
- **THEN** 对话实例数据、轮次记录与对话行全部被删除，其他空间不受影响

#### Scenario: 实例清理暂时失败
- **WHEN** 清理时某个实例调用失败
- **THEN** 该对话在下次清理时重试，其余对话照常删除
