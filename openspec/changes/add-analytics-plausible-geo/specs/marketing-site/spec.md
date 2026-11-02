# Spec Delta

## ADDED Requirements

### Requirement: 定价页转化路径
定价页 SHALL 使用与其他营销页一致的页头和页脚。首页套餐 CTA MUST 指向 `/register`；定价页 CTA MUST 指向 `/app`，未登录访客 MUST 先进入登录页并在登录后回到工作区。

#### Scenario: 未登录点击定价页 CTA
- **WHEN** 未登录访客点击定价页的 “View in my workspace”
- **THEN** 进入登录页，登录后回到 `/app`

#### Scenario: 定价页导航
- **WHEN** 访客打开 `/pricing`
- **THEN** 页面有站点页头与页脚

### Requirement: 404 回导航
不存在的路径 SHALL 显示带返回导航的 404 页面，并返回 404 状态码。

#### Scenario: 打开不存在的地址
- **WHEN** 访客打开不存在的路径
- **THEN** 响应状态为 404，页面提供返回首页的链接

### Requirement: 法律页不展示模板占位邮箱
支持邮箱仍是模板占位值（`example.com` 域）时，法律页 MUST NOT 显示该地址，SHALL 显示明确的“尚未配置”提示。

#### Scenario: 未替换支持邮箱
- **WHEN** `app.supportEmail` 为 `support@example.com`
- **THEN** 法律页不含 `support@example.com`，显示尚未配置的提示
