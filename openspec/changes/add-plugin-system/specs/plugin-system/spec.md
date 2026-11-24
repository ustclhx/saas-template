# Spec Delta

## Purpose

让衍生项目按需启用可选功能插件：插件源码随模板保留，未启用的插件不进入任何构建产物，核心只通过固定扩展点接入插件。

## ADDED Requirements

### Requirement: 插件启用配置
项目 SHALL 在模板配置的 `plugins` 段中以插件 id 为键声明启用的插件，值为该插件的配置段；未出现的插件视为未启用。配置 MUST 在构建与类型检查时校验：未知插件 id、插件配置段不合法、所依赖的插件或模板开关未满足时构建失败，错误信息指出插件与缺失项。

#### Scenario: 依赖未满足
- **WHEN** 启用的插件声明依赖 billing，而项目关闭了 billing
- **THEN** 构建失败，错误信息指出该插件需要开启 billing

#### Scenario: 未知插件
- **WHEN** `plugins` 中出现不存在的插件 id
- **THEN** 构建失败并列出可用的插件 id

### Requirement: 未启用插件不进入构建产物
未启用插件的路由、页面、服务端代码、后台任务代码及其专属依赖 MUST NOT 出现在 web（Cloudflare 与 Node）和 jobs 的构建产物中；其路由 MUST 返回 404。

#### Scenario: 关闭插件后的产物
- **WHEN** 项目未启用某插件并完成生产构建
- **THEN** 构建产物中搜索不到该插件特有的标识（如其后台任务类名、服务商域名），访问其页面与接口返回 404

#### Scenario: 启用插件后的路由
- **WHEN** 项目启用该插件并完成构建
- **THEN** 插件的页面与接口可访问，且路由参与类型化路由检查

### Requirement: 插件源码随模板保留
生成新项目与采纳模板更新时，所有插件的源码 SHALL 保留在项目中，启停插件 MUST 只需修改模板配置与部署绑定，不需要增删源码目录。

#### Scenario: 后续启用插件
- **WHEN** 一个未启用某插件的衍生项目改为启用它
- **THEN** 只需修改 `plugins` 配置并补齐检查提示的部署绑定，重新构建后插件可用

### Requirement: 核心不直接依赖插件
核心应用与共享包 MUST NOT 直接导入任何插件；插件 SHALL 只通过构建期生成的注册文件接入导航、后台菜单、Worker 请求前置处理与导出、后台任务注册、积分预扣清理和消息部件渲染。插件之间只能依赖其声明的插件。依赖检查 MUST 拦截违反者。

#### Scenario: 核心导入插件
- **WHEN** 核心代码中出现对某插件包的导入
- **THEN** `pnpm check:deps` 失败并指出文件与导入

#### Scenario: 插件未声明依赖
- **WHEN** 插件 A 导入插件 B，而 A 的清单未声明依赖 B
- **THEN** 依赖检查失败

### Requirement: 部署目标约束
插件 SHALL 声明支持的部署目标。只支持 Cloudflare 的插件在 selfhost 构建中 MUST 被排除，构建继续成功并输出提示；生成器 MUST 拒绝为 selfhost 目标启用这类插件。

#### Scenario: selfhost 构建排除
- **WHEN** 启用了仅支持 Cloudflare 的插件的仓库执行 selfhost 构建
- **THEN** 构建成功，日志提示该插件已排除，产物中不含其代码

### Requirement: 插件绑定一致性检查
`pnpm check` SHALL 检查启用插件声明的 Cloudflare 绑定在 web 与 jobs 的 wrangler 配置各环境中都存在且种类一致，并 MUST 在 wrangler 引用了未启用插件的类时失败。

#### Scenario: 缺少绑定
- **WHEN** 启用插件需要某 Durable Object 绑定，而 wrangler 的 production 环境缺少它
- **THEN** `pnpm check` 失败并指出文件、环境与绑定名

#### Scenario: 引用未启用插件
- **WHEN** wrangler 仍保留已停用插件的 Workflow 绑定
- **THEN** `pnpm check` 失败并提示删除该绑定
