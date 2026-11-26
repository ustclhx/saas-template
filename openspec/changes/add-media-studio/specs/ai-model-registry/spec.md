# Spec Delta

## ADDED Requirements

### Requirement: 模型显示名
模型 SHALL 可配置可选的显示名；面向终端用户的页面（创作页、作品页、画廊）SHALL 显示显示名，未配置时回退到模型 key。显示名 MUST NOT 影响模型 key、计费与权益判定。

#### Scenario: 配置显示名
- **WHEN** 管理员为模型 `fal-flux-schnell` 填写显示名「FLUX 快速」
- **THEN** 创作页模型选择与作品页显示「FLUX 快速」，任务记录仍使用原 key

#### Scenario: 未配置
- **WHEN** 模型没有显示名
- **THEN** 页面显示模型 key
