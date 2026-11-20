# seo-internal-linking Specification

## Purpose

约束公开页面之间的站内链接：页面声明层级与主词，模板生成固定内链区块，构建后对实际渲染的链接图做检查，使批量生成的页面不会成为孤岛，内链结构可在 CI 中验收。

## Requirements

### Requirement: 页面层级与主词声明
每个可索引的公开页面 SHALL 声明 `url`、`titleMain`；除首页外 MUST 声明 `parent`，且 `parent` MUST 指向存在的可索引页面。`url` 全站（同一语言内）MUST 唯一。缺失或指向不存在的页面时构建 MUST 失败。

#### Scenario: 程序化页面缺少 parent
- **WHEN** 项目新增一批详情页，其中一页没有声明 `parent`
- **THEN** 构建失败，并指出该页的地址

#### Scenario: parent 指向不存在的页面
- **WHEN** 某页的 `parent` 是 `/tarot`，但站点没有 `/tarot` 页面
- **THEN** 构建失败，并指出该页与缺失的上级地址

#### Scenario: 主词重复
- **WHEN** 同一语言中两页的 `titleMain` 相同
- **THEN** 构建输出警告并列出两页，构建不失败

### Requirement: 可选字段与默认值
页面 MAY 声明 `anchorShort`（一个短锚文本变体）、`group`（同级分组）、`related`（相关页地址列表）、`indexable`（默认 `true`）与 `priority`（`'money'` 表示钱页）。`group` 与 `related` 中的地址 MUST 指向存在的可索引页面，否则构建 MUST 失败。

#### Scenario: related 指向不可索引页
- **WHEN** 某页的 `related` 包含一个 `indexable: false` 的页面
- **THEN** 构建失败，并指出该页与目标地址

### Requirement: 面包屑
除首页外的每个可索引公开页面 SHALL 显示面包屑：沿 `parent` 链列出全部上级，每级是真实的 `<a href>`，并输出与之一致的 BreadcrumbList 结构化数据。

#### Scenario: 博客文章的面包屑
- **WHEN** 抓取一篇博客文章的 HTML
- **THEN** 页面包含「首页 › 博客 › 文章」的链接，以及内容一致的 BreadcrumbList JSON-LD

### Requirement: 列表页列出下级
被其他页面声明为 `parent` 的页面（hub）SHALL 链接到其全部可索引下级；下级超过项目配置的单页上限（默认 100）时 MUST 分页，每个分页 MUST 可以从 hub 首页经链接到达。

#### Scenario: 下级数量超出上限
- **WHEN** 某 hub 有 150 个下级，上限为 100
- **THEN** hub 第一页列出 100 个并链接到第二页，第二页列出剩余 50 个

### Requirement: 详情页的同级与相关区块
声明了 `group` 的页面 SHALL 显示同组的其他页面（数量由项目配置，默认 3–5 个）；声明了 `related` 的页面 SHALL 显示相关区块。未声明时 MUST NOT 显示对应区块。

#### Scenario: 没有 related 的页面
- **WHEN** 某页没有声明 `related`
- **THEN** 页面上没有「相关」区块

### Requirement: 系列页的上一篇与下一篇
项目声明为有序系列的同组页面 SHALL 显示上一篇与下一篇链接；系列的第一页没有上一篇，最后一页没有下一篇。

#### Scenario: 系列中间的一页
- **WHEN** 打开有序系列的第 5 页
- **THEN** 页面链接到第 4 页与第 6 页

### Requirement: 锚文本来源
模板区块生成的站内链接 SHALL 使用目标页的 `titleMain` 或 `anchorShort` 作为锚文本，MUST NOT 接受自由文本。全站任何站内链接的锚文本 MUST NOT 是项目配置的禁用词（默认含「点击这里」「了解更多」「查看详情」「here」「read more」「learn more」），出现时构建 MUST 失败。只含图片的链接 MUST 带非空 `alt`。

#### Scenario: 正文中写了「点击这里」
- **WHEN** 一篇文章正文的链接文字是「点击这里」
- **THEN** 构建失败，并指出文章地址与链接目标

### Requirement: 只有真实链接计入链接图
链接图 SHALL 只计入 `<a href>` 元素；按钮、`onclick` 与脚本跳转 MUST NOT 计入。

#### Scenario: 用按钮跳转的入口
- **WHEN** 某页唯一的入口是一个用脚本跳转的按钮
- **THEN** 该页按没有入链处理

### Requirement: 构建后链接图检查
构建 SHALL 读取实际产出的公开页面 HTML，按以下规则检查并输出报告；失败级规则不满足时 MUST 以非零状态退出：
- 失败：可索引页没有站内入链（站点地图不计）；站内死链；可索引页正文或区块链接到不可索引页（导航层与转化入口 `action` 区域除外）；禁用锚文本；违反姊妹站链接约束；可索引页的 `<h1>` 不是恰好一个。
- 警告：同一语言中两页的 `<h1>` 文本相同；页头频道链接数不在阈值范围内（默认 3–7）；声明了 `group` 的详情页正文链接少于阈值（默认 2）；从首页出发的最短点击深度超过阈值（默认 3）；钱页站内入链少于阈值（默认 3）；页脚链接数超过阈值（默认 10）；主词重复。

#### Scenario: 孤岛页
- **WHEN** 某可索引页只出现在站点地图中，没有任何站内页面链接到它
- **THEN** 构建失败，报告列出该页

#### Scenario: 深度超出阈值
- **WHEN** 某页从首页最少需要点击 4 次才能到达
- **THEN** 构建成功，报告中有该页的深度警告

### Requirement: 阈值与规则由项目配置
项目 SHALL 能够配置各阈值、禁用词、钱页列表、sister 域名列表、系列定义，以及检查模式（`report` 只报告、`enforce` 按级别失败）。未配置时为 `report`，模板仓库自身配置为 `enforce`。

#### Scenario: 衍生项目先用报告模式
- **WHEN** 项目把检查模式设为 `report`
- **THEN** 失败级问题只出现在报告中，构建成功

### Requirement: 姊妹站链接约束
项目 SHALL 能够声明 sister 域名列表（同模板生成的其他站点，包括同一部署中的其他站点域名）。指向这些域名的链接 MUST 带 `rel="nofollow"`；MUST NOT 出现在导航层（页头、页脚、面包屑）；MUST NOT 指向与当前页相同路径的镜像页面。违反任一条时构建 MUST 失败。正文中带 nofollow 的普通姊妹站链接允许。

#### Scenario: 正文中的姊妹站链接
- **WHEN** 东站一篇文章正文链接到西站的另一篇文章，并带 `rel="nofollow"`
- **THEN** 检查通过

#### Scenario: 缺少 nofollow
- **WHEN** 东站某页链接到西站，没有 `rel="nofollow"`
- **THEN** 构建失败，并指出该链接

#### Scenario: 页脚放姊妹站链接
- **WHEN** 东站页脚链接到西站首页，即使带 nofollow
- **THEN** 构建失败，指出这是导航层的姊妹站链接

#### Scenario: 镜像互指
- **WHEN** 东站 `/tarot/the-fool` 链接到西站 `/tarot/the-fool`
- **THEN** 构建失败，指出这是镜像链接

### Requirement: 不可索引页不参与链接图
`indexable: false` 的页面以及应用区、账户、后台、分享页、带查询参数的地址 SHALL 输出 noindex，MUST NOT 出现在站点地图，且不作为链接图中的检查对象。

#### Scenario: 分享结果页
- **WHEN** 构建产物中存在分享页 `/s/<类型>/<令牌>`
- **THEN** 它不在站点地图中，也不因没有入链而报告为孤岛
