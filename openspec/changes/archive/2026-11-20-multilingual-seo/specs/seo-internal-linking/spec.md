## ADDED Requirements

### Requirement: 多语言检查
构建后的链接图检查 SHALL 对公开页面同时检查多语言规则；失败级规则的处理与链接图检查相同（`report` 只报告，`enforce` 以非零状态退出）。
- 失败：
  - 可索引页的 canonical 不指向自身；
  - hreflang 未双向互指、跨域名、指向不可访问或不可索引的地址，或 x-default 不是恰好一条；
  - `<html lang>` 与页面在 hreflang 组中声明的语言不一致；
  - 以不同 Accept-Language 请求同一公开地址时状态、`Location` 或正文语言不同；
  - 公开页响应带有语言相关的 `Set-Cookie`；
  - 站内链接使用 `?lang=` 一类语言查询参数；
  - 带默认语言前缀的地址未 301 到无前缀地址；
  - 服务端 HTML 中出现语言提示。

#### Scenario: hreflang 单向
- **WHEN** 英文页的 hreflang 列出了中文页，而中文页的 hreflang 没有列出英文页
- **THEN** 检查报告该页对的 hreflang 失败

#### Scenario: 按浏览器语言跳转
- **WHEN** 项目在 `/` 上按 Accept-Language 返回 302 到 `/zh`
- **THEN** 检查报告失败，`enforce` 模式下以非零状态退出

#### Scenario: 模板自身
- **WHEN** 模板仓库构建后运行检查
- **THEN** 多语言规则没有失败项
