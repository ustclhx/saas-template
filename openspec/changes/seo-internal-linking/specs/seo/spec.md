## MODIFIED Requirements

### Requirement: 多语言关联
存在多语言版本的公开页面 SHALL 声明各语言版本之间的 hreflang 关联，并包含 x-default；hreflang MUST 只列出真实存在译文的语言版本。缺少译文、以默认语言内容回退显示的页面，其 canonical MUST 指向原语言页，且 MUST NOT 出现在站点地图中。

#### Scenario: 定价页的语言版本
- **WHEN** 搜索引擎抓取英文定价页
- **THEN** 页面声明了中文版本地址与 x-default

#### Scenario: 缺少中文译文的文章
- **WHEN** 一篇文章只有英文版本，访客打开 `/zh/blog/<slug>`
- **THEN** 页面显示英文内容，canonical 指向 `/blog/<slug>`，hreflang 不包含 `zh`，站点地图不包含 `/zh/blog/<slug>`
