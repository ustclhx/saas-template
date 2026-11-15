# marketing-site Specification

## Purpose

提供站点对未登录访客展示的内容：营销首页、定价、博客、法律页与可选文档站，并保证这些页面快速加载、与实际套餐数据一致。

## Requirements

### Requirement: 营销页预渲染
首页、定价页、博客文章与法律页 SHALL 以预渲染或可缓存的方式提供，访客请求 MUST NOT 依赖实时数据库查询才能显示主体内容。

#### Scenario: 数据库不可用时访问首页
- **WHEN** 数据库暂时不可达，访客打开首页
- **THEN** 首页主体内容正常显示

### Requirement: 定价与实际套餐一致
定价页展示的套餐、价格与积分 SHALL 来自系统中的套餐数据，套餐变更后 SHALL 在缓存刷新后（不超过 1 小时）反映到定价页。

#### Scenario: 修改套餐价格
- **WHEN** 管理员修改了 Pro 套餐的月付价格
- **THEN** 1 小时内定价页显示新价格

### Requirement: 博客
站点 SHALL 提供博客列表与文章页，文章由仓库中的 MDX 文件生成，支持标题、摘要、发布日期、封面与标签；未到发布日期或标记为草稿的文章 MUST NOT 出现在生产环境。

#### Scenario: 草稿文章
- **WHEN** 一篇文章标记为草稿
- **THEN** 生产环境的列表、站点地图与直接访问都看不到它

### Requirement: 法律页
站点 SHALL 提供隐私政策、服务条款与退款政策页面，退款政策 SHALL 说明取消订阅与删除账号默认不退款、可通过退款申请提出。

#### Scenario: 访问退款政策
- **WHEN** 访客打开退款政策页
- **THEN** 页面说明默认不退款及申请退款的途径

### Requirement: 可选文档站
`features.docs=true` 时站点 SHALL 提供带侧边导航与搜索的文档页面；关闭时文档路由 MUST 返回 404 且不出现在站点地图中。

#### Scenario: 关闭文档站
- **WHEN** `features.docs=false`，访客访问 `/docs`
- **THEN** 返回 404

### Requirement: 暗色模式
站点 SHALL 支持浅色、深色与跟随系统三种主题，用户的选择 SHALL 在刷新后保留，首次渲染 MUST NOT 出现主题闪烁。

#### Scenario: 选择深色后刷新
- **WHEN** 用户选择深色主题后刷新页面
- **THEN** 页面直接以深色渲染，没有先浅后深的闪烁

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

### Requirement: 数据背书区块不伪造数据
营销页 SHALL 提供数据背书区块（如用户数、评分），数值与来源 MUST 来自项目配置；未配置任何数值时该区块 MUST NOT 渲染，模板 MUST NOT 提供示例数值作为默认值。

#### Scenario: 未配置背书数据
- **WHEN** 项目没有配置背书数值
- **THEN** 首页不渲染该区块，页面中不出现任何占位数字

### Requirement: 流程与产品矩阵区块
营销页 SHALL 提供「三步流程」区块与带编号的产品矩阵区块（每项含图片、主按钮与次级链接），内容来自项目配置与多语言文案，构建期预渲染。

#### Scenario: 配置三个产品
- **WHEN** 项目配置三项产品矩阵
- **THEN** 首页按编号顺序显示三张卡片，每张含图片、主按钮与次级链接，且不依赖数据库即可预渲染

### Requirement: 悬浮 AI 入口
营销页 SHALL 支持可配置的悬浮 AI 入口按钮，指向配置的地址（默认聊天页）；未启用时不渲染。按钮 MUST NOT 遮挡页脚链接与 Cookie 提示，并可通过键盘访问。

#### Scenario: 启用悬浮入口
- **WHEN** 项目启用悬浮入口并滚动到页脚
- **THEN** 按钮可见、可用 Tab 聚焦，且页脚链接仍可点击

### Requirement: 订阅与积分包并列展示
定价页 SHALL 在同一页并列展示订阅套餐（月付与年付切换）与一次性积分包，并说明订阅积分按月发放、积分包长期有效、两者叠加且优先消耗先到期的积分；权益清单 SHALL 来自套餐数据。只有一种套餐类型时 SHALL 只显示该类型。

#### Scenario: 同时存在订阅与积分包
- **WHEN** 系统中既有订阅套餐又有积分包
- **THEN** 定价页同时显示两组，切换年付时只改变订阅价格，积分包不受影响

#### Scenario: 只有积分包
- **WHEN** 系统中只有积分包
- **THEN** 定价页不显示月付/年付切换与订阅分组
