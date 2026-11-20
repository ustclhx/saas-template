# seo Specification

## Purpose

让公开页面能被搜索引擎正确抓取与索引、在社交平台上有正确的分享预览，同时避免应用区与后台被索引。
统一页面元数据、多语言关联、站点地图、结构化数据与默认分享图，使公开内容的搜索发现与分享展示保持一致。

## Requirements

### Requirement: 页面元数据
每个公开页面 SHALL 具有唯一的标题与描述、规范链接（canonical）以及社交分享所需的 Open Graph 与 Twitter 卡片信息。

#### Scenario: 分享博客文章
- **WHEN** 有人在社交平台分享一篇博客文章链接
- **THEN** 预览显示该文章的标题、摘要与封面图

### Requirement: 多语言关联
存在多语言版本的公开页面 SHALL 输出完整的 hreflang 组：自身、该页真实存在的其他语言版本，以及恰好一条 x-default。
- hreflang 必须满足：
  - 使用绝对地址，各版本 MUST 双向互指，且 MUST NOT 跨域名。
  - x-default 指向默认语言版本；该页没有默认语言版本时，指向它存在的第一个语言版本。
  - 各语言版本的路径可以不同（如使用当地关键词的 slug），对应关系由页面声明的语言版本地址表达。
- 公开页面的 canonical MUST 指向自身地址。
- 缺少译文的页面默认不发布：该语言地址返回 404，不进入站点地图、hreflang 与站内链接。
- 项目开启「回退显示」后，缺少译文的页面以原语言内容显示：其 canonical MUST 指向同一站点内的原语言页，且 MUST NOT 出现在 hreflang 与站点地图中。

#### Scenario: 定价页的语言版本
- **WHEN** 搜索引擎抓取英文定价页
- **THEN** 页面 canonical 指向自身，并声明了英文、中文版本地址与一条 x-default

#### Scenario: 缺少中文译文的文章
- **WHEN** 一篇文章只有英文版本，访客打开 `/zh/blog/<slug>`
- **THEN** 返回 404；英文文章的 hreflang 不包含 `zh`；站点地图不包含 `/zh/blog/<slug>`；中文页面不链接到该地址

#### Scenario: 开启回退显示
- **WHEN** 项目开启回退显示，一篇文章只有英文版本，访客打开 `/zh/blog/<slug>`
- **THEN** 页面显示英文内容，canonical 指向 `/blog/<slug>`，hreflang 不包含 `zh`，站点地图不包含 `/zh/blog/<slug>`

#### Scenario: 本地化 slug
- **WHEN** 某项目页面的英文地址为 `/four-pillars`，韩语地址为 `/ko/만세력`，并声明了两者互为语言版本
- **THEN** 两页的 hreflang 都同时列出这两个地址

### Requirement: 站点地图与抓取规则
站点 SHALL 自动生成站点地图，其中的地址集合 MUST 等于可索引公开页面的集合（含各语言版本）：不含 404、noindex、回退页和带查询参数的地址。站点 SHALL 提供 robots 规则；应用区（`/app`）、后台（`/admin`）与接口路径 MUST 被禁止抓取，且这些页面 SHALL 带 noindex。

#### Scenario: 站点地图内容
- **WHEN** 搜索引擎读取站点地图
- **THEN** 其中包含首页、定价、已发布博客文章与法律页的各语言地址，不包含 `/app`、`/admin` 与未翻译页面的地址

### Requirement: 结构化数据
首页 SHALL 提供组织与网站的结构化数据，博客文章 SHALL 提供文章结构化数据，定价页 SHALL 提供产品与价格的结构化数据。

#### Scenario: 博客文章结构化数据
- **WHEN** 搜索引擎抓取一篇博客文章
- **THEN** 页面中包含作者、发布日期与标题的文章结构化数据

### Requirement: 动态分享图
没有指定封面的公开页面 SHALL 自动生成包含站点名称与页面标题的分享图片。

#### Scenario: 法律页分享
- **WHEN** 分享没有封面图的服务条款页面
- **THEN** 预览图显示站点名称与「服务条款」标题

### Requirement: llms.txt
启用营销站时站点 SHALL 提供 `/llms.txt`，列出站点名称与公开、已发布页面，地址 MUST 属于当前环境 APP_URL。

#### Scenario: 读取 llms.txt
- **WHEN** 请求 `/llms.txt`
- **THEN** 返回 200 的纯文本，其中的链接都指向本站

#### Scenario: 不含私有路径
- **WHEN** 读取 `/llms.txt`
- **THEN** 不包含 `/app`、`/admin` 与 `/api`

### Requirement: IndexNow 提交
配置 IndexNow 密钥后，站点 SHALL 在 `/indexnow.txt` 公开该密钥，生产发布后 SHALL 提交站点地图中的本站地址；提交失败 MUST NOT 使发布失败。未配置时 `/indexnow.txt` MUST 返回 404，MUST NOT 提交。密钥 MUST NOT 写入仓库。

#### Scenario: 未配置密钥
- **WHEN** 没有配置 `INDEXNOW_KEY`
- **THEN** `/indexnow.txt` 返回 404，发布步骤跳过提交

#### Scenario: 提交失败
- **WHEN** IndexNow 服务返回错误
- **THEN** 记录警告，发布继续
