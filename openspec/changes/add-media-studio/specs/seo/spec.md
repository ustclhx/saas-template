# Spec Delta

## ADDED Requirements

### Requirement: 插件附加站点地图
已启用插件 SHALL 能声明附加站点地图地址；robots 规则 MUST 列出主站点地图与所有附加站点地图。主站点地图与附加站点地图的地址合集 MUST 等于可索引公开页面的集合，同一地址 MUST NOT 同时出现在两者中。插件未启用时其站点地图地址 MUST NOT 出现在 robots 中。

#### Scenario: 启用 studio
- **WHEN** 项目启用 studio 插件
- **THEN** robots 同时列出主站点地图与画廊站点地图，画廊站点地图只含审核通过的作品页

#### Scenario: 未启用
- **WHEN** 项目未启用任何声明站点地图的插件
- **THEN** robots 只列出主站点地图
